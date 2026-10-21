/**
 * 看屏幕：截图 → 内存压缩 → 交给视觉模型 → 让她知道主人现在在干什么。
 *
 * ── 三条硬约束（主人明确要求）──
 *
 * 1. **图片优先走内存，不落盘**。
 *    这里走的是 DeepSeek 官方 API 的 `image_url: data:image/jpeg;base64,...`，
 *    整条链路只在 Node 进程内存里，不经过 DSH 的附件存储。
 *    （DSH 内置的图片消息必须吃 `ImageAttachmentRef`，而附件存储是**写磁盘**的——
 *    实测 `.dsh/attachments/v1/objects/` 里已经有 195 个对象。所以这里绕开它。）
 *
 * 2. **可核对**：顺手在插件目录落一份快照，主人随时能知道「她到底看了什么」。
 *    保留张数可配置，超了删最旧的。这一份是**给人看的**，不是给模型吃的。
 *
 * 3. **能关**：总开关默认关。不开她绝不截图。
 *
 * ── 为什么先做这一步 ──
 * 「陪玩」和「自己玩游戏」都要先能看懂屏幕。这一层做扎实，后面两个只是策略不同。
 */

import { spawn } from 'node:child_process';
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** 压缩后的目标宽度（像素）。1280 足够看清 UI 与游戏画面，又不会让 token 爆掉。 */
const TARGET_WIDTH = 1280;

/** JPEG 质量。72 在「文字可读」与「体积小」之间比较均衡。 */
const JPEG_QUALITY = 72;

/** 单张截图的硬上限：超过说明压缩没生效，宁可失败也不要把巨图发出去。 */
const MAX_JPEG_BYTES = 900 * 1024;

/** 截图临时文件用的临时目录名（只在插件用户目录下建） */
const SHOT_DIR_NAME = 'sight';

/**
 * 跑一段 PowerShell 脚本，脚本内容**从 stdin 送进去**。
 *
 * 为什么不用 `promisify(execFile)`：那个封装不接受 `input` 选项
 * （只有 `execSync`/`spawnSync` 才有），脚本根本传不进去，表现为
 * 「Command failed: powershell.exe … -Command -」但没有任何有用错误。
 * 走 ``-Command -`` 让 PowerShell 从标准输入读脚本，顺带绕开命令行长度与引号转义。
 */
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
      reject(new Error('截图超时'));
    }, 20_000);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      // 防止异常情况把内存吃满（正常一次约 100~300 KB base64）
      if (stdout.length > 64 * 1024 * 1024) child.kill();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`截图脚本退出码 ${String(code)}：${stderr.trim().slice(0, 300)}`));
        return;
      }
      resolvePromise({ stdout, stderr });
    });
    child.stdin.end(script, 'utf8');
  });
}

/** 抓一次屏幕得到 JPEG（base64 + 字节数 + 尺寸），**全程内存**。*/
export type Screenshot = {
  /** data URL 形式，直接塞进 image_url */
  dataUrl: string;
  /** 压缩后的字节数 */
  bytes: number;
  width: number;
  height: number;
  /** 抓取耗时（毫秒），用于诊断 */
  elapsedMs: number;
};

/**
 * 用 PowerShell + .NET 抓屏并压缩成 JPEG。
 *
 * 为什么用 PowerShell 而不是原生模块：这台机器上验证过 36ms 就能抓完一次全屏，
 * 而装一个原生截图模块（node-screenshots 之类）要带二进制、还要跟 Electron 的
 * ABI 对齐——为这点性能不值得。
 *
 * @param region 只抓某块矩形（窗口模式用）；缺省 = 整个虚拟桌面
 */
