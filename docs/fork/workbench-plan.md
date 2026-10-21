# Fork Workbench：全屏工作台实施方案（方案 B）

> 状态：设计稿，尚未实施。本文档只适用于 `custom` 分支（fork），不提交上游。

本方案在 omp 的 TUI 上增加一个可开关的**常驻全屏工作台**（Workbench Shell），提供：

1. **左侧会话侧边栏**：在同一项目的不同会话之间快速切换（类似 Claude 桌面端）。
2. **轮次跳转**：用快捷键跳到上一条/下一条用户提示词；右侧有一条导航条（rail），点击可跳到对应轮次。
3. **鼠标选择复制**：在工作台里拖动鼠标选中文本，通过 OSC 52 复制。Windows 上的 Tabby、Mac 经 SSH 连到 WSL 都能用。

同时满足一个硬性约束：**与上游的冲突面尽量小**。新代码全部放进新文件，上游文件只加少量挂载行。

---

## 1. 背景与选型

omp 的渲染模型决定了，在普通模式下画不出常驻的侧边栏或导航条：

- 产品层的 `Composer`（[composer.ts](../../packages/tui/src/prompt/composer.ts)）每帧做两件事：把已经定稿的行**一次性提交**到终端原生 scrollback（`HistoryBatch`），只保留底部一块可变视口。
- 滚动由终端负责，渲染器从不探测滚动位置。已提交的行无法再修改，也就加不了左右栏。

全屏覆盖层（`ui.showOverlay(c, { fullscreen: true })`）会借用 alt screen（`?1049h`），并默认开启 SGR 鼠标上报。在这种模式下：

- [tui.ts:3925](../../packages/tui/src/tui.ts:3925) 走 `#renderAltFrame`，此时 `Composer` 不再提交 history，原生 scrollback 被冻结。
- 覆盖层关闭、回到 normal buffer 后，`Composer` 会自动补提交冻结期间的 history。
- 进程退出时，`stop()` 中的 `#flushHistoryBeforeStop` 会把还没写出的 history 写进原生 scrollback。

几种方案的比较：

| 方案 | 说明 | 结论 |
|---|---|---|
| A 按需全屏视图 | 需要时临时打开一个全屏浏览器 | 侧边栏不能常驻，切换体验差 |
| **B 常驻全屏外壳** | 一个常驻的 fullscreen overlay，把现有组件按缩窄后的宽度重新渲染 | **采用**：只读上游组件，触点少 |
| C 改造 TUI 核心为全屏模式 | 重写 Composer 和渲染器 | 与上游冲突严重 |
| D tmux 侧窗 | 用外部 pane 显示侧边栏 | 无法跳转轮次和选中文本，Mac 经 SSH 时体验差 |

---

## 2. 目标与非目标

| 目标 | 非目标 |
|---|---|
| 侧边栏列出同项目的会话，用回车或点击切换 | 不改 TUI 核心渲染模型，不碰 `Composer` 和 history 提交逻辑 |
| 快捷键跳转上/下一轮；右侧导航条点击跳转 | 不在普通（非全屏）模式下画侧边栏 |
| 全屏下用鼠标拖选，经 OSC 52 复制 | 不重写 transcript 组件，直接复用它们的 `render(width)` |
| 新代码放进新文件，上游文件只加 1～4 行挂载 | 不做多会话并行，切换会话时仍会中止正在运行的回合（见附录 B） |

---

## 3. 总体架构

```
┌──────────────── 终端 alt screen（由 fullscreen overlay 借用）─────────────────┐
│ Sidebar (24~36列) │ 主列 (W_main)                                │gap│Rail │
│ ● 当前会话标题  3m │ ┌ 内容区 (ScrollView) ───────────────────────┐ │   │ ━   │
│ ◐ 运行中…     12m │ │ header roots + TranscriptContainer 渲染行  │ │   │ │   │
│   旧会话标题   2h  │ │ （可滚动、可拖选、可按轮次跳转）           │ │   │ ┃←视口│
│   …              │ └───────────────────────────────────────────┘ │   │ ━   │
│                  │ ┌ 底部固定区 ─────────────────────────────────┐ │   │ │   │
│ [/ 过滤] [n 新建] │ │ pending/todo/HUD/editorContainer/status 等 │ │   │ ━   │
│                  │ └───────────────────────────────────────────┘ │   │     │
└──────────────────┴───────────────────────────────────────────────┴───┴─────┘
```

**核心思路**：`WorkbenchShell` 是一个常驻的 `fullscreen: true` 覆盖层，它自己不画对话。每一帧它都把现有的 `ui.children`（composer 的根组件）按缩窄后的宽度 `render(W_main)`，然后分到两个区域：

- **内容区**（可滚动）：`chatContainer`（`TranscriptContainer`）以及排在它之前的根组件。
- **底部固定区**：排在 `chatContainer` 之后的根组件，即 pending、todo、HUD、编辑器、状态栏等。

外壳对上游组件**只读、不改**，所以冲突面最小。

**依赖方向**：`pi-tui/fork/*` 不依赖 coding-agent。列会话、切换、复制、新建等业务能力，都由 `coding-agent/fork/workbench.ts` 通过 `WorkbenchDeps` 注入。这与上游 rewind selector 的依赖注入写法一致（[selector-controller.ts:1343](../../packages/coding-agent/src/modes/controllers/selector-controller.ts:1343)）。

---

## 4. 文件布局与上游触点

### 4.1 新增文件（与上游零冲突）

```
packages/tui/src/fork/
├── keybindings.ts            # declare module 合并 Keybindings 接口 + FORK_KEYBINDINGS 表
└── workbench/
    ├── index.ts              # export * 桶文件；顶部注释列出依赖的上游 API 清单（§11）
    ├── shell.ts              # WorkbenchShell：布局、渲染管线、焦点委托、输入路由
    ├── layout.ts             # 纯函数：列宽、底部区高度上限、点击命中测试
    ├── turn-index.ts         # 纯函数：从 TranscriptContainer 构建轮次索引
    ├── rail.ts               # 纯函数：轮次 → 导航条行映射、点击 → 最近轮次
    ├── selection.ts          # 选区状态机 + 按列切片 + 纯文本提取
    └── sidebar.ts            # SessionSidebar 组件（只依赖注入的 deps）

packages/coding-agent/src/fork/
├── workbench.ts              # installWorkbench(mode)：组装 deps、会话列表、切换、读取设置
├── workbench-startup.ts      # openStartupWorkbench / takeStartupWorkbench：预绘制时打开外壳，安装时交接
└── workbench-settings.ts     # register() 定义 fork.workbench.* 设置
```

### 4.2 上游触点（共 6 处，其中 2 处可选）

