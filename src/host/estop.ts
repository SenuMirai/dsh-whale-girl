/**
 * 急停：让主人随时能把她「按住」的那只手抽走。
 *
 * ── 为什么单独一个模块 ──
 *
 * 键鼠注入是全项目唯一能**造成实际后果**的能力（点错按钮、按错键、在游戏里
 * 丢掉存档）。所以急停不是「附赠的一个功能」，而是启用代打的**前置条件**：
 * 没有可用的急停，代打开关根本不该打开。
 *
 * ── 三层急停（任意一层生效即停） ──
 *
 * 1. **热键**：默认 `F12`。全局轮询（PowerShell 每 100ms 读一次按键状态），
 *    不依赖焦点——哪怕游戏全屏也能停。
 * 2. **超时**：单次动作/单轮决策超过上限，自动停。防止卡死时她一直按。
 * 3. **开关**：设置里关掉，或 `/dsh-whale-girl/autoplay/stop` 一发即停。
 *
 * 任何一层触发后都是**粘滞**状态：必须主人显式恢复才会再次行动
 * （自动恢复等于没有急停——这正是事故的常见形态）。
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/** 急停状态（粘滞：触发了就一直停着，直到显式恢复） */
export type EstopState = 'ready' | 'stopped';

/** 停止原因（写进日志，事后能查清楚是谁停的） */
export type EstopReason = 'hotkey' | 'user-input' | 'timeout' | 'manual' | 'error';

export type EstopSnapshot = {
  state: EstopState;
  /** 最近一次停止的原因；从未停过则 undefined */
  lastReason?: EstopReason;
  /** 最近一次停止的时间戳（毫秒） */
  lastStoppedAt?: number;
  /** 当前监听的急停热键（展示用） */
  hotkey: string;
};

/** 默认急停键：F12（几乎不会被游戏占用，也不在手边误触的位置） */
export const DEFAULT_ESTOP_HOTKEY = 'F12';

/** 允许用作急停的键（收窄，避免主人填一个游戏里天天按的键） */
const ALLOWED_ESTOP_KEYS: Record<string, number> = {
  f8: 0x77,
  f9: 0x78,
  f10: 0x79,
  f11: 0x7a,
  f12: 0x7b,
  esc: 0x1b,
  pause: 0x13,
  scrolllock: 0x91,
};

/** 把键名解析成虚拟码；不在允许集合里 → undefined */
export function resolveEstopKey(name: string): number | undefined {
  return ALLOWED_ESTOP_KEYS[name.trim().toLowerCase()];
}

/** 允许的急停键清单（给设置页做下拉，主人不用背键名） */
export function estopKeyChoices(): string[] {
  return Object.keys(ALLOWED_ESTOP_KEYS);
}

/**
 * 急停控制器。
 *
 * 用闭包而不是 class：本仓库的构建目标（es2020）下 `#private` 字段会拖进
 * `@oxc-project/runtime` 这个裸 import，插件加载时直接 ERR_MODULE_NOT_FOUND。踩过。
 */
export type EstopController = {
  /** 当前状态快照 */
  snapshot: () => EstopSnapshot;
  /** 立即停止（记录原因） */
  stop: (reason: EstopReason) => void;
  /** 显式恢复（只有主人手动操作才该调它） */
  resume: () => void;
  /** 是否处于「可以行动」的状态 */
  canAct: () => boolean;
  /** 标记是否正在注入：真时屏蔽「用户动了就停」的判断 */
  markInjecting: (active: boolean) => void;
  /**
   * 开始陪玩后的**宽限期**：这段时间里的真实键鼠输入不触发「主人接管」急停。
   * 为什么需要：点「开始陪玩」本身是一次点击，之后主人还要点一下游戏窗口把它切到前台——
   * 这两下都是**真实输入**。没有宽限期的话，急停会在开始的一瞬间自己停掉。
   */
  grantGrace: (ms: number) => void;
  /**
   * 开始监听热键；返回停止监听的函数。
   * @param options.voiceSpec 语音热键（按住说话）——按住它时**不算「主人接管」**，
   *        否则「按 Alt+V 想给个提醒」会先把代打停掉（实测）。
   */
  startWatching: (options?: { voiceSpec?: VoiceHotkeySpec }) => () => void;
};

