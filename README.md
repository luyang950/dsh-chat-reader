# dsh-chat-reader

[中文](#中文) · [English](#english)

---

## 中文

在 DeepSeek Harness（DSH）的**会话流里**读本地小说。输入 `/read 书名`，阅读卡就出现在你敲命令的那一轮，正文直接整段显示、从上次读到的段落开始，自己往下滚着读——正文**不进模型上下文、不产生任何 token**。

适配 DSH `>=0.2.1-0 <0.3.0-0`（Web 版与桌面版，已在桌面版 0.2.1-rc.5 运行时上实测）。

### 特性

- **长在会话里**：不是侧栏、悬浮窗或底栏。阅读卡是一个自定义 chat node，位置就是 `/read` 那一轮。
- **零 token**：`/read` 只产生两条只写日志的事件（`command/run` / `command/done`），结果只含书名、格式、段落数等元数据；不伪造 assistant 消息，正文只经由插件自己的 HTTP 接口按需分页拉取。
- **不顶动历史**：卡片高度 = 会话可视高度 − 输入框高度（读取 DSH 会话滚动容器发布的 `--dsh-conversation-viewport-height` / `--dsh-composer-height`），正文在卡片内部滚动；往下滚时按需加载后续段落，上方历史消息一像素不动。
- **定位到顶部**：打开时把上次读到的段落放在卡片顶部；在你亲手滚动之前，即使会话布局还在变化，也会一直对齐在这一段。卡片顶部那一段就是保存的进度。
- **低调外观**：看起来像一条普通的 AI 回复；标题栏和控制条默认隐藏，鼠标移入才浮出，平时只剩一条细进度线。字号默认跟随会话字号。
- **老板键**（默认 `Ctrl + Alt + B`，可在设置里改）：按一次所有阅读卡折叠成一行 `···`，正文**从 DOM 移除**（不是 `visibility:hidden`），再按恢复到原来的段落。状态在刷新后保持，避免刷新瞬间露出正文。
- **格式**：`.txt`（UTF-8 / UTF-8 BOM / UTF-16 LE·BE（有无 BOM 均可）/ GB18030 / GBK / Big5 自动嗅探）、`.md`、`.epub`（EPUB 2/3，按 nav / NCX 分章）。txt 自动识别「第X章 / 第X回 / 卷X / 楔子 / Chapter N …」分章。
- **每本书独立进度**，刷新页面或重启 App 后从上次段落继续。
- **书签、章节目录、书内搜索**。
- **继续阅读入口**：在 New Session 里 `/read` 不会开启模型轮次，DSH 会把这个会话当作空白会话，一切到别的会话就从侧边栏消失。插件会记住每次 `/read` 所在的会话，侧边栏 **More** 菜单顶部会列出最近三个「继续阅读 · 书名」，点一下就回到原来的会话，阅读卡和位置都在。老板键模式下这些菜单项也会隐藏。

### 键盘

所有阅读快捷键都绑在**卡片**上，只有点击卡片使其获焦后才生效；插件唯一的全局监听是老板键组合键，所以输入框里的空格、方向键完全不受影响。

| 按键 | 作用 |
| --- | --- |
| `空格` / `→` / `PageDown` | 下一页（`Shift+空格` 上一页） |
| `←` / `PageUp` | 上一页 |
| `↑` `↓` | 上 / 下滚一行 |
| `Ctrl+F`（mac 也可 `⌘F`） | 书内搜索，`Enter` 下一个，`Shift+Enter` 上一个 |
| `Esc` | 关闭搜索；再按一次合上阅读卡（点击 `··· 已合上` 可继续） |
| 老板键 | 全部阅读卡折叠 / 恢复 |

### 设置

设置 → **阅读**：书库根目录、字号（默认跟随会话）、行距、老板键（点一下后按下新组合键，需含 Ctrl / Alt / Meta 之一，或用 F1–F12）。下方列出书库里的书和各自进度。

### 用法

```
/read 射雕            # 书名关键词（在书库里模糊匹配；同名优先）
/read 武侠/射雕.txt    # 书库内相对路径
/read                 # 留空：继续上一本
```

### 安装

**命令行（Web 版 profile）：**

```bash
dsh plugin --profile web add github:luyang950/dsh-chat-reader
```

安装后重启 `dsh web`。

**桌面版：** 打开左侧 **Plugins** 页，用 GitHub spec 安装 `github:luyang950/dsh-chat-reader`，按提示重启。

本插件是预构建分发：没有 `prepare` / 构建脚本、没有 TypeScript，pnpm 不会要求构建授权。

> 与 `dsh-read` 插件都注册 `/read` 命令，二者不能同时启用。

> 已知限制：DSH 点 New Session 时会优先复用同一工作区里的空白会话，所以可能直接回到某个阅读会话。此时在里面正常提问即可，阅读卡留在上方，会话会变成普通会话并出现在侧边栏。

### 安全

- 所有接口只接受**书库根目录内的相对路径**；绝对路径、`..`、反斜杠、NUL 一律拒绝；解析真实路径后再校验一次，指向书库外的符号链接也会被拒绝。
- 扩展名白名单：`.txt` / `.md` / `.epub`；单文件上限 256 MB（读取前检查）。
- 只读正文，从不写用户的原文件；EPUB 内部链接也不能越出压缩包。
- 插件只写 `$DSH_HOME/dsh-chat-reader/`：`config.json`、`progress.json`、`notes.json`（书签）、`sessions.json`（打开过阅读卡的会话 id，最多 20 个）。

### HTTP 接口

前缀 `/dsh-chat-reader/api/`，统一返回 `{ ok, ... }` 或 `{ ok:false, error }`（400/403/404/405/413/415）。

| 路由 | 方法 | 说明 |
| --- | --- | --- |
| `config` | GET / POST | 读取 / 局部更新配置 |
| `library?q=` | GET | 书库书目 + 进度 |
| `open?book=` | GET | 书的元数据、章节、进度、书签（不含正文） |
| `paragraphs?book=&from=&count=` | GET | 按段落下标分页取正文（count ≤ 200） |
| `search?book=&q=&from=` | GET | 书内搜索（最多 50 条） |
| `progress` | GET / POST `{book,index}` | 进度 |
| `notes` | GET / POST `{book,index}` / `{book,remove}` | 书签 |
| `sessions` | GET / POST `{forget}` | 打开过阅读卡的会话（新到旧，含进度）/ 移除一条 |

### 开发

```bash
npm test        # node --test，零依赖
```

测试覆盖编码嗅探、分段与分章、EPUB 解析、进度读写、路由参数校验与路径约束，以及 client bundle 的 loader 契约（含 `command/run` + `command/done` 折叠成阅读节点）。若本机有 `react` + `react-dom`（`DSH_REACT_DIR` 指向其 `node_modules`），还会额外做一次真实 React 渲染，确认老板键模式下 DOM 里只剩 `···`。

结构：

```
index.mjs                 host 半边（cordis 插件）：/read 命令 + API 路由
lib/book.mjs              路径约束、分段、分章、缓存、搜索
lib/store.mjs             config / progress / notes 持久化
lib/formats/text.mjs      txt 编码嗅探
lib/formats/epub.mjs      零依赖 ZIP + EPUB 解析
lib/client.js             client 半边（ModuleLoader bundle，仅依赖 react）
cordis.patch.yml
```

---

## English

Read local novels **inside the DeepSeek Harness conversation transcript**. Type `/read <title>` and a reader card appears right where you typed it, with the text shown in full starting from where you left off — you scroll at your own pace, and the text **never enters the model context and costs zero tokens**.

Targets DSH `>=0.2.1-0 <0.3.0-0` (Web and Desktop; verified against the Desktop 0.2.1-rc.5 runtime).

### Features

- **Lives in the transcript** — not a sidebar, overlay or dock: a custom chat node anchored to the `/read` turn.
- **Zero tokens** — `/read` only logs the log-only `command/run` / `command/done` pair; the result carries metadata (id, title, format, paragraph count). No fake assistant messages; text is paged over the plugin's own HTTP API.
- **No transcript reflow** — the card's height is the conversation viewport minus the composer (from the scroller's published `--dsh-conversation-viewport-height` / `--dsh-composer-height`). Text scrolls inside the card and loads on demand; history above never moves.
- **Opens at the top of your place** — the saved paragraph sits at the top of the card and stays there, even while the transcript's layout settles, until you scroll yourself. The paragraph at the top is the saved position.
- **Low-key look** — reads like an ordinary reply; header and controls stay hidden until hover, leaving a thin progress line. Font size follows the conversation by default.
- **Boss key** (default `Ctrl + Alt + B`, configurable): collapses every reader to a single `···` line and **removes the text from the DOM** (not `visibility:hidden`); press again to restore at the same paragraph. The state survives reloads.
- **Formats** — `.txt` with encoding sniffing (UTF-8 / BOM / UTF-16 LE·BE with or without BOM / GB18030 / GBK / Big5), `.md`, `.epub` (EPUB 2/3, chapters from nav / NCX). Chapter headings in txt are detected (`第X章`, `Chapter N`, prologue …).
- **Per-book progress**, restored after a reload or an app restart. Bookmarks, table of contents, in-book search.
- **Way back to a reader** — `/read` in a New Session starts no model turn, so DSH treats that Session as blank and drops it from the sidebar once you switch away. The plugin remembers which Sessions hold a reader, and the sidebar's **More** menu lists the newest three as 继续阅读 · <title>; one click reopens the Session with the card where you left it. The rows are hidden in boss mode.

