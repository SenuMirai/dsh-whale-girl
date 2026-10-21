/**
 * 发消息：先准备好，等主人确认，再动手。
 *
 * ── 为什么必须有确认这一步 ──
 *
 * 微信没有命令行接口，只能模拟键盘：切窗口 → 搜联系人 → 打开会话 → 粘贴 → 回车。
 * 其中「搜联系人」那步一旦匹配错人，**消息就发给别人了，不可逆**。
 *
 * 所以这里的分工是：
 *  1. 先把「要发给谁、发什么」拼成一份**待确认**的计划；
 *  2. 主人确认（说"发"）之后才真正按键；
 *  3. 任何一步失败都停手，不硬着头皮往下按。
 */

/** 一条待确认的消息 */
export type PendingMessage = {
  /** 应用名（微信 / QQ …） */
  app: string;
  /** 收信人 */
  to: string;
  /** 正文（可能为空：那只是打开会话，不含发送） */
  text: string;
  /** 什么时候准备的（用于超时作废） */
  at: number;
};

/**
 * 待确认消息的有效期。
 *
 * 过期就作废：隔了十分钟才说"发"，很可能主人已经忘了在说什么，
 * 这时按下去比不按危险。
 */
export const PENDING_TTL_MS = 5 * 60 * 1000;

/** 确认词 */
const CONFIRM_WORDS = ['发', '发吧', '发送', '确认', '确认发送', '发出去', '发给他', '发给她', '发过去'];
/** 取消词 */
const CANCEL_WORDS = ['不发', '别发', '取消', '算了', '不发了', '取消发送'];

/** 这句话是"确认发送"吗 */
export function isConfirm(text: string): boolean {
  const t = text.replace(/[，。！？、；：\s]/g, '').trim();
  return CONFIRM_WORDS.includes(t);
}

/** 这句话是"取消发送"吗 */
export function isCancel(text: string): boolean {
  const t = text.replace(/[，。！？、；：\s]/g, '').trim();
  return CANCEL_WORDS.includes(t);
}

/** 待确认的消息是否已过期 */
export function isExpired(pending: PendingMessage, now = Date.now()): boolean {
  return now - pending.at > PENDING_TTL_MS;
}

/**
 * 把待确认消息说成人话（气泡/播报用）。
 *
 * **必须把收信人和正文都说出来**——这是确认这一步存在的唯一意义：
 * 主人要能一眼看出"发给谁、发什么"，才能判断对不对。
 */
export function describePending(pending: PendingMessage): string {
  if (pending.text.trim() === '') {
    return `要打开${pending.app}里和「${pending.to}」的会话，但你没说发什么。要发什么？`;
  }
  return `确认一下：发给${pending.app}的「${pending.to}」，内容是「${pending.text}」。说「发」我就发，说「不发」就取消。`;
}

/**
 * 生成按键计划。
 *
 * 用"计划"而不是直接按，一是可测，二是能让调用方逐步执行并在失败处停下。
 *
 * 步骤（微信 Windows 版）：
 *   1. Ctrl+F 打开搜索
 *   2. 粘贴联系人名（中文只能靠剪贴板，SendKeys 打不出中文）
 *   3. 回车打开会话
 *   4. 粘贴正文
 *   5. 回车发送（正文为空时**不按**，那就只是打开会话）
 */
export type MessageStep =
  | { kind: 'clipboard'; text: string }
  | { kind: 'key'; key: string; modifiers?: string[] };

export function planSend(pending: PendingMessage): MessageStep[] {
  const steps: MessageStep[] = [
    { kind: 'key', key: 'f', modifiers: ['ctrl'] },
    { kind: 'clipboard', text: pending.to },
    { kind: 'key', key: 'v', modifiers: ['ctrl'] },
    { kind: 'key', key: 'enter' },
  ];
  const body = pending.text.trim();
  if (body !== '') {
    // 稍等一下让会话打开再粘贴，否则可能粘到搜索框里
    steps.push({ kind: 'clipboard', text: body });
    steps.push({ kind: 'key', key: 'v', modifiers: ['ctrl'] });
    steps.push({ kind: 'key', key: 'enter' });
  }
  return steps;
}