| # | 文件（近 30 天上游提交数） | 改动 | 必需 | 引入阶段 |
|---|---|---|---|---|
| ① | [main.ts:703](../../packages/coding-agent/src/main.ts:703)（73） | 在 setup wizard 的 `if` 块之后加 `installWorkbench(mode);`，另加 1 行 import | ✅ | M1 |
| ② | [app-keybindings.ts:89](../../packages/tui/src/app-keybindings.ts:89)（8） | 在 `...TUI_KEYBINDINGS,` 之后加 `...FORK_KEYBINDINGS,`，另加 1 行 import | ✅ | M1 |
| ③ | [all-settings.ts](../../packages/coding-agent/src/config/all-settings.ts)（6） | 1 行 import，`DOMAINS` 加 1 项 | 可选 | M5 |
| ④ | [tui.ts:3847](../../packages/tui/src/tui.ts:3847)（68） | `wantAlt` 改为"栈中任一可见覆盖层是 fullscreen" | 可选 | M1 视验证结果决定 |
| ⑤ | [startup-composer.ts:89](../../packages/coding-agent/src/modes/startup-composer.ts:89)（5） | 在 `beginStartupComposer` 的 `composer.start(...)` 之前加 `openStartupWorkbench(composer);`，另加 1 行 import | ✅ | M3 之后 |
| ⑥ | [tui.ts:1164](../../packages/tui/src/tui.ts:1164)（67） | 新增只读 getter `inputDeferred`，暴露私有 `#inputDeferred`；纯新增，不改已有行 | ✅ | M3 之后 |

触点 ⑤ 还连带改了 1 个上游测试：[issue-9597-cold-launch-double-clear.test.ts](../../packages/coding-agent/test/issue-9597-cold-launch-double-clear.test.ts) 走真实预绘制路径，外壳打开期间启动清屏被延后，所以统计前先关闭启动外壳（带 `Fork:` 注释）。触点 ⑤ 本身由 [fork-workbench.test.ts](../../packages/coding-agent/test/fork-workbench.test.ts) 的启动用例守护：这一行在 rebase 中丢失，或被挪到 `start` 之后，测试都会失败。

**为什么挂在 `main.ts`，不挂在 `interactive-mode.ts`**：

- 上游提交频率：`interactive-mode.ts` 近 30 天 204 次，`main.ts` 73 次。
- 挂载点在 `init()` 和 setup wizard 都完成之后，外壳不会盖住首启向导。
- 编辑器被替换时（[interactive-mode.ts:7569](../../packages/coding-agent/src/modes/interactive-mode.ts:7569)）不受影响：外壳每帧都通过 `mode.editor`、`mode.editorContainer` 的 getter 取最新实例，从不缓存。
- 唯一的生产构造点就在 `main.ts` 的 `runInteractiveMode` 中。`cli/render-cli.ts` 是基准工具，不挂载。

---

## 5. 组件设计

### 5.1 WorkbenchShell 渲染管线（`shell.ts`）

```ts
export interface WorkbenchHost {          // InteractiveMode 在结构上已满足，不需要 adapter
	readonly ui: TUI;
	readonly chatContainer?: TranscriptContainer;                       // 预绘制时还没有
	readonly editorContainer: { readonly children: readonly Component[] };
}

export class WorkbenchShell implements Component, OverlayFocusOwner {
	render(width: number): string[];      // 返回 terminal.rows 行
	handleInput(data: string): void;      // 转发给委托的焦点目标
	ownsOverlayFocusTarget(c: Component): boolean;
}
```

每一帧 `render(cols)` 依次执行：

1. **布局**：`layout.ts` 根据 `cols`、`rows` 和侧边栏状态，算出 `sidebarW`、`W_main`、`railX`。
   - 侧边栏宽度：`sidebarW = clamp(floor(cols * 0.22), 24, 36)`。
   - 当 `cols < minColumns`（默认 100）时自动收起侧边栏。
   - 导航条占 1 列，和主列之间空 1 列。
2. **驱动动画**：调用 `chatContainer.beginFrame({ now, tick: Math.floor(now / 80) })`（[transcript-container.ts:459](../../packages/tui/src/chrome/transcript-container.ts:459)），节拍与 composer 一致。外壳显示期间 composer 不运行，必须由外壳代劳，否则 spinner 会停住。
3. **拆分根组件**：在 `ui.children` 中找到 `chatContainer` 的下标 `k`。`[0..k]` 进入内容区，`(k..end]` 进入底部固定区。预绘制时还没有 transcript，就从编辑器所在的根开始固定到底部，它上面的欢迎页进入内容区。
4. **底部固定区**：依次 `render(W_main)` 并拼接。
   - 高度上限为 `rows - 4`，保证内容区至少有 4 行。超出上限时保留尾部，因为光标和选择器高亮通常在下方。
   - 保留其中的 `CURSOR_MARKER`。只要当前焦点组件是 overlay focus target，[tui.ts:4461](../../packages/tui/src/tui.ts:4461) 就会把硬件光标放在这里，输入法（IME）才能正常工作。
5. **内容区**：拼接各根组件的渲染行，并逐行清理：
   - 用 `stripPromptZones()`（[transcript-outline.ts:57](../../packages/tui/src/chat/transcript-outline.ts:57)）去掉 OSC 133 提示区标记；
   - 去掉残留的 `CURSOR_MARKER`。

   清理后交给 `ScrollView.setLines()`（[scroll-view.ts](../../packages/tui/src/components/scroll-view.ts)），`followTail` 默认为 true。
6. **合成**：逐行拼接 `sidebar | ' │ ' | 主列 | gap | rail`。每一段用 `truncateToWidth` 截断、补空格对齐；选区高亮在这一步叠加（§5.5）。

**性能**：组件内部已按宽度做缓存，外壳显示期间只会以 `W_main` 一种宽度渲染，只有开关外壳时才会换宽度。第一版不额外优化。M1 用约 2000 轮的长会话实测，单帧超过 16ms 时，再考虑以下两种手段：

- 缓存内容区行，以 transcript 版本号（或子组件数加尾部 hash）作为键；
- 只渲染视口附近的子组件。

### 5.2 焦点与输入路由

**焦点委托**（实现 [tui.ts:356](../../packages/tui/src/tui.ts:356) 的 `OverlayFocusOwner`）：

```ts
ownsOverlayFocusTarget(c) {
	return c !== this && !ui 覆盖层栈中包含 c; // 非覆盖层组件一律由外壳代管
}
```

- `ui.setFocus(editor)`、`ui.setFocus(inlineSelector)` 因此都能正常落到目标组件上。
- 其他覆盖层关闭后，焦点会回到外壳本身。这时外壳在 `queueMicrotask` 中把焦点恢复到 `editorContainer` 里第一个 Focusable 子组件：没有内联选择器时是编辑器，打开 `/model` 这类会替换编辑器的选择器时就是该选择器。
- `tui` 没有公开获取当前焦点的 getter，所以由外壳根据 editorContainer 推导，不修改上游。

**输入优先级**：外壳通过 `ui.addInputListener`（[tui.ts:2443](../../packages/tui/src/tui.ts:2443)）注册一个监听器，只在外壳是最顶层可见覆盖层时生效，按以下顺序处理：

1. **SGR 鼠标事件**：交给 `routeSgrMouseInput(data, handler)`（[mouse.ts](../../packages/tui/src/mouse.ts)），按坐标分发到侧边栏、内容区、导航条或底部区。点击底部区会把焦点切回编辑器（M4 有侧边栏焦点后才有意义，目前只是吞掉）。所有鼠标事件都 `consume`。
2. **全局快捷键**（§6.1）：匹配后 `consume`。
3. **侧边栏焦点下的按键**：吞掉对应的纯字母键。
4. **其他输入**：不处理，交给焦点组件（编辑器）。

