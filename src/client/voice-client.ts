/**
 * 语音对话的前端半侧：按住说话 → 本地编码成 16 kHz WAV → 宿主识别+生成 → 合成 → 播放。
 *
 * ── 录音这段为什么照抄 DSH ──
 * DSH 自带的语音输入插件（`@deepseek-ai/dsh-experimental-client-ui-voice-input`）
 * 已经把这套流程写好并实测可用：`getUserMedia` → `MediaRecorder` → `decodeAudioData`
 * → `OfflineAudioContext(1, len, 16000)` 重采样 → 手写 44 字节 PCM16 头。
 * 这里沿用同样的做法（不是原创），因为格式必须与宿主的 `speechToText` 严格一致：
 * **16 kHz / 单声道 / PCM16 / WAV**。差一点（44.1k、立体声、float32）本地
 * SenseVoice 就会识别成乱码或直接失败。
 *
 * ── 两个必须记住的坑 ──
 * 1. `app.ts` 里 `const { jsx: h } = require('react/jsx-runtime')`。
 *    这个 `h` 的签名是 `h(type, props)` —— **子元素必须放进 `props.children`**，
 *    不能像 `React.createElement` 那样当位置参数传。位置参数会被静默丢弃，
 *    渲染出一个空 div：插槽条目 `active: true`，但界面上什么都没有。
 * 2. React 的 `style` 只接受对象；传 CSS 字符串会在渲染期抛错，插槽随后把条目判为失活。
 *
 * ── 交互 ──
 * 按住说话（按钮 / 快捷键），松手后「识别中 → 思考中 → 说话中」。
 * 录音期间在宠物头顶推一个「······」气泡，让人知道正在听。
 * 回复文本由宿主写进 /state 的 pets.<id>.say，宠物自己会弹气泡。
 * 播放中再按一次 = 立刻停止播放（打断）。
 */

import type * as React from 'react';

/** 宿主路由前缀 */
const PREFIX = '/dsh-whale-girl';

/** 最短录音（秒）：太短的当作误触，不送识别 */
const MIN_SECONDS = 0.35;

/** 录音中宠物头顶显示的提示（走宿主现有的 broadcast 通道，不新增端点） */
const LISTENING_TEXT = '······';

export type VoiceState = 'idle' | 'recording' | 'recognizing' | 'thinking' | 'speaking' | 'error';

/** 把 16 kHz 单声道浮点采样编码成 PCM16 WAV（44 字节头，`data` 必须正好在偏移 36） */
function encodePcm16Wav(samples: Float32Array): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (at: number, text: string): void => {
    for (let i = 0; i < text.length; i++) bytes[at + i] = text.charCodeAt(i);
  };
  ascii(0, 'RIFF');
  view.setUint32(4, bytes.length - 8, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt 块大小
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // 单声道
  view.setUint32(24, 16000, true); // 采样率
  view.setUint32(28, 32000, true); // 字节率
  view.setUint16(32, 2, true); // 块对齐
  view.setUint16(34, 16, true); // 位深
  ascii(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, Math.round(clamped * (clamped < 0 ? 32768 : 32767)), true);
  }
  return bytes;
}

/** 任意采样率的单声道采样 → 16 kHz → PCM16 WAV */
async function toCanonicalWav(samples: Float32Array, sampleRate: number): Promise<Uint8Array> {
  if (sampleRate === 16000) return encodePcm16Wav(samples);
  const frames = Math.max(1, Math.floor((samples.length * 16000) / sampleRate));
  // 用 AudioBuffer 装原采样，再交给 OfflineAudioContext(16000) 重采样
  const buffer = new AudioBuffer({ length: Math.max(1, samples.length), sampleRate, numberOfChannels: 1 });
  buffer.copyToChannel(samples, 0);
  const offline = new OfflineAudioContext(1, frames, 16000);
  const source = offline.createBufferSource();
  source.buffer = buffer;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  return encodePcm16Wav(rendered.getChannelData(0));
}

