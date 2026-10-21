/**
 * 对话记忆的导入/导出（纯逻辑，可单测）。
 *
 * ── 为什么要单独一层 ──
 *
 * 主人要把手机端的聊天记录移植过来，而各家的导出格式都不一样：
 * OpenAI 风格 `[{role, content}]`、只有正文的纯文本「我：… / 你：…」、
 * 或者已经是本插件导出的 JSON。解析、去重、排序的规则必须能脱离 HTTP/文件系统测，
 * 否则「倒进去以后顺序乱了 / 重复了」这类问题只能靠猜。
 *
 * 存储格式（与 memory.json 一致）：
 *   { <entry>: { <petId>: { messages: [{ role: 'user' | 'assistant', content: string, ts: number }] } } }
 */

/** 一条可导入的记忆（与 chat.ts 的 ChatMemoryMessage 同构） */
export type ImportedMessage = { role: 'user' | 'assistant'; content: string; ts: number };

export type ParseImportResult = { ok: true; messages: ImportedMessage[] } | { ok: false; message: string };

/** 角色别名：手机端导出常见的中英文各种写法 */
const ROLE_ALIASES: Record<string, 'user' | 'assistant'> = {
  user: 'user',
  me: 'user',
  human: 'user',
  我: 'user',
  主人: 'user',
  用户: 'user',
  assistant: 'assistant',
  ai: 'assistant',
  bot: 'assistant',
  model: 'assistant',
  you: 'assistant',
  你: 'assistant',
  她: 'assistant',
  助手: 'assistant',
  鲸鱼娘: 'assistant',
};

/** 单次导入上限：防止一个 100MB 的 JSON 把内存打爆 */
const MAX_IMPORT = 5000;

/** 把各种 role 写法归一化；认不出 → undefined */
function normalizeRole(raw: unknown): 'user' | 'assistant' | undefined {
  if (typeof raw !== 'string') return undefined;
  return ROLE_ALIASES[raw.trim().toLowerCase()] ?? ROLE_ALIASES[raw.trim()];
}

/** 从对象里取正文（content / text / message 都认） */
function messageText(item: Record<string, unknown>): string {
  for (const key of ['content', 'text', 'message']) {
    const value = item[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
    if (Array.isArray(value)) {
      // OpenAI 多段 content：[{type:'text', text:'…'}]
      const joined = value
        .map((part) =>
          part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
            ? (part as { text: string }).text
            : '',
        )
        .join('')
        .trim();
      if (joined !== '') return joined;
    }
  }
  return '';
}

/** 纯文本解析：`我：…` / `你：…` / `User: …` / `Assistant: …`，续行接到上一条 */
function parseText(raw: string, now: number): ParseImportResult {
  const lines = raw.split(/\r?\n/);
  const messages: ImportedMessage[] = [];
  const prefix = /^\s*(我|主人|用户|user|me|human|你|她|助手|ai|assistant|bot|model|鲸鱼娘)\s*[:：]\s*(.*)$/i;
  for (const line of lines) {
    if (line.trim() === '') continue;
    const match = prefix.exec(line);
    if (match) {
      const role = normalizeRole(match[1]);
      const content = match[2].trim();
      if (role !== undefined && content !== '') messages.push({ role, content, ts: now + messages.length });
      continue;
    }
    // 没有前缀：续上一句（手机复制出来的多行消息常见）
    if (messages.length > 0) messages[messages.length - 1].content += '\n' + line.trim();
  }
  if (messages.length === 0) {
    return { ok: false, message: '没认出对话格式：可以粘贴 JSON，或用「我：… / 你：…」这种一行一句的格式' };
  }
  return { ok: true, messages: messages.slice(0, MAX_IMPORT) };
}

/**
 * 解析各种导入格式。
 *
 * @param raw 用户粘贴的字符串，或已经解析好的 JSON 值
 * @param now 没有时间戳时用的基准时间（默认当前时间）
 */
export function parseMemoryImport(raw: unknown, now = Date.now()): ParseImportResult {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (text === '') return { ok: false, message: '内容是空的' };
    if (text.startsWith('[') || text.startsWith('{')) {
      try {
        value = JSON.parse(text);
      } catch (e) {
        return { ok: false, message: 'JSON 解析失败：' + (e instanceof Error ? e.message : String(e)) };
      }
    } else {
      return parseText(text, now);
    }
  }

  let list: unknown[] | undefined;
  if (Array.isArray(value)) list = value;
  else if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    for (const key of ['messages', 'data', 'history', 'items']) {
      if (Array.isArray(obj[key])) {
        list = obj[key] as unknown[];
        break;
      }
    }
  }
  if (list === undefined) return { ok: false, message: '没找到消息数组（支持 {messages:[…]} 或直接是数组）' };

  const messages: ImportedMessage[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const role = normalizeRole(obj.role ?? obj.from ?? obj.author);
    const content = messageText(obj);
    if (role === undefined || content === '') continue;
    const tsRaw = Number(obj.ts ?? obj.time ?? obj.timestamp ?? obj.createdAt);
    const ts = Number.isFinite(tsRaw) && tsRaw > 0 ? Math.round(tsRaw) : now + messages.length;
    messages.push({ role, content, ts });
    if (messages.length >= MAX_IMPORT) break;
  }
  if (messages.length === 0) {
    return { ok: false, message: '一条都没认出来：每条消息需要 role（user/assistant）和 content' };
  }
  return { ok: true, messages };
}

