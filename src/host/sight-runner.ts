/**
 * 主动识屏搭话的编排层：定时看屏幕 → 判断值不值得说话 → 写进气泡。
 *
 * 分三层，各自可单测：
 *   1. `sight.ts`   —— 抓屏、压缩、帧差、快照保留（纯字节操作）
 *   2. `vision.ts`  —— 一次视觉对话（网络 + 提示词）
 *   3. 本文件       —— 节流、去重、决策、落地（状态机）
 *
 * ── 设计口径 ──
 *
 * **默认关**。不开她绝不截图——这是主人的要求，也是常识。
 *
 * **静默优先**：模型可以回 `[SKIP]`，我们照办不出声。宁可少说，不要每分钟点评空气。
 *
 * **画面没变就不看**：帧差低于阈值直接跳过，连截图都不发。实测能省掉大部分调用。
 *
 * **同一句话不重复说**：连续两次拿到很像的回复（比如都是"加油"），第二次丢掉。
 */

import type { Screenshot } from './sight';
import type { SightMode } from './vision-llm';
import type { VoiceVisionMode } from './voice-vision';

/** 识屏配置（存在 voice.json 旁边的 sight.json，与宠物配置解耦） */
export type SightConfig = {
  /** 总开关，默认关 */
  enabled: boolean;
  /**
   * 间隔秒数 —— 这是**基准**，实际每次在 [minPercent, maxPercent] 区间里随机。
   * 固定频率太机械（主人原话：不生动），随机才像"偶尔瞄一眼"。
   */
  intervalSec: number;
  /** 随机下限：实际间隔 = intervalSec × 本值（默认 0.6） */
  jitterMin: number;
  /** 随机上限：实际间隔 = intervalSec × 本值（默认 1.6） */
  jitterMax: number;
  /** 快照保留张数，0 = 不留 */
  keepSnapshots: number;
  /** 帧差阈值：低于它认为画面没变，跳过。0.02 = 2% */
  changeThreshold: number;
  /** 要不要出声（默认只弹气泡） */
  speak: boolean;
  /** 观察模式：日常陪聊 / 陪玩 / 只看不说 */
  mode: SightMode;
  /** 识屏说的话要不要写进共享记忆（默认开） */
  memoryShared: boolean;
  /** 语音对话里主动识屏的档位：off 从不 / auto 命中关键词才看 / always 每轮都看 */
  voiceVision: VoiceVisionMode;
  /** 连拍帧数（1 = 单帧最省；3~5 能看出画面变化） */
  voiceFrames: number;
  /** 连拍帧间隔（毫秒） */
  voiceFrameGapMs: number;
  /** 只抓指定窗口标题（为空 = 整屏） */
  windowTitle?: string;
};

export const DEFAULT_SIGHT_CONFIG: SightConfig = {
  enabled: false,
  intervalSec: 60,
  jitterMin: 0.6,
  jitterMax: 1.6,
  keepSnapshots: 20,
  changeThreshold: 0.02,
  speak: false,
  mode: 'companion',
  memoryShared: true,
  voiceVision: 'auto',
  voiceFrames: 3,
  voiceFrameGapMs: 700,
};

/** 间隔的硬边界：太短会烧钱 + 吵，太长就失去"陪"的感觉 */
export const MIN_INTERVAL_SEC = 15;
export const MAX_INTERVAL_SEC = 3600;

/** 合法的模式集合（配置里写了别的就当 companion，不报错） */
const MODES: readonly SightMode[] = ['companion', 'play', 'watch'];

/**
 * 算下一次该等多久（毫秒）。
 *
 * 为什么不用固定间隔：主人明确说「固定频率不太生动」。人不会每 60 秒整瞄你一眼，
 * 而是有时连着看两次、有时十分钟都不看。这里用基准 × 随机系数实现这种不规则感。
 *
 * `random` 参数是为了能单测（默认 Math.random）。
 */
export function nextSightDelayMs(config: SightConfig, random: () => number = Math.random): number {
  const lo = Math.min(config.jitterMin, config.jitterMax);
  const hi = Math.max(config.jitterMin, config.jitterMax);
  const factor = lo + random() * (hi - lo);
  const seconds = config.intervalSec * factor;
  return Math.max(5_000, Math.round(seconds * 1000));
}