外壳隐藏时，监听器只识别 `toggle` 和 `prevTurn` 两个键（用来唤起外壳），其余全部放行。

**监听器顺序**：外壳在预绘制时就注册了监听器，所以排在 InteractiveMode 初始化时注册的上游监听器之前。上游监听器在有覆盖层时都会让路，目前没有观察到差异；`installWorkbench` 另注册的转发监听器仍排在上游之后。

### 5.3 滚动

外壳有两种焦点状态：`editor`（默认）、`sidebar`。原计划的 `read` 焦点（键盘滚动、`y`、`c`）已在 M3 之后移除，见 §8"M3 之后的调整"。

| 输入 | 行为 |
|---|---|
| 滚轮（任何焦点） | 内容区滚动 3 行，**不抢占键盘焦点**，可以继续打字 |
| 向上滚离底部 | 离开尾部后停止跟随，内容区底部出现一行 `↓ 下方还有 N 行 · 点击回到底部` |
| 点击这行提示 | 回到底部并恢复跟随 |
| 提交提示词 | 自动 `scrollToBottom()`，恢复 followTail（订阅会话的 user message 事件） |

**resize 时保持锚点**：记录视口顶部所在的轮次 `turnIndex` 及其在该轮内的偏移；重新排版后，按新的 `startRow + 偏移` 恢复位置。处于 followTail 时直接贴底。

### 5.4 轮次索引与右侧导航条

**轮次索引**（`turn-index.ts`，纯函数）：

```ts
export interface TurnEntry { index: number; row: number; label: string }
export function buildTurnIndex(transcript: TranscriptContainer, rows: readonly string[], rowOffset: number): TurnEntry[];
```

- 遍历 `transcript.children`，筛出 `instanceof UserMessageComponent`（[user-message.ts:128](../../packages/tui/src/chat/user-message.ts:128)）的块。`CollapsedSyntheticMessageComponent` 是另一个类，自然会被排除。
- `row = rowOffset + transcript.getChildStartRow(child)`（[transcript-container.ts:983](../../packages/tui/src/chrome/transcript-container.ts:983)），其中 `rowOffset` 是 header 等前置根组件的行数。
- `label` 取该块渲染行里第一个非空行，依次去掉 ANSI（`Bun.stripANSI`）、去掉气泡边框前缀、`replaceTabs`，最后截断。不读组件私有的 `#text`。

**导航条**（`rail.ts`，纯函数）：

- **映射**：`y_i = floor(row_i * H / max(total, 1))`，`H` 为内容区高度。多个轮次落到同一行时合并显示。
- **字符**：
  - 普通轮次用 `━`；
  - 当前轮次（满足 `row <= scrollTop` 的最后一轮）用 accent 色的 `━`；
  - 视口覆盖的行用 `┃` 作背景，其余用 dim 的 `│`。
- **点击**：在第 `y` 行点击时，跳到 `|y_i - y|` 最小的那一轮，并设 `scrollTop = row_i - 1`，让提示词贴近视口顶部。
- **悬停**：在底部状态行临时显示 `第 k/N 轮 · <label>`，每 50ms 最多重绘一次。

**快捷键**：全局的 `prevTurn`、`nextTurn` 共用同一个 `jumpToTurn(delta)`。外壳隐藏时按 `prevTurn`，会先打开外壳再跳到上一轮，所以在任何状态下"跳到上一条提示词"都只需按一次键。

### 5.5 鼠标选择与复制（`selection.ts`）

- **状态机**：`idle → pressed(anchor) → dragging(anchor, head) → idle`。
- **坐标**：选区记录的是内容区的**逻辑行号**（`ScrollView.logicalRowAt(y)`）加显示列号，滚动时选区保持不变。
- **拖选**：按下时记录 anchor，拖动时更新 head。拖到内容区上下边缘时，启动 50ms 定时器每次自动滚动 ±1 行，并继续扩展选区。
- **双击 / 三击**：在同一格 400ms 内连续按下，分别选中一个词或整行。词边界按空白和标点判断，CJK 字符逐字成词。
- **高亮**：合成阶段，对选区覆盖的行，用 `sliceByColumn`（[utils.ts:752](../../packages/tui/src/utils.ts:752)）按列切出纯文本，再加反色重画。宽字符边界向外吸附。
- **复制**：松开鼠标时，按行切出纯文本，每行去掉尾部空格（`trimEnd`），用 `\n` 连接，然后调用注入的 `deps.copyToClipboard(text)`（即 [clipboard.ts:117](../../packages/coding-agent/src/utils/clipboard.ts:117)：先发 OSC 52，再尝试本机剪贴板）。底部状态行提示"已复制 N 行"。

**已知限制与兜底**：

- 软换行处会被复制成真实换行。需要干净的原文时，用上游 `/copy` 选择器。
- 需要原生选择时：Tabby 中按住 Shift 拖动（xterm.js 会绕过鼠标上报）；Mac 终端按住 Option 拖动；也可以按 `toggle` 关闭外壳，回到原生模式。

### 5.6 左侧会话侧边栏（`sidebar.ts`）

```ts
export interface SidebarDeps {
	listSessions(): Promise<SidebarSession[]>;  // SessionManager.listForPicker(cwd, sessionDir)
	currentPath(): string | undefined;          // sessionManager.getSessionFile()
	isStreaming(): boolean;                     // session.isStreaming
	switchTo(path: string): Promise<void>;      // ctx.handleResumeSession(path)
	newSession(): Promise<void>;                // ctx.handleNewCommand()
}
export interface SidebarSession { path: string; title: string; modified: Date; searchText: string }
```

`title` 由 `sessionDisplayName(info)`（[session-listing.ts:143](../../packages/coding-agent/src/session/session-listing.ts:143)）生成。会话切换调用 `handleResumeSession`（[selector-controller.ts:1974](../../packages/coding-agent/src/modes/controllers/selector-controller.ts:1974)），沿用上游已有的整套流程：落盘设置、迁移 worktree、`switchSession`、重放 transcript、重新加载 todos。

- **渲染**：
  - 首行是项目名（cwd 的 basename，经 `shortenPath` 处理）和会话数，其下是一条分隔线。
  - 每个会话占一行：`标记 + 标题（截断） + 右对齐的相对时间`。当前会话的标记是 `●`，正在流式输出时换成 spinner；相对时间形如 `3m`、`2h`、`5d`。
  - 侧边栏有焦点时，选中行反色显示。
  - 底部显示提示 `/ 过滤  n 新建`。
- **交互**：
  - `↑/↓` 或滚轮移动选中项；回车或单击切换到该会话。
  - `/` 进入过滤，排序复用 `rankSessionSearchMatches`（[session-selector.ts:405](../../packages/tui/src/overlays/session-selector.ts:405)）。
  - `n` 新建会话，`Esc` 回到编辑器。
