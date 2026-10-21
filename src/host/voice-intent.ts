/**
 * 语音指令：让「说话」能直接操控她和电脑，而不只是闲聊。
 *
 * ── 为什么需要一层独立的意图识别 ──
 *
 * 主人想说的是「就算语音对话能让它操控一切，包括它自身行为和功能开关、游戏、
 * 计算机上的其他应用」。如果每次都要先把话交给大模型、模型再决定调工具，
 * 那开个关也要 2~4 秒 + 一次模型调用——太重了。
 *
 * 所以常见指令走**本地规则**（0 成本、毫秒级），只在规则认不出来时才退回闲聊。
 * 这是刻意的分工：确定的命令不花钱，模糊的表达才花钱。
 *
 * ── 安全 ──
 *
 * 这里只产出「意图」，真正执行在 host 侧，且**所有动作都受既有闸门约束**
 * （代打开关、窗口白名单、急停）。语音不能绕过任何一道安全闸。
 */

/** 可被语音触发的意图 */
export type VoiceIntent =
  | { kind: 'end-session' }
  | { kind: 'toggle-sight'; on?: boolean }
  | { kind: 'toggle-autoplay'; on?: boolean }
  | { kind: 'stop-now' }
  | { kind: 'open-app'; target: string }
  | { kind: 'look-now' }
  | { kind: 'status' }
  | { kind: 'search'; query: string };

/** 去掉标点与空白，便于中文匹配 */
function normalize(text: string): string {
  return text
    .replace(/[，。！？、；：「」【】（）《》,.!?;:()[\]<>'"]/g, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

/** 判断一句话是不是「让某功能 开/关」，返回目标状态 */
function onOff(text: string): boolean | undefined {
  if (/关闭|关掉|别|不要|停止|停用/.test(text)) return false;
  if (/打开|开启|启动|打开吧|开一下|启用/.test(text)) return true;
  return undefined;
}

/**
 * 识别一句话里的指令。
 *
 * 返回 undefined = 不是指令，走正常闲聊。
 *
 * 设计原则：**宁漏不错**。听不懂就当闲聊，绝不去猜着执行一个危险动作
 * （"帮我关掉那个"这种模糊表达会落到 undefined，而不是被当成关代打）。
 */
export function parseVoiceIntent(raw: string): VoiceIntent | undefined {
  const text = normalize(raw);
  if (text === '') return undefined;

  // ── 停下（最高优先级：任何时候都要能喊停）──
  if (/^(停|停下|停下来|别动|停手|停止操作|急停)$/.test(text) || /马上停下|立刻停下|先停下/.test(text)) {
    return { kind: 'stop-now' };
  }

  // ── 结束本局 ──
  if (/结束本局|结束这局|这局结束|玩完了|不玩了|收工|结束游戏/.test(text)) {
    return { kind: 'end-session' };
  }

  // ── 看一眼 ──
  if (/看一眼|看一下|看看屏幕|你看一眼|瞧瞧|瞅一眼/.test(text)) {
    return { kind: 'look-now' };
  }

  // ── 开关：主动识屏 ──
  if (/识屏|看屏幕|看视屏/.test(text) && /开|关|停|启用|别/.test(text)) {
    const want = onOff(text);
    if (want !== undefined) return { kind: 'toggle-sight', on: want };
  }

  // ── 开关：代打 ──
  if (/代打|自动玩|替我玩|帮我玩/.test(text) && /开|关|停|启用|别/.test(text)) {
    const want = onOff(text);
    if (want !== undefined) return { kind: 'toggle-autoplay', on: want };
  }

  // ── 状态 ──
  if (/现在什么状态|状态怎么样|在干什么|本局多少步|进度多少/.test(text)) {
    return { kind: 'status' };
  }

  // ── 打开应用：把"打开/启动"后面的东西当目标 ──
  const openMatch = raw.match(/(?:帮我)?(?:打开|启动|运行)\s*([^\s，。！？,.!?]{1,30})/);
  if (openMatch !== null) {
    const target = openMatch[1].trim();
    // 排除"打开识屏/打开代打"这种功能开关（上面已经处理过）
    if (target !== '' && !/识屏|代打|看屏幕/.test(target)) {
      return { kind: 'open-app', target };
    }
  }

  // ── 让它自己查 ──
  const searchMatch = raw.match(/(?:帮我)?(?:搜一下|搜搜|查一下|查查|搜索)\s*(.{1,60})/);
  if (searchMatch !== null) {
    const query = searchMatch[1].trim();
    if (query !== '') return { kind: 'search', query };
  }

  return undefined;
}

/** 把意图转成一句回话（执行成功后播报用） */
export function intentReply(intent: VoiceIntent, detail?: string): string {
  switch (intent.kind) {
    case 'end-session':
      return detail ?? '这局收工啦，我都记住了。';
    case 'toggle-sight':
      return intent.on === false ? '好，我不看了。' : '好，我盯着屏幕。';
    case 'toggle-autoplay':
      return intent.on === false ? '好，我停手。' : '好，我来操作。';
    case 'stop-now':
      return '停了。';
    case 'open-app':
      return `好，打开${intent.target}。`;
    case 'look-now':
      return detail ?? '嗯，我看看。';
    case 'status':
      return detail ?? '我在呢。';
    case 'search':
      return detail ?? `我去查查「${intent.query}」。`;
  }
}
