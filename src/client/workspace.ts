/**
 * 鲸鱼娘专属工作区（DSH 左侧栏面板）。
 *
 * ── 它是怎么挂上去的 ──
 *
 * DSH 的左侧栏是 `sidebar.panellist` 槽（全局面板图标列表），
 * 而 `main` 槽是**按 list id 寻址的主面板**——文档原话：
 *
 *   > Each list id addresses the matching main panel.
 *
 * 所以我们用同一个 id（`whale-girl`）注册两处：图标 + 面板。
 * 这不是猜测：另一个第三方插件（posterflow-ai）已经在用同样的模式。
 *
 * ── 为什么要有它 ──
 *
 * 主人要的是「鲸鱼娘在 DSH 上的会话任务都在那块」。
 * 现在这一版先做**她自己的状态面板**：本局进度、开关、急停、最近动作。
 * 后续接上「复杂任务建 DSH 会话」后，会话列表也放这里。
 */

/** 工作区需要的运行时能力（由 app.ts 注入） */
export type WorkspaceRuntime = {
  h: typeof import('react').createElement;
  useState: typeof import('react').useState;
  useEffect: typeof import('react').useEffect;
  useCallback: typeof import('react').useCallback;
  t: (key: string) => string;
};

/** 服务端口径与 host 路由一致 */
const PREFIX = '/dsh-whale-girl';

type SessionInfo = { gameTitle?: string; steps?: number; cap?: number } | null;

/**
 * 左侧栏图标。
 *
 * 契约（SidebarPanelIconOwnerProps）：`{ size, active }`。
 * 只画一个圆头鲸鱼轮廓——用内联 SVG，不引外部资源
 * （面板图标不该依赖网络或打包资源）。
 */
export function makeWorkspaceIcon(rt: WorkspaceRuntime) {
  const { h } = rt;
  return function WorkspaceIcon(props: { size: number; active: boolean }): ReturnType<typeof h> {
    const size = typeof props.size === 'number' && props.size > 0 ? props.size : 20;
    return h(
      'svg',
      {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        'aria-hidden': true,
        style: { display: 'block', opacity: props.active === true ? 1 : 0.75 },
      },
      h('path', {
        // 鲸鱼轮廓：圆身 + 尾巴 + 喷水
        d: 'M4 14c0-3.3 2.7-6 6-6h2c3.9 0 7 3.1 7 7 0 .6-.5 1-1 1H5c-.6 0-1-.4-1-1z',
        fill: 'currentColor',
        opacity: 0.9,
      }),
      h('path', { d: 'M19 15c1.5-.5 2.5-1.5 3-3-.2 2-1 3.5-2.4 4.5', fill: 'currentColor', opacity: 0.7 }),
      h('circle', { cx: 8, cy: 12, r: 0.9, fill: 'white' }),
      h('path', { d: 'M9 6c0-1.5.8-2.7 2-3.5-.3 1.2-.2 2.2.3 3', stroke: 'currentColor', 'stroke-width': 1.4, 'stroke-linecap': 'round' }),
    );
  };
}

/**
 * 工作区面板。
 *
 * 刻意做得**只读 + 两个动作**（结束本局 / 跑一轮）：
 * 详细设置在设置页，这里只回答「她现在在干什么」。
 */