- **中止保护**：当前会话正在流式输出时，第一次回车或点击只在状态行提示"再次确认将中止当前回合"，3 秒内再确认一次才切换。
- **刷新时机**：
  - 外壳打开时、切换会话后、`agent_end` 之后（标题可能已更新）刷新一次；
  - 外壳可见期间，每 30 秒刷新一次。

  刷新是异步的，同一时间只跑一个刷新任务，结果返回前继续显示旧数据。cwd 每次都从 `sessionManager.getCwd()` 读取，worktree 迁移后列表会自然跟着变。

---

## 6. 快捷键与设置

### 6.1 快捷键（`fork/keybindings.ts`）

默认键都是在已占用键位表里核对过的空闲键。`ctrl+x` 已被 autoresearch 扩展占用，`ctrl+o`、`ctrl+]`、`alt+r` 是上游的默认键，所以都不用。用户可以在 omp 的 keybindings 配置里改键。

| id | 默认键 | 作用 |
|---|---|---|
| `fork.workbench.toggle` | `ctrl+n` | 显示或隐藏外壳 |
| `fork.workbench.prevTurn` | `ctrl+up` | 跳到上一轮；外壳隐藏时先打开外壳 |
| `fork.workbench.nextTurn` | `ctrl+down` | 跳到下一轮 |
| `fork.workbench.sidebar` | `f2` | 聚焦侧边栏；再按一次收起或展开侧边栏 |

**Mac 注意**：`⌃↑`、`⌃↓` 默认被 Mission Control 占用。可以在"系统设置 → 键盘快捷键"里关掉这两项，也可以把 `prevTurn`、`nextTurn` 改到其他键。导航条点击和滚轮始终可用。

**待办（M5）**：上游 `/hotkeys`（[command-controller.ts:931](../../packages/coding-agent/src/modes/controllers/command-controller.ts:931)）还列不出这些键。之后新增或改动工作台快捷键时，都要把说明同步加入 `/hotkeys`。

### 6.2 设置（`fork/workbench-settings.ts`）

| 设置 | 默认 | 说明 |
|---|---|---|
| `fork.workbench.enabled` | `true` | 总开关；关闭后快捷键也不再拦截 |
| `fork.workbench.autoOpen` | `true` | 启动即进入外壳（预绘制时打开，`installWorkbench` 接管）；`ctrl+n` 仍可隐藏（目前是固定行为，尚无设置项） |
| `fork.workbench.sidebarWidth` | `0` | 0 表示按比例自动计算 |
| `fork.workbench.minColumns` | `100` | 终端列数低于该值时自动收起侧边栏 |

M1～M4 期间，这些值先写成 `fork/workbench.ts` 中的常量（`autoOpen` 目前直接写成安装后打开）；M5 再决定是否接入设置系统（触点 ③）。

---

## 7. 生命周期与边界情况

| 场景 | 处理 |
|---|---|
| 切换会话 | `handleResumeSession` 会调用 `renderInitialMessages({ clearTerminalHistory: true })`，登记一次待执行的 clearScrollback。外壳显示期间这次清理不会执行，等外壳关闭、退出 alt screen 时一并执行，所以原生 scrollback 不会混入旧会话的内容。**M1 必须验证。** `chatContainer` 每帧都通过 getter 读取，即使实例被替换也不受影响。 |
| 其他全屏覆盖层（`/resume`、rewind 等） | 它们成为最顶层，接管 alt 帧和输入；外壳的监听器因为不再是最顶层而自动失效。它们关闭后，外壳重新接管焦点（§5.2）。 |
| 非全屏覆盖层（center 锚定的 jobs、report 等弹窗） | 现状下 [tui.ts:3847](../../packages/tui/src/tui.ts:3847) 只看最顶层覆盖层是不是 fullscreen，于是终端会退回 normal buffer，外壳闪掉，并补提交 history。处理方式见下文"非全屏覆盖层的两种方案"。 |
| resize | 重新布局，按轮次锚点恢复滚动位置（§5.3）；侧边栏按 `minColumns` 自动收起或展开。 |
| 流式输出 | 订阅 `session.subscribe`，每个事件都 `requestRender`；流式期间外壳另开一个 80ms 定时器，驱动 spinner 和 `beginFrame`。 |
| 启动预绘制 | `beginStartupComposer` 在首帧之前打开外壳，首帧直接进入 alt screen，不再先显示约 1 秒的内联界面。此时外壳的宿主只有 composer 的编辑器，编辑器固定在底部；`installWorkbench` 用 `rebind` 换成 InteractiveMode。预绘制时 tty 仍是 cooked 模式，打开鼠标上报会把报告回显到画面上，所以外壳的 `mouseTracking` 在 `ui.inputDeferred` 期间为 false；`enableInput()` 切到 raw 输入后的下一帧即打开（实测约 0.65s，早于接管约 1s）。进入全屏到切 raw 之间约 0.4s，滚轮在部分终端会变成方向键，这段无法消除。原生渲染模式下不在预绘制时打开。 |
| 退出（`ctrl+c`、`/quit`） | `tui.stop()` 会自动退出 alt screen 并补写 history；外壳在 `ui` 停止时清理定时器和输入监听器。外壳从启动一直开到退出时，启动时的清屏始终被延后，退出时直接丢弃：终端保留启动前的 scrollback，可见屏被最终画面覆盖。中途关过外壳时，清屏在第一次关闭时执行，和上游一致。 |
| 原生 TSP 渲染（`isNativeRendering()`） | 禁用外壳：启动时不自动打开，也不提示；手动 `toggle` 时提示"工作台不支持当前的原生渲染模式"。 |
| 图片（kitty、sixel） | 在内容区滚动时图片可能被截断。第一版接受这个问题；如果影响明显，把图片行替换为 `[image]` 占位。 |
| 失去的原生能力 | 外壳期间不能用终端原生搜索，也不能点击内联 subagent 聚焦。按 `toggle` 回到原生模式即可。 |

**非全屏覆盖层的两种方案**：

- **(a) 改 tui.ts 一行**：把 `wantAlt` 改为"栈中任一可见覆盖层是 fullscreen"，相邻的 mouseTracking 判断同步修改。已确认 [tui.ts:4457](../../packages/tui/src/tui.ts:4457) 的 `#compositeOverlaysIntoWindow` 会把所有覆盖层都合成进 alt 帧，所以小弹窗能正常叠在外壳上面。代价是与上游有小冲突。
- **(b) 零触点**：外壳检测到上方出现非全屏覆盖层时，主动临时隐藏，弹窗关闭后再恢复。代价是一次闪烁和一次 history 补提交。
- **建议**：先实现 (b)；如果闪烁明显，再改用 (a)，并考虑把 (a) 作为通用修复提给上游，让这个触点归零。

---

## 8. 分阶段迭代规划

每个阶段都要满足以下**通用验收**：

- `bun check` 通过；
- 本阶段新增的测试，以及 `packages/tui`、`packages/coding-agent` 里相关的已有测试都通过；
- 上游触点不超过本阶段计划的范围；
- 不提交 `.gitignore` 忽略的文件。

阶段之间是"前一阶段验收通过，再进入下一阶段"。M0、M1 中任何一项前提被推翻，都要先回到本文档修订方案，再继续。

