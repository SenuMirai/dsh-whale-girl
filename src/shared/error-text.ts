/**
 * 模型/语音失败的**人话化**（浏览器 overlay 与桌面窗共用同一份）。
 *
 * 为什么必须有这一层：宿主会把上游的原始错误整段塞进 `message`
 * （实测有 300+ 字符的 429 JSON，还带 reset 时间戳）。原样显示会出现两种坏结果：
 *   - 气泡里一坨 JSON，主人看不出是什么事（而且撑破布局）
 *   - 语音按钮旁那个 nowrap 标签直接横向溢出屏幕，看起来像「什么都没发生」
 *
 * 这里只做「取最短可读摘要」，**不改语义**：
 * 拿不准的原样截断，绝不把失败粉饰成成功。
 */

/** 已知失败原因 → 一句中文 */
const KNOWN: Record<string, string> = {
  'service-missing': '语音识别服务不可用',
  'provider-missing': '没有启用语音识别',
  'no-pet': '没有可对话的宠物',
  'bad-request': '请求参数不对',
};

/**
 * 把宿主给的 reason/message 压成一句人能读的话。
 *
 * @param reason 结构化原因（`unsupported` / `generate-error` / …）
 * @param message 原始错误正文（可能很长）
 * @param maxLength 截断上限（默认 36 字，够说明又不会撑破气泡）
 */
export function humanizeModelError(reason?: string, message?: string, maxLength = 36): string {
  const raw = (message ?? reason ?? '未知错误').trim();
  if (raw === '') return reason !== undefined ? (KNOWN[reason] ?? reason) : '未知错误';

  // 限流：最常遇到，单独把「什么时候恢复」挑出来
  if (/\b429\b|soft_rate|rate.?limit|频率|quota|额度/i.test(raw)) {
    const reset = raw.match(/([0-9]{4}-[0-9]{2}-[0-9]{2})[ T]([0-9]{2}:[0-9]{2})/);
    return reset !== null ? `模型限流（${reset[1]} ${reset[2]} 恢复）` : '模型限流，稍后再试';
  }
  // 缺凭证：上游会写 key 名，保留更有用
  if (/api.?key|credential|凭据|凭证|401|403/i.test(raw)) return '缺少模型凭证（去设置里配一下）';
  if (/没听清|empty/i.test(raw)) return '没听清，再说一次';
  if (/Invalid speech WAV|canonical/i.test(raw)) return '录音格式被拒（内部错误）';
  if (/timeout|timed out|超时/i.test(raw)) return '请求超时，稍后再试';
  if (/ECONNREFUSED|ENOTFOUND|network|fetch failed/i.test(raw)) return '网络不通';

  // 兜底：结构化原因优先展示成中文名，其余截断
  if (KNOWN[raw] !== undefined) return KNOWN[raw];
  if (reason !== undefined && KNOWN[reason] !== undefined) return KNOWN[reason];

  const oneLine = raw.replace(/\s+/g, ' ');
  return oneLine.length > maxLength ? oneLine.slice(0, maxLength) + '…' : oneLine;
}
