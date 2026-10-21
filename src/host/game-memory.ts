/**
 * 游戏会话记忆：玩的时候容量要大，退出时压缩回通用上限。
 *
 * ── 为什么不能直接用对话记忆 ──
 *
 * 玩游戏是**连续决策**：每一轮都基于「刚才做了什么、结果如何」。对话记忆的容量
 * （默认 5 轮）在游戏里连一分钟都撑不到——她会反复踩同一个坑。
 *
 * ── 但也不该是另一份独立记忆 ──
 *
 * 主人明确要求：**记忆共用同一份**，只是玩游戏时容量放大。
 * 所以这里的是「会话级缓冲」：玩的时候往里灌，退出时**压缩成一条摘要**塞回
 * 聊天记忆，然后缓冲清空。这样她的长期记忆仍然是一条线，不会分裂成两个自己。
 */

/** 一条游戏决策记录 */
export type GameStep = {
  at: number;
  /** 这一屏她看到的关键状态（模型给的客观描述，截断保存） */
  screen: string;
  /** 她决定做什么 */
  plan: string;
  /** 实际执行了吗（空跑时 false） */
  executed: boolean;
  /** 执行结果：成功 / 被拒 / 急停 */
  outcome: 'ok' | 'dry' | 'rejected' | 'stopped' | 'failed';
};

/** 游戏会话状态 */
export type GameSession = {
  gameTitle: string;
  startedAt: number;
  /** 全部决策记录（按时间正序） */
  steps: GameStep[];
  /** 本轮会话的容量上限（条） */
  cap: number;
};

/**
 * 按游戏类型的容量预设（条数）。
 *
 * 依据是「这类游戏一局要做多少次决策」：
 *  - 回合制：几十分钟一局，几百次操作；
 *  - 大战略：一局几十小时，但每轮决策稀疏，留多一些；
 *  - 动作：决策密集但同质，不需要记太细。
 */
export const GENRE_MEMORY_CAP: Record<string, number> = {
  'turn-based': 500,
  'grand-strategy': 2000,
  tactics: 800,
  rpg: 1500,
  action: 300,
  custom: 500,
};

/** 容量边界：太小没意义，太大会撑爆上下文（每轮只带最近若干条，但压缩也要读完） */
export const MIN_CAP = 20;
export const MAX_CAP = 20000;

/** 开会话 */
export function createGameSession(gameTitle: string, cap: number): GameSession {
  return {
    gameTitle,
    startedAt: Date.now(),
    steps: [],
    cap: Math.max(MIN_CAP, Math.min(MAX_CAP, Math.round(cap))),
  };
}

/**
 * 记一步。
 *
 * 超过容量时**丢最旧的**（环形缓冲语义）：游戏里最近发生的事最重要，
 * 二十轮之前怎么走的路已经没有参考价值了。
 */
export function recordStep(session: GameSession, step: GameStep): void {
  session.steps.push({
    ...step,
    // 单条也限长，避免一条把整个预算吃了
    screen: step.screen.slice(0, 400),
    plan: step.plan.slice(0, 200),
  });
  if (session.steps.length > session.cap) {
    session.steps.splice(0, session.steps.length - session.cap);
  }
}

/**
 * 取给模型看的「最近战况」。
 *
 * @param recent 只带最近几条（不是全部——全带会挤占画面理解的预算）
 */
export function recentContext(session: GameSession, recent = 12): string {
  const steps = session.steps.slice(-recent);
  if (steps.length === 0) return '';
  return steps
    .map((s, i) => {
      const tag = s.outcome === 'ok' ? '' : `[${s.outcome}]`;
      return `${i + 1}. 画面：${s.screen} → 决定：${s.plan}${tag}`;
    })
    .join('\n');
}

/**
 * 压缩：把整局压成一条可以塞回对话记忆的摘要。
 *
 * 刻意做得**保守**：只统计数量与最后几步，不做"总结剧情"那种猜测。
 * 摘要里不该出现我们不知道的东西。
 *
 * @param target 通用记忆能容纳的轮数（1 轮 ≈ 1 条 user + 1 条 assistant）
 */
export function compressSession(session: GameSession, target: number): string {
  const total = session.steps.length;
  if (total === 0) return `（和主人玩了${session.gameTitle}，还没做什么）`;

  const executed = session.steps.filter((s) => s.executed).length;
  const dry = session.steps.filter((s) => s.outcome === 'dry').length;
  const rejected = session.steps.filter((s) => s.outcome === 'rejected').length;
  const stopped = session.steps.filter((s) => s.outcome === 'stopped').length;

  const stats: string[] = [`共 ${total} 步`, `实际执行 ${executed} 步`];
  // 空跑步骤不是「被拒绝」：早先没区分，摘要会写成「被白名单拒绝 N 次」，读起来像出错了
  if (dry > 0) stats.push(`空跑 ${dry} 步（未按键）`);
  if (rejected > 0) stats.push(`被白名单拒绝 ${rejected} 次`);
  if (stopped > 0) stats.push(`急停 ${stopped} 次`);

  // 保留最后几步，够接上下文就行
  const keep = Math.max(1, Math.min(target, 5));
  const tail = session.steps.slice(-keep).map((s) => s.plan);
  return `（和主人玩了${session.gameTitle}：${stats.join('，')}。最近做的：${tail.join(' → ')}）`;
}

/** 是否该压缩（会话结束时用） */
export function shouldCompress(session: GameSession): boolean {
  return session.steps.length > 0;
}
