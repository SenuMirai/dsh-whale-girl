// 余额气泡（client 半侧）：展示当前服务商余额/用量。哑组件——数据由上层传入，
// 自身不发起请求；工厂形态与 pet.ts 一致（react 由 DSH 运行时注入）。
// 内容（文案/档位/数学）来自 src/shared/balance.ts 的 balanceBubbleView ——
// 与桌面模式共用同一份行数据，本文件只负责把行数据映射成 React 节点。
import { balanceBubbleView, type BalanceBubbleRow, type BalanceState } from '../shared/balance';
import {
  MEME_BUBBLE_CLASS,
  MEME_IMG_CLASS,
  injectMemeBubbleCss,
  memeImageUrl,
  whisperBubbleView,
} from '../shared/whisper';
import type { ReactNode } from 'react';
import type { jsx } from 'react/jsx-runtime';

/** 气泡内联样式：白色半透明圆润泡 + 底部小尾巴指向宠物；字体用上首软糖体（本地打包，稳定）。
 * 尺寸分两类锚点：
 *  - 气泡**盒子**（宽上下限/内边距/圆角/尾巴/阴影/行间距/角标）锚在字号 `--f` 上（em 语义）：
 *    字号调大盒子同步变大，文字永远装得下——不再出现「字长大了、框没长」把文字顶出白底；
 *  - 气泡**位置**（bottom 偏移）仍锚在 `--dsh-whale-girl-size`，保证气泡始终贴在宠物头顶同一点。
 * 系数 = 原系数 ÷ 0.0455（原字号系数），故默认 462px 宠物 / 21px 字号下与改造前逐像素一致：
 * ×0.0455 → 1em、最小宽 0.26 → 5.7143、最大宽 0.5 → 10.989 等。
 * 字号：正文取 --dsh-whale-girl-font-bubble（两端按该宠物尺寸算好注入，见 shared/fonts.ts 的 resolveFontPx）；
 * 气泡内其余层级按「相对正文的比例」派生——故统一先定义局部变量 --f = 正文最终字号，
 * 子元素经自定义属性继承取用；变量未注入时 --f 回退到原表达式，行为与改造前逐像素一致。
 * 换行：正文不锁 nowrap，折行只在内容真的超过宽度上限时才发生（见下一条）。
 * 宽度为什么必须写 width:max-content：气泡是 left:50% 的绝对定位盒，它的「可用宽度」只有包含块的一半
 * （= 宠物宽度的一半），shrink-to-fit 会先被这道墙卡死——max-width 调多大都不生效，字号一大就折行/顶出。
 * 写 width:max-content 后盒子先按内容取宽，再由 max-width 收口（= min(字号口径上限, 包含块 100%)），
 * 「字变大 → 框变宽」才真正生效，且永不超过宠物本身宽度（桌面窗口只比宠物大一圈，超了会被裁）。
 * 断词用 break-word 而非 anywhere：只在整词放不下时才断，不会把 85% / ¥12.34 这类数字拆到两行。 */
