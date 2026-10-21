/**
 * 当前模型是否支持 reasoning effort（含 "off"）的探测（host 半侧共用）。
 *
 * dsh-llm 对"模型无 reasoning 元数据 + 调用方显式传 effort"会直接判
 * UNSUPPORTED_REASONING_EFFORT（请求发不出去，被 adapter 折叠成空流，
 * 表现为"模型未返回文本"），因此只有在模型确实声明支持时才应传
 * reasoningEffort: 'off'；其余情况省略该字段（语义等价："off" 对无 reasoning
 * 元数据的模型本就等于"不传"）。
 */

/** 可调用的 dsh-llm resolveModelInfo 能力的最小形状（防御式：不依赖完整类型） */
interface ResolveModelInfoCapable {
  resolveModelInfo?(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<{ reasoning?: { efforts?: ReadonlyArray<{ id: string }> } }>;
}

/**
 * 当前 provider/model 是否声明支持 reasoning effort（含 "off"）。
 * 能力缺失或查询失败一律保守返回 false（= 不传，等价于模型默认行为，避免请求失败）。
 */
export async function supportsReasoningOff(ctx: { llm?: unknown }, provider: string, model: string): Promise<boolean> {
  const llm = ctx.llm as ResolveModelInfoCapable | undefined;
  if (!llm || typeof llm.resolveModelInfo !== 'function') return false;
  try {
    const info = await llm.resolveModelInfo(provider, model);
    return info?.reasoning?.efforts?.some((e) => e.id === 'off') ?? false;
  } catch {
    return false; // 查询失败保守不传（等价于模型默认行为，不至于让请求失败）
  }
}

/**
 * 选这个模型**最省的** reasoning effort。
 *
 * 为什么需要：有的模型不支持 "off"（只能思考），但支持 low/high/max 多档。
 * 看图决定「下一步按什么键」不需要深度思考，默认档（往往是 high/max）会让一轮
 * 拖到十几二十秒（实测 18~27 秒/轮），游戏根本没法玩。
 *
 * @returns effort id；模型没有任何 reasoning 元数据时返回 undefined（= 不传）
 */
export async function cheapestReasoningEffort(
  ctx: { llm?: unknown },
  provider: string,
  model: string,
): Promise<string | undefined> {
  const llm = ctx.llm as ResolveModelInfoCapable | undefined;
  if (!llm || typeof llm.resolveModelInfo !== 'function') return undefined;
  try {
    const info = await llm.resolveModelInfo(provider, model);
    const ids = (info?.reasoning?.efforts ?? []).map((e) => e.id);
    if (ids.length === 0) return undefined;
    for (const preferred of ['off', 'minimal', 'low']) {
      if (ids.includes(preferred)) return preferred;
    }
    // 都不认识：取声明里的第一个（通常按从省到贵排列）
    return ids[0];
  } catch {
    return undefined;
  }
}
