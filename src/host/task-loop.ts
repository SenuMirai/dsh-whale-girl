/**
 * 通用任务循环：看着屏幕，一步步把一件事做成。
 *
 * ── 为什么要有它（一次架构纠正）──
 *
 * 早先我给「打开网易云播放音乐」写的是硬编码：开应用 → 提示主人自己去搜。
 * 主人一句话点破了：「不应该做成和玩游戏模式差不多的吗？」
 *
 * 对。**玩游戏本质就是"看着屏幕操作电脑"**，播放音乐、发消息、搜索是同一件事
 * 的低配版本。硬编码每加一个功能就要写一段专用代码，而且永远做不全。
 *
 * 所以这里把「代打循环」抽象成**任务通用**：
 *   目标（一句话）→ 截图 → 模型决定动作 → 急停检查 → 注入 → 验证 → 下一轮
 *
 * 游戏模式 = 目标换成"玩这个游戏"、窗口白名单换成游戏窗口。同一套代码。
 *
 * ── 与代打的关键差别 ──
 *
 * 1. **有目标达成判定**：模型可以输出 `done`，循环就结束
 * 2. **有步数上限**：防止在一个做不成的任务上无限烧钱
 * 3. **每轮都要看到变化**：画面完全没变说明动作没生效，连续几次就停手
 */

import type { InputAction } from './input';

/** 一次任务执行的配置 */
export type TaskRunConfig = {
  /** 要达成的目标（自然语言） */
  goal: string;
  /** 只在这些窗口里动手（空 = 不限制，不推荐） */
  allowedTitles: string[];
  /** 最多走多少步（每步一次模型调用） */
  maxSteps: number;
  /** 空跑：只打印不注入 */
  dryRun: boolean;
};

export const DEFAULT_TASK_CONFIG: Omit<TaskRunConfig, 'goal'> = {
  allowedTitles: [],
  maxSteps: 20,
  dryRun: true,
};

/** 单步结果 */
export type TaskStep =
  | { kind: 'acted'; thought: string; actions: InputAction[]; executed: boolean }
  | { kind: 'done'; summary: string }
  | { kind: 'noop'; reason: string }
  | { kind: 'stopped'; reason: string }
  | { kind: 'failed'; reason: string; message: string };

/** 任务提示词：把目标交给模型，要求它一次只走一步 */
export function taskPrompt(goal: string, step: number, maxSteps: number): string {
  return `你在替主人操作电脑，完成这个任务：${goal}

这是第 ${step} / ${maxSteps} 步。你会看到当前屏幕画面。

请判断**下一步做什么**，并且只输出**一行**，格式必须是下面之一：

click X Y            —— 用鼠标左键点屏幕坐标 (X, Y)
rclick X Y           —— 右键点击
drag X1 Y1 X2 Y2     —— 在 (X1,Y1) 按下左键、拖到 (X2,Y2) 松开（拖拽/战棋移动）
key NAME             —— 按一下某个键（NAME 用英文：w a s d space enter esc tab up down left right 0-9）
keydown NAME         —— 按住
keyup NAME           —— 松开
move X Y             —— 只移动鼠标
done 说明            —— **任务已经完成了**，用一句话说结果
noop 原因            —— 这一步什么都不做

规则：
1. 一次只输出**一个**动作。
2. 坐标用画面像素，左上角是 (0,0)。
3. **看不清、不确定、界面还没加载好 → 一律 noop**。乱点比不动危险得多。
4. 确认目标真的达成了才输出 done。没达成不要提前 done。
5. 不要解释，不要输出第二行，不要用 Markdown。`;
}

/**
 * 只看这一行是不是「完成」。
 *
 * 为什么只做这件事：动作解析已经有一套（`parseActionPlan`，代打在用），
 * 这里再写一遍就会有两份互相漂移的实现。本模块只负责"任务特有"的那一点：认出终点。
 *
 * @returns 是 done 就返回摘要；否则 undefined（调用方拿原文去解析动作）
 */
export function parseTaskDone(raw: string): string | undefined {
  const text = raw
    .replace(/```[a-zA-Z]*\n?([\s\S]*?)```/g, '$1')
    .replace(/[`*_#>|]/g, '')
    .trim();
  const first = (text.split('\n').find((l) => l.trim() !== '') ?? '').trim();
  if (!first.toLowerCase().startsWith('done')) return undefined;
  return first.slice(4).trim() || '完成了';
}

/**
 * 判断"卡住了"：连续这么多步画面都没变化。
 *
 * 为什么需要：模型可能一直点同一个点、或者对着加载中的界面空转。
 * 没有这个判据就会把步数上限烧光，还什么都没做成。
 */
export const STUCK_LIMIT = 4;

/** 一次任务执行的累计状态 */
export type TaskState = {
  steps: number;
  /** 连续没产生画面变化的步数 */
  stuck: number;
  /** 执行过的动作摘要（给最终汇报用） */
  log: string[];
};

export function createTaskState(): TaskState {
  return { steps: 0, stuck: 0, /** 连续无变化 */ log: [] };
}

/**
 * 一步之后更新状态。
 *
 * @param changed 这一步执行后画面是否明显变化
 */
export function advanceTaskState(state: TaskState, description: string, changed: boolean): TaskState {
  state.steps += 1;
  state.stuck = changed ? 0 : state.stuck + 1;
  state.log.push(description);
  // 只留最近 10 条，汇报用
  if (state.log.length > 10) state.log.splice(0, state.log.length - 10);
  return state;
}

/** 是否该停手了（超步数 / 卡住太久） */
export function shouldGiveUp(state: TaskState, maxSteps: number): { giveUp: boolean; reason: string } {
  if (state.steps >= maxSteps) return { giveUp: true, reason: `已经走了 ${state.steps} 步还没完成` };
  if (state.stuck >= STUCK_LIMIT) return { giveUp: true, reason: `连续 ${state.stuck} 步画面没有变化，可能卡住了` };
  return { giveUp: false, reason: '' };
}
