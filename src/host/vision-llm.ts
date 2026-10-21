/**
 * 视觉对话：把一张 JPEG 交给**当前选定的模型**看一眼并说话。
 *
 * ── 为什么走 ctx.llm（而不是直连官方 API）──
 *
 * 早先这里直连 `api.deepseek.com`，好处是纯内存不落盘，代价是**只烧官方 token**：
 * 主人用的是 workbuddy 的积分渠道，识屏却硬吃官方余额，一晚上几十次调用就是真金白银。
 *
 * 现在改走 DSH 的 `ctx.llm.stream()`：**模型跟着设置里选的那个走**，
 * 选 workbuddy 就花积分，选官方就花 token，主人自己决定。
 *
 * ── 代价（如实）──
 *
 * DSH 的图片消息只能吃 `ImageRef`，而附件存储**只有落盘实现**
 * （`@deepseek-ai/dsh-attachment-local` 里是 `writeFile` + `link` 到
 * `objects/<sha256>`，全文没有任何内存模式）。所以这条路**必然写一次盘**。
 *
 * 折中：调用一结束立刻 unlink，做到「落地即焚」。快照副本是另一回事
 * （那是给主人核对用的审计副本，按保留张数管理）。
 *
 * 这个取舍是主人明确拍板的：宁可落盘 1 秒，也不要不必要的支出。
 */

import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import type { ModelRef } from './model-selection';

/**
 * 选这个模型最省的 reasoning effort。
 *
 * 为什么在这里内联一份（而不是 import ./llm-reasoning）：tools 下的测试直接用
 * node 的 TS 类型擦除跑 src 目录里的 .ts，相对路径 import 必须带扩展名才能解析；
 * 而 tsc 的当前配置又不允许 .ts 扩展名。vision-llm.ts 之前只 import 了外部包，
 * 是这批测试能直接跑的原因。为一行探测把测试链搞坏不值得，所以内联。
 * （chat/whisper 走的是 pnpm test 的 register 解析器，不受这条限制，仍用 llm-reasoning。）
 */
async function cheapestEffort(
  ctx: { llm?: unknown },
  provider: string,
  model: string,
): Promise<string | undefined> {
  const llm = ctx.llm as
    | { resolveModelInfo?(p: string, m: string): Promise<{ reasoning?: { efforts?: ReadonlyArray<{ id: string }> } }> }
    | undefined;
  if (llm === undefined || typeof llm.resolveModelInfo !== 'function') return undefined;
  try {
    const info = await llm.resolveModelInfo(provider, model);
    const ids = (info?.reasoning?.efforts ?? []).map((e) => e.id);
    if (ids.length === 0) return undefined;
    // 动作模式优先「low」而不是「off」：战棋的回合/阵营判断需要一点多步推理，
    // 完全关掉思考时模型容易看一眼就说「看不清」（DeepSeek 网页端开着思考就答得很准）。
    // low 档实测仍只有几秒；没有 low 再退 off / minimal。
    for (const preferred of ['low', 'off', 'minimal']) {
      if (ids.includes(preferred)) return preferred;
    }
    return ids[0];
  } catch {
    return undefined;
  }
}

/**
 * 图片附件的结构（与 DSH 的 `ImageRef` 同构）。
 *
 * 为什么不直接 import 那个类型：`@deepseek-ai/dsh-attachment` 不在本插件的
 * 依赖声明里，引它会编译不过。这里只描述**我们真正用到的字段**，
 * 靠结构兼容通过类型检查。
 */
type ImageRef = {
  attachmentId: string;
  mediaType: string;
  bytes: number;
  width: number;
  height: number;
  name?: string;
};

/** 单次视觉请求超时：推理模型看图 + 思考，给足 60 秒 */
const TIMEOUT_MS = 60_000;

/**
 * 输出预算 —— **必须给足**。
 *
 * 推理模型先吐 reasoning 再吐 content，两者共用这一份预算。
 * 给 200 时实测 200 全被思考吃掉、`content` 是空串（看着像「模型什么都没返回」）。
 */
const MAX_TOKENS = 1024;

export type VisionFailure = {
  ok: false;
  reason: 'no-model' | 'attachments-missing' | 'unauthorized' | 'rate-limited' | 'network' | 'timeout' | 'bad-response' | 'empty-reply';
  message: string;
};

export type VisionResult = { ok: true; text: string; model: string; elapsedMs: number } | VisionFailure;

/** 让模型「看一眼」得到的产出 */
export type SightReply = { speak: boolean; text: string };

