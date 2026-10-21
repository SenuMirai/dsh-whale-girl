/**
 * 语音对话里的「主动识屏」：她什么时候该自己去看一眼。
 *
 * ── 为什么要单独一层决策 ──
 *
 * 每次看屏幕都要花积分/token（抓帧 + 视觉模型）。如果每句话都看，
 * 聊十句就是十次调用；如果从不看，那"你看我在干嘛"就只能瞎猜。
 *
 * 所以做成三档，可调（主人明确要求「偶尔省、偶尔尽情花」）：
 *  - `off`    ：从不主动看（只走手动触发）
 *  - `auto`   ：**启发式判断**——话里提到"看/瞧/这个/屏幕/我在干嘛"才看（免费）
 *  - `always` ：每轮语音对话都看（最贵，也最"在场"）
 *
 * ── 为什么 auto 用关键词而不是让模型先判断 ──
 *
 * 让模型判断「要不要看」本身也是一次调用，等于每句都付费——那 auto 就失去意义了。
 * 关键词是免费的、可预期的；真需要模型判断时用 always 档。
 */

/** 识屏触发档位 */
export type VoiceVisionMode = 'off' | 'auto' | 'always';

/** 命中这些词的才会触发 auto 档 */
const LOOK_HINTS = [
  '看',
  '瞧',
  '瞅',
  '这个',
  '那个',
  '画面',
  '屏幕',
  '我在干嘛',
  '我在做什么',
  '你猜',
  '怎么样',
  '好看吗',
  '这个游戏',
  '我在玩',
  '注意到',
  '发现了',
];

/**
 * 这句话要不要让她看一眼。
 *
 * @param text 用户刚说的话（语音识别结果，通常很短）
 * @param mode 当前档位
 * @param manual 是否手动要求（比如命令里带"看屏幕"）——手动永远看
 */
export function shouldLookAtScreen(text: string, mode: VoiceVisionMode, manual = false): boolean {
  if (manual) return true;
  if (mode === 'off') return false;
  if (mode === 'always') return true;
  // auto：宽松命中即可（宁可多看一次，也别在她明明问了"我在干嘛"时装瞎）
  const lower = text.toLowerCase();
  return LOOK_HINTS.some((hint) => lower.includes(hint.toLowerCase()));
}

/**
 * 抓几帧、间隔多久。
 *
 * 单帧只能看"静态画面"，看不出「在动/在打/刚切了界面」。
 * 多帧才能比较变化——这正是主人要的「分析画面变化运动」。
 *
 * @param frames 帧数（1~5；1 = 退回旧行为，最省）
 * @param gapMs 帧间隔（默认 700ms；太短看不出变化，太长跟不上）
 */
export function framePlan(frames: number, gapMs = 700): { count: number; gapMs: number } {
  const count = Math.max(1, Math.min(5, Math.round(Number.isFinite(frames) ? frames : 1)));
  const gap = Math.max(200, Math.min(2000, Math.round(Number.isFinite(gapMs) ? gapMs : 700)));
  return { count, gapMs: gap };
}

/**
 * 把多帧之间的差异压成一句给模型看的提示。
 *
 * 为什么不一帧帧描述：模型能自己看图，我们只需要告诉它「这几张是连续拍的、
 * 按时间顺序」，它就能比较出运动。额外加一句反而挤占预算。
 */
export function frameCaption(count: number, gapMs: number): string {
  if (count <= 1) return '这是你当前屏幕的样子。';
  const span = ((count - 1) * gapMs) / 1000;
  return `接下来是 ${count} 张连续截图（按时间顺序，间隔约 ${gapMs} 毫秒，共 ${span.toFixed(1)} 秒），可以对比出画面在怎么变化。`;
}
