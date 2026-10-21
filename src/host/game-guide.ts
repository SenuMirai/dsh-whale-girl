/**
 * 联网查攻略：让它知道「这个游戏怎么玩」。
 *
 * 走 DSH 的 `ctx.web` 服务（和 DSH 自己的 web_search 同一条通道），
 * 不自己接搜索引擎——那要管 key、管配额、管反爬，全都不是这个插件该操心的。
 *
 * ── 用在哪 ──
 *
 * 1. **首次遇到某款游戏**：查一次「<游戏> 操作 按键 新手攻略」，把要点写进档案；
 * 2. **卡关时**：拿当前画面描述去查具体问题。
 *
 * ── 为什么不每轮都查 ──
 *
 * 一轮游戏决策才 2~4 秒，联网搜索要 2~5 秒且要花钱。每轮都查会把节奏彻底拖垮，
 * 所以结果**缓存进档案**（`guide` 字段），同款游戏只查一次。
 */

/** 检索结果（结构化，便于落盘与展示） */
export type GuideResult = {
  ok: true;
  query: string;
  /** 摘要（来自 provider 的 content，或把 sources 的标题/片段拼起来） */
  summary: string;
  sources: Array<{ title?: string; url: string }>;
  atMs: number;
} | { ok: false; reason: string; message: string };

/** ctx.web 的最小契约（结构化类型，避免依赖具体包） */
type WebLike = {
  search(
    request: { query: string; maxResults?: number },
    signal?: AbortSignal,
  ): Promise<{ content?: string; sources: readonly { url: string; title?: string; snippet?: string }[]; truncated: boolean }>;
};

/** 单次检索超时：搜索服务偶尔会很慢，别把整轮游戏卡住 */
const TIMEOUT_MS = 12_000;

/**
 * 查一次攻略。
 *
 * @param web `ctx.web`（软取，可能不存在）
 * @param game 游戏名
 * @param extra 额外关键词（比如「新手」「按键」「怎么打 XX」）
 */
export async function searchGuide(web: WebLike | undefined, game: string, extra = '操作 按键 新手攻略'): Promise<GuideResult> {
  const query = `${game} ${extra}`.trim();
  if (web === undefined || typeof web.search !== 'function') {
    return { ok: false, reason: 'web-unavailable', message: '没有可用的联网搜索服务' };
  }
  if (game.trim() === '') {
    return { ok: false, reason: 'no-game', message: '不知道是哪个游戏，没法查' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const result = await web.search({ query, maxResults: 5 }, controller.signal);
    const sources = (result.sources ?? [])
      .filter((s) => typeof s.url === 'string' && s.url !== '')
      .slice(0, 5)
      .map((s) => ({ ...(typeof s.title === 'string' ? { title: s.title } : {}), url: s.url }));

    // 摘要优先用 provider 给的 content；没有就退回「标题 + 片段」
    const rawSummary =
      typeof result.content === 'string' && result.content.trim() !== ''
        ? result.content.trim()
        : (result.sources ?? [])
            .map((s) => [s.title, s.snippet].filter((x): x is string => typeof x === 'string' && x !== '').join('：'))
            .filter((s) => s !== '')
            .join('\n');

    if (rawSummary === '') {
      return { ok: false, reason: 'empty', message: '搜到了但没有任何内容' };
    }
    return {
      ok: true,
      query,
      // 太长的摘要进提示词会挤占画面预算；300 字够给方向
      summary: rawSummary.slice(0, 300),
      sources,
      atMs: Date.now(),
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (/abort/i.test(message)) return { ok: false, reason: 'timeout', message: `检索超时（${TIMEOUT_MS} ms）` };
    return { ok: false, reason: 'search-failed', message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 该不该自己上网查一次攻略。
 *
 * ── 为什么要这个判据 ──
 *
 * 主人要的是「它玩游戏需要主动决策是否联网搜索，而不是我点击它联网才联网」。
 * 但每轮都查会拖垮节奏（搜索 2~5 秒 + 花钱），所以只在**连着卡住**时才查。
 *
 * 「卡住」的定义（由调用方统计）：
 *  - 模型说 noop（没主意了）
 *  - 模型输出解析不了（看不懂该干嘛）
 *  - 动作被白名单拒绝（走错方向）
 *
 * @param stuckRounds 连续卡住几轮
 * @param hasGuide 档案里已经有攻略了吗
 * @param lastSearchAt 上次查询时间（冷却用）
 */
export function shouldSearchGuide(opts: {
  stuckRounds: number;
  hasGuide: boolean;
  lastSearchAt?: number;
  now?: number;
  stuckThreshold?: number;
  cooldownMs?: number;
}): boolean {
  const threshold = Math.max(1, opts.stuckThreshold ?? 3);
  const cooldown = Math.max(0, opts.cooldownMs ?? 10 * 60 * 1000);
  const now = opts.now ?? Date.now();

  // 没卡够就不查
  if (opts.stuckRounds < threshold) return false;
  // 冷却中不查（避免一卡就刷搜索）
  if (opts.lastSearchAt !== undefined && now - opts.lastSearchAt < cooldown) return false;
  // 已经有攻略也不急着查（先让她照现有的试）
  if (opts.hasGuide) return false;
  return true;
}