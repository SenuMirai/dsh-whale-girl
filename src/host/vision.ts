/**
 * 视觉对话：把一张 JPEG（base64）交给 DeepSeek 官方 API，让她「看一眼并说话」。
 *
 * ── 为什么直连官方 API，而不是用 ctx.llm ──
 *
 * DSH 的图片消息只能吃 `ImageAttachmentRef`，而附件存储是**写磁盘**的
 * （`.dsh/attachments/v1/objects/` 里已经有 195 个对象）。主人的要求是
 * 「截图仅在内存中处理、不写入本地文件、不保留副本」——走 DSH 内置通道做不到。
 *
 * 官方 API 的 `image_url: { url: "data:image/jpeg;base64,..." }` 可以把图片
 * 直接放在请求体里，**整条链路只在进程内存中**，一个字节都不落盘。
 *
 * 实测（2026-10-18 本机）：
 *   - `DEEPSEEK_API_KEY` 有效，余额 ¥3.57
 *   - `deepseek-flash` 的 `input_modalities: ["text","image"]` → 支持视觉
 *   - 一张 160×120 的测试图，prompt 234 tokens，耗时约 1.3 秒
 *
 * ── 失败口径 ──
 * 所有失败都返回**结构化原因**，不静默、不伪造"她说了什么"。
 */

/** 官方 API 端点 */
const API_BASE = 'https://api.deepseek.com';

/** 视觉模型。deepseek-flash 支持图像输入；v4-pro 不支持（input_modalities 只有 text）。 */
const VISION_MODEL = 'deepseek-flash';

/** 单次视觉请求超时：实测 1.3 秒，给到 45 秒足够覆盖网络抖动 */
const REQUEST_TIMEOUT_MS = 45_000;

/**
 * 输出预算 —— **必须给足**。
 *
 * `deepseek-flash` 是推理模型：先吐 `reasoning_content`，再吐 `content`，
 * 两者**共用同一份 `max_tokens`**。实测给 200 时，200 个 token 全被思考吃掉，
 * `finish_reason` 变成 `length`、`content` 是**空字符串**——
 * 看起来像「模型什么都没返回」，实际是预算被思考阶段烧完了。
 *
 * 1024 对「一两句口语」绰绰有余，思考通常 200~500 token，也不至于成本失控。
 */
const MAX_TOKENS = 1024;

/** 失败原因 */
export type SightFailure = {
  ok: false;
  reason:
    | 'no-key'
    | 'unauthorized'
    | 'rate-limited'
    | 'network'
    | 'timeout'
    | 'bad-response'
    | 'empty-reply';
  message: string;
};

export type SightResult = { ok: true; text: string; model: string; elapsedMs: number } | SightFailure;

/** 让模型「看一眼」得到的产出 */
export type SightReply = { speak: boolean; text: string };

/**
 * 观察模式。
 *
 * 同一张截图、同一条链路，**换的是人设与关注点**：
 *  - `companion`：日常陪聊。看到什么顺口提一句，没话就沉默。
 *  - `play`：陪玩。盯着战况——局势、血量、资源、下一步该干嘛。
 *  - `watch`：看不说话（只记录，供后续决策用，不打扰主人）。
 */
export type SightMode = 'companion' | 'play' | 'watch';

/**
 * 视觉观察的提示词。
 *
 * 设计要点：
 * - **允许沉默**：没好说的就回 `[SKIP]`。不硬凑话，否则她会每 60 秒点评一次空气。
 * - **短**：这是陪伴不是解说，一两句就够。
 * - **认游戏/番剧**：主人的主要场景是打游戏和看番，认出来才有"陪玩"的感觉。
 * - **不许编**：看不清就说看不清，不要猜剧情。
 * - **不要 Markdown**：这段话原样进气泡。
 */
const PROMPT_COMMON_TAIL = `
4. 绝不编造你看不清的内容。看不清就按第 3 条处理。
5. 不要说"我看到"、"根据画面"这类旁白，直接说话。
6. 不要提你是 AI。
7. **不要用任何 Markdown 符号**（不要反引号、星号、井号、代码块）——这段话会原样显示在气泡里，符号会变成乱码。要提代码或文件名就直接写，不加修饰。`;