/**
 * 观察模式。
 *
 * 同一张截图、同一条链路，**换的是人设与关注点**：
 *  - `companion`：日常陪聊。看到什么顺口提一句，没话就沉默。
 *  - `play`：陪玩。盯着战况——局势、血量、资源、下一步该干嘛。
 *  - `watch`：看不说话（只记录，供后续决策用，不打扰主人）。
 *  - `action`：替主人操作游戏。只输出**一行动作指令**（格式由调用方在系统提示里给），
 *    不要描述、不要解释。代打/任务循环走这一档——`watch` 的系统提示要求「只做客观描述」，
 *    和「只输出一行动作」是**互相矛盾**的指令，模型只会去描述，解析器必然报 unparseable（实测）。
 */
export type SightMode = 'companion' | 'play' | 'watch' | 'action';

const PROMPT_COMMON_TAIL = `
4. 绝不编造你看不清的内容。看不清就按第 3 条处理。
5. 不要说"我看到"、"根据画面"这类旁白，直接说话。
6. 不要提你是 AI。
7. **不要用任何 Markdown 符号**（不要反引号、星号、井号、代码块）——这段话会原样显示在气泡里，符号会变成乱码。要提代码或文件名就直接写，不加修饰。`;

const PROMPTS: Record<SightMode, string> = {
  companion: `你正坐在主人旁边一起用电脑，看到的是 TA 现在的屏幕。

像熟人一样随口搭一句（1~2 句，中文，口语，可以有情绪）。这是**搭话，不是汇报**：
1. **不要复述屏幕内容**——不要说「你在看/你在写/画面里/这里显示…」，直接说你的反应、吐槽、好奇或关心；
2. 可以问一句、开玩笑、催一催、夸一下；每次换角度、换开头，别用同一个句式；
3. 看到值得注意的事（打得精彩、报错、卡关、快没血了）就直说，别念说明书；
4. 如果画面没什么可说的（桌面、静态文档、聊天软件、什么都看不懂），**只回 [SKIP] 四个字符**，不要解释。${PROMPT_COMMON_TAIL}`,

  play: `你正坐在主人旁边**看他玩游戏**。你会看到游戏画面。

像真的在旁边看人打游戏那样说一句（不超过 40 字，口语，中文）。

规则：
1. **先说局势再说建议**：战况怎么样、谁占优、资源/血量/时间紧不紧张。
2. 看到**具体该做的决定**就直接说（该开团了、这个科技树先点那个、留钱别乱花、这里能绕后）。
   不确定就只描述局势，不要瞎指挥。
3. 打得精彩就叫好，要崩了就提醒——像朋友那样，不要念说明书。
4. 如果画面不是游戏（桌面、聊天、文档），或者你看不出局势，**只回 [SKIP]**，不要硬聊。
${PROMPT_COMMON_TAIL}`,

  watch: `你在观察主人的屏幕，但**这次不要说话**——你的输出会被程序拿去判断下一步动作，不会显示给主人。

请只做客观描述（不超过 80 字，中文，不要 Markdown）：
1. 这是什么界面/游戏？
2. 当前关键状态（血量、资源、棋盘局面、菜单选项、可点击的按钮）。
3. 如果是游戏回合，现在是该谁行动。

看不清就说明看不清，**不要猜**。不要回 [SKIP]，这里需要描述而不是沉默。`,

  // 这一档的系统提示由调用方覆盖（见 lookAtScreen 的 systemOverride）：
  // 完整动作格式（autoplay.ts 的 AUTOPLAY_PROMPT）必须放在系统提示里，
  // 否则模型会把「描述画面」和「只输出一行」当成两条冲突的指令。
  action: `你在替主人操作游戏。只输出下一步的**一行动作指令**，不要描述画面、不要解释、不要 Markdown。`,
};

/** 把宿主上下文里我们要用的两个服务描述出来（结构化类型，避免 any） */
type VisionCtx = {
  llm: {
    stream(options: unknown): AsyncIterable<{
      type: string;
      text?: string;
      block?: { type?: string; text?: string };
    }>;
  };
  attachments: {
    saveImages(inputs: Array<{ data: Uint8Array; mediaType: string; name?: string }>): Promise<ImageRef[]>;
  };
};

/**
 * 看一眼屏幕。
 *
 * @param ctx 宿主上下文（要 llm + attachments）
 * @param jpeg 压缩后的 JPEG 字节
 * @param model 用哪个模型看（设置里选的，与对话共用）
 * @param mode 观察模式
 * @param hint 额外上下文，可为空
 * @param afterCall 调用结束的回调（用来立刻删掉临时附件，做到"落地即焚"）
 * @param systemOverride 覆盖系统提示（action 档要传完整的动作格式说明）
 */
