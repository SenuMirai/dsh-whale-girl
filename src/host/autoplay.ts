/**
 * 代打：看屏幕 → 想一步 → 动手。
 *
 * ── 状态机（每一轮都要走完）──
 *
 * ```
 * 急停就绪？ → 前台窗口在白名单？ → 截图 → watch 模式问模型 → 解析动作
 *   → 再确认一次急停 → 注入 → 记录日志
 * ```
 *
 * ── 三条必须守住的边界 ──
 *
 * 1. **急停优先**：每一步动作前后都查 `estop.canAct()`。查一次不够——
 *    模型推理期间主人可能已经动了鼠标。
 * 2. **空跑模式（dry run）**：默认**只打印打算做什么，不真的执行**。
 *    必须显式关掉才会真注入。第一版就该这样上线，让主人先看几轮日志确认判断合理。
 * 3. **动作必须可解析**：模型只能从固定动作集里选（见 `parseActionPlan`）。
 *    解析不了就跳过这一轮，绝不猜着按。
 *
 * ── 为什么决策和动作要分开 ──
 *
 * 「想」走 `watch` 模式（客观描述，不说话），「做」走 `performInput`。
 * 中间夹一次本地的动作解析与白名单校验——这样即使模型输出跑偏，
 * 也不会变成一串乱按。
 */

import type { EstopController } from './estop';
import type { InputAction } from './input';

/**
 * 中文游戏名 ↔ 窗口英文标题。
 *
 * 为什么需要：主人填白名单时用的是**游戏名**（「苏丹的游戏」），而 Windows 窗口标题
 * 往往是英文（`Sultan's Game`）。只做 `title.includes(填的)` 会永远不匹配，
 * 表现就是「点了开始什么都不发生」——循环一直在等「白名单窗口」。
 * 这张表只处理**确实存在的中英对应**，不用模糊猜测（猜错会让她对别的窗口动手）。
 */
const GAME_TITLE_ALIASES: Record<string, string[]> = {
  苏丹的游戏: ["sultan's game", 'sultans game'],
  星露谷物语: ['stardew valley'],
  群星: ['stellaris'],
  戴森球计划: ['dyson sphere program'],
  环世界: ['rimworld'],
  泰拉瑞亚: ['terraria'],
  我的世界: ['minecraft'],
  缺氧: ['oxygen not included'],
  文明6: ['civilization vi', 'civilization 6'],
  饥荒: ["don't starve", 'dont starve'],
  无人深空: ['no man’s sky', "no man's sky"],
  边缘世界: ['rimworld'],
};

/** 归一化标题：小写 + 去空格/标点（`Sultan's Game` 与 `sultans game` 等价） */
function normalizeTitle(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s'’·:：\-_.,!?()（）[\]【】]/g, '');
}

/**
 * 当前前台窗口标题是否命中白名单（空数组 = 不限制）。
 *
 * 判据（任一命中即可）：
 * 1. 原样包含（中文窗口标题的常见情况）；
 * 2. 归一化后包含（忽略大小写 / 空格 / 标点）；
 * 3. 白名单里的中文名在别名表里有对应英文标题，且窗口标题命中其中之一。
 */
export function windowMatchesAllowed(title: string, allowedTitles: string[]): boolean {
  if (allowedTitles.length === 0) return true;
  const normalized = normalizeTitle(title);
  for (const raw of allowedTitles) {
    const key = typeof raw === 'string' ? raw.trim() : '';
    if (key === '') continue;
    if (title.includes(key)) return true;
    const normalizedKey = normalizeTitle(key);
    if (normalizedKey !== '' && normalized.includes(normalizedKey)) return true;
    for (const alias of GAME_TITLE_ALIASES[key] ?? []) {
      const normalizedAlias = normalizeTitle(alias);
      if (normalizedAlias !== '' && normalized.includes(normalizedAlias)) return true;
    }
  }
  return false;
}

/** 代打配置（存 `autoplay.json`，与宠物/语音/识屏配置都解耦） */
export type AutoplayConfig = {
  /** 总开关，默认关 */
  enabled: boolean;
  /** 空跑：只打印计划不注入。**默认 true** */
  dryRun: boolean;
  /** 急停键（必须在 estop 的允许集合里） */
  estopKey: string;
  /** 只在这些窗口标题下动手（空 = 不限制，不推荐） */
  windowTitles: string[];
  /**
   * 代打专用的识图模型（空 = 跟随对话模型）。
   *
   * 为什么单开一项：对话模型往往是「会思考」的重模型（实测一轮 15~60 秒、
   * 思考还会把输出预算吃光导致空回复）。代打要的是**快**、能看图、会按格式吐一行，
   * 用独立配置才不会被聊天模型拖死。
   */
  visionModel?: { provider: string; model: string };
};