### M0 前置验证（不写代码）

**目标**：在投入编码前，确认终端环境满足前提。

**改动**：无。

**验收**：

- [x] 在 Windows 的 Tabby 和 Mac 上（经 SSH 连到 WSL）分别执行下面的命令，再到别处粘贴，能看到 `test`，说明 OSC 52 可用。Tabby 需要在设置中允许剪贴板写入。
  ```bash
  printf '\033]52;c;%s\007' "$(printf test | base64)"
  ```
- [x] 在两个环境中确认 `ctrl+n`、`ctrl+up`、`ctrl+down`、`f2` 能送到终端程序，没有被终端或系统拦截。被拦截的键记下来，M1 改用替代键。
- [x] 在两个环境中确认 SGR 鼠标上报可用。可以在现有的全屏覆盖层（如 `/resume`）里滚动滚轮来验证。

**结果**：已在 Tabby（Windows）和 Mac（SSH）上验收，OSC 52、上述按键和 SGR 鼠标上报均可用，不需要替代键或兜底方案。Mac 上 `⌃↑`、`⌃↓` 需要先关掉 Mission Control 的对应快捷键（§6.1）。

### M1 外壳骨架（风险验证原型）

**目标**：搭出最小可用的外壳，同时验证架构层面的全部风险。

**改动**：

- 新增 `packages/tui/src/fork/keybindings.ts`，先只定义 `toggle`。
- 新增 `packages/tui/src/fork/workbench/{index,shell,layout}.ts`：
  - 只有主列，暂无侧边栏和导航条；
  - 包含渲染管线（§5.1）、焦点委托与输入路由（§5.2）、滚轮滚动和 followTail、动画驱动；
  - 实现非全屏覆盖层方案 (b)。
- 新增 `packages/coding-agent/src/fork/workbench.ts`：`installWorkbench(mode)`，注册输入监听、处理开关、在 native 渲染模式下禁用。
- 加上上游触点 ① ②。

**验收（功能）**：

- [x] 按 `ctrl+n` 打开和关闭外壳；关闭后原生 scrollback 中能看到外壳期间产生的全部输出，没有缺失或重复。
- [x] 在外壳中正常打字、提交、中断；中文输入法候选框跟随光标。
- [x] 流式输出期间 spinner 在转，transcript 实时增长；跟随底部时自动滚动。
- [x] 滚轮上滚后停止跟随，出现"↓ 下方还有 N 行"；提交提示词后回到底部。
- [x] 打开 `/model` 这类内联选择器，以及 `/resume` 这类全屏覆盖层，再关闭，焦点都能回到编辑器。
- [x] 打开非全屏弹窗（如 jobs）时，外壳临时隐藏；弹窗关闭后外壳恢复。
- [x] 改变终端尺寸后布局正确。

**验收（风险结论，写回本文档）**：

- [x] **切换会话与 clearScrollback**：在外壳中执行 `/resume` 切换会话，再关闭外壳，原生 scrollback 里不应残留旧会话的内容。
- [x] **性能**：约 2000 轮的会话，单帧渲染 ≤ 16ms。超出时，把 §5.1 的优化纳入 M2。
- [x] **非全屏覆盖层**：确认方案 (b) 的闪烁程度，决定是否改用 (a)（触点 ④）。结论：闪烁可以接受，保留方案 (b)，不加触点 ④。

**验收（测试）**：

- [x] 用 `VirtualTerminal` 和 `VirtualRenderScheduler` 写外壳集成测试（参考 [alt-frame-row-diff.test.ts](../../packages/tui/test/alt-frame-row-diff.test.ts)），覆盖三点：
  1. 外壳显示期间，不向 normal buffer 写入 history 字节；
  2. 编辑器有焦点时，硬件光标位于底部固定区；
  3. 外壳关闭后，history 补提交完整。

**M1 实施记录**：

- **与方案的偏差**：
  - 上游已经有 `ui.getFocused()`，直接用它，不再从 editorContainer 推导焦点。
  - 没有调用 `beginFrame` / `transcript.render()`。外壳自己遍历 transcript 块：每块调用 `setTranscriptAllocation(MAX)` 后渲染，按渲染数组的身份做缓存；关闭时释放已提交块的缓存。这样避开了 `transcript.render()` 的副作用。spinner 靠组件自己的 `requestComponentRender` 驱动，不需要外壳的定时器。
  - 非全屏覆盖层采用方案 (b)：外壳 `setHidden(true)` 让位，然后每 150ms 轮询一次，覆盖层全部关闭后再恢复（上游没有覆盖层关闭事件）。
  - 外壳成为常驻覆盖层后，上游有几个全局快捷键在"存在覆盖层"时会主动放弃：`ctrl+t`、`ctrl+r`、`ctrl+g`、`alt+l`、`ctrl+o`。`fork/workbench.ts` 在外壳位于最顶层、且编辑器持有焦点时把它们转发给 InteractiveMode；问答框或审批框持有焦点时，`ctrl+o` 照上游逻辑原地展开它们。
- **风险结论**：
  - clearScrollback：外壳打开期间发生的销毁式重绘，会融合进关闭外壳时的 alt screen 退出流程，旧会话的行不会留在原生 scrollback 里。已有自动化测试覆盖。
  - 会话重建：`renderInitialMessages` 重放期间，`chatContainer` 会临时指向一个未挂载的暂存容器。外壳因此改为从 `ui.children` 中找出实际挂载的 transcript 根，不直接信任 `chatContainer`。
  - 性能：在 `VirtualTerminal` 160×50 下测了 2000 轮，每轮是一条用户消息加 12 段 Markdown。结果见下表。≤16ms 的预算针对空闲帧和流式帧，两者都满足，§5.1 的优化暂不需要；打开外壳的那一帧是一次性开销，约 25～28ms。

    | 场景 | 耗时 |
    |---|---|
    | 首次打开（transcript 已有缓存） | 25ms |
    | 关闭后再打开（缓存已释放） | 28ms |
    | 空闲帧 | 0.7ms |
    | 流式更新帧 | 中位数 1.2ms，p95 1.4ms |
- **已知限制**：
  - `ctrl+shift+o`（显示或隐藏工具活动）没有对应的 InteractiveMode 方法，外壳中暂不可用。
  - 被转发的快捷键只在焦点位于编辑器时生效（`ctrl+o` 展开问答框和审批框除外）。
  - 在外壳中按 `ctrl+g` 打开外部编辑器，会让 `ui` 先 stop 再 start。如果在此之前有一次尚未执行的销毁式重绘（例如在外壳里切换了会话），这次重绘会被丢掉，原生 scrollback 可能残留旧内容。
  - 比屏幕矮的全屏覆盖层（计划评审、底部锚定的菜单）上方会透出外壳的内容。
  - 用户如果把 `ctrl+n` 绑给了别的功能，外壳会先拿到这个键。
  - 任何新出现的用户消息都会把视图重新钉到底部。
- **手动验收**（已完成）：
  - M0 中的全部终端能力验证；
  - 中文输入法候选框的位置；
  - 方案 (b) 在真实终端中的闪烁程度。