/** 一次录音会话（直接抓采样，不经过 MediaRecorder） */
type Capture = {
  /** 已经录了多久（秒） */
  seconds(): number;
  /** 已经收到的采样点数 */
  blocks(): number;
  /** 停止并返回原始采样 + 采样率 */
  stop(): Promise<{ samples: Float32Array; sampleRate: number }>;
  /** 丢弃并释放 */
  abort(): void;
};

/**
 * 用 AudioContext 直接抓采样，**不用 MediaRecorder**。
 *
 * 为什么必须换掉 MediaRecorder：本机 Electron 里
 * `new MediaRecorder(stream).mimeType` 是**空字符串**——它选不出任何可用编码格式，
 * 于是录音器起来后立刻自我终止：`chunks` 永远是 0、`state` 是 `inactive`
 * （voice-trace.log 里连续三条实测记录都是 `chunks:0, state:"inactive"`，`mime:""`）。
 * 这是那条 API 在这个环境不可用，不是我们的逻辑错。
 *
 * `ScriptProcessorNode` 虽被标 deprecated，但在所有 Chromium 上都能跑、
 * 不需要额外的 worker 模块文件；对「录一句几秒钟的话」完全够用。
 */
async function startCapture(stream: MediaStream): Promise<Capture> {
  const context = new AudioContext();
  await context.resume().catch(() => {
    /* 已经在 running 时 resume 会直接 resolve */
  });
  const source = context.createMediaStreamSource(stream);
  const processor = context.createScriptProcessor(4096, 1, 1);
  const blocks: Float32Array[] = [];
  let stopped = false;

  processor.onaudioprocess = (event) => {
    if (stopped) return;
    // 必须拷贝：inputBuffer 的底层数组会被复用
    blocks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
  };
  source.connect(processor);
  // 接到 destination 才会被驱动；我们从不写 outputBuffer，所以不会产生回声
  processor.connect(context.destination);

  const sampleRate = context.sampleRate;
  const totalSamples = (): number => blocks.reduce((n, b) => n + b.length, 0);

  const release = (): void => {
    stopped = true;
    processor.onaudioprocess = null;
    try {
      processor.disconnect();
    } catch {
      /* 已断开 */
    }
    try {
      source.disconnect();
    } catch {
      /* 已断开 */
    }
    void context.close().catch(() => {});
  };

  return {
    seconds: () => totalSamples() / sampleRate,
    blocks: () => blocks.length,
    async stop() {
      release();
      const length = totalSamples();
      const samples = new Float32Array(length);
      let offset = 0;
      for (const b of blocks) {
        samples.set(b, offset);
        offset += b.length;
      }
      return { samples, sampleRate };
    },
    abort: release,
  };
}

/** Uint8Array → base64（分块，避免大数组爆栈） */
function toBase64(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(text);
}

/**
 * 上报一步进度到宿主日志（`$DSH_HOME/dsh-whale-girl/voice-trace.log`）。
 *
 * 为什么要有：语音链路在前端有六七步，任何一步静默失败都表现为「按了没反应」，
 * 而浏览器控制台主人不方便看。落成文件后宿主侧一次 GET 就能看到断在哪一步。
 * 纯诊断，**失败静默**——绝不能因为日志发不出去影响主流程。
 */
function trace(step: string, detail?: unknown): void {
  try {
    void fetch(`${PREFIX}/voice/trace`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ step, detail }),
      cache: 'no-store',
    }).catch(() => {
      /* 诊断失败不影响主流程 */
    });
  } catch {
    /* 同上 */
  }
}