/**
 * 合并两段记忆：按 `ts + role + content` 去重、按时间排序、保留最近 `cap` 条。
 *
 * 为什么要排序：手机导出的记录可能整体早于本机记忆——不排序的话，聊到一半会「穿越」。
 */
export function mergeMemory(
  existing: readonly ImportedMessage[],
  incoming: readonly ImportedMessage[],
  cap = 2000,
): { messages: ImportedMessage[]; added: number } {
  const byKey = new Map<string, ImportedMessage>();
  for (const message of [...existing, ...incoming]) {
    if (message.content.trim() === '') continue;
    const key = `${message.ts}|${message.role}|${message.content}`;
    if (!byKey.has(key)) byKey.set(key, message);
  }
  const merged = [...byKey.values()].sort((a, b) => a.ts - b.ts);
  const limited = cap > 0 && merged.length > cap ? merged.slice(-cap) : merged;
  return { messages: limited, added: Math.max(0, limited.length - existing.length) };
}

/** 导出成可移植的 JSON（带版本号，方便以后升级格式） */
export function exportMemoryPayload(messages: readonly ImportedMessage[]): Record<string, unknown> {
  return {
    format: 'dsh-whale-girl-memory',
    version: 1,
    exportedAt: new Date().toISOString(),
    messages: messages.map((message) => ({ role: message.role, content: message.content, ts: message.ts })),
  };
}

/** 中文按二字组切，英文/数字按词切（够用且不需要分词库） */
function tokensOf(text: string): string[] {
  const lowered = text.toLowerCase();
  const latin = lowered.match(/[a-z0-9]{2,}/g) ?? [];
  const cjk = lowered.replace(/[^\u4e00-\u9fff]/g, '');
  const grams: string[] = [];
  for (let i = 0; i + 2 <= cjk.length; i++) grams.push(cjk.slice(i, i + 2));
  return [...new Set([...latin, ...grams])];
}

/**
 * 从全部记忆里挑「跟当前这句话最相关」的旧消息。
 *
 * 为什么需要：聊天上下文只带最近 N 轮，导入的几百条旧记录默认进不了模型视野。
 * 每次把整本记忆塞进去既贵又吵；按关键词重合度挑几条最相关的补进去，
 * 主人提到「牛腩粉」「火焰纹章」这类旧话题时她才接得上。
 *
 * @param messages 全部记忆（按时间正序）
 * @param query 主人刚说的话
 * @param options.excludeLast 最近几条不参与（它们本来就在上下文里）
 * @param options.limit 最多挑几条（默认 6）
 * @param options.minScore 最低相关度（默认 1；常见词权重低、具体名词权重高）
 */
export function selectRelevantMemory(
  messages: readonly ImportedMessage[],
  query: string,
  options: { excludeLast?: number; limit?: number; minScore?: number } = {},
): ImportedMessage[] {
  const tokens = tokensOf(query);
  if (tokens.length === 0) return [];
  const excludeLast = Math.max(0, options.excludeLast ?? 0);
  const limit = Math.max(1, options.limit ?? 6);
  const minScore = Math.max(0.1, options.minScore ?? 1);
  const end = Math.max(0, messages.length - excludeLast);

  // IDF：在整本记忆里到处都有的两字组（「记得」「我们」）几乎不加分，
  // 具体名词（「牛腩粉」「火焰纹章」）才有分量——否则会挑出一堆无关的「记得」。
  const corpus: string[] = [];
  for (let i = 0; i < end; i++) corpus.push(messages[i].content.toLowerCase());
  const weights = new Map<string, number>();
  for (const token of tokens) {
    let df = 0;
    for (const content of corpus) if (content.includes(token)) df++;
    weights.set(token, Math.log((corpus.length + 1) / (df + 1)) + 0.2);
  }

  const scored: Array<{ message: ImportedMessage; score: number }> = [];
  for (let i = 0; i < end; i++) {
    const message = messages[i];
    const content = corpus[i];
    let score = 0;
    for (const token of tokens) {
      if (content.includes(token)) score += weights.get(token) ?? 0;
    }
    if (score >= minScore) scored.push({ message, score });
  }
  scored.sort((a, b) => b.score - a.score || b.message.ts - a.message.ts);
  return scored.slice(0, limit).map((entry) => entry.message);
}