### M2 轮次跳转与导航条

**目标**：完成需求 2，即用快捷键跳转轮次，并提供右侧导航条。

**改动**：

- 新增 `turn-index.ts`、`rail.ts`（纯函数）。
- `shell.ts` 增加以下能力：
  - 导航条渲染与点击、悬停；
  - ~~`read` 焦点与相应按键~~（M3 之后移除）；
  - `jumpToTurn`；
  - 点击"下方还有 N 行"提示回到底部（增补）；
  - resize 时保持锚点。
- `fork/keybindings.ts` 增加 `prevTurn`、`nextTurn`（`read` 已在 M3 之后移除）。
- 如果 M1 性能不达标，在这里实现内容区缓存。

**验收（功能）**：

- [x] 用 `ctrl+up`、`ctrl+down` 跳转后，目标提示词位于视口顶部附近，跳到第一轮或最后一轮时不越界。
- [x] 外壳隐藏时按 `ctrl+up`，外壳打开并直接跳到上一轮。
- [x] 导航条上的刻度数等于用户提示词数（合成消息不计）；视口位置和当前轮次的高亮正确。
- [x] 点击导航条能跳到最近的一轮；悬停时底部显示 `第 k/N 轮 · 标签`。
- [x] 改变终端尺寸后，视口仍停在原来那一轮。
- [x] 上滚后点击"↓ 下方还有 N 行 · 点击回到底部"这一行，回到底部并重新跟随新输出（增补）。

**验收（测试）**：

- [x] `turn-index`：两个用户消息块加一个合成消息块，应得到恰好 2 个轮次，且 `row` 等于各块的起始行。轮次索引改为外壳拼接内容时顺手记录（见下方实施记录），所以这一项由外壳集成测试 `marks each real prompt on the rail…` 覆盖（合成气泡不计入导航条刻度），没有单独的 `turn-index` 测试。
- [x] `rail`：映射单调；同一行多个轮次时合并；点击时最近轮次的边界判断正确。

**M2 实施记录**：

> 注：下文涉及阅读模式（`read` 焦点、`f3`）的内容已在 M3 之后移除，见"M3 之后的调整"。

- **与方案的偏差**：
  - 轮次索引不再单独遍历 transcript，而是在外壳拼接内容区时顺手记录每个轮次块在内容缓冲中的起始行。`TurnEntry` 只保留 `row` 和 `label`。
  - 轮次块的判定与上游 rewind/copy 的口径一致，§5.4 只看 `UserMessageComponent` 的假设不成立：
    - 非合成的 `UserMessageComponent` 算一轮。合成气泡（auto-continue 等）和真实提示词是同一个类，只能通过公开的 `describe()` 角色 `omp.user.synthetic` 区分。每个块只判定一次，结果缓存。
    - `/skill:` 提示词（`SkillMessageComponent`）和协作提示词（`CollabPromptMessageComponent`）也算一轮。
    - 主 transcript 里并不会出现 `CollapsedSyntheticMessageComponent`。
  - 标签：用户气泡用上游的 `renderTranscriptBlockEmergencyRow(width)`，取第一行提示词正文，跳过可能带 reaction 或 steered 徽章的上内边距行；其他卡片取第一个有文字的行。
  - 布局中，导航条占主列最右侧 2 列（1 列间隔加 1 列导航条），只出现在内容区旁边；底部固定区仍用整个主列宽度。主列不足 20 列时不显示导航条。点击间隔列也算点中导航条。
  - 跳转请求先记下来，到下一帧内容排好后再执行。这样隐藏状态下按 `ctrl+up` 时，外壳先打开、贴底，再跳到视口顶部之上的最近一条提示词。如果最新一轮整屏放得下，落点是倒数第二条。
  - 阅读模式下，提示行单独占内容区最后一行，不再盖住内容。悬停提示和"下方还有 N 行"仍然覆盖最后一行。
  - 阅读模式记下进入时的焦点组件。外壳托管的其他组件拿到焦点后（例如审批框或问答框替换了编辑器），下一帧就退出阅读模式：提示行消失，按键交给新焦点。这样 Esc、Enter 不会被误送进审批框。
  - 阅读模式下 `ctrl+d`、`ctrl+u` 滚动半页。它们若漏进编辑器，会退出 omp 或清空草稿。
  - 悬停时记下指针所在的导航条行，每帧再换算成轮次；只有指针所在行变化时才重绘，取代"每 50ms 最多一次"。
  - `ctrl+up`、`ctrl+down` 在外壳已打开时只跳转、不进入阅读模式，避免打字途中跳一下就把后续字母吞掉。只有从隐藏状态唤起时才进入阅读模式（与 §5.4 一致）。
  - 增补（M3 之后）："下方还有 N 行"提示改为"点击回到底部"。单击这一行的内容列会滚到底部并恢复跟随，不会开始选区。只有上一帧显示的确实是这条提示时才响应；导航条悬停或复制提示盖住它时，单击照常开始选区。
- **性能**：导航条让内容列比终端窄 2 列，打开外壳时所有块都要按新宽度重排一次。轮次标签按块的渲染数组缓存。

  | 场景 | 耗时 |
  |---|---|
  | 首次打开 | 37～42ms |
  | 关闭后再打开 | 28～30ms |
  | 空闲帧 | 1.3～1.4ms |
  | 流式更新帧 | 中位数 1.0～1.6ms，p95 1.5～2.0ms |
- **已知限制**：
  - 悬停提示会暂时盖住内容区最后一行。
  - 技能卡片和协作卡片不公开 attribution，所以 agent 调起的技能提示词也会算一轮。
  - 阅读模式只吞掉可打印字符和上述滚动键。其他控制键（`ctrl+c`、Backspace 等）和粘贴仍然交给编辑器。
  - 判定用户气泡是否合成要调用 `describe()`，它会顺带解码并缓存提示词里的附图。带大量截图的会话，首次打开外壳会更慢，并常驻一份解码后的图片字节。
  - 协作提示词的悬停标签是作者行 `«guest» ›`，不是提示词正文。
  - 指针从导航条移出终端窗口后，悬停提示会留到下一次鼠标事件。
  - 快速三击"下方还有 N 行"提示：第一击回到底部，后两击落在同一格，被当作双击，复制该行的一个词。
  - 贴底规则改为按轮次判定：合成气泡（auto-continue）不再把视图拉回底部，协作访客的提示词会。
  - resize 锚点只记录"第几轮加轮内偏移"。如果该轮自身被重排得更短，偏移可能落进下一轮。
  - Mac 上 `⌃↑`、`⌃↓` 默认被 Mission Control 占用（§6.1）。
- **手动验收**（已完成）：真实终端中悬停与点击导航条的手感。

### M3 鼠标选择与复制

**目标**：完成需求"用鼠标选中文本并复制"。

**改动**：

- 新增 `selection.ts`。
- `shell.ts` 接入：拖选、边缘自动滚动、双击和三击、反色高亮。
- ~~在 `read` 焦点下增加 `y`（复制当前轮）、`c`（上游 `/copy` 选择器）~~（M3 之后移除）。
- `fork/workbench.ts` 注入 `copyToClipboard`。

