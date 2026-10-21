/**
 * 陪玩循环（代打的「持续跑」控制器）。
 *
 * ── 为什么单独一层 ──
 *
 * 原来的代打只有一个 `POST /autoplay/run`：点一次跑一轮。主人要的是「点开始，
 * 她自己一局一局地玩下去」——循环、间隔、失败退避、卡窗口等待、上限、停止口径
 * 都是**纯调度逻辑**，不该和截图/模型/注入搅在 index.ts 里。
 * 这里注入 `runRound`（真实实现调 runAutoplayOnce）与定时器，测试可以完全离线跑。
 *
 * ── 口径 ──
 *
 * - **窗口不在白名单不算失败**：那说明主人切去干别的了，等它回来即可（每拍先查窗口，
 *   不截图、不花钱）。只有「模型连续看不懂 / 注入连续被拒」才算失败，连续 N 次才停。
 * - **急停返回 stopped 时立刻停循环**：急停是粘滞的，继续跑只会每轮空转。
 * - **上限**：maxRounds 是预算保险丝（默认 200 轮），到点自己停，不会烧一夜。
 * - 状态每变一次就回调 onState，宿主据此广播/落盘，页面据此渲染「思考中…」气泡。
 */

/** 循环对外的状态 */
export type PlayState = 'idle' | 'thinking' | 'waiting' | 'stopped' | 'error';

/** runRound 的返回（与 autoplay.ts 的 AutoplayRound 结构兼容） */
export type PlayRoundLike =
  | { kind: 'planned'; thought: string; executed: boolean }
  | { kind: 'skipped'; reason: string; detail?: string }
  | { kind: 'stopped'; reason: string }
  | { kind: 'failed'; reason: string; message: string };

export type PlaySnapshot = {
  /** 循环是否还在跑 */
  running: boolean;
  state: PlayState;
  /** 已经完成的轮数（只有 planned 才计） */
  rounds: number;
  /** 开始时间（毫秒；未开始过则 undefined） */
  startedAtMs?: number;
  /** 最近一次状态变化的说明（给状态气泡用） */
  lastMessage: string;
  /** 停止原因（只在 stopped/error 时有） */
  lastReason?: string;
  /** 连续失败次数（成功一轮或跳到别的窗口会归零） */
  consecutiveFailures: number;
  /** 最近一轮从发出到返回用了多久（毫秒；诊断「一轮太慢」用） */
  lastRoundMs?: number;
  /** 最近一次状态变化的时间（页面据此决定气泡还显示多久） */
  updatedAtMs: number;
};

export type PlayLoopDeps = {
  /** 跑一轮；真实实现会先过急停/窗口/截图/模型/注入 */
  runRound: () => Promise<PlayRoundLike>;
  /** 状态变化回调（每次状态或轮数变化都会调） */
  onState?: (snapshot: PlaySnapshot) => void;
  /** 两轮之间的间隔（默认 1200ms） */
  intervalMs?: number;
  /** 失败后的退避（默认 3000ms） */
  failureDelayMs?: number;
  /** 连续失败多少次就停（默认 3） */
  failureLimit?: number;
  /** 单次会话最多跑多少轮（预算保险丝，默认 200） */
  maxRounds?: number;
  /** 可注入的时钟与定时器（测试用） */
  now?: () => number;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
};

export type PlayLoop = {
  /** 开始（已在跑则忽略） */
  start: () => void;
  /** 停止并记录原因（幂等） */
  stop: (reason: string) => void;
  /** 当前快照 */
  snapshot: () => PlaySnapshot;
};

const DEFAULT_INTERVAL_MS = 1200;
const DEFAULT_FAILURE_DELAY_MS = 3000;
const DEFAULT_FAILURE_LIMIT = 3;
const DEFAULT_MAX_ROUNDS = 200;

