/**
 * 任务分流：简单的自己做，复杂的交给 DSH 会话。
 *
 * ── 主人原话 ──
 *
 * 「打开微信给谁发什么消息、打开浏览器搜索什么、打开网易云播放什么，
 *   就它自己执行；如果是更复杂的创建项目工程做文档等任务，
 *   就让它能够直接在 DSH 上新建会话执行。」
 *
 * ── 为什么必须分流 ──
 *
 * 两条路的**代价差两个数量级**：
 *  - 自己执行：本地动作，0.1~2 秒，不花钱（开应用、按键、剪贴板）
 *  - 建 DSH 会话：起一个完整 agent，能读写文件、跑命令、写文档，但慢且贵
 *
 * 把「打开浏览器」也丢给 agent，等于为了开个网页启动一台工程机器。
 *
 * ── 判据 ──
 *
 * 不做"智能判断"——用**明确的动作类型 + 关键词**。
 *
 * ── 一个必须纠正的设计错误 ──
 *
 * 最初这里写「认不出来的一律交给 DSH（宁可偏复杂）」。
 * 结果是「现在在干嘛呀」这种闲聊被当成复杂任务去建会话，失败后她回你
 * 「无法新建会话」——比不智能更糟，是**答非所问**。
 *
 * 正确的分界：**有明确动作意图**才叫任务；只是闲聊就老老实实聊天。
 * 所以认不出来的落到 `chat`，交给正常对话——她本来就会聊天。
 */

/** 任务分流结果 */
export type TaskRoute =
  | { kind: 'self'; action: SelfAction; reason: string }
  | { kind: 'session'; prompt: string; reason: string }
  /** 不是任务，是聊天——交给正常对话 */
  | { kind: 'chat'; reason: string };

/** 自己能做的动作 */
export type SelfAction =
  | { do: 'open-app'; target: string }
  | { do: 'open-url'; url: string }
  | { do: 'search-web'; query: string }
  | { do: 'play-music'; what: string }
  | { do: 'send-message'; app: string; to: string; text: string }
  | { do: 'focus-window'; target: string };

/**
 * 复杂任务的标志词。
 *
 * 出现这些就交给 DSH 会话——它们意味着**多步骤、要产出文件、要访问代码库**，
 * 不是一次点击能完成的。
 */
/**
 * 明确要求「在 DSH 里新建会话」的说法。
 *
 * 主人定的规则：**只有明确提到这些**才去建会话；
 * 其余情况要么是自己能动手的活儿，要么就是聊天——聊天就好好聊天。
 */
const SESSION_HINTS = [
  '新建一个项目',
  '建一个项目',
  '做一个项目',
  '新建一个会话',
  '开一个新会话',
  '建个工程',
  '新建项目',
  '新建项目',
  '新开项目',
  '建个项目',
  '建个新项目',
  '新建会话',
  '新开会话',
  '新建dsh',
  'dsh会话',
  'dsh项目',
  '在dsh',
  '开个会话',
  '起个会话',
];

/** 判断一个任务该走哪条路 */
export function routeTask(text: string): TaskRoute {
  const raw = text.trim();
  if (raw === '') return { kind: 'chat', reason: '空话' };

  // 主人定的规则：**明确要新建 DSH 会话**才建会话。
  // 不靠"这听起来像个复杂任务"去猜——那正是上次把「现在在干嘛呀」
  // 判成建会话、回你「无法新建会话」的原因。
  const lower = raw.toLowerCase();
  const sessionHint = SESSION_HINTS.find((h) => lower.includes(h));
  if (sessionHint !== undefined) {
    return { kind: 'session', prompt: raw, reason: `你提到了「${sessionHint}」` };
  }

  // 打开网址（含 http/https 或明显是域名）
  const urlMatch = raw.match(/(?:打开|访问|去到?)\s*((?:https?:\/\/)?[\w-]+(?:\.[\w-]+)+(?:\/\S*)?)/);
  if (urlMatch !== null) {
    let url = urlMatch[1];
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    return { kind: 'self', action: { do: 'open-url', url }, reason: '打开网址' };
  }

  // 发消息：打开<某应用>给<某人>发<内容>
  const msgMatch = raw.match(/(?:打开|用)?\s*([^\s，。]{1,10})\s*(?:给|跟|向)\s*([^\s，。]{1,20})\s*(?:发|说|告诉)(?:条|一条|一个|个)?(?:信息|消息|话|一句)?\s*(.*)/);
  // 内容可以为空（'给某人发信息'没说内容）——那也要走 send-message 分支，
  // 否则会掉进 open-app、被当成'只是打开微信'，丢掉真实意图。
  if (msgMatch !== null) {
    return {
      kind: 'self',
      action: { do: 'send-message', app: msgMatch[1].trim(), to: msgMatch[2].trim(), text: msgMatch[3].trim() },
      reason: '发消息',
    };
  }

  // 放音乐
  const musicMatch = raw.match(/(?:播放|放一首|放首|听)\s*(.{1,40})/);
  if (musicMatch !== null && /音乐|歌|网易云|QQ音乐/.test(raw)) {
    return {
      kind: 'self',
      action: { do: 'play-music', what: musicMatch[1].trim() },
      reason: '放音乐',
    };
  }

  // 搜索
  const searchMatch = raw.match(/(?:搜索|搜一下|查一下|帮我查)\s*(.{1,60})/);
  if (searchMatch !== null) {
    return { kind: 'self', action: { do: 'search-web', query: searchMatch[1].trim() }, reason: '搜索' };
  }

  // 切窗口
  const focusMatch = raw.match(/(?:切到|切换到|回到)\s*(.{1,30})/);
  if (focusMatch !== null) {
    return { kind: 'self', action: { do: 'focus-window', target: focusMatch[1].trim() }, reason: '切窗口' };
  }

  // 打开应用（最宽的一条，所以放最后）
  const openMatch = raw.match(/(?:帮我)?(?:打开|启动|运行)\s*([^\s，。给发说]{1,20})\s*$|(?:帮我)?(?:打开|启动|运行)\s*([^\s，。给发说]{1,20})/);
  if (openMatch !== null) {
    const appName = (openMatch[1] ?? openMatch[2] ?? '').trim();
    if (appName !== '') {
      return { kind: 'self', action: { do: 'open-app', target: appName }, reason: '打开应用' };
    }
  }

  // 没有明确的动作意图 → 这是聊天，不是任务（她本来就会聊天）
  return { kind: 'chat', reason: '没有明确动作意图' };
}