**验收（功能）**：

- [x] 在 Tabby（Windows）和 Mac（SSH）上拖选，粘贴的内容与屏幕上看到的一致；中英文混排时宽字符不会被切开，也不带 ANSI 残留和行尾空格。
- [x] 拖到上下边缘时自动滚动，跨越多屏的选区完整。
- [x] 双击选中一个词，三击选中整行。
- [x] 按住 Shift（Tabby）或 Option（Mac）拖动时，走原生选择。

**验收（测试）**：

- [x] `selection`：用包含 CJK 和 ANSI 的多行、跨行选区作为输入，提取的文本应完全精确。

**M3 实施记录**：

> 注：下文涉及阅读模式和 `y`、`c` 的内容已在 M3 之后移除，见"M3 之后的调整"。

- **与方案的偏差**：
  - 状态机做成 `selection.ts` 里的 `MouseSelection`：单击只记 anchor，指针离开 anchor 所在格才出现选区。双击、三击选中的词和整行是固定范围，按住拖动不会再扩展。第四次连击重新从单击算起。
  - 词边界：连续的字母、数字、下划线算一个词；CJK 字符逐字成词；其他字符（标点、空格）单独成词。
  - 选区坐标超出可见内容时会被夹住：指针在内容区以下（底部固定区）算作最后一个可见行的行尾，在内容列右侧（导航条）算作行尾。
  - 自动滚动：拖动中指针停在内容区第一行，或移到最后一个可见行以下（底部固定区）时，每 50ms 滚动 1 行，并按指针当前位置重新计算选区终点。双击、三击的固定选区不会触发自动滚动。
  - 松开事件丢失（拖动中有别的全屏 overlay 收走了它）时，下一条"无按键移动"上报会取消这次拖动，不复制、不继续滚动。
  - 选区和共享工具保持一致：分词用 `getSegmenter()`，宽度用 `visibleWidth()`，词分类用 `getWordNavKind()`（与编辑器的按词移动同一口径）。
  - 阅读模式帮助行变长了，"↓ 下方还有 N 行"挪到帮助文字前面，窄终端截掉的是帮助而不是行数。
  - 松开后高亮保留，直到下一次按键或单击。按键会照常送达编辑器，不会被吞掉。宽度变化导致内容重排时清空选区，因为逻辑行号已经指向别的文本。
  - 复制结果和 `y` 的结果用状态行提示（"已复制 N 行"、"已复制第 k 轮"），优先级仅低于导航条悬停提示。
  - `y` 复制视口所在的整轮：从提示词气泡开始，到下一轮之前，复制的是渲染后的文本，首尾空行会去掉。
  - `c` 调用 InteractiveMode 的 `showCopySelector()`。它是叠在外壳上的全屏 overlay，关闭后焦点回到编辑区，阅读模式保持不变。
  - 剪贴板和复制选择器都通过 `WorkbenchShellOptions` 注入，pi-tui 仍然不依赖 coding-agent。没有注入剪贴板时，拖选只高亮、不复制。
- **性能**：无选区时每帧只多一次判空，基准测试与 M2 持平（首次打开约 40ms，空闲帧 1.4ms，流式更新中位数 1.05ms）。
- **已知限制**：
  - 复制的是渲染结果：软换行变成真实换行，气泡内边距、徽章（如 steered 的 `*`）、工具框线都会一起复制。需要原文时用 `c`。
  - 选区按逻辑行号记录。选区上方的块高度变化（例如运行中工具的输出、subagent 进度块在流式增长）后，高亮会落到别的行，直到下一次单击。
  - 状态行提示覆盖内容区最后一行，选区落在这一行时看不到该行的高亮。
- **手动验收**（已完成）：Tabby（Windows）和 Mac（SSH）下的拖选、双击三击、OSC 52 粘贴结果，以及按住 Shift／Option 走原生选择。

### M3 之后的调整（验收反馈）

- **默认打开**：启动即打开外壳，`ctrl+n` 仍可隐藏和重新打开。原生渲染模式下不打开，也不弹警告。暂时是固定行为，M5 再决定是否做成 `autoOpen` 设置。是否打开在预绘制和安装时各判断一次：Tern 乐观启动在安装之后才被撤销时不会补开，需要手动 `ctrl+n`。初始化期间按 `ctrl+n` 关掉外壳，安装时会被重新打开（窗口很短，可以接受）。
- **启动即全屏**（触点 ⑤ ⑥）：原来外壳在 `createAgentSession` 和 `init` 之后才打开，启动时会先显示约 1 秒的内联界面。现在 `beginStartupComposer` 在首帧之前调用 `openStartupWorkbench`，首帧直接是全屏外壳；`installWorkbench` 通过 `takeStartupWorkbench` 取回这个外壳并 `rebind` 到 InteractiveMode，没有预绘制时（非 TTY 等）照旧新建。打开失败只记日志，启动退回内联。鼠标上报在切到 raw 输入时就打开（触点 ⑥），不等接管。细节见 §7"启动预绘制"和"退出"两行。
- **移除阅读模式**：删掉 `fork.workbench.read`（`f3`）、`read` 焦点及其按键，包括 `j/k`、`ctrl+d/u`、`space`、`[`、`]`、`g/G` 滚动跳转，以及 `y` 复制当前轮、`c` 打开 `/copy`。替代方式如下：
  - 滚动用滚轮；
  - 跳轮用 `ctrl+up`、`ctrl+down` 或点击导航条；
  - 复制用鼠标拖选，或上游 `/copy`。

  外壳隐藏时按 `ctrl+up` 仍会打开外壳并跳到上一轮，之后按键照常输入编辑器。少了阅读模式的提示行，内容区重新用满底部固定区以上的全部行。
- **快捷键说明**：工作台快捷键的说明要加入 `/hotkeys`，列为 M5 待办（§6.1）。

### M4 会话侧边栏

**目标**：完成需求 1，在同项目的会话之间快速切换。

**改动**：

- 新增 `sidebar.ts`。
- `shell.ts` 接入侧边栏的布局、焦点和鼠标处理。
- `fork/keybindings.ts` 增加 `sidebar`。
- `fork/workbench.ts` 实现 `SidebarDeps`：`listForPicker`、`handleResumeSession`、`handleNewCommand`，以及刷新策略。

**验收（功能）**：

- [ ] 列表只包含当前项目的会话，按修改时间排序；当前会话有标记，运行中的会话显示 spinner。
- [ ] 回车或单击切换会话后，transcript、todos、状态栏都切换到目标会话，侧边栏的标记跟着更新。
- [ ] 当前会话在运行时，第一次确认不会切换，3 秒内第二次确认才切换。
- [ ] `/` 过滤和 `n` 新建正常；回合结束后标题会更新。
- [ ] 终端宽度小于 100 列时，侧边栏自动收起；按 `f2` 可以手动展开或收起。

**验收（测试）**：

- [ ] `sidebar`（注入假 deps）：排序和当前会话标记正确；运行中第一次确认不调用 `switchTo`，第二次才调用。

### M5 收尾

**目标**：让功能达到可以长期使用的状态。

