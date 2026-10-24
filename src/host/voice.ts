/**
 * 语音：语音识别（本地 SenseVoice）+ 语音合成（edge-tts 晓伊）。
 *
 * ── 为什么这么实现 ──
 *
 * **ASR 不用自己接**：DSH 自带 `speechToText` 服务，desktop profile 里已经启用
 * `sensevoice-local`（228 MB int8 模型已下载）。本模块只做「拿到 WAV → resolve →
 * transcribe」，不重造识别链路。
 *
 * **TTS 必须走 Python**：`edge-tts` 只有 Python 实现（7.3.1，本机已装）。
 * Node 侧没有等价库；手写 Edge 的 WebSocket 合成协议是另一件事，且容易随微软改协议失效。
 *
 * **为什么用常驻 worker 而不是每次 spawn**：
 * 实测每次 `spawn python` + `import edge_tts` 要 **1.5–2.4 秒**——这部分是纯开销，
 * 与句子长短无关。改成「进程常驻 + 长度前缀协议」后，冷启动只付一次，之后每句只付
 * 合成本身的时间（约 1 秒，与网络往返同量级）。对话场景下这个差别很实在。
 *
 * **音频格式**：必须是 **16 kHz 单声道 PCM16 WAV**。
 * 浏览器侧用 `OfflineAudioContext(1, len, 16000)` 重采样 + 手写 44 字节头。
 * 这段不要自己发明：DSH 自带的语音输入插件
 * （`@deepseek-ai/dsh-experimental-client-ui-voice-input`）已经写好并实测可用，
 * 照抄它的 `encodeWave()` 与录制流程。
 *
 * ── 边界（诚实说明）──
 * - 端到端延迟约 3–4.5 秒：录音结束 → ASR（~0.5–1s）→ LLM（1–3s）→ TTS（~1s）。
 * - 本地 SenseVoice **不支持流式**（要等整段音频），所以这条链路的下限降不下来。
 *   想更快只能换云端流式 ASR——那是另一个决定，不要偷偷替换。
 * - TTS 需要 Python 与 `edge-tts` 包；缺任何一个都返回**结构化失败**，不假装成功。
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 默认音色：主人 2026-10 试听 6 个样本后选定（见 docs/DECISIONS.md） */
export const DEFAULT_VOICE = 'zh-CN-XiaoyiNeural';

/** 语速/音调：与原文一致，不修饰 */
export const DEFAULT_RATE = '+0%';

/**
 * 本地 GPT-SoVITS 网关的默认地址。
 *
 * 为什么是 50123 而不是 9880：9880 是 GPT-SoVITS 本体（api_v2.py），
 * 50123 是外面那层网关（C:\DSHwork\models\tts\gsv_gateway.py）。
 * 网关负责「换角色权重 + 按情感挑参考音频 + 拼 prompt_text」这些脏活；
 * 插件直接打 9880 的话，每个调用点都得自己拼那串参数，且换音色要自己管。
 * 与 dsh-qq-group 用的是同一个网关、同一个端口，两边共享一份模型常驻内存。
 */
export const DEFAULT_GATEWAY_ENDPOINT = 'http://127.0.0.1:50123';

/** 网关默认角色与情感（与 gsv_gateway.py 的 DEFAULT_VOICE/DEFAULT_STYLE 对齐） */
export const DEFAULT_GATEWAY_VOICE = '三月七';
export const DEFAULT_GATEWAY_STYLE = '开心';

/** 单次合成超时：热调用约 1 秒，给足 25 秒余量兜卡死 */
const TTS_TIMEOUT_MS = 25_000;

/** ASR 超时：本地模型冷启动最慢几秒，给足余量 */
const ASR_TIMEOUT_MS = 60_000;

/**
 * 常驻 worker 的 Python 源码。
 *
 * 协议（stdin/stdout，二进制）：
 *   请求  = uint32 BE 长度 + UTF-8 JSON {text, voice, rate, pitch, volume}
 *   响应  = uint8 状态（0 = 成功音频，1 = 错误文本）+ uint32 BE 长度 + 载荷
 *
 * 用定长前缀而不是行分隔：MP3 是二进制，任何分隔符都可能出现在音频里。
 *
 * pitch / volume 是后加的（QQ 群唱歌与「换个调说话」要用），**空串表示不传**：
 * edge-tts 对不认的参数会直接抛 TypeError，老版本 edge-tts 上没有这两个关键字，
 * 所以带条件拼 kwargs，而不是一股脑塞进去。
 */
