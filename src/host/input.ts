/**
 * 键鼠注入：让她能「真的动手」。
 *
 * ── 安全立场（先读这段再读代码）──
 *
 * 这是一段**能让程序操作主人电脑**的能力。设计上守三条：
 *
 * 1. **默认关**，而且**必须有急停**才允许启用（见 estop.ts）。
 * 2. **只做被要求的那一下**：本模块不决定「什么时候按什么」，只负责把
 *    「按下 W、松开 W、移动到这里、点一下」执行出去。决策在上层，可审计。
 * 3. **白名单**：只对配置里列出的窗口标题注入。前台窗口不匹配就拒绝——
 *    防止她照着游戏截图，把按键打进微信/浏览器。
 *
 * ── 实现坑（踩过，别再踩）──
 *
 * PowerShell **从 stdin 读脚本**时，`@'...'@` / `@"..."@` 这类 here-string
 * 会**静默失效**：退出码 0、stdout 全空、stderr 也空。截图模块栽过一次，
 * 这里必须用单行的 `Add-Type -MemberDefinition` 注册 P/Invoke。
 */

import { spawn } from 'node:child_process';

/** 支持的输入动作（刻意保持最小集：能表达点击/拖拽与按键就够了） */
export type InputAction =
  | { kind: 'move'; x: number; y: number }
  | { kind: 'click'; x: number; y: number; button?: 'left' | 'right' }
  /**
   * 按住左键从 from 拖到 to 再松开。
   *
   * 为什么必须有：战棋类游戏（Wargroove 等）移动单位是**拖拽**——
   * 按在单位上、拖到目标格、松开；只 click 是选不中也移不动的（真机实测）。
   */
  | { kind: 'drag'; fromX: number; fromY: number; toX: number; toY: number }
  | { kind: 'key'; key: string; holdMs?: number }
  | { kind: 'keyDown'; key: string }
  | { kind: 'keyUp'; key: string }
  | { kind: 'type'; text: string };

/** 执行结果：成功/失败都带结构化原因，不静默 */
export type InputResult = { ok: true; elapsedMs: number } | { ok: false; reason: string; message: string };

/**
 * 键名 → Windows 虚拟键码。
 *
 * 只收「游戏与桌面导航会用到」的那一批；不提供「随便填字符串」的后门
 * （那等于把键盘交给模型，风险不可控）。
 */
const VK: Record<string, number> = {
  up: 0x26,
  down: 0x28,
  left: 0x25,
  right: 0x27,
  space: 0x20,
  enter: 0x0d,
  esc: 0x1b,
  tab: 0x09,
  shift: 0x10,
  ctrl: 0x11,
  alt: 0x12,
  a: 0x41, b: 0x42, c: 0x43, d: 0x44, e: 0x45, f: 0x46, g: 0x47, h: 0x48,
  i: 0x49, j: 0x4a, k: 0x4b, l: 0x4c, m: 0x4d, n: 0x4e, o: 0x4f, p: 0x50,
  q: 0x51, r: 0x52, s: 0x53, t: 0x54, u: 0x55, v: 0x56, w: 0x57, x: 0x58,
  y: 0x59, z: 0x5a,
  '0': 0x30, '1': 0x31, '2': 0x32, '3': 0x33, '4': 0x34,
  '5': 0x35, '6': 0x36, '7': 0x37, '8': 0x38, '9': 0x39,
};

/**
 * 把键名归一化并查表；不认识 → undefined（上层据此拒绝，而不是瞎按一个键）。
 *
 * @param name 键名，如 `w` / `space` / `f1`
 * @param extra 用户自己加进白名单的键（`sight.json` 的 `extraKeys`），优先于内置表。
 *              允许主人按游戏需要扩：`{"f1": 112, "num5": 101}` 这样写 VK 码即可。
 */
export function resolveKey(name: string, extra?: Record<string, number>): number | undefined {
  const key = name.trim().toLowerCase();
  if (key === '') return undefined;
  if (extra !== undefined && typeof extra[key] === 'number' && Number.isFinite(extra[key])) {
    const v = Math.trunc(extra[key]);
    // 只收 Windows 虚拟键码的合法区间，防止配置里写个天文数字
    if (v > 0 && v < 0x100) return v;
  }
  return VK[key];
}

/**
 * 内置键表（**可扩展**，不是封闭集合）。
 *
 * 主人可以直接往 `sight.json` 的 `extraKeys` 里加，形如：
 * ```json
 * { "extraKeys": { "f1": 112, "num5": 101, "oemcomma": 188 } }
 * ```
 * 这样遇到新游戏要按没收录的键，不用改代码。
 */
export const BUILTIN_KEYS: Readonly<Record<string, number>> = VK;

/** 列出内置键名（设置页展示用） */
export function builtinKeyNames(): string[] {
  return Object.keys(VK).sort();
}

