/**
 * 电脑操作：她像 DSH 一样干活，而不是模拟鼠标键盘。
 *
 * ── 为什么这条路线才是对的 ──
 *
 * 早先我给"代打"做的是 `SendInput` 模拟按键——那是**最后手段**：
 * 只能做游戏里那点事，还受限于"必须前台、必须认得出窗口"。
 *
 * 而她本身跑在 DSH 里，DSH 能干的事她当然也能干：
 * `ctx.subprocess` 是**同一个执行世界**（同 PATH、同权限、同沙箱），
 * DSH 自己的终端工具走的就是它。所以开应用、查进程、跑命令，
 * 用这条通道比模拟键鼠又稳又全。
 *
 * 模拟键鼠只在一种情况下仍然必要：**目标程序不提供任何命令行接口**（游戏）。
 */

/** 一条命令的执行结果 */
export type CommandResult =
  | { ok: true; exitCode: number; stdout: string }
  | { ok: false; reason: string; message: string };

/** ctx.subprocess 的最小契约（结构化类型，避免依赖具体包） */
type SubprocessLike = {
  spawn(spec: {
    argv: readonly string[];
    cwd: string;
    stdio: { stdin: 'ignore'; stdout: { maxBytes: number }; stderr: { maxBytes: number } };
    graceMs: number;
  }): {
    done: Promise<{ exitCode: number | null }>;
    collected: { stdout?: { readFrom(from: number): { text: string } }; stderr?: { readFrom(from: number): { text: string } } };
  };
};

/**
 * 跑一条命令，拿回 stdout。
 *
 * 所有动作都**限定为只读或明确意图**：调用方给什么就跑什么，
 * 但这里不接受 shell 拼接（argv 数组，不经过 shell），避免注入。
 */