const TTS_WORKER_SCRIPT = String.raw`
import asyncio
import json
import struct
import sys

import edge_tts

DEFAULT_VOICE = "zh-CN-XiaoyiNeural"
DEFAULT_RATE = "+0%"


async def synth(text: str, voice: str, rate: str, pitch: str, volume: str) -> bytes:
    out = bytearray()
    kwargs = {"rate": rate}
    if pitch:
        kwargs["pitch"] = pitch
    if volume:
        kwargs["volume"] = volume
    communicate = edge_tts.Communicate(text, voice, **kwargs)
    async for chunk in communicate.stream():
        if chunk.get("type") == "audio" and chunk.get("data"):
            out.extend(chunk["data"])
    return bytes(out)


def read_exact(stream, size: int) -> bytes:
    data = stream.read(size)
    return data if data is not None else b""


def main() -> int:
    stdin = sys.stdin.buffer
    stdout = sys.stdout.buffer
    while True:
        head = read_exact(stdin, 4)
        if len(head) < 4:
            return 0
        (length,) = struct.unpack(">I", head)
        payload = read_exact(stdin, length)
        if len(payload) < length:
            return 0
        try:
            request = json.loads(payload.decode("utf-8"))
            text = str(request.get("text") or "")
            voice = str(request.get("voice") or DEFAULT_VOICE)
            rate = str(request.get("rate") or DEFAULT_RATE)
            pitch = str(request.get("pitch") or "")
            volume = str(request.get("volume") or "")
            if not text.strip():
                raise ValueError("empty text")
            audio = asyncio.run(synth(text, voice, rate, pitch, volume))
            status, body = 0, audio
        except Exception as exc:  # noqa: BLE001 —— 任何失败都要让 Node 侧看见原因
            status, body = 1, f"{type(exc).__name__}: {exc}".encode("utf-8", "replace")
        stdout.write(bytes([status]))
        stdout.write(struct.pack(">I", len(body)))
        stdout.write(body)
        stdout.flush()


if __name__ == "__main__":
    raise SystemExit(main())
`;

/**
 * 找 Python。
 *
 * 优先级：显式配置 → `DSH_PYTHON` 环境变量 → DSH 自带运行时 → PATH。
 *
 * **显式配置不做存在性检查**：主人写了路径就用它，路径不对时由 spawn 抛 ENOENT、
 * 返回 `python-missing` 并带上那个路径——把配置错误**报出来**。
 * 如果这里偷偷回落到另一个能用的 Python，主人会以为配置生效了，
 * 实际用的是别的解释器（可能没装 edge-tts）。宁可显式失败。
 */
export function resolvePython(configured?: string): string {
  if (configured !== undefined && configured.trim() !== '') return configured.trim();
  if (process.env.DSH_PYTHON) return process.env.DSH_PYTHON;

  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  if (home) {
    // DSH 自带运行时（本机实测存在，且装了 edge-tts 7.3.1）
    const bundled = [
      join(home, '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe'),
      join(home, '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'bin', 'python3'),
    ];
    for (const candidate of bundled) {
      if (existsSync(candidate)) return candidate;
    }
  }

  // PATH 上的 python（最后尝试，由 spawn 自己报 ENOENT）
  return process.platform === 'win32' ? 'python.exe' : 'python3';
}

/** TTS 失败原因（结构化，前端据此显示人话，不静默） */
export type TtsFailure = {
  ok: false;
  reason:
    | 'python-missing'
    | 'edge-tts-missing'
    | 'empty-text'
    | 'timeout'
    | 'worker-dead'
    | 'error'
    /** 本地 GPT-SoVITS 网关没起来 / 地址不对 / 连不上 */
    | 'gateway-unavailable'
    /** 网关在，但返回了错误（模型没加载、参考音频缺失、合成异常…） */
    | 'gateway-error';
  message: string;
};

export type TtsResult = { ok: true; audio: Uint8Array; mime: string } | TtsFailure;

/** 驱动脚本落盘位置（每进程只写一次） */
let scriptPath: string | undefined;
function ensureScript(userRoot: string): string {
  if (scriptPath !== undefined && existsSync(scriptPath)) return scriptPath;
  const dir = join(userRoot, 'cache');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'tts-worker.py');
  writeFileSync(file, TTS_WORKER_SCRIPT, 'utf8');
  scriptPath = file;
  return file;
}

