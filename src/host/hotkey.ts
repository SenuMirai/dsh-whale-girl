/**
 * 全局快捷键（按住说话）：让「离开 DSH 窗口 / 最小化 / 被别的应用挡住」时也能用语音。
 *
 * ── 为什么浏览器做不到 ──
 * 页面里的 `keydown` 只在该页面有焦点时才会触发。窗口一失焦（切到游戏、记事本、桌面），
 * 页面根本收不到按键——这不是我们的事件监听写错了，是浏览器安全模型。
 * 想要「系统级热键」必须有一个**不依赖焦点**的原生侧观察者。
 *
 * ── 为什么不用 RegisterHotKey / Electron globalShortcut ──
 * 1. `RegisterHotKey` 注册的是一次性按下事件，拿不到「松开」；按住说话需要 keyup。
 * 2. 注册热键会被前台应用抢走（和急停那次踩的坑一样），全屏程序里经常收不到。
 * 3. 轮询 `GetAsyncKeyState` 两个问题都没有：不依赖焦点、能看到按下/松开。
 *    急停监听用的就是这条路，实测在全屏游戏里也能读到。
 *
 * ── 这条链路 ──
 * 宿主 PowerShell 轮询（25ms）→ 边沿检测（DOWN/UP）→ SSE 推给页面 → 页面驱动录音。
 * 页面侧的 `keydown/keyup` 仍然保留：它是「窗口有焦点时」的零延迟路径，
 * 两条路都会触发，但录音状态机有防重入，不会开出两个录音器。
 *
 * ⚠️ 多标签页：SSE 是广播，同一个 DSH 开两个标签页时两边都会收到。
 * 正常只用一扇窗口时无影响；真遇到再补「标签页选主」（别为此把链路搞复杂）。
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerResponse } from 'node:http';

/** 默认快捷键（与页面 src/client/voice-client.ts 的 DEFAULT_SHORTCUT 保持一致） */
export const DEFAULT_VOICE_SHORTCUT = 'Alt+V';

/** 解析后的快捷键：一个主键 + 四个修饰键的精确状态 */
export type HotkeySpec = {
  /** 主键虚拟码（VK） */
  vk: number;
  alt: boolean;
  ctrl: boolean;
  shift: boolean;
  win: boolean;
};

export type HotkeyParse = { ok: true; spec: HotkeySpec; display: string } | { ok: false; message: string };

/** 一次全局热键事件（只关心按下/松开这两个边沿） */
export type HotkeyEvent = { type: 'down' | 'up'; atMs: number };

/** 修饰键虚拟码 */
const VK = {
  ctrl: 0x11,
  alt: 0x12,
  shift: 0x10,
  winLeft: 0x5b,
  winRight: 0x5c,
} as const;

/** 具名主键 → VK */
const NAMED_KEYS: Record<string, number> = {
  space: 0x20,
  enter: 0x0d,
  return: 0x0d,
  tab: 0x09,
  esc: 0x1b,
  escape: 0x1b,
  backspace: 0x08,
  delete: 0x2e,
  insert: 0x2d,
  home: 0x24,
  end: 0x23,
  pageup: 0x21,
  pagedown: 0x22,
  arrowleft: 0x25,
  left: 0x25,
  arrowup: 0x26,
  up: 0x26,
  arrowright: 0x27,
  right: 0x27,
  arrowdown: 0x28,
  down: 0x28,
  // 标点（US 布局的 OEM 虚拟码；与页面里 event.key 的写法一致）
  '`': 0xc0,
  backquote: 0xc0,
  '-': 0xbd,
  minus: 0xbd,
  '=': 0xbb,
  equal: 0xbb,
  '[': 0xdb,
  bracketleft: 0xdb,
  ']': 0xdd,
  bracketright: 0xdd,
  '\\': 0xdc,
  backslash: 0xdc,
  ';': 0xba,
  semicolon: 0xba,
  "'": 0xde,
  quote: 0xde,
  ',': 0xbc,
  comma: 0xbc,
  '.': 0xbe,
  period: 0xbe,
  '/': 0xbf,
  slash: 0xbf,
};