### Keys

Reader shortcuts are bound to the **card** and only work once it has focus (click it). The only window-level listener is the boss-key chord, so space and arrows in the composer are never touched.

| Key | Action |
| --- | --- |
| `Space` / `→` / `PageDown` | next page (`Shift+Space` previous) |
| `←` / `PageUp` | previous page |
| `↑` `↓` | scroll one line |
| `Ctrl+F` / `⌘F` | search in book; `Enter` next, `Shift+Enter` previous |
| `Esc` | close search; again to fold the card (click `···` to reopen) |
| boss key | fold / restore all readers |

### Settings

Settings → **阅读 (Reading)**: library root, font size, line height, boss key (click, then press a chord containing Ctrl / Alt / Meta, or an F-key). Lists the library with per-book progress.

### Usage

```
/read <keyword>          # fuzzy match in the library; an exact title wins
/read <relative/path.txt>
/read                    # resume the last book
```

### Install

**CLI (web profile):**

```bash
dsh plugin --profile web add github:luyang950/dsh-chat-reader
```

Restart `dsh web` afterwards.

**Desktop:** open **Plugins** in the sidebar, install by GitHub spec `github:luyang950/dsh-chat-reader`, and restart when asked.

Distributed pre-built: no `prepare`/build scripts and no TypeScript, so pnpm never asks for build approval.

> Both this plugin and `dsh-read` register `/read`; enable only one of them.

> Known limitation: DSH's New Session reuses a blank Session of the same workspace first, so it may land you back in a reading Session. Just chat there as usual — the card stays above and the Session becomes an ordinary one in the sidebar.

### Security

- Every route takes a **path relative to the library root**; absolute paths, `..`, backslashes and NUL are refused, and the real (symlink-resolved) path is re-checked against the real root.
- Extension whitelist `.txt` / `.md` / `.epub`; files over 256 MB are refused before reading.
- Book files are only read, never written; EPUB hrefs cannot escape the archive.
- The plugin writes only `$DSH_HOME/dsh-chat-reader/` (`config.json`, `progress.json`, `notes.json`, and `sessions.json` — the ids of up to 20 Sessions that hold a reader).

### Development

```bash
npm test        # node --test, zero dependencies
```

Covers encoding sniffing, paragraph/chapter splitting, EPUB parsing, progress persistence, route validation and path confinement, and the client bundle's loader contract (including folding `command/run` + `command/done` into a reader node). Set `DSH_REACT_DIR` to a `node_modules` containing `react` + `react-dom` to also render the card with real React.

## License

MIT
