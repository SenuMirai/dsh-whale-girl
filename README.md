# dsh-whale-girl 🐋

住在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 里的鲸鱼娘 AI 伙伴：会说话、会看屏幕、也会陪你玩。

An AI whale-girl companion that lives inside [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): she talks, watches your screen, and plays games with you.

> **来源 / Origin**
>
> 本项目是在 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet)（MIT，© 2026 PC2005-cloud，上游版本 0.3.7）的基础上修改、扩展而来的。
> 我们保留并扩展了它的桌宠渲染、对话、记忆、桌面窗口和设置系统，新增了实时语音、识屏搭话、游戏陪玩/代打，并把包名、路由、数据目录与桌面助手协议全部改成 `dsh-whale-girl`，以便与上游同时安装。
>
> This project is a fork and extension of [dsh-pet](https://github.com/PC2005-cloud/dsh-pet) (MIT, © 2026 PC2005-cloud, upstream 0.3.7). We keep and extend its rendering, chat, memory, desktop window and settings systems; add real-time voice, screen awareness and game companion/autoplay; and rename the package, routes, data directory and desktop-helper protocol to `dsh-whale-girl` so it can coexist with upstream.
>
> 上游代码与美术素材的 MIT 许可见 [NOTICE.md](./NOTICE.md) 与 [LICENSE](./LICENSE)。
> See [NOTICE.md](./NOTICE.md) and [LICENSE](./LICENSE) for upstream code/asset attribution.

---

## 中文

### 这是什么

她不是一张会动的贴纸，而是一个**有记忆、有声音、能看见你屏幕、能陪你在游戏里说话**的桌面伙伴。她把大模型能力做成一个住在 DSH 里的透明小窗口，你可以拖她、点她、跟她说话，也可以让她安静待在角落。

### 功能与特点

| 能力 | 说明 |
|---|---|
| **透明桌宠** | 106 段 VP9-alpha 透明动画；待机、点击、拖拽、移动、碎碎念、余额气泡等状态 |
| **文字对话** | 走 DSH 当前模型；人设、记忆落盘、上下文压缩；支持气泡与右键对话 |
| **实时语音** | 本地 SenseVoice ASR + edge-tts 语音合成；按住说话，无需显卡；支持全局热键 |
| **屏幕感知** | 截图仅在内存中处理，交给 DSH 视觉模型，再以气泡搭话；默认关闭，可核对快照 |
| **游戏陪玩** | 识屏的「陪玩模式」：看战况、点评、提醒开团 |
| **游戏代打** | 键鼠注入 + 决策循环 + 三层急停；默认空跑，需显式开启 |
| **桌面窗口** | 透明置顶的 Electron 助手窗口，可与浏览器 overlay 并存 |
| **DSH 原生命令** | `/whale-pet`、`/whale-chat`、`/whale-balance`，不会和 dsh-pet 的命令撞名 |
| **设置页** | 形象、动画、语音、识屏、游戏、模型、快捷键等集中配置 |
| **独立数据** | 数据在 `$DSH_HOME/dsh-whale-girl/`，不碰 dsh-pet，也不碰 QQ 群聊插件 |

### 环境要求

- **DeepSeek Harness** 桌面版（推荐最新版）
- **Node.js 20+**、**pnpm 9+**
- Windows 10/11（桌面窗口、全局热键、键鼠注入以 Windows 为主）
- 语音识别需要本机可用的 SenseVoice 运行时；不装也能用文字对话
- 识屏与看图需要所选 DSH 模型支持图片输入

### 安装

```bash
git clone https://github.com/SenuMirai/dsh-whale-girl.git
cd dsh-whale-girl
pnpm install
pnpm run bundle
```

然后在 DSH 的 profile 中把本目录 link 进去（或使用 `dsh plugin --profile desktop add <绝对路径>`）：

```jsonc
// <DSH_HOME>/profiles/desktop/package.json
{
  "dependencies": {
    "dsh-whale-girl": "link:/absolute/path/to/dsh-whale-girl"
  },
  "dsh": {
    "profile": {
      "bundles": [
        // ... 其它插件
        "dsh-whale-girl"
      ]
    }
  }
}
```

**重启 DSH**。`dsh.profile.bundles` 只在启动时读取，热重载不会捡起新插件。

### 使用

1. 启动 DSH 后，右下角出现鲸鱼娘；拖动可换位置，单击/双击触发互动，右键打开菜单。
2. 打开「设置 → 鲸鱼娘」配置人设、模型、语音、识屏与游戏选项。
3. 语音：在设置里选择麦克风与热键，按住热键说话；首次使用会检查 ASR 运行时。
4. 识屏/陪玩：开启后她会按间隔截图并请求视觉模型；截图只在内存中，可保存快照核对。
5. 代打：默认 dry-run（只决策、不注入键鼠）。确认游戏窗口、键位与急停键后再开启真实注入。

### 配置与数据

| 路径 | 内容 |
|---|---|
| `$DSH_HOME/dsh-whale-girl/main-config.jsonc` | 用户配置（只写覆盖项） |
| `$DSH_HOME/dsh-whale-girl/memory.json` | 对话记忆 |
| `$DSH_HOME/dsh-whale-girl/main-animation/` | 自定义动画 |
| `$DSH_HOME/dsh-whale-girl/memes/` | 自定义表情包 |
| `$DSH_HOME/dsh-whale-girl/pet/` | 额外 pet pack |

仓库**不包含**任何用户记忆、聊天记录、截图、账号或令牌；上述文件只存在于本机。

### 与 dsh-pet 的隔离

| 项 | dsh-whale-girl | dsh-pet |
|---|---|---|
| 包名 / entry id | `dsh-whale-girl` | `dsh-pet` |
| 路由前缀 | `/dsh-whale-girl/*` | `/dsh-pet-7340/*` |
| 数据目录 | `$DSH_HOME/dsh-whale-girl/` | `$DSH_HOME/dsh-pet/` |
| 斜杠命令 | `/whale-*` | `/balance` `/pet` `/chat` |
| 桌面协议 | `dsh-whale-girl-bridge://` | `dsh-pet-bridge://` |

两者可以同时安装，不会共享人设、记忆或配置。

### 开发

```bash
pnpm run bundle      # 构建 lib/
pnpm test            # 单元测试
pnpm run typecheck   # 类型检查
```

### 已知边界

- 语音识别与游戏注入依赖本机环境，Linux/macOS 未完整验证；
- 识屏/看图受模型能力限制；模型不支持图片时会退回文字；
- 代打涉及键鼠注入，请只在单机/允许的场景使用，并保留急停；
- 上游美术素材的授权边界以 `NOTICE.md` 为准。

### 致谢

- [dsh-pet](https://github.com/PC2005-cloud/dsh-pet)：上游桌宠框架、渲染、记忆、桌面窗口与素材链；
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)：插件宿主、模型、附件、设置与命令系统；
- edge-tts / SenseVoice / Electron 等开源依赖；
- 上游素材由豆包生成，详见 [NOTICE.md](./NOTICE.md)。

### 许可

MIT。上游部分 © 2026 PC2005-cloud；本仓库修改部分 © 2026 SenuMirai。见 [LICENSE](./LICENSE)。

---

## English

### What it is

Not an animated sticker, but a **desktop companion with memory, a voice, screen awareness and game-side commentary**. It turns a large language model into a transparent little window living inside DSH: drag her, poke her, talk to her, or let her sit quietly in a corner.

### Features

| Feature | Details |
|---|---|
| **Transparent desktop pet** | 106 VP9-alpha animations: idle, click, drag, move, mutter, balance bubble |
| **Text chat** | Uses the current DSH model; persona, persisted memory, context compression, bubbles and right-click chat |
| **Real-time voice** | Local SenseVoice ASR + edge-tts; push-to-talk, no GPU required, global hotkey |
| **Screen awareness** | Screenshots are processed in memory, sent to a DSH vision model, then commented on in a bubble; off by default, snapshots available for review |
| **Game companion** | A "watch and comment" mode: reads the match, comments, calls out engages |
| **Game autoplay** | Keyboard/mouse injection + decision loop + three-layer emergency stop; dry-run by default, explicit opt-in |
| **Desktop window** | Transparent always-on-top Electron helper window; can coexist with the browser overlay |
| **Native DSH commands** | `/whale-pet`, `/whale-chat`, `/whale-balance`; no collision with dsh-pet |
| **Settings UI** | Appearance, animations, voice, screen, games, model, hotkeys |
| **Isolated data** | `$DSH_HOME/dsh-whale-girl/`; does not touch dsh-pet or the QQ group plugin |

### Requirements

- **DeepSeek Harness** desktop (latest recommended)
- **Node.js 20+**, **pnpm 9+**
- Windows 10/11 (desktop window, global hotkey and input injection are Windows-first)
- A working local SenseVoice runtime for speech recognition; text chat works without it
- A DSH model with image input for screen/vision features

### Install

```bash
git clone https://github.com/SenuMirai/dsh-whale-girl.git
cd dsh-whale-girl
pnpm install
pnpm run bundle
```

Link it into your DSH profile (or run `dsh plugin --profile desktop add <absolute-path>`):

```jsonc
// <DSH_HOME>/profiles/desktop/package.json
{
  "dependencies": {
    "dsh-whale-girl": "link:/absolute/path/to/dsh-whale-girl"
  },
  "dsh": {
    "profile": {
      "bundles": [
        // ... other plugins
        "dsh-whale-girl"
      ]
    }
  }
}
```

**Restart DSH.** `dsh.profile.bundles` is read at startup only; hot reload will not pick up a new plugin.

### Usage

1. After DSH starts, the whale girl appears in the bottom-right corner. Drag to move, click/double-click to interact, right-click for the menu.
2. Open **Settings → Whale Girl** to configure persona, model, voice, screen awareness and game options.
3. Voice: choose microphone and hotkey, hold to talk. The ASR runtime is checked on first use.
4. Screen/game companion: when enabled, she captures screenshots at an interval and asks the vision model. Screenshots stay in memory; snapshots are optional.
5. Autoplay: dry-run by default (decisions only, no input). Verify the game window, key bindings and emergency stop before enabling real injection.

### Configuration and data

| Path | Contents |
|---|---|
| `$DSH_HOME/dsh-whale-girl/main-config.jsonc` | User config (overrides only) |
| `$DSH_HOME/dsh-whale-girl/memory.json` | Chat memory |
| `$DSH_HOME/dsh-whale-girl/main-animation/` | Custom animations |
| `$DSH_HOME/dsh-whale-girl/memes/` | Custom memes |
| `$DSH_HOME/dsh-whale-girl/pet/` | Additional pet packs |

The repository contains **no** user memory, chat logs, screenshots, accounts or tokens; those files exist only on your machine.

### Isolation from dsh-pet

| | dsh-whale-girl | dsh-pet |
|---|---|---|
| Package / entry id | `dsh-whale-girl` | `dsh-pet` |
| Route prefix | `/dsh-whale-girl/*` | `/dsh-pet-7340/*` |
| Data dir | `$DSH_HOME/dsh-whale-girl/` | `$DSH_HOME/dsh-pet/` |
| Slash commands | `/whale-*` | `/balance` `/pet` `/chat` |
| Desktop protocol | `dsh-whale-girl-bridge://` | `dsh-pet-bridge://` |

Both can be installed side by side with separate personas, memories and configs.

### Development

```bash
pnpm run bundle      # build lib/
pnpm test            # unit tests
pnpm run typecheck   # type check
```

### Known limits

- Voice recognition and input injection depend on the local environment; Linux/macOS are not fully verified.
- Vision features depend on the selected model; text-only models fall back to text.
- Autoplay injects keyboard/mouse input. Use it only in single-player/allowed scenarios and keep the emergency stop reachable.
- Asset licensing follows the upstream terms in `NOTICE.md`.

### Credits

- [dsh-pet](https://github.com/PC2005-cloud/dsh-pet): upstream desktop-pet framework, rendering, memory, desktop window and asset pipeline.
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): plugin host, models, attachments, settings and commands.
- edge-tts, SenseVoice, Electron and other open-source dependencies.
- Upstream art assets were generated with Doubao; see [NOTICE.md](./NOTICE.md).

### License

MIT. Upstream portions © 2026 PC2005-cloud; modifications © 2026 SenuMirai. See [LICENSE](./LICENSE).
