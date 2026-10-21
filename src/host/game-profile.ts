/**
 * 游戏档案：这个游戏怎么玩、按键是什么、有什么攻略要点。
 *
 * ── 为什么需要它 ──
 *
 * 视觉模型只看一帧画面，它**不可能自己知道**「W 是前进、空格是跳」这种事——
 * 那是游戏外部知识，不在像素里。所以必须有一份存档：主人给的、或联网查来的。
 *
 * ── 设计口径 ──
 *
 * 1. **按类型给预设**：回合制 / 大战略 / 战棋 / RPG / 动作，常见键位直接套。
 * 2. **可覆盖**：每款游戏一份档案，写自己的键位与要点。
 * 3. **攻略可缓存**：联网查到的要点存下来，下次不用再查（省调用、也省时间）。
 */

/** 游戏类型：决定用哪套键位预设、以及每轮给多少思考预算 */
export type GameGenre = 'turn-based' | 'grand-strategy' | 'tactics' | 'rpg' | 'action' | 'custom';

/** 动作名 → 按键。动作名用中文/英文都行，模型看得懂即可 */
export type KeyMap = Record<string, string>;

/** 一个游戏档案 */
export type GameProfile = {
  /** 稳定 id（文件名用它；不含路径分隔符） */
  id: string;
  /** 显示名（也用于匹配窗口标题） */
  title: string;
  genre: GameGenre;
  /** 键位表：动作 → 键名（键名必须在 input.ts 的白名单或 extraKeys 里） */
  keys: KeyMap;
  /** 攻略要点（主人手写或联网查来） */
  notes: string[];
  /**
   * 本局记忆容量（步数）。留空 = 用该类型的预设容量。
   *
   * 为什么允许单游戏覆盖：同为「大战略」，有人一局打十小时，有人只玩两分钟。
   */
  memoryCap?: number;
  /** 最近一次联网检索的结果 */
  guide?: { query: string; summary: string; sources: Array<{ title?: string; url: string }>; atMs: number };
};

/**
 * 类型预设。
 *
 * 只放「几乎所有这类游戏都成立」的键位，不做过度假设——
 * 押错的键会让她在游戏里乱按，比不按更糟。
 */
export const GENRE_PRESETS: Record<Exclude<GameGenre, 'custom'>, KeyMap> = {
  // 回合制（宝可梦一类）：方向选择 + 确认取消
  'turn-based': {
    上: 'up',
    下: 'down',
    左: 'left',
    右: 'right',
    确认: 'enter',
    取消: 'esc',
    菜单: 'tab',
  },
  // 大战略（群星 / 欧陆风云）：暂停、时间流速、地图缩放
  'grand-strategy': {
    暂停: 'space',
    加速: 'a',
    减速: 's',
    确认: 'enter',
    取消: 'esc',
    菜单: 'esc',
  },
  // 战棋：方向移动 + 确认（火焰纹章 / 机器人大战那类）
  tactics: {
    上: 'up',
    下: 'down',
    左: 'left',
    右: 'right',
    确认: 'enter',
    取消: 'esc',
    结束回合: 'space',
  },
  // RPG：WASD 移动 + 交互
  rpg: {
    前: 'w',
    后: 's',
    左: 'a',
    右: 'd',
    交互: 'e',
    确认: 'enter',
    取消: 'esc',
    菜单: 'tab',
  },
  // 动作类：WASD + 攻击/跳跃（速度受限，见 docs）
  action: {
    前: 'w',
    后: 's',
    左: 'a',
    右: 'd',
    攻击: 'j',
    跳跃: 'space',
    交互: 'e',
    取消: 'esc',
  },
};

/** 档案 id 的合法化：只留安全字符，避免拼出奇怪路径 */
export function profileIdFromTitle(title: string): string {
  const cleaned = title
    .trim()
    .toLowerCase()
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, '-');
  return cleaned === '' ? 'untitled' : cleaned.slice(0, 60);
}