export const DEFAULT_AUTOPLAY_CONFIG: AutoplayConfig = {
  enabled: false,
  dryRun: true,
  estopKey: 'f12',
  windowTitles: [],
};

/** 归一化：非法值一律夹到安全的一侧（关掉 / 空跑 / 默认键） */
export function normalizeAutoplayConfig(raw: Partial<AutoplayConfig> | undefined): AutoplayConfig {
  const titles = Array.isArray(raw?.windowTitles)
    ? raw.windowTitles.filter((t): t is string => typeof t === 'string' && t.trim() !== '').map((t) => t.trim())
    : [];
  const vision = raw?.visionModel as { provider?: unknown; model?: unknown } | undefined;
  const visionModel =
    vision !== undefined &&
    typeof vision.provider === 'string' &&
    vision.provider.trim() !== '' &&
    typeof vision.model === 'string' &&
    vision.model.trim() !== ''
      ? { provider: vision.provider.trim(), model: vision.model.trim() }
      : undefined;
  return {
    // 只有显式 true 才算开——配置损坏时绝不能变成「允许动手」
    enabled: raw?.enabled === true,
    // 同理：只有显式 false 才关掉空跑
    dryRun: raw?.dryRun !== false,
    estopKey: typeof raw?.estopKey === 'string' && raw.estopKey.trim() !== '' ? raw.estopKey.trim() : 'f12',
    windowTitles: titles.slice(0, 20),
    ...(visionModel === undefined ? {} : { visionModel }),
  };
}

/** 模型能选的动作用一个紧凑的文本格式表达，便于解析与审计 */
export type ActionPlan =
  | { kind: 'noop'; reason: string }
  | { kind: 'act'; actions: InputAction[]; thought: string }
  | { kind: 'invalid'; raw: string; reason: string };

/**
 * 给模型的指令。
 *
 * 关键约束：
 * - **只准输出一行命令**，格式固定，解析器能可靠处理；
 * - **允许 `noop`**：看不懂/不该动就什么都不做（这比乱按安全一万倍）；
 * - **动作条数上限**：一次最多 3 个，避免一口气把整段操作跑完没法中途叫停。
 */
export const AUTOPLAY_PROMPT = `你在替主人操作电脑上的游戏。你会看到当前画面。

请判断**下一步做什么**，并且只输出**一行**，格式必须是下面之一：

click X Y            —— 用鼠标左键点屏幕坐标 (X, Y)
rclick X Y           —— 右键点击（也用来取消弹出来的菜单）
drag X1 Y1 X2 Y2     —— 在 (X1,Y1) 按下左键，拖到 (X2,Y2) 再松开（战棋移动单位必须用这个）
key NAME             —— 按一下某个键（NAME 用英文：w a s d space enter esc tab up down left right 0-9）
keydown NAME         —— 按住
keyup NAME           —— 松开
move X Y             —— 只移动鼠标
noop 原因            —— 这一步什么都不做

规则：
1. 一次只输出**一个**动作，或者 noop。不要一次写多个。
2. 坐标用画面像素，左上角是 (0,0)。画面宽高会告诉你。
3. **看不清、不确定、不是游戏界面 → 一律 noop**。乱按比不动危险得多。
4. 不要解释，不要输出第二行，不要用 Markdown。
5. 如果这一屏需要连续操作（比如走一段路），也只输出**当前这一步**。
6. 画面里那个蓝发女仆（Q 版鲸鱼娘）和她头顶的气泡是**助手自己**：不要点她、不要点她的气泡，
   目标是游戏里的按钮/角色/地块。
7. **只要画面确实是游戏**（有角色/棋盘/按钮/关卡），尽量给一个能推进的动作；只有真的看不清、
   不是游戏界面、或正在播不可跳过的动画时才 noop。回合制游戏：没有选中单位就先点一个单位，
   选中了就点目标格，或者按确认/结束回合键。
8. 回合制游戏的常见情况：
   - 弹出对话框/文字提示 → 点一下对话框中央，或按 Z / Enter / 空格 继续；
   - 正在播动画 → 这一轮输出 noop（程序 2.5 秒后会再看一眼）；
   - 地图/棋盘界面 → 先点自己的单位（通常高亮、颜色与敌方不同），选中后再点目标格；
   - 有「结束回合」按钮 → 点它。
9. **先判断现在是不是你的回合**：
   - 画面出现你方单位的高亮/选中框、行动菜单、移动范围格、或「结束回合」按钮 → **是你的回合**：
     选单位 → 点移动目标格 → 交互/攻击；不要因为「不确定」就 noop；
   - 只有出现「敌方回合 / Enemy Turn」字样，或敌方单位正在移动的动画 → 才是对方回合，这时才 noop。
   战棋里通常蓝色/绿色单位是你方，红色是敌方；看颜色和血条上面有没有你的阵营标记。
10. **战棋（Wargroove 这类）的操作方式**：
   - 移动/攻击都是**拖拽**：drag 单位X 单位Y 目标X 目标Y。只 click 不会移动（主人实测）；
   - **画面有菜单时，本轮唯一目标是关掉它**：点菜单里的「取消 / 返回 / 关闭」那一项（通常是菜单最下面一项），
     然后再做别的；**不要用 rclick**——这个游戏的右键也可能打开菜单，越点越乱；
   - 把单位拖到建筑旁的格子 = 占领，拖到敌人旁 = 攻击（然后可能需要再确认一次）。
11. **怎么读 Wargroove 的回合/单位状态**（这些是真实有效的画面规律）：
   - 左上角指挥官头像的**边框颜色** = 当前回合方的颜色；
   - 地图上颜色**鲜艳/高亮**的一侧是当前行动方；**灰暗/降饱和度**的一侧不是当前回合；
   - 单位头顶有**白色小箭头（向上）** = 这个单位本回合**还没行动**；没有箭头的已经行动过；
   - 建筑上的 **Zzz** = 待机；
   - 右下角那个蓝发女仆是**助手 UI**，和战局无关，不要拿她判断任何事。
   先按这几条判断“现在是不是你的回合、还有谁没动”，再决定动作；判断出来了就不要 noop。
12. 如果画面里是「结束回合 / 概览 / 任务 / 取消」这样的竖排菜单：**点最下面的「取消」**把它关掉。
13. **玩家颜色不是固定的**：不要默认「蓝色=我方」。先看左上角指挥官头像/横幅与地图哪边单位同色，
    同色的那一方通常就是玩家；如果游戏档案里写了玩家颜色，以档案为准（例如本机 Wargroove 玩家是红色方「玛丝雅」）。`;