/**
 * 一条合成请求的等待者
 *
 * 为什么这里不用 class：`#private` 字段在 es2020 目标下会被降级成
 * `_defineProperty(...)` 之类的运行时辅助，进而把 `@oxc-project/runtime`
 * 拖成一条**裸 import**——那个包不在本包依赖里，DSH 加载时直接
 * `ERR_MODULE_NOT_FOUND`，插件起不来（上游 tsdown 配置的注释里警告过同一件事）。
 * 闭包没有类字段，产物干净。
 */
type Pending = {
  resolve: (result: TtsResult) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** 常驻 Python 合成 worker 的句柄 */
export type TtsWorkerHandle = {
  synthesize(
    text: string,
    voice: string,
    rate: string,
    extras?: { pitch?: string; volume?: string },
  ): Promise<TtsResult>;
  dispose(): void;
};

/**
 * 建一个常驻 Python 合成 worker。
 *
 * 生命周期：首次合成时启动，进程活着就一直复用；进程死了下次调用自动重启。
 * 所有请求**串行**（Python 侧是单线程循环）——语音是一次一句的，不需要并发；
 * 串行也让「响应与请求配对」变得不需要额外 id。
 */
export function createTtsWorker(python: string, script: string): TtsWorkerHandle {
  let child: ChildProcessWithoutNullStreams | undefined;
  let buffer: Buffer = Buffer.alloc(0);
  let pending: Pending[] = [];
  let starting: Promise<void> | undefined;
  let dead = false;

  /** 按长度前缀切包，逐条兑现等待者 */
  function onData(chunk: Buffer): void {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 5) {
      const status = buffer[0];
      const length = buffer.readUInt32BE(1);
      if (buffer.length < 5 + length) return;
      const body = buffer.subarray(5, 5 + length);
      buffer = buffer.subarray(5 + length);
      const waiting = pending.shift();
      if (waiting === undefined) continue;
      clearTimeout(waiting.timer);
      if (status === 0) {
        waiting.resolve({ ok: true, audio: new Uint8Array(body), mime: 'audio/mpeg' });
      } else {
        const message = body.toString('utf8');
        const isImportError = /ModuleNotFoundError|No module named '?edge_tts/.test(message);
        waiting.resolve({
          ok: false,
          reason: isImportError ? 'edge-tts-missing' : 'error',
          message: isImportError ? 'Python 里没有 edge-tts（请执行 pip install edge-tts）' : message,
        });
      }
    }
  }

  /** 确保进程在跑；失败抛错（由调用方转成结构化失败） */
  function ensure(): Promise<void> {
    if (child !== undefined && !dead) return Promise.resolve();
    if (starting !== undefined) return starting;

    starting = new Promise<void>((resolvePromise, reject) => {
      const spawned = spawn(python, [script], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      let settled = false;

      spawned.on('error', (err: NodeJS.ErrnoException) => {
        if (settled) return;
        settled = true;
        starting = undefined;
        reject(
          err.code === 'ENOENT'
            ? Object.assign(new Error(`找不到 Python：${python}`), { code: 'python-missing' })
            : err,
        );
      });

      spawned.on('spawn', () => {
        if (settled) return;
        settled = true;
        child = spawned;
        buffer = Buffer.alloc(0);
        dead = false;
        starting = undefined;
        resolvePromise();
      });

      spawned.stdout.on('data', (chunk: Buffer) => onData(chunk));
      spawned.stderr.on('data', () => {
        /* Python 的 stderr 只用于诊断；错误已通过响应状态字节回传 */
      });
      spawned.on('close', () => {
        dead = true;
        child = undefined;
        // 所有等待中的请求都要有结论，不能永远挂着
        const waiting = pending;
        pending = [];
        for (const p of waiting) {
          clearTimeout(p.timer);
          p.resolve({ ok: false, reason: 'worker-dead', message: '语音合成进程意外退出' });
        }
      });
    });

    return starting;
  }

  async function synthesize(
    text: string,
    voice: string,
    rate: string,
    extras: { pitch?: string; volume?: string } = {},
  ): Promise<TtsResult> {
    const trimmed = text.trim();
    if (trimmed === '') return { ok: false, reason: 'empty-text', message: '要合成的文本为空' };

    try {
      await ensure();
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === 'python-missing') return { ok: false, reason: 'python-missing', message: err.message };
      return { ok: false, reason: 'error', message: err.message };
    }

    const running = child;
    if (running === undefined) return { ok: false, reason: 'worker-dead', message: '语音合成进程不可用' };

    // 空串会被 Python 侧跳过（见 TTS_WORKER_SCRIPT 的注释）：不传参数 = 用 edge-tts 默认
    const payload = Buffer.from(
      JSON.stringify({
        text: trimmed,
        voice,
        rate,
        pitch: extras.pitch ?? '',
        volume: extras.volume ?? '',
      }),
      'utf8',
    );
    const header = Buffer.alloc(4);
    header.writeUInt32BE(payload.length, 0);

    return new Promise<TtsResult>((resolvePromise) => {
      const timer = setTimeout(() => {
        // 超时：把这一条从队列摘掉，并**杀掉进程**——晚到的响应对不上号，
        // 留着它只会让后续请求全部错位。
        pending = pending.filter((p) => p.timer !== timer);
        child?.kill();
        resolvePromise({ ok: false, reason: 'timeout', message: `语音合成超时（${TTS_TIMEOUT_MS} ms）` });
      }, TTS_TIMEOUT_MS);

      pending.push({ resolve: resolvePromise, timer });
      try {
        running.stdin.write(header);
        running.stdin.write(payload);
      } catch (e) {
        clearTimeout(timer);
        pending = pending.filter((p) => p.timer !== timer);
        resolvePromise({ ok: false, reason: 'worker-dead', message: e instanceof Error ? e.message : String(e) });
      }
    });
  }

  /** 插件卸载时收掉子进程，别留孤儿 */
  function dispose(): void {
    child?.kill();
    child = undefined;
    dead = true;
  }

  return { synthesize, dispose };
}

