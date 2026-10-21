/**
 * 技能库：把「这套操作在这个场景下有效」记下来，下次直接复用。
 *
 * ── 为什么这是最该学的一条 ──
 *
 * 我们每轮要花 2~4 秒（截图 + 视觉模型 + 注入）。真实游玩时大量操作是**重复**的：
 * 补兵、走路、点同一个"下一步"。每次都让模型重新看图是纯浪费。
 *
 * Voyager（Minecraft 自主探索 agent）的核心贡献就是这个：
 * **把验证过的行为固化成可复用技能，按场景检索复用**，而不是每步都重新推理。
 *
 * ── 我们怎么用（保守版）──
 *
 * 1. 一轮决策成功（执行后画面确实变了）→ 把这组动作连同「触发描述」存成技能；
 * 2. 下一轮先看当前画面描述**是否匹配某个技能**，匹配就直接重放动作，跳过模型调用；
 * 3. 重放后再验证一次：画面变了算成功，没变算失败；
 * 4. 失败多的技能自动淘汰（不能让她一直用错的办法）。
 *
 * ── 为什么不做得更激进 ──
 *
 * 不做「技能组合成新技能」「技能生成代码」这类 —— 那是通用 agent 的路子，
 * 对「按几个键」这种粒度的收益很小，出错却很难查。
 */

import type { InputAction } from './input';

/** 一条技能：场景特征 → 动作序列 */
export type Skill = {
  id: string;
  /** 人类可读的名字（日志/设置页用） */
  name: string;
  /**
   * 触发特征：从画面描述里提取的关键词（空格分隔）。
   * 匹配要求**全部命中**，宁可漏匹配也不要错匹配——
   * 错匹配会让她在错误场景按错键，比慢一点糟糕得多。
   */
  triggers: string[];
  /** 要执行的动作（相对/绝对坐标都可，按记录时的原样重放） */
  actions: InputAction[];
  /** 成功次数（画面确实变化了） */
  wins: number;
  /** 失败次数（重放后画面没变，或注入被拒） */
  losses: number;
  createdAt: number;
  lastUsedAt: number;
};

/** 淘汰阈值：失败次数达到它就删掉（成功再多也不能留一个常错的） */
export const LOSS_LIMIT = 3;

/** 技能库上限（防止无限增长吃内存与检索时间） */
export const MAX_SKILLS = 200;

/** 触发关键词上限：太多会导致永远匹配不上 */
const MAX_TRIGGERS = 6;

/** 从画面描述里提取关键词（去掉标点与常见虚词） */
const STOP_WORDS = new Set([
  '的', '了', '是', '在', '有', '和', '与', '就', '都', '而', '及', '或',
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'of', 'to', 'in', 'on', 'and', 'or',
]);

const STOP_CHARS = new Set(['的', '了', '是', '在', '有', '和', '与', '就', '都', '而', '及', '或', '着', '过', '吧', '呢', '啊']);

/**
 * 这个词块是不是「全是虚词」。
 *
 * 为什么需要：中文没有空格，`的了是` 这种串会整个被当成一个词。
 * 只按 STOP_WORDS 整词过滤挡不住它——它既不是单个虚词，也是完全无信息量的串。
 * 这类词块当触发条件会让技能永远匹配不上（或者匹配错），所以整块丢掉。
 */
function isAllStopChars(token: string): boolean {
  for (const ch of token) {
    if (!STOP_CHARS.has(ch)) return false;
  }
  return true;
}

export function extractTriggers(description: string): string[] {
  const words = description
    // 去掉标点，切成词块
    .replace(/[，。！？、；：「」【】（）《》,.!?;:()[\]<>'"]/g, ' ')
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w !== '' && !STOP_WORDS.has(w) && w.length >= 2 && !isAllStopChars(w));

  // 去重 + 取前 N 个（顺序保留：越靠前越有区分度）
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of words) {
    if (seen.has(w)) continue;
    seen.add(w);
    out.push(w);
    if (out.length >= MAX_TRIGGERS) break;
  }
  return out;
}