/**
 * PowerShell 前置：注册 user32 的 P/Invoke。
 *
 * **必须是单行字符串形式的 `-TypeDefinition`**。
 *  - here-string（`@'...'@`）在这条 stdin 通道上会静默失效（退出码 0、stdout 空）；
 *  - `-MemberDefinition` 又不支持嵌套结构体与辅助函数。
 * 所以把整段 C# 压成一行、用单引号包起来传进去。
 */
const CS_TYPE = [
  'using System;',
  'using System.Runtime.InteropServices;',
  'using System.Text;',
  'public static class DshInApi {',
  '  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }',
  '  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }',
  '  [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }',
  '  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION u; }',
  '  [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint n, INPUT[] p, int cb);',
  '  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);',
  '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
  '  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);',
  '  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int max);',
  '  public static string ForegroundTitle() {',
  '    IntPtr h = GetForegroundWindow();',
  '    int len = GetWindowTextLength(h);',
  '    StringBuilder sb = new StringBuilder(len + 2);',
  '    GetWindowText(h, sb, sb.Capacity);',
  '    return sb.ToString();',
  '  }',
  '  public static void Mouse(uint down, uint up) {',
  '    INPUT[] arr = new INPUT[2];',
  '    arr[0].type = 0; arr[0].u.mi.dwFlags = down;',
  '    arr[1].type = 0; arr[1].u.mi.dwFlags = up;',
  '    SendInput(2, arr, Marshal.SizeOf(typeof(INPUT)));',
  '  }',
  '  public static void Key(int vk, bool up) {',
  '    INPUT[] arr = new INPUT[1];',
  '    arr[0].type = 1;',
  '    arr[0].u.ki.wVk = (ushort)vk;',
  '    arr[0].u.ki.dwFlags = up ? 2u : 0u;',
  '    SendInput(1, arr, Marshal.SizeOf(typeof(INPUT)));',
  '  }',
  '}',
].join(' ');

const PS_PRELUDE = `
$ErrorActionPreference = 'Stop'
# 窗口标题常含中文：不显式指定 UTF-8 的话，Node 侧拿到的是乱码
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition '${CS_TYPE.replace(/'/g, "''")}' | Out-Null
`;

/** 跑一段 PowerShell（脚本从 stdin 送）。 */
function runPowerShell(script: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'],
      { windowsHide: true },
    );
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('注入超时'));
    }, 15_000);
    child.stdout.on('data', (c: Buffer) => {
      stdout += c.toString('utf8');
    });
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`注入脚本退出码 ${String(code)}：${stderr.trim().slice(0, 300)}`));
        return;
      }
      resolvePromise({ stdout, stderr });
    });
    child.stdin.end(script, 'utf8');
  });
}