const bubbleCss = [
  // 本地字体：/dsh-whale-girl/font/ 由 host 从 assets/fonts 提供；font-display swap 先回退后切换
  '@font-face{font-family:"ShangshouSoftCandy";src:url("/dsh-whale-girl/font/上首软糖体.ttf") format("truetype");font-display:swap;font-weight:400}',
  '.dsh-whale-girl-bubble{position:absolute;left:50%;transform:translateX(-50%);' +
    'bottom:calc(100% - var(--dsh-whale-girl-size)*0.108);' +
    'width:max-content;min-width:calc(var(--f)*5.7143);max-width:min(calc(var(--f)*10.989),100%);' +
    // 钉死 content-box：宿主页面可能全局设了 border-box，那会让 min/max-width 把内边距也算进去，
    // 内容可用宽度被悄悄缩掉一圈（表现为「明明还有空位却折行」）。桌面端 index.html 同样钉死，两端一致。
    'box-sizing:content-box;' +
    'padding:calc(var(--f)*0.4835) calc(var(--f)*0.6593);' +
    'border-radius:calc(var(--f)*0.7692);' +
    'background:rgba(255,255,255,.92);' +
    '--f:var(--dsh-whale-girl-font-bubble,calc(var(--dsh-whale-girl-size)*0.0455));' +
    'color:#2b2b2b;font-family:var(--dsh-whale-girl-font-family,"ShangshouSoftCandy","Yuanti SC","YouYuan","幼圆","Comic Sans MS","PingFang SC","Microsoft YaHei",sans-serif);' +
    'font-size:var(--f);line-height:1.6;z-index:3;pointer-events:none;' +
    'box-shadow:0 calc(var(--f)*0.1978) calc(var(--f)*0.7692) rgba(0,0,0,.14),0 1px 3px rgba(0,0,0,.08);' +
    'backdrop-filter:blur(6px);opacity:0;transition:opacity .25s ease;' +
    'white-space:normal;overflow-wrap:break-word}',
  // 底部尾巴：小三角指向下方宠物（尺寸锚字号，与盒子同步）
  '.dsh-whale-girl-bubble::after{content:"";position:absolute;left:50%;bottom:calc(var(--f)*-0.3736);' +
    'transform:translateX(-50%);border:calc(var(--f)*0.3736) solid transparent;' +
    'border-top-color:rgba(255,255,255,.92);border-bottom:none}',
  '.dsh-whale-girl-bubble.is-on{opacity:1}',
  // 碎碎念变体：字号缩到余额气泡的 0.75（0.0455→0.034，即 ×0.7473）、宽度下限更窄（0.10 → 2.1978），
  // 上限与余额气泡相同；宽度取宽/折行的规则同 .dsh-whale-girl-bubble（继承 width:max-content）
  '.dsh-whale-girl-bubble.dsh-whale-girl-whisper{font-size:calc(var(--f)*0.7473);' +
    'min-width:calc(var(--f)*2.1978);max-width:min(calc(var(--f)*10.989),100%)}',
  // 配图（碎碎念/对话共用）：样式在 shared 的 MEME_BUBBLE_CSS（两端同一份，由
  // createMemeImage 注入）——这里不再重复写一份，避免与桌面端 index.html 走样
  '.dsh-whale-girl-bubble .pet-bub-title{font-size:calc(var(--f)*0.7692);color:rgba(43,43,43,.6);margin-bottom:calc(var(--f)*0.1978)}',
  '.dsh-whale-girl-bubble .pet-bub-row{display:flex;justify-content:space-between;gap:calc(var(--f)*0.6593)}',
  '.dsh-whale-girl-bubble .pet-bub-sub{font-size:calc(var(--f)*0.7692);color:rgba(43,43,43,.6)}',
  '.dsh-whale-girl-bubble .pet-bub-val{font-variant-numeric:tabular-nums;font-weight:650;color:#1f1f1f}',
  '.dsh-whale-girl-bubble .pet-bub-err{color:#d94f3d;font-size:calc(var(--f)*0.7692)}',
  '.dsh-whale-girl-bubble .pet-bub-tag{margin-left:calc(var(--f)*0.2857);font-size:calc(var(--f)*0.4835);color:rgba(43,43,43,.55);border:1px solid rgba(43,43,43,.25);' +
    'border-radius:calc(var(--f)*0.2857);padding:0 calc(var(--f)*0.1978);vertical-align:1px}',
  // 峰/谷计价档位标注：峰红、谷绿
  '.dsh-whale-girl-bubble .pet-bub-tier{font-weight:700}',
  '.dsh-whale-girl-bubble .pet-bub-tier-peak{color:#e53935}',
  '.dsh-whale-girl-bubble .pet-bub-tier-idle{color:#2e9e4f}',
].join('\n');

/** 只注入一次 */
function injectBubbleCss(): void {
  if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css="dsh-whale-girl/bubble"]') === null) {
    const tag = document.createElement('style');
    tag.dataset.plugin = 'dsh-whale-girl';
    tag.dataset.pluginCss = 'dsh-whale-girl/bubble';
    tag.textContent = bubbleCss;
    document.head.appendChild(tag);
  }
}