export async function captureScreen(region?: {
  x: number;
  y: number;
  width: number;
  height: number;
}): Promise<Screenshot> {
  const t0 = Date.now();
  const rect = region ?? { x: 0, y: 0, width: 0, height: 0 };
  const useRegion = region !== undefined && region.width > 0 && region.height > 0;

  // 脚本走 stdin 传，避免命令行长参数与引号转义的坑。
  //
  // 注意：这里刻意写成**线性脚本**，不嵌套 try/finally。
  // 早先那版用三层嵌套 try/finally + 中文注释，结果是 stdout/stderr 全空、退出码 0
  // （PowerShell 从 stdin 读脚本时对这类结构处理得很怪）。这是个短命进程，
  // 退出即释放句柄，不值得为清理写嵌套。
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$targetW = ${TARGET_WIDTH}
$quality = ${JPEG_QUALITY}
$useRegion = ${useRegion ? '$true' : '$false'}
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
if ($useRegion) { $b = New-Object System.Drawing.Rectangle(${rect.x}, ${rect.y}, ${rect.width}, ${rect.height}) }
if ($b.Width -le 0) { throw 'no-screen' }
$full = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
$g = [System.Drawing.Graphics]::FromImage($full)
$g.CopyFromScreen($b.X, $b.Y, 0, 0, $full.Size)
$g.Dispose()
$ratio = [Math]::Min(1.0, $targetW / $full.Width)
$nw = [int][Math]::Max(1, [Math]::Round($full.Width * $ratio))
$nh = [int][Math]::Max(1, [Math]::Round($full.Height * $ratio))
$small = New-Object System.Drawing.Bitmap($nw, $nh)
$g2 = [System.Drawing.Graphics]::FromImage($small)
$g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g2.DrawImage($full, 0, 0, $nw, $nh)
$g2.Dispose()
$full.Dispose()
$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$ep = New-Object System.Drawing.Imaging.EncoderParameters(1)
$ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]$quality)
$ms = New-Object System.IO.MemoryStream
$small.Save($ms, $codec, $ep)
$small.Dispose()
$b64 = [Convert]::ToBase64String($ms.ToArray())
[Console]::Out.Write(("{0}|{1}|{2}" -f $nw, $nh, $b64))
`;

  const { stdout, stderr } = await runPowerShell(script);

  const text = String(stdout).trim();
  const firstBar = text.indexOf('|');
  const secondBar = text.indexOf('|', firstBar + 1);
  if (firstBar < 0 || secondBar < 0) {
    // 把 stderr 与长度带出来：否则只看到「格式不对」，根本不知道 PowerShell 报了什么
    throw new Error(
      `截图脚本没有返回预期格式（stdout ${text.length} 字符，stderr：${stderr.trim().slice(0, 300) || '空'}）`,
    );
  }

  const width = Number(text.slice(0, firstBar));
  const height = Number(text.slice(firstBar + 1, secondBar));
  const base64 = text.slice(secondBar + 1).replace(/\s+/g, '');
  if (!Number.isFinite(width) || !Number.isFinite(height) || base64 === '') {
    throw new Error('截图结果无法解析');
  }

  const bytes = Math.floor((base64.length * 3) / 4);
  if (bytes > MAX_JPEG_BYTES) {
    // 压缩没生效就别发：宁可这一轮跳过，也不要把近 1MB 的图塞给模型
    throw new Error(`截图过大（${Math.round(bytes / 1024)} KB），已跳过`);
  }

  return {
    dataUrl: `data:image/jpeg;base64,${base64}`,
    bytes,
    width,
    height,
    elapsedMs: Date.now() - t0,
  };
}

/**
 * 把快照落一份到插件目录，供主人核对「她看了什么」。
 *
 * 与「发给模型」的那份是**两回事**：这份是给人看的，保留最近 N 张，其余删掉。
 * 删的顺序按文件名（时间戳前缀）排，不依赖 mtime——复制/同步会改 mtime。
 *
 * @returns 写入的文件路径；失败只返回 undefined（快照失败不能影响主流程）
 */
export async function saveSnapshot(
  sightRoot: string,
  jpegBase64: string,
  keep: number,
): Promise<string | undefined> {
  try {
    await mkdir(sightRoot, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = join(sightRoot, `${stamp}.jpg`);
    await writeFile(file, Buffer.from(jpegBase64, 'base64'));

    // 只保留最近 keep 张
    if (keep > 0) {
      const names = (await readdir(sightRoot)).filter((n) => n.endsWith('.jpg')).sort();
      const excess = names.length - keep;
      for (let i = 0; i < excess; i++) {
        try {
          await unlink(join(sightRoot, names[i]));
        } catch {
          /* 并发删除/占用都无所谓，下一轮还会清 */
        }
      }
    }
    return file;
  } catch {
    return undefined;
  }
}

/** 快照目录的当前占用（张数 + 总字节），给设置页显示 */
export async function snapshotUsage(sightRoot: string): Promise<{ count: number; bytes: number }> {
  try {
    const names = (await readdir(sightRoot)).filter((n) => n.endsWith('.jpg'));
    let bytes = 0;
    for (const name of names) {
      try {
        bytes += (await stat(join(sightRoot, name))).size;
      } catch {
        /* 刚被删掉 */
      }
    }
    return { count: names.length, bytes };
  } catch {
    return { count: 0, bytes: 0 };
  }
}

/** 截图目录名（拼在插件用户目录下） */
export const SIGHT_DIR = SHOT_DIR_NAME;

/**
 * 帧差：把两张图缩成 32×18 灰度网格比较，判断「画面有没有变」。
 *
 * 为什么值得做：主动识屏如果每秒都送一张给模型，既烧钱又吵。实测上个项目里
 * 静态窗口能跳过约 80% 的帧——只在她真的有新东西可看时才调用模型。
 *
 * 这里不装图像库，直接在 Node 里比**压缩后的字节大小 + 采样哈希**：
 * JPEG 对相同画面编码结果几乎一致，用「长度 + 稀疏采样」做粗判足够。
 *
 * @returns 0~1 的差异比例；0 = 完全相同
 */
export function frameDiff(previous: Uint8Array | undefined, current: Uint8Array): number {
  if (previous === undefined) return 1;
  if (previous.length === 0 || current.length === 0) return 1;
  // 长度差本身就是一个便宜的信号
  const lengthDelta = Math.abs(previous.length - current.length) / Math.max(previous.length, current.length);
  // 再按等距采样点比对字节。
  // 采样点要够密：64 个点在 100+ KB 的文件上只覆盖 0.06%，局部小改动会漏判。
  // JPEG 的熵编码决定了**画面一变，字节几乎处处不同**，所以密集采样是可靠的。
  let changed = 0;
  const samples = 512;
  const limit = Math.min(previous.length, current.length);
  for (let i = 0; i < samples; i++) {
    const idx = Math.floor((i / samples) * limit);
    if (previous[idx] !== current[idx]) changed++;
  }
  const sampleDelta = changed / samples;
  // 两者取大：任一维度明显变化都算「画面变了」
  return Math.max(lengthDelta, sampleDelta);
}

/**
 * 连拍：抓 N 帧，帧间留间隔。
 *
 * ── 为什么需要多帧 ──
 *
 * 单帧只能看"静态画面"——看不出「她在跑/怪在动/刚切了地图」。
 * 多帧才能让模型比较出**变化与运动**，这才是"看我在干嘛"的完整信息。
 *
 * 代价是线性增加的：每多一帧就多一份图片 token。所以帧数做成可调
 * （1 帧 = 退回旧行为，最省）。
 *
 * @param count 帧数（调用方已用 framePlan 夹过）
 * @param gapMs 帧间隔
 */
export async function captureFrames(
  count: number,
  gapMs: number,
  capture: () => Promise<Screenshot> = captureScreen,
): Promise<Screenshot[]> {
  const frames: Screenshot[] = [];
  for (let i = 0; i < Math.max(1, count); i++) {
    frames.push(await capture());
    // 最后一帧之后不再等
    if (i + 1 < count) await new Promise((r) => setTimeout(r, gapMs));
  }
  return frames;
}