**改动**：

- 新增 `fork/workbench-settings.ts`；决定是否接入触点 ③（不接入时保留常量）。
- 决定是否把默认打开做成 `autoOpen` 设置（默认打开已在 M3 之后实现）。预绘制早于 Settings 加载，`autoOpen`、`enabled` 要像 ComposerCache 那样缓存到预绘制阶段可读；否则只能在接管时再关闭，"先全屏再退回"的闪变又会回来。
- 把工作台快捷键（`ctrl+n`、`ctrl+up`、`ctrl+down`、`f2` 等）的说明加入 `/hotkeys`。
- 在 `fork/workbench/index.ts` 顶部写上游 API 依赖清单（§11）。
- 在 `packages/coding-agent/CHANGELOG.md` 的 `[Unreleased]` 下增加 `### Added` 条目。
- 根据 M1～M4 的实际结果更新本文档。

**验收**：

- [ ] 设置项生效：关闭 `enabled` 后快捷键不再拦截；关闭 `autoOpen` 后启动停在原生界面（预绘制时也不打开），开启时启动即进入外壳（不会盖住 setup wizard）。
- [ ] `/hotkeys` 列出全部工作台快捷键及其说明。
- [ ] 完整跑一遍 M1～M4 的功能验收清单，没有回退。
- [ ] 执行 `git diff main --stat`，确认上游文件的改动只有计划中的触点。

---

## 9. 测试原则

测试遵守仓库 `AGENTS.md` 中的 Testing Guidance：

- 只测对外契约，每个测试都要能说明回归后用户会看到什么；
- 不做源码字符串断言（source-grep）；
- 不用 `mock.module()`，需要替身时用 `spyOn`；
- 纯函数（turn-index、rail、selection、layout）用单元测试；外壳的交互用 `VirtualTerminal` 写集成测试。

---

## 10. Changelog 与上游同步

**Changelog**（M5 时添加）：

```markdown
### Added
- Added a fullscreen workbench (`ctrl+n`) with a session sidebar, a turn navigation rail and mouse text selection
```

**同步上游的流程**：

1. 合并上游后，冲突只可能出现在触点 ① ② ⑤ ⑥（以及选用的 ③ ④）的几行上，手动保留即可。
2. 运行 `bun check` 和外壳的集成测试，它们能发现上游内部 API 的漂移（见 §11）。
3. 有 API 变化时，对照 `fork/workbench/index.ts` 顶部的依赖清单逐项修复。

---

## 11. 依赖的上游 API 清单

上游改动以下接口时，需要同步修改外壳：

| API | 位置 | 用途 |
|---|---|---|
| `ui.showOverlay` / `OverlayOptions.fullscreen` | [tui.ts](../../packages/tui/src/tui.ts) | 外壳本体 |
| `OverlayFocusOwner.ownsOverlayFocusTarget` | [tui.ts:356](../../packages/tui/src/tui.ts:356) | 焦点委托 |
| `ui.addInputListener` | [tui.ts:2443](../../packages/tui/src/tui.ts:2443) | 键盘、鼠标拦截 |
| `ui.children` 中 chatContainer 的位置 | [composer.ts](../../packages/tui/src/prompt/composer.ts) `setRuntimeChildren` | 内容区与底部区的拆分 |
| `beginStartupComposer` / `Composer.ui` / `Composer.editor` | [startup-composer.ts](../../packages/coding-agent/src/modes/startup-composer.ts)、[composer.ts](../../packages/tui/src/prompt/composer.ts) | 预绘制时打开外壳 |
| `OverlayOptions.mouseTracking`（每帧重读）/ `TUI.inputDeferred`（触点 ⑥） | [tui.ts](../../packages/tui/src/tui.ts) | cooked 输入期间关闭鼠标上报 |
| `TranscriptContainer.beginFrame` / `getChildStartRow` | [transcript-container.ts](../../packages/tui/src/chrome/transcript-container.ts) | 动画、轮次定位 |
| `UserMessageComponent` | [user-message.ts:128](../../packages/tui/src/chat/user-message.ts:128) | 轮次识别 |
| `stripPromptZones` | [transcript-outline.ts:57](../../packages/tui/src/chat/transcript-outline.ts:57) | 清理 OSC 133 |
| `ScrollView` | [scroll-view.ts](../../packages/tui/src/components/scroll-view.ts) | 内容区滚动 |
| `routeSgrMouseInput` | [mouse.ts](../../packages/tui/src/mouse.ts) | 鼠标解析 |
| `sliceByColumn` | [utils.ts:752](../../packages/tui/src/utils.ts:752) | 选区切片 |
| `KEYBINDINGS` / `Keybindings` 接口 | [app-keybindings.ts:89](../../packages/tui/src/app-keybindings.ts:89) | 快捷键注册 |
| `SessionManager.listForPicker` / `sessionDisplayName` | [session-listing.ts](../../packages/coding-agent/src/session/session-listing.ts) | 会话列表 |
| `handleResumeSession` / `handleNewCommand` | [selector-controller.ts:1974](../../packages/coding-agent/src/modes/controllers/selector-controller.ts:1974) | 切换、新建会话 |
| `copyToClipboard` | [clipboard.ts:117](../../packages/coding-agent/src/utils/clipboard.ts:117) | 复制 |

---

## 附录 A：风险清单

| 风险 | 验证阶段 | 应对 |
|---|---|---|
| 外壳期间切换会话后，clearScrollback 没能和退出 alt screen 合并执行 | M1 | 外壳在切换会话前先临时关闭，切换后再打开 |
| 长会话每帧都重新拼接内容，渲染过慢 | M1 | 内容区缓存，或只渲染视口附近的子组件 |
| 非全屏覆盖层导致外壳闪烁 | M1 | 方案 (b) 改为方案 (a) |
| Tabby 或 Mac 不支持 OSC 52 | M0 | 使用 Shift/Option 原生选择，或关闭外壳后用原生选择 |
| 快捷键被终端或系统拦截 | M0 | 改用替代键，并写入本文档 |
| 内容区滚动时图片被截断 | M2 | 图片行改为 `[image]` 占位 |
| 任意移动上报（1003）在 SSH 下事件太多 | M3 | 悬停渲染节流；仍不理想时评估只上报拖动（1002，需改 tui） |

## 附录 B：多会话并行（暂不纳入）

现在的 `switchSession` 复用同一个 `AgentSession` 对象，所以切换前必须先中止正在运行的回合。上游已经有 `SessionFocusController`（[session-focus-controller.ts](../../packages/coding-agent/src/modes/controllers/session-focus-controller.ts)）、`AgentRegistry` 和 `/tan` 的后台会话机制，可以在此基础上做一个"主会话 + 并行访客会话"版本：

- 改动量中等，全部写在新文件里，不需要新增上游触点。
- 访客会话受上游聚焦视图的命令白名单限制：
  - 只能执行 `/btw /effort /export /jobs /model /switch /usage`；
  - 没有扩展 UI；
  - `ask` 走无界面模式。
- 多个会话共用同一个工作区，可能同时修改同一批文件。

本期不实施。需要时作为 M6 单独评估。