/** 语音热键按下时用来「豁免主人接管」的组合（由调用方从 voice.json 解析） */
export type VoiceHotkeySpec = {
  vk: number;
  alt: boolean;
  ctrl: boolean;
  shift: boolean;
  win: boolean;
};

/**
 * 创建一个急停控制器。
 *
 * @param hotkey 急停键名（必须在 `estopKeyChoices()` 里）
 * @param onStop 停止时的回调（用来记日志 / 通知前端）
 */
export function createEstop(hotkey: string, onStop?: (reason: EstopReason) => void): EstopController {
  const vk = resolveEstopKey(hotkey);
  let state: EstopState = 'ready';
  let lastReason: EstopReason | undefined;
  let lastStoppedAt: number | undefined;
  let watching = false;
  /**
   * 正在注入中（>0 表示当前有一次注入在跑）。
   * 注入期产生的键鼠会被 GetLastInputInfo 当成「用户输入」，必须屏蔽掉。
   */
  let injectingAt = 0;
  /** 上一次读到的空闲毫秒数（-1 = 还没读过） */
  let lastIdle = -1;
  /** 最近一次注入结束的时间戳（0 = 还没注入过）。用来判断某次归零该归给谁 */
  let lastInjectEndedAt = 0;
  /** 宽限期截止时间（毫秒时间戳）：这段时间内不因真实输入而停 */
  let graceUntil = 0;
  let stopWatcher: (() => void) | undefined;

  const snapshot = (): EstopSnapshot => ({
    state,
    ...(lastReason === undefined ? {} : { lastReason }),
    ...(lastStoppedAt === undefined ? {} : { lastStoppedAt }),
    hotkey,
  });

  const stop = (reason: EstopReason): void => {
    if (state === 'stopped' && lastReason === reason) return; // 幂等，避免刷日志
    state = 'stopped';
    lastReason = reason;
    lastStoppedAt = Date.now();
    onStop?.(reason);
  };

  const resume = (): void => {
    state = 'ready';
    // 故意不清 lastReason：主人应该能看到"刚才是因为什么停的"
  };

  /**
   * 全局轮询急停键。
   *
   * 为什么不用注册热键（RegisterHotKey）：那个会被前台游戏抢走，
   * 而且全屏独占时你收不到。**轮询 `GetAsyncKeyState`** 不依赖焦点，全屏也能读到。
   *
   * 用 PowerShell 常驻进程而不是每 100ms 起一个新进程：
   * 起进程要 ~300ms，频繁起会拖慢机器，而且检测会漏。
   */
  const startWatching = (options?: { voiceSpec?: VoiceHotkeySpec }): (() => void) => {
    if (watching) return stopWatcher ?? (() => {});
    if (vk === undefined) {
      // 配置了不支持的键：直接标记为不可行动，绝不「降级成能动手但停不下来」
      stop('error');
      return () => {};
    }
    watching = true;
    const voiceSpec = options?.voiceSpec;

    // 注意写法：全部压成**单行** `-MemberDefinition`，**不用 here-string**。
    // 实测 PowerShell 从 stdin 读脚本时，嵌着 `@"..."@` 的多层结构会静默失败
    // （退出码 0、stdout 全空）——截图那次就栽在这，这里不重犯。
    //
    // 轮询两件事：
    //   1. 急停键（GetAsyncKeyState）
    //   2. **真人一动就停**（GetLastInputInfo）：鼠标或键盘有输入就说明主人在操作，
    //      这时候她还按着键鼠，就是在跟主人抢设备。
    //      注意 GetLastInputInfo 会把**我们自己注入的**输入也算进去，
    //      所以只在「这一轮动作之间」比对，注入期间不做判断（见 idleSince 的处理）。
    // **必须用单行 `-TypeDefinition`**，不能用 `-MemberDefinition`：
    // 本机跑的是 Windows PowerShell 5.1，它既不认 `--MemberDefinition` 双横线，
    // 也不接受这种多次注册同一命名空间内不同类名的写法（实测报
    // 「找不到与参数名称"MemberDefinition"匹配的参数」）。
    // `-TypeDefinition` + 一整行 C# 在 5.1 上是通的（实测 V1=73515 V2=73843）。
    const bool = (value: boolean): string => (value ? 'true' : 'false');
    const CS_MONITOR = [
      'using System;',
      'using System.Runtime.InteropServices;',
      'public static class DshEstopMonitor {',
      '  [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }',
      '  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);',
      '  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);',
      '  [DllImport("kernel32.dll")] public static extern uint GetTickCount();',
      '  static bool D(int k) { return (GetAsyncKeyState(k) & 0x8000) != 0; }',
      '  public static uint IdleMs() {',
      '    LASTINPUTINFO li = new LASTINPUTINFO();',
      '    li.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));',
      '    if (!GetLastInputInfo(ref li)) return uint.MaxValue;',
      '    return GetTickCount() - li.dwTime;',
      '  }',
      '  public static bool HotkeyDown() { return D(' + String(vk) + '); }',
      // 语音热键（按住说话）：按住它期间/松开后几秒内，输入不算「主人接管」
      ...(voiceSpec === undefined
        ? []
        : [
            '  public static bool VoiceDown() {',
            '    if (!D(' + String(voiceSpec.vk) + ')) return false;',
            '    if (D(17) != ' + bool(voiceSpec.ctrl) + ') return false;',
            '    if (D(18) != ' + bool(voiceSpec.alt) + ') return false;',
            '    if (D(16) != ' + bool(voiceSpec.shift) + ') return false;',
            '    bool win = D(91) || D(92);',
            '    if (win != ' + bool(voiceSpec.win) + ') return false;',
            '    return true;',
            '  }',
          ]),
      '}',
    ].join(' ');

    const voiceExpr = voiceSpec === undefined ? '$false' : '[DshEstopMonitor]::VoiceDown()';
    const script = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition '${CS_MONITOR.replace(/'/g, "''")}' | Out-Null
