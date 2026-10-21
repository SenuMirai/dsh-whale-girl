/**
 * 把模型回复拆成「台词」与「动作/神态」。
 *
 * ── 为什么 ──
 *
 * 主人要的是**单纯的自然语言聊天**：气泡里/语音里只出现她说的话。
 * 但带动作神态的版本又舍不得丢——那份进「对话记录」，随时可以翻。
 *
 * 格式约定（写进提示词）：
 *   正常说话，一行一句。
 *   【动作】她把尾巴甩了甩。   ← 可选，只进记录，不显示/不朗读
 *
 * 兼容旧回复：没有【动作】标记时，把**整段都在括号里**的旁白从台词里剔除；
 * 段落里夹着的括号（比如「（笑）」）保留，避免误伤正常说话。
 */

export type ChatFormat = { speech: string; action: string };

/** 动作段的标记：「【动作】」「[神态]」「动作：」「--- 动作 ---」都认 */
const ACTION_MARKER = /^\s*(?:【(?:动作|神态|表情|心理|旁白)】|\[(?:动作|神态|表情|心理|旁白)\]|(?:动作|神态|表情|心理|旁白)\s*[:：]|-{2,}\s*(?:动作|神态|表情|心理|旁白)\s*-{2,})/;

/** 整段都是旁白：`（…）` / `(…)` / `【…】` / `*…*` */
function isStageParagraph(paragraph: string): boolean {
  const p = paragraph.trim();
  if (p === '') return false;
  return /^[（(【\[][\s\S]*[）)】\]]$/.test(p) || /^\*[^*\n]+\*$/.test(p);
}

export function splitChatReply(raw: string): ChatFormat {
  const text = raw.trim();
  if (text === '') return { speech: '', action: '' };

  const speechLines: string[] = [];
  const actionLines: string[] = [];
  let inAction = false;
  for (const line of text.split(/\r?\n/)) {
    if (ACTION_MARKER.test(line)) {
      inAction = true;
      const rest = line.replace(ACTION_MARKER, '').trim();
      if (rest !== '') actionLines.push(rest);
      continue;
    }
    if (inAction) actionLines.push(line);
    else speechLines.push(line);
  }

  let speech = speechLines.join('\n').trim();
  if (speech !== '') {
    const paragraphs = speech
      .split(/\n{2,}/)
      .map((paragraph) => {
        // 去掉段首的旁白前缀：「（甩了甩尾巴）你好」→「你好」
        let p = paragraph.trim();
        p = p.replace(/^(?:[（(][^）)]{0,200}[）)]\s*)+/, '').trim();
        return p;
      })
      .filter((paragraph) => paragraph !== '' && !isStageParagraph(paragraph));
    const cleaned = paragraphs.join('\n\n').trim();
    // 整条回复都是旁白（旧版可能这样）→ 至少别让她“说不出话”，把原文当台词
    if (cleaned !== '') speech = cleaned;
  }

  // 只有动作、没有台词：把动作当台词，别给主人一个空气泡
  if (speech === '' && actionLines.length > 0) {
    return { speech: actionLines.join('\n').trim(), action: '' };
  }
  return { speech, action: actionLines.join('\n').trim() };
}