/** 取当前前台窗口标题（白名单校验 + 设置页探针都用它） */
export async function foregroundWindowTitle(): Promise<string> {
  // 标题常含中文。PowerShell 的 stdout 在这条管道上会按控制台代码页编码，
  // 直接传字符串到 Node 侧就是乱码（实测「开始新项目」变成一串问号）。
  // 改成 **base64 传字节**，绕开所有编码猜测。
  const { stdout } = await runPowerShell(
    `${PS_PRELUDE}\n$b = [System.Text.Encoding]::UTF8.GetBytes([DshInApi]::ForegroundTitle())\n[Console]::Out.Write([Convert]::ToBase64String($b))`,
  );
  const b64 = stdout.trim();
  if (b64 === '') return '';
  try {
    return Buffer.from(b64, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

/**
 * 执行一个输入动作。
 *
 * @param action 要做的动作
 * @param guard 安全门：前台窗口标题必须包含 `allowedTitles` 里的任一条；
 *              空数组 = 不限制（调用方必须**显式**选择不限制）
 */
export async function performInput(
  action: InputAction,
  guard: {
    allowedTitles: string[];
    extraKeys?: Record<string, number>;
    /**
     * 自定义标题匹配（可选）。默认是 `title.includes(条)`。
     * 代打会传带「中文名 ↔ 英文窗口标题」别名的匹配器（见 autoplay.ts 的 windowMatchesAllowed）。
     * 放在参数里而不是 import：input.ts 要被 tools 下的测试直接跑，不能引相对路径运行时依赖。
     */
    matchesTitle?: (title: string, allowedTitles: string[]) => boolean;
  },
): Promise<InputResult> {
  const started = Date.now();

  // 白名单前置检查：拿当前前台标题，不匹配直接拒绝。
  // 必须在**注入之前**做，避免「先点了再发现打错窗口」。
  if (guard.allowedTitles.length > 0) {
    try {
      const title = await foregroundWindowTitle();
      const matcher =
        guard.matchesTitle ??
        ((current: string, allowed: string[]): boolean => allowed.some((t) => t !== '' && current.includes(t)));
      const allowed = matcher(title, guard.allowedTitles);
      if (!allowed) {
        return {
          ok: false,
          reason: 'window-not-allowed',
          message: `前台窗口不在白名单里（当前：${title === '' ? '无标题' : title}）`,
        };
      }
    } catch (e) {
      return { ok: false, reason: 'guard-failed', message: e instanceof Error ? e.message : String(e) };
    }
  }

  let body = '';
  switch (action.kind) {
    case 'move':
      body = `[void][DshInApi]::SetCursorPos(${Math.round(action.x)}, ${Math.round(action.y)})`;
      break;
    case 'click': {
      const btn = action.button ?? 'left';
      const down = btn === 'right' ? '0x08' : '0x02';
      const up = btn === 'right' ? '0x10' : '0x04';
      // 先移动、停一下、再按下/抬起：SetCursorPos 与鼠标事件同一瞬间发出时，
      // 有些游戏会先收到 click 再收到 hover，结果「光标到了但没点中」（真机踩过）。
      body = [
        `[void][DshInApi]::SetCursorPos(${Math.round(action.x)}, ${Math.round(action.y)})`,
        'Start-Sleep -Milliseconds 60',
        `[DshInApi]::Mouse(${down}, 0x00)`,
        'Start-Sleep -Milliseconds 60',
        `[DshInApi]::Mouse(0x00, ${up})`,
        'Start-Sleep -Milliseconds 40',
      ].join('\n');
      break;
    }
    case 'drag': {
      // 战棋移动：按下 → 分几步拖过去 → 松开。
      // 一步跳到位很多游戏认不出「拖拽」（只会当成一次点击），必须给中间移动事件。
      const x1 = Math.round(action.fromX);
      const y1 = Math.round(action.fromY);
      const x2 = Math.round(action.toX);
      const y2 = Math.round(action.toY);
      const STEPS = 6;
      const steps: string[] = [];
      for (let i = 1; i <= STEPS; i++) {
        const x = Math.round(x1 + ((x2 - x1) * i) / STEPS);
        const y = Math.round(y1 + ((y2 - y1) * i) / STEPS);
        steps.push(`[void][DshInApi]::SetCursorPos(${x}, ${y})`, 'Start-Sleep -Milliseconds 35');
      }
      body = [
        `[void][DshInApi]::SetCursorPos(${x1}, ${y1})`,
        'Start-Sleep -Milliseconds 80',
        '[DshInApi]::Mouse(0x02, 0x00)',
        'Start-Sleep -Milliseconds 80',
        ...steps,
        'Start-Sleep -Milliseconds 80',
        '[DshInApi]::Mouse(0x00, 0x04)',
        'Start-Sleep -Milliseconds 60',
      ].join('\n');
      break;
    }
    case 'key': {
      const vk = resolveKey(action.key, guard.extraKeys);
      if (vk === undefined) return { ok: false, reason: 'unknown-key', message: `不认识的键：${action.key}` };
      const hold = Math.max(20, Math.min(5000, action.holdMs ?? 60));
      body = `[DshInApi]::Key(${vk}, $false)\nStart-Sleep -Milliseconds ${hold}\n[DshInApi]::Key(${vk}, $true)`;
      break;
    }
    case 'keyDown': {
      const vk = resolveKey(action.key, guard.extraKeys);
      if (vk === undefined) return { ok: false, reason: 'unknown-key', message: `不认识的键：${action.key}` };
      body = `[DshInApi]::Key(${vk}, $false)`;
      break;
    }
    case 'keyUp': {
      const vk = resolveKey(action.key, guard.extraKeys);
      if (vk === undefined) return { ok: false, reason: 'unknown-key', message: `不认识的键：${action.key}` };
      body = `[DshInApi]::Key(${vk}, $true)`;
      break;
    }
    case 'type': {
      // 只允许可打印 ASCII；中文输入法行为不可预测，宁可拒绝也不要乱打
      if (!/^[\x20-\x7e]{0,200}$/.test(action.text)) {
        return { ok: false, reason: 'unsupported-text', message: '只支持可打印 ASCII（中文会走输入法，行为不可控）' };
      }
      const escaped = action.text.replace(/[+^%~(){}[\]]/g, (c) => `{${c}}`);
      body = `Add-Type -AssemblyName System.Windows.Forms\n[System.Windows.Forms.SendKeys]::SendWait(${JSON.stringify(escaped)})`;
      break;
    }
    default:
      return { ok: false, reason: 'unknown-action', message: '不支持的动作' };
  }

  try {
    await runPowerShell(`${PS_PRELUDE}\n${body}`);
    return { ok: true, elapsedMs: Date.now() - started };
  } catch (e) {
    return { ok: false, reason: 'inject-failed', message: e instanceof Error ? e.message : String(e) };
  }
}