export async function runCommand(
  subprocess: SubprocessLike | undefined,
  argv: readonly string[],
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<CommandResult> {
  if (subprocess === undefined || typeof subprocess.spawn !== 'function') {
    return { ok: false, reason: 'subprocess-unavailable', message: '没有可用的进程服务' };
  }
  if (argv.length === 0) return { ok: false, reason: 'empty-argv', message: '没有要执行的命令' };

  const timeoutMs = Math.max(1000, Math.min(60_000, opts.timeoutMs ?? 15_000));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const handle = subprocess.spawn({
      argv,
      cwd: opts.cwd ?? process.cwd(),
      stdio: { stdin: 'ignore', stdout: { maxBytes: 256 * 1024 }, stderr: { maxBytes: 64 * 1024 } },
      graceMs: 2000,
    });
    const outcome = await handle.done;
    const stdout = handle.collected.stdout?.readFrom(0).text ?? '';
    const stderr = handle.collected.stderr?.readFrom(0).text ?? '';
    const exitCode = outcome.exitCode ?? -1;
    // 命令跑起来了 ≠ 命令成功了。
    // 早先只看 spawn 有没有抛异常，于是 `Start-Process '微信'`（找不到程序）这种失败
    // 被当成成功，回了句「好，打开微信」然后什么都没发生——这就是"回应了却没执行"。
    if (exitCode !== 0) {
      return {
        ok: false,
        reason: 'exit-nonzero',
        message: (stderr.trim() || stdout.trim() || `命令退出码 ${exitCode}`).slice(0, 300),
      };
    }
    return { ok: true, exitCode, stdout };
  } catch (e) {
    return { ok: false, reason: 'spawn-failed', message: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 跑 PowerShell 脚本（**中文安全**）。
 *
 * ── 为什么必须用 -EncodedCommand ──
 *
 * 直接把 `-Command "Start-Process '网易云'"` 传进去，Windows 会按 ANSI 代码页
 * 解释参数，中文变成 `????`，PowerShell 收到乱码就报 InvalidOperationException。
 * 这就是"打开网易云失败、打开网易云音乐成功"的真正原因——不是名字没收录，是编码。
 *
 * `-EncodedCommand` 收的是 UTF-16LE 的 base64，全程不走代码页，中文原样到达。
 */
export async function runPowerShell(
  subprocess: SubprocessLike | undefined,
  script: string,
  opts: { timeoutMs?: number } = {},
): Promise<CommandResult> {
  // 前置一句设输出编码：否则 PowerShell 的错误流会以 CLIXML + 本地代码页回传，
  // 中文全变成 ????（主人截图里那一大串就是它）。
  const full = '[Console]::OutputEncoding = [Text.Encoding]::UTF8;' + script;
  const encoded = Buffer.from(full, 'utf16le').toString('base64');
  return runCommand(subprocess, ['powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], opts);
}

/** 一个可见窗口（进程 + 标题） */
export type WindowInfo = { title: string; processName: string; pid: number };

/**
 * 列出所有**有可见主窗口**的进程。
 *
 * 用 PowerShell 的 Get-Process 取 MainWindowTitle——这是"后台进程"视角，
 * 不依赖前台窗口，所以能找到"没在用的那个游戏"。
 */
export async function listWindows(subprocess: SubprocessLike | undefined): Promise<WindowInfo[]> {
  const script =
    "Get-Process | Where-Object { $_.MainWindowTitle -ne '' } | " +
    'Select-Object Id,ProcessName,MainWindowTitle | ConvertTo-Json -Compress';
  const result = await runPowerShell(subprocess, script, { timeoutMs: 15_000 });
  if (!result.ok || result.stdout.trim() === '') return [];
  try {
    const parsed = JSON.parse(result.stdout.trim()) as
      | { Id?: number; ProcessName?: string; MainWindowTitle?: string }
      | Array<{ Id?: number; ProcessName?: string; MainWindowTitle?: string }>;
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows
      .filter((r) => typeof r.MainWindowTitle === 'string' && r.MainWindowTitle !== '')
      .map((r) => ({
        title: String(r.MainWindowTitle),
        processName: String(r.ProcessName ?? ''),
        pid: Number(r.Id ?? 0),
      }));
  } catch {
    return [];
  }
}

/**
 * 在一个窗口列表里找「最像」的那个。
 *
 * ── 为什么不能只做完全匹配 ──
 *
 * 主人提醒过：游戏名翻译不同，窗口标题常常对不上（"群星" vs "Stellaris"）。
 * 所以这里做**多路打分**：标题包含查询词、进程名包含、以及反过来的包含关系，
 * 取分最高的；低于阈值就返回 undefined（不猜）。
 */
export function findWindow(windows: readonly WindowInfo[], query: string): WindowInfo | undefined {
  const q = query.trim().toLowerCase();
  if (q === '') return undefined;

  let best: WindowInfo | undefined;
  let bestScore = 0;
  for (const w of windows) {
    const title = w.title.toLowerCase();
    const proc = w.processName.toLowerCase();
    let score = 0;
    if (title === q || proc === q) score = 100;
    else if (title.includes(q)) score = 80;
    else if (proc.includes(q)) score = 70;
    else if (q.includes(proc) && proc.length >= 3) score = 60;
    else if (q.includes(title) && title.length >= 3) score = 50;
    if (score > bestScore) {
      bestScore = score;
      best = w;
    }
  }
  // 30 分以下视为"不像"，宁可不切窗口也不要切错
  return bestScore >= 30 ? best : undefined;
}

/**
 * 打开一个应用。
 *
 * Windows 走 `Start-Process`（等价于 Win+R 里输入名字），让它自己按 PATH /
 * App Paths 注册表去解析——比我们自己拼路径可靠得多。
 */
/** 常见中文应用名 → 可执行文件名（Start-Process 认的是后者） */
/**
 * 常见应用的名字 → 可执行名（**默认表**，可被用户配置覆盖）。
 *
 * 覆盖范围：聊天、浏览器、影音、办公、开发、系统工具。
 * 用户可以在插件目录的 `apps.json` 里增删改，设置页能看能改。
 *
 * 注意：这里给的是**可执行名**（Start-Process 认的），不是窗口标题。
 */
export const DEFAULT_APP_ALIASES: Record<string, string> = {
  // 聊天
  微信: 'WeChat', wechat: 'WeChat',
  qq: 'QQ', 扣扣: 'QQ',
  钉钉: 'DingTalk', dingtalk: 'DingTalk',
  飞书: 'Feishu', 企业微信: 'WXWork',
  电报: 'Telegram', telegram: 'Telegram',
  微信输入法: 'WeChatInput',
  // 浏览器
  浏览器: 'msedge', edge: 'msedge', 谷歌浏览器: 'chrome', chrome: 'chrome',
  火狐: 'firefox', firefox: 'firefox', '360浏览器': '360se',
  // 影音
  网易云音乐: 'cloudmusic', 网易云: 'cloudmusic',
  qq音乐: 'QQMusic', 酷狗音乐: 'KuGou', 酷我音乐: 'KwMusic',
  哔哩哔哩: 'bilibili', b站: 'bilibili', 哔哩: 'bilibili',
  爱奇艺: 'iqiyi', 腾讯视频: 'QQLive', 优酷: 'Youku',
  potplayer: 'PotPlayerMini64', vlc: 'vlc',
  // 办公
  word: 'WINWORD', excel: 'EXCEL', ppt: 'POWERPNT', powerpoint: 'POWERPNT',
  记事本: 'notepad', notepad: 'notepad',
  写字板: 'write', 画图: 'mspaint', 截图: 'SnippingTool',
  onenote: 'ONENOTE', 印象笔记: 'Evernote',
  // 开发
  vscode: 'code', 'visual studio code': 'code', 代码编辑器: 'code',
  终端: 'wt', 命令提示符: 'cmd', cmd: 'cmd', powershell: 'powershell',
  任务管理器: 'taskmgr', 资源管理器: 'explorer', 文件管理器: 'explorer',
  计算器: 'calc', 控制面板: 'control', 设置: 'ms-settings:',
  // 其他
  steam: 'steam', 商店: 'ms-windows-store:', 日历: 'outlookcal:',
  微信开发者工具: 'wechatdevtools',
};

export async function openApp(
  subprocess: SubprocessLike | undefined,
  target: string,
  /** 用户自定义的别名表（缺省用内置表） */
  aliases?: Record<string, string>,
): Promise<CommandResult> {
  const name = target.trim();
  if (name === '') return { ok: false, reason: 'empty-target', message: '没说是哪个应用' };
  // 中文名要走别名表：`Start-Process '微信'` 找的是可执行文件名，中文名永远找不到。
  // 别名只覆盖最常见的几个，其余原样传给 Start-Process（它自己会查 PATH 与 App Paths）。
  const table = aliases ?? DEFAULT_APP_ALIASES;
  const resolved = table[name] ?? table[name.toLowerCase()] ?? name;
  const escaped = resolved.replace(/'/g, "''");
  // 不只会 `Start-Process a`：那只在 PATH / App Paths 里能查到。
  // 像 cloudmusic 这种装在 Program Files 里的，要自己去找。
  // 顺序：直接启动 → App Paths 注册表 → Program Files 搜索 → 开始菜单快捷方式。
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$name = '" + escaped + "'",
    "try { Start-Process $name -ErrorAction Stop; [Console]::Out.Write('OK'); exit 0 } catch {}",
    "$appPath = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\' + $name + '.exe'",
    "$hit = (Get-ItemProperty -Path $appPath -ErrorAction SilentlyContinue).'(default)'",
    "if (-not $hit) {",
    "  $roots = @($env:ProgramFiles, [Environment]::GetFolderPath('ProgramFilesX86'), $env:LOCALAPPDATA)",
    "  foreach ($root in $roots) {",
    "    if (-not $root) { continue }",
    "    $found = Get-ChildItem -Path $root -Filter ($name + '.exe') -Recurse -Depth 3 -ErrorAction SilentlyContinue | Select-Object -First 1",
    "    if ($found) { $hit = $found.FullName; break }",
    "  }",
    "}",
    "if (-not $hit) {",
    "  $progs = [Environment]::GetFolderPath('Programs')",
    "  $lnk = Get-ChildItem -Path $progs -Filter ($name + '.lnk') -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1",
    "  if ($lnk) { $hit = $lnk.FullName }",
    "}",
    "if (-not $hit) { [Console]::Out.Write('NOTFOUND'); exit 1 }",
    "try { Start-Process $hit -ErrorAction Stop; [Console]::Out.Write('OK'); exit 0 }",
    "catch { [Console]::Out.Write('FAILED'); exit 1 }",
  ].join('\n');
  const result = await runPowerShell(subprocess, script, { timeoutMs: 30_000 });
  if (result.ok && result.stdout.includes('OK')) return result;
  // 找不到时给一句人话，不要把 PowerShell 的英文错误抛给主人
  const said = result.ok ? result.stdout : '';
  if (said.includes('NOTFOUND') || result.ok) {
    return {
      ok: false,
      reason: 'not-found',
      message: `系统里找不到「${resolved}」。去设置→更多→应用名单里补上它的可执行名或完整路径，就认得它了。`,
    };
  }
  return { ok: false, reason: 'launch-failed', message: `启动 ${resolved} 失败` };
}

/**
 * 把一个窗口切到前台。
 *
 * 为什么不干脆用 SetForegroundWindow：Windows 有「前台窗口锁定」——
 * 不是当前前台的进程调它经常被静默忽略。可靠做法是先附着到目标线程的输入队列
 * （AttachThreadInput），再 BringWindowToTop + SetForegroundWindow。
 *
 * 这段是**尽力而为**：失败了如实返回 false，不假装切过去了
 * （假装成功会让她对着错误窗口按键，比不动更糟）。
 */
export async function focusWindow(subprocess: SubprocessLike | undefined, pid: number): Promise<boolean> {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$sig = '[DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport(\"user32.dll\")] public static extern bool BringWindowToTop(IntPtr h); [DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr h, int n); [DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow(); [DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid); [DllImport(\"kernel32.dll\")] public static extern uint GetCurrentThreadId(); [DllImport(\"user32.dll\")] public static extern bool AttachThreadInput(uint a, uint b, bool f);'",
    "Add-Type -MemberDefinition $sig -Name W -Namespace DshFg | Out-Null",
    `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue`,
    'if ($p -eq $null) { [Console]::Out.Write("NO_PROCESS"); exit 0 }',
    '$h = $p.MainWindowHandle',
    'if ($h -eq 0) { [Console]::Out.Write("NO_WINDOW"); exit 0 }',
    // 最小化的窗口先还原（SW_RESTORE=9）：只 SetForegroundWindow 的话任务栏图标会闪一下但窗口不弹出来
    '[void][DshFg.W]::ShowWindow($h, 9)',
    '$fg = [DshFg.W]::GetForegroundWindow()',
    '$fgPid = 0',
    '$fgThread = [DshFg.W]::GetWindowThreadProcessId($fg, [ref]$fgPid)',
    '$myThread = [DshFg.W]::GetCurrentThreadId()',
    '[void][DshFg.W]::AttachThreadInput($myThread, $fgThread, $true)',
    '$ok = [DshFg.W]::SetForegroundWindow($h)',
    '[void][DshFg.W]::BringWindowToTop($h)',
    '[void][DshFg.W]::AttachThreadInput($myThread, $fgThread, $false)',
    'if ($ok) { [Console]::Out.Write("OK") } else { [Console]::Out.Write("FAILED") }',
  ].join('\n');
  const result = await runPowerShell(subprocess, script, { timeoutMs: 15_000 });
  return result.ok && result.stdout.trim().endsWith('OK');
}