/** 发一个 JSON 请求，把「网络失败」与「业务失败」都折成结构化结果 */
async function postJson<T>(path: string, body: unknown): Promise<{ ok: true; data: T } | { ok: false; message: string }> {
  try {
    const response = await fetch(`${PREFIX}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
    });
    if (!response.ok) return { ok: false, message: `请求失败（HTTP ${response.status}）` };
    return { ok: true, data: (await response.json()) as T };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

/** 宿主对话回复的形状 */
type TurnReply = { ok: boolean; userText?: string; reply?: string; reason?: string; message?: string };

/** 宿主 voice.json 的形状（只取前端关心的字段） */
type VoiceConfig = { micDeviceId?: string; shortcut?: string; voice?: string; hideButton?: string };

const DEFAULT_SHORTCUT = 'Alt+V';

/** 设置页保存语音配置后派发的浏览器事件（同页内即时生效，无需刷新） */
export const VOICE_CONFIG_EVENT = 'dsh-whale-girl:voice-config';

/** 取语音配置（每次开录前都取一次：设置页保存后立刻生效，不必刷新） */
async function loadVoiceConfig(): Promise<VoiceConfig> {
  try {
    const res = await fetch(`${PREFIX}/voice/config`, { cache: 'no-store' });
    if (!res.ok) return {};
    return (await res.json()) as VoiceConfig;
  } catch {
    return {};
  }
}

/** 容器样式（固定在右下角，避开宠物本体） */
const ROOT_STYLE = [
  'position:fixed',
  'right:16px',
  'bottom:96px',
  'z-index:2147483000',
  'display:flex',
  'align-items:center',
  'gap:8px',
  'pointer-events:auto',
  'user-select:none',
].join(';');

const BUTTON_STYLE = [
  'width:44px',
  'height:44px',
  'border-radius:50%',
  'border:1px solid rgba(255,255,255,.22)',
  'background:rgba(20,28,48,.82)',
  'color:#e8f0ff',
  'font-size:18px',
  'line-height:1',
  'cursor:pointer',
  'display:flex',
  'align-items:center',
  'justify-content:center',
  'transition:transform .12s ease, background .12s ease',
  'box-shadow:0 4px 16px rgba(0,0,0,.35)',
].join(';');

const LABEL_STYLE = [
  'font-size:12px',
  'color:#cfe0ff',
  'background:rgba(20,28,48,.72)',
  'padding:4px 8px',
  'border-radius:8px',
  'white-space:nowrap',
  'max-width:320px',
  'overflow:hidden',
  'text-overflow:ellipsis',
].join(';');

// 失败文案统一走 src/shared/error-text：文字对话弹窗与语音按钮用**同一份**口径，
// 否则同一个 429 在两处显示成完全不同的样子（踩过）。
import { humanizeModelError } from '../shared/error-text';

const STATE_TEXT: Record<VoiceState, string> = {
  idle: '按住说话',
  recording: '松开结束',
  recognizing: '识别中…',
  thinking: '思考中…',
  speaking: '说话中（再按可打断）',
  error: '',
};

/** 把 CSS 字符串转成 React 的 style 对象（React 的 style 不接受字符串） */
function parseStyle(css: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of css.split(';')) {
    const index = part.indexOf(':');
    if (index <= 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key === '' || value === '') continue;
    out[key.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())] = value;
  }
  return out;
}

const styles = {
  root: parseStyle(ROOT_STYLE),
  label: parseStyle(LABEL_STYLE),
  heard: parseStyle(
    [
      'font-size:12px',
      'color:#e8f0ff',
      'background:rgba(96,140,255,.35)',
      'border:1px solid rgba(96,140,255,.5)',
      'padding:4px 8px',
      'border-radius:8px',
      'white-space:nowrap',
      'max-width:320px',
      'overflow:hidden',
      'text-overflow:ellipsis',
    ].join(';'),
  ),
  button: parseStyle(BUTTON_STYLE),
  buttonActive: parseStyle(`${BUTTON_STYLE};background:rgba(96,140,255,.92)`),
  buttonBusy: parseStyle(`${BUTTON_STYLE};opacity:.6;cursor:progress`),
} as const;

/** 解析快捷键字符串（`Alt+V` / `Ctrl+Shift+Space` / `F8`） */
function parseShortcut(text: string): { mods: Set<string>; key: string } | undefined {
  const parts = text
    .split('+')
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p !== '');
  if (parts.length === 0) return undefined;
  const key = parts[parts.length - 1];
  if (key === '') return undefined;
  const mods = new Set(parts.slice(0, -1));
  const known = new Set(['alt', 'ctrl', 'control', 'shift', 'meta', 'cmd', 'win']);
  if ([...mods].some((m) => !known.has(m))) return undefined;
  return { mods, key };
}

/** 判断一次按键事件是否命中该快捷键（修饰键精确匹配） */
function matches(event: KeyboardEvent, combo: { mods: Set<string>; key: string }): boolean {
  const wantAlt = combo.mods.has('alt');
  const wantCtrl = combo.mods.has('ctrl') || combo.mods.has('control');
  const wantShift = combo.mods.has('shift');
  const wantMeta = combo.mods.has('meta') || combo.mods.has('cmd') || combo.mods.has('win');
  if (event.altKey !== wantAlt) return false;
  if (event.ctrlKey !== wantCtrl) return false;
  if (event.shiftKey !== wantShift) return false;
  if (event.metaKey !== wantMeta) return false;
  const pressed = event.key.toLowerCase();
  const normalized = pressed === ' ' ? 'space' : pressed;
  return normalized === combo.key || event.code.toLowerCase() === combo.key;
}

/**
 * 造「按住说话」按钮组件。
 *
 * @param rt 宿主提供的 React 运行时（h / hooks），与 pet.ts 同一套注入方式
 */
export function makeVoiceButton(rt: {
  h: typeof React.createElement;
  useState: typeof React.useState;
  useRef: typeof React.useRef;
  useCallback: typeof React.useCallback;
  useEffect: typeof React.useEffect;
}) {
  const { h, useState, useRef, useCallback, useEffect } = rt;

  // 返回类型允许 null：设置里关掉按钮后整块不渲染（只留快捷键）
  return function VoiceButton(props: { label: (key: string) => string }): React.ReactElement | null {
    void props;
    const [state, setState] = useState<VoiceState>('idle');
    const [message, setMessage] = useState<string>('');
    // 最近一次识别到的原文。主人最想确认的就是「到底听清没」——
    // 所以哪怕后面的模型调用失败，也要把这句显示出来。
    const [heard, setHeard] = useState<string>('');
    const [shortcut, setShortcut] = useState<string>(DEFAULT_SHORTCUT);
    // 是否隐藏那颗大按钮（设置页可切；隐藏后仍可用快捷键）
    const [hidden, setHidden] = useState<boolean>(false);
    const captureRef = useRef<Capture | undefined>(undefined);
    const streamRef = useRef<MediaStream | undefined>(undefined);
    const startedWallRef = useRef<number>(0);
    const audioRef = useRef<HTMLAudioElement | undefined>(undefined);
    const urlRef = useRef<string | undefined>(undefined);
    const busyRef = useRef<boolean>(false);
    /**
     * 「还没开始录就松手了」的标记。
     *
     * `startRecording` 要先 await getUserMedia（几十到几百毫秒），这期间
     * recorderRef 还是空的。若主人按得快、松得早，`finish()` 会看到
     * recorderRef === undefined 直接返回——表现就是**按了、气泡出来了、然后什么都不发生**。
     * 用这个标记把「松手」记住，等录音器真的起来后立刻收尾。
     */
    const stopRequestedRef = useRef<boolean>(false);
    /**
     * 防重入：`startRecording` 里有 await（读配置 + getUserMedia），
     * 这段窗口内任何再次触发（按键重复、连点）都会开出第二个录音器并覆盖 ref，
     * 结果两个都残废。加这把锁，第二次触发只记「等会儿停」。
     */
    const startingRef = useRef<boolean>(false);

    const cleanupStream = useCallback((): void => {
      captureRef.current?.abort();
      captureRef.current = undefined;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = undefined;
    }, []);

    const stopPlayback = useCallback((): void => {
      const audio = audioRef.current;
      if (audio !== undefined) {
        audio.pause();
        audio.currentTime = 0;
        audioRef.current = undefined;
      }
      if (urlRef.current !== undefined) {
        URL.revokeObjectURL(urlRef.current);
        urlRef.current = undefined;
      }
    }, []);

    /** 录音开始：让宠物头顶冒一个「······」，告诉人「我在听」 */
    const showListening = useCallback((): void => {
      void postJson('/broadcast', { text: LISTENING_TEXT }).catch(() => {
        /* 提示失败不影响录音本身 */
      });
    }, []);

    /** 松手后：编码 → turn → tts → 播放 */
    const finish = useCallback(async (): Promise<void> => {
      const capture = captureRef.current;
      if (capture === undefined) {
        // 见 stopRequestedRef 的注释：录音器还没起来就松手了。
        if (stateRef.current === 'recording') stopRequestedRef.current = true;
        return;
      }
      captureRef.current = undefined;

      const seconds = capture.seconds();
      const blockCount = capture.blocks();
      let recorded: { samples: Float32Array; sampleRate: number };
      try {
        recorded = await capture.stop();
      } catch (e) {
        cleanupStream();
        setState('error');
        setMessage('录音收尾失败：' + humanizeModelError(undefined, e instanceof Error ? e.message : String(e)));
        return;
      }
      cleanupStream();

      trace('stop', {
        seconds: Number(seconds.toFixed(2)),
        blocks: blockCount,
        samples: recorded.samples.length,
        rate: recorded.sampleRate,
      });

      if (seconds < MIN_SECONDS) {
        setState('error');
        setMessage(`太短了（${seconds.toFixed(1)}s），按住多说一会儿`);
        return;
      }
      if (recorded.samples.length === 0 || blockCount === 0) {
        // 曾经这里是静默 return：「按了没反应」最难查的一条路径。
        setState('error');
        setMessage('没收到音频采样（麦克风没有输出数据）');
        return;
      }

      setState('recognizing');
      busyRef.current = true;
      try {
        const wav = await toCanonicalWav(recorded.samples, recorded.sampleRate);
        trace('wav', { bytes: wav.length });

        setState('thinking');
        const turn = await postJson<TurnReply>('/voice/turn', { audio: toBase64(wav) });
        trace('turn', {
          transportOk: turn.ok,
          reason: turn.ok ? turn.data.reason : turn.message,
          userText: turn.ok ? turn.data.userText : undefined,
          replyLength: turn.ok ? (turn.data.reply ?? '').length : undefined,
        });
        // 先落识别结果：后面的模型调用可能失败（限流/网络），
        // 但「有没有听清」这件事此时已经确定了，要立刻给主人看。
        const recognized = (turn.ok ? turn.data.userText : undefined)?.trim();
        if (recognized !== undefined && recognized !== '') setHeard(recognized);
        if (!turn.ok) {
          setState('error');
          setMessage(humanizeModelError(undefined, turn.message));
          return;
        }
        if (!turn.data.ok) {
          setState('error');
          setMessage(humanizeModelError(turn.data.reason, turn.data.message));
          return;
        }

        const reply = (turn.data.reply ?? '').trim();
        if (reply === '') {
          setState('idle');
          return;
        }

        // 回复文本已经由宿主写进 /state，气泡会自己出现；这里只负责出声
        setState('speaking');
        trace('tts:request', { chars: reply.length });
        const response = await fetch(`${PREFIX}/voice/tts`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: reply }),
          cache: 'no-store',
        });
        if (!response.ok) {
          setState('error');
          setMessage(`语音合成失败（HTTP ${response.status}）`);
          return;
        }
        const bytes = await response.arrayBuffer();
        const mime = response.headers.get('content-type') ?? 'audio/mpeg';
        trace('tts:response', { bytes: bytes.byteLength, mime });
        if (bytes.byteLength === 0) {
          setState('error');
          setMessage('语音合成失败');
          return;
        }
        const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
        urlRef.current = url;
        const player = new Audio(url);
        audioRef.current = player;
        player.addEventListener('ended', () => {
          stopPlayback();
          setState('idle');
        });
        player.addEventListener('error', () => {
          stopPlayback();
          setState('error');
          setMessage('音频播放失败');
        });
        try {
          await player.play();
          trace('play:start');
        } catch (e) {
          // 播放被浏览器拦（autoplay policy）是最容易「看起来没反应」的一种：
          // 音频其实已经拿到了，只是没播出来。必须让主人看见原因。
          setState('error');
          setMessage('音频被系统拦下（点一下页面再试）：' + humanizeModelError(undefined, e instanceof Error ? e.message : String(e)));
          return;
        }
      } catch (e) {
        trace('error', { message: e instanceof Error ? e.message : String(e) });
        setState('error');
        setMessage(humanizeModelError(undefined, e instanceof Error ? e.message : String(e)));
      } finally {
        busyRef.current = false;
      }
    }, [cleanupStream, stopPlayback]);

    const startRecording = useCallback(async (): Promise<void> => {
      if (startingRef.current) {
        // 已经在启动流程里了：只记下「之后停」，绝不重复开录音器
        stopRequestedRef.current = true;
        return;
      }
      startingRef.current = true;
      setMessage('');
      setHeard('');
      stopRequestedRef.current = false;
      setState('recording');
      // 立刻把 ref 同步成 recording：setState 要等下一次渲染才生效，
      // 而键重复/连点发生在那之前，靠 stateRef 判断会漏。
      stateRef.current = 'recording';
      try {
        const devices = navigator.mediaDevices;
        if (devices === undefined) throw new Error('这个环境不支持麦克风');

        // 每次开录都重读配置：设置页刚保存的麦克风立刻生效
        const cfg = await loadVoiceConfig();
        const micId = cfg.micDeviceId ?? '';

        const constraints: MediaStreamConstraints = {
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            ...(micId === '' ? {} : { deviceId: { exact: micId } }),
          },
          video: false,
        };
        const stream = await devices.getUserMedia(constraints);
        streamRef.current = stream;
        const capture = await startCapture(stream);
        captureRef.current = capture;
        startedWallRef.current = performance.now();
        trace('record:start', {
          mic: micId === '' ? 'default' : micId.slice(0, 8),
          tracks: stream.getAudioTracks().length,
        });
        showListening();
        // 录音器起来之前就松手了 → 立刻收尾（否则会一直停在「录音中」）
        if (stopRequestedRef.current) {
          stopRequestedRef.current = false;
          trace('record:early-stop');
          void finish();
        }
      } catch (e) {
        cleanupStream();
        setState('error');
        const name = e instanceof DOMException ? e.name : '';
        setMessage(
          name === 'NotAllowedError'
            ? '麦克风权限被拒绝（请在系统设置里允许）'
            : name === 'NotFoundError'
              ? '没找到麦克风'
              : name === 'OverconstrainedError'
                ? '选定的麦克风不可用（设置里换一个）'
                : e instanceof Error
                  ? e.message
                  : String(e),
        );
        trace('record:error', { name, message: e instanceof Error ? e.message : String(e) });
      } finally {
        startingRef.current = false;
      }
    }, [cleanupStream, showListening, finish]);

    // 快捷键 + 按钮显隐：都从配置读。
    //
    // 关键：设置页保存后必须**重新读**。主人踩过——勾了「隐藏麦克风按钮」、
    // 点了保存，按钮还在，因为组件只在挂载时读了一次。
    // 所以除了挂载，还监听设置页派发的变更事件、以及窗口重新获得焦点时补读。
    useEffect(() => {
      let alive = true;
      const reload = (): void => {
        void (async () => {
          const cfg = await loadVoiceConfig();
          if (!alive) return;
          if (typeof cfg.shortcut === 'string' && cfg.shortcut.trim() !== '') setShortcut(cfg.shortcut.trim());
          setHidden(cfg.hideButton === 'true');
        })();
      };
      reload();
      window.addEventListener(VOICE_CONFIG_EVENT, reload);
      window.addEventListener('focus', reload);
      return () => {
        alive = false;
        window.removeEventListener(VOICE_CONFIG_EVENT, reload);
        window.removeEventListener('focus', reload);
      };
    }, []);

    const stateRef = useRef<VoiceState>(state);
    stateRef.current = state;

    /**
     * 「按下」的完整语义 —— 按钮、页面快捷键、宿主全局热键三条入口共用同一份。
     *
     * 说话/识别/思考中按下 = 打断并**立刻开始新一轮**（只停不录会让主人以为快捷键坏了）。
     */
    const pressDown = useCallback((): void => {
      const now = stateRef.current;
      if (now === 'speaking' || now === 'recognizing' || now === 'thinking') {
        stopPlayback();
        setState('idle');
        stateRef.current = 'idle';
        void startRecording();
        return;
      }
      if (now === 'idle' || now === 'error') void startRecording();
    }, [startRecording, stopPlayback]);

    /** 「松开」的完整语义：只有正在录音才收尾（重复的 up 是空操作） */
    const pressUp = useCallback((): void => {
      if (stateRef.current === 'recording') void finish();
    }, [finish]);

    useEffect(() => {
      const combo = parseShortcut(shortcut);
      if (combo === undefined) return;

      /**
       * 是否该忽略这次按键。
       *
       * 只在「输入框里且没有修饰键」时忽略：用 Alt+V 时焦点通常就在聊天输入框里，
       * 若也按 isTyping 拦掉，快捷键就永远不会触发（这正是「按 Alt+V 没反应」的原因）。
       * 带修饰键的组合本来不产生普通字符，不必让位给输入。
       */
      const shouldIgnore = (event: KeyboardEvent): boolean => {
        if (event.altKey || event.ctrlKey || event.metaKey) return false;
        const el = event.target as HTMLElement | null;
        if (!el || typeof el.tagName !== 'string') return false;
        const tag = el.tagName.toLowerCase();
        return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable === true;
      };

      const down = (event: KeyboardEvent): void => {
        // 按键**自动重复**必须忽略：按住 Alt+V 不放时浏览器每 30ms 发一次 keydown，
        // 每次都调 startRecording 会瞬间开出几十个 MediaRecorder、互相覆盖 chunksRef，
        // 最后一个还没开始录就被停掉 → chunks=0、state=inactive（实测就是这个）。
        if (event.repeat) return;
        if (!matches(event, combo) || shouldIgnore(event)) return;
        event.preventDefault();
        trace('key:down', { key: event.key, code: event.code, target: (event.target as HTMLElement | null)?.tagName });
        pressDown();
      };
      const up = (event: KeyboardEvent): void => {
        if (!matches(event, combo)) return;
        event.preventDefault();
        trace('key:up', { key: event.key, state: stateRef.current });
        pressUp();
      };

      window.addEventListener('keydown', down, true);
      window.addEventListener('keyup', up, true);
      return () => {
        window.removeEventListener('keydown', down, true);
        window.removeEventListener('keyup', up, true);
      };
    }, [shortcut, pressDown, pressUp]);

    /**
     * 宿主级全局热键（SSE）：DSH 窗口失焦 / 最小化 / 被别的应用挡住时也能用。
     *
     * 页面里的 `keydown` 只在本页有焦点时触发；宿主侧的轮询进程不依赖焦点
     * （见 src/host/hotkey.ts），把 DOWN/UP 通过 `text/event-stream` 推过来。
     * 页面在后台时 EventSource 仍然收得到——这正是这条链路存在的意义。
     *
     * 两条路径同时触发不会出问题：`startRecording` 有防重入、`finish` 有状态判定，
     * 焦点在页面里时浏览器那条会先到，宿主这条再到达时状态已经不是 idle/recording。
     */
    useEffect(() => {
      if (typeof EventSource === 'undefined') return undefined;
      let source: EventSource;
      try {
        source = new EventSource(`${PREFIX}/voice/hotkey/stream`);
      } catch {
        return undefined; // 极端环境（无 EventSource）→ 退回页面内快捷键
      }
      const onHotkey = (event: Event): void => {
        try {
          const data = JSON.parse((event as MessageEvent<string>).data) as { type?: string };
          if (data.type === 'down') {
            trace('hotkey:down', { state: stateRef.current });
            pressDown();
          } else if (data.type === 'up') {
            trace('hotkey:up', { state: stateRef.current });
            pressUp();
          }
        } catch {
          /* 坏帧忽略：不能因为一条事件流异常把快捷键搞坏 */
        }
      };
      source.addEventListener('hotkey', onHotkey as EventListener);
      return () => {
        source.removeEventListener('hotkey', onHotkey as EventListener);
        source.close();
      };
    }, [pressDown, pressUp]);

    // 提示自动消失：回到 idle 后 6 秒清掉「听到：…」与错误文案，
    // 否则那两行会一直挂在按钮旁边、很碍眼（主人反馈过）。
    useEffect(() => {
      if (state !== 'idle') return undefined;
      const timer = setTimeout(() => {
        setHeard('');
        setMessage('');
      }, 6000);
      return () => clearTimeout(timer);
    }, [state]);

    // 隐藏模式：设置里关掉按钮后**整块不渲染**，只保留快捷键与头顶气泡。
    // 注意必须在所有 hooks 之后 return，否则会违反 hooks 规则。
    if (hidden && state === 'idle') return null;

    const active = state === 'recording' || state === 'speaking';
    const busy = state === 'recognizing' || state === 'thinking';
    // idle 时不再显示「按住说话」这类常驻文案：按钮本身够说明问题，
    // 常驻标签正是主人嫌碍眼的那块。
    const label =
      state === 'idle' ? message : state === 'error' ? message || '出错了' : STATE_TEXT[state] || message;
    // 识别到的原文：拿到后短暂显示（上面那个 effect 负责清掉），
    // 即便模型那一步失败，也能确认「麦克风与识别是通的」。
    const heardLine = heard === '' ? '' : `听到：${heard}`;

    // 注意：h 是 react/jsx-runtime 的 jsx，子元素必须放进 props.children，
    // 不能当位置参数传（会被静默丢弃，渲染出空 div）。
    return h('div', {
      style: styles.root,
      children: [
        label === '' ? null : h('span', { key: 'label', style: styles.label, children: label }),
        heardLine === ''
          ? null
          : h('span', {
              key: 'heard',
              style: styles.heard,
              title: heard,
              children: heardLine,
            }),
        h('button', {
          key: 'btn',
          type: 'button',
          style: busy ? styles.buttonBusy : active ? styles.buttonActive : styles.button,
          title: `按住说话，松开结束（快捷键 ${shortcut}；播放中按下可打断）`,
          disabled: busy,
          onPointerDown: (event: { preventDefault(): void }) => {
            event.preventDefault();
            if (state === 'speaking' || busyRef.current) {
              stopPlayback();
              setState('idle');
              return;
            }
            if (state === 'idle' || state === 'error') void startRecording();
          },
          onPointerUp: (event: { preventDefault(): void }) => {
            event.preventDefault();
            void finish();
          },
          onPointerLeave: (event: { preventDefault(): void }) => {
            if (state === 'recording') {
              event.preventDefault();
              void finish();
            }
          },
          children: state === 'recording' ? '■' : '🎤',
        }),
      ],
    });
  };
}