/** 归一化：非法输入一律回落到安全值，不抛错（配置手滑不该让插件停摆） */
export function normalizeProfile(raw: Partial<GameProfile> | undefined): GameProfile {
  const title = typeof raw?.title === 'string' && raw.title.trim() !== '' ? raw.title.trim() : '未命名游戏';
  const genre: GameGenre =
    raw?.genre === 'turn-based' ||
    raw?.genre === 'grand-strategy' ||
    raw?.genre === 'tactics' ||
    raw?.genre === 'rpg' ||
    raw?.genre === 'action' ||
    raw?.genre === 'custom'
      ? raw.genre
      : 'custom';

  // 键位：只在 custom 且没有自己的键位时用预设；其余情况以显式给出的为准
  const explicitKeys: KeyMap = {};
  if (raw?.keys && typeof raw.keys === 'object') {
    for (const [action, key] of Object.entries(raw.keys)) {
      if (typeof key === 'string' && key.trim() !== '') explicitKeys[action] = key.trim();
    }
  }
  const preset = genre === 'custom' ? {} : GENRE_PRESETS[genre];
  const keys: KeyMap = { ...preset, ...explicitKeys };

  const notes = Array.isArray(raw?.notes)
    ? raw.notes.filter((n): n is string => typeof n === 'string' && n.trim() !== '').map((n) => n.trim()).slice(0, 50)
    : [];

  const guide =
    raw?.guide !== undefined &&
    typeof raw.guide === 'object' &&
    raw.guide !== null &&
    typeof (raw.guide as { query?: unknown }).query === 'string' &&
    typeof (raw.guide as { summary?: unknown }).summary === 'string'
      ? {
          query: (raw.guide as { query: string }).query,
          summary: (raw.guide as { summary: string }).summary,
          sources: Array.isArray((raw.guide as { sources?: unknown }).sources)
            ? ((raw.guide as { sources: Array<{ title?: unknown; url?: unknown }> }).sources)
                .filter((s): s is { title?: string; url: string } => typeof s?.url === 'string')
                .map((s) => ({ ...(typeof s.title === 'string' ? { title: s.title } : {}), url: s.url }))
                .slice(0, 10)
            : [],
          atMs: typeof (raw.guide as { atMs?: unknown }).atMs === 'number' ? (raw.guide as { atMs: number }).atMs : Date.now(),
        }
      : undefined;

  const capRaw = Number(raw?.memoryCap);
  const memoryCap = Number.isFinite(capRaw) && capRaw > 0 ? Math.max(20, Math.min(20000, Math.round(capRaw))) : undefined;
  return {
    id: typeof raw?.id === 'string' && raw.id.trim() !== '' ? profileIdFromTitle(raw.id) : profileIdFromTitle(title),
    title,
    genre,
    keys,
    notes,
    ...(memoryCap === undefined ? {} : { memoryCap }),
    ...(guide === undefined ? {} : { guide }),
  };
}

/**
 * 把档案拼成给模型看的「操作说明」。
 *
 * 这是让她知道「怎么玩」的唯一入口——没有这段，她只能看着画面瞎点。
 * 输出刻意简短：每轮都要带进提示词，太啰嗦会挤占画面理解的预算。
 */
export function profileBrief(profile: GameProfile): string {
  const lines: string[] = [`游戏：${profile.title}（${profile.genre}）`];
  const keys = Object.entries(profile.keys);
  if (keys.length > 0) {
    lines.push('按键：' + keys.map(([action, key]) => `${action}=${key}`).join(' '));
  }
  if (profile.notes.length > 0) {
    lines.push('要点：' + profile.notes.slice(0, 8).join('；'));
  }
  const guide = profile.guide;
  if (guide !== undefined && guide.summary.trim() !== '') {
    lines.push('攻略：' + guide.summary.trim().slice(0, 300));
  }
  return lines.join('\n');
}