/** 修饰键写法（页面与宿主共用一套语义） */
const MOD_ALIASES: Record<string, 'alt' | 'ctrl' | 'shift' | 'win'> = {
  alt: 'alt',
  ctrl: 'ctrl',
  control: 'ctrl',
  shift: 'shift',
  meta: 'win',
  cmd: 'win',
  win: 'win',
  super: 'win',
};

/** 主键名 → VK（不认识 → undefined） */
function resolveMainVk(key: string): number | undefined {
  // 单字母 / 数字
  if (/^[a-z]$/.test(key)) return 0x41 + (key.charCodeAt(0) - 97);
  if (/^[0-9]$/.test(key)) return 0x30 + Number(key);
  // F1–F24
  const fn = /^f([1-9]|1[0-9]|2[0-4])$/.exec(key);
  if (fn !== null) return 0x70 + (Number(fn[1]) - 1);
  return NAMED_KEYS[key];
}

/**
 * 解析快捷键字符串（与页面 `parseShortcut` 同一套语法：`Alt+V` / `Ctrl+Shift+Space` / `F8`）。
 *
 * 与页面版本唯一的差别：这里要落到**Windows 虚拟码**，所以只支持
 * 字母 / 数字 / F1–F24 / 常见具名键 / 常见标点；解析不了就明确报错，
 * 绝不「静默降级成某个默认键」——主人按了没反应会比报错更难查。
 */
export function parseHotkey(text: string): HotkeyParse {
  const raw = typeof text === 'string' ? text.trim() : '';
  if (raw === '') return { ok: false, message: '快捷键为空' };
  const parts = raw
    .split('+')
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part !== '');
  if (parts.length === 0) return { ok: false, message: '快捷键为空' };
  const key = parts[parts.length - 1];
  const modParts = parts.slice(0, -1);
  if (key === '') return { ok: false, message: '快捷键缺少主键' };
  if (MOD_ALIASES[key] !== undefined) {
    return { ok: false, message: '主键不能是修饰键（写成 ' + raw + '+X 这种形式）' };
  }
  const spec: HotkeySpec = { vk: 0, alt: false, ctrl: false, shift: false, win: false };
  for (const part of modParts) {
    const mod = MOD_ALIASES[part];
    if (mod === undefined) return { ok: false, message: '不认识的修饰键：' + part };
    spec[mod] = true;
  }
  const vk = resolveMainVk(key);
  if (vk === undefined) return { ok: false, message: '系统级热键暂不支持这个主键：' + key };
  spec.vk = vk;

  // 展示用（与用户输入无关，统一成 Ctrl+Alt+Shift+Win 顺序）
  const displayMods = [
    spec.ctrl ? 'Ctrl' : '',
    spec.alt ? 'Alt' : '',
    spec.shift ? 'Shift' : '',
    spec.win ? 'Win' : '',
  ].filter((part) => part !== '');
  const displayKey = key.length === 1 ? key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1);
  return { ok: true, spec, display: [...displayMods, displayKey].join('+') };
}

/** 全局热键监听器的句柄 */
export type HotkeyWatcher = {
  /** 停止监听（幂等） */
  stop: () => void;
  /** 轮询进程是否还活着 */
  running: () => boolean;
  /** 轮询进程是否已完成 Add-Type 并进入循环（启动有几百毫秒编译期） */
  ready: () => boolean;
};

/** 轮询间隔（ms）：20~30ms 是「手感即时」与「CPU 可忽略」的折中 */
const POLL_MS = 25;

/**
 * 起一个常驻 PowerShell 轮询进程监听全局热键。
 *
 * 实现要点（与 estop.ts 同源，踩过的坑不再踩）：
 * - C# 用**单行** `Add-Type -TypeDefinition`（5.1 不认 `-MemberDefinition` 的写法）；
 * - 带 `while` 的多行脚本必须落成 `.ps1` 用 `-File` 跑，从 stdin 灌进去会一行都不执行；
 * - 只在边沿（false→true / true→false）输出，进程不会刷屏。
 *
 * @param spec 解析好的快捷键
 * @param onEvent 按下 / 松开回调（在宿主进程里同步调用）
 */