/** 每个 (python, 用户目录) 组合一个 worker —— 正常情况只有一个 */
const workers = new Map<string, TtsWorkerHandle>();

/** 取（或建）worker；key 里带 python 路径，换解释器时不会复用旧进程 */
function workerFor(python: string, userRoot: string): TtsWorkerHandle {
  const key = `${python}::${userRoot}`;
  const existing = workers.get(key);
  if (existing !== undefined) return existing;
  const created = createTtsWorker(python, ensureScript(userRoot));
  workers.set(key, created);
  return created;
}

/** 插件 dispose 时调用：杀掉所有常驻 worker，别留孤儿进程 */
export function disposeVoiceWorkers(): void {
  for (const worker of workers.values()) worker.dispose();
  workers.clear();
}


/**
 * 本地 TTS 网关（GPT-SoVITS）合成。
 *
 * ── 为什么要走 HTTP 网关而不是直接调 Python ──
 * GPT-SoVITS 本体是一个常驻的 Python 服务（api_v2.py 听 9880），换音色要重新加载
 * 上百 MB 权重。把它塞进宿主进程既没法热重载、又会让插件启动慢几十秒。
 * 所以这里只做一件事：**调一个已经在跑的 HTTP 网关**（默认 127.0.0.1:50123）。
 * 网关负责切换权重、挑情感参考音频；插件只知道「给文本和音色，拿 WAV」。
 *
 * ── 为什么必须先健康检查 ──
 * 服务没起来时 fetch 会等到超时（网关内部给合成留了 180 秒）。桌宠按住说话是
 * **实时交互**，等三分钟等于卡死。所以先打 /health，2.5 秒不通就直接回退 edge-tts。
 *
 * ── 为什么返回 WAV 也要检查 ──
 * 网关出错时返回的是 JSON 错误体，不是音频。只看 `response.ok` 会把一段 JSON
 * 当音频丢给播放器，表现为「点了没声，也没有报错」——最难查的那种。所以校验 RIFF 头。
 */