/** 画面上限：一次最多执行的动作数（防御模型输出跑偏） */
const MAX_ACTIONS = 3;

/**
 * 解析模型输出。
 *
 * 刻意做得**保守**：格式不对就返回 invalid，不尝试「猜它的意思」。
 * 猜错的代价是鼠标键盘真的动起来，方向完全不可控。
 *
 * @param raw 模型原始输出
 * @param screen 画面尺寸（用来夹坐标，防止点到屏幕外）
 */
export function parseActionPlan(raw: string, screen: { width: number; height: number }): ActionPlan {
  const text = raw
    // 模型常把命令包在 ``` 里。这里要**取出内容**而不是整块丢掉——
    // 早先直接 replace 成空格，等于把命令也吃了。
    .replace(/```[a-zA-Z]*\n?([\s\S]*?)```/g, '$1')
    .replace(/[`*_#>|]/g, '')
    .trim();
  if (text === '') return { kind: 'invalid', raw, reason: '模型没有输出' };

  // 只取第一行：模型偶尔会多写解释
  const line = (text.split('\n').find((l) => l.trim() !== '') ?? '').trim();
  const lower = line.toLowerCase();

  if (lower.startsWith('noop')) {
    return { kind: 'noop', reason: line.slice(4).trim() || '模型选择不动' };
  }

  const clamp = (v: number, max: number): number => Math.max(0, Math.min(Math.max(0, max - 1), Math.round(v)));
  const twoNums = /^(\d{1,5})\s+(\d{1,5})$/;
  const fourNums = /^(\d{1,5})\s+(\d{1,5})\s+(\d{1,5})\s+(\d{1,5})$/;

  const actions: InputAction[] = [];
  let thought = line;

  if (lower.startsWith('drag ')) {
    const rest = line.slice('drag '.length).trim();
    const m = rest.match(fourNums);
    if (m === null) return { kind: 'invalid', raw, reason: `拖拽坐标格式不对：${rest}` };
    actions.push({
      kind: 'drag',
      fromX: clamp(Number(m[1]), screen.width),
      fromY: clamp(Number(m[2]), screen.height),
      toX: clamp(Number(m[3]), screen.width),
      toY: clamp(Number(m[4]), screen.height),
    });
  } else if (lower.startsWith('click ') || lower.startsWith('rclick ') || lower.startsWith('move ')) {
    const isRight = lower.startsWith('rclick ');
    const isMove = lower.startsWith('move ');
    const rest = line.slice(line.indexOf(' ') + 1).trim();
    const m = rest.match(twoNums);
    if (m === null) return { kind: 'invalid', raw, reason: `坐标格式不对：${rest}` };
    const x = clamp(Number(m[1]), screen.width);
    const y = clamp(Number(m[2]), screen.height);
    if (isMove) actions.push({ kind: 'move', x, y });
    else actions.push({ kind: 'click', x, y, ...(isRight ? { button: 'right' as const } : {}) });
  } else if (lower.startsWith('key ') || lower.startsWith('keydown ') || lower.startsWith('keyup ')) {
    const mode = lower.startsWith('keydown ') ? 'keyDown' : lower.startsWith('keyup ') ? 'keyUp' : 'key';
    const name = line.slice(line.indexOf(' ') + 1).trim().toLowerCase();
    if (name === '') return { kind: 'invalid', raw, reason: '没有给出键名' };
    actions.push({ kind: mode, key: name } as InputAction);
  } else {
    return { kind: 'invalid', raw, reason: `不认识的动作：${line.slice(0, 40)}` };
  }

  if (actions.length === 0) return { kind: 'invalid', raw, reason: '没解析出动作' };
  if (actions.length > MAX_ACTIONS) {
    return { kind: 'invalid', raw, reason: `动作太多（${actions.length} > ${MAX_ACTIONS}）` };
  }
  thought = line;
  return { kind: 'act', actions, thought };
}

/** 一轮代打的结果 */
export type AutoplayRound =
  | { kind: 'stopped'; reason: string }
  | { kind: 'skipped'; reason: string; detail?: string }
  | { kind: 'planned'; thought: string; actions: InputAction[]; executed: boolean }
  | { kind: 'failed'; reason: string; message: string };

/**
 * 跑一轮代打。
 *
 * @param deps 注入的副作用（真实运行时接 screenshot / vision / input；测试时全假）
 * @param config 运行配置（dryRun 默认 true）
 * @param estop 急停控制器
 */
export async function runAutoplayRound(
  deps: {
    /** 抓一张当前画面，返回 JPEG 与尺寸 */
    capture: () => Promise<{ jpeg: Uint8Array; width: number; height: number }>;
    /** watch 模式问模型：这一屏是什么状态 */
    /**
     * watch 模式问模型：这一屏是什么状态。
     * context 是游戏档案 + 最近战况 —— 没有它，模型只看到一帧死图，
     * 既不知道该按什么键，也不知道刚才试过什么。
     */
    describe: (
      jpeg: Uint8Array,
      context: string,
      screen: { width: number; height: number },
    ) => Promise<{ ok: true; text: string } | { ok: false; message: string }>;
    /** 真正执行动作（内部会做窗口白名单校验） */
    perform: (action: InputAction) => Promise<{ ok: true } | { ok: false; message: string }>;
    /** 当前前台窗口标题（用于开跑前的窗口校验） */
    foregroundTitle: () => Promise<string>;
    /** 控制台日志（可替换以便测试） */
    log: (message: string) => void;
    /**
     * 尝试用缓存技能直接出手（省掉视觉模型那 2~4 秒）。
     * 返回 undefined = 没有可用技能，走正常路径。
     * 判据由调用方掌握（通常是「画面几乎没变」才敢复用）。
     */
    trySkill?: (jpeg: Uint8Array) => { name: string; actions: InputAction[] } | undefined;
    /** 学到一招：这一轮的动作在什么画面下有效（以及有没有成功） */
    learnSkill?: (description: string, actions: InputAction[], ok: boolean) => void;
  },
  config: {
    /** true = 只打印不执行（默认） */
    dryRun: boolean;
    /** 只在这些窗口标题下动手（空 = 不限制） */
    allowedTitles: string[];
    /** 每轮最多几步动作（含校验失败的） */
    maxSteps?: number;
    /**
     * 游戏档案 + 最近战况（由调用方用 game-profile / game-memory 拼好）。
     * 空串 = 没有档案，模型只能靠画面猜——那通常会导致瞎按。
     */
    gameContext?: string;
  },
  estop: EstopController,
): Promise<AutoplayRound> {
  /** 游戏档案 + 最近战况：模型靠它知道「这游戏怎么玩、刚才试过什么」 */
  const context = config.gameContext ?? '';
  // ── 第 0 关：急停 ──
  if (!estop.canAct()) {
    const snap = estop.snapshot();
    return { kind: 'stopped', reason: snap.lastReason ?? '已停止' };
  }

  // ── 第 1 关：前台窗口 ──
  if (config.allowedTitles.length > 0) {
    let title = '';
    try {
      title = await deps.foregroundTitle();
    } catch (e) {
      return { kind: 'failed', reason: 'window-check', message: e instanceof Error ? e.message : String(e) };
    }
    if (!windowMatchesAllowed(title, config.allowedTitles)) {
      return { kind: 'skipped', reason: 'window-not-allowed', detail: title || '(无标题)' };
    }
  }

  // ── 第 2 关：截图 ──
  let shot: { jpeg: Uint8Array; width: number; height: number };
  try {
    shot = await deps.capture();
  } catch (e) {
    return { kind: 'failed', reason: 'capture', message: e instanceof Error ? e.message : String(e) };
  }

  // ── 第 2.5 关：技能快路径（**跳过视觉模型**）──
  //
  // Voyager 那套「技能库」在我们这里的落地：完全相同的场景不需要让模型重新看图，
  // 直接重放上次验证过的动作，省下 2~4 秒。判据由调用方掌握（它才知道画面差多少）。
  const cached = deps.trySkill?.(shot.jpeg);
  if (cached !== undefined) {
    if (!estop.canAct()) {
      const snap = estop.snapshot();
      return { kind: 'stopped', reason: snap.lastReason ?? '已停止' };
    }
    if (config.dryRun) {
      deps.log(`[空跑][技能] ${cached.name}`);
      return { kind: 'planned', thought: `[技能] ${cached.name}`, actions: cached.actions, executed: false };
    }
    estop.markInjecting(true);
    let ok = true;
    try {
      for (const action of cached.actions) {
        if (!estop.canAct()) {
          const snap = estop.snapshot();
          deps.log(`[技能] 执行中途急停：${snap.lastReason ?? '已停止'}`);
          return { kind: 'stopped', reason: snap.lastReason ?? '已停止' };
        }
        const result = await deps.perform(action);
        if (!result.ok) {
          ok = false;
          deps.log(`[技能] 动作被拒：${result.message}`);
          break;
        }
      }
    } finally {
      estop.markInjecting(false);
    }
    // 记战绩：失败多会被技能库淘汰（不能一直用错的办法）
    deps.learnSkill?.(cached.name, cached.actions, ok);
    deps.log(`[技能] 重放 ${cached.name}${ok ? '' : '（失败）'}`);
    return { kind: 'planned', thought: `[技能] ${cached.name}`, actions: cached.actions, executed: ok };
  }

  // ── 第 3 关：问模型（这一步耗时可能几秒，期间主人可能已经动了鼠标）──
  const described = await deps.describe(shot.jpeg, context, { width: shot.width, height: shot.height });
  if (!described.ok) {
    return { kind: 'failed', reason: 'describe', message: described.message };
  }

  // ── 第 4 关：解析动作 ──
  const plan = parseActionPlan(described.text, { width: shot.width, height: shot.height });
  if (plan.kind === 'noop') {
    return { kind: 'skipped', reason: 'model-noop', detail: plan.reason };
  }
  if (plan.kind === 'invalid') {
    return { kind: 'skipped', reason: 'unparseable', detail: plan.reason };
  }

  // ── 第 5 关：**动作前**再查一次急停 ──
  // 模型推理通常要 1~3 秒，这期间主人完全可能已经接管鼠标了。
  // 只在开头发查一次是不够的——这正是"急停看起来有、其实没拦住"的典型来源。
  if (!estop.canAct()) {
    const snap = estop.snapshot();
    return { kind: 'stopped', reason: snap.lastReason ?? '已停止' };
  }

  if (config.dryRun) {
    deps.log(`[空跑] 打算：${plan.thought}`);
    return { kind: 'planned', thought: plan.thought, actions: plan.actions, executed: false };
  }

  // ── 第 6 关：执行 ──
  estop.markInjecting(true);
  try {
    for (const action of plan.actions) {
      if (!estop.canAct()) {
        const snap = estop.snapshot();
        deps.log(`[代打] 执行中途急停：${snap.lastReason ?? '已停止'}`);
        return { kind: 'stopped', reason: snap.lastReason ?? '已停止' };
      }
      const result = await deps.perform(action);
      if (!result.ok) {
        deps.log(`[代打] 动作被拒：${result.message}`);
        return { kind: 'failed', reason: 'inject', message: result.message };
      }
    }
  } finally {
    estop.markInjecting(false);
  }

  deps.log(`[代打] 执行：${plan.thought}`);
  // 学到一招：这组动作在这个画面描述下有效，下次同样场景可以直接重放
  deps.learnSkill?.(described.text, plan.actions, true);
  return { kind: 'planned', thought: plan.thought, actions: plan.actions, executed: true };
}
