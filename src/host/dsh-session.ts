/**
 * 让复杂任务在 DSH 里**新建会话**执行。
 *
 * ── 为什么走这条路 ──
 *
 * 主人：「如果是接收到更复杂的创建项目工程做文档等任务，就让它能够直接在 DSH 上
 * 新建会话执行」。
 *
 * 这类任务需要读写文件、跑命令、写文档——这些能力 DSH 的 agent 本来就有，
 * 我们**不该在插件里重造一套**。建一个会话把任务交出去，等于直接复用整套 agent 能力。
 *
 * ── 契约（来自 ctx.agents）──
 *
 * ```
 * agents.create({
 *   sessionId,                    // 共享的 agent/session id
 *   meta: { cwd, isSeeded },      // isSeeded 表示"这个会话是被种了初始事件的"
 *   seed: SessionEvent[],         // 初始事件（我们用它塞用户任务）
 *   agentOptions: { provider, model },
 * })
 * ```
 *
 * ── 这一步的诚实边界 ──
 *
 * 种子事件里的 `seq`/`time` 是 DSH 的带标签数值，顺序错了会话可能起不来。
 * 所以这里**所有失败都结构化返回**，不假装成功——建会话失败就明说，
 * 而不是回一句"好的我去做了"然后什么都没发生。
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm';

/** DSH 侧我们会用到的服务形状（结构化类型，避免依赖具体包） */
export type AgentsLike = {
  create(options: {
    sessionId: string;
    meta?: { cwd?: string; isSeeded?: boolean };
    seed?: readonly unknown[];
    /** 种子会话必须声明继承了多少事件；我们从 seq 0 开始，所以是 0 */
    inheritedEventCount?: number;
    agentOptions?: { provider?: string; model?: string };
  }): Promise<{ agent: { id: string } }>;
};

/** 建会话的结果 */
export type TaskSessionResult =
  | { ok: true; sessionId: string; title: string }
  | { ok: false; reason: string; message: string };

/**
 * 造一条「用户消息」种子事件。
 *
 * 字段按 DSH 的 SessionEvent 形状给：
 * `{ type, seq, time, data, surfaceOp }`。
 * seq 从 0 开始（种子是这个会话的第一条事件），surfaceOp 用 'append'。
 */
export function buildSeedEvent(text: string, now = Date.now()): unknown {
  // **必须用官方工厂**：手写对象缺 DSH 要求的 message id，
  // 会被判成 `seed user/message at index 0 lacks an identified message`。
  // createUserMessage 会补上那条消息的身份。
  const message = createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  });
  return {
    type: 'user/message',
    seq: 0,
    time: now,
    data: message,
    surfaceOp: 'append',
  };
}
/** 从任务文本生成一个稳定的会话 id（不用随机数，便于事后在 DSH 里找） */
export function makeSessionId(prefix = 'whale', now = Date.now()): string {
  return `${prefix}-${now.toString(36)}`;
}

/**
 * 把一个任务建成 DSH 会话。
 *
 * @param agents `ctx.agents`（软取，可能不存在）
 * @param task 要做的任务（原始自然语言）
 * @param opts 模型与工作目录
 */
export async function createTaskSession(
  agents: AgentsLike | undefined,
  task: string,
  opts: { cwd?: string; provider?: string; model?: string; now?: number } = {},
): Promise<TaskSessionResult> {
  const text = task.trim();
  if (text === '') return { ok: false, reason: 'empty-task', message: '没有要做的任务' };
  if (agents === undefined || typeof agents.create !== 'function') {
    return { ok: false, reason: 'agents-unavailable', message: 'Agent 服务不可用，建不了会话' };
  }

  const sessionId = makeSessionId('whale', opts.now ?? Date.now());
  const title = text.length > 24 ? text.slice(0, 24) + '…' : text;

  try {
    const handle = await agents.create({
      sessionId,
      meta: {
        // 有工作目录就带上（agent 会在那里读写文件）
        ...(opts.cwd === undefined || opts.cwd === '' ? {} : { cwd: opts.cwd }),
        // 明确告诉 DSH：这个会话是从种子起的
        isSeeded: true,
      },
      // **两个都不能少**：seed 给事件，inheritedEventCount 声明从哪儿接上。
      // 少了后者 DSH 直接拒绝：'seeded session requires an inherited event count'。
      inheritedEventCount: 0,
      seed: [buildSeedEvent(text, opts.now ?? Date.now())],
      ...(opts.provider === undefined || opts.model === undefined
        ? {}
        : { agentOptions: { provider: opts.provider, model: opts.model } }),
    });
    return { ok: true, sessionId: handle.agent.id, title };
  } catch (e) {
    return { ok: false, reason: 'create-failed', message: e instanceof Error ? e.message : String(e) };
  }
}