async function synthesizeGateway(
  endpoint: string,
  text: string,
  options: { voice?: string; style?: string },
): Promise<TtsResult> {
  const base = endpoint.trim().replace(/\/+$/, '');
  if (base === '') {
    return { ok: false, reason: 'gateway-unavailable', message: '本地 TTS 网关地址为空（voice.json 的 endpoint）' };
  }

  try {
    const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2_500) });
    if (!health.ok) {
      return { ok: false, reason: 'gateway-unavailable', message: `本地 TTS 网关未就绪（HTTP ${health.status}）` };
    }
  } catch (e) {
    return {
      ok: false,
      reason: 'gateway-unavailable',
      message: `本地 TTS 网关不可用：${base}（${e instanceof Error ? e.message : String(e)}）`,
    };
  }

  try {
    // 合成超时给 120 秒：实测 CPU 上热态 2.4~3.3 秒/句，但换音色后的第一句
    // 要加载权重（几十秒），不能按热态的时间卡。
    const response = await fetch(`${base}/tts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text,
        ...(options.voice === undefined ? {} : { voice: options.voice }),
        ...(options.style === undefined ? {} : { style: options.style }),
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      return { ok: false, reason: 'gateway-error', message: `本地 TTS 网关 ${response.status}：${detail.slice(0, 300)}` };
    }
    const audio = new Uint8Array(await response.arrayBuffer());
    if (audio.length < 12 || audio[0] !== 0x52 || audio[1] !== 0x49 || audio[2] !== 0x46 || audio[3] !== 0x46) {
      return { ok: false, reason: 'gateway-error', message: '本地 TTS 网关没有返回 WAV（RIFF 头缺失）' };
    }
    return { ok: true, audio, mime: 'audio/wav' };
  } catch (e) {
    return {
      ok: false,
      reason: 'gateway-error',
      message: `本地 TTS 网关调用失败：${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * 合成一段语音。
 *
 * ── 两条路：本地 GPT-SoVITS 优先，edge-tts 回退 ──
 * `voice.json` 里 `provider` 决定走哪条：
 *   - `"gpt-sovits"`（推荐）：用本地网关，音色/情感都由它决定；**失败自动回退 edge**
 *   - `"edge"`（默认）：原来的 edge-tts，音色是微软的名字（zh-CN-XiaoyiNeural 之类）
 *
 * 回退这一步不能省：网关是独立进程，主人没启动它、或者它崩了的时候，
 * 若直接抛错，桌宠就**彻底不会说话**了。回退到 edge 至少还有声音，日志里会写明原因。
 *
 * @param userRoot 插件用户目录（$DSH_HOME/dsh-whale-girl），用于落 worker 脚本
 * @param text 要合成的文本（纯文本；由调用方保证不含标记）
 * @param options 音色 / 语速 / 音高 / 音量 / 解释器 / 供应商 / 网关地址 / 情感
 */
export async function synthesize(
  userRoot: string,
  text: string,
  options: {
    voice?: string;
    rate?: string;
    pitch?: string;
    volume?: string;
    pythonPath?: string;
    /** 'gpt-sovits' 走本地网关；缺省 'edge' */
    provider?: 'edge' | 'gpt-sovits';
    /** 本地网关地址，如 http://127.0.0.1:50123 */
    endpoint?: string;
    /** 情感风格（网关决定支持哪些，如 开心/生气/中立） */
    style?: string;
  } = {},
): Promise<TtsResult> {
  const provider = options.provider ?? 'edge';

  if (provider === 'gpt-sovits') {
    const local = await synthesizeGateway(options.endpoint ?? DEFAULT_GATEWAY_ENDPOINT, text, {
      voice: options.voice,
      style: options.style,
    });
    if (local.ok) return local;
    // 回退：不让「网关没启动」变成「桌宠不会说话」
    console.warn(`[dsh-whale-girl] 本地 GPT-SoVITS 失败，回退 edge-tts：${local.message}`);
  }

  // edge 的音色必须是合法的微软名字（`xx-XX-XxxNeural`）。
  // 网关那边的音色是角色名（三月七/青雀…），直接传给 edge 会被拒，所以要换掉。
  const edgeVoice =
    typeof options.voice === 'string' && /^[a-z]{2}-[A-Z]{2}-/i.test(options.voice)
      ? options.voice
      : DEFAULT_VOICE;

  const python = resolvePython(options.pythonPath);
  const worker = workerFor(python, userRoot);
  return worker.synthesize(text, edgeVoice, options.rate ?? DEFAULT_RATE, {
    pitch: options.pitch,
    volume: options.volume,
  });
}

/** ASR 结果 */
export type AsrResult =
  | { ok: true; text: string; audioSeconds: number }
  | { ok: false; reason: 'service-missing' | 'provider-missing' | 'empty-audio' | 'error'; message: string };

/**
 * 识别一段 16 kHz 单声道 PCM16 WAV。
 *
 * 走 DSH 的 `speechToText` 服务：它已经管好 provider 选择与语言。
 * 本插件不指定 provider（跟随用户在 DSH 里的选择）。
 */
export async function transcribe(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- DSH 注入的 ctx 无静态类型
  ctx: any,
  audio: Uint8Array,
  options: { language?: string; signal?: AbortSignal } = {},
): Promise<AsrResult> {
  if (audio.length === 0) {
    return { ok: false, reason: 'empty-audio', message: '录音为空' };
  }

  // 软取：没装语音识别插件时不在场。
  // 注意**不能**写 `ctx.get(...) ?? ctx.speechToText`：后者是硬访问，
  // 服务不存在时 cordis 会抛 `cannot get property "speechToText" without inject`，
  // 整个 /voice/turn 变成 500，前端表现就是「说完没反应」（2026-10-19 踩到）。
  let raw: unknown;
  try {
    raw = ctx.get?.('speechToText', false);
  } catch {
    raw = undefined;
  }
  const stt = raw as
    | { resolve?: unknown; transcribe?: unknown; snapshot?: () => { selection?: { providerId?: string } } }
    | undefined;
  if (stt === undefined || typeof stt.resolve !== 'function' || typeof stt.transcribe !== 'function') {
    return {
      ok: false,
      reason: 'service-missing',
      message: 'DSH 的语音识别服务不可用（没装/没启用 speechToText）',
    };
  }

  try {
    const snapshot = stt.snapshot?.();
    const providerId = snapshot?.selection?.providerId;
    if (!providerId) {
      return {
        ok: false,
        reason: 'provider-missing',
        message: '没有可用的语音识别 provider（请在 DSH 设置里启用语音识别）',
      };
    }
  } catch (e) {
    return { ok: false, reason: 'error', message: e instanceof Error ? e.message : String(e) };
  }

  const signal = options.signal ?? AbortSignal.timeout(ASR_TIMEOUT_MS);
  try {
    const spec = stt.resolve({
      audio,
      ...(options.language === undefined ? {} : { language: options.language }),
    });
    const transcript = await stt.transcribe(spec, signal);
    const text = String(transcript?.text ?? '').trim();
    if (text === '') {
      return { ok: false, reason: 'error', message: '没听清（识别结果为空）' };
    }
    return { ok: true, text, audioSeconds: Number(transcript?.audioSeconds ?? 0) };
  } catch (e) {
    return { ok: false, reason: 'error', message: e instanceof Error ? e.message : String(e) };
  }
}

/** 请求体里 audio 的 base64 解码（容忍 data URL 前缀） */
export function decodeAudioBase64(input: string): Uint8Array | undefined {
  const raw = input.includes(',') ? input.slice(input.indexOf(',') + 1) : input;
  if (raw.trim() === '') return undefined;
  try {
    const buf = Buffer.from(raw, 'base64');
    return buf.length === 0 ? undefined : new Uint8Array(buf);
  } catch {
    return undefined;
  }
}