/** 生成技能 id（递增即可，不需要稳定 hash） */
export function makeSkillId(existing: readonly Skill[]): string {
  let n = existing.length + 1;
  const taken = new Set(existing.map((s) => s.id));
  while (taken.has(`s${n}`)) n++;
  return `s${n}`;
}

/**
 * 建一条技能。
 *
 * @param description 当时画面的客观描述（watch 模式给的）
 * @param actions 这轮实际执行成功的动作
 */
export function createSkill(
  description: string,
  actions: InputAction[],
  existing: readonly Skill[],
  now = Date.now(),
): Skill | undefined {
  const triggers = extractTriggers(description);
  // 提不出特征就别建：没有触发条件的技能永远匹配不上，白占地方
  if (triggers.length === 0 || actions.length === 0) return undefined;
  return {
    id: makeSkillId(existing),
    name: triggers.slice(0, 3).join('-'),
    triggers,
    actions,
    wins: 1,
    losses: 0,
    createdAt: now,
    lastUsedAt: now,
  };
}

/**
 * 在技能库里找一条能用的。
 *
 * 匹配规则：**所有触发词都必须出现在当前描述里**。
 * 多条命中时取成功次数最高的（成功多的更可信）。
 */
export function matchSkill(skills: readonly Skill[], description: string): Skill | undefined {
  const haystack = description.toLowerCase();
  const candidates = skills.filter((s) => {
    if (s.triggers.length === 0) return false;
    if (s.losses >= LOSS_LIMIT) return false;
    return s.triggers.every((t) => haystack.includes(t.toLowerCase()));
  });
  if (candidates.length === 0) return undefined;
  return candidates.sort((a, b) => b.wins - a.wins || b.lastUsedAt - a.lastUsedAt)[0];
}

/** 记一次结果；失败到阈值就返回 false（调用方据此淘汰） */
export function scoreSkill(skill: Skill, ok: boolean, now = Date.now()): boolean {
  if (ok) skill.wins++;
  else skill.losses++;
  skill.lastUsedAt = now;
  return skill.losses < LOSS_LIMIT;
}

/** 淘汰：把失败超限的删掉，并按「最少使用」裁到上限 */
export function pruneSkills(skills: Skill[]): Skill[] {
  const alive = skills.filter((s) => s.losses < LOSS_LIMIT);
  if (alive.length <= MAX_SKILLS) return alive;
  // 超上限时保留「成功多、最近用过」的
  return alive
    .sort((a, b) => b.wins - a.wins || b.lastUsedAt - a.lastUsedAt)
    .slice(0, MAX_SKILLS);
}

/** 归一化（从磁盘读回来的脏数据也安全） */
export function normalizeSkill(raw: Partial<Skill> | undefined): Skill | undefined {
  if (raw === undefined || typeof raw !== 'object') return undefined;
  if (!Array.isArray(raw.actions) || raw.actions.length === 0) return undefined;
  if (!Array.isArray(raw.triggers) || raw.triggers.length === 0) return undefined;
  const triggers = raw.triggers.filter((t): t is string => typeof t === 'string' && t.trim() !== '').slice(0, MAX_TRIGGERS);
  if (triggers.length === 0) return undefined;
  return {
    id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : 's0',
    name: typeof raw.name === 'string' && raw.name !== '' ? raw.name : triggers.join('-'),
    triggers,
    actions: raw.actions as InputAction[],
    wins: typeof raw.wins === 'number' && Number.isFinite(raw.wins) ? Math.max(0, raw.wins) : 0,
    losses: typeof raw.losses === 'number' && Number.isFinite(raw.losses) ? Math.max(0, raw.losses) : 0,
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
    lastUsedAt: typeof raw.lastUsedAt === 'number' ? raw.lastUsedAt : Date.now(),
  };
}