/** 行数据 → React 节点（shared 视图的薄壳） */
function rowsToNodes(h: typeof jsx, rows: BalanceBubbleRow[]): ReactNode {
  const block = (r: BalanceBubbleRow, key: number): ReactNode => {
    if (r.role === 'error') return h('div', { key, className: 'pet-bub-err', children: r.text });
    if (r.role === 'sub') return h('div', { key, className: 'pet-bub-row pet-bub-sub', children: r.text });
    return h('div', { key, className: 'pet-bub-row', children: r.text });
  };

  // 档位段（deepseek 余额）：`余额（峰）¥x.xx` 是**同一行**的三个片段，内联渲染。
  //
  // 但「档位行」不等于「全部行」：`money` 形状下还可能跟一条 sub 说明
  // （例如回落取数时那句「DSH 账号余额」）。早先的写法是「只要含 tier 就把所有行
  // 塞进同一个 flex 行」，结果那条说明被当成行内 span 挤成竖排、溢出白底——
  // 现在按「档位行 = 开头到第一个块级行」切片，剩下的照常一块一块渲染。
  const tierIndex = rows.findIndex((r) => r.role === 'tier');
  if (tierIndex >= 0) {
    const firstBlockAfterTier = rows.findIndex((r, i) => i > tierIndex && (r.role === 'sub' || r.role === 'error'));
    const splitAt = firstBlockAfterTier < 0 ? rows.length : firstBlockAfterTier;
    const head = rows.slice(0, splitAt);
    const tail = rows.slice(splitAt);
    return [
      h('div', {
        key: 'tier-line',
        className: 'pet-bub-row',
        children: head.map((r, i) =>
          r.role === 'tier'
            ? h('span', { key: i, className: 'pet-bub-tier pet-bub-tier-' + r.tier, children: r.text })
            : h('span', { key: i, children: r.text }),
        ),
      }),
      ...tail.map((r, i) => block(r, i)),
    ];
  }
  // 其余：每行一个块（label 主行 / sub 次要行 / error 错误行）
  return rows.map((r, i) => block(r, i));
}

/**
 * 制造余额气泡（工厂）。
 * 工厂内注入样式一次（与 pet.ts 的 injectCss 同模式）；组件为哑组件，props = { state, on }。
 * 内容来自 src/shared 的 balanceBubbleView（与桌面模式完全一致）。
 */
export function makeBalanceBubble(rt: { h: typeof jsx }): (props: { state: BalanceState; on: boolean }) => ReactNode {
  const { h } = rt;
  injectBubbleCss();

  return function BalanceBubble({ state, on }: { state: BalanceState; on: boolean }) {
    const rows = balanceBubbleView(state);
    // 不可用状态（不支持/缺凭证/抓取失败）是**多行文字说明**：套用碎碎念的换行变体
    // （字号缩到 0.75、宽度下限更窄，多行说明更紧凑；折行现在已是气泡的通用行为）
    const wrap = state.ok ? '' : ' dsh-whale-girl-whisper';
    return h('div', {
      className: 'dsh-whale-girl-bubble' + wrap + (on ? ' is-on' : ''),
      children: rowsToNodes(h, rows),
    });
  };
}

/**
 * 制造碎碎念气泡（工厂）。
 * 与余额气泡共用同一套样式（dsh-whale-girl-bubble）与行渲染（rowsToNodes）；
 * 内容来自 src/shared 的 whisperBubbleView（与桌面模式完全一致）。
 * image：配图名称（配置 memes 的键），有值则在文字上方渲染该表情包；
 *        图片样式取自 shared 的 MEME_BUBBLE_CSS（两端同一份，这里只声明式建节点）。
 * assetRoot：素材根（= 该宠物的条目 key），决定图片去哪个表情包目录链取
 *        （种类独占 pet/<名>-memes/ → 用户目录 → 包内），与动画素材同一套归属语义。
 */
export function makeWhisperBubble(rt: {
  h: typeof jsx;
}): (props: { text: string; image?: string; assetRoot?: string; on: boolean }) => ReactNode {
  const { h } = rt;
  injectBubbleCss();
  injectMemeBubbleCss();

  return function WhisperBubble({
    text,
    image,
    assetRoot,
    on,
  }: {
    text: string;
    image?: string;
    assetRoot?: string;
    on: boolean;
  }) {
    const rows = whisperBubbleView({ ok: true, text, ts: 0 });
    const key = String(image ?? '').trim();
    return h('div', {
      className: 'dsh-whale-girl-bubble dsh-whale-girl-whisper' + (key ? ' ' + MEME_BUBBLE_CLASS : '') + (on ? ' is-on' : ''),
      children: key
        ? [
            h('img', {
              key: 'img',
              className: MEME_IMG_CLASS,
              // 浏览器端基址就是本页 origin 下的路由前缀（与上面 @font-face 同一个字面量）
              src: memeImageUrl(key, '/dsh-whale-girl', assetRoot),
              alt: key,
            }),
            rowsToNodes(h, rows),
          ]
        : rowsToNodes(h, rows),
    });
  };
}