export function startHotkeyWatcher(spec: HotkeySpec, onEvent: (event: HotkeyEvent) => void): HotkeyWatcher {
  let alive = false;
  if (process.platform !== 'win32') {
    // 明确说明「不支持」而不是假装在听：主人按了没反应时能一眼看到原因
    console.warn('[dsh-whale-girl] 全局语音热键只支持 Windows（当前平台：' + process.platform + '）');
    return { stop: () => {}, running: () => false, ready: () => false };
  }

  const bool = (value: boolean): string => (value ? 'true' : 'false');
  const cs = [
    'using System;',
    'using System.Runtime.InteropServices;',
    'public static class DshVoiceHotkeyMonitor {',
    '  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);',
    '  static bool D(int k) { return (GetAsyncKeyState(k) & 0x8000) != 0; }',
    '  public static bool Hit() {',
    '    if (!D(' + String(spec.vk) + ')) return false;',
    '    if (D(' + String(VK.ctrl) + ') != ' + bool(spec.ctrl) + ') return false;',
    '    if (D(' + String(VK.alt) + ') != ' + bool(spec.alt) + ') return false;',
    '    if (D(' + String(VK.shift) + ') != ' + bool(spec.shift) + ') return false;',
    '    bool win = D(' + String(VK.winLeft) + ') || D(' + String(VK.winRight) + ');',
    '    if (win != ' + bool(spec.win) + ') return false;',
    '    return true;',
    '  }',
    '}',
  ].join(' ');

  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition '${cs.replace(/'/g, "''")}' | Out-Null
