/**
 * 陪玩状态的浮标（右下角，和语音按钮同款式）。
 *
 * ── 为什么需要 ──
 *
 * 主人点「开始陪玩」之后，界面不能只剩一个按钮文字变化：她会看不到「她在不在想」。
 * 语音对话那块已经验证过这个交互：一个常驻小浮标 + 一句状态，比一行日志有用得多。
 * 所以陪玩也照抄同一款式（同一色板、同样贴在右下角、带一个停止按钮）。
 *
 * ── 数据从哪来 ──
 *
 * `GET /dsh-whale-girl/autoplay/play` 是宿主的循环快照（running / thinking / waiting /
 * stopped / error + 最近一句说明）。这里 700ms 轮询一次：循环状态是**低频**的，
 * 不值得为它再开一条 SSE；而且轮询天然容忍宿主热重载。
 */

import type * as React from 'react';

/** 宿主路由前缀 */
const PREFIX = '/dsh-whale-girl';

/** 宿主 `/autoplay/play` 返回的循环快照（只取前端关心的字段） */
type PlaySnapshot = {
  running?: boolean;
  state?: string;
  rounds?: number;
  lastMessage?: string;
  lastReason?: string;
  lastRoundMs?: number;
  updatedAtMs?: number;
};

const ROOT_STYLE = [
  'position:fixed',
  'right:16px',
  'bottom:150px', // 让开语音按钮（bottom:96px + 44px 高）
  'z-index:2147483000',
  'display:flex',
  'align-items:center',
  'gap:8px',
  'pointer-events:auto',
  'user-select:none',
].join(';');

const DOT_STYLE = [
  'width:8px',
  'height:8px',
  'border-radius:50%',
  'background:#7aa2ff',
  'box-shadow:0 0 8px rgba(122,162,255,.8)',
].join(';');

const DOT_IDLE_STYLE = DOT_STYLE + ';background:#8892a6;box-shadow:none';

const LABEL_STYLE = [
  'font-size:12px',
  'color:#cfe0ff',
  'background:rgba(20,28,48,.82)',
  'border:1px solid rgba(255,255,255,.22)',
  'padding:4px 10px',
  'border-radius:8px',
  'white-space:nowrap',
  'max-width:360px',
  'overflow:hidden',
  'text-overflow:ellipsis',
  'box-shadow:0 4px 16px rgba(0,0,0,.35)',
].join(';');

const STOP_STYLE = [
  'font-size:12px',
  'color:#fff',
  'background:rgba(214,86,86,.85)',
  'border:1px solid rgba(255,255,255,.22)',
  'padding:4px 10px',
  'border-radius:8px',
  'cursor:pointer',
].join(';');

/** 把 CSS 字符串转成 React 的 style 对象（React 不接受字符串） */
function parseStyle(css: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of css.split(';')) {
    const index = part.indexOf(':');
    if (index <= 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key === '' || value === '') continue;
    out[key.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())] = value;
  }
  return out;
}

const styles = {
  root: parseStyle(ROOT_STYLE),
  dot: parseStyle(DOT_STYLE),
  dotIdle: parseStyle(DOT_IDLE_STYLE),
  label: parseStyle(LABEL_STYLE),
  stop: parseStyle(STOP_STYLE),
};

/** 最近一次状态停止后，浮标还显示多久（毫秒）：够主人看到「为什么停了」 */
const LINGER_MS = 12_000;

/** 状态快照 → 一句话 */
function describe(snap: PlaySnapshot): string {
  const rounds = typeof snap.rounds === 'number' && snap.rounds > 0 ? `（第 ${snap.rounds} 轮）` : '';
  // 一轮的耗时放在状态里：太慢时主人一眼能看出是模型在拖（而不是「她又卡住了」）
  const spent = typeof snap.lastRoundMs === 'number' ? ` · ${(snap.lastRoundMs / 1000).toFixed(1)}s` : '';
  switch (snap.state) {
    case 'thinking':
      return '代打 · 思考中…' + rounds;
    case 'waiting':
      return '代打 · ' + (snap.lastMessage ?? '等待中') + rounds + spent;
    case 'stopped':
    case 'error':
      return snap.lastMessage ?? '代打已停';
    default:
      return '代打 · ' + (snap.lastMessage ?? '');
  }
}

/**
 * 造陪玩状态浮标组件。
 *
 * @param rt 宿主提供的 React 运行时（h / hooks），与 pet.ts 同一套注入方式
 */
export function makePlayStatus(rt: {
  h: typeof React.createElement;
  useState: typeof React.useState;
  useCallback: typeof React.useCallback;
  useEffect: typeof React.useEffect;
}) {
  const { h, useState, useCallback, useEffect } = rt;

  return function PlayStatus(): React.ReactElement | null {
    const [snap, setSnap] = useState<PlaySnapshot | null>(null);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
      let alive = true;
      const tick = async (): Promise<void> => {
        try {
          const res = await fetch(`${PREFIX}/autoplay/play`, { cache: 'no-store' });
          if (!res.ok) return;
          const data = (await res.json()) as { play?: PlaySnapshot };
          if (alive) setSnap(data.play ?? null);
        } catch {
          /* 宿主热重载期间会短暂失败：忽略，下一拍重试 */
        }
      };
      void tick();
      // 700ms：循环状态变化是低频的，再快也只是白轮询
      const timer = setInterval(() => void tick(), 700);
      return () => {
        alive = false;
        clearInterval(timer);
      };
    }, []);

    const stop = useCallback(async (): Promise<void> => {
      setBusy(true);
      try {
        await fetch(`${PREFIX}/autoplay/play/stop`, { method: 'POST' });
      } catch {
        /* 停止失败：下一拍轮询会显示真实状态 */
      } finally {
        setBusy(false);
      }
    }, []);

    if (snap === null) return null;
    const running = snap.running === true;
    // 没在跑时只保留一小会儿（让主人看到停止原因），之后整块隐藏
    const recent = typeof snap.updatedAtMs === 'number' && Date.now() - snap.updatedAtMs < LINGER_MS;
    if (!running && !recent) return null;
    // idle 且从未跑过：不留空壳
    if (!running && snap.state === 'idle') return null;

    const text = describe(snap);
    return h('div', {
      style: styles.root,
      children: [
        h('span', { key: 'dot', style: running ? styles.dot : styles.dotIdle }),
        h('span', { key: 'label', style: styles.label, title: text, children: text }),
        running
          ? h('button', {
              key: 'stop',
              type: 'button',
              style: styles.stop,
              disabled: busy,
              onClick: (event: { preventDefault(): void }) => {
                event.preventDefault();
                void stop();
              },
              children: '停止',
            })
          : null,
      ],
    });
  };
}