$voiceHold = 0
while ($true) {
  $voice = ${voiceExpr}
  if ($voice) { $voiceHold = 30 } elseif ($voiceHold -gt 0) { $voiceHold-- }
  if ([DshEstopMonitor]::HotkeyDown()) { [Console]::Out.WriteLine('ESTOP'); [Console]::Out.Flush() }
  $suppress = 0
  if ($voice -or $voiceHold -gt 0) { $suppress = 1 }
  [Console]::Out.WriteLine('IDLE ' + [DshEstopMonitor]::IdleMs() + ' ' + $suppress)
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds 100
}
`;

    // 长脚本（带 while 循环）**必须落成 .ps1 再用 -File 跑**。
    //
    // 踩过的坑：把多行 `while` 循环从 stdin 灌进 `-Command -`，PowerShell
    // **一行都不执行**——进程活着、退出码 0、stdout 全空。表现就是
    // 「急停在监听、其实什么都没听」，比直接报错危险得多。
    const scriptPath = join(tmpdir(), `dsh-whale-estop-${process.pid}-${Date.now()}.ps1`);
    writeFileSync(scriptPath, script, 'utf8');

    /**
     * spawn 可能**同步抛出**（实测：受限环境里直接 `EPERM`）。
     *
     * 这里原本没有 try/catch，异常会被 `rearmAutoplay` → `ctx.effect` 一路上抛，
     * 导致**整个插件激活失败**（DSH 起不来，且启动失败的回滚会清掉主人的模型配置，
     * 见 docs/ROADMAP.md 坑 7）。
     *
     * 急停监听起不来时正确的行为是**明确降级**：标记为不可行动，
     * 让上层知道「现在没有急停保护」——而不是让宿主崩掉。
     * 这比「假装在听」安全得多（后者是文件头注释里专门警告过的那种情形）。
     */
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
        { windowsHide: true },
      ) as ChildProcessWithoutNullStreams;
    } catch (error) {
      watching = false;
      stop('error');
      console.warn(
        '[dsh-whale-girl] 急停监听启动失败（进程起不来）：' +
          (error instanceof Error ? error.message : String(error)) +
          '——急停不可用，代打不应开启',
      );
      try {
        unlinkSync(scriptPath);
      } catch {
        /* 文件可能已被清理 */
      }
      return () => {};
    }
    let buffer = '';
    /**
     * 上一次看到的「用户空闲时长」。
     *
     * GetLastInputInfo 把**我们自己注入的**键鼠也算成输入，所以不能直接拿它判断
     * 「主人在动」——那会在每次注入后自我触发急停，等于代打一次都跑不了。
     *
     * 判据：注入期间（`injectingAt > 0`）完全不判；注入结束后，空闲计时会因为
     * 我们自己的动作归零一次，于是观察**下一次读取时 idle 是不是又变小了**——
     * 只有「刚归零完又归零」才说明有人真的在动，那时候才停。
     */
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        // 排障开关：DSH_ESTOP_DEBUG=1 时把每行都打出来
        if (process.env.DSH_ESTOP_DEBUG === '1') console.log('[estop] ' + JSON.stringify(trimmed));
        if (trimmed.includes('ESTOP')) {
          stop('hotkey');
          continue;
        }
        if (!trimmed.startsWith('IDLE ')) continue;
        const parts = trimmed.split(/\s+/);
        const idle = Number(parts[1]);
        if (!Number.isFinite(idle)) continue;
        // 第三段 = 语音热键豁免标记（按住 Alt+V 说话期间 + 松开后 3 秒）
        const voiceSuppressed = parts[2] === '1';

        if (injectingAt > 0 || voiceSuppressed) {
          // 正在注入 / 主人正在用语音热键说话：只记账，绝不判停
          lastIdle = idle;
          continue;
        }

        if (lastIdle >= 0) {
          // 空闲时长变小 = 刚刚有人/有东西动了键鼠
          const decreased = idle < lastIdle - 50;
          if (decreased) {
            /**
             * 这一次「归零」该归给谁？
             *
             * 我们自己的注入同样会让空闲计时归零，所以不能一见下降就停。
             * 判据用**时间归属**：注入结束后的 1.5 秒内出现的归零算我们的，
             * 其余都算主人的输入。
             *
             * 早先的写法是「第一次下降吞掉、第二次才停」，那在家里没注入时
             * 会把主人的**第一次**真实输入吞掉（实测测出来就是不停），是错的。
             */
            const sinceInject = Date.now() - lastInjectEndedAt;
            if (lastInjectEndedAt === 0 || sinceInject > 1500) {
              // 宽限期（刚点「开始陪玩」、正在切游戏窗口）里不算接管
              if (Date.now() >= graceUntil) stop('user-input');
            }
          }
        }
        lastIdle = idle;
      }
    });
    child.stderr.on('data', () => {
      /* 轮询进程的普通噪声（Add-Type 警告等），不打扰 */
    });
    child.on('error', () => {
      stop('error');
    });

    stopWatcher = () => {
      watching = false;
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
    };
    return stopWatcher;
  };

  return {
    snapshot,
    stop,
    resume,
    canAct: () => state === 'ready',
    /** 标记注入开始/结束（结束传 0）。注入期不做「用户动了」判断 */
    markInjecting: (active: boolean): void => {
      injectingAt = active ? 1 : 0;
      if (!active) lastInjectEndedAt = Date.now();
      lastIdle = -1;
    },
    /** 开始陪玩后给一段宽限期（在这段时间内主人可以自由点窗口，不会触发接管急停） */
    grantGrace: (ms: number): void => {
      graceUntil = Date.now() + Math.max(0, ms);
      lastIdle = -1;
    },
    startWatching,
  };
}