export async function lookAtScreen(
  ctx: VisionCtx,
  /** 一张或多张连续帧（多帧才能比较画面变化） */
  jpeg: Uint8Array | Uint8Array[],
  model: ModelRef,
  mode: SightMode,
  hint: string | undefined,
  afterCall?: (refs: ImageRef[]) => void,
  systemOverride?: string,
): Promise<VisionResult> {
  const started = Date.now();
  if (model.provider === '' || model.model === '') {
    return { ok: false, reason: 'no-model', message: '还没选识图模型' };
  }
  if (typeof ctx.attachments?.saveImages !== 'function') {
    return { ok: false, reason: 'attachments-missing', message: '附件服务不可用（无法把图片交给模型）' };
  }

  let refs: ImageRef[] = [];
  try {
    // 存临时附件：DSH 的图片消息只认 ImageRef，没有别的路。
    // 多帧时一次存一组——调用方会在结束时把它们全部删掉（落地即焚）。
    const frames = Array.isArray(jpeg) ? jpeg : [jpeg];
    if (frames.length === 0) {
      return { ok: false, reason: 'attachments-missing', message: '没有可用的画面' };
    }
    refs = await ctx.attachments.saveImages(
      frames.map((data, i) => ({ data, mediaType: 'image/jpeg', name: 'screen-' + (i + 1) + '.jpg' })),
    );
    if (refs.length === 0) {
      return { ok: false, reason: 'attachments-missing', message: '附件存不进去' };
    }

    // watch 模式有两种用途，**提示词必须分开**：
    //  - 没有 hint：只描述画面（识屏陪聊用）
    //  - 有 hint：hint 本身就是完整指令（任务循环用），不能再套「描述这个画面」——
    //    否则模型同时收到"描述画面"和"只输出一行动作"两个矛盾指令，只会去描述。
    const userText =
      mode === 'watch' || mode === 'action'
        ? hint === undefined || hint.trim() === ''
          ? mode === 'action'
            ? '看这张画面，输出下一步动作。'
            : '描述这个画面。'
          : hint
        : hint === undefined || hint.trim() === ''
          ? '看看我现在在干什么。'
          : `看看我现在在干什么。${hint}`;

    // 动作模式必须把「完整动作格式」作为系统提示；缺省时退回 action 档的简短提示
    // （调用方应当传 systemOverride，否则模型不知道合法格式）。
    const systemText = systemOverride ?? PROMPTS[mode];

    // 动作决策不需要深度思考：推理模型默认档（high/max）会把一轮拖到 18~27 秒（实测），
    // 游戏根本没法玩。选模型声明里**最省的一档**（off / minimal / low）；
    // 只有模型确实声明了 effort 才传，否则 dsh-llm 会判 UNSUPPORTED_REASONING_EFFORT。
    const effort = mode === 'action' ? await cheapestEffort(ctx, model.provider, model.model) : undefined;
    // 思考与正文共用输出预算：动作模式给宽一点，别让 thinking 把那一行动作吃光。
    // 实测教训（2026-10-18）：`workbuddy/step-5-preview` 是 onlyReasoning 模型，
    // 2048 预算被思考吃光后 content 为空 → 每轮 45~60 秒还报「模型没有返回内容」。
    // 推理模型的 maxTokens 动辄 64000，给 8192 才够「想完还能吐出一行动作」。
    const budget = mode === 'action' ? 8192 : MAX_TOKENS;

    // 组装用户消息。attachmentId 在 DSH 的类型里是 branded 字符串，
    // 我们运行时拿到的是普通 string —— 结构与值完全一致，只差编译期的品牌标记，
    // 所以整段消息做一次断言（不是绕过校验，是补上那个纯类型标记）。
    const blocks = [
      ...refs.map((r) => ({ type: 'image' as const, attachment: r })),
      { type: 'text' as const, text: userText },
    ];
    const userMessage = createUserMessage({
      content: blocks as unknown as Parameters<typeof createUserMessage>[0]['content'],
      source: { kind: 'user' },
    });

    /** 跑一次流式请求，返回拼好的正文（空串 = 模型只思考没产出正文） */
    const attempt = async (maxTokens: number): Promise<string> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      let text = '';
      try {
        const stream = ctx.llm.stream({
          provider: model.provider,
          model: model.model,
          system: systemText,
          messages: [userMessage],
          maxTokens,
          ...(effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(effort) }),
          signal: controller.signal,
          sessionId: 'dsh-whale-girl:sight',
        });

        for await (const chunk of stream) {
          if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
            text += chunk.text;
          } else if (chunk.type === 'block-end' && chunk.block?.type === 'text' && typeof chunk.block.text === 'string') {
            // 有的适配器只在 block-end 给完整文本；text-delta 已经拼过就不要重复
            if (text === '') text = chunk.block.text;
          } else if (chunk.type === 'finish') {
            break;
          }
        }
      } finally {
        clearTimeout(timer);
      }
      return text.trim();
    };

    let trimmed = await attempt(budget);
    // 推理模型偶尔还是会把预算吃光：动作模式再试一次（预算翻倍）。
    // 宁可多花一次调用，也不要让主人看到「让我想想 → 没进展」的死循环。
    if (trimmed === '' && mode === 'action') {
      console.warn('[dsh-whale-girl] 识图模型只思考没吐正文，翻倍预算重试一次：' + model.provider + '/' + model.model);
      trimmed = await attempt(budget * 2);
    }
    if (trimmed === '') {
      return { ok: false, reason: 'empty-reply', message: '模型没有返回内容' };
    }
    return { ok: true, text: trimmed, model: `${model.provider}/${model.model}`, elapsedMs: Date.now() - started };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/abort/i.test(msg)) return { ok: false, reason: 'timeout', message: `请求超时（${TIMEOUT_MS} ms）` };
    if (/401|403|unauthor/i.test(msg)) return { ok: false, reason: 'unauthorized', message: msg };
    if (/429|rate.?limit|频率/i.test(msg)) return { ok: false, reason: 'rate-limited', message: msg };
    return { ok: false, reason: 'bad-response', message: msg };
  } finally {
    // 落地即焚：无论成功失败都把临时附件交给调用方清理
    afterCall?.(refs);
  }
}