const PROMPTS: Record<SightMode, string> = {
  companion: `你在陪主人用电脑。你会看到主人当前屏幕的一小块画面。

请像坐在旁边的人一样，自然地说一句话（不超过 40 字，口语，中文）。

规则：
1. 如果你能看出主人在玩什么游戏、看什么视频/番剧，可以顺口提一下。
2. 如果你看到明显值得注意的事（打得很精彩、卡关了、报错了、队伍快没血了），可以点评或提醒。
3. 如果画面没什么可说的（桌面、静态文档、聊天软件、什么都看不懂），**只回 [SKIP] 四个字符**，不要解释。${PROMPT_COMMON_TAIL}`,

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
};


/**
 * 调一次视觉模型。
 *
 * @param apiKey `DEEPSEEK_API_KEY` 的值（由调用方从 ctx.credentials 解析后注入）
 * @param dataUrl `data:image/jpeg;base64,...`
 * @param hint 额外上下文（比如"主人正在玩的游戏是《群星》"），可为空
 * @param mode 观察模式：日常陪聊 / 陪玩 / 只看不说（默认 companion）
 */
export async function describeScreen(
  apiKey: string,
  dataUrl: string,
  hint?: string,
  mode: SightMode = 'companion',
): Promise<SightResult> {
  const started = Date.now();
  if (apiKey.trim() === '') {
    return { ok: false, reason: 'no-key', message: '没有可用的 DEEPSEEK_API_KEY' };
  }

  const userText =
    mode === 'watch'
      ? hint === undefined || hint.trim() === ''
        ? '描述这个画面。'
        : `描述这个画面。${hint}`
      : hint === undefined || hint.trim() === ''
        ? '看看我现在在干什么。'
        : `看看我现在在干什么。${hint}`;

  const body = {
    model: VISION_MODEL,
    messages: [
      { role: 'system', content: PROMPTS[mode] },
      {
        role: 'user',
        content: [
          { type: 'text', text: userText },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ],
    // 见 MAX_TOKENS 的注释：这份预算同时供「思考」和「回答」用，给小了只会拿到空 content
    max_tokens: MAX_TOKENS,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (response.status === 401 || response.status === 403) {
      return { ok: false, reason: 'unauthorized', message: `API Key 无效或权限不足（HTTP ${response.status}）` };
    }
    if (response.status === 429) {
      return { ok: false, reason: 'rate-limited', message: '模型限流（429），稍后再试' };
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return { ok: false, reason: 'bad-response', message: `HTTP ${response.status}：${text.slice(0, 200)}` };
    }

    const json = (await response.json()) as {
      choices?: Array<{
        finish_reason?: string;
        message?: { content?: unknown; reasoning_content?: unknown };
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const choice = json.choices?.[0];
    const content = choice?.message?.content;
    const text = typeof content === 'string' ? content.trim() : '';
    if (text !== '') {
      return { ok: true, text, model: VISION_MODEL, elapsedMs: Date.now() - started };
    }

    // ── content 为空的两条兜底 ──
    //
    // 1) 推理模型把预算烧在思考上（finish_reason=length）→ 从 reasoning 里捞最后一句。
    //    聊胜于无：总比把「模型没有返回内容」丢给主人强，而且那句通常就是它的结论。
    // 2) reasoning 也没有（真的是空回复）→ 如实报错，不伪造。
    const reasoning = choice?.message?.reasoning_content;
    const think = typeof reasoning === 'string' ? reasoning.trim() : '';
    if (think !== '') {
      const lastLine = think
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '')
        .pop();
      if (lastLine !== undefined && lastLine !== '') {
        console.warn(
          `[dsh-whale-girl] 视觉模型 content 为空（finish_reason=${choice?.finish_reason ?? '?'}），已从 reasoning 兜底`,
        );
        return { ok: true, text: lastLine, model: VISION_MODEL, elapsedMs: Date.now() - started };
      }
    }
    return {
      ok: false,
      reason: 'empty-reply',
      message: `模型没有返回内容（finish_reason=${choice?.finish_reason ?? '?'}，思考 ${think.length} 字）`,
    };
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      return { ok: false, reason: 'timeout', message: `请求超时（${REQUEST_TIMEOUT_MS} ms）` };
    }
    return { ok: false, reason: 'network', message: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

// parseSightReply 已迁到 vision-llm.ts（那才是上线用的那份）。
// 这里**不再提供副本，也不 re-export**：tsc 要求无扩展名、Node 直跑又要求带扩展名，
// 两者在同一个 import 上没法同时满足。需要它的地方（测试、host）直接引 vision-llm。