/**
 * dsh-whale-girl 宿主半侧（host half）—— 宠物插件的"后端"部分
 *
 * 职责：提供 `/dsh-whale-girl/` 前缀的**业务能力**（handlePetRoute 纯函数，路由与桌面管道共用）。
 * 全部配置（内置默认 + 用户主配置 + 文件宠物）由 ./config 的 readAllConfig 统一读取合并，
 * 本文件只消费它的返回值（绝对正确、零校验），不再接触任何配置文件。
 *
 * 两个入口消费同一份 handlePetRoute：
 *   - HTTP 路由：注册在 DSH WebServer 上（浏览器 overlay / 设置页 / 斜杠命令用）
 *   - 桌面 Helper 管道：helper-process.ts 的 bridgeHandler（DSH_WHALE_BRIDGE=1 时经
 *     dsh-whale-girl-bridge:// scheme + stdout JSON 行 + 本地回调，**不走 HTTP**——
 *     DSH Desktop 2.0.3+ 的浏览器访问闸门会拦插件子进程的裸 HTTP 请求）
 * 两端行为严格一致（硬契约：浏览器/桌面功能/文案/配置完全对齐）。
 *
 * 路由：
 *   /dsh-whale-girl/config             → 合并后的**成品配置**（{ main:{...}, test1:{...}, ... }，
 *                                每条目字段已填满；浏览器/桌面/设置页的唯一配置入口）
 *                                GET 读取成品；PUT 保存用户层（白名单重建 main-config.jsonc）、
 *                                POST 同步用户层（把内置默认 config.jsonc **原文**整份写入，
 *                                含注释与全部高级字段；合并结果与「没有用户层」等价）——
 *                                两个写接口的**响应体都是保存后的成品聚合**，设置页即时生效
 *                                直接拍平这份响应，客户端不再有第二份"补吹条目级字段"的实现
 *   /dsh-whale-girl/reload              → 桌面端「重载配置」（右键菜单，POST）：重启桌面 Helper，全部桌面
 *                                宠物窗口按最新配置重建（改配置文件后不必回设置页点保存）；与保存走
 *                                **同一条**重启路径（syncDesktop），宠物数量/display/size 变化同样生效
 *   /dsh-whale-girl/config/meta         → 配置文件与素材目录路径 + 全部存储位置清单
 *                                       （设置页「高级配置」「卸载与存储」展示用）
 *   /dsh-whale-girl/models              → 可选「服务商 + 模型」清单（设置页「AI 模型」下拉框数据源；
 *                                       与 DSH 模型选择器同源，取宿主 llm 服务的 listProviders/listModels）
 *   /dsh-whale-girl/thumb/<素材根>/<动画名>.webm|.mov  → 素材按宠物归属（.mov 为 macOS 定制，扩展名取决于
 *       客户端播放常量 ANIMATION_EXT；本路由固定双扩展名兜底）：
 *       文件宠物 = $DSH_HOME/dsh-whale-girl/pet/<素材根>-animation/（只查自己的，绝不回落）；
 *       主宠物   = $DSH_HOME/dsh-whale-girl/main-animation/<webm|mov>（用户目录，优先）→ 包内 assets/<webm|mov>
 *       <素材根> 是**标识符**（pet/ 下文件名前缀），含分隔符/保留字符即 400（见 ID_FORBIDDEN）
 *   /dsh-whale-girl/state               → **轮询统一状态 S**（GET，前端 1s 轮询的唯一数据源）：
 *                                       { sections: { balance, workStatus, notify }, pets: { <id>: { say } } }，
 *                                       每个叶子 = { counter, data }；counter 变了前端才渲染。
 *                                       只读、纯内存、零副作用（绝不在这里触发外部调用/模型生成）。
 *   /dsh-whale-girl/balance              → 余额刷新（POST 动作端点，写 S；数据从 /state 读）
 *   /dsh-whale-girl/whisper              → 让某只宠物立即说一句（POST 动作端点，写 S 的 pets.<id>.say）
 *   /dsh-whale-girl/broadcast            → 第三方投喂：把外部给定的文本写进气泡（POST 动作端点，写 S 的
 *                                       pets.<id>.say；不生成、只搬运，供宿主侧其他插件集成）
 *   /dsh-whale-girl/anim                 → 点播动画：让桌宠播一段指定动画（POST 动作端点，写 S 的
 *                                       pets.<id>.anim；效果与右键「动作」菜单一致，供其他插件调用）
 *   /dsh-whale-girl/chat                 → 对话与记忆（GET 最近窗口 / POST 对话并写 memory.json；
 *                                       POST 只回 {ok}，回复同样写 S 的 pets.<id>.say）
 *   /dsh-whale-girl/font|pic             → 字体 / 通知图标素材
 *
 * 系统通知不属于宠物行为、不在这里的旧实现是：浏览器半侧 notify.ts 经 connection 事件流
 * （api.events.mux/host）监听 DSH 事件。但 DSH 0.1.5 已删除该事件流 API——通知改为
 * host 侧监听宿主事件（session/event + agent/error）生成帧写进 S 的 sections.notify，
 * 浏览器统一轮询 /state 后弹 toast（帧契约与 shared/notify.ts 一致；单槽，见下方 pushNotifyFrame）。
 *
 * 桌面模式（Electron 透明窗）没有独立配置文件：宠物显示在哪全部由宠物条目的 display 决定
 * （web=仅浏览器 / desktop=仅桌面 / both=两者 / none=都不显示；缺失时合并器填内置默认值）。
 *
 * 安全性：resolveAsset 做"防穿越"校验，保证路径仍在对应根目录内；
 *         PUT 保存经 saveUserConfig 白名单重建，id 过滤文件名非法字符。
 *
 * TODO(类型)：peer 依赖类型包本地暂不可解析，ctx/req/res 暂用 any；
 *             依赖可解析后替换为 DSH 官方类型。
 */