/** 归一化用户给的配置：非法值一律夹到合法区间，不抛错（配置手滑不该让插件停摆） */
export function normalizeSightConfig(raw: Partial<SightConfig> | undefined): SightConfig {
  const base = DEFAULT_SIGHT_CONFIG;
  const n = (v: unknown, fallback: number): number => {
    const num = Number(v);
    return Number.isFinite(num) ? num : fallback;
  };
  const interval = Math.round(n(raw?.intervalSec, base.intervalSec));
  const mode: SightMode =
    typeof raw?.mode === 'string' && (MODES as readonly string[]).includes(raw.mode)
      ? (raw.mode as SightMode)
      : base.mode;
  return {
    enabled: raw?.enabled === true,
    intervalSec: Math.min(MAX_INTERVAL_SEC, Math.max(MIN_INTERVAL_SEC, interval)),
    keepSnapshots: Math.max(0, Math.min(200, Math.round(n(raw?.keepSnapshots, base.keepSnapshots)))),
    changeThreshold: Math.min(0.9, Math.max(0.001, n(raw?.changeThreshold, base.changeThreshold))),
    speak: raw?.speak === true,
    mode,
    memoryShared: raw?.memoryShared !== false,
    voiceVision:
      raw?.voiceVision === 'off' || raw?.voiceVision === 'always' || raw?.voiceVision === 'auto'
        ? raw.voiceVision
        : base.voiceVision,
    voiceFrames: Math.max(1, Math.min(5, Math.round(n(raw?.voiceFrames, base.voiceFrames)))),
    voiceFrameGapMs: Math.max(200, Math.min(2000, Math.round(n(raw?.voiceFrameGapMs, base.voiceFrameGapMs)))),
    jitterMin: Math.max(0.2, Math.min(3, n(raw?.jitterMin, base.jitterMin))),
    jitterMax: Math.max(0.2, Math.min(5, n(raw?.jitterMax, base.jitterMax))),
    ...(typeof raw?.windowTitle === 'string' && raw.windowTitle.trim() !== ''
      ? { windowTitle: raw.windowTitle.trim() }
      : {}),
  };
}

/** 一轮识屏的结果（给调用方决定怎么落地） */
export type SightRound =
  | { kind: 'skipped'; reason: 'disabled' | 'unchanged' | 'no-reply' | 'duplicate' | 'watch-silent' }
  | { kind: 'spoke'; text: string; speak: boolean; screenshot: Screenshot }
  | { kind: 'failed'; reason: string; message: string };

/** 两句话"太像"的判定：去掉标点空白后比较，前缀相同或编辑距离接近就算重复 */
export function isDuplicateReply(previous: string, current: string): boolean {
  const clean = (s: string): string => s.replace(/[\s，。！？、…~～,.!?]/g, '');
  const a = clean(previous);
  const b = clean(current);
  if (a === '' || b === '') return false;
  if (a === b) return true;
  // 前缀相同超过 60% 也算重复（"主人加油" / "主人加油啊"）
  const minLen = Math.min(a.length, b.length);
  let same = 0;
  for (let i = 0; i < minLen; i++) {
    if (a[i] !== b[i]) break;
    same++;
  }
  return same / minLen >= 0.6;
}

/**
 * 一轮识屏的状态机（纯逻辑，抓屏/模型调用都由注入的函数提供，便于单测）。
 *
 * @param deps 注入的副作用（真实运行时 = sight.ts + vision.ts；测试时 = 假实现）
 * @param state 跨轮次的状态（上一帧、上一句话）
 */
export async function runSightRound(
  config: SightConfig,
  deps: {
    capture: () => Promise<Screenshot>;
    describe: (jpeg: Uint8Array, mode: SightMode) => Promise<{ ok: true; text: string } | { ok: false; reason: string; message: string }>;
    persist: (jpegBase64: string, keep: number) => Promise<string | undefined>;
    /** 帧差比较（注入而不是直接 import，本模块因此保持零运行时依赖、可直接单测） */
    diff: (previous: Uint8Array | undefined, current: Uint8Array) => number;
    /** 模型输出 → 「要不要说话」 */
    parseReply: (text: string) => { speak: boolean; text: string };
  },
  state: { lastJpeg?: Uint8Array; lastReply: string },
): Promise<SightRound> {
  if (!config.enabled) return { kind: 'skipped', reason: 'disabled' };

  let shot: Screenshot;
  try {
    shot = await deps.capture();
  } catch (e) {
    return { kind: 'failed', reason: 'capture', message: e instanceof Error ? e.message : String(e) };
  }

  // 帧差：画面没变就不打扰模型
  const bytes = Uint8Array.from(Buffer.from(shot.dataUrl.split(',')[1] ?? '', 'base64'));
  const diff = deps.diff(state.lastJpeg, bytes);
  state.lastJpeg = bytes;
  if (diff < config.changeThreshold) return { kind: 'skipped', reason: 'unchanged' };

  // 快照：给人核对用（失败不影响主流程）
  if (config.keepSnapshots > 0) {
    await deps.persist(shot.dataUrl.split(',')[1] ?? '', config.keepSnapshots);
  }

  // 「只看不说」= 真静默：只留快照供核对，**不调用模型**。
  // 早先这里照样请求模型、再把描述当气泡弹出来，和文案（只默默记录、不打扰）不一致。
  if (config.mode === 'watch') return { kind: 'skipped', reason: 'watch-silent' };

  const result = await deps.describe(bytes, config.mode);
  if (!result.ok) return { kind: 'failed', reason: result.reason, message: result.message };

  const reply = deps.parseReply(result.text);
  if (!reply.speak) return { kind: 'skipped', reason: 'no-reply' };

  if (isDuplicateReply(state.lastReply, reply.text)) return { kind: 'skipped', reason: 'duplicate' };
  state.lastReply = reply.text;

  return { kind: 'spoke', text: reply.text, speak: config.speak, screenshot: shot };
}