export function makeWorkspacePanel(rt: WorkspaceRuntime) {
  const { h, useState, useEffect, useCallback, t } = rt;
  return function WorkspacePanel(): ReturnType<typeof h> {
    const [session, setSession] = useState<SessionInfo>(null);
    const [sightOn, setSightOn] = useState(false);
    const [autoOn, setAutoOn] = useState(false);
    const [estop, setEstop] = useState<string>('unknown');
    const [msg, setMsg] = useState('');

    const refresh = useCallback(async (): Promise<void> => {
      try {
        const s = await fetch(`${PREFIX}/autoplay/session`);
        if (s.ok) {
          const d = (await s.json()) as { session?: SessionInfo };
          setSession(d.session ?? null);
        }
        const c = await fetch(`${PREFIX}/autoplay/config`);
        if (c.ok) {
          const d = (await c.json()) as { config?: { enabled?: boolean }; estop?: { state?: string } };
          setAutoOn(d.config?.enabled === true);
          setEstop(d.estop?.state ?? 'unknown');
        }
        const g = await fetch(`${PREFIX}/sight/config`);
        if (g.ok) {
          const d = (await g.json()) as { config?: { enabled?: boolean } };
          setSightOn(d.config?.enabled === true);
        }
      } catch {
        /* 读不到就保持上次的值，不报错打扰 */
      }
    }, []);

    useEffect(() => {
      void refresh();
      // 3 秒一刷：这是"看她在干什么"的面板，不需要更实时
      const timer = setInterval(() => void refresh(), 3000);
      return () => clearInterval(timer);
    }, [refresh]);

    const endSession = async (): Promise<void> => {
      try {
        const res = await fetch(`${PREFIX}/autoplay/end`, { method: 'POST' });
        const d = (await res.json()) as { ended?: { summary?: string } | null };
        setMsg(d.ended?.summary ?? t('wsNothing'));
        await refresh();
      } catch {
        setMsg(t('wsFailed'));
      }
    };

    const runOne = async (): Promise<void> => {
      setMsg(t('wsRunning'));
      try {
        const res = await fetch(`${PREFIX}/autoplay/run`, { method: 'POST' });
        const d = (await res.json()) as { kind?: string; thought?: string; reason?: string; message?: string };
        setMsg(
          d.kind === 'planned'
            ? `${t('wsPlanned')}：${d.thought ?? ''}`
            : d.kind === 'skipped'
              ? `${t('wsSkipped')}：${d.reason ?? ''}`
              : `${t('wsFailed')}：${d.message ?? d.reason ?? ''}`,
        );
        await refresh();
      } catch {
        setMsg(t('wsFailed'));
      }
    };

    const dot = (on: boolean, label: string): ReturnType<typeof h> =>
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px' } }, [
        h('span', {
          key: 'd',
          style: {
            width: '8px',
            height: '8px',
            borderRadius: '50%',
            background: on ? 'var(--dsw-alias-state-success-primary, #2e9e4f)' : 'var(--dsw-alias-label-secondary)',
          },
        }),
        h('span', { key: 'l', children: `${label}${on ? t('wsOn') : t('wsOff')}` }),
      ]);

    return h('div', { style: { padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: '12px' } }, [
      h('h2', { key: 'title', style: { margin: 0, fontSize: '17px' }, children: t('wsTitle') }),
      h('p', { key: 'hint', style: { margin: 0, fontSize: '12px', opacity: 0.7 }, children: t('wsHint') }),

      // 本局
      h('div', { key: 'session', style: { fontSize: '13px' } }, [
        h('div', { key: 'a', children: session === null ? t('wsNoSession') : `${session.gameTitle ?? ''}` }),
        session === null
          ? null
          : h('div', { key: 'b', style: { opacity: 0.7 }, children: `${session.steps ?? 0} / ${session.cap ?? 0} ${t('wsSteps')}` }),
      ]),

      dot(sightOn, t('wsSight')),
      dot(autoOn, t('wsAutoplay')),
      h('div', { key: 'estop', style: { fontSize: '12px', opacity: 0.8 } }, [
        `${t('wsEstop')}：${estop === 'ready' ? t('wsReady') : t('wsStopped')}`,
      ]),

      h('div', { key: 'actions', style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '4px' } }, [
        h('button', { key: 'r', type: 'button', onClick: () => void runOne(), children: t('wsRun') }),
        h('button', { key: 'e', type: 'button', onClick: () => void endSession(), children: t('wsEnd') }),
      ]),
      msg === '' ? null : h('div', { key: 'msg', style: { fontSize: '12px', opacity: 0.85 }, children: msg }),
    ]);
  };
}