import { createReadStream, existsSync, fstatSync, readFileSync } from 'node:fs';
import { appendFile, readdir, readFile, mkdir, unlink, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { queryBalance } from './balance/index';
import type { AccountBalanceSnapshot } from './balance/types';
import { generateWhisper } from './whisper';
import { generateChat, type ChatMemoryMessage } from './chat';
import { configuredModel } from './model-selection';
import { limitPool, pickMeme, readMemePool } from './memes';
import { decideBroadcast, normalizeBroadcastText } from './broadcast';
import { decideAnim } from './anim';
import { decodeAudioBase64, synthesize, transcribe, disposeVoiceWorkers, DEFAULT_VOICE, DEFAULT_RATE } from './voice';
import { captureFrames, captureScreen, frameDiff, saveSnapshot, snapshotUsage, SIGHT_DIR } from './sight';
import { frameCaption, framePlan, shouldLookAtScreen } from './voice-vision';
import { intentReply, parseVoiceIntent } from './voice-intent';
import { DEFAULT_APP_ALIASES, findWindow, focusWindow, listWindows, openApp, runCommand } from './computer';
import { lookAtScreen, parseSightReply, probeModelLatency, type SightMode } from './vision-llm';
import {
  AUTOPLAY_PROMPT,
  DEFAULT_AUTOPLAY_CONFIG,
  normalizeAutoplayConfig,
  parseActionPlan,
  runAutoplayRound,
  windowMatchesAllowed,
  type AutoplayConfig,
  type AutoplayRound,
} from './autoplay';
import { createEstop } from './estop';
import { createPlayLoop } from './play-loop';
import {
  createHotkeyHub,
  DEFAULT_VOICE_SHORTCUT,
  HOTKEY_STREAM_PATH,
  parseHotkey,
  startHotkeyWatcher,
  type HotkeyWatcher,
} from './hotkey';
import { createSkill, matchSkill, pruneSkills, scoreSkill, type Skill } from './game-skill';
import { compressSession, createGameSession, recordStep, recentContext, shouldCompress, GENRE_MEMORY_CAP, type GameSession } from './game-memory';
import { normalizeProfile, profileBrief, profileIdFromTitle, type GameProfile } from './game-profile';
import { searchGuide, shouldSearchGuide } from './game-guide';
import { createTaskSession } from './dsh-session';
import { DEFAULT_TASK_CONFIG, advanceTaskState, createTaskState, parseTaskDone, shouldGiveUp, taskPrompt } from './task-loop';
import { routeTask, type SelfAction } from './task-router';
import { describePending, isCancel, isConfirm, isExpired, planSend, type PendingMessage } from './messaging';
import { foregroundWindowTitle, performInput } from './input';
import { splitChatReply, type ChatFormat } from './chat-format';
import { exportMemoryPayload, mergeMemory, parseMemoryImport, selectRelevantMemory } from './memory-io';
import {
  DEFAULT_SIGHT_CONFIG,
  nextSightDelayMs,
  normalizeSightConfig,
  runSightRound,
  type SightConfig,
  type SightRound,
} from './sight-runner';
import {
  configVersion,
  findPetInstance,
  flattenPetList,
  ID_FORBIDDEN,
  migrateUserConfig,
  PET_DISPLAY_SET,
  readAllConfig,
  readPetConfigEntry,
  readUserConfig,
  saveUserConfig,
  sliceMemoryRounds,
  syncUserConfigFromDefault,
  userConfigUnparsable,
  type ConfigPaths,
} from './config';
import {
  GOAL_UPDATE_TOOL,
  reduceWorkStatus,
  currentTaskFromTodo,
  goalUpdateAction,
  WorkStatusStore,
  type WorkStatusTurnContext,
} from './work-status';
import {
  agentErrorFrame,
  hasBlockingActivity,
  isCompletionTurnEnd,
  reduceNotifyFrame,
  sessionIdOf,
  shouldNotifySession,
  type HostNotifyFrame,
} from './notify-events';
import { profileNameFrom, storageEntries } from './storage-paths';
import { PollStateStore } from './state';
import { timeContextOf } from './time-context';
import {
  HelperProcess,
  defaultElectronExe,
  electronLandingDir,
  ensureElectronDownload,
  hasGraphicalDisplay,
  resolveElectronPath,
} from './helper-process';

/** 插件行 id（与 cordis.patch.yml 一致） */
export const name = 'dsh-whale-girl';
/** 需要注入的服务：webServer（路由）+ agentDefaultModel（当前服务商）+ credentials（凭证）+ llm（对话模型调用）+ commands（/balance 斜杠命令）+ connection（桌面 Helper「打开网站」用的已鉴权站点 URL） */
export const inject = ['webServer', 'agentDefaultModel', 'credentials', 'llm', 'commands', 'connection'];

/** 本包目录：宿主构建产物位于 lib/，其上一级即包根。 */
const PACKAGE_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** 包内 assets 根 */
const PACKAGE_ROOT_ASSETS = join(PACKAGE_ROOT, 'assets');

/** 包内表情包目录（表情包池的最后一环：assets/memes/<名称>.png） */
const PACKAGE_MEMES_DIR = join(PACKAGE_ROOT_ASSETS, 'memes');

/** 路由前缀 */
const ROUTE_PREFIX = '/dsh-whale-girl';

/**
 * 宿主是不是 **DSH 桌面应用**（Electron 宿主）。
 *
 * 判据只用 `process.versions.electron`：桌面应用以 `ELECTRON_RUN_AS_NODE=1` 跑宿主（见 dsh.cmd），
 * 该字段照样在；而 `dsh web` / 独立模式都是纯 Node 进程，取不到它。据此把「打开网站」自动分派：
 * 桌面宿主 → 唤起桌面应用窗口（helper 走 `dsh://open`），其余 → 浏览器打开站点。
 */
const isDesktopHost = (): boolean => Boolean(process.versions.electron);

/** 不同扩展名对应的 Content-Type 映射 */
const MIME: Record<string, string> = {
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mp4': 'video/mp4',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.jsonc': 'application/json; charset=utf-8',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

/**
 * 规范化并校验请求路径，确保它在 assets 根目录内（防路径穿越）。
 * @returns 规范化后的绝对文件路径；非法（穿越）时返回 undefined
 */
function resolveAsset(root: string, rel: string): string | undefined {
  if (rel.length === 0) return undefined;
  const candidate = normalize(join(root, rel));
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  if (candidate !== root && !candidate.startsWith(rootWithSep)) return undefined;
  return candidate;
}

/** 在 root 下解析并确认实体存在；非法（穿越）或不存在时返回 undefined */
function resolveExisting(root: string, rel: string): string | undefined {
  const candidate = resolveAsset(root, rel);
  return candidate && existsSync(candidate) ? candidate : undefined;
}

/**
 * 流式返回一个文件（带 Content-Type / 长度 / 缓存头）。
 *
 * Content-Length 必须取自**正在读的那个 fd**（open 事件里 fstat），不能先 stat 再另开流：用户往
 * $DSH_HOME/dsh-whale-girl/main-animation/webm/ 复制或同名覆盖素材时，stat 与真正开始读之间文件会被截断/
 * 改写，一旦实际字节数少于声明的长度，这个响应就**永远不结束、也不报错**（浏览器表现为 stalled、
 * 视频 loadeddata 永不触发且无 error）——正是 issue #62 现场"数据断供"的一种成因。同一个 fd 的
 * fstat 拿到的大小与随后读出的字节天然一致。
 */
function sendFile(res: ServerResponse, file: string, contentType: string): void {
  const stream = createReadStream(file);
  stream.once('open', (fd) => {
    if (res.destroyed || res.writableEnded) {
      stream.destroy(); // 客户端在开流前就放弃了
      return;
    }
    try {
      res.writeHead(200, {
        'content-type': contentType,
        'content-length': fstatSync(fd).size,
        'cache-control': 'public, max-age=3600',
      });
    } catch {
      // 极端情况下 fstat 拿不到：不发长度头，交给 Node 用 chunked 收尾（长度天然一致，只是没声明）
      res.writeHead(200, { 'content-type': contentType, 'cache-control': 'public, max-age=3600' });
    }
    stream.pipe(res);
  });
  // 读失败（文件被删/权限/被占用）：直接断连，让客户端立刻看到失败，而不是无限等待
  stream.on('error', () => res.destroy());
  // 客户端提前断开（快速切动画时高频发生）→ 停读，别把整个文件读完
  res.on('close', () => stream.destroy());
}

// 配置的读取/校验/合并/保存全部收敛在 ./config（readAllConfig / saveUserConfig，host 自包含实现，
// 不 import src/shared —— DSH 单文件加载约束）。本文件不再保留任何配置逻辑，只消费成品返回值。

/** 该宠物是否参与桌面模式（Electron 透明窗） */
const isDesktopVisible = (display: unknown): boolean => display === 'desktop' || display === 'both';

/** 发送 JSON 响应（headers 可选：如 no-cache 触发计数） */
function sendJson(res: ServerResponse, status: number, obj: unknown, headers: Record<string, string> = {}): void {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

/** 发送纯文本响应（素材 404/400 等显式错误文案） */
function sendText(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(body);
}

/**
 * 发送二进制响应（语音合成的 MP3）。
 *
 * 只走 HTTP：桌面 Helper 的 bridge 管道是 JSON 行协议，塞不了二进制音频。
 * 桌面窗里的语音走 `/voice/tts` 的 HTTP 端点（与本机 127.0.0.1 同源），不经 bridge。
 */
function sendBuffer(res: ServerResponse, status: number, body: Uint8Array, contentType: string): void {
  const buf = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': buf.length,
    // 同一段文本合成结果可缓存，但语音是一次性的，别让代理/浏览器留太久
    'cache-control': 'no-store',
  });
  res.end(buf);
}

/** 单次业务路由的应答（WebServer 注册与桌面 Helper 管道共用的同一契约；消费方各自落盘） */
type RouteResult =
  | { kind: 'json'; status: number; obj: unknown; headers?: Record<string, string> }
  | { kind: 'text'; status: number; body: string }
  | { kind: 'file'; file: string; contentType: string }
  | { kind: 'buffer'; status: number; body: Uint8Array; contentType: string };

/** 收集请求体（文本） */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve2, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve2(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// 额外宠物（pet pack）说明：校验/扫描已收敛到 ./config（readAllConfig 内部逐字段合并），
// 这里不再有 host 侧拷贝——文件宠物与主宠物一样，统一从 readAllConfig 的成品读取。
// ---------------------------------------------------------------------------

/** 宿主插件主体：注册 `/dsh-whale-girl` 前缀路由 + 斜杠命令（/balance /pet /chat）。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- DSH 注入的 ctx（webServer/locale 等 service 无静态类型）
export function apply(ctx: any): void {
  // 用户数据根：配置与用户素材统一收敛于此（扩展包按 <插件id> 各自建目录）
  const dshHome = resolveDshHome();
  const userRoot = join(dshHome, 'dsh-whale-girl');
  // 用户主配置（可编辑层）与文件宠物目录；配置读取/合并统一走 readAllConfig（./config）。
  // 主配置是 **JSONC**（main-config.jsonc）——与包内默认 config.jsonc 同名同格式：
  // 「同步」写进去的就是带注释的原文，扩展名如实反映内容（旧版 main-config.json 只读回落 + 启动迁移）
  const userConfigPath = join(userRoot, 'main-config.jsonc');
  const legacyUserConfigPath = join(userRoot, 'main-config.json');
  const petConfigDir = join(userRoot, 'pet');
  // 配置路径集（readAllConfig 的唯一输入：内置默认 + 用户主配置 + 文件宠物目录）
  const configPaths: ConfigPaths = {
    defaultFile: join(PACKAGE_ROOT, 'assets', 'config.jsonc'),
    userFile: userConfigPath,
    legacyUserFile: legacyUserConfigPath,
    petDir: petConfigDir,
  };
  // 老用户一次性迁移：main-config.json → main-config.jsonc（重命名，内容一字不动；
  // 新文件已存在则不动旧文件）。失败不影响运行——读取侧对旧路径有回落。
  migrateUserConfig(configPaths, (msg) => console.log('[dsh-whale-girl] ' + msg));
  // 用户动画目录（thumb 播放时优先于包内素材；webm 放 main-animation/webm/，mov（macOS 定制）放 main-animation/mov/）
  const thumbUserRoot = join(userRoot, 'main-animation');
  // 用户表情包目录（碎碎念/对话配图的图片：优先于包内 assets/memes，加图不必改包）
  const memesUserRoot = join(userRoot, 'memes');

  // ── 主动识屏（看屏幕搭话）──────────────────────────────────────────────
  // 配置单独放 sight.json：与宠物外观配置解耦（那边校验严格，手滑会牵连整体）。
  // 默认**关**——不开她绝不截图。
  const sightConfigPath = join(userRoot, 'sight.json');
  const sightSnapshotsRoot = join(userRoot, SIGHT_DIR);
  const readSightConfig = (): SightConfig => {
    try {
      const raw = JSON.parse(readFileSync(sightConfigPath, 'utf8')) as Partial<SightConfig>;
      return normalizeSightConfig(raw);
    } catch {
      // 文件不存在 / 不是合法 JSON：用默认（关）
      return { ...DEFAULT_SIGHT_CONFIG };
    }
  };
  /** 跨轮次的识屏状态：上一帧（判帧差）、上一句话（去重）与最近几句（防模板化重复） */
  const sightState: { lastJpeg?: Uint8Array; lastReply: string; recent: string[] } = {
    lastReply: '',
    recent: [],
  };

  // ── 代打（看屏幕 → 想一步 → 动手）────────────────────────────────────
  // 配置单独放 autoplay.json：与宠物/语音/识屏都解耦。
  // **默认关闭 + 空跑**：主人要显式打开、并且显式关掉空跑，才会真的按键。
  const autoplayConfigPath = join(userRoot, 'autoplay.json');
  const readAutoplayConfig = (): AutoplayConfig => {
    try {
      return normalizeAutoplayConfig(JSON.parse(readFileSync(autoplayConfigPath, 'utf8')) as Partial<AutoplayConfig>);
    } catch {
      return { ...DEFAULT_AUTOPLAY_CONFIG };
    }
  };

  // QQ 群接入已拆成独立插件（dsh-qq-group）：桌宠不再创建 QQ 控制器，
  // 也不再与群聊共享人设/记忆/模型。数据在 $DSH_HOME/dsh-qq-group。

  /**
   * 代打用的急停控制器。
   *
   * 生命周期跟着插件：配置变更时重建（换了热键就要换监听），
   * 卸载时停掉监听进程（否则会留下一个孤儿 PowerShell 一直轮询）。
   */
  let autoplayEstop = createEstop(readAutoplayConfig().estopKey);
  let stopEstopWatcher: (() => void) | undefined;

  /** 重建急停控制器与监听（配置变更后调用） */
  const rearmAutoplay = async (config: AutoplayConfig): Promise<void> => {
    stopEstopWatcher?.();
    stopEstopWatcher = undefined;
    autoplayEstop = createEstop(config.estopKey, (reason) => {
      console.warn(`[dsh-whale-girl] 代打急停：${reason}`);
    });
    // 只在「允许代打」时才启动监听——关着的时候没必要常驻一个轮询进程
    if (config.enabled) {
      // 语音热键在急停里是「豁免键」：按住它说话不算「主人接管」。
      // 否则陪玩中按 Alt+V 想提醒一句，会先把代打停掉（主人实测）。
      const voiceShortcut = readVoiceConfig().shortcut ?? DEFAULT_VOICE_SHORTCUT;
      const parsedVoice = parseHotkey(voiceShortcut);
      stopEstopWatcher = autoplayEstop.startWatching({
        ...(parsedVoice.ok ? { voiceSpec: parsedVoice.spec } : {}),
      });
    }
  };

  /**
   * 跑一轮代打。
   *
   * 所有副作用都从这一处注入，方便日后单测；决策逻辑本身在 autoplay.ts（纯函数）。
   */
  /**
   * 解析「识图该用哪个模型」。
   *
   * 顺序：单独指定 → **该宠物配置的 chatModel** → 会话实际模型。
   *
   * 为什么中间那环必须读宠物配置：主人是在「AI 与语音」页里选对话模型的，
   * 那个值存在 `main-config.jsonc` 的 `chatModel`，**不在 sight.json 里**。
   * 早先这里读的是 sight.json（那里根本没有 chatModel），于是一路落到「会话实际模型」，
   * 表现就是「我明明切了模型，看屏幕还显示旧的」。
   */
  const resolveVisionModel = (
    override?: { provider: string; model: string },
  ): { provider: string; model: string } | undefined => {
    if (override !== undefined) return override;
    try {
      const cfg = readAllConfig(configPaths);
      const petId = resolveActivePetId();
      const found = findPetInstance(cfg, petId);
      const conf = found ? found.conf : (cfg.main ?? {});
      const configured = configuredModel(conf, 'chatModel');
      if (configured !== undefined) return configured;
    } catch {
      /* 配置读不出来就往下回落 */
    }
    return resolveCurrentModel();
  };

  /**
   * 安全取 attachments 服务。
   *
   * 它**不在本插件的 inject 列表**里，直接写 `ctx.attachments` 会被 cordis 抛
   * 「cannot get property "attachments" without inject」（实测 500 就是这个）。
   * 用软取：没有就返回 undefined，调用方按「附件不可用」处理，
   * 而不是让整个路由崩掉。
   */
  const getAttachments = (): {
    saveImages: Parameters<typeof lookAtScreen>[0]['attachments']['saveImages'];
  } | undefined => {
    try {
      return ctx.get('attachments', false) as ReturnType<typeof getAttachments>;
    } catch {
      return undefined;
    }
  };

  /**
   * 代打用的技能库 + 上一帧/上一句描述。
   *
   * 技能只在「画面几乎没变」时复用：画面一变，之前那句描述就不再对应现在的屏幕，
   * 硬套技能会让她在错误场景按错键。
   */
  // ── 游戏档案 + 本局会话 ──────────────────────────────────────────────
  // 档案存 `games/<id>.json`（每款游戏一份：键位、要点、攻略缓存）
  const appsPath = join(userRoot, 'apps.json');
  /** 读用户自定义别名（与内置表合并；用户条目优先） */
  const readAppAliases = (): Record<string, string> => {
    let user: Record<string, string> = {};
    try {
      const raw = JSON.parse(readFileSync(appsPath, 'utf8')) as unknown;
      if (raw !== null && typeof raw === 'object') {
        for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
          if (typeof v === 'string' && k.trim() !== '' && v.trim() !== '') user[k] = v;
        }
      }
    } catch {
      /* 没有就用内置表 */
    }
    return { ...DEFAULT_APP_ALIASES, ...user };
  };

  const gamesRoot = join(userRoot, 'games');
  /** 本局游戏会话（玩的时候往里灌，退出时压缩成一条摘要写回共用记忆） */
  let autoplaySession: GameSession | undefined;
  /** 本局用的游戏档案（跑的时候用于拼提示词） */
  let currentGame: GameProfile | undefined;
  /** 待确认的发送任务（确认后才按键） */
  let pendingMessage: PendingMessage | undefined;
  /** 连续卡住几轮（noop / 解析失败 / 被拒），到阈值就自己上网查攻略 */
  let autoplayStuck = 0;
  /** 上次自动查攻略的时间（冷却用） */
  let autoplayLastSearchAt: number | undefined;

  const readGames = async (): Promise<GameProfile[]> => {
    try {
      const names = (await readdir(gamesRoot)).filter((n) => n.endsWith('.json'));
      const out: GameProfile[] = [];
      for (const name of names) {
        try {
          const parsed = normalizeProfile(JSON.parse(readFileSync(join(gamesRoot, name), 'utf8')) as Partial<GameProfile>);
          out.push(parsed);
        } catch {
          /* 单份坏了跳过，不影响其它 */
        }
      }
      return out.sort((a, b) => a.title.localeCompare(b.title));
    } catch {
      return [];
    }
  };

  const writeGame = async (profile: GameProfile): Promise<void> => {
    await mkdir(gamesRoot, { recursive: true });
    await writeFile(join(gamesRoot, profile.id + '.json'), JSON.stringify(profile, null, 2) + '\n', 'utf8');
  };

  /**
   * 结束本局：把会话压缩成一条摘要写进**共用记忆**，然后清空缓冲。
   *
   * 主人要求「记忆共用一份，只是玩的时候容量放大」——所以这里不是存到另一个地方，
   * 而是压成一条 assistant 注记塞回 memory.json，长期记忆仍是一条线。
   */
  const endAutoplaySession = async (): Promise<{ steps: number; summary: string } | undefined> => {
    const session = autoplaySession;
    if (session === undefined || !shouldCompress(session)) {
      autoplaySession = undefined;
      return undefined;
    }
    const petId = resolveActivePetId();
    let target = 5;
    try {
      const cfg = readAllConfig(configPaths);
      target = memoryRounds(petId, cfg);
    } catch {
      /* 读不到配置就用默认轮数 */
    }
    const summary = compressSession(session, target);
    try {
      const mem = await readMemory();
      const cfg = readAllConfig(configPaths);
      const found = findPetInstance(cfg, petId);
      const entryKey = found ? found.entry : 'main';
      const bucket = (mem[entryKey] ??= {});
      const record = (bucket[petId] ??= { messages: [] });
      record.messages.push({ role: 'assistant', content: summary, ts: Date.now() });
      const keep = Math.max(0, target) * 2;
      if (keep > 0 && record.messages.length > keep) record.messages = record.messages.slice(-keep);
      await writeMemory(mem);
    } catch (e) {
      console.warn('[dsh-whale-girl] 结束本局写记忆失败：' + (e instanceof Error ? e.message : String(e)));
    }
    const steps = session.steps.length;
    autoplaySession = undefined;
    return { steps, summary };
  };

  const autoplaySkills: Skill[] = [];
  let autoplayLastJpeg: Uint8Array | undefined;
  let autoplayLastDesc = '';
  /**
   * 防「同一个动作无限重放」：
   * - 技能快路径最多连用 1 次，之后必须重新看图（否则一次没生效的点击会被永远重放）；
   * - 连续 3 次相同动作且画面没变 → 停手报原因（这是主人实测「一直点同一个点」的根因）。
   */
  let autoplaySkillReuses = 0;
  let lastActionKey = '';
  let sameActionRounds = 0;
  /** 连续「画面几乎没有变化」的轮数（动作不同也算：卡在菜单上就是这种形态） */
  let noProgressRounds = 0;
  /** 本轮截图与上一轮的差异（0~1）；1 = 首轮/完全不同 */
  let lastCaptureDiff = 1;
  /**
   * 主人在陪玩过程中用语音给的战术提醒（全局热键 → ASR 识别出来的那句话）。
   * 下一轮会作为「主人刚刚提醒」写进给模型的上下文，用掉即清。
   */
  let autoplayUserHint = '';

  /**
   * 代打默认挑一个「快」的识图模型。
   *
   * 为什么不直接跟随对话模型：实测（2026-10-18，同一张游戏截图）
   *   workbuddy/step-5-preview（对话模型）   100 秒都没出结果，还空回复
   *   deepseek-account/deepseek-flash       **1.9 秒**
   *   workbuddy-ai/deepseek-v4.1-flash       4.6 秒
   * 对话模型偏重思考，代打要的是「快 + 能看图 + 按格式吐一行」，所以默认先用前者。
   * 两个都用不了才回落到对话模型（行为与旧版一致）。
   */
  const pickFastVisionModel = (): { provider: string; model: string } | undefined => {
    try {
      const llm = ctx.llm as { listProviders?: () => Array<{ id?: unknown }> } | undefined;
      const ids = (llm?.listProviders?.() ?? []).map((p) => String(p.id ?? ''));
      if (ids.includes('deepseek-account')) return { provider: 'deepseek-account', model: 'deepseek-flash' };
      if (ids.includes('workbuddy-ai')) return { provider: 'workbuddy-ai', model: 'deepseek-v4.1-flash' };
    } catch {
      /* 服务商列表不可用：回落对话模型 */
    }
    return undefined;
  };

  const runAutoplayOnce = async (config: AutoplayConfig): Promise<AutoplayRound> => {
    // 代打可以单独指定识图模型；没指定就用快速默认，最后才跟随对话模型。
    // 对话模型常是重推理模型（一轮 60 秒还空回复），不该被聊天选择拖死。
    const visionModel = config.visionModel ?? pickFastVisionModel() ?? resolveVisionModel();
    // 本局会话：第一次跑时按游戏类型给容量（这就是「玩游戏时容量放大」的落点）
    if (autoplaySession === undefined) {
      const games = await readGames();
      // 按白名单窗口挑对应档案：早先永远用 games[0]，所以填了 Wargroove 的档案也不生效，
      // 模型只看到一份「未命名游戏」的空档案（没键位、没要点、连查攻略都查错名字）。
      const matched =
        config.windowTitles.length > 0
          ? games.find((g) => windowMatchesAllowed(g.title, config.windowTitles))
          : games[0];
      // 没有档案就**用白名单里的窗口名当游戏名**（不落盘；查到攻略时会写进档案）。
      // 早先这里会退化成「未命名游戏」，于是自动查攻略永远查不到东西。
      const game = matched ?? normalizeProfile({ title: config.windowTitles[0] ?? '未指定游戏' });
      // 容量来源：档案自定义 > 类型预设 > 兜底
      const cap =
        game.memoryCap ?? (GENRE_MEMORY_CAP[game.genre] ?? GENRE_MEMORY_CAP.custom);
      autoplaySession = createGameSession(game.title, cap);
      currentGame = game;
    }
    const roundStartedAt = Date.now();
    // 主人语音提醒（若有）：只喂给这一轮，模型真的看了图就清掉
    const coachHint = autoplayUserHint;
    // 连续重复同一个无效动作时，把「换个办法」明确写进提示词——否则模型看到同一屏还会做同一个决定
    const stuckHint = [
      sameActionRounds >= 1 ? '注意：你刚才连续执行同一个动作、但画面没有变化。' : '',
      noProgressRounds >= 2
        ? `注意：画面已经连续 ${noProgressRounds + 1} 轮几乎没有变化。如果画面里有菜单（结束回合/概览/任务/取消），先点「取消」；否则换一个完全不同的操作。`
        : '',
      sameActionRounds >= 1 || noProgressRounds >= 2 ? '战棋移动单位要 drag（拖动）不是 click。' : '',
    ]
      .filter((part) => part !== '')
      .join(' ');
    const round = await runAutoplayRound(
      {
        capture: async () => {
          const shot = await captureScreen();
          const b64 = shot.dataUrl.split(',')[1] ?? '';
          const jpeg = Uint8Array.from(Buffer.from(b64, 'base64'));
          lastCaptureDiff = autoplayLastJpeg === undefined ? 1 : frameDiff(autoplayLastJpeg, jpeg);
          autoplayLastJpeg = jpeg;
          // 留一份审计快照：主人能亲眼看到「她到底看到了什么」。
          // 排查「看不清谁的回合」这类问题时，第一件事就是看这张图。
          try {
            await saveSnapshot(sightSnapshotsRoot, b64, readSightConfig().keepSnapshots);
          } catch {
            /* 存不下不影响代打 */
          }
          return { jpeg, width: shot.width, height: shot.height };
        },
        describe: async (jpeg: Uint8Array, context: string, screen: { width: number; height: number }) => {
          if (visionModel === undefined) return { ok: false as const, message: '没有可用的模型' };
          // 走到模型 = 重新看图：语音提醒已经进了这轮的上下文，用掉即清
          if (coachHint !== '') autoplayUserHint = '';
          // 走到模型 = 重新看图：技能连用计数清零（下一次同画面仍可复用一次）
          autoplaySkillReuses = 0;
          const attachments = getAttachments();
          if (attachments === undefined) {
            return { ok: false as const, message: '附件服务不可用（无法把图片交给模型）' };
          }
          // 动作模式（不是 watch）：系统提示 = 完整动作格式（AUTOPLAY_PROMPT），
          // 用户消息 = 游戏档案 + 最近战况 + 画面尺寸。
          // 早先这里用 watch + 一句 hint：系统提示要求「只做客观描述」，与「只输出一行动作」
          // 矛盾，模型只会描述画面 → parseActionPlan 必然 unparseable（真机实测 27 秒白跑一轮）。
          const hint = [
            context.trim() === '' ? '' : '游戏档案与最近战况：\n' + context,
            '画面尺寸：' + screen.width + '×' + screen.height + '（click 的 X/Y 按这个尺寸）',
            '现在只输出下一步动作，一行。',
          ]
            .filter((part) => part !== '')
            .join('\n\n');
          const result = await lookAtScreen(
            { llm: ctx.llm, attachments },
            jpeg,
            visionModel,
            'action',
            hint,
            (refs) => {
              void purgeAttachmentObjects(ctx, refs);
            },
            AUTOPLAY_PROMPT,
          );
          return result.ok ? { ok: true as const, text: result.text } : { ok: false as const, message: result.message };
        },
        perform: async (action) => {
          const result = await performInput(action, {
            allowedTitles: config.windowTitles,
            // 中文游戏名 ↔ 英文窗口标题：与开跑前的窗口校验用同一个匹配器，不能两套口径
            matchesTitle: windowMatchesAllowed,
          });
          return result.ok ? { ok: true as const } : { ok: false as const, message: result.message };
        },
        foregroundTitle: () => foregroundWindowTitle(),
        log: (message: string) => console.log('[dsh-whale-girl] ' + message),
        /** 技能快路径：只在画面几乎没变（<1%）且**本轮还没复用过的**时候复用一次 */
        trySkill: () => {
          // 早先这里用 frameDiff(autoplayLastJpeg, jpeg) 判断「画面没变」——
          // 但 autoplayLastJpeg 在 capture 里已经被更新成这一帧了，diff 恒为 0，
          // 于是一次（没生效的）点击会被**永远重放**（主人实测「一直点同一个点」）。
          // 现在用 capture 时算好的 lastCaptureDiff。
          if (autoplaySkills.length === 0 || autoplayLastDesc === '') return undefined;
          // 一招最多连用 1 次：复用之后必须重新看图，防止卡死在同一个动作上
          if (autoplaySkillReuses >= 1) return undefined;
          if (lastCaptureDiff >= 0.01) return undefined;
          const hit = matchSkill(autoplaySkills, autoplayLastDesc);
          if (hit === undefined) return undefined;
          autoplaySkillReuses++;
          return { name: hit.name, actions: hit.actions };
        },
        /** 学一招 / 记战绩 */
        learnSkill: (description: string, actions, ok: boolean) => {
          autoplayLastDesc = description;
          const existing = autoplaySkills.find((s) => s.name === description && s.actions.length === actions.length);
          if (existing !== undefined) {
            scoreSkill(existing, ok);
            const kept = pruneSkills(autoplaySkills);
            autoplaySkills.length = 0;
            autoplaySkills.push(...kept);
            return;
          }
          if (!ok) return; // 没成功过的不入库
          const created = createSkill(description, actions, autoplaySkills);
          if (created !== undefined) autoplaySkills.push(created);
          const kept = pruneSkills(autoplaySkills);
          autoplaySkills.length = 0;
          autoplaySkills.push(...kept);
        },
      },
      {
        dryRun: config.dryRun,
        allowedTitles: config.windowTitles,
        // 游戏档案（怎么玩）+ 最近战况（刚才做过什么）——模型靠这两样才知道该按什么
        gameContext: [
          profileBrief(currentGame ?? normalizeProfile({ title: '未指定游戏' })),
          recentContext(autoplaySession ?? createGameSession('', 1), 12),
          stuckHint,
          coachHint === '' ? '' : '主人刚刚用语音提醒：' + coachHint,
        ]
          .filter((x) => x !== '')
          .join('\n'),
      },
      autoplayEstop,
    );

    // 每轮耗时写进 voice-trace.log（同一份诊断日志）：判断「慢在模型还是慢在别处」用
    void appendFile(
      join(userRoot, 'voice-trace.log'),
      JSON.stringify({
        at: new Date().toISOString(),
        step: 'autoplay.round',
        detail: {
          elapsedMs: Date.now() - roundStartedAt,
          kind: round.kind,
          reason: round.kind === 'skipped' || round.kind === 'stopped' ? round.reason : undefined,
          model: visionModel === undefined ? undefined : visionModel.provider + '/' + visionModel.model,
          // 动作也记下来：排查「她到底点了哪里/有没有拖」就靠这两行
          thought: round.kind === 'planned' ? round.thought.slice(0, 100) : undefined,
          actions: round.kind === 'planned' ? JSON.stringify(round.actions).slice(0, 200) : undefined,
        },
      }) + '\n',
      'utf8',
    ).catch(() => {
      /* 诊断写不进去不影响代打 */
    });

    // 同一个动作连着做、画面又没变 → 停手。修的是主人实测的现象：
    // 她一直点同一个位置（技能缓存里那一招），点空了也照点。
    if (round.kind === 'planned') {
      const actionKey = JSON.stringify(round.actions);
      if (actionKey === lastActionKey && lastCaptureDiff < 0.02) {
        sameActionRounds++;
      } else {
        sameActionRounds = 0;
        lastActionKey = actionKey;
      }
      // 动作不同但画面一直不变（例如卡在菜单上）：另一种「没进展」，单独计数
      if (lastCaptureDiff < 0.01) noProgressRounds++;
      else noProgressRounds = 0;
      if (sameActionRounds >= 2) {
        return { kind: 'stopped', reason: '连续 3 次同一个动作、画面没有变化（大概是点空了）' };
      }
      if (noProgressRounds >= 6) {
        return {
          kind: 'stopped',
          reason: '连续 6 轮画面几乎没有变化（可能卡在菜单或动作无效）',
        };
      }
    } else {
      sameActionRounds = 0;
      lastActionKey = '';
    }

    // 记到本局会话（容量按游戏类型放大；退出时压缩回共用记忆）
    if (autoplaySession !== undefined) {
      if (round.kind === 'planned') {
        recordStep(autoplaySession, {
          at: Date.now(),
          screen: round.thought,
          plan: round.thought,
          executed: round.executed,
          // 空跑没按键 ≠ 被白名单拒绝：分开记，退出摘要才不会误报「被拒绝 N 次」
          outcome: round.executed ? 'ok' : config.dryRun ? 'dry' : 'rejected',
        });
      } else if (round.kind === 'stopped') {
        recordStep(autoplaySession, {
          at: Date.now(),
          screen: '急停',
          plan: '停止操作',
          executed: false,
          outcome: 'stopped',
        });
      }
    }
    // 卡住计数 + 自主查攻略
    if (round.kind === 'planned' && round.executed) {
      autoplayStuck = 0; // 走通一步就归零
    } else if (
      (round.kind === 'skipped' && (round.reason === 'model-noop' || round.reason === 'unparseable')) ||
      (round.kind === 'failed' && round.reason === 'inject')
    ) {
      autoplayStuck++;
    }

    // 连着卡住 → 自己上网查一次攻略，写进档案（下一轮就会带进提示词）
    if (
      currentGame !== undefined &&
      shouldSearchGuide({
        stuckRounds: autoplayStuck,
        hasGuide: currentGame.guide !== undefined,
        ...(autoplayLastSearchAt === undefined ? {} : { lastSearchAt: autoplayLastSearchAt }),
      })
    ) {
      autoplayStuck = 0;
      autoplayLastSearchAt = Date.now();
      console.log('[dsh-whale-girl] 连续卡住，自己查攻略：' + currentGame.title);
      const web = ctx.get('web', false) as Parameters<typeof searchGuide>[0];
      const found = await searchGuide(web, currentGame.title);
      if (found.ok) {
        currentGame = normalizeProfile({
          ...currentGame,
          guide: { query: found.query, summary: found.summary, sources: found.sources, atMs: found.atMs },
        });
        await writeGame(currentGame);
      }
    }

    return round;
  };

  /**
   * 陪玩循环：把「一轮」串成「一直玩」。
   *
   * runRound 复用 runAutoplayOnce（同一套急停/窗口/截图/模型/注入安全闸），
   * 这里只负责节奏与停止口径（见 src/host/play-loop.ts 的模块注释）。
   */
  let playWasRunning = false;
  /** 头顶气泡的上一句：同一句不重复写（窗口不在白名单时每秒都会触发） */
  let lastPlayBubble = '';
  const pushPlayBubble = (text: string): void => {
    const trimmed = text.trim();
    if (trimmed === '' || trimmed === lastPlayBubble) return;
    lastPlayBubble = trimmed;
    try {
      // 桌宠头顶气泡 = S 的 pets.<id>.say（浏览器与桌面两半共用同一出口）
      const petId = resolveActivePetId() || 'main';
      state.writePet(petId, 'say', { text: trimmed });
    } catch {
      /* 气泡写失败不影响循环 */
    }
  };
  /**
   * 把循环内部消息翻译成给人看的气泡。
   *
   * 为什么不直接显示 lastMessage：窗口不在白名单时它是
   * 「不在白名单窗口：@docs\HANDOFF… — DeepSeek Harness」这种长串，
   * 主人只会觉得在刷屏。这里换成「等游戏窗口（现在前台：DSH）」。
   */
  const playBubbleText = (message: string): string => {
    const prefix = '不在白名单窗口：';
    if (!message.startsWith(prefix)) return message;
    const current = message.slice(prefix.length).trim();
    const short = current.length > 26 ? current.slice(0, 26) + '…' : current;
    return '等我切到游戏窗口…（现在前台：' + (short === '' ? '无标题' : short) + '）';
  };
  /** 思考气泡延迟 800ms 再写：窗口不对的轮次一两百毫秒就返回，不该闪一下「思考中」 */
  let thinkingBubbleTimer: ReturnType<typeof setTimeout> | null = null;
  const clearThinkingBubble = (): void => {
    if (thinkingBubbleTimer !== null) {
      clearTimeout(thinkingBubbleTimer);
      thinkingBubbleTimer = null;
    }
  };
  const playLoop = createPlayLoop({
    runRound: async () => {
      const conf = readAutoplayConfig();
      if (!conf.enabled) return { kind: 'stopped', reason: 'disabled' };
      return runAutoplayOnce(conf);
    },
    intervalMs: 1200,
    failureDelayMs: 3000,
    failureLimit: 3,
    maxRounds: 200,
    onState: (snap) => {
      // 等待白名单窗口时不断续上急停宽限：主人切到游戏窗口那一下点击/按键不该把她停掉
      if (snap.running && snap.lastMessage.startsWith('不在白名单窗口')) autoplayEstop.grantGrace(3000);
      // 头顶气泡：桌面模式看不到浏览器右下角的浮标，头顶这一句才是主人实际会看的
      if (snap.running) {
        if (snap.state === 'thinking') {
          if (thinkingBubbleTimer === null) {
            thinkingBubbleTimer = setTimeout(() => {
              thinkingBubbleTimer = null;
              // 空跑时把「只看不动」直接写在气泡里：主人最爱问的就是「她到底动没动」
              pushPlayBubble(
                readAutoplayConfig().dryRun ? '让我想想…（空跑：只看不动）' : '让我想想…',
              );
            }, 800);
          }
        } else {
          clearThinkingBubble();
          if (snap.lastMessage !== '') pushPlayBubble(playBubbleText(snap.lastMessage));
        }
      } else if (playWasRunning) {
        clearThinkingBubble();
        pushPlayBubble(playBubbleText(snap.lastMessage));
      }
      // 循环自己停了（急停/连续失败/轮数上限）：把本局压缩进共用记忆
      if (playWasRunning && !snap.running) {
        void endAutoplaySession().catch(() => {
          /* 记忆写失败不影响停止 */
        });
      }
      // 桌面宠物据此在代打期间保持点击穿透：她的点击要落到游戏上，
      // 不能被宠物窗口吃掉（吃掉的后果就是「一直点同一个位置、画面没反应」）。
      if (snap.running !== playWasRunning) {
        try {
          state.writeSection('autoplay', { running: snap.running, state: snap.state });
        } catch {
          /* 状态写失败不影响循环 */
        }
      }
      playWasRunning = snap.running;
    },
  });

  /**
   * 开始陪玩（设置页按钮、右键菜单、语音指令共用这一条路径）。
   * @returns ok=false 时带明确原因（真注入没白名单会被拒）
   */
  const beginPlay = async (patch: Record<string, unknown> = {}): Promise<{ ok: true } | { ok: false; message: string }> => {
    const current = readAutoplayConfig();
    // patch.visionModel = null 显式表示「跟随对话模型」；缺省沿用当前配置
    const requestedVision =
      patch.visionModel === null
        ? undefined
        : patch.visionModel !== undefined
          ? (patch.visionModel as AutoplayConfig['visionModel'])
          : current.visionModel;
    const next = normalizeAutoplayConfig({
      enabled: true,
      dryRun: typeof patch.dryRun === 'boolean' ? patch.dryRun : current.dryRun,
      estopKey: typeof patch.estopKey === 'string' ? patch.estopKey : current.estopKey,
      windowTitles: Array.isArray(patch.windowTitles)
        ? (patch.windowTitles as unknown[]).filter((v): v is string => typeof v === 'string' && v.trim() !== '')
        : current.windowTitles,
      visionModel: requestedVision,
    });
    // 真注入 + 空白名单 = 她会对任何前台窗口动手（包括 DSH 自己）：拒绝开跑。
    // 空跑不受此限（只记录计划，不按键）。
    if (!next.dryRun && next.windowTitles.length === 0) {
      return { ok: false, message: '真注入模式必须填「允许动手的窗口」白名单（否则可能点错到别的窗口）' };
    }
    await mkdir(userRoot, { recursive: true });
    await writeFile(autoplayConfigPath, JSON.stringify(next, null, 2) + '\n', 'utf8');
    await rearmAutoplay(next);
    // 开始这一下是点击、主人还要切到游戏窗口：先恢复急停，再给 5 秒宽限期
    autoplayEstop.resume();
    autoplayEstop.grantGrace(5000);
    // **主动把白名单里的窗口切到前台**：主人是从 DSH 里点开始的，不切过去她会一直等窗口，
    // 主人看到的就是「一直循环：不在白名单窗口」。这里借主人点开始这一次前台权切过去最稳。
    try {
      const subprocess = ctx.get('subprocess', false) as Parameters<typeof listWindows>[0];
      const wins = await listWindows(subprocess);
      const target = wins.find((w) => windowMatchesAllowed(w.title, next.windowTitles));
      if (target !== undefined) {
        const focused = await focusWindow(subprocess, target.pid);
        pushPlayBubble(
          focused
            ? '切到「' + target.title + '」，开始了…'
            : '想切到「' + target.title + '」但系统没让，点一下游戏窗口就行',
        );
      } else if (next.windowTitles.length > 0) {
        pushPlayBubble('没找到白名单里的窗口：' + next.windowTitles.join(' / '));
      }
    } catch {
      /* 切不过去就等主人自己切（窗口校验会继续等，不花钱） */
    }
    playLoop.start();
    return { ok: true };
  };

  /** 停止陪玩：停循环 + 急停 + 结束本局（压缩记忆）。三处入口共用，避免行为漂移 */
  const stopPlayNow = async (reason: string): Promise<{ steps: number; summary: string } | undefined> => {
    playLoop.stop(reason);
    autoplayEstop.stop('manual');
    return endAutoplaySession();
  };

  /**
   * 跑一轮识屏：看屏幕 → 判断值不值得说 → 写进 `say` 叶子（气泡 / 可选语音）。
   *
   * 这是**唯一**的落地出口：手动触发（POST /sight/run）和定时器都走它，
   * 保证两条路径行为完全一致，不会出现「手动能说、定时不说」这种漂移。
   */
  /**
   * 删掉刚才为了送图而临时写下的附件对象（「落地即焚」）。
   *
   * 为什么要这么做：DSH 的图片消息只能吃 `ImageAttachmentRef`，而附件存储
   * **只有落盘实现**（`writeFile` + `link` 到 `objects/<sha256>`，全文没有内存模式）。
   * 主人接受「落盘约 1 秒」，但要求**调用完就删**。
   *
   * 注意：路径是内容寻址的（`objects/<sha256 前2位>/<sha256>`），删之前先确认
   * 它确实是我们这次写的那份；删除失败只记日志，绝不影响对话结果。
   */
  const purgeAttachmentObjects = async (
    context: unknown,
    refs: Array<{ attachmentId?: string }>,
  ): Promise<void> => {
    if (refs.length === 0) return;
    try {
      // 附件根目录由 DSH 管理，按官方布局推导：$DSH_HOME/attachments/v1/objects/<xx>/<sha256>
      const attachments = (context as { attachments?: { root?: string } }).attachments;
      // 服务本身不暴露路径，退一步用 DSH_HOME 拼（与 observed-model.json 同源）
      const root = attachments?.root ?? join(dshHome, 'attachments', 'v1', 'objects');
      for (const ref of refs) {
        const id = typeof ref.attachmentId === 'string' ? ref.attachmentId : '';
        if (id === '') continue;
        // attachmentId 就是 sha256（内容寻址），取前两位分桶
        const file = join(root, id.slice(0, 2), id);
        try {
          await unlink(file);
        } catch {
          /* 已经不在了 / 被别的会话共用 → 都不算错 */
        }
      }
    } catch {
      /* 清理是尽力而为，失败不能让识屏结果作废 */
    }
  };

  /**
   * 执行一条语音指令。
   *
   * 返回要播报的话；返回 undefined = 这个意图当前不可用（交给正常对话兜底）。
   *
   * 注意：这里**不绕过任何安全闸**——开关走的是和设置页同一个配置写盘，
   * 代打仍然受急停与窗口白名单约束，语音只是"另一只手按同一个按钮"。
   */
  const runVoiceIntent = async (intent: ReturnType<typeof parseVoiceIntent>, petId: string): Promise<string | undefined> => {
    if (intent === undefined) return undefined;
    try {
      switch (intent.kind) {
        case 'stop-now': {
          autoplayEstop.stop('manual');
          return intentReply(intent);
        }
        case 'end-session': {
          const ended = await endAutoplaySession();
          if (ended === undefined) return '这局还没开始呢。';
          return ended.summary;
        }
        case 'toggle-sight': {
          const current = readSightConfig();
          const next = { ...current, enabled: intent.on ?? !current.enabled };
          await mkdir(userRoot, { recursive: true });
          await writeFile(sightConfigPath, JSON.stringify(next, null, 2) + '\n', 'utf8');
          armSightTimer();
          return intentReply({ ...intent, on: next.enabled });
        }
        case 'toggle-autoplay': {
          // 「打开/关掉代打」= 开始/停止陪玩循环（不再是只翻一个权限位——
          // 主人说「打开代打」要的就是她开始玩，见 2026-10-18 的反馈）
          const running = playLoop.snapshot().running;
          const wantOn = intent.on ?? !running;
          if (wantOn) {
            const started = await beginPlay();
            if (!started.ok) return started.message;
            return '好，我开始陪玩啦。累了就说「停」或者按急停键。';
          }
          await stopPlayNow('voice');
          return '好，先停在这。';
        }
        case 'look-now': {
          // 语音里的「你看看…」不是一条独立命令，而是**对话请求**：
          // 早先这里直接 runSightOnce，识屏关着时就回一句「这屏好像没什么可说的」——
          // 主人问「看看我现在什么样子」永远得到这句，等于没看。
          // 现在交给下面的聊天链路（会强制附上当前屏幕的多帧），由她看着画面回答。
          return undefined;
        }
        case 'status': {
          const sightOn = readSightConfig().enabled;
          const autoOn = readAutoplayConfig().enabled;
          const steps = autoplaySession?.steps.length ?? 0;
          return `识屏${sightOn ? '开着' : '关着'}，代打${autoOn ? '开着' : '关着'}，本局记了 ${steps} 步。`;
        }
        case 'open-app': {
          // 走 ctx.subprocess（和 DSH 自己跑命令同一个执行世界），不猜路径：
          // Start-Process 会按 PATH / App Paths 注册表自己解析，比我们拼路径可靠。
          void petId;
          const sub = ctx.get('subprocess', false) as Parameters<typeof openApp>[0];
          // 先看是不是已开着的窗口（比重新启动更常见：'打开群星'通常是想切回去）
          const wins = await listWindows(sub);
          const hit = findWindow(wins, intent.target);
          if (hit !== undefined) {
            // 已开着就切过去（"打开群星"通常是想切回那个窗口，不是再开一个）
            const focused = await focusWindow(sub, hit.pid);
            return focused ? `切到「${hit.title}」了。` : `「${hit.title}」开着，但没切过去（系统不肯让）。`;
          }
          const opened = await openApp(sub, intent.target, readAppAliases());
          return opened.ok ? intentReply(intent) : `没打开${intent.target}：${opened.message}`;
        }
        case 'search': {
          const web = ctx.get('web', false) as Parameters<typeof searchGuide>[0];
          const result = await searchGuide(web, intent.query, '');
          if (!result.ok) return `没查到：${result.message}`;
          return `查到一些：「${result.summary.slice(0, 120)}」`;
        }
      }
    } catch (e) {
      console.warn('[dsh-whale-girl] 语音指令执行失败：' + (e instanceof Error ? e.message : String(e)));
      return '这条命令没执行成功。';
    }
  };

  /**
   * 执行一个「自己能做」的动作。
   *
   * 返回要播报的话；undefined = 这个动作当前做不了（交给正常对话兜底）。
   * 所有失败都如实说——"好的我去做了"然后什么都没发生是最坏的结果。
   */
  const runSelfAction = async (action: SelfAction): Promise<string | undefined> => {
    const sub = ctx.get('subprocess', false) as Parameters<typeof openApp>[0];
    switch (action.do) {
      case 'open-app': {
        const wins = await listWindows(sub);
        const hit = findWindow(wins, action.target);
        if (hit !== undefined) {
          const focused = await focusWindow(sub, hit.pid);
          return focused ? `切到「${hit.title}」了。` : `「${hit.title}」开着，但没切过去。`;
        }
        const opened = await openApp(sub, action.target, readAppAliases());
        return opened.ok ? `好，打开${action.target}。` : `没打开${action.target}：${opened.message}`;
      }
      case 'focus-window': {
        const wins = await listWindows(sub);
        const hit = findWindow(wins, action.target);
        if (hit === undefined) return `没找到「${action.target}」这个窗口。`;
        const focused = await focusWindow(sub, hit.pid);
        return focused ? `切到「${hit.title}」了。` : `「${hit.title}」没切过去。`;
      }
      case 'open-url': {
        const r = await runCommand(sub, ['powershell.exe', '-NoProfile', '-Command', `Start-Process '${action.url.replace(/'/g, "''")}'`], { timeoutMs: 20000 });
        return r.ok ? `好，打开 ${action.url}。` : `打不开网址：${r.message}`;
      }
      case 'search-web': {
        // 搜索 = 用系统默认浏览器打开搜索结果页（比"读一堆网页再总结"快得多，也更符合直觉）
        const url = 'https://www.bing.com/search?q=' + encodeURIComponent(action.query);
        const r = await runCommand(sub, ['powershell.exe', '-NoProfile', '-Command', `Start-Process '${url}'`], { timeoutMs: 20000 });
        return r.ok ? `好，帮你搜「${action.query}」。` : `搜不了：${r.message}`;
      }
      case 'play-music': {
        // 没有通用音乐 API，务实做法：打开网易云并搜索
        const wins = await listWindows(sub);
        const netease = findWindow(wins, '网易云') ?? findWindow(wins, 'cloudmusic');
        if (netease !== undefined) {
          const focused = await focusWindow(sub, netease.pid);
          return focused ? `网易云开着，你去搜「${action.what}」吧。` : `网易云没切过去。`;
        }
        const opened = await openApp(sub, 'cloudmusic', readAppAliases());
        if (!opened.ok) return `打不开网易云：${opened.message}`;
        // 打开之后**自己去找歌播放**——走通用任务循环，不再让你手动搜。
        // 这就是"和玩游戏模式差不多"的落地：同一套看屏幕→决定→按的循环。
        const run = await runTask(`在网易云音乐里播放「${action.what}」`, {
          allowedTitles: ['网易云音乐', 'cloudmusic'],
          maxSteps: 15,
          dryRun: false,
        });
        return run.ok ? `放上了：${run.summary}` : `打开了网易云，但没能自动播放（${run.summary}）`;
      }
      case 'send-message': {
        // 分两步：先把要发的东西摆出来让主人确认，**不立刻按键**。
        // 搜联系人那步一旦匹配错人，消息发给别人就收不回来了。
        pendingMessage = { app: action.app, to: action.to, text: action.text, at: Date.now() };
        return describePending(pendingMessage);
      }
    }
  };

  /**
   * 执行「确认过了」的发送：真正按键。
   *
   * 每一步失败就停手（不再往下按），因为后半段的按键会落到错误的窗口里，
   * 那比不发更糟。中文只能走剪贴板——SendKeys 打不出中文。
   */
  const executePendingMessage = async (): Promise<string> => {
    const pending = pendingMessage;
    if (pending === undefined) return '没有待发的消息。';
    if (isExpired(pending)) {
      pendingMessage = undefined;
      return '这条消息放太久了，已经作废。要发的话再跟我说一次。';
    }
    pendingMessage = undefined;

    const sub = ctx.get('subprocess', false) as Parameters<typeof openApp>[0];
    const wins = await listWindows(sub);
    const win = findWindow(wins, pending.app);
    if (win === undefined) {
      const opened = await openApp(sub, pending.app, readAppAliases());
      if (!opened.ok) return `打不开${pending.app}：${opened.message}`;
      await new Promise((r) => setTimeout(r, 2500)); // 等它真的起来
    } else {
      const focused = await focusWindow(sub, win.pid);
      if (!focused) return `没法把${pending.app}切到前台，所以没发。`;
    }

    for (const step of planSend(pending)) {
      if (step.kind === 'clipboard') {
        const r = await runCommand(sub, [
          'powershell.exe', '-NoProfile', '-Command',
          `Set-Clipboard -Value '${step.text.replace(/'/g, "''")}'`,
        ], { timeoutMs: 15000 });
        if (!r.ok) return `写剪贴板失败，没发出去：${r.message}`;
        await new Promise((r2) => setTimeout(r2, 120));
        continue;
      }
      const input = await performInput(
        { kind: 'key', key: step.key, ...(step.modifiers === undefined ? {} : { modifiers: step.modifiers }) } as never,
        { allowedTitles: [] },
      );
      if (!input.ok) return `按键「${step.key}」被拒，没发出去：${input.message}`;
      await new Promise((r2) => setTimeout(r2, 200));
    }
    return pending.text.trim() === ''
      ? `打开了和「${pending.to}」的会话，但你没说发什么，所以没发。`
      : `发了：给${pending.app}的「${pending.to}」——「${pending.text}」`;
  };

  /**
   * 跑一个通用任务：看着屏幕一步步做成。
   *
   * 这是「硬编码动作」的替代方案——播放音乐、搜索、发消息都走这一条路，
   * 和玩游戏共用同一套"截图→决定→注入→验证"的循环，只是目标不同。
   *
   * 每步都会检查急停；连续卡住或超步数就停手，不无限烧钱。
   */
  const runTask = async (
    goal: string,
    opts: { allowedTitles?: string[]; maxSteps?: number; dryRun?: boolean } = {},
  ): Promise<{ ok: boolean; kind: 'done' | 'gaveup' | 'stopped' | 'failed'; summary: string; steps: number }> => {
    const visionModel = resolveVisionModel();
    if (visionModel === undefined) return { ok: false, kind: 'failed', summary: '没有可用的模型', steps: 0 };
    const attachments = getAttachments();
    if (attachments === undefined) return { ok: false, kind: 'failed', summary: '附件服务不可用', steps: 0 };

    const maxSteps = Math.max(1, Math.min(50, opts.maxSteps ?? DEFAULT_TASK_CONFIG.maxSteps));
    const dryRun = opts.dryRun ?? DEFAULT_TASK_CONFIG.dryRun;
    const state = createTaskState();
    let lastJpeg: Uint8Array | undefined;

    for (let step = 1; step <= maxSteps; step++) {
      // 急停优先：每步都查（主人一动键鼠就停）
      if (!autoplayEstop.canAct()) {
        const snap = autoplayEstop.snapshot();
        return { ok: false, kind: 'stopped', summary: `急停：${snap.lastReason ?? '已停止'}`, steps: state.steps };
      }

      const shot = await captureScreen();
      const jpeg = Uint8Array.from(Buffer.from(shot.dataUrl.split(',')[1] ?? '', 'base64'));
      const changed = lastJpeg === undefined ? true : frameDiff(lastJpeg, jpeg) >= 0.01;
      lastJpeg = jpeg;
      // 存一份审计快照：主人要能回看「她看到了什么」。
      // 早先只有识屏链路存、任务循环不存——所以设置页里看不到任务期间的画面。
      try {
        await saveSnapshot(sightSnapshotsRoot, shot.dataUrl.split(',')[1] ?? '', readSightConfig().keepSnapshots);
      } catch {
        /* 存不下不影响任务本身 */
      }

      const seen = await lookAtScreen(
        { llm: ctx.llm, attachments },
        jpeg,
        visionModel,
        // 与代打同一档：只输出一行动作（watch 档的系统提示要求「描述画面」，与动作格式冲突）
        'action',
        taskPrompt(goal, step, maxSteps),
        (refs) => void purgeAttachmentObjects(ctx, refs),
      );
      if (!seen.ok) return { ok: false, kind: 'failed', summary: seen.message, steps: state.steps };

      // 留痕：模型到底说了什么。没有这行，失败时只能猜。
      console.log('[dsh-whale-girl] 任务第 ' + step + ' 步模型输出：' + seen.text.slice(0, 200));

      // 先看是不是报告完成（任务特有），再交给代打那套动作解析（不重复实现）
      const finished = parseTaskDone(seen.text);
      if (finished !== undefined) {
        return { ok: true, kind: 'done', summary: finished, steps: state.steps };
      }
      const plan = parseActionPlan(seen.text, { width: shot.width, height: shot.height });
      if (plan.kind === 'noop' || plan.kind === 'invalid') {
        advanceTaskState(state, `跳过：${plan.kind === 'noop' ? plan.reason : plan.reason}`, changed);
        const giveUp = shouldGiveUp(state, maxSteps);
        if (giveUp.giveUp) return { ok: false, kind: 'gaveup', summary: giveUp.reason, steps: state.steps };
        continue;
      }

      // 执行这一步的动作
      let executed = true;
      if (!dryRun) {
        autoplayEstop.markInjecting(true);
        try {
          for (const action of plan.actions) {
            const r = await performInput(action, {
            allowedTitles: opts.allowedTitles ?? [],
            matchesTitle: windowMatchesAllowed,
          });
            if (!r.ok) {
              executed = false;
              return { ok: false, kind: 'failed', summary: `动作被拒：${r.message}`, steps: state.steps };
            }
          }
        } finally {
          autoplayEstop.markInjecting(false);
        }
      }
      advanceTaskState(state, `${executed ? '' : '[空跑]'}${plan.actions.length} 个动作`, changed);
      const giveUp = shouldGiveUp(state, maxSteps);
      if (giveUp.giveUp) return { ok: false, kind: 'gaveup', summary: giveUp.reason, steps: state.steps };
    }
    return { ok: false, kind: 'gaveup', summary: `走了 ${state.steps} 步还没完成`, steps: state.steps };
  };

  const runSightOnce = async (): Promise<SightRound> => {
    const conf = readSightConfig();
    const round = await runSightRound(
      conf,
      {
        capture: () => captureScreen(),
        describe: async (jpeg: Uint8Array, mode) => {
          // 识图用哪个模型：默认用**快模型**（识屏只是看一眼说一两句，不值得等 30 秒）；
          // 快模型不可用才回落到「sight.json 单独指定 > 宠物 chatModel > 会话实际模型」。
          const visionModel = pickFastVisionModel() ?? resolveVisionModel();
          if (visionModel === undefined) {
            return { ok: false as const, reason: 'no-model', message: '没解析到可用的识图模型' };
          }
          // attachments 不在 inject 列表里，必须软取（硬取会抛 500）
          const attachments = getAttachments();
          if (attachments === undefined) {
            return { ok: false as const, reason: 'attachments-missing', message: '附件服务不可用' };
          }
          // 反模板化：把最近几次搭话的原文给模型看，让它换角度/换开头；
          // watch（只看不说话）不需要这些，避免干扰描述任务。
          const recent = sightState.recent.slice(-4);
          const styleHint =
            mode === 'watch'
              ? undefined
              : [
                  recent.length === 0
                    ? ''
                    : '你最近几次搭话是：' +
                      recent.map((text) => '「' + text + '」').join('、') +
                      '。这次换个角度和开头，别重复这些说法，也别只复述画面。',
                  '现在是' + timeContextOf(new Date()) + '。',
                ]
                  .filter((part) => part !== '')
                  .join('\n');
          const result = await lookAtScreen(
            { llm: ctx.llm, attachments },
            jpeg,
            visionModel,
            mode,
            styleHint,
            // 落地即焚：调用一结束立刻删掉临时附件
            (refs) => {
              void purgeAttachmentObjects(ctx, refs);
            },
          );
          return result.ok ? { ok: true as const, text: result.text } : result;
        },
        persist: (jpegBase64: string, keep: number) => saveSnapshot(sightSnapshotsRoot, jpegBase64, keep),
        diff: frameDiff,
        parseReply: parseSightReply,
      },
      sightState,
    );

    if (round.kind === 'spoke') {
      // 记下这句：下一轮会作为「你最近说过」的上下文，防止每次都是同一个模板
      sightState.lastReply = round.text;
      sightState.recent = [...sightState.recent, round.text].slice(-4);
      const petId = resolveActivePetId();
      state.writePet(
        petId,
        'say',
        // 识屏搭话默认只弹气泡；conf.speak 打开后由桌面渲染端念出来。
        round.speak ? { text: round.text, speak: true } : { text: round.text },
      );
      console.log(`[dsh-whale-girl] 看屏幕说：${round.text}`);

      // 写进**同一份记忆**（memory.json，与文字/语音对话共用）。
      //
      // 为什么：主人问过「识屏搭话、陪玩、语音、文字的记忆难道不共用吗」——
      // 早先识屏确实是独立的（每次看完就忘），所以她刚才夸过你打赢，下一秒又问你在干嘛。
      // 现在她看屏幕说的话也进历史，下次对话就能接上。
      if (conf.memoryShared) {
        try {
          const cfgNow = readAllConfig(configPaths);
          const mem = await readMemory();
          const found = findPetInstance(cfgNow, petId);
          const entryKey = found ? found.entry : 'main';
          const bucket = (mem[entryKey] ??= {});
          const record = (bucket[petId] ??= { messages: [] });
          const now = Date.now();
          // 用一条 system 风格的注记，避免被模型当成"主人说的话"
          record.messages.push({ role: 'assistant', content: `（我看了眼屏幕，说：${round.text}）`, ts: now });
          // 截断到配置轮数，防止无限增长烧 token
          const rounds = memoryRounds(petId, cfgNow);
          const keep = Math.max(0, rounds) * 2;
          if (keep > 0 && record.messages.length > keep) {
            record.messages = record.messages.slice(-keep);
          }
          await writeMemory(mem);
        } catch (e) {
          // 记忆写失败不能影响这次已经成功的搭话
          console.warn('[dsh-whale-girl] 识屏记忆写入失败：' + (e instanceof Error ? e.message : String(e)));
        }
      }
    } else if (round.kind === 'failed') {
      console.warn(`[dsh-whale-girl] 识屏失败（${round.reason}）：${round.message}`);
    }
    return round;
  };

  /**
   * 重排识屏定时器。
   *
   * 用 `setTimeout` 自链而不是 `setInterval`：一轮识屏要抓屏 + 调模型（秒级），
   * 固定间隔会在慢轮次上堆积请求。自链保证「上一轮跑完才开始计时下一轮」。
   *
   * 配置变更（POST /sight/config）会立刻调它重排，不用等重启。
   */
  let sightTimer: ReturnType<typeof setTimeout> | null = null;
  const armSightTimer = (): void => {
    if (sightTimer !== null) {
      clearTimeout(sightTimer);
      sightTimer = null;
    }
    const conf = readSightConfig();
    if (!conf.enabled) return; // 关着就什么都不排
    // 随机间隔（不是固定频率）：主人要的是「偶尔瞄一眼」而不是机械的每 N 秒
    const delayMs = nextSightDelayMs(conf);
    sightTimer = setTimeout(() => {
      sightTimer = null;
      void (async () => {
        try {
          await runSightOnce();
        } catch (e) {
          console.warn('[dsh-whale-girl] 识屏异常：' + (e instanceof Error ? e.message : String(e)));
        } finally {
          armSightTimer(); // 链式安排下一轮
        }
      })();
    }, delayMs);
  };

  /**
   * **会话实际在用的模型**（观察值）。
   *
   * 为什么不能只用 `agentDefaultModel.currentSelection()`：DSH 的文档写得很清楚——
   * 它「owns the **default** model selection independently of any Host or transport」，
   * 也就是**新会话的默认模型**，跟界面里给当前会话挑的那个可以是两码事。
   * 实测就撞上了：profile 里默认写的是 `workbuddy-ai`，而主人当前会话跑在
   * `deepseek-account/deepseek-flash` 上，插件却拿默认值去调用，直接吃了 429。
   *
   * 权威来源是 `agent/request` 瀑布：每一轮请求的最终 provider/model 都会从这里过一遍
   * （DSH 自己的会话级模型选择也是在这个瀑布里覆盖的，见 dsh-agent 的
   * `installModelSelection`）。我们只**旁听**：`await next()` 拿到解析结果，记下来，原样返回，
   * 绝不改配置。
   *
   * 没观察过（插件刚启动、还没跑过任何对话）时退回默认值——不能因为没数据就不出声。
   */
  let observedSessionModel: { provider: string; model: string } | undefined;

  /**
   * 把学到的会话模型**落盘**。
   *
   * 为什么必须存：观察值只活在进程内存里，DSH 一重启就没了。而插件刚启动、
   * 还没旁听到任何请求的那段时间，`resolveCurrentModel()` 只能退回
   * `agentDefaultModel` 的默认值——本机那个默认值是已经限流的 workbuddy-ai，
   * 于是「重启后第一次对话/语音必定失败一次」（主人实测踩到）。
   * 存下来后，重启读回上次学到的，冷启动窗口就不存在了。
   */
  const observedModelPath = join(userRoot, 'observed-model.json');
  try {
    const cached = JSON.parse(readFileSync(observedModelPath, 'utf8')) as { provider?: unknown; model?: unknown };
    if (typeof cached.provider === 'string' && cached.provider !== '' && typeof cached.model === 'string' && cached.model !== '') {
      observedSessionModel = { provider: cached.provider, model: cached.model };
    }
  } catch {
    /* 首次运行没有缓存，正常 */
  }
  const persistObservedModel = (value: { provider: string; model: string }): void => {
    observedSessionModel = value;
    void (async () => {
      try {
        await mkdir(userRoot, { recursive: true });
        await writeFile(observedModelPath, JSON.stringify(value, null, 2) + '\n', 'utf8');
      } catch {
        /* 存不下来不影响本次对话 */
      }
    })();
  };
  ctx.effect(() => {
    try {
      return ctx.on('agent/request', async (_payload: unknown, next: () => Promise<unknown>) => {
        const resolved = (await next()) as { provider?: unknown; model?: unknown } | undefined;
        try {
          const provider = resolved?.provider;
          const model = resolved?.model;
          if (typeof provider === 'string' && provider !== '' && typeof model === 'string' && model !== '') {
            // 变了才写盘：每轮请求都写会白白制造磁盘 IO
            if (observedSessionModel?.provider !== provider || observedSessionModel.model !== model) {
              persistObservedModel({ provider, model });
            }
          }
        } catch {
          /* 只旁听，出问题也不能影响这一轮请求 */
        }
        return resolved;
      });
    } catch (e) {
      // 事件注册失败**不能连带插件起不来**：观察模型只是「让对话更准」的增强，
      // 退化成用 agentDefaultModel 的默认值也要能跑。
      console.warn(
        '[dsh-whale-girl] 无法旁听 agent/request（将退回默认模型）：' +
          (e instanceof Error ? e.message : String(e)),
      );
      return () => {};
    }
  }, 'dsh-whale-girl: observe session model');

  /**
   * 解析「当前对话该用哪个模型」：优先观察到的会话模型，其次 agentDefaultModel 的默认值。
   * 对话、语音、余额都走这一个出口，保证三处口径一致。
   */
  const resolveCurrentModel = (): { provider: string; model: string } | undefined => {
    if (observedSessionModel !== undefined) return observedSessionModel;
    try {
      const sel = ctx.agentDefaultModel.currentSelection() as { provider?: string; model?: string } | undefined;
      if (typeof sel?.provider === 'string' && sel.provider !== '' && typeof sel.model === 'string' && sel.model !== '') {
        return { provider: sel.provider, model: sel.model };
      }
    } catch {
      /* 未配置 → undefined */
    }
    return undefined;
  };

  /**
   * 语音设置：`$DSH_HOME/dsh-whale-girl/voice.json`（可选，不存在就用默认）。
   *
   * 为什么不塞进 config.jsonc：那份配置有严格的逐字段校验与「整段替换」语义，
   * 语音是主机侧能力（Python 路径、音色），与宠物外观无关；混进去会让
   * 「配置非法 → 宠物不显示」这类问题牵连语音。
   *
   * 字段全部可选：
   *   { "voice": "zh-CN-XiaoyiNeural", "rate": "+0%", "pythonPath": "C:\\...\\python.exe", "language": "zh" }
   *
   * 每次都重新读（文件很小），改完刷新页面即生效，不必重启。
   */
  const readVoiceConfig = (): {
    voice: string;
    rate: string;
    pythonPath?: string;
    language?: string;
    shortcut?: string;
    micDeviceId?: string;    hideButton?: string;
  } => {
    const fallback = { voice: DEFAULT_VOICE, rate: DEFAULT_RATE } as {
      voice: string;
      rate: string;
      pythonPath?: string;
      language?: string;
      shortcut?: string;
      micDeviceId?: string;      hideButton?: string;
    };
    try {
      const raw = readFileSync(join(userRoot, 'voice.json'), 'utf8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const voice = typeof parsed.voice === 'string' && parsed.voice.trim() !== '' ? parsed.voice.trim() : fallback.voice;
      const rate = typeof parsed.rate === 'string' && parsed.rate.trim() !== '' ? parsed.rate.trim() : fallback.rate;
      const pythonPath = typeof parsed.pythonPath === 'string' && parsed.pythonPath.trim() !== '' ? parsed.pythonPath.trim() : undefined;
      const language = typeof parsed.language === 'string' && parsed.language.trim() !== '' ? parsed.language.trim() : undefined;
      const shortcut = typeof parsed.shortcut === 'string' && parsed.shortcut.trim() !== '' ? parsed.shortcut.trim() : undefined;
      const micDeviceId =
        typeof parsed.micDeviceId === 'string' && parsed.micDeviceId.trim() !== '' ? parsed.micDeviceId.trim() : undefined;
      const hideButton = typeof parsed.hideButton === 'string' && parsed.hideButton.trim() !== '' ? parsed.hideButton.trim() : undefined;
      return { voice, rate, pythonPath, language, shortcut, micDeviceId, hideButton };
    } catch {
      // 文件不存在 / 不是合法 JSON：静默回落默认值（语音是可选能力，不该因配置手滑让插件报错）
      return fallback;
    }
  };

  // ── 全局语音热键（按住说话）──────────────────────────────────────────────
  //
  // 页面里的 keydown 只在 DSH 有焦点时才会触发（切到游戏/记事本/桌面就收不到）。
  // 宿主另起一个不依赖焦点的轮询进程，把「按下 / 松开」通过 SSE 推给页面；
  // 页面侧状态机与按钮、快捷键共用同一套（见 src/client/voice-client.ts）。
  //
  // 为什么推给页面而不是宿主直接录音：麦克风在页面里（getUserMedia 需要浏览器权限），
  // 宿主只负责「什么时候该按 / 该松」。
  const voiceHotkeyHub = createHotkeyHub();
  let voiceHotkeyWatcher: HotkeyWatcher | undefined;
  let voiceHotkeyDisplay = DEFAULT_VOICE_SHORTCUT;
  let voiceHotkeyError: string | undefined;
  /** 热键链路的诊断快照（/voice/hotkey 与 SSE 的 ready 帧都用它） */
  const voiceHotkeyStatus = (): Record<string, unknown> => ({
    ok: voiceHotkeyError === undefined && voiceHotkeyWatcher?.running() === true,
    shortcut: voiceHotkeyDisplay,
    platform: process.platform,
    watcher: voiceHotkeyWatcher?.running() === true ? 'running' : 'stopped',
    clients: voiceHotkeyHub.clients(),
    ...(voiceHotkeyError === undefined ? {} : { message: voiceHotkeyError }),
  });
  /** 按当前 voice.json 的 shortcut 重建监听（插件启动、保存语音设置时都走这里） */
  const restartVoiceHotkey = (): void => {
    voiceHotkeyWatcher?.stop();
    voiceHotkeyWatcher = undefined;
    voiceHotkeyError = undefined;
    const shortcut = readVoiceConfig().shortcut ?? DEFAULT_VOICE_SHORTCUT;
    voiceHotkeyDisplay = shortcut;
    const parsed = parseHotkey(shortcut);
    if (!parsed.ok) {
      voiceHotkeyError = parsed.message;
      console.warn('[dsh-whale-girl] 全局语音热键不可用：' + parsed.message);
      return;
    }
    voiceHotkeyDisplay = parsed.display;
    voiceHotkeyWatcher = startHotkeyWatcher(parsed.spec, (event) => {
      // 没有页面连着时就是空操作，不影响宿主
      voiceHotkeyHub.broadcast(event);
    });
    if (!voiceHotkeyWatcher.running()) {
      voiceHotkeyError = '热键监听没有起来（页面有焦点时快捷键仍可用）';
      console.warn('[dsh-whale-girl] ' + voiceHotkeyError);
    }
  };

  /**
   * 表情包目录链 —— 与动画素材（/thumb）**同一套素材归属语义**：
   *   - `pet/<素材根>-memes/` 存在（种类自带表情包）：**只查它**，池与路由都不回落——
   *     查不到即 404 / 该条目剔除（与 `pet/<素材根>-animation/` 的独占规则逐字一致）；
   *   - 否则：用户目录 `$DSH_HOME/dsh-whale-girl/memes/` 优先，其次包内 `assets/memes/`（逐文件合并，
   *     与「main-animation/<ext> → 包内 assets/<ext>」的主素材链同构）。
   * 池（readMemePool）与路由（/pic/memes）必须走**同一个函数**：池里能选的名字，
   * 路由必须取得到，否则气泡配图会图裂。
   * 素材根一律先过 resolveAsset：它来自 URL 段，Windows 上 %5C 解出的反斜杠不会被
   * rest.split('/') 切开，直接 join 会让 `..\..\x` 逃出用户根读盘（与 /thumb 同一道防线）。
   */
  const memeDirsFor = (assetRoot: string): string[] => {
    const own = resolveAsset(petConfigDir, assetRoot + '-memes');
    if (own !== undefined && existsSync(own)) return [own];
    return [memesUserRoot, PACKAGE_MEMES_DIR];
  };
  // 轮询统一状态（S）：前端 1s 轮询的**唯一**数据源（余额 / 工作状态 / 通知 / 宠物说话）。
  // 所有写入走 state.writeSection / writePet（由它统一更新 counter），见 ./state 的说明。
  const state = new PollStateStore();
  // 工作状态联动快照（/work-status 端点响应，浏览器 1s 轮询）：state=当前活动状态（null=空闲）、
  // task=当前任务详情、ts=最近变化时间（轮询侧检测变化用）。气泡文案不在此：浏览器读配置
  // events.workStatusTexts（host 不内置文案）。
  // 聚合与展示选择都在 WorkStatusStore（host/work-status.ts，纯逻辑可单测）：**state 与 task 都按
  // 会话存**——task 曾是全局单值，写过一次就跟着此后所有会话活动一直显示（issue #59）。
  // 进程内内存态：重启回空闲；每次会话事件有实际状态变化才更新（签名比对防刷屏）。
  const workStatus = new WorkStatusStore();
  // 工作状态快照 → 写进 S（前端 1s 轮询 /state 后按 counter 变化渲染）。
  // **只在内容真的变了时才写**：每次写都会推进 counter，前端据此重播档位动画——
  // 会话事件很密（每个 tool/call 都来），无条件写会把动画刷成幻灯片。
  // 判据用**内容**（state + task）而不是 store 的 ts：ts 是 Date.now()（毫秒分辨率），
  // 同一毫秒内连改两次会被误判成"没变化"而漏写（测试里连发事件就会踩到）。
  // data 里不再带 ts：「变了没有」已由叶子 counter 承担，少一个会漂移的第二信号。
  let publishedWork = '\u0000';
  const publishWorkStatus = (): void => {
    const snap = workStatus.snapshot();
    const key = String(snap.state) + '\u0000' + String(snap.task);
    if (key === publishedWork) return;
    publishedWork = key;
    state.writeSection('workStatus', { state: snap.state, task: snap.task });
  };
  // 系统通知帧：host 监听 DSH 宿主事件生成通知帧（帧契约与 shared/notify.ts 一致），写进 S 的
  // sections.notify，浏览器 1s 轮询 /state 后弹 toast。
  // 背景：DSH 0.1.5 删除浏览器侧 api.events.mux/host 事件流，改为 host 转发通道——
  // 不依赖 DSH 版本间变化的事件 API。
  // **单槽**（后到覆盖先到）：同一秒来多条只弹最后一条。这是有意的取舍——1 秒内连弹多个系统通知
  // 本身没有意义（反而更烦），所以不再带 seq / 增量帧队列（改造前的 frames 数组机制已删）。
  const pushNotifyFrame = (frame: HostNotifyFrame): void => {
    state.writeSection('notify', frame);
  }; /** 每会话 turn 级标志（goal 续跑轮判定；不参与展示，仅修正 turn/end 终局语义） */
  const turnFlags = new Map<string, WorkStatusTurnContext>();
  /** 终态（success/error）展示窗口定时器：约 60s 后清掉该会话条目，陈旧完成态不再浮上来（Bug 2/3） */
  const terminalTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const TERMINAL_KEEP_MS = 60 * 1000;
  /** 取消某会话待执行的终态清理：会话已回到非终态，那次清理到点后既不清理也不重排，留着只会误导 */
  const cancelTerminalCleanup = (sessionId: string): void => {
    const t = terminalTimers.get(sessionId);
    if (t === undefined) return;
    clearTimeout(t);
    terminalTimers.delete(sessionId);
  };
  /** 排一个终态清理定时器（每会话一个，已排则跳过） */
  const scheduleTerminalCleanup = (sessionId: string): void => {
    if (terminalTimers.has(sessionId)) return;
    const t = setTimeout(() => {
      terminalTimers.delete(sessionId);
      const sessionState = workStatus.stateOf(sessionId);
      if (sessionState === 'success' || sessionState === 'error') {
        workStatus.clear(sessionId); // 条目连同它的任务详情文案一起消失，不残留到后续活动
        turnFlags.delete(sessionId);
        publishWorkStatus(); // 清完要写 S：否则前端一直挂着那条陈旧完成态
      }
    }, TERMINAL_KEEP_MS);
    terminalTimers.set(sessionId, t);
  };
  // 通知活动门（issue #114）：「对话完成」不立刻弹，先挂起，到点确认这条会话确实没活了再弹
  // （在跑的下属子代理 / 团队成员、后台任务、活跃提醒任一非空 → 丢弃这一帧）。
  //
  // 为什么必须延迟而不是同步查：`workspace/session-activity` 的 turn 族读的是**活 Agent 的
  // status**，而 turn/end 是在回合体的 finally 里追加的——同步那一刻它自己还是 running，判据必然
  // 非空，照「任一非空就不弹」写会把每一条通知都吞掉（详见 notify-events.ts 的 hasBlockingActivity）。
  // 延迟同时让「成员刚变 idle、Lead 下一秒 send_message 又把它唤醒」的窗口过去（队友邮箱是入队后
  // 立刻投递、空闲目标会起一轮）。
  //
  // 判据不可用（宿主没组合 workspace、standalone 伪 ctx 没有 waterfall、调用抛错、返回值形状不对）
  // → 一律放行：宁可多弹一条，也不能让通知被一次宿主变更整体打哑。
  const NOTIFY_ACTIVITY_DELAY_MS = 1500;
  /** 每会话一个待查定时器（同会话连续收尾只保留最后一次：后到覆盖先到，与单槽帧同语义） */
  const notifyActivityTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** waterfall 只用到签名本身：DSH 未导出该事件的请求/响应类型，这里宽松声明（与 ctx 同为 any 的现状一致） */
  type Waterfall = (name: string, request: unknown, next: () => Promise<unknown[]>) => Promise<unknown>;
  /** 这条会话是否还有在跑的活；判据不可用一律 false＝放行 */
  const sessionHasRunningWork = async (sessionId: string): Promise<boolean> => {
    const waterfall = (ctx as { waterfall?: Waterfall }).waterfall;
    if (typeof waterfall !== 'function') return false;
    try {
      const activity = await waterfall.call(ctx, 'workspace/session-activity', { sessionId }, () =>
        Promise.resolve([]),
      );
      return hasBlockingActivity(activity);
    } catch {
      return false; // 查询失败不阻塞通知（与「判据不可用时放行」同一策略）
    }
  };
  /** 排一个活动门定时器：到点确认空闲才推这一帧 */
  const scheduleCompletionNotify = (sessionId: string, event: unknown): void => {
    const prev = notifyActivityTimers.get(sessionId);
    if (prev !== undefined) clearTimeout(prev);
    notifyActivityTimers.set(
      sessionId,
      setTimeout(() => {
        notifyActivityTimers.delete(sessionId);
        void (async () => {
          if (await sessionHasRunningWork(sessionId)) return; // 还有活：等真正的收尾轮再弹
          const frame = reduceNotifyFrame(event as Parameters<typeof reduceNotifyFrame>[0]);
          if (frame) pushNotifyFrame(frame);
        })();
      }, NOTIFY_ACTIVITY_DELAY_MS),
    );
  };
  // 命令「当前桌宠」（/pet 选择、/chat 使用）：全局单值不分会话；进程内内存，重启回默认第一只
  let activePetId = '';
  // 碎碎念周期调度的「上次生成时刻」（按宠物）：调度拍据此判断到没到点。
  // 改造前这份节流靠 whisperCache（缓存 + ts 比较），现在"该不该生成"由调度侧决定、
  // "生成结果"直接写 S——多端共享同一句由 S 天然保证，不再需要第二份缓存。
  const lastWhisperAt = new Map<string, number>();

  // 对话记忆文件（唯一读写方 = 本进程；浏览器/桌面两端都只是客户端 → 同一实例天然共享同一份记忆）。
  // 结构双层：{ <种类桶 assetRoot ?? petId>: { <实例 id>: { messages: ChatMemoryMessage[] } } }
  const memoryPath = join(userRoot, 'memory.json');
  /**
   * 人设覆盖文件：主人自己写的人设放这里，优先于 config 的 whisperPrompt。
   * 为什么不直接改 main-config.jsonc：那份是结构化配置（有校验与整段替换语义），
   * 人设是长文本，单独一份文件更不容易被配置保存冲掉。
   */
  const personaPath = join(userRoot, 'persona.json');
  /**
   * 对话记录（与 memory.json **分开**）：主人随时翻阅用的完整来往，
   * 含被拆出去的动作/神态；**不参与模型上下文**。
   * 格式：{ entries: [{ ts, petId, user, speech, action, raw }] }
   */
  const chatLogPath = join(userRoot, 'chatlog.json');
  type ChatLogEntry = {
    ts: number;
    petId: string;
    user: string;
    speech: string;
    action: string;
    raw: string;
  };
  const CHAT_LOG_CAP = 2000;
  // 对话写操作串行队列：read-modify-write 排队执行，防两端同时对话时交错写盘
  let chatQueue: Promise<void> = Promise.resolve();

  /** 读记忆文件：不存在 → 空；损坏 → 显式报错 + 备份原始文件（绝不静默丢数据）+ 重建空记忆 */
  const readMemory = async (): Promise<Record<string, Record<string, { messages: ChatMemoryMessage[] }>>> => {
    let raw: string;
    try {
      raw = await readFile(memoryPath, 'utf8');
    } catch {
      return {}; // 文件不存在 = 尚无记忆
    }
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
      return parsed as Record<string, Record<string, { messages: ChatMemoryMessage[] }>>;
    } catch (e) {
      console.error(
        `dsh-whale-girl: 记忆文件损坏已备份（对话将从头开始）：${memoryPath}（${e instanceof Error ? e.message : String(e)}）`,
      );
      try {
        await mkdir(userRoot, { recursive: true });
        await writeFile(`${memoryPath}.bak-${Date.now()}`, raw, 'utf8');
      } catch {
        /* 备份失败仅告警，不阻断 */
      }
      return {};
    }
  };

  const writeMemory = async (mem: Record<string, Record<string, { messages: ChatMemoryMessage[] }>>): Promise<void> => {
    await mkdir(userRoot, { recursive: true });
    await writeFile(memoryPath, JSON.stringify(mem, null, 2), 'utf8');
  };

  // ── 对话记录（chatlog.json）：只给主人翻阅，不进模型上下文 ──

  const readChatLog = async (): Promise<ChatLogEntry[]> => {
    try {
      const parsed = JSON.parse(await readFile(chatLogPath, 'utf8')) as { entries?: unknown };
      if (!Array.isArray(parsed.entries)) return [];
      return parsed.entries.filter(
        (entry): entry is ChatLogEntry =>
          entry !== null &&
          typeof entry === 'object' &&
          typeof (entry as ChatLogEntry).ts === 'number' &&
          typeof (entry as ChatLogEntry).speech === 'string',
      );
    } catch {
      return [];
    }
  };

  const writeChatLog = async (entries: ChatLogEntry[]): Promise<void> => {
    await mkdir(userRoot, { recursive: true });
    await writeFile(chatLogPath, JSON.stringify({ entries }, null, 2), 'utf8');
  };

  const appendChatLog = async (petId: string, user: string, formatted: ChatFormat, raw: string): Promise<void> => {
    const entries = await readChatLog();
    entries.push({ ts: Date.now(), petId, user, speech: formatted.speech, action: formatted.action, raw });
    await writeChatLog(entries.length > CHAT_LOG_CAP ? entries.slice(-CHAT_LOG_CAP) : entries);
  };

  /**
   * 第一次打开「对话记录」时，用现有记忆播种（把导入的手机记录也变成可翻阅的记录）。
   * 只在 chatlog.json **不存在**时做一次；之后新对话自己追加。
   */
  const seedChatLogFromMemory = async (petId: string): Promise<void> => {
    try {
      await readFile(chatLogPath, 'utf8');
      return; // 已存在（哪怕是空的）→ 不再播种
    } catch {
      /* 确实没有 → 播种 */
    }
    try {
      const mem = await readMemory();
      const cfg = readAllConfig(configPaths);
      const entryKey = findPetInstance(cfg, petId)?.entry ?? 'main';
      const messages = mem[entryKey]?.[petId]?.messages ?? [];
      const entries: ChatLogEntry[] = [];
      let pendingUser = '';
      for (const message of messages) {
        if (message.role === 'user') {
          pendingUser = message.content;
          continue;
        }
        const formatted = splitChatReply(message.content);
        entries.push({
          ts: message.ts,
          petId,
          user: pendingUser,
          // 旧的导入记录里动作和台词是混在一起的：记录模块要保留**原文**，
          // 不然「带动作的版本」就丢了（新对话才拆成 speech/action）。
          speech: message.content,
          action: formatted.action,
          raw: message.content,
        });
        pendingUser = '';
      }
      await writeChatLog(entries.slice(-CHAT_LOG_CAP));
    } catch (e) {
      console.warn('[dsh-whale-girl] 对话记录播种失败：' + (e instanceof Error ? e.message : String(e)));
    }
  };


  /** 把一次读写封进串行队列（同进程内防交错），返回 fn 的结果 */
  const withMemoryLock = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chatQueue.then(fn, fn);
    chatQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  // ---- 配置消费：唯一入口 readAllConfig（./config）——返回值绝对正确，这里只读字段，零校验 ----

  /** 某宠物的最终人设 system：所属条目（非文件宠物 → main 条目）的 whisperPrompt（合并器已填默认）
   *  + 无条件追加一句名字声明（name，缺失已按 id）——碎碎念与对话共用同一拼装。
   *  + 末尾追加一行**时间背景**（time-context.ts：日期/星期/时刻/时段/工作日或周末）：
   *    碎碎念与对话各自每次生成都会重新走这里，所以拿到的永远是**当前**时刻，不需要额外的刷新机制；
   *    非法 Date 时它为空串，此时整行不加（宁可没有时间信息，也不把 NaN 拼进提示词）。 */
  /**
   * 人设覆盖（persona.json 的 main 字段）。
   * 文件不存在/坏了/为空 → undefined（回落到 config 的 whisperPrompt，行为与旧版一致）。
   */
  const readPersonaOverride = (): string | undefined => {
    try {
      const raw = JSON.parse(readFileSync(personaPath, 'utf8')) as { main?: unknown };
      return typeof raw.main === 'string' && raw.main.trim() !== '' ? raw.main.trim() : undefined;
    } catch {
      return undefined;
    }
  };

  const petSystemPrompt = (petId: string, cfg: Record<string, Record<string, unknown>>): string => {
    const found = findPetInstance(cfg, petId);
    const conf = found ? found.conf : (cfg.main ?? {});
    // main 条目可以用 persona.json 覆盖；文件宠物有自己的 whisperPrompt 时仍以它为准。
    const override = (found ? found.entry : 'main') === 'main' ? readPersonaOverride() : undefined;
    const prompt = override ?? (typeof conf.whisperPrompt === 'string' ? conf.whisperPrompt : '');
    const name = found ? String(found.pet.name || found.pet.id || petId) : petId;
    const nameLine = '你的名字是“' + name + '”。';
    const base = prompt ? prompt + '\n' + nameLine : nameLine;
    const time = timeContextOf(new Date());
    return time ? base + '\n' + time : base;
  };

  /** 对话专用人设：碎碎念的底座 + 聊天规则（早先对话复用「20 字以内」的碎碎念人设，导致又短又呆） */
  const chatSystemPrompt = (petId: string, cfg: Record<string, Record<string, unknown>>): string =>
    petSystemPrompt(petId, cfg) +
    '\n\n【聊天规则】\n' +
    '- 这次是在聊天，不是在碎碎念，也不是在汇报屏幕：一次自然地说 2~5 句，句长有变化。\n' +
    '- **只写你说的话**：不要动作、神态、表情、心理描写，不要括号旁白（`（…）`），不要 `*…*`。\n' +
    '  主人要的是纯聊天；带动作的版本由你另起一行用「【动作】…」记，那部分不会显示/朗读，只进对话记录。\n' +
    '- 可以反问、吐槽、撒娇、讲自己的看法；不要只给结论，不要每句都用同样的开头或语气词。\n' +
    '- 不要复述主人刚说的话；记忆里有前文就接着聊（提到之前的事、主人的心情或约定），别像第一次见面。\n' +
    '- 上面「20 字以内」只适用于碎碎念，聊天时不适用。\n' +
    '- 不要提「作为 AI / 模型」，不要解释你在做什么。';

  /** 对话记忆轮数（1 轮 = 1 问 1 答）：所属条目/主条目的 chatMemoryRounds（合并器已填默认非负数字） */
  const memoryRounds = (petId: string, cfg: Record<string, Record<string, unknown>>): number => {
    const found = findPetInstance(cfg, petId);
    const v = Number(found?.conf.chatMemoryRounds ?? cfg.main?.chatMemoryRounds);
    return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 5;
  };

  /** 生成/返回某宠物的一句碎碎念（周期 GET 与菜单手动触发共用的同一逻辑）：
   *  每只宠物独立生成（所属条目的人设）。生成成功就写进 S 的 pets.<id>.say——
   *  碎碎念 / 命令气泡 / 对话回复在前端本来就是**同一条展示链路**（同一个 triggerWhisper、
   *  同一个气泡槽、同一批 events.whisper 动画），所以合并成同一个叶子；"周期内不重复"由
   *  调度侧的 lastWhisperAt 保证，不再需要一份 whisperCache（多端共享也由 S 天然保证）。
   *  配图（whisperImageEnabled 开启时）：从表情包池**随机抽 1 张**，把描述注入指令并随文本一起写。 */
  const publishWhisper = async (petId: string): Promise<boolean> => {
    const cfg = readAllConfig(configPaths);
    const found = findPetInstance(cfg, petId);
    const conf = found ? found.conf : (cfg.main ?? {});
    const entry = found ? found.entry : 'main';
    const system = petSystemPrompt(petId, cfg);
    // 配图：全局开关关闭 / 池为空 / 池内图片全缺失 → 纯文本（不报错，退化为原行为）
    const meme = conf.whisperImageEnabled === true ? pickMeme(readMemePool(conf.memes, memeDirsFor(entry))) : undefined;
    // 模型：条目配置的 whisperModel 优先（留空 = 不指定）；生成侧失败会回落到当前对话的模型重试一次
    const result = await generateWhisper(ctx, system, meme, configuredModel(conf, 'whisperModel'));
    if (!result.ok) {
      // 失败**不写 S**（与改造前一致：静默跳过 + console.warn，不伪造文案、不弹错误气泡）
      console.warn(
        '[dsh-whale-girl] 碎碎念生成失败 pet=' +
          petId +
          ' reason=' +
          result.reason +
          (result.message ? ' ' + result.message : ''),
      );
      return false;
    }
    state.writePet(petId, 'say', result.image ? { text: result.text, image: result.image } : { text: result.text });
    return true;
  };

  /** 与某只宠物对话：截取最近记忆 → 生成回复 → 写入记忆 → 把回复写进 S 的 pets.<id>.say。
   *  供 POST /chat（动作端点）与 /chat 命令共用同一条路径（锁内读写，防两端交错写盘）。
   *  配图（chatImageEnabled 开启时）：把表情包清单交给模型按语境选一张，命中池内才随回复写回。 */
  const chatWithPet = async (
    petId: string,
    text: string,
    override?: { provider: string; model: string },
    /**
     * 要不要让**渲染端**把回复念出来（写进 `say` 的 `speak` 标记）。
     *
     * - 文字对话（右键「对话」）传 true：那里没有别的播放途径，靠渲染端出声。
     * - 语音对话传 **false**：`/voice/turn` 的调用方（浏览器页）自己会合成播放，
     *   再让桌面窗播一次就成了**同一句话播两遍**（主人实测踩到）。
     */
    speakReply = true,
    /**
     * 语音对话里的主动识屏结果（多帧 + 说明）。
     * 有它就带图回答，没有就是纯文本——同一条生成链路，不另开分支。
     */
    preSight?: { note: string; images: Uint8Array[] },
    /** 输出通道：voice = 这段话会被 TTS 念出来（更口语、更短） */
    style: 'text' | 'voice' = 'text',
  ): Promise<
    | { ok: true; text: string; image?: string; fellBackTo?: string }
    | { ok: false; reason: 'provider-missing' | 'generate-error'; message?: string }
  > =>
    withMemoryLock(async () => {
      const cfg = readAllConfig(configPaths);
      const rounds = memoryRounds(petId, cfg);
      const found = findPetInstance(cfg, petId);
      const conf = (found ?? { conf: cfg.main ?? {} }).conf;
      // 人设：所属条目的 whisperPrompt（合并器已填默认）+ 名字声明 + **聊天专用规则**。
      // 早先对话直接复用碎碎念人设（「短短一句 20 字以内」），所以聊天又短又呆——
      // 碎碎念可以短，对话应该像正常人聊几句。
      const baseSystem =
        style === 'voice'
          ? chatSystemPrompt(petId, cfg) +
            '\n\n【语音回复】这段话会被念出来：用口语，2~4 句，不要列清单、不要 Markdown/表情符号；说完就停，别拖太长。'
          : chatSystemPrompt(petId, cfg);
      // 配图：开关关闭 → 空池（指令与解析都不介入，与旧行为逐字一致）；目录链按所属条目取。
      // 张数上限（chatImageLimit，0 = 不限制）：整张清单每条消息都要附，截断后费用上限可控。
      const pool =
        conf.chatImageEnabled === true
          ? limitPool(readMemePool(conf.memes, memeDirsFor(found?.entry ?? 'main')), Number(conf.chatImageLimit))
          : [];
      const mem = await readMemory();
      const bucketKey = found?.entry ?? petId;
      const bucket = (mem[bucketKey] ??= {});
      const entry = (bucket[petId] ??= { messages: [] });
      // rounds = 0（用户关掉历史）→ 空历史；否则截尾部 rounds 轮（1 轮 = 1 问 1 答）。
      // 不能写 slice(-rounds * 2)：-0 在 JS 里 === 0，slice(-0) 返回整个数组而不是空。
      const list = sliceMemoryRounds(entry.messages, rounds);
      // 更早的相关记忆：上下文只带最近 N 轮，导入的几百条旧记录默认进不了视野。
      // 按关键词挑几条最相关的补进 system（不提「记忆」这种元信息，避免模型开始总结）。
      const recalled = selectRelevantMemory(entry.messages, text, { excludeLast: list.length, limit: 6 });
      const memoryBlock =
        recalled.length === 0
          ? ''
          : '\n\n【更早的相关记忆（可能不连续；用来接上主人提到的话题，别逐字复述）】\n' +
            recalled
              .map((message) => (message.role === 'user' ? '主人：' : '你：') + message.content.slice(0, 300))
              .join('\n');
      const system = baseSystem + memoryBlock;
      // 模型：条目配置的 chatModel 优先（留空 = 不指定）；生成侧失败会回落到当前对话的模型重试一次。
      // override 仅供语音链路在「当前模型被限流」时显式换一家（见 /voice/turn），
      // 常规对话（/chat、右键弹窗）永远不传，行为与上游逐字一致。
      const preferred = override ?? configuredModel(conf, 'chatModel') ?? resolveCurrentModel();

      /**
       * 语音对话主动识屏：把抓到的多帧交给模型。
       *
       * 图片必须先过附件存储（DSH 的图片消息只认 ref），所以这里存一次、
       * 用完立刻删（与识屏同一条口径：落地即焚）。
       * 存不进去就**降级成纯文本**——看一眼失败不该让整轮对话失败。
       */
      let pictures:
        | ReadonlyArray<{ attachmentId: string; mediaType: string; bytes: number; width: number; height: number }>
        | undefined;
      let userTextWithNote = text;
      if (preSight !== undefined) {
        const attachments = getAttachments();
        if (attachments !== undefined) {
          try {
            const refs = await attachments.saveImages(
              preSight.images.map((data, i) => ({ data, mediaType: 'image/jpeg', name: 'voice-' + (i + 1) + '.jpg' })),
            );
            pictures = refs as unknown as typeof pictures;
            // 说明放正文最前面：告诉她这是连续帧、能对比变化
            userTextWithNote = preSight.note + '\n' + text;
            // 落地即焚
            void purgeAttachmentObjects(ctx, refs);
          } catch (e) {
            console.warn('[dsh-whale-girl] 语音识屏附图失败，按纯文本继续：' + (e instanceof Error ? e.message : String(e)));
          }
        }
      }

      let generated = await generateChat(ctx, system, list, userTextWithNote, pool, preferred, pictures);

      /**
       * 限流回落（文字与语音共用这一处）。
       *
       * 为什么必须在这里兜：插件刚启动时还没旁听到任何 `agent/request`，
       * `resolveCurrentModel()` 只能退回 `agentDefaultModel` 的**默认值**——
       * 而那个默认值可能早就不是主人在用的模型（实测就是 workbuddy-ai 额度用尽）。
       * 结果是「重启后第一次对话必定失败一次」，体验很差。
       *
       * 只对**明确的限流**回落：其它失败（缺凭证 / 模型不存在 / 网络）换一家只会掩盖问题。
       */
      let usedFallback: { provider: string; model: string } | undefined;
      if (!generated.ok && /429|soft_rate|rate.?limit|频率/i.test(generated.message ?? '')) {
        /**
         * 先**用同一个主候选重试一次**，再考虑换服务商。
         *
         * 原因：`generateChat` 内部本身有一条候选链（传入的 preferred → 当前默认模型）。
         * 主候选（会话实际模型）偶发失败时，它会自动回落到**默认模型**，而那个默认值
         * 可能正是已限流的 workbuddy-ai —— 于是最终报出来的 429 其实来自**兜底候选**，
         * 跟主候选无关。主人看到「限流」就以为模型识别又坏了。
         * 先重试主候选一次，能挡掉这类误报。
         */
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
        const retry = await generateChat(ctx, system, list, text, pool, preferred);
        if (retry.ok) {
          generated = retry;
        } else {
          const currentProvider = (preferred ?? resolveCurrentModel())?.provider ?? '';
          const alt = await pickFallbackModel(currentProvider);
          if (alt !== undefined) {
            const second = await generateChat(ctx, system, list, text, pool, alt);
            if (second.ok) {
              generated = second;
              usedFallback = alt;
              // 学到的东西要留住：下次本进程内直接用这个能跑的（并落盘，重启后仍然记得）
              persistObservedModel(alt);
              console.warn(`[dsh-whale-girl] 当前模型限流，已改用 ${alt.provider}/${alt.model} 重试成功`);
            }
          }
        }
      }
      if (!generated.ok) return generated;
      const now = Date.now();
      // 台词/动作分开：气泡与语音只用台词；带动作的完整版进「对话记录」。
      const formatted = splitChatReply(generated.text);
      entry.messages.push({ role: 'user', content: text, ts: now });
      // 记忆只存**台词**：存动作的话，模型下次会照着模仿，又变回旁白风格
      entry.messages.push({ role: 'assistant', content: formatted.speech, ts: now });
      // 第一次聊天时先用「写之前的记忆」播种对话记录，否则文件会被这一条先创建，
      // 导入的旧记录就永远进不了记录模块（顺序很关键）。
      try {
        await seedChatLogFromMemory(petId);
      } catch {
        /* 播种失败不影响聊天 */
      }
      await writeMemory(mem);
      // 对话记录失败不影响这次回复（主人至少能正常聊天）
      try {
        await appendChatLog(petId, text, formatted, generated.text);
      } catch (e) {
        console.warn('[dsh-whale-girl] 写对话记录失败：' + (e instanceof Error ? e.message : String(e)));
      }
      // 回复写进 S（与碎碎念同一个叶子：前端本来就是同一条展示链路）
      state.writePet(
        petId,
        'say',
        // `speak` 是**给渲染端的口令**：这条回复该不该由桌面窗念出来。
        //  - 文字对话 → true（除此之外没有别的播放途径）
        //  - 语音对话 → false（调用方自己播；再让桌面窗播就是同一句两遍）
        // 碎碎念 / 广播永远没有这个字段，只弹气泡——不然她一整天在自言自语。
        speakReply
          ? generated.image
            ? { text: formatted.speech, image: generated.image, speak: true }
            : { text: formatted.speech, speak: true }
          : generated.image
            ? { text: formatted.speech, image: generated.image }
            : { text: formatted.speech },
      );
      // 文本必须回传：语音链路要拿它去合成，不能靠前端再轮询一次 S
      // （早先这里只回 { ok: true }，导致 /voice/turn 的 reply 恒为空，前端静默结束）
      return {
        ok: true as const,
        text: formatted.speech,
        ...(generated.image ? { image: generated.image } : {}),
        ...(usedFallback === undefined ? {} : { fellBackTo: `${usedFallback.provider}/${usedFallback.model}` }),
      };
    });

  /**
   * 当前生效宠物列表 = readAllConfig 成品拍平（main + 文件宠物全部条目；合并器已保证 id 唯一、
   * 字段填满），命令与桌面模式都从这里取。
   */
  const effectivePetList = (): Record<string, unknown>[] => flattenPetList(readAllConfig(configPaths));

  /** 余额刷新周期（秒）：成品 main 条目的 eventsRefreshSec.balance（合并器已填默认；非法兜底 1800） */
  const balancePeriodSec = (cfg: Record<string, Record<string, unknown>>): number => {
    const ers = cfg.main?.eventsRefreshSec as Record<string, unknown> | undefined;
    const n = Number(ers?.balance);
    return Number.isFinite(n) && n > 0 ? n : 1800;
  };

  /** 碎碎念周期（秒）：该宠物**所属条目**的 eventsRefreshSec.whisper（合并器已填默认；非法兜底 300） */
  const whisperPeriodSec = (cfg: Record<string, Record<string, unknown>>, petId: string): number => {
    const conf = (findPetInstance(cfg, petId) ?? { conf: cfg.main ?? {} }).conf;
    const ers = conf.eventsRefreshSec as Record<string, unknown> | undefined;
    const n = Number(ers?.whisper);
    return Number.isFinite(n) && n > 0 ? n : 300;
  };

  /**
   * 刷新余额并写入 S —— host 侧**唯一**的余额查询点。
   *
   * 改造前是每个客户端各自按自己的定时器去查（浏览器一个 + 桌面每窗口一个）：同一份外部 API
   * 被重复请求、两端还可能看到新旧不一致的数据。现在只有这里查，两端都从 /state 读同一份结果。
   *
   * 失败也写进 S（reason 区分 unsupported / credential-missing / fetch-error）——余额不可用要弹
   * 文字说明气泡，不能静默；意外异常同样落成 fetch-error，不吞。
   *
   * @param manual 这次刷新是不是"用户要的"（/balance 命令、桌面「查看余额」菜单）。
   *   标记随数据一起写进叶子：只有 host 知道是谁要的，前端据此决定余额不可用时要不要**必弹**
   *   文字说明（decideBalanceNotice 的 explicit；周期刷新则只在原因变化时弹一次，免得反复刷屏）。
   */
  /**
   * 账号服务要求的调用方身份（`AccountClientMetadata`）：Platform 用它派生五个客户端头，
   * 只影响**请求来源标识**与**服务端本地化文案**，不参与余额数值与币种。
   *
   * - version：本插件版本（读自身 package.json；读不到回落 '0.0.0'——该字段只是标识）
   * - locale：本插件是中文产品，固定 `zh-CN`（Platform 侧归一到 zh_CN）
   * - timezoneOffsetSeconds：本机 UTC 偏移（东八区为 +28800）
   */
  const accountClientMetadata = (): { version: string; locale: string; timezoneOffsetSeconds: number } => {
    let version = '0.0.0';
    try {
      const raw = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as { version?: unknown };
      if (typeof raw.version === 'string' && raw.version.length > 0) version = raw.version;
    } catch {
      // 读不到不影响查询：version 只是平台侧的来源标识
    }
    return { version, locale: 'zh-CN', timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60 };
  };

  const refreshBalance = async (manual = false): Promise<void> => {
    const mark = <T>(v: T): T | (T & { manual: true }) => (manual ? { ...v, manual: true } : v);
    try {
      const sel = resolveCurrentModel() ?? { provider: '', model: '' };
      const resolveKey = async (ref: string): Promise<string | undefined> => {
        const rc = await ctx.credentials.resolve(credentialRef(ref));
        return rc?.value;
      };
      // `deepseek-account`（免费额度 / 平台登录）没有 API Key：它的凭证是 DSH 账号服务
      // 持有的授权记录，只能经 getBalance 查询。账号服务是**可选**服务（软取，不放进
      // inject）——没装账号插件时它不在场，此时该路由报 credential-missing 而不是崩。
      const resolveAccount = async (): Promise<AccountBalanceSnapshot | null | undefined> => {
        const account = ctx.get('deepseekAccount', false);
        if (!account) return undefined;
        return (await account.getBalance(accountClientMetadata())) as AccountBalanceSnapshot | null | undefined;
      };

      let result = await queryBalance(sel.provider, resolveKey, resolveAccount);

      // 当前服务商没有余额接口（第三方中继常见，如 workbuddy-ai）时**回落到有接口的**
      // 并标明这是谁的账，而不是只丢一句「不支持」。顺序取自「主人真正在看的那笔账」：
      // DSH 账号（deepseek-account）→ DeepSeek 官方 API Key。
      //
      // 只在 `unsupported` 时回落：缺凭证 / 抓取失败是**真实故障**，
      // 悄悄换一家显示会掩盖问题（那正是「不要让检查变绿而改错地方」的反面）。
      if (!result.ok && result.reason === 'unsupported') {
        for (const candidate of ['deepseek-account', 'deepseek-official'] as const) {
          const attempt = await queryBalance(candidate, resolveKey, resolveAccount);
          if (!attempt.ok) continue;
          const data = attempt.data as unknown as Record<string, unknown>;
          result = { ...attempt, data: { ...data, fallbackFrom: sel.provider } } as unknown as typeof result;
          break;
        }
      }

      state.writeSection('balance', mark(result));
    } catch (e) {
      state.writeSection(
        'balance',
        mark({
          ok: false,
          provider: 'unknown',
          reason: 'fetch-error',
          message: e instanceof Error ? e.message : String(e),
        }),
      );
    }
  };

  /**
   * 限流回落时挑一个替代模型。
   *
   * 只在语音链路用（见 /voice/turn）：主人正对着麦克风说话，静默失败最伤，
   * 而 429 是**服务商额度**问题，换一家通常立刻可用。
   *
   * 选择顺序：DSH 账号（deepseek-account）→ DeepSeek 官方 → 其余任意有模型的服务商；
   * 同服务商内优先名字带 flash 的（便宜、快，适合闲聊）；当前服务商永远跳过。
   */
  const pickFallbackModel = async (currentProvider: string): Promise<{ provider: string; model: string } | undefined> => {
    const llm = ctx.llm as
      | { listProviders?: () => Array<{ id: string }>; listModels?: (p: string) => Promise<Array<{ id: string }>> }
      | undefined;
    if (!llm?.listProviders || !llm.listModels) return undefined;
    try {
      const providers = llm.listProviders();
      const rank = (id: string): number => {
        const order = ['deepseek-account', 'deepseek-official'];
        const i = order.indexOf(id);
        return i < 0 ? order.length : i;
      };
      const ordered = [...providers].sort((a, b) => rank(a.id) - rank(b.id));
      for (const provider of ordered) {
        if (provider.id === currentProvider) continue;
        try {
          const models = await llm.listModels(provider.id);
          if (models.length === 0) continue;
          const hit = models.find((m) => /flash/i.test(m.id)) ?? models[0];
          return { provider: provider.id, model: hit.id };
        } catch {
          // 该服务商没配凭证 / 不可用 → 试下一个
        }
      }
    } catch {
      /* 枚举失败就不回落，让原错误照常上报 */
    }
    return undefined;
  };

  /** 当前交互桌宠 id：/pet 已选且仍存在 → 该宠物；未选/已失效 → 有效宠物列表第一只（进程内，重启回默认） */
  const resolveActivePetId = (): string => {
    try {
      const eff = effectivePetList();
      if (eff.length === 0) return '';
      if (activePetId && eff.some((p) => String(p.id) === activePetId)) return activePetId;
      return String(eff[0].id);
    } catch {
      return activePetId;
    }
  };

  /** 宠物的显示名（name，缺失回落 id）——命令文案用 */
  const petDisplayName = (pet: Record<string, unknown>): string => {
    const n = String(pet.name ?? '').trim();
    return n || String(pet.id ?? '');
  };

  let hasDesktopPet = false;
  const refreshDesktop = (): void => {
    hasDesktopPet = false;
    try {
      hasDesktopPet = effectivePetList().some((p) => isDesktopVisible(p.display));
    } catch (e) {
      ctx.logger?.warn?.(`[dsh-whale-girl] 宠物配置非法，桌面模式已跳过：${e instanceof Error ? e.message : String(e)}`);
    }
  };
  refreshDesktop();

  /** 桌面可见宠物列表（[{id,size}]）：透传 Helper 决定创建几个局部窗口（每宠物一个）。 */
  const desktopPetList = (): Array<{ id: string; size: number }> => {
    try {
      return effectivePetList()
        .filter((p) => isDesktopVisible(p.display))
        .map((p) => ({ id: String(p.id), size: Number(p.size) }));
    } catch {
      return [];
    }
  };

  let helper: HelperProcess | undefined;
  let startRetryTimer: NodeJS.Timeout | undefined;
  let electronEnsure: Promise<void> | undefined;
  let disposed = false;
  /** 「无图形环境」提示只在进程生命周期内打一次，避免守护循环刷屏 */
  let displayWarned = false;

  /** 用已确认存在的 Electron 路径拉起桌面 Helper（每只桌面宠物一个局部小窗口）。 */
  const launchHelper = (electronPath: string | undefined): void => {
    if (helper || disposed) return;
    if (!hasDesktopPet) return; // 无宠物显示在桌面（display 含 desktop/both）：不启动
    const port = typeof ctx.webServer?.port === 'number' ? ctx.webServer.port : 0;
    if (!port || port <= 0) {
      // webServer 可能尚未完成监听（OS 分配端口时 port 短暂为 0）：延迟重试。
      if (!startRetryTimer) {
        startRetryTimer = setTimeout(() => {
          startRetryTimer = undefined;
          launchHelper(electronPath);
        }, 500);
        startRetryTimer.unref?.();
      }
      return;
    }
    const origin = `http://127.0.0.1:${port}`;
    // 右键「打开网站」交出去的是裸 origin：DSH 只在 `GET /` 接受本进程的启动令牌，换发绑定 authority 的
    // 签名 Cookie，其余请求一律 401 —— 默认浏览器没有该 authority 的 Cookie 时必然打不开（#87）。
    // 令牌等价登录态：只经子进程环境变量递到 helper 内存，不落盘、不进日志；authority 必须保持
    // 127.0.0.1（与 localhost 算两套 Cookie），故这里传 origin 而不是另拼地址。
    const siteUrl = ctx.connection.authenticatedUrl(origin);
    // 桌面渲染端也从同一份 handlePetRoute 拿成品配置（每只宠物一个局部小窗口；经管道，不走 HTTP——
    // DSH Desktop 2.0.3+ 会拦插件自拉进程的裸 HTTP 请求，浏览器访问闸门只放行带令牌的请求）
    const configUrl = `${origin}${ROUTE_PREFIX}/config`;
    helper = new HelperProcess(
      {
        electronPath,
        env: {
          DSH_WHALE_CONFIG_URL: configUrl,
          // 已鉴权站点 URL（含本进程启动令牌）：只供 helper 的「打开网站」使用，任何日志都不许出现它
          DSH_WHALE_SITE_URL: siteUrl,
          // 宿主形态决定工具项「打开网站」的去向（同名菜单项，两端两种语义）：
          //   desktop = 宿主是 DSH 桌面应用 → 唤起桌面应用主窗口（helper 走 dsh://open，见 main.js）
          //   site    = dsh web / 独立模式 → 系统默认浏览器打开站点（原行为，别破坏）
          DSH_WHALE_OPEN_TARGET: isDesktopHost() ? 'desktop' : 'site',
          DSH_WHALE_SCALE: '1',
          // 打开 bridge 协议：main.js 注册 dsh-whale-girl-bridge scheme，把渲染端请求经管道转给宿主
          DSH_WHALE_BRIDGE: '1',
          // 每只桌面宠物一个局部小窗口：透传宠物列表（[{id,size}]）
          DSH_WHALE_PETS: JSON.stringify(desktopPetList()),
        },
        // bridge 协议处理器 = HTTP 路由同一份 handlePetRoute（业务逻辑唯一，两端天然一致）；
        // 素材过文件路径（main.js 自行读盘），json/text 过 body
        bridgeHandler: async (req) => {
          const result = await handlePetRoute(req.url ?? '/', req.method ?? 'GET', req.body);
          if (result.kind === 'file') {
            // file 分支恒 200（404/400 已由 text 分支表达）
            return { id: req.id, status: 200, contentType: result.contentType, file: result.file };
          }
          if (result.kind === 'text') {
            return { id: req.id, status: result.status, contentType: 'text/plain; charset=utf-8', body: result.body };
          }
          if (result.kind === 'buffer') {
            // bridge 是 JSON 行协议，塞不了二进制：桌面窗的语音必须走 HTTP。
            // 显式报错而不是返回空 body —— 空 body 会让前端以为「合成成功但没声音」。
            return {
              id: req.id,
              status: 501,
              contentType: 'application/json; charset=utf-8',
              body: JSON.stringify({ ok: false, reason: 'bridge-unsupported', message: '二进制响应不能走 bridge，请用 HTTP' }),
            };
          }
          return {
            id: req.id,
            status: result.status,
            contentType: 'application/json; charset=utf-8',
            body: JSON.stringify(result.obj),
          };
        },
      },
      ctx.logger ?? console,
    );
    try {
      helper.start();
      ctx.logger?.info?.(`dsh-whale-girl desktop helper started (config: ${configUrl})`);
    } catch (e) {
      ctx.logger?.warn?.(`dsh-whale-girl desktop helper start failed: ${e instanceof Error ? e.message : String(e)}`);
      helper = undefined;
    }
  };

  /** 拉起桌面 Helper：先探测本机 Electron；缺失时进程内异步下载
   *  （不 spawn 子进程，CLI node 与 DSH Desktop 均适用），下载完成后自动拉起。 */
  const startHelper = (): void => {
    if (helper || electronEnsure || disposed) return;
    if (!hasDesktopPet) return; // 无宠物显示在桌面（display 含 desktop/both）：不启动
    // 无图形显示环境（Linux 服务器 / 容器）：直接放弃，不探测、不下载、不拉起。
    // 否则 Electron 会「拉起即崩」，被守护循环反复重启并刷满 core dump。
    if (!hasGraphicalDisplay()) {
      if (!displayWarned) {
        displayWarned = true;
        ctx.logger?.warn?.(
          '[dsh-whale-girl] 未检测到图形显示环境（DISPLAY/WAYLAND_DISPLAY 均为空），已跳过桌面宠物。' +
            '浏览器内宠物不受影响；如需在服务器上启用桌面模式，请配置 Xvfb 后设置 DSH_WHALE_DESKTOP_FORCE=1。',
        );
      }
      return;
    }
    const found = resolveElectronPath();
    if (found) {
      launchHelper(found);
      return;
    }
    console.warn(`[dsh-whale-girl] Electron not found, downloading to ${defaultElectronExe()} ...`);
    electronEnsure = ensureElectronDownload()
      .then((path) => {
        if (path) {
          launchHelper(path);
        } else {
          console.warn(
            '[dsh-whale-girl] Electron download failed; desktop pet unavailable. Set DSH_WHALE_ELECTRON_PATH and restart, or retry later.',
          );
        }
      })
      .finally(() => {
        electronEnsure = undefined;
      });
  };

  /** 停止桌面 Helper（保留配置，可再次拉起）。宿主退出/插件卸载路径：不等它退干净（见 stopAndWait）。 */
  const stopHelper = (reason = 'settings-change'): void => {
    if (startRetryTimer) {
      clearTimeout(startRetryTimer);
      startRetryTimer = undefined;
    }
    helper?.stop(reason);
    helper = undefined;
  };

  /** 停止并**等旧 helper 真正退出**：配置变更触发的"停旧起新"专用（issue #64）。 */
  const stopHelperAndWait = async (reason: string): Promise<void> => {
    if (startRetryTimer) {
      clearTimeout(startRetryTimer);
      startRetryTimer = undefined;
    }
    const old = helper;
    helper = undefined;
    await old?.stopAndWait(reason);
  };

  /**
   * 宠物配置（display / size 等）变更后：重解析桌面宠物，**等旧 helper 退出**再拉起新的。
   *
   * 为什么要等（issue #64）：Electron 收到 SIGTERM 后关窗是异步的（几百 ms 起），"发完 kill 就 spawn
   * 新进程"会让旧窗口（旧大小）与新窗口（新大小）短暂共存——用户看到的就是"改完大小冒出来第二只宠物"。
   * 为什么要串行：连续保存会触发多次重启，两次重启交错同样会同时拉起两个 helper，所以用队列串起来。
   * 队列自身绝不留下 rejected 状态，否则后续保存再也不会重启 helper。
   */
  let desktopSyncQueue: Promise<void> = Promise.resolve();
  const syncDesktop = (): Promise<void> => {
    desktopSyncQueue = desktopSyncQueue
      .then(async () => {
        refreshDesktop();
        await stopHelperAndWait('desktop-config-change');
        startHelper();
      })
      .catch((e: unknown) => {
        ctx.logger?.warn?.(`[dsh-whale-girl] 重启桌面 Helper 失败：${e instanceof Error ? e.message : String(e)}`);
      });
    return desktopSyncQueue;
  };

  /** 扩展名 → 素材子目录名（webm → webm/，mov → mov/；其余落在动画目录平级放行） */
  const animSubdirFor = (ext: string): string => (ext === '.mov' ? 'mov' : 'webm');

  /** 包内动画素材根：按扩展名取子目录（webm/ 随包发布；mov/ 不存在时为 404 兜底，仅 macOS 自维护）。 */
  const assetRootFor = (ext: string): string => join(PACKAGE_ROOT, 'assets', animSubdirFor(ext));

  /** 用户动画根：按扩展名取子目录（main-animation/webm 或 main-animation/mov）。 */
  const userRootFor = (ext: string): string => join(thumbUserRoot, animSubdirFor(ext));

  /** 单次业务路由(WebServer 注册 → HTTP 落盘 / 桌面 Helper 管道 → scheme 应答,共用同一份实现):
   *  输入只需 rawUrl(/dsh-whale-girl/... + 查询) + method + body 文本;返回 RouteResult(JSON/文本/文件),
   *  消费方各自落盘——业务逻辑只有一份,两端天然一致(硬契约:浏览器/桌面行为严格对齐)。 */
  const handlePetRoute = async (rawUrl: string, method: string, body?: string): Promise<RouteResult> => {
    const url = new URL(rawUrl, 'http://localhost');
    const rest = decodeURIComponent(url.pathname.slice(ROUTE_PREFIX.length + 1));

    // QQ 群聊已迁到独立插件 dsh-qq-group（/dsh-qq-group/*），桌宠不再处理 qq/*。

    // 自检：/dsh-whale-girl/diag（GET）
    //
    // 为什么要有它：排「模型用错」这类问题时，光看现象（429）分不清是
    // 「监听没触发」「拿到的是默认值」还是「上游真的限流」。把插件**看到的**三份数据
    // 并排摆出来，一眼就能定位。只读，不触发任何外部调用。
    if (rest === 'diag') {
      let defaultSelection: unknown;
      try {
        defaultSelection = ctx.agentDefaultModel.currentSelection();
      } catch (e) {
        defaultSelection = { error: e instanceof Error ? e.message : String(e) };
      }
      let speech: unknown;
      try {
        const stt = ctx.get?.('speechToText', false) ?? ctx.speechToText;
        const snap = stt?.snapshot?.();
        speech = snap === undefined ? 'unavailable' : { selection: snap.selection, providers: snap.providers?.map((p: { id: string }) => p.id) };
      } catch (e) {
        speech = { error: e instanceof Error ? e.message : String(e) };
      }
      let modelCatalog: unknown;
      try {
        const llm = ctx.llm as { listProviders?: () => unknown[] } | undefined;
        modelCatalog = llm?.listProviders?.()?.map((p) => (p as { id: string }).id);
      } catch (e) {
        modelCatalog = { error: e instanceof Error ? e.message : String(e) };
      }
      return {
        kind: 'json',
        status: 200,
        obj: {
          ok: true,
          plugin: 'dsh-whale-girl',
          routePrefix: ROUTE_PREFIX,
          // 关键三分：观察到的会话模型 / DSH 默认模型 / 最终解析结果
          observedSessionModel: observedSessionModel ?? null,
          defaultSelection,
          resolvedModel: resolveCurrentModel() ?? null,
          llmProviders: modelCatalog,
          speech,
          voice: readVoiceConfig(),
        },
      };
    }

    // 模型能力诊断：/dsh-whale-girl/diag/model-info?provider=&model=（GET）
    //
    // 为什么要有：代打一轮要 12~27 秒，得先确认「慢」是模型/路由本身，还是我们没传对
    // reasoning 档位。resolveModelInfo 是 DSH 暴露的能力声明（含 efforts / 是否支持图片），
    // 把它原样透出来比猜可靠。只读，不触发模型调用。
    if (rest === 'diag/model-info') {
      if (method !== 'GET') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      const provider = url.searchParams.get('provider') ?? '';
      const model = url.searchParams.get('model') ?? '';
      if (provider === '' || model === '') {
        return { kind: 'json', status: 400, obj: { ok: false, message: '需要 provider 与 model 参数' } };
      }
      const llm = ctx.llm as { resolveModelInfo?: (p: string, m: string) => Promise<unknown> } | undefined;
      if (typeof llm?.resolveModelInfo !== 'function') {
        return { kind: 'json', status: 200, obj: { ok: false, message: 'llm.resolveModelInfo 不可用' } };
      }
      try {
        const info = await llm.resolveModelInfo(provider, model);
        return { kind: 'json', status: 200, obj: { ok: true, provider, model, info } };
      } catch (e) {
        return { kind: 'json', status: 200, obj: { ok: false, message: e instanceof Error ? e.message : String(e) } };
      }
    }

    // 模型链路延迟诊断：/dsh-whale-girl/diag/llm-latency?provider=&model=&effort=（GET）
    // 一条纯文本小请求，量「模型/路由本身」的延迟（跟看图无关）。只读诊断用。
    if (rest === 'diag/llm-latency') {
      if (method !== 'GET') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      const provider = url.searchParams.get('provider') ?? '';
      const model = url.searchParams.get('model') ?? '';
      const effort = url.searchParams.get('effort') ?? undefined;
      if (provider === '' || model === '') {
        return { kind: 'json', status: 400, obj: { ok: false, message: '需要 provider 与 model 参数' } };
      }
      const result = await probeModelLatency({ llm: ctx.llm }, { provider, model }, effort);
      return { kind: 'json', status: 200, obj: { provider, model, effort: effort ?? null, ...result } };
    }

    // 成品配置：/dsh-whale-girl/config（GET 读取合并成品 / PUT 保存用户层 / POST 同步内置默认）
    if (rest === 'config') {
      if (method === 'GET') {
        // 唯一配置入口：readAllConfig 返回绝对正确的完成品聚合（{ main:{...}, test1:{...} }），
        // 浏览器/桌面/设置页直接消费，无需任何校验/兜底
        try {
          // 动态配置必须杀缓存（与 /state 同口径）：消费端会「发现配置版本变化 → 重拉 /config」，
          // 这一次 GET 若命中缓存就会拿回旧配置，那套机制直接失效。
          return {
            kind: 'json',
            status: 200,
            obj: readAllConfig(configPaths),
            headers: { 'cache-control': 'no-cache, no-store' },
          };
        } catch (e) {
          return { kind: 'json', status: 500, obj: { error: e instanceof Error ? e.message : String(e) } };
        }
      }
      if (method === 'PUT') {
        try {
          const parsed = JSON.parse(body ?? '');
          // 透传保留：读当前磁盘上的用户文件原对象，把非白名单顶层字段（physics/whisperPrompt/
          // chatMemoryRounds/...）带回给 saveUserConfig——设置页保存不再抹掉用户手改的精调配置。
          // **必须走 JSONC 容忍解析器**（readUserConfig）：用户层可能是「同步」写入的带 // 注释
          // 的 config.jsonc 原文，用严格 JSON.parse 会在这里抛错并被吞掉 → existing 变 undefined
          // → 白名单重建 → 用户的高级字段全丢（老 bug 的复发路径，已由守卫测试钉住）。
          const existing = readUserConfig(configPaths);
          const clean = saveUserConfig(parsed, existing);
          if (!clean) {
            return {
              kind: 'json',
              status: 400,
              obj: {
                error:
                  'invalid pet config: expected { pets:[{name?,id,size,balanceEnabled,display,position:{corner,marginX,marginY}}] }（display 为 web/desktop/both/none 之一；可选顶层 notificationsEnabled / whisperImageEnabled / chatImageEnabled 布尔；可选宠物布尔 whisperEnabled / workStatusEnabled / fixedEnabled）',
              },
            };
          }
          // 损坏预检：用户层存在但连 JSONC 都解析不了（真损坏）→ **先不写盘**。
          // 保存是白名单重建，existing 读不出来就等于把文件里剩下的内容整份丢掉，而且静默——
          // 所以回 409 让设置页弹窗（取消 = 不动文件；确认 = 带 ?force=1 强行重建）。
          if (url.searchParams.get('force') !== '1' && userConfigUnparsable(configPaths)) {
            return {
              kind: 'json',
              status: 409,
              obj: { error: 'user config is unparsable', needConfirm: true, userFile: userConfigPath },
            };
          }
          await mkdir(userRoot, { recursive: true });
          await writeFile(userConfigPath, JSON.stringify(clean, null, 2), 'utf8');
          void syncDesktop(); // display/size 等可能变化：重解析桌面宠物并重启 Helper（异步，不阻塞保存响应）
          // 响应体 = 保存后的**成品聚合**（与 GET /config 同一份，字段已填满）：
          // 设置页把它直接交给容器的 flattenConfigPets 拍平渲染——客户端的条目级字段
          // （动画池/权重/物理参数/工作状态文案）只有这一处填充，不再有第二份补吹实现。
          return { kind: 'json', status: 200, obj: readAllConfig(configPaths) };
        } catch {
          return { kind: 'json', status: 400, obj: { error: 'invalid JSON body' } };
        }
      }
      if (method === 'POST') {
        // 同步：把内置默认配置（assets/config.jsonc 原文，含注释）整份写入用户配置——
        // 既是「恢复默认」（合并结果 = 内置默认），又给用户留下一份可直接编辑的完整配置，
        // 不必再自己从包内复制一份（见 config.ts 的 syncUserConfigFromDefault）。
        try {
          syncUserConfigFromDefault(configPaths);
        } catch (e) {
          // 默认文件缺失 / 用户目录不可写：显式 500，绝不静默留下半个配置文件
          return { kind: 'json', status: 500, obj: { error: e instanceof Error ? e.message : String(e) } };
        }
        void syncDesktop(); // 配置变了：重解析桌面宠物并重启 Helper（异步，不阻塞响应）
        return { kind: 'json', status: 200, obj: readAllConfig(configPaths) };
      }
      return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
    }

    // 单只宠物的显示位置（桌面端右键「关闭桌面显示」→ POST /pet-display）。
    // 高频操作，故只收 id + display 两个参数，不要求调用方回传整段 pets（那是 PUT /config 的形态：
    // 客户端做读-改-写既容易误伤同层其它宠物，也拿不准该写哪一层）。
    // 层归属由服务端反查：id 在合并后被 mergePet 保证**全局唯一**（重复实例会被跳过、不进聚合），
    // 所以 findPetInstance 的结果没有歧义；反过来让客户端传 entry 只会多出"参数与真实归属不符"的
    // 新失败面（还平白把 entry 暴露成拼文件路径的输入）。
    // 写入语义与 PUT /config 完全一致：saveUserConfig 白名单重建 + existing 透传——用户手改的
    // whisperPrompt / memes 等非白名单字段不许被抹掉（见 ./config 里那段老 bug 的注释）。
    if (rest === 'pet-display') {
      if (method !== 'POST') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      let payload: { id?: unknown; display?: unknown };
      try {
        payload = JSON.parse(body ?? '') as { id?: unknown; display?: unknown };
      } catch {
        return { kind: 'json', status: 400, obj: { error: 'invalid JSON body' } };
      }
      const petId = typeof payload.id === 'string' ? payload.id.trim() : '';
      const nextDisplay = String(payload.display ?? '');
      if (!petId) return { kind: 'json', status: 400, obj: { error: 'missing pet id' } };
      if (!PET_DISPLAY_SET.has(nextDisplay)) {
        return { kind: 'json', status: 400, obj: { error: `invalid display: ${nextDisplay}` } };
      }
      let merged: Record<string, Record<string, unknown>>;
      try {
        merged = readAllConfig(configPaths);
      } catch (e) {
        return { kind: 'json', status: 500, obj: { error: e instanceof Error ? e.message : String(e) } };
      }
      // 命中不到有两种可能：id 根本不存在，或该实例在合并时**因 id 与其它条目重复被跳过**（于是不在
      // 聚合里）。两种都只能回 404——绝不能凭 id 去猜它"应该"属于哪个文件。
      const hit = findPetInstance(merged, petId);
      if (!hit) return { kind: 'json', status: 404, obj: { error: `pet not found: ${petId}` } };
      // 目标层：main → 用户主配置；其余 → 文件宠物自己的配置（.json 或 .jsonc，定位统一走 ./config）
      let layerPath: string;
      let layerDir: string;
      let existing: Record<string, unknown> | undefined;
      if (hit.entry === 'main') {
        layerPath = userConfigPath;
        layerDir = userRoot;
        existing = readUserConfig(configPaths);
      } else {
        const file = readPetConfigEntry(configPaths, hit.entry);
        if (!file) {
          return { kind: 'json', status: 404, obj: { error: `pet config file not found: ${hit.entry}` } };
        }
        layerPath = file.path;
        layerDir = petConfigDir;
        existing = file.raw;
      }
      // 整段替换语义：saveUserConfig 重建的是整个 pets 数组，必须带上**该层全部**宠物，只把目标
      // 那只的 display 换掉（漏掉别的 = 把它们从配置里删掉）。
      const layerPets = Array.isArray(hit.conf.pets) ? (hit.conf.pets as Record<string, unknown>[]) : [];
      const pets = layerPets.map((p) => (String(p.id) === petId ? { ...p, display: nextDisplay } : p));
      const clean = saveUserConfig({ pets }, existing);
      if (!clean) return { kind: 'json', status: 400, obj: { error: 'invalid pet config' } };
      try {
        await mkdir(layerDir, { recursive: true });
        await writeFile(layerPath, JSON.stringify(clean, null, 2), 'utf8');
      } catch (e) {
        return { kind: 'json', status: 500, obj: { error: e instanceof Error ? e.message : String(e) } };
      }
      // 不 await：发起者很可能就是**即将被这次重载换掉的**桌面 Helper（与 /reload 同一处境）。
      // 写盘已经落定，重启结果不需要回给调用方。
      void syncDesktop();
      // 响应体 = 改动后的**成品聚合**（与 PUT / POST /config 同形）：调用方（浏览器端右键菜单）
      // 直接把它交给 petBridge.reload，不必再发一次 GET /config —— 与设置页保存走的是同一条路，
      // 也就不会拿到可能陈旧的配置（现场表现：不返回聚合时浏览器端要刷新才生效）。
      return { kind: 'json', status: 200, obj: readAllConfig(configPaths) };
    }

    // 桌面端「重载配置」（右键菜单 → POST /reload）：重启桌面 Helper，全部桌面宠物窗口按最新配置重建。
    // 与保存走**同一条**重启路径（syncDesktop：串行队列 + 等旧进程真正退出再起新的），
    // 所以宠物数量 / display / size 的变化同样生效——渲染端就地重拉配置做不到这几项
    // （每只宠物一个窗口，是宿主启动时按 DSH_WHALE_PETS 建的）。
    // 注意：发起者就是**即将被重启的那个 helper**，本响应不保证送达，因此不 await 重启、立刻回 200。
    if (rest === 'reload') {
      if (method !== 'POST') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      void syncDesktop();
      return { kind: 'json', status: 200, obj: { reloading: true } };
    }

    // 配置文件路径 + 存储位置清单（设置页「高级配置」与「卸载与存储」展示用）
    if (rest === 'config/meta') {
      return {
        kind: 'json',
        status: 200,
        obj: {
          user: userConfigPath,
          default: join(PACKAGE_ROOT, 'assets', 'config.jsonc'),
          animations: thumbUserRoot,
          memes: memesUserRoot,
          // 全部落盘位置（本包用户数据 / Electron 运行时 / 桌面端缓存 / 下载缓存 / 插件本体）：
          // 前两条直接传真实写入方的路径，不在这里重拼目录名
          storage: storageEntries({
            userDataRoot: userRoot,
            electronDir: electronLandingDir(),
            home: homedir(),
            packageRoot: PACKAGE_ROOT,
          }),
          // profile 名（拼卸载命令 dsh plugin --profile <名> remove dsh-whale-girl；反推不出时为空串）
          profile: profileNameFrom(PACKAGE_ROOT) ?? '',
        },
      };
    }

    // 可选模型清单（设置页「AI 模型」两个下拉框的数据源）：与 DSH 自己的模型选择器**同源**——
    // 都来自宿主 llm 服务：listProviders = 已注册的实时服务商路由，listModels(provider) = 该路由下的模型。
    // 只读、无副作用；某个服务商列模型失败（适配器不支持 / 网络）只让它空着，不拖垮整张清单。
    // 服务商路由一个都没注册时回落到 listConfigurableProviders（适配器声明可配置的路由），
    // 免得下拉框空着——那种路由调用失败会由生成侧的回落兜住。
    if (rest === 'models') {
      if (method !== 'GET') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      try {
        const llm = ctx.llm as
          | {
              listProviders?: () => Array<{ id?: unknown; name?: unknown }>;
              listConfigurableProviders?: () => Array<{ provider?: unknown; displayName?: unknown }>;
              listModels?: (provider: string) => Promise<Array<{ id?: unknown; name?: unknown }>>;
            }
          | undefined;
        const named = (id: unknown, name: unknown): { id: string; name: string } => {
          const pid = String(id ?? '');
          return { id: pid, name: String(name ?? '') || pid };
        };
        let providers = (typeof llm?.listProviders === 'function' ? llm.listProviders() : []).map((p) =>
          named(p?.id, p?.name),
        );
        if (providers.length === 0 && typeof llm?.listConfigurableProviders === 'function') {
          providers = llm.listConfigurableProviders().map((p) => named(p?.provider, p?.displayName));
        }
        providers = providers.filter((p) => p.id);
        const catalog = await Promise.all(
          providers.map(async (p) => {
            let models: Array<{ id: string; name: string }> = [];
            try {
              const list = await llm?.listModels?.(p.id);
              models = (Array.isArray(list) ? list : []).map((m) => named(m?.id, m?.name)).filter((m) => m.id);
            } catch {
              /* 单个服务商列不出模型：留空即可（下拉框里该服务商只有「跟随当前对话」可选） */
            }
            return { ...p, models };
          }),
        );
        return { kind: 'json', status: 200, obj: { providers: catalog } };
      } catch (e) {
        return { kind: 'json', status: 500, obj: { error: e instanceof Error ? e.message : String(e) } };
      }
    }

    // 轮询统一状态（S）：/dsh-whale-girl/state（GET，no-cache）——前端 1s 轮询的**唯一**数据源
    // （余额 / 工作状态 / 通知 / 宠物说话，形状见 ./state）。
    // 只读、纯内存、**零副作用**：绝不在这里触发外部调用或模型生成——那会把所有人的 1s 轮询拖死。
    if (rest === 'state') {
      if (method !== 'GET') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      return {
        kind: 'json',
        status: 200,
        // 顺带下发配置版本：浏览器端靠它发现「配置被别处改过」（桌面端右键改 display / 另一个标签页
        // 保存 / 用户手改配置文件）后重拉 /config。没有它，桌面端的改动要刷新页面才可见。
        obj: { ...state.read(), configVersion: configVersion(configPaths) },
        headers: { 'cache-control': 'no-cache, no-store' },
      };
    }

    // 余额：/dsh-whale-girl/balance（POST = 立即刷新一次并写入 S，返回 {ok}）
    // 动作端点，**不返回余额数据**——数据只有一个出口（/state），这里只负责"让它刷新"。
    // 改造前这里是 GET（直接查余额）+ /balance/trigger（1s 计数轮询）两个端点，都已删除：
    // 前端不再各自定时查余额（host 定时器统一查，两端共享一份），也不再需要计数轮询中转。
    if (rest === 'balance') {
      if (method !== 'POST') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      await refreshBalance(true); // manual：用户主动要的，余额不可用时前端必弹文字说明
      // ok 只表示"这次刷新动作完成了"；余额本身是否可用在 S 的 data 里（ok:false 会弹文字说明气泡）
      return { kind: 'json', status: 200, obj: { ok: true } };
    }

    // 碎碎念：/dsh-whale-girl/whisper?pet=<id>（POST = 立即让桌宠新说一句，返回 {ok}）
    // 动作端点，**不返回文本**——文本走 S 的 pets.<id>.say（碎碎念/命令气泡/对话回复同一个叶子）。
    // 手动语义不受 whisperEnabled 门控：那个字段只关自动周期（与改造前一致）。
    if (rest === 'whisper') {
      if (method !== 'POST') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      const petId = String(url.searchParams.get('pet') ?? '');
      try {
        const ok = await publishWhisper(petId);
        return { kind: 'json', status: 200, obj: ok ? { ok: true } : { ok: false, reason: 'generate-error' } };
      } catch (e) {
        return {
          kind: 'json',
          status: 200,
          obj: { ok: false, reason: 'generate-error', message: e instanceof Error ? e.message : String(e) },
        };
      }
    }

    // 第三方投喂：/dsh-whale-girl/broadcast?pet=<id>（POST = 把一段**外部给定的**文本写进桌宠气泡）
    // 与 /whisper 的区别：这个**不生成**，调用方自己给文本——宿主侧其他插件（女仆巡检等）
    // 想说自己的话时用它，桌宠就成了那套人格的"实体"（见 issue #76）。
    // 写入 S 的 pets.<id>.say —— 与碎碎念/对话回复**同一个叶子**，两端 1s 内自动显示，前端零改动。
    // 动作端点，只回 {ok}；文本本身从 /state 读。
    // 校验（不通过一律 HTTP 200 + ok:false，与 /chat 的失败口径一致）：
    //   text 必填、trim 后非空（**不设长度限制，也不限频**：内容与频率由调用方自己负责）；
    //   pet 缺省 = 当前桌宠（resolveActivePetId），须真实存在；
    //   image 只认**包内表情包名**（池内命中即用其规范名），杜绝第三方注入外部地址。
    if (rest === 'broadcast') {
      if (method !== 'POST') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      let parsed: unknown;
      try {
        parsed = JSON.parse(body ?? 'null');
      } catch {
        return { kind: 'json', status: 400, obj: { error: 'invalid JSON body' } };
      }
      const o = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
      // 空文本不需要读配置就能判定：先短路，别为一个必然失败的请求去碰磁盘
      if (!normalizeBroadcastText(o.text)) {
        return { kind: 'json', status: 200, obj: { ok: false, reason: 'bad-request', message: 'text 为空' } };
      }
      try {
        const cfg = readAllConfig(configPaths);
        const d = decideBroadcast({
          cfg,
          requested: String(url.searchParams.get('pet') ?? ''),
          active: resolveActivePetId(),
          text: o.text,
          image: o.image,
          memeDirs: memeDirsFor,
        });
        if (!d.ok) return { kind: 'json', status: 200, obj: { ok: false, reason: d.reason, message: d.message } };
        state.writePet(d.petId, 'say', d.image ? { text: d.text, image: d.image } : { text: d.text });
        return { kind: 'json', status: 200, obj: { ok: true } };
      } catch (e) {
        // 配置读取失败等（安装损坏）→ 显式失败，不静默
        return {
          kind: 'json',
          status: 200,
          obj: { ok: false, reason: 'generate-error', message: e instanceof Error ? e.message : String(e) },
        };
      }
    }

    // 点播动画：/dsh-whale-girl/anim?pet=<id>（POST = 让桌宠播一段指定动画）
    // 效果与右键菜单点「动作」树**完全一致**——两端都复用同一个菜单动作处理函数
    // （浏览器 handleMenuAction / 桌面 sprite.onMenuAction），宿主只负责把名字送到。
    // 写入 S 的 pets.<id>.anim —— 前端 1s 内发现 counter 变化后换源播放（**名字即文件名**）。
    // 动作端点，只回 {ok}。
    // 校验（不通过一律 HTTP 200 + ok:false，与其他动作端点口径一致）：
    //   name 必填、trim 后非空，且必须在该宠物 animations 配置能点到的集合内
    //   （播放端对不存在的动画没有兜底：名字即文件名 → 404 → 加载失败 → 表现为"点了没反应"，
    //    所以必须在这里拦住，而不是写进 S 让前端白跑一趟）；
    //   pet 缺省 = 当前桌宠（resolveActivePetId），须真实存在。
    if (rest === 'anim') {
      if (method !== 'POST') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      let parsed: unknown;
      try {
        parsed = JSON.parse(body ?? 'null');
      } catch {
        return { kind: 'json', status: 400, obj: { error: 'invalid JSON body' } };
      }
      const o = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
      try {
        const cfg = readAllConfig(configPaths);
        const d = decideAnim({
          cfg,
          requested: String(url.searchParams.get('pet') ?? ''),
          active: resolveActivePetId(),
          name: o.name,
        });
        if (!d.ok) return { kind: 'json', status: 200, obj: { ok: false, reason: d.reason, message: d.message } };
        state.writePet(d.petId, 'anim', { name: d.name });
        return { kind: 'json', status: 200, obj: { ok: true } };
      } catch (e) {
        // 配置读取失败等（安装损坏）→ 显式失败，不静默
        return {
          kind: 'json',
          status: 200,
          obj: { ok: false, reason: 'generate-error', message: e instanceof Error ? e.message : String(e) },
        };
      }
    }

    // 对话：/dsh-whale-girl/chat?pet=<id>
    //   GET  —— 最近记忆窗口（截尾 chatMemoryRounds 轮），弹窗打开时展示（一次性读，不是轮询）
    //   POST —— 携带历史生成回复并写入记忆；**只回 {ok}**，回复走 S 的 pets.<id>.say
    // 记忆唯一读写方 = host（memory.json；浏览器/桌面两端都只是客户端）→
    // 同一实例的浏览器与桌面天然共享同一份记忆；文件全存不删，
    // 请求只截尾部 chatMemoryRounds 轮（1 轮 = 1 问 1 答；合并器已按条目填默认）。
    // ── 人设（自定义，覆盖 config 的 whisperPrompt）──────────────────────
    //   GET  /persona           → 当前生效的人设与来源
    //   POST /persona { prompt } → 写 persona.json（空串 = 删除覆盖，回落 config）
    if (rest === 'persona') {
      if (method === 'GET') {
        const override = readPersonaOverride();
        return {
          kind: 'json',
          status: 200,
          obj: { ok: true, prompt: override ?? '', source: override === undefined ? 'config' : 'persona.json' },
        };
      }
      if (method !== 'POST') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      try {
        const parsed = (JSON.parse(body ?? 'null') as Record<string, unknown> | null) ?? {};
        const prompt = typeof parsed.prompt === 'string' ? parsed.prompt.trim() : '';
        await mkdir(userRoot, { recursive: true });
        await writeFile(
          personaPath,
          JSON.stringify(prompt === '' ? {} : { main: prompt }, null, 2) + '\n',
          'utf8',
        );
        return {
          kind: 'json',
          status: 200,
          obj: { ok: true, prompt, source: prompt === '' ? 'config' : 'persona.json' },
        };
      } catch (e) {
        return { kind: 'json', status: 200, obj: { ok: false, message: e instanceof Error ? e.message : String(e) } };
      }
    }

    // ── 对话记忆（导入 / 导出 / 清空）─────────────────────────────────────
    //   GET  /memory?pet=main        → 数量 + 最近 20 条（设置页预览）
    //   GET  /memory/export?pet=main → 可移植 JSON（手机↔电脑迁移用）
    //   POST /memory/import          → { pet?, payload } 解析 + 去重合并
    //   POST /memory/clear           → { pet? } 清空该宠物的记忆
    if (rest === 'memory' || rest === 'memory/export' || rest === 'memory/import' || rest === 'memory/clear') {
      let parsedBody: Record<string, unknown> = {};
      if (method === 'POST') {
        try {
          parsedBody = (JSON.parse(body ?? 'null') as Record<string, unknown> | null) ?? {};
        } catch {
          return { kind: 'json', status: 400, obj: { ok: false, message: 'invalid JSON body' } };
        }
      }
      const requested = String(parsedBody.pet ?? url.searchParams.get('pet') ?? '').trim();
      const petId = requested !== '' ? requested : resolveActivePetId() || 'main';
      const cfgNow = readAllConfig(configPaths);
      const entryKey = findPetInstance(cfgNow, petId)?.entry ?? 'main';

      if (rest === 'memory' && method === 'GET') {
        const mem = await readMemory();
        const messages = mem[entryKey]?.[petId]?.messages ?? [];
        return {
          kind: 'json',
          status: 200,
          obj: { ok: true, pet: petId, entry: entryKey, count: messages.length, messages: messages.slice(-20) },
        };
      }

      if (rest === 'memory/export') {
        const mem = await readMemory();
        const messages = mem[entryKey]?.[petId]?.messages ?? [];
        return { kind: 'json', status: 200, obj: { ok: true, pet: petId, entry: entryKey, ...exportMemoryPayload(messages) } };
      }

      if (rest === 'memory/clear') {
        if (method !== 'POST') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
        await withMemoryLock(async () => {
          const mem = await readMemory();
          if (mem[entryKey]?.[petId]) mem[entryKey][petId].messages = [];
          await writeMemory(mem);
        });
        return { kind: 'json', status: 200, obj: { ok: true, pet: petId, cleared: true } };
      }

      if (rest === 'memory/import') {
        if (method !== 'POST') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
        const parsedImport = parseMemoryImport(parsedBody.payload ?? parsedBody.messages ?? parsedBody.text);
        if (!parsedImport.ok) return { kind: 'json', status: 200, obj: { ok: false, message: parsedImport.message } };
        const merged = await withMemoryLock(async () => {
          const mem = await readMemory();
          const bucket = (mem[entryKey] ??= {});
          const record = (bucket[petId] ??= { messages: [] });
          const result = mergeMemory(record.messages, parsedImport.messages, 2000);
          record.messages = result.messages;
          await writeMemory(mem);
          return result;
        });
        return {
          kind: 'json',
          status: 200,
          obj: {
            ok: true,
            pet: petId,
            entry: entryKey,
            imported: parsedImport.messages.length,
            added: merged.added,
            total: merged.messages.length,
          },
        };
      }

      return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
    }

    // ── 对话记录（只给主人翻阅；不进模型上下文）─────────────────────────
    //   GET  /chatlog?pet=&limit=&before= → 倒序分页（含动作神态版本）
    //   GET  /chatlog/export              → 全量 JSON
    //   POST /chatlog/clear               → 清空该宠物的记录
    if (rest === 'chatlog' || rest === 'chatlog/export' || rest === 'chatlog/clear') {
      let parsedBody: Record<string, unknown> = {};
      if (method === 'POST') {
        try {
          parsedBody = (JSON.parse(body ?? 'null') as Record<string, unknown> | null) ?? {};
        } catch {
          return { kind: 'json', status: 400, obj: { ok: false, message: 'invalid JSON body' } };
        }
      }
      const requested = String(parsedBody.pet ?? url.searchParams.get('pet') ?? '').trim();
      const petId = requested !== '' ? requested : resolveActivePetId() || 'main';

      if (rest === 'chatlog/clear') {
        if (method !== 'POST') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
        const kept = (await readChatLog()).filter((entry) => entry.petId !== petId);
        await writeChatLog(kept);
        return { kind: 'json', status: 200, obj: { ok: true, pet: petId, cleared: true } };
      }

      await seedChatLogFromMemory(petId);
      const all = (await readChatLog()).filter((entry) => entry.petId === petId);

      if (rest === 'chatlog/export') {
        return { kind: 'json', status: 200, obj: { ok: true, pet: petId, entries: all } };
      }

      const limitRaw = Number(url.searchParams.get('limit') ?? '50');
      const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, Math.round(limitRaw))) : 50;
      const beforeRaw = Number(url.searchParams.get('before') ?? '');
      const filtered =
        Number.isFinite(beforeRaw) && beforeRaw > 0 ? all.filter((entry) => entry.ts < beforeRaw) : all;
      const page = filtered.slice(-limit).reverse();
      return {
        kind: 'json',
        status: 200,
        obj: { ok: true, pet: petId, entries: page, hasMore: filtered.length > page.length },
      };
    }

    if (rest === 'chat') {
      const petId = String(url.searchParams.get('pet') ?? '');
      try {
        if (method === 'GET') {
          const cfg = readAllConfig(configPaths);
          const mem = await readMemory();
          const bucket = mem[findPetInstance(cfg, petId)?.entry ?? petId] ?? {};
          const list = (bucket[petId]?.messages ?? []).slice();
          const rounds = memoryRounds(petId, cfg);
          // 与 chatWithPet 同一语义：rounds = 0 → 空历史（slice(-0) 会返回整个数组，见上）
          const messages = sliceMemoryRounds(list, rounds);
          return { kind: 'json', status: 200, obj: { ok: true, messages, rounds } };
        }
        if (method === 'POST') {
          const parsed = (JSON.parse(body ?? 'null') as Record<string, unknown> | null) ?? {};
          const text = typeof parsed.text === 'string' ? parsed.text.trim() : '';
          if (!text) {
            return { kind: 'json', status: 200, obj: { ok: false, reason: 'bad-request', message: '消息为空' } };
          }
          if (text.length > 2000) {
            return {
              kind: 'json',
              status: 200,
              obj: { ok: false, reason: 'bad-request', message: '消息过长（限 2000 字）' },
            };
          }
          const result = await chatWithPet(petId, text);
          return { kind: 'json', status: 200, obj: result };
        }
        return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      } catch (e) {
        // 配置已由 readAllConfig 保证正确（不再有 config-error 分支）；其余（IO/LLM）→ generate-error
        return {
          kind: 'json',
          status: 200,
          obj: { ok: false, reason: 'generate-error', message: e instanceof Error ? e.message : String(e) },
        };
      }
    }

    // ── 语音诊断追踪（只在排障时用）────────────────────────────────────
    // POST /dsh-whale-girl/voice/trace  {step, detail}
    // 追加一行 JSONL 到 $DSH_HOME/dsh-whale-girl/voice-trace.log。
    //
    // 为什么需要：语音链路在**前端**有很多步（拿设备→录音→编码→请求→合成→播放），
    // 任何一步静默失败都表现为「按了没反应」，而浏览器控制台主人不方便看。
    // 落成文件后，宿主侧一次 GET 就能看到走到哪一步断的。
    // GET  /dsh-whale-girl/voice/trace  → 最近 60 行（给排障用）
    if (rest === 'voice/trace') {
      const file = join(userRoot, 'voice-trace.log');
      if (method === 'GET') {
        let lines: string[] = [];
        try {
          lines = readFileSync(file, 'utf8').split('\n').filter((l) => l !== '').slice(-60);
        } catch {
          /* 没有日志 = 还没跑过 */
        }
        return { kind: 'json', status: 200, obj: { ok: true, lines } };
      }
      if (method !== 'POST') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      try {
        const parsed = (JSON.parse(body ?? 'null') as Record<string, unknown> | null) ?? {};
        const line = JSON.stringify({
          at: new Date().toISOString(),
          step: String(parsed.step ?? ''),
          detail: parsed.detail === undefined ? undefined : parsed.detail,
        });
        await mkdir(userRoot, { recursive: true });
        await appendFile(file, line + '\n', 'utf8');
        return { kind: 'json', status: 200, obj: { ok: true } };
      } catch (e) {
        return { kind: 'json', status: 200, obj: { ok: false, message: e instanceof Error ? e.message : String(e) } };
      }
    }

    // ── 代打（看屏幕 → 想一步 → 动手）────────────────────────────────────
    //   GET  /autoplay/config      → 配置 + 急停状态
    //   POST /autoplay/config      → 保存配置（白名单重建）
    //   POST /autoplay/run         → 跑一轮（空跑时只打印计划）
    //   POST /autoplay/resume      → 手动恢复急停
    //   POST /autoplay/stop        → 手动急停
    //   GET  /autoplay/foreground  → 当前前台窗口标题（方便填白名单）
    //   POST /autoplay/task        → 任务分流（简单自己做 / 复杂建 DSH 会话）
    //   GET  /autoplay/games       → 游戏档案列表
    //   POST /autoplay/games       → 保存档案
    //   POST /autoplay/guide       → 联网查攻略并写进档案
    //   GET  /autoplay/session     → 本局进度
    //   POST /autoplay/end         → 结束本局（压缩进共用记忆）
    //   POST /autoplay/toggle      → 右键菜单快捷开关
    //
    // ⚠️ 所有 /autoplay/* 都必须在下面这个 startsWith 分支里用 sub 判断：
    //    分支末尾有「未知子路由 → 404」，写在分支外面的 rest === 'autoplay/xxx'
    //    永远走不到（17:06 构建前的老 bug，2026-10-18 修）。
    if (rest.startsWith('autoplay/')) {
      const sub = rest.slice('autoplay/'.length);

      if (sub === 'config') {
        if (method === 'GET') {
          return {
            kind: 'json',
            status: 200,
            obj: { ok: true, config: readAutoplayConfig(), estop: autoplayEstop.snapshot() },
          };
        }
        if (method !== 'POST') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
        let patch: Record<string, unknown>;
        try {
          patch = (JSON.parse(body ?? 'null') as Record<string, unknown> | null) ?? {};
        } catch {
          return { kind: 'json', status: 400, obj: { ok: false, message: 'invalid JSON body' } };
        }
        try {
          const current = readAutoplayConfig();
          const next: AutoplayConfig = normalizeAutoplayConfig({
            enabled: typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled,
            dryRun: typeof patch.dryRun === 'boolean' ? patch.dryRun : current.dryRun,
            estopKey: typeof patch.estopKey === 'string' ? patch.estopKey : current.estopKey,
            windowTitles: Array.isArray(patch.windowTitles)
              ? (patch.windowTitles as unknown[]).filter((v): v is string => typeof v === 'string')
              : current.windowTitles,
            // null = 显式清空（跟随对话模型）；对象 = 指定代打识图模型；缺省沿用
            visionModel:
              patch.visionModel === null
                ? undefined
                : (patch.visionModel as AutoplayConfig['visionModel']) ?? current.visionModel,
          });
          await mkdir(userRoot, { recursive: true });
          await writeFile(autoplayConfigPath, JSON.stringify(next, null, 2) + '\n', 'utf8');
          // 换了急停键就要换监听：重建控制器
          await rearmAutoplay(next);
          if (!next.enabled) {
            // 关总开关 = 立刻停掉陪玩循环（不能等下一轮才停）
            playLoop.stop('disabled');
            if (autoplaySession !== undefined) await endAutoplaySession();
          }
          return { kind: 'json', status: 200, obj: { ok: true, config: next, estop: autoplayEstop.snapshot() } };
        } catch (e) {
          return { kind: 'json', status: 200, obj: { ok: false, message: e instanceof Error ? e.message : String(e) } };
        }
      }

      if (sub === 'run') {
        if (method !== 'POST') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
        const conf = readAutoplayConfig();
        if (!conf.enabled) {
          return { kind: 'json', status: 200, obj: { kind: 'skipped', reason: 'disabled' } };
        }
        return { kind: 'json', status: 200, obj: await runAutoplayOnce(conf) };
      }

      if (sub === 'resume') {
        if (method !== 'POST') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
        autoplayEstop.resume();
        return { kind: 'json', status: 200, obj: { ok: true, estop: autoplayEstop.snapshot() } };
      }

      if (sub === 'stop') {
        if (method !== 'POST') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
        autoplayEstop.stop('manual');
        return { kind: 'json', status: 200, obj: { ok: true, estop: autoplayEstop.snapshot() } };
      }

      if (sub === 'foreground') {
        if (method !== 'GET') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
        try {
          return { kind: 'json', status: 200, obj: { ok: true, title: await foregroundWindowTitle() } };
        } catch (e) {
          return { kind: 'json', status: 200, obj: { ok: false, message: e instanceof Error ? e.message : String(e) } };
        }
      }

      // 运行中的窗口列表：给设置页做「点选白名单」，不用主人手打标题。
      // 为什么需要：中文游戏名和窗口英文标题经常对不上（苏丹的游戏 ↔ Sultan's Game），
      // 点一下列表里真实存在的窗口，写进去的就是能匹配上的准确标题。
      if (sub === 'windows') {
        if (method !== 'GET') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
        try {
          const subprocess = ctx.get('subprocess', false) as Parameters<typeof listWindows>[0];
          const wins = await listWindows(subprocess);
          const seen = new Set<string>();
          const windows = wins
            .filter((w) => {
              if (w.title.trim() === '' || seen.has(String(w.pid))) return false;
              seen.add(String(w.pid));
              return true;
            })
            .slice(0, 60)
            .map((w) => ({ pid: w.pid, title: w.title, processName: w.processName }));
          return { kind: 'json', status: 200, obj: { ok: true, windows } };
        } catch (e) {
          return { kind: 'json', status: 200, obj: { ok: false, message: e instanceof Error ? e.message : String(e) } };
        }
      }

      // ── 持续陪玩（开始 / 停止 / 状态）────────────────────────────────
      //   POST /autoplay/play/start { dryRun?, estopKey?, windowTitles? }
      //        —— 总是把 enabled 落盘为 true；开始后给 5 秒急停宽限期
      //   POST /autoplay/play/stop  → 停循环 + 急停 + 结束本局（压缩记忆）
      //   GET  /autoplay/play       → 循环状态 + 配置 + 急停快照
      if (sub === 'play') {
        if (method !== 'GET') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
        return {
          kind: 'json',
          status: 200,
          obj: {
            ok: true,
            play: playLoop.snapshot(),
            config: readAutoplayConfig(),
            estop: autoplayEstop.snapshot(),
          },
        };
      }

      if (sub === 'play/start') {
        if (method !== 'POST') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
        let patch: Record<string, unknown> = {};
        try {
          patch = (JSON.parse(body ?? 'null') as Record<string, unknown> | null) ?? {};
        } catch {
          return { kind: 'json', status: 400, obj: { ok: false, message: 'invalid JSON body' } };
        }
        try {
          // 「开始陪玩」本身就是一次明确授权：不管表单有没有保存，这里都以 enabled:true 落盘。
          const started = await beginPlay(patch);
          if (!started.ok) return { kind: 'json', status: 200, obj: { ok: false, message: started.message } };
          return {
            kind: 'json',
            status: 200,
            obj: { ok: true, play: playLoop.snapshot(), config: readAutoplayConfig(), estop: autoplayEstop.snapshot() },
          };
        } catch (e) {
          return { kind: 'json', status: 200, obj: { ok: false, message: e instanceof Error ? e.message : String(e) } };
        }
      }

      if (sub === 'play/stop') {
        if (method !== 'POST') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
        const ended = await stopPlayNow('manual');
        return {
          kind: 'json',
          status: 200,
          obj: { ok: true, play: playLoop.snapshot(), estop: autoplayEstop.snapshot(), ended: ended ?? null },
        };
      }

      // ── 任务执行（分流验证入口）────────────────────────────────────────
      //   POST /autoplay/task { text, cwd? }
      //   → 简单任务本地执行；复杂任务在 DSH 新建会话执行
      //
      // 这个路由是**验证用**：先确认建会话真的可行，再往语音链路里接。
      if (sub === 'task') {
        if (method !== 'POST') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
        try {
          const patch = (JSON.parse(body ?? 'null') as Record<string, unknown> | null) ?? {};
          const text = typeof patch.text === 'string' ? patch.text.trim() : '';
          const routed = routeTask(text);
          if (routed.kind === 'self') {
            return { kind: 'json', status: 200, obj: { ok: true, route: 'self', action: routed.action, reason: routed.reason } };
          }
          if (routed.kind === 'chat') {
            return { kind: 'json', status: 200, obj: { ok: true, route: 'chat', reason: routed.reason } };
          }
          const sel = resolveCurrentModel();
          const created = await createTaskSession(
            ctx.get('agents', false) as Parameters<typeof createTaskSession>[0],
            routed.prompt,
            {
              ...(typeof patch.cwd === 'string' && patch.cwd !== '' ? { cwd: patch.cwd } : {}),
              ...(sel === undefined ? {} : { provider: sel.provider, model: sel.model }),
            },
          );
          return { kind: 'json', status: 200, obj: { ...created, route: 'session', reason: routed.reason } };
        } catch (e) {
          return { kind: 'json', status: 200, obj: { ok: false, message: e instanceof Error ? e.message : String(e) } };
        }
      }

      // ── 游戏档案 + 本局会话 ──────────────────────────────────────────
      //   GET  /autoplay/games   → 全部档案
      //   POST /autoplay/games   → 保存一份（title/genre/keys/notes）
      //   POST /autoplay/guide   → 联网查攻略并写进档案
      //   GET  /autoplay/session → 本局进度
      //   POST /autoplay/end     → 结束本局（压缩进共用记忆）
      if (sub === 'games') {
        if (method === 'GET') {
          return {
            kind: 'json',
            status: 200,
            obj: { ok: true, games: await readGames(), genreCaps: GENRE_MEMORY_CAP },
          };
        }
        if (method !== 'POST') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
        try {
          const patch = (JSON.parse(body ?? 'null') as Record<string, unknown> | null) ?? {};
          const profile = normalizeProfile(patch as Partial<GameProfile>);
          await writeGame(profile);
          return { kind: 'json', status: 200, obj: { ok: true, game: profile } };
        } catch (e) {
          return { kind: 'json', status: 200, obj: { ok: false, message: e instanceof Error ? e.message : String(e) } };
        }
      }

      if (sub === 'guide') {
        if (method !== 'POST') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
        try {
          const patch = (JSON.parse(body ?? 'null') as Record<string, unknown> | null) ?? {};
          const title = typeof patch.title === 'string' ? patch.title.trim() : '';
          const result = await searchGuide(ctx.get('web', false) as Parameters<typeof searchGuide>[0], title);
          if (!result.ok) return { kind: 'json', status: 200, obj: result };
          // 写进同名档案（没有就新建一份）
          const games = await readGames();
          const existing = games.find((g) => g.title === title || g.id === profileIdFromTitle(title));
          const merged = normalizeProfile({
            ...(existing ?? { title, genre: 'custom' }),
            title,
            guide: { query: result.query, summary: result.summary, sources: result.sources, atMs: result.atMs },
          });
          await writeGame(merged);
          return { kind: 'json', status: 200, obj: { ok: true, guide: result, game: merged } };
        } catch (e) {
          return { kind: 'json', status: 200, obj: { ok: false, message: e instanceof Error ? e.message : String(e) } };
        }
      }

      if (sub === 'session') {
        if (method !== 'GET') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
        return {
          kind: 'json',
          status: 200,
          obj: {
            ok: true,
            session:
              autoplaySession === undefined
                ? null
                : {
                    gameTitle: autoplaySession.gameTitle,
                    steps: autoplaySession.steps.length,
                    cap: autoplaySession.cap,
                    startedAt: autoplaySession.startedAt,
                  },
          },
        };
      }

      // 「结束本局」：**同时停掉陪玩循环**（主人反馈：只结束记录不停手，得再去点停止）
      if (sub === 'end') {
        if (method !== 'POST') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
        const ended = await stopPlayNow('end-session');
        return {
          kind: 'json',
          status: 200,
          obj: { ok: true, ended: ended ?? null, play: playLoop.snapshot(), estop: autoplayEstop.snapshot() },
        };
      }

      // 快捷开关（右键菜单）：**开始 / 停止陪玩**——不再只是翻「允许代打」的权限位。
      // 主人反馈：点菜单是为了快，结果还要回设置页点开始，等于多此一举。
      if (sub === 'toggle') {
        if (method !== 'POST') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
        try {
          if (playLoop.snapshot().running) {
            const ended = await stopPlayNow('manual');
            return {
              kind: 'json',
              status: 200,
              obj: { ok: true, running: false, play: playLoop.snapshot(), estop: autoplayEstop.snapshot(), ended: ended ?? null },
            };
          }
          const started = await beginPlay();
          if (!started.ok) return { kind: 'json', status: 200, obj: { ok: false, message: started.message } };
          return {
            kind: 'json',
            status: 200,
            obj: { ok: true, running: true, play: playLoop.snapshot(), config: readAutoplayConfig(), estop: autoplayEstop.snapshot() },
          };
        } catch (e) {
          return { kind: 'json', status: 200, obj: { ok: false, message: e instanceof Error ? e.message : String(e) } };
        }
      }

      return { kind: 'json', status: 404, obj: { error: 'unknown autoplay route' } };
    }

    // 快捷开关：右键菜单直接翻转「主动识屏」，不用回设置页
    if (rest === 'sight/toggle') {
      if (method !== 'POST') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      const current = readSightConfig();
      const next = { ...current, enabled: !current.enabled };
      await mkdir(userRoot, { recursive: true });
      await writeFile(sightConfigPath, JSON.stringify(next, null, 2) + '\n', 'utf8');
      armSightTimer(); // 立刻按新状态重排定时器
      return { kind: 'json', status: 200, obj: { ok: true, enabled: next.enabled } };
    }

    // ── 主动识屏（看屏幕搭话）────────────────────────────────────────────
    //   GET  /sight/config   → 当前配置 + 快照占用
    //   POST /sight/config   → 保存配置（白名单重建）
    //   POST /sight/run      → 立刻看一次（手动触发，不等定时器）
    //   GET  /sight/snapshot/<file> → 取一张快照（给设置页核对「她看了什么」）
    if (rest === 'sight/config') {
      if (method === 'GET') {
        const usage = await snapshotUsage(sightSnapshotsRoot);
        const conf = readSightConfig();
        // 把**实际会用的识图模型**一起返回：设置页要显示「到底是谁在识别」。
        // 否则主人只看到「跟随对话模型」四个字，不知道最终落到哪家（也就没法判断烧的是谁的钱）。
        const resolvedVision = resolveVisionModel();
        return {
          kind: 'json',
          status: 200,
          obj: {
            ok: true,
            config: conf,
            snapshots: usage,
            dir: sightSnapshotsRoot,
            visionModelResolved: resolvedVision ?? null,
          },
        };
      }
      if (method === 'POST') {
        let patch: Record<string, unknown>;
        try {
          patch = (JSON.parse(body ?? 'null') as Record<string, unknown> | null) ?? {};
        } catch {
          return { kind: 'json', status: 400, obj: { ok: false, message: 'invalid JSON body' } };
        }
        try {
          // 白名单重建：只接受已知字段，类型不对就用当前值
          const current = readSightConfig();
          const next: SightConfig = normalizeSightConfig({
            enabled: typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled,
            intervalSec: Number(patch.intervalSec ?? current.intervalSec),
            keepSnapshots: Number(patch.keepSnapshots ?? current.keepSnapshots),
            changeThreshold: Number(patch.changeThreshold ?? current.changeThreshold),
            speak: typeof patch.speak === 'boolean' ? patch.speak : current.speak,
            mode: typeof patch.mode === 'string' ? (patch.mode as SightMode) : current.mode,
            windowTitle: typeof patch.windowTitle === 'string' ? patch.windowTitle : current.windowTitle,
          });
          await mkdir(userRoot, { recursive: true });
          await writeFile(sightConfigPath, JSON.stringify(next, null, 2) + '\n', 'utf8');
          // 配置改了立刻重排定时器（不用等下一次重启）
          armSightTimer();
          return { kind: 'json', status: 200, obj: { ok: true, config: next } };
        } catch (e) {
          return { kind: 'json', status: 200, obj: { ok: false, message: e instanceof Error ? e.message : String(e) } };
        }
      }
      return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
    }

    if (rest === 'sight/run') {
      if (method !== 'POST') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      const round = await runSightOnce();
      return { kind: 'json', status: 200, obj: round };
    }

    // ── 应用别名（可查阅、可增减）──────────────────────────────────────
    //   GET  /apps/aliases → 当前生效的完整表
    //   POST /apps/aliases → 保存用户表（与内置表合并）
    if (rest === 'apps/aliases') {
      if (method === 'GET') {
        return { kind: 'json', status: 200, obj: { ok: true, aliases: readAppAliases(), defaults: DEFAULT_APP_ALIASES } };
      }
      if (method !== 'POST') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      try {
        const patch = (JSON.parse(body ?? 'null') as Record<string, unknown> | null) ?? {};
        const next: Record<string, string> = {};
        for (const [k, v] of Object.entries(patch)) {
          if (typeof v === 'string' && k.trim() !== '' && v.trim() !== '') next[k.trim()] = v.trim();
        }
        await mkdir(userRoot, { recursive: true });
        await writeFile(appsPath, JSON.stringify(next, null, 2) + '\n', 'utf8');
        return { kind: 'json', status: 200, obj: { ok: true, aliases: readAppAliases() } };
      } catch (e) {
        return { kind: 'json', status: 200, obj: { ok: false, message: e instanceof Error ? e.message : String(e) } };
      }
    }

    if (rest === 'sight/snapshots') {
      // 快照清单（设置页缩略图用）：只给文件名，不带内容
      if (method !== 'GET') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      let files: string[] = [];
      try {
        files = (await readdir(sightSnapshotsRoot)).filter((n) => n.endsWith('.jpg')).sort();
      } catch {
        /* 目录还不存在 → 空清单 */
      }
      return { kind: 'json', status: 200, obj: { ok: true, files } };
    }

    if (rest.startsWith('sight/snapshot/')) {
      // 只允许取快照目录里的文件；名字必须是 .jpg 且不含分隔符（防穿越）
      const name = rest.slice('sight/snapshot/'.length);
      if (name === '' || name.includes('/') || name.includes('\\') || !name.endsWith('.jpg')) {
        return { kind: 'text', status: 400, body: 'dsh-whale-girl: invalid snapshot name' };
      }
      const file = join(sightSnapshotsRoot, name);
      if (!existsSync(file)) return { kind: 'text', status: 404, body: 'dsh-whale-girl: snapshot not found' };
      return { kind: 'file', file, contentType: 'image/jpeg' };
    }

    // ── 语音配置（读写 voice.json）────────────────────────────────────────
    // 为什么不并进 config.jsonc：那份配置有严格的逐字段校验与「整段替换」语义，
    // 语音是主机侧能力（解释器路径、音色、快捷键），混进去会让「配置非法 → 宠物不显示」
    // 牵连语音。分成两份文件，互不影响。
    if (rest === 'voice/config') {
      if (method === 'GET') {
        return { kind: 'json', status: 200, obj: { ok: true, ...readVoiceConfig() } };
      }
      if (method === 'POST') {
        let patch: Record<string, unknown>;
        try {
          patch = (JSON.parse(body ?? 'null') as Record<string, unknown> | null) ?? {};
        } catch {
          return { kind: 'json', status: 400, obj: { ok: false, message: 'invalid JSON body' } };
        }
        try {
          // 只接受已知字段，且只接受非空字符串 —— 白名单重建，不把任意键写进用户目录
          const current = readVoiceConfig();
          const next: Record<string, string> = { voice: current.voice, rate: current.rate };
          if (current.pythonPath !== undefined) next.pythonPath = current.pythonPath;
          if (current.language !== undefined) next.language = current.language;
          if (current.shortcut !== undefined) next.shortcut = current.shortcut;
          if (current.micDeviceId !== undefined) next.micDeviceId = current.micDeviceId;
          if (current.hideButton !== undefined) next.hideButton = current.hideButton;
          for (const key of ['voice', 'rate', 'pythonPath', 'language', 'shortcut', 'micDeviceId', 'hideButton'] as const) {
            const value = patch[key];
            if (typeof value === 'string' && value.trim() !== '') next[key] = value.trim();
            else if (value === '') delete next[key];
          }
          // 用 promises 版（本文件顶部已导入 mkdir/writeFile）；同步版没有导入，
          // 之前这里写成 mkdirSync，一保存就报 "mkdirSync is not defined"。
          await mkdir(userRoot, { recursive: true });
          await writeFile(join(userRoot, 'voice.json'), JSON.stringify(next, null, 2) + '\n', 'utf8');
          // 快捷键可能变了：立刻重建全局监听（页面不用刷新——它订阅的是同一条流）
          restartVoiceHotkey();
          return { kind: 'json', status: 200, obj: { ok: true, ...readVoiceConfig(), hotkey: voiceHotkeyStatus() } };
        } catch (e) {
          return {
            kind: 'json',
            status: 200,
            obj: { ok: false, message: e instanceof Error ? e.message : String(e) },
          };
        }
      }
      return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
    }

    // 全局热键诊断：页面设置页 / 排障时用它确认「监听起没起来、几个页面连着」
    if (rest === 'voice/hotkey') {
      if (method !== 'GET') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      return { kind: 'json', status: 200, obj: voiceHotkeyStatus() };
    }

    // ── 语音 ──────────────────────────────────────────────────────────────
    // 三个端点，拆开是为了让前端能按需组合、并在每一步失败时给出不同的人话：
    //   POST /voice/asr   {audio:<base64 wav>}         → {ok,text}      识别
    //   POST /voice/turn  {audio:<base64 wav>, pet?}   → {ok,userText,reply}  识别 + 生成回复（含记忆）
    //   POST /voice/tts   {text, voice?, rate?}        → audio/mpeg     合成
    //
    // 为什么 /turn 不直接吐音频：回复文本要先上屏（气泡/字幕），语音随后播；
    // 把两者塞进一个响应会让前端在「文本已到但音频没到」时无法渐进显示。
    //
    // 为什么 TTS 单独端点：同一句回复可能要重播，「合成」与「对话」解耦后
    // 重播不必再跑一次 LLM。
    if (rest === 'voice/asr' || rest === 'voice/turn' || rest === 'voice/tts') {
      if (method !== 'POST') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      let parsed: Record<string, unknown>;
      try {
        parsed = (JSON.parse(body ?? 'null') as Record<string, unknown> | null) ?? {};
      } catch {
        return { kind: 'json', status: 400, obj: { ok: false, reason: 'bad-request', message: 'invalid JSON body' } };
      }

      // 音色/语速/解释器都允许在 voice.json 里覆盖，但缺省一律用主人拍板的值
      const voiceCfg = readVoiceConfig();

      if (rest === 'voice/tts') {
        const text = typeof parsed.text === 'string' ? parsed.text : '';
        const tts = await synthesize(userRoot, text, {
          voice: typeof parsed.voice === 'string' ? parsed.voice : voiceCfg.voice,
          rate: typeof parsed.rate === 'string' ? parsed.rate : voiceCfg.rate,
          pythonPath: voiceCfg.pythonPath,
        });
        if (!tts.ok) {
          return { kind: 'json', status: 200, obj: { ok: false, reason: tts.reason, message: tts.message } };
        }
        // 桌面窗经 bridge 取音频：bridge 是 JSON 行协议，塞不了二进制，
        // 所以提供 base64 形态（`?encoding=base64`），渲染端自己解回 Blob 播放。
        // 浏览器端仍用默认的二进制响应（更省内存）。
        if (url.searchParams.get('encoding') === 'base64') {
          return {
            kind: 'json',
            status: 200,
            obj: { ok: true, mime: tts.mime, audio: Buffer.from(tts.audio).toString('base64') },
          };
        }
        return { kind: 'buffer', status: 200, body: tts.audio, contentType: tts.mime };
      }

      // asr / turn 都要先拿音频
      const audio = typeof parsed.audio === 'string' ? decodeAudioBase64(parsed.audio) : undefined;
      if (audio === undefined) {
        return { kind: 'json', status: 200, obj: { ok: false, reason: 'bad-request', message: '缺少或无法解码 audio' } };
      }
      const asr = await transcribe(ctx, audio, { language: voiceCfg.language });
      if (!asr.ok) {
        return { kind: 'json', status: 200, obj: { ok: false, reason: asr.reason, message: asr.message } };
      }
      if (rest === 'voice/asr') {
        return { kind: 'json', status: 200, obj: { ok: true, text: asr.text, audioSeconds: asr.audioSeconds } };
      }

      // turn：识别完直接走与 /chat 完全相同的那条生成路径（同一份人设/记忆/回落到当前模型）
      const requested = String(parsed.pet ?? '');
      const petId = requested.trim() === '' ? resolveActivePetId() : requested;
      if (!petId) {
        return { kind: 'json', status: 200, obj: { ok: false, reason: 'no-pet', message: '没有可对话的宠物' } };
      }

      // ── 陪玩进行中：这句语音是**给她的战术提醒**，不是闲聊 ──
      //
      // 全局热键（默认 Alt+V）在陪玩时照样能用：说「先选弓箭手再打那个法师」，
      // 下一轮就作为「主人刚刚用语音提醒」进提示词；说「停」直接停手。
      // 为什么单独分流：陪玩时她需要的是「怎么打」，普通闲聊回复帮不上忙。
      if (playLoop.snapshot().running) {
        const spoken = asr.text.trim();
        if (spoken === '') {
          // 没听清就说没听清，别继续走聊天（陪玩时她不需要闲聊回复）
          const sorry = '没听清，再说一次？';
          state.writePet(petId, 'say', { text: sorry });
          return {
            kind: 'json',
            status: 200,
            obj: { ok: true, userText: '', reply: sorry, audioSeconds: asr.audioSeconds, route: 'coach' },
          };
        }
        const spokenIntent = parseVoiceIntent(spoken);
        if (spokenIntent?.kind === 'stop-now') {
          await stopPlayNow('voice');
          const bye = '好，先停在这。';
          state.writePet(petId, 'say', { text: bye });
          return {
            kind: 'json',
            status: 200,
            obj: { ok: true, userText: spoken, reply: bye, audioSeconds: asr.audioSeconds, route: 'coach' },
          };
        }
        autoplayUserHint = spoken.slice(0, 200);
        const ack = '收到：' + autoplayUserHint;
        state.writePet(petId, 'say', { text: ack });
        return {
          kind: 'json',
          status: 200,
          obj: { ok: true, userText: spoken, reply: ack, audioSeconds: asr.audioSeconds, route: 'coach' },
        };
      }

      // ── 语音指令：认出来就直接执行，不走模型 ──
      //
      // 主人要的是「语音能操控一切」：开关、结束本局、打开应用、自己查。
      // 这些确定的命令走本地规则（毫秒级、0 成本），只在认不出来时才当闲聊。

      // ── 待发消息的确认（最高优先级）──
      //
      // 主人说了"发"就真的按出去；说"不发"就丢掉。
      // 放在最前面：这两个词太容易出现在别的句子里，必须先处理掉。
      if (pendingMessage !== undefined) {
        if (isConfirm(asr.text)) {
          const done = await executePendingMessage();
          state.writePet(petId, 'say', { text: done });
          return { kind: 'json', status: 200, obj: { ok: true, userText: asr.text, reply: done, audioSeconds: asr.audioSeconds, route: 'send' } };
        }
        if (isCancel(asr.text)) {
          pendingMessage = undefined;
          const done = '好，不发了。';
          state.writePet(petId, 'say', { text: done });
          return { kind: 'json', status: 200, obj: { ok: true, userText: asr.text, reply: done, audioSeconds: asr.audioSeconds, route: 'send' } };
        }
      }

      const intent = parseVoiceIntent(asr.text);
      if (intent !== undefined) {
        const done = await runVoiceIntent(intent, petId);
        if (done !== undefined) {
          state.writePet(petId, 'say', { text: done });
          return { kind: 'json', status: 200, obj: { ok: true, userText: asr.text, reply: done, audioSeconds: asr.audioSeconds, intent: intent.kind } };
        }
      }
      // ── 任务分流：不是上面那些开关指令，就看是不是"能做的活"──
      //
      // 这一段是**必须的**：早先只认 parseVoiceIntent（开关/开应用/搜），
      // 像「打开微信给某人发消息」「在DSH上新建项目做个转盘」都落进了普通聊天——
      // 大模型思考几秒回一句话，但什么都没做。这就是"回应了却没执行"的根因。
      if (intent === undefined) {
        const routed = routeTask(asr.text);
        if (routed.kind === 'self') {
          const done = await runSelfAction(routed.action);
          if (done !== undefined) {
            // 写气泡：早先这里直接 return，只把 reply 交给调用方播声音，
            // 气泡叶子没写——所以你听得到她说话，却看不到字。
            state.writePet(petId, 'say', { text: done });
            return { kind: 'json', status: 200, obj: { ok: true, userText: asr.text, reply: done, audioSeconds: asr.audioSeconds, route: 'self' } };
          }
        } else if (routed.kind === 'session') {
          // 只有你明确说了「新建项目/新建会话/在DSH…」才建会话
          // 其余（chat）落下去走正常对话——她本来就会聊天
          const sel = resolveCurrentModel();
          const created = await createTaskSession(
            ctx.get('agents', false) as Parameters<typeof createTaskSession>[0],
            routed.prompt,
            sel === undefined ? {} : { provider: sel.provider, model: sel.model },
          );
          const reply = created.ok
            ? `好，我在 DSH 开了个会话去做：${created.title}`
            : `没能开会话：${created.message}`;
          state.writePet(petId, 'say', { text: reply });
          return { kind: 'json', status: 200, obj: { ok: true, userText: asr.text, reply, audioSeconds: asr.audioSeconds, route: 'session' } };
        }
      }

      // ── 语音对话里的「主动识屏」──

      // ── 语音对话里的「主动识屏」──
      //
      // 主人原话：「我在干嘛」这种话，她应该自己去看一眼再答，而不是瞎猜。
      // 但每句都看太贵，所以按 sight.json 的档位判断：
      //   off   从不主动看 / auto 命中关键词才看 / always 每轮都看
      // 帧数也可调（1 = 最省，3~5 = 能看出画面变化）。
      //
      // 看的结果不写记忆（只是一次性上下文），省得把截图描述灌满对话历史。
      const sightConf = readSightConfig();
      let preSight: { note: string; images: Uint8Array[] } | undefined;
      // 明确说「看看/看一下」时**强制看**，不再受 voiceVision 档位限制
      // （off 档是「别主动偷看」，不是「主人让你看你也不看」）。
      const wantsLook = intent?.kind === 'look-now' || shouldLookAtScreen(asr.text, sightConf.voiceVision);
      if (wantsLook) {
        try {
          const plan = framePlan(sightConf.voiceFrames, sightConf.voiceFrameGapMs);
          const frames = await captureFrames(plan.count, plan.gapMs);
          preSight = {
            note:
              frameCaption(plan.count, plan.gapMs) +
              '\n（注意：截图来自系统屏幕；桌宠窗口本身被排除在截图外，所以画面里看不到你自己。' +
              '主人问「你什么样子」时，按你对自己形象的了解回答；画面里有什么就如实说，不要回「没什么可看的」。）',
            images: frames.map((f) => Uint8Array.from(Buffer.from(f.dataUrl.split(',')[1] ?? '', 'base64'))),
          };
          console.log(`[dsh-whale-girl] 语音对话主动识屏：${plan.count} 帧（档位 ${sightConf.voiceVision}）`);
        } catch (e) {
          // 看一眼失败不能影响对话本身——她仍然可以只靠文字回答
          console.warn('[dsh-whale-girl] 语音识屏失败，按纯文本继续：' + (e instanceof Error ? e.message : String(e)));
        }
      }

      // 限流回落已经下沉到 chatWithPet 里（文字与语音共用同一处），这里只负责把结果转出去。
      // 语音对话：**不**让桌面窗念（调用方自己合成播放），否则同一句播两遍
      // 语音链路默认用**快模型**：对话模型可能是重推理模型（实测一句 18~33 秒），
      // 语音里等这么久就没法聊了。快模型 + 语音专用短回复，端到端才能压到个位数秒。
      const final = await chatWithPet(petId, asr.text, pickFastVisionModel(), false, preSight, 'voice');

      if (!final.ok) return { kind: 'json', status: 200, obj: final };
      return {
        kind: 'json',
        status: 200,
        obj: {
          ok: true,
          userText: asr.text,
          reply: final.text ?? '',
          audioSeconds: asr.audioSeconds,
          ...(final.fellBackTo === undefined ? {} : { fellBackTo: final.fellBackTo }),
        },
      };
    }

    // 动画文件：/dsh-whale-girl/thumb/<素材根>/<file>，扩展名 webm（默认）/ mov（macOS 定制）。
    // 素材归属按「是否存在该宠物的独立素材目录 `pet/<petId>-animation/`」判定：
    //   - 存在（pet pack 宠物）：只查自己的目录，查不到即 404 显式报错——绝不混用
    //   - 不存在（**所有主配置宠物**，main 与用户添加的任意多只）：主素材链
    //     main-animation/<webm|mov> 优先 → 包内 assets/<webm|mov>（与宠物数量无关，多只共用）
    // mov（HEVC-with-Alpha）为 macOS Safari/WKWebView 定制格式：默认不随包发布，
    // 用户从 GitHub Release（assets-mov）下载后放 main-animation/mov/，并把客户端播放
    // 扩展名常量（src/shared/constants.ts 的 ANIMATION_EXT / 产物 lib/client.js）改为 .mov。
    // 注意：font / pic 是扁平的 /<scope>/<file>，只有 thumb 是 /<scope>/<petId>/<file>——
    // 这里先拆 scope，再按 scope 各自拆剩余段，避免 font/pic 被误当作 petId 吞掉文件段。
    const [scope, ...restParts] = rest.split('/');
    if (scope === 'font') {
      const fontRoot = join(PACKAGE_ROOT, 'assets', 'fonts');
      const fontFile = resolveExisting(fontRoot, restParts.join('/'));
      if (fontFile === undefined) return { kind: 'text', status: 404, body: 'dsh-whale-girl: font not found' };
      const ext = fontFile.slice(fontFile.lastIndexOf('.')).toLowerCase();
      return { kind: 'file', file: fontFile, contentType: MIME[ext] ?? 'application/octet-stream' };
    }

    // 通知图标：/dsh-whale-girl/pic/<file> → 包内 assets/pic（方形 png，系统通知 icon 用）
    // 表情包：/dsh-whale-girl/pic/memes/<素材根>/<名称>.png → 按素材根走 memeDirsFor 的目录链
    // （种类独占目录 → 用户目录 → 包内），与 /thumb 同一套素材归属语义；名称含中文，URL 段已在上方解码。
    // 旧的两段形式 /pic/memes/<名称>.png 保留：等价于素材根 main 的目录链（未升级的客户端照常取到包内图）。
    if (scope === 'pic') {
      if (restParts[0] === 'memes') {
        const segs = restParts.slice(1);
        // 段数 ≥ 2 = <素材根>/<名称…>；恰好 1 段 = 旧扁平形式。表情包名称即文件名（不含子目录），
        // 所以两种形式不歧义；素材根与 /thumb 的 petId 同规矩：含分隔符 / 保留字符即显式 400。
        const scoped = segs.length >= 2;
        const assetRoot = scoped ? segs[0] : 'main';
        if (scoped && (assetRoot.length > 64 || ID_FORBIDDEN.test(assetRoot))) {
          return { kind: 'text', status: 400, body: 'dsh-whale-girl: invalid asset root' };
        }
        const rel = (scoped ? segs.slice(1) : segs).join('/');
        let picFile: string | undefined;
        for (const dir of memeDirsFor(assetRoot)) {
          picFile = resolveExisting(dir, rel);
          if (picFile !== undefined) break;
        }
        if (picFile === undefined) return { kind: 'text', status: 404, body: 'dsh-whale-girl: pic not found' };
        const ext = picFile.slice(picFile.lastIndexOf('.')).toLowerCase();
        return { kind: 'file', file: picFile, contentType: MIME[ext] ?? 'application/octet-stream' };
      }
      const picRoot = join(PACKAGE_ROOT, 'assets', 'pic');
      const picFile = resolveExisting(picRoot, restParts.join('/'));
      if (picFile === undefined) return { kind: 'text', status: 404, body: 'dsh-whale-girl: pic not found' };
      const ext = picFile.slice(picFile.lastIndexOf('.')).toLowerCase();
      return { kind: 'file', file: picFile, contentType: MIME[ext] ?? 'application/octet-stream' };
    }

    if (scope !== 'thumb') {
      return { kind: 'text', status: 400, body: 'dsh-whale-girl: expected /dsh-whale-girl/thumb/<petId>/<file>' };
    }
    // thumb 是三段式：/<scope>/<petId>/<file>——从这里再拆宠物 id 与文件名
    const [petId, ...nameParts] = restParts;
    if (!petId || nameParts.length === 0) {
      return { kind: 'text', status: 400, body: 'dsh-whale-girl: expected /dsh-whale-girl/thumb/<petId>/<file>' };
    }
    // petId 是**标识符**（= pet/<名>-animation/ 的 <名>，来源是 pet/ 下的文件名前缀），不是路径片段：
    // 含分隔符/保留字符即显式 400，早于任何路径拼接判定。合法名（含中文）照常——
    // 用非法字符类而不是 ASCII 白名单。非法输入不再静默回落到主素材池（攻击尝试与"没有独立素材"可区分），
    // 也给下面的 resolveAsset 之外再留一道结构性防线。
    if (ID_FORBIDDEN.test(petId)) {
      return { kind: 'text', status: 400, body: 'dsh-whale-girl: invalid pet id' };
    }
    const fileName = nameParts.join('/');
    const ext = fileName.slice(fileName.lastIndexOf('.')).toLowerCase();
    if (ext !== '.webm' && ext !== '.mov') {
      return { kind: 'text', status: 400, body: 'dsh-whale-girl: unsupported animation format (expected .webm or .mov)' };
    }
    // 素材归属（按是否存在该宠物的独立素材目录判定，绝不静默混用）：
    //   - 存在 `pet/<petId>-animation/`（pet pack 宠物，URL 段 = 素材根 assetRoot）：
    //     只查自己的目录，查不到即 404 显式报错——绝不回落别的素材
    //   - 不存在（**所有主配置宠物**：main 及用户添加的任意多只，共用全局动画池）：
    //     主素材链——用户 main-animation/<ext 子目录> 优先，其次包内 assets/<ext 子目录>
    // extraAnimDir 必须先过 resolveAsset：petId 是解码后的 URL 段，Windows 上 %5C 解出的
    // 反斜杠不会被 rest.split('/') 切开，直接 join 会让 `..\..\x` 逃出用户根读盘。
    const extraAnimDir = resolveAsset(petConfigDir, petId + '-animation');
    const file =
      extraAnimDir !== undefined && existsSync(extraAnimDir)
        ? resolveExisting(extraAnimDir, fileName)
        : (resolveExisting(userRootFor(ext), fileName) ?? resolveExisting(assetRootFor(ext), fileName));
    if (file === undefined) return { kind: 'text', status: 404, body: 'dsh-whale-girl: asset not found' };
    return { kind: 'file', file, contentType: MIME[ext] ?? 'application/octet-stream' };
  };

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          try {
            // 全局热键事件流：长连接、自己接管响应，不走 handlePetRoute 的 RouteResult 契约
            // （那条契约的每个分支都会立刻结束响应）。路径与页面共用 hotkey.ts 的常量。
            const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
            if (pathname === ROUTE_PREFIX + HOTKEY_STREAM_PATH) {
              if ((req.method ?? 'GET') !== 'GET') {
                res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
                res.end('method not allowed');
                return;
              }
              voiceHotkeyHub.subscribe(res, voiceHotkeyStatus);
              return;
            }
            const body = req.method === 'PUT' || req.method === 'POST' ? await readBody(req) : undefined;
            const result = await handlePetRoute(req.url ?? '/', req.method ?? 'GET', body);
            if (result.kind === 'json') sendJson(res, result.status, result.obj, result.headers);
            else if (result.kind === 'text') sendText(res, result.status, result.body);
            else if (result.kind === 'buffer') sendBuffer(res, result.status, result.body, result.contentType);
            else sendFile(res, result.file, result.contentType); // 非 async：流在 open 后自己 pipe，错误内部收口
          } catch (e) {
            sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
          }
        },
      }),
    'dsh-whale-girl: /dsh-whale-girl asset route',
  );

  // 语音 worker 的生命周期：插件卸载/HMR 重载时杀掉常驻的 Python 进程，
  // 否则每次重载都会多留一个孤儿进程（它还会占着管道不退出）。
  ctx.effect(() => () => disposeVoiceWorkers(), 'dsh-whale-girl: voice workers');

  // QQ 群聊已拆成独立插件：桌宠卸载时不再需要处理 QQ 连接。

  // 全局语音热键：随插件启停。重载时必须把轮询进程收掉再重建，
  // 否则每次重载会多一个 PowerShell 在后台空转、还会重复推 DOWN/UP。
  ctx.effect(() => {
    restartVoiceHotkey();
    return () => {
      voiceHotkeyWatcher?.stop();
      voiceHotkeyWatcher = undefined;
      voiceHotkeyHub.close();
    };
  }, 'dsh-whale-girl: global voice hotkey');

  // 主动识屏：按配置启动定时器；插件卸载时清掉，免得重载后叠出两个定时器
  // （两个定时器 = 每轮截两次屏、说两遍话，而且都会花钱）。
  ctx.effect(() => {
    armSightTimer();
    return () => {
      if (sightTimer !== null) {
        clearTimeout(sightTimer);
        sightTimer = null;
      }
    };
  }, 'dsh-whale-girl: sight timer');

  // 代打：按配置启动急停监听；插件卸载时**必须**停掉那个常驻轮询进程，
  // 否则每重载一次就多留一个 PowerShell 在后台空转（而且它一直在读键盘状态）。
  ctx.effect(() => {
    void rearmAutoplay(readAutoplayConfig());
    return () => {
      stopEstopWatcher?.();
      stopEstopWatcher = undefined;
      // 卸载时无条件置为「停止」，防止热重载期间留下一个可执行的循环
      playLoop.stop('dispose');
      clearThinkingBubble();
      autoplayEstop.stop('manual');
    };
  }, 'dsh-whale-girl: autoplay estop');

  // 工作状态联动：监听 DSH 会话事件 → 聚合"当前活动状态"（WorkStatusStore → 展示快照）。
  // 消费的事件：turn/start、user/message（goal 续跑轮判定）、tool/call（update_goal 收尾判定）、
  // tool/result、approval/asked、turn/end、todo/write（只更新任务详情文案，不切档位）。
  // 纯监听不调用模型；有宠物启用 workStatusEnabled 时才被浏览器侧消费（host 侧恒轻量监听）。
  ctx.effect(() => {
    const dispose = ctx.on('session/event', (session: unknown, event: unknown) => {
      const type = (event as { type?: string } | null)?.type;
      if (!type) return;
      const sessionId = String(
        (session as { id?: unknown; header?: { id?: unknown } } | null)?.header?.id ??
          (session as { id?: unknown } | null)?.id ??
          'unknown',
      );
      if (type === 'todo/write') {
        // 任务详情文案：只写**该会话**的条目（state/task 同源，不再有全局字段，也就不可能串会话）。
        // 会话没有活动条目（已空闲/已清理）→ 不动：它不会被展示，写进去只会成为一条"幽灵文案"。
        // 清单里再无 in_progress/pending 时 currentTaskFromTodo 返回 null，等于把旧文案清掉、
        // 气泡回落到档位文案（issue #59 缺陷 3：档位文案不该被一条历史记录永久屏蔽）。
        if (workStatus.has(sessionId)) {
          workStatus.setTask(
            sessionId,
            currentTaskFromTodo(event as { data?: { todos?: Array<{ status?: string; content?: string }> } }),
          );
          publishWorkStatus(); // 任务文案变化也要写 S（气泡内容靠它更新）
        }
        return;
      }
      if (type === 'user/message') {
        // 目标续跑轮判定：自动轮的消息带 source.kind==='goal'（round>0），该轮属自动续跑，
        // 其 turn/end completed 只是"本轮完成"，不是整个任务完成
        const source = (event as { data?: { source?: { kind?: string } } })?.data?.source;
        if (source?.kind === 'goal') {
          const flags = turnFlags.get(sessionId) ?? { goalRound: false, closing: null };
          flags.goalRound = true;
          turnFlags.set(sessionId, flags);
        }
        return; // user/message 不驱动档位动画
      }
      if (type === 'turn/start') {
        turnFlags.set(sessionId, { goalRound: false, closing: null }); // 新一轮：清 turn 级标志
        // 新一轮也开始新的任务上下文：清掉上一轮留下的任务详情文案（issue #59），否则它会一直挂着。
        // 代价：goal 续跑这类多轮任务，每轮开头会回落一瞬档位文案，直到本轮（通常在开头几步内）
        // 再写一次 todo 清单。
        workStatus.setTask(sessionId, null);
        publishWorkStatus(); // 清掉上一轮任务文案也要写 S
      }
      if (
        type === 'tool/call' &&
        String((event as { data?: { name?: unknown } })?.data?.name ?? '') === GOAL_UPDATE_TOOL
      ) {
        // update_goal complete/blocked = 本轮是该目标的收尾轮，其 completed 才是真完成
        const action = goalUpdateAction(String((event as { data?: { arguments?: unknown } })?.data?.arguments ?? ''));
        if (action) {
          const flags = turnFlags.get(sessionId) ?? { goalRound: false, closing: null };
          flags.closing = action;
          turnFlags.set(sessionId, flags);
        }
      }
      const next = reduceWorkStatus(
        event as { type?: string; data?: Record<string, unknown> & { reason?: { kind?: string } } },
        turnFlags.get(sessionId),
      );
      if (!next) {
        // turn/end 的 null（aborted / 未知 kind）＝该会话回合已结束：清掉会话状态，让展示回到空闲或
        // 落到其他活跃会话，防止回合被打断后永久卡在上一档；其他事件的 null 是"不关心"，忽略。
        if (type === 'turn/end') {
          turnFlags.delete(sessionId);
          cancelTerminalCleanup(sessionId); // 条目都要清了，别留一个到点后无事可做的定时器
          workStatus.clear(sessionId); // 条目连同任务详情文案一起消失（clear 内部会重算展示）
          publishWorkStatus(); // 回合被打断 → 回到空闲：前端据此收起常驻气泡
        }
        return;
      }
      const seq = Number((event as { seq?: unknown }).seq ?? 0);
      // 同会话同状态不重复更新（防刷屏）；不同状态才改写并重算展示
      if (!workStatus.setState(sessionId, next, seq)) return;
      publishWorkStatus(); // 档位变了 → 写 S（前端据此切动画 + 气泡）
      // 终态只展示短暂窗口后自动清理：陈旧完成态不再浮上来（Bug 3 的一环，顺带缓解 Bug 2 残留）。
      // 回到非终态则取消那次待执行的清理——否则它到点时会话已非终态，既不清也不重排，
      // 条目（连同旧任务文案）就永久留下了。
      if (next === 'success' || next === 'error') scheduleTerminalCleanup(sessionId);
      else cancelTerminalCleanup(sessionId);
    });
    return () => {
      dispose();
      for (const t of terminalTimers.values()) clearTimeout(t);
      terminalTimers.clear();
    };
  }, 'dsh-whale-girl: work-status session events');

  // 系统通知：监听 DSH 宿主事件 → 生成通知帧入队（浏览器轮询 /state 读到后弹 toast）。
  // 与 work-status 同一 session/event 源，但职责各自独立（通知帧 = 事件 → toast 的一对一映射，
  // 不做状态聚合）。帧契约与 shared/notify.ts 完全一致，浏览器侧映射零改动。
  //   事件源：turn/end（完成/失败/截断）、approval/asked（权限申请）、
  //          tool/call（ask_user_question：用户选择）、agent/error（无回合位置失败，0.1.5 新增）。
  //   两道门：会话门 #82（shouldNotifySession：子代理/委派不发）+ 活动门 #114（只拦「对话完成」，
  //          延迟确认这条会话确实没活了再弹，见上方 scheduleCompletionNotify）。
  // 纯监听不调用模型；通知是浏览器网页端能力，桌面模式不消费本队列（不影响任何宠物行为）。
  ctx.effect(() => {
    const sessionDispose = ctx.on(
      'session/event',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (session: any, event: any) => {
        // 会话门（issue #82）：子代理 / 委派会话不发通知——你等的是父对话，不是某一路子代理跑完。
        // 判据用 header.origin（不是 parentSession，那会把普通 fork 的主对话一起静音），
        // 判据不可用时放行，绝不把通知整体打哑。详见 notify-events.ts 的 shouldNotifySession。
        if (!shouldNotifySession(session)) return;
        // 活动门（issue #114）：「对话完成」延迟确认这条会话确实没活了再弹——团队会话里 Lead 的
        // 这一轮结束 ≠ 团队收工，成员还在跑时弹「对话完成」是误报。生成失败/输出截断、权限申请、
        // 用户选择不过这道门，直接放行（理由见 notify-events.ts 的 isCompletionTurnEnd）。
        if (isCompletionTurnEnd(event)) {
          scheduleCompletionNotify(sessionIdOf(session), event);
          return;
        }
        const frame = reduceNotifyFrame(event as Parameters<typeof reduceNotifyFrame>[0]);
        if (frame) pushNotifyFrame(frame);
      },
    );
    // agent/error（agent-loop dispatch.emit）：无回合位置的生成失败；0.1.5 新增，
    // 旧版无此事件 = 少一条通知（turn/end error 分支已覆盖大部分失败场景），不报错。
    // **两道门都管不到它**：载荷只有 { turn, step, error }，不带会话标识，无从判定来源。
    const errorDispose = ctx.on(
      'agent/error',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (payload: any) => {
        pushNotifyFrame(agentErrorFrame(payload?.error));
      },
    );
    return () => {
      // 卸载时清掉待查的定时器：否则插件已卸载，到点还去写一次 S
      for (const t of notifyActivityTimers.values()) clearTimeout(t);
      notifyActivityTimers.clear();
      sessionDispose();
      errorDispose();
    };
  }, 'dsh-whale-girl: notify frames');

  // /whale-balance 斜杠命令：触发一次余额刷新（写 S → 前端 1s 轮询看到后弹气泡）。
  // fire-and-forget：回执不等外部 API（查询可能要几秒），立刻回；结果一律从 S 看
  // （成功播档位动画 + 余额气泡；服务商不支持 / 缺凭证 / 抓取失败则弹文字说明气泡，绝不静默）。
  //
  // 命令名一律带 `whale-` 前缀：commands 是**全局命名空间**，同名注册会直接抛
  // `command "balance" is already registered` 并让整个插件 activation 失败
  // （上游 dsh-pet 用的是裸名 balance/pet/chat，两个插件并存时必然撞车）。
  ctx.effect(
    () =>
      ctx.commands.register({
        name: 'whale-balance',
        description: '手动触发鲸鱼娘余额显示（立即弹出余额气泡）',
        handler: () => {
          void refreshBalance(true); // manual：命令是用户主动敲的
          return { kind: 'success', text: '已触发鲸鱼娘余额显示' };
        },
      }),
    'dsh-whale-girl: /whale-balance command',
  );

  // 余额周期刷新：host 侧唯一定时器（前端不再有任何余额定时器）。
  // 周期**每次重新读配置** eventsRefreshSec.balance → 改了配置下一拍自然跟上。
  // 没有任何启用余额的宠物时跳过查询：尊重配置，不白花外部 API 调用。
  ctx.effect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    function arm(sec: number): void {
      if (disposed) return;
      timer = setTimeout(() => void tick(), Math.max(1000, sec * 1000));
    }
    async function tick(): Promise<void> {
      let sec: number;
      try {
        const cfg = readAllConfig(configPaths);
        sec = balancePeriodSec(cfg);
        // 没有任何启用余额的宠物 → 不查（省外部调用）；配置改了下一拍自然跟上
        if (flattenPetList(cfg).some((p) => p.balanceEnabled === true)) await refreshBalance();
      } catch {
        // 读配置抛错 = 安装损坏（readAllConfig 只在**内置默认**缺失/损坏时抛，用户层写坏只会告警回退）：
        // 不再重排——每 30 分钟重试一次没有意义，而且会白占一个常驻定时器。修好安装后重启 DSH 即可。
        return;
      }
      arm(sec);
    }
    void tick(); // 启动即拉一次（与改造前客户端"先拉一次再定时"一致）
    return () => {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, 'dsh-whale-girl: balance poll');

  // 碎碎念周期：host 侧调度（前端不再有任何碎碎念定时器）。
  // 一拍 = 读一次配置 + 给"到点"的宠物各生成一句；下一拍按**最短周期**排（多数部署只有一个
  // 周期值，那它就是那个值）。用"读一次配置 + 逐宠物比对 lastWhisperAt"而不是每宠一个定时器：
  // 宠物随配置增删、周期随条目改，固定拍天然跟上，不用维护一堆定时器的生命周期。
  ctx.effect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    function arm(sec: number): void {
      if (disposed) return;
      timer = setTimeout(() => void tick(), Math.max(1000, sec * 1000));
    }
    function tick(): void {
      let next = 300;
      try {
        const cfg = readAllConfig(configPaths);
        const now = Date.now();
        let min = Infinity;
        for (const pet of flattenPetList(cfg)) {
          const petId = String(pet.id ?? '');
          if (!petId || pet.whisperEnabled !== true) continue;
          const sec = whisperPeriodSec(cfg, petId);
          min = Math.min(min, sec);
          if (now - (lastWhisperAt.get(petId) ?? 0) < sec * 1000) continue;
          lastWhisperAt.set(petId, now);
          // 不 await：生成要几秒，别把调度拍拖住（每只宠物独立生成，互不阻塞）
          void publishWhisper(petId).catch(() => {});
        }
        if (Number.isFinite(min)) next = min;
      } catch {
        // 读配置抛错 = 安装损坏（同余额定时器）：不再重排，别白占常驻句柄
        return;
      }
      arm(next);
    }
    void tick(); // 启动即生成一次（与改造前客户端首拉就生成一致）
    return () => {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, 'dsh-whale-girl: whisper poll');

  // /pet 斜杠命令：选择「当前桌宠」（/chat 对话的目标）。浏览器端另有 commandUi 装饰的选择框
  // （裸输 /pet 回车或菜单点选时弹出，选中后提交 /pet <id> 走同一 handler）；手输参数认 id 或名字
  // （name 可重复：唯一命中才认，重名报错列出候选 id）。
  ctx.effect(
    () =>
      ctx.commands.register({
        name: 'whale-pet',
        description: '选择鲸鱼娘（/whale-chat 对话的目标；支持选择框或手输 id/名字）',
        input: { hint: '[宠物 id 或名字]（留空查看当前）' },
        handler: ({ rawInput }: { rawInput: string }) => {
          const arg = rawInput.trim();
          let eff: Record<string, unknown>[];
          try {
            eff = effectivePetList();
          } catch {
            eff = [];
          }
          if (!arg) {
            const cur = resolveActivePetId();
            const found = eff.find((p) => String(p.id) === cur);
            return {
              kind: 'success',
              text: '当前桌宠：' + (found ? petDisplayName(found) : cur || '（无可交互桌宠）'),
            };
          }
          const byId = eff.find((p) => String(p.id) === arg);
          if (byId) {
            activePetId = String(byId.id);
            return { kind: 'success', text: '已选择桌宠：' + petDisplayName(byId) };
          }
          const byName = eff.filter((p) => petDisplayName(p) === arg);
          if (byName.length === 1) {
            activePetId = String(byName[0].id);
            return { kind: 'success', text: '已选择桌宠：' + petDisplayName(byName[0]) };
          }
          if (byName.length > 1) {
            return {
              kind: 'error',
              text:
                '「' +
                arg +
                '」有 ' +
                byName.length +
                ' 只桌宠（id：' +
                byName.map((p) => String(p.id)).join('、') +
                '），请用 id 指定',
            };
          }
          return { kind: 'error', text: '找不到桌宠「' + arg + '」（id 或名字都行；/pet 回车可打开选择框）' };
        },
      }),
    'dsh-whale-girl: /pet command',
  );

  // /chat 斜杠命令：与当前桌宠对话。无参数 = 碎碎念一句（手动语义：不受 whisperEnabled 门控，
  // 那个字段只关自动周期）；有参数 = 正常对话（走 chatWithPet 同一条路径：记忆 + 人设 + 写盘）。
  // 两个分支都是 **fire-and-forget**：回执不等模型（生成要几秒），文本一律写进 S 的
  // pets.<id>.say，前端 1s 轮询 /state 后弹气泡——与 /balance 命令同一套语义（回执不带数据）。
  ctx.effect(
    () =>
      ctx.commands.register({
        name: 'whale-chat',
        description: '与鲸鱼娘对话：留空 = 碎碎念一句；输入消息 = 正常对话',
        input: { hint: '[消息]（留空 = 碎碎念）' },
        handler: ({ rawInput }: { rawInput: string }) => {
          const petId = resolveActivePetId();
          if (!petId) return { kind: 'error', text: '没有可交互的桌宠' };
          const text = rawInput.trim();
          if (!text) {
            void publishWhisper(petId).catch((e: unknown) =>
              console.warn('[dsh-whale-girl] 碎碎念异常：' + (e instanceof Error ? e.message : String(e))),
            );
            return { kind: 'success', text: '已让桌宠碎碎念一句' };
          }
          if (text.length > 2000) return { kind: 'error', text: '消息过长（限 2000 字）' };
          void chatWithPet(petId, text).then((r) => {
            if (!r.ok) {
              console.warn('[dsh-whale-girl] 对话失败 reason=' + r.reason + (r.message ? ' ' + r.message : ''));
            }
          });
          return { kind: 'success', text: '已发送，桌宠马上回应' };
        },
      }),
    'dsh-whale-girl: /chat command',
  );

  // 系统通知的宿主监听已在上方注册（notify frames effect）：host 监听 session/event +
  // agent/error 生成通知帧入队，浏览器轮询 /notify 拉取弹 toast（DSH 0.1.5 删除了浏览器侧
  // api.events.mux/host 事件流，通知与宠物一样改走 host 通道，两端行为一致）。

  // 随插件生命周期清理：桌面 Helper 回收（异步下载完成后不再拉起）
  ctx.effect(() => () => {
    disposed = true;
    stopHelper('dsh-host-stop');
  });

  // 路由就绪后拉起桌面 Helper（Electron 缺失时仅告警，不影响 DSH 与浏览器 overlay）
  startHelper();
}
