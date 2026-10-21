// client 半侧「装配层」：注入 react → 组装两个页面组件 → 注册进 DSH 插槽。
// 页面代码不在本文件：宠物页面在 pet.ts，设置页在 settings.ts——
// 类似 Vue 的 App.vue 只挂根组件、SpringBoot 启动类只做装配，不写页面业务。
import { makePetUI } from './pet';
import { makeWorkspaceIcon, makeWorkspacePanel } from './workspace';
import { makeVoiceButton } from './voice-client';
import { makePlayStatus } from './play-status';
import { makePetConfigSection, NS, zh, en, petBridge } from './settings';
import { initNotify } from './notify';
import { installCommandFaces, type CommandFace, type CommandUiLike } from './command-faces';
import { installSectionNavIcon } from './nav-icon';
import type * as ReactNS from 'react';
import type * as PrimitivesNS from '@deepseek-ai/dsh-client-ui-primitives';

/**
 * 返回 DSH 插件 factory：`(require) => module`。
 * 插件三件套（name / inject / apply）都在其返回的 module 上。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- DSH __ModuleLoader__ 契约（f(require) => module），外部无静态类型
export function makeFactory(): (require: (mod: string) => any) => any {
  return (require) => {
    const module = { exports: {} };

    const react: typeof ReactNS = require('react');
    const { useEffect, useRef, useState, useCallback } = react;
    const { jsx: h } = require('react/jsx-runtime');

    // 平台种子模块（DSH web 前端壳提供，与 react / cordis 并列）：取不到就退化成
    // 「命令没图标」，绝不让整个插件加载失败。
    let primitives: typeof PrimitivesNS | undefined;
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives');
    } catch (error) {
      console.warn('[dsh-whale-girl] 图标模块不可用：' + (error instanceof Error ? error.message : String(error)));
    }

    // react-dom 同样是平台种子模块（见 dsh-web-frontend 打包产物里的 staticModules 表）。
    // 这里只用它把图标组件**同步**渲成 SVG 源码，供设置页导航的 CSS mask 用；
    // 取不到就退化成「那一行仍是齿轮」，绝不让整个插件加载失败。
    let renderIconSvg: ((icon: ReactNS.ComponentType<PrimitivesNS.IconProps>) => string) | undefined;
    try {
      const { createRoot } = require('react-dom/client');
      const { flushSync } = require('react-dom');
      renderIconSvg = (icon) => {
        const holder = document.createElement('div');
        const root = createRoot(holder);
        try {
          // flushSync：React 18 的 root.render 是异步调度，不同步刷一次就拿不到 DOM
          flushSync(() => root.render(h(icon, { size: 16 })));
          return holder.innerHTML;
        } finally {
          root.unmount();
        }
      };
    } catch (error) {
      console.warn(
        '[dsh-whale-girl] 图标渲染器不可用（react-dom 缺失）：' + (error instanceof Error ? error.message : String(error)),
      );
    }

    // 宠物页面（overlay）与配置设置页：组件各自独立文件，这里只组装 + 注册
    const PetMulti = makePetUI({ h, useState, useEffect, useRef });

    const name = 'dsh-whale-girl';
    // commandUi 写成服务依赖（与官方 client-ui-permission-presets 的写法一致）：
    // 让 cordis 等「/」命令入口服务就绪后才 apply 本插件，保证 /pet 装饰必然注册成功。
    const inject = ['slots', 'locale', 'connection', 'remote', 'remote.commands', 'commandUi'];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- DSH 注入的 ctx（locale/slots/webServer 等 service 无静态类型）
    function apply(ctx: any) {
      // 本地化字典（设置页文案）
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-whale-girl: dictionaries');
      const t = ctx.locale.bind(NS);

      // 系统通知：host 侧监听 DSH 宿主事件生成通知帧，写进 /state 的 sections.notify；
      // 容器的统一轮询发现 counter 变化后调 notifyFromFrame 弹 toast（本引擎不再自己轮询）。
      // 不再依赖浏览器 connection 事件流（DSH 0.1.5 删除了 api.events.mux/host）。
      ctx.effect(() => initNotify(), 'dsh-whale-girl: notifications');

      // /pet 选择框：裸输 /pet 回车或菜单点选时弹出桌宠列表，选中后提交 /pet <id> 由 host 命令落地。
      // commandUi 已声明为服务依赖（上方 inject）：插件只在「/」命令服务就绪后 apply，
      // 装饰注册有保障；仍保留缺失时的降级提示，防止异常装配下静默失效。
      ctx.effect(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- DSH 注入服务无静态类型
        const commandUi = (ctx as any).get?.('commandUi');
        if (!commandUi || typeof commandUi.decorate !== 'function') {
          console.warn('[dsh-whale-girl] 命令选择框不可用：commandUi 服务缺失（/pet 仍可手输 id 或名字）');
          return () => {};
        }
        return commandUi.decorate({
          name: 'whale-pet',
          available: () => true,
          ui: {
            kind: 'popupSelect',
            // 选项 = 当前生效宠物列表（petBridge.current：主宠物 + 文件宠物，name 已兜底）
            options: async () =>
              petBridge.current.map((p) => ({
                id: p.id,
                label: p.name || p.id,
                detail: (p.assetRoot && p.assetRoot !== p.id ? p.assetRoot + ' / ' : '') + p.id,
              })),
            // 选中 → 提交 /pet <id>（host handler 校验并设置当前桌宠，命令节点回显名字）
            onSelect: async (option: { id: string }, session: { sessionId: string }) => {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any -- remote 无静态类型
              await (ctx as any).remote?.commands?.execute(session.sessionId, '/pet ' + option.id, []);
            },
          },
        });
      }, 'dsh-whale-girl: /pet picker');

      // /chat /pet /balance 在「/」菜单里的行标题与图标。
      // DSH 没有给宿主命令配图标的官方入口，这里包装 commandUi.candidates 补上 label + icon；
      // 三个命令的宿主侧能力（命令日志 / 手输参数 / input.hint / SDK 可见性）全部不受影响。
      // 依据与降级策略见 command-faces.ts 的模块注释。
      ctx.effect(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- DSH 注入服务无静态类型
        const commandUi = (ctx as any).get?.('commandUi') as CommandUiLike | undefined;
        const icons = primitives;
        if (commandUi === undefined || icons === undefined) {
          console.warn('[dsh-whale-girl] 命令图标不可用（命令本身仍可用，只是没有图标）');
          return () => {};
        }
        return installCommandFaces(
          commandUi,
          new Map<string, CommandFace>([
            // 对话气泡：94 个内置图标里唯一的纯对话气泡
            ['whale-chat', { label: () => t('cmd.chat'), icon: icons.IconQueueOutlineRegular }],
            // 双人形：多只桌宠里挑一只
            ['whale-pet', { label: () => t('cmd.pet'), icon: icons.IconUsersOutlineRegular }],
            // 仪表盘：额度 / 用量
            ['whale-balance', { label: () => t('cmd.balance'), icon: icons.IconGaugeOutlineRegular }],
          ]),
        );
      }, 'dsh-whale-girl: command faces');

      // 设置面板导航里「桌宠配置」那一行的图标：DSH 的 navIcon 是按分区 id 硬编码的
      // 白名单 + 兜底齿轮，slot 契约里也没有图标位 —— 只能在 DOM 层补。
      // 依据与降级策略见 nav-icon.ts 的模块注释。
      ctx.effect(() => {
        const renderIcon = renderIconSvg;
        const icon = primitives?.IconSlidersTwoOutlineMedium;
        if (renderIcon === undefined || icon === undefined) {
          console.warn('[dsh-whale-girl] 设置页导航图标不可用（那一行仍是齿轮）');
          return () => {};
        }
        return installSectionNavIcon({ label: () => t('nav'), renderSvg: () => renderIcon(icon) });
      }, 'dsh-whale-girl: settings nav icon');

      // 宠物 overlay（多开：容器渲染多个 PetCard）
      // 插槽 id 必须与 dsh-pet 区分：dsh-pet 用 `pet`，同 id 会互相覆盖。
      ctx.slots.inject('shell.overlay', function* () {
        yield ctx.slots.register({ name: 'shell.overlay', id: 'whale-girl', order: 1000 }, () => h(PetMulti, {}));
      });

      // 语音按钮：独立 overlay 条目（own id），不挤进宠物容器——
      // 宠物容器按 display 过滤、会被多开逻辑接管；语音是全局能力，不该随宠物显示开关消失。
      const VoiceButton = makeVoiceButton({ h, useState, useRef, useCallback, useEffect });
      ctx.slots.inject('shell.overlay', function* () {
        yield ctx.slots.register({ name: 'shell.overlay', id: 'whale-girl-voice', order: 1001 }, () =>
          h(VoiceButton, { label: (key: string) => t(key) }),
        );
      });

      // 陪玩状态浮标：她自己玩游戏时右下角显示「思考中…」+ 停止按钮。
      // 与语音按钮同款式（同色板、同位置逻辑），独立 overlay 条目：不跑步就不渲染任何东西。
      const PlayStatus = makePlayStatus({ h, useState, useCallback, useEffect });
      ctx.slots.inject('shell.overlay', function* () {
        yield ctx.slots.register({ name: 'shell.overlay', id: 'whale-girl-play', order: 1002 }, () =>
          h(PlayStatus, {}),
        );
      });

      // 设置页：「桌宠配置」（大小/位置/模型，保存即时生效）。
      // 设置页 id 同样必须区分：dsh-pet 用 `pet-config`。
      // useRef 用于「AI 模型」单下拉选择器（浮层定位与外部点击判定），与宠物页面同一份注入。
      const PetConfigSection = makePetConfigSection({ h, useState, useEffect, useRef, useCallback, t });
      // ── 左侧栏专属工作区 ──
      //
      // 同一个 id（whale-girl）注册两处：`sidebar.panellist` 出图标，
      // `main` 出面板。DSH 文档原话「Each list id addresses the matching main panel」，
      // 且 posterflow-ai 已经用同样的模式跑着——不是我们猜的。
      const WorkspaceIcon = makeWorkspaceIcon({ h, useState, useEffect, useCallback, t });
      const WorkspacePanel = makeWorkspacePanel({ h, useState, useEffect, useCallback, t });
      ctx.slots.inject('sidebar.panellist', function* () {
        yield ctx.slots.register(
          { name: 'sidebar.panellist', id: 'whale-girl', order: 200, label: () => t('wsTitle') },
          WorkspaceIcon,
        );
      });
      ctx.slots.inject('main', function* () {
        yield ctx.slots.register({ name: 'main', key: 'whale-girl' }, WorkspacePanel);
      });
      ctx.slots.inject('settings.section', function* () {
        yield ctx.slots.register(
          { name: 'settings.section', id: 'whale-girl-config', order: 30, label: () => t('nav'), inject: () => ({ t }) },
          PetConfigSection,
        );
      });
    }

    module.exports = { apply, inject, name };
    return module.exports;
  };
}
