# NOTICE —— 上游与素材归属

本插件 **dsh-whale-girl** 派生自 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet)，
在其基础上扩展了「实时语音对话 / 看屏幕 / 陪玩与代打」三项能力。

MIT 许可允许使用、复制、修改、合并、发布、再许可，唯一要求是**保留版权声明与许可声明**。
本文件与 `LICENSE` 共同承担这一义务。

---

## 一、代码来源

| 项 | 内容 |
|---|---|
| 上游项目 | dsh-pet |
| 上游仓库 | <https://github.com/PC2005-cloud/dsh-pet> |
| 上游版本 | 0.3.7 |
| 上游许可 | MIT License, Copyright (c) 2026 PC2005-cloud |
| 本插件许可 | MIT（见 `LICENSE`） |

**改动范围**（相对上游）：

- 包名 `dsh-pet` → `dsh-whale-girl`
- 路由前缀 `/dsh-pet-7340` → `/dsh-whale-girl`
- 用户数据目录 `$DSH_HOME/dsh-pet/` → `$DSH_HOME/dsh-whale-girl/`
- 桌面助手桥接协议 `dsh-pet-bridge://` → `dsh-whale-girl-bridge://`
- 宿主入口 `name = 'pet'` → `name = 'dsh-whale-girl'`
- 新增：语音对话、屏幕感知、游戏陪玩/代打（进行中，见 `docs/ROADMAP.md`）

---

## 二、美术素材

`assets/webm/`（106 个 VP9-alpha 透明动画，51.8 MB）、`assets/memes/`、
`assets/pic/`、`assets/fonts/` 均来自上游 dsh-pet 仓库，随 MIT 许可一并沿用。

上游 README 说明这些素材由**豆包**生成，并经其素材链（AI 提示词 → 绿幕视频 → 透明动画）产出。
素材的具体许可边界以**上游仓库的声明为准**；本插件自用、不商用。

> 若要替换为自有形象素材，只需替换 `assets/webm/` 下的 `.webm` 文件并同步
> `assets/config.jsonc` 的动画名清单，代码无需改动（见 `docs/ASSETS.md`）。

---

## 三、依赖

| 依赖 | 许可 | 用途 |
|---|---|---|
| `@electron/get` | MIT | 按需下载 Electron 运行时（桌面模式） |
| `@electron-internal/extract-zip` | MIT | 解压 Electron 包 |

DSH 宿主提供的 `@deepseek-ai/*` 包为 peerDependency，不随本包分发。

---

## 四、上游 README 中的许可说明（原文引用）

> ## 📄 许可
>
> 见仓库 `LICENSE`（MIT）。