[Console]::Out.WriteLine('READY')
[Console]::Out.Flush()
$last = $false
while ($true) {
  $hit = [DshVoiceHotkeyMonitor]::Hit()
  if ($hit -ne $last) {
    if ($hit) { [Console]::Out.WriteLine('DOWN') } else { [Console]::Out.WriteLine('UP') }
    [Console]::Out.Flush()
    $last = $hit
  }
  Start-Sleep -Milliseconds ${POLL_MS}
}
`;

  const scriptPath = join(tmpdir(), `dsh-voice-hotkey-${process.pid}-${Date.now()}.ps1`);
  writeFileSync(scriptPath, script, 'utf8');

  /**
   * spawn 本身可能**同步抛出**（不只是异步 error 事件）。
   *
   * 实测踩到：在受限环境里 `spawn()` 直接抛 `EPERM`，而这里原本没有 try/catch，
   * 于是异常一路上传到 `apply()` → `ctx.effect()`，插件激活失败 →
   * **DSH 整个起不来**（见 docs/ROADMAP.md 坑 7：启动失败会触发回滚，
   * 连模型配置、权限预设、皮肤一起被清掉）。
   *
   * 全局语音热键只是锦上添花的能力：它起不来时应该只降级（热键不可用、
   * 按钮仍能录音），绝不能让宿主启动失败。异步的 error 事件本来就只打日志，
   * 这里补上同步路径，让两条路的口径一致。
   */
  let child: ChildProcessWithoutNullStreams;
  try {
    // stdio 默认是 'pipe'，所以这里拿到的一定是非 null 的三个流；
    // 显式声明成 ChildProcessWithoutNullStreams 就是为了让下游不用到处写 ?.
    child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      { windowsHide: true },
    ) as ChildProcessWithoutNullStreams;
  } catch (error) {
    alive = false;
    console.warn(
      '[dsh-whale-girl] 全局语音热键监听启动失败（进程起不来）：' +
        (error instanceof Error ? error.message : String(error)) +
        '——热键不可用，但录音按钮与页面快捷键仍然工作',
    );
    return {
      stop: () => {
        /* 没起来就不用停 */
      },
      running: () => false,
      ready: () => false,
    };
  }
  alive = true;
  let ready = false;

  let buffer = '';
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (process.env.DSH_HOTKEY_DEBUG === '1') console.log('[hotkey] line=' + JSON.stringify(trimmed));
      if (trimmed === 'READY') {
        ready = true;
        continue;
      }
      if (trimmed === 'DOWN') onEvent({ type: 'down', atMs: Date.now() });
      else if (trimmed === 'UP') onEvent({ type: 'up', atMs: Date.now() });
    }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    // 排障开关：启动失败时 PowerShell 的报错就是唯一线索
    if (process.env.DSH_HOTKEY_DEBUG === '1') console.log('[hotkey] ' + chunk.toString('utf8').trim());
  });
  child.on('error', (error: Error) => {
    alive = false;
    console.warn('[dsh-whale-girl] 全局语音热键监听启动失败：' + error.message);
  });
  child.on('exit', () => {
    alive = false;
  });

  let stopped = false;
  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      alive = false;
      try {
        child.kill();
      } catch {
        /* 已经退出 */
      }
      try {
        unlinkSync(scriptPath);
      } catch {
        /* 文件可能已被清理 */
      }
    },
    running: () => alive && !stopped,
    ready: () => ready,
  };
}

/** 页面订阅 SSE 的地址（宿主与页面共用同一个常量，改一处即可） */
export const HOTKEY_STREAM_PATH = '/voice/hotkey/stream';

export type HotkeyHub = {
  /** 接纳一个 SSE 订阅；返回取消订阅的函数 */
  subscribe: (res: ServerResponse, ready: () => unknown) => () => void;
  /** 向所有订阅者推送一次热键事件 */
  broadcast: (event: HotkeyEvent) => void;
  /** 当前订阅者数量 */
  clients: () => number;
  /** 关闭所有订阅（插件卸载时调用） */
  close: () => void;
};

/**
 * SSE 广播器：把宿主侧的热键事件推给所有打开的页面。
 *
 * 为什么用 SSE 而不是轮询 `/state`：
 * 按住说话对**延迟**敏感（现在 /state 是 1 秒一轮），而 SSE 是推送、毫秒级；
 * 且 DSH 的 webserver 已经明确把 `text/event-stream` 排除在 gzip 之外
 * （见 dsh-host-webserver 的 filter），说明这就是它预期的长连接用法。
 */
export function createHotkeyHub(): HotkeyHub {
  const clients = new Set<ServerResponse>();

  // 心跳：注释帧（以 `:` 开头）不会触发页面事件，只用来保活
  const heartbeat = setInterval(() => {
    for (const client of clients) {
      try {
        client.write(': ping\n\n');
      } catch {
        clients.delete(client);
      }
    }
  }, 15000);
  // 别让心跳把宿主进程吊着不退出
  heartbeat.unref?.();

  const write = (client: ServerResponse, frame: string): void => {
    try {
      client.write(frame);
    } catch {
      clients.delete(client);
    }
  };

  return {
    subscribe: (res, ready) => {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        // 就算以后前面挂了个会缓冲的代理，也让它别攒包
        'x-accel-buffering': 'no',
      });
      res.flushHeaders?.();
      // 先登记再发 ready：ready 里的 clients 计数包含刚连上的这一位
      clients.add(res);
      write(res, 'event: ready\ndata: ' + JSON.stringify(ready()) + '\n\n');
      const drop = (): void => {
        clients.delete(res);
      };
      res.on('close', drop);
      res.on('error', drop);
      return drop;
    },
    broadcast: (event) => {
      const frame = 'event: hotkey\ndata: ' + JSON.stringify(event) + '\n\n';
      for (const client of clients) write(client, frame);
    },
    clients: () => clients.size,
    close: () => {
      for (const client of clients) {
        try {
          client.end();
        } catch {
          /* 已断开 */
        }
      }
      clients.clear();
      clearInterval(heartbeat);
    },
  };
}