export function createPlayLoop(deps: PlayLoopDeps): PlayLoop {
  const intervalMs = Math.max(100, deps.intervalMs ?? DEFAULT_INTERVAL_MS);
  const failureDelayMs = Math.max(100, deps.failureDelayMs ?? DEFAULT_FAILURE_DELAY_MS);
  const failureLimit = Math.max(1, deps.failureLimit ?? DEFAULT_FAILURE_LIMIT);
  const maxRounds = Math.max(1, deps.maxRounds ?? DEFAULT_MAX_ROUNDS);
  const now = deps.now ?? (() => Date.now());
  const setTimeoutFn = deps.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimeoutFn =
    deps.clearTimeoutFn ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  let timer: unknown = undefined;
  let running = false;
  /** 每次 start 递增：async 轮次返回时用它判断「这轮是不是已经过期的」 */
  let generation = 0;
  let state: PlayState = 'idle';
  let rounds = 0;
  let startedAtMs: number | undefined;
  let lastMessage = '';
  let lastReason: string | undefined;
  let consecutiveFailures = 0;
  /** 连续「模型观望（noop）」的次数（软计数：不算错误） */
  let idleRounds = 0;
  let lastRoundMs: number | undefined;
  let updatedAtMs = now();

  const snapshot = (): PlaySnapshot => ({
    running,
    state,
    rounds,
    ...(startedAtMs === undefined ? {} : { startedAtMs }),
    lastMessage,
    ...(lastReason === undefined ? {} : { lastReason }),
    consecutiveFailures,
    ...(lastRoundMs === undefined ? {} : { lastRoundMs }),
    updatedAtMs,
  });

  const emit = (): void => {
    updatedAtMs = now();
    deps.onState?.(snapshot());
  };

  const clearTimer = (): void => {
    if (timer !== undefined) {
      clearTimeoutFn(timer);
      timer = undefined;
    }
  };

  const schedule = (delayMs: number): void => {
    clearTimer();
    const gen = generation;
    timer = setTimeoutFn(() => {
      timer = undefined;
      if (!running || gen !== generation) return;
      void tick(gen);
    }, delayMs);
  };

  const finish = (next: PlayState, reason: string | undefined, message: string): void => {
    running = false;
    clearTimer();
    state = next;
    if (reason !== undefined) lastReason = reason;
    lastMessage = message;
    emit();
  };

  const stop = (reason: string): void => {
    if (!running) return;
    finish('stopped', reason, '已停止：' + reason);
  };

  async function tick(gen: number): Promise<void> {
    if (!running || gen !== generation) return;
    state = 'thinking';
    lastMessage = '思考中…';
    emit();
    const roundStartedAt = now();

    let round: PlayRoundLike;
    try {
      round = await deps.runRound();
    } catch (e) {
      round = { kind: 'failed', reason: 'exception', message: e instanceof Error ? e.message : String(e) };
    }
    lastRoundMs = now() - roundStartedAt;
    // 轮次返回时可能已经被停止/重启：过期结果直接丢弃
    if (!running || gen !== generation) return;

    if (round.kind === 'stopped') {
      finish('stopped', round.reason, '已停止：' + round.reason);
      return;
    }

    if (round.kind === 'planned') {
      rounds++;
      consecutiveFailures = 0;
      idleRounds = 0;
      lastReason = undefined;
      state = 'waiting';
      lastMessage = (round.executed ? '执行了：' : '空跑：') + round.thought;
      emit();
      if (rounds >= maxRounds) {
        finish('stopped', 'round-cap', `到上限了（${maxRounds} 轮），先停`);
        return;
      }
      schedule(intervalMs);
      return;
    }

    if (round.kind === 'skipped' && round.reason === 'window-not-allowed') {
      // 主人在用别的窗口：不算失败，等她回来（这一拍不截图、不花钱）
      state = 'waiting';
      lastMessage = '不在白名单窗口：' + (round.detail ?? '（无标题）');
      emit();
      schedule(intervalMs);
      return;
    }

    if (round.kind === 'skipped' && round.reason === 'model-noop') {
      // 模型选择「观望」：不是错误。回合制游戏里这会经常发生（比如对方回合、动画播放中）。
      // 单独计数、间隔拉长（2.5s），连续 8 次都没动作才停——早先按失败 3 次就停，
      // 表现就是「开局三步就说没进展」。
      idleRounds++;
      state = 'waiting';
      lastMessage = '观望：' + (round.detail ?? '模型选择不动') + `（第 ${idleRounds} 次）`;
      emit();
      if (idleRounds >= 8) {
        finish('stopped', 'model-noop-limit', '连续 8 次没有可执行动作，先停（模型认为现在无事可做）');
        return;
      }
      schedule(2500);
      return;
    }

    // 看不懂（unparseable）与 failed 算失败：连续到上限才停
    consecutiveFailures++;
    idleRounds = 0;
    const reason = round.kind === 'skipped' ? round.reason : round.reason;
    const detail = round.kind === 'skipped' ? (round.detail ?? round.reason) : round.message;
    if (consecutiveFailures >= failureLimit) {
      finish('error', reason, `连续 ${consecutiveFailures} 次没进展，先停：${detail}`);
      return;
    }
    state = 'waiting';
    lastMessage = '没进展（' + detail + '），再试一次…';
    emit();
    schedule(failureDelayMs);
  }

  return {
    start: () => {
      if (running) return;
      generation++;
      running = true;
      rounds = 0;
      consecutiveFailures = 0;
      idleRounds = 0;
      startedAtMs = now();
      lastReason = undefined;
      state = 'waiting';
      lastMessage = '准备中…';
      emit();
      const gen = generation;
      // 第一轮立刻跑（不额外等一拍）
      timer = setTimeoutFn(() => {
        timer = undefined;
        if (!running || gen !== generation) return;
        void tick(gen);
      }, 0);
    },
    stop,
    snapshot,
  };
}