/**
 * 诊断：用同一条 llm 通道发一条**纯文本**小请求，量一下这个模型/路由本身的延迟。
 *
 * 代打一轮要十几秒时，得先分清是「模型链路慢」还是「看图慢」：
 * 文本也要 10 秒 → 是服务商/路由的问题（换模型才有意义）；
 * 文本 1 秒、看图 12 秒 → 是图片处理/思考档位的问题。
 */
export async function probeModelLatency(
  ctx: { llm: VisionCtx['llm'] },
  model: ModelRef,
  effort?: string,
): Promise<{ ok: boolean; elapsedMs: number; text?: string; message?: string }> {
  const started = Date.now();
  try {
    let text = '';
    const stream = ctx.llm.stream({
      provider: model.provider,
      model: model.model,
      system: '你是回声器。只回两个字：好的。',
      messages: [
        createUserMessage({
          content: [{ type: 'text', text: '回复：好的' }] as unknown as Parameters<typeof createUserMessage>[0]['content'],
          source: { kind: 'user' },
        }),
      ],
      maxTokens: 32,
      ...(effort === undefined || effort === '' ? {} : { reasoningEffort: ReasoningEffortId(effort) }),
      signal: AbortSignal.timeout(60_000),
      sessionId: 'dsh-whale-girl:diag',
    });
    for await (const chunk of stream) {
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text;
      else if (chunk.type === 'finish') break;
    }
    return { ok: true, elapsedMs: Date.now() - started, text };
  } catch (e) {
    return { ok: false, elapsedMs: Date.now() - started, message: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 把模型输出解析成「要不要说话 + 说什么」。
 *
 * `[SKIP]` 是给模型的**沉默出口**：没东西可说时不要硬凑。
 */
export function parseSightReply(text: string): SightReply {
  // 先洗一遍：模型偶尔无视「不要 Markdown」的约定，回出反引号 / 星号 / 井号。
  // 这些进气泡会显示成乱码（实测拿到过 "又在让 AI 改 `" 这种被截断的句子）。
  const cleaned = text
    .replace(/```[\s\S]*?```/g, ' ') // 整块代码 → 丢掉
    .replace(/[`*_#>|~]/g, '') // 行内符号 → 去掉
    .replace(/\s+/g, ' ')
    .trim();

  // 整句就是 SKIP 标记（容忍大小写与方括号）
  if (/^[[【]?\s*skip\s*[\]】]?$/i.test(cleaned)) return { speak: false, text: '' };
  // 句子中间夹了标记（模型偶尔会先解释再打标记）→ 也当作沉默
  if (/[[【]\s*skip\s*[\]】]/i.test(cleaned)) return { speak: false, text: '' };
  return { speak: cleaned !== '', text: cleaned };
}
