# omp fork 改造说明

本目录记录这个 fork（`Grosser-Kurfuerst/oh-my-pi`，`custom` 分支）对上游 omp 的改造。`custom` 跟随上游的稳定版发布 tag，由 CI 自动合并，当前基于上游 `v18.12.5`。

| 文档 | 内容 |
|---|---|
| 本文 | fork 版的使用方法、改造点总览、上游触点、同步上游时可能冲突的地方 |
| [workbench-plan.md](workbench-plan.md) | 全屏工作台的完整方案与迭代记录 |
| [release-ci.md](release-ci.md) | 同步上游与构建发布的 CI 维护、本机 omp 的安装与更新 |

## 0. 使用 fork 版 omp

fork 版只提供 linux-x64 的独立二进制，由 CI 自动构建，发布在本仓库的 Releases。

**新机器直接安装**：

```bash
curl -fL -o ~/.local/bin/omp https://github.com/Grosser-Kurfuerst/oh-my-pi/releases/latest/download/omp-linux-x64
```

```bash
chmod +x ~/.local/bin/omp
```

**已装官方版时切换**（先备份官方版，方便回退）：

```bash
cp ~/.local/bin/omp ~/.local/bin/omp.official
```

```bash
PI_BUILD_URL=https://raw.githubusercontent.com/Grosser-Kurfuerst/oh-my-pi/build-index omp update
```

提示 `Already up to date` 时加 `--force`。装好后 fork 版内置了更新地址，以后不需要 `PI_BUILD_URL`。

**日常更新**：和官方版一样，启动时会提示有新版，执行 `omp update`。上游发新版和 fork 自己改代码都会发布更高的版本号；只改 fork 代码的构建版本号形如 `18.12.6-kf.3`（规则见 [release-ci.md §2.1](release-ci.md)）。刚发布的构建可能要几分钟后才检测得到。

**确认装的是 fork 版**：`omp --version` 带 `-kf.N` 的一定是 fork 版；版本号和上游相同时，比对 `sha256sum ~/.local/bin/omp` 和[索引](https://raw.githubusercontent.com/Grosser-Kurfuerst/oh-my-pi/build-index/api/products/omp/latest/linux-x86_64)里的 `sha256`。

**回退**：

- 回到官方版：`cp ~/.local/bin/omp.official ~/.local/bin/omp`，或者执行 `PI_BUILD_URL=https://build.stencil.so omp update --force`。
- 回到 fork 的上一个构建：见 [release-ci.md §5.4](release-ci.md)。

注意：

- 不要用 `omp update --canary`，fork 只发布稳定版。
- 更新后要重启正在运行的 omp。
- 从源码目录运行的 omp 不会提示更新。

## 1. 改造点

### 1.1 全屏工作台

常驻的全屏覆盖层（`WorkbenchShell`），启动第一帧即打开，`ctrl+n` 隐藏或重新打开。

- **M1 外壳骨架**：对话内容在上方滚动，编辑器和状态行固定在底部；鼠标滚轮滚动内容区。
- **M2 轮次跳转**：右侧导航条，`ctrl+up` / `ctrl+down` 跳到上一个或下一个提问；内容区下方有未读行时显示"下方还有 N 行 点击回到底部"。
- **M3 鼠标选择与复制**：拖选文字，松开后复制到剪贴板。
- **M3 之后**：默认打开、移除阅读模式、启动预绘制时就进入全屏，鼠标上报在切到 raw 输入时打开。
- **M4 会话侧边栏**：左侧列出当前项目的会话，单击或回车切换，`/` 过滤，`n` 新建；当前回合运行中切换要二次确认。窄于 100 列时自动收起，`f2` 聚焦、收起或展开。启动第一帧就从缓存画出列表。
- **M5 收尾**：设置项 `fork.workbench.enabled`（总开关）、`fork.workbench.autoOpen`（启动即进入），下次启动生效；`/hotkeys` 增加 Workbench 分组。

### 1.2 自动更新指向 fork 的构建

`omp update` 默认从本 fork `build-index` 分支上的静态构建索引安装，而不是上游的 `build.stencil.so`。仍可用 `PI_BUILD_URL` 覆盖。构建由 [fork-release.yml](../../.github/workflows/fork-release.yml) 自动发布，维护和使用方式见 [release-ci.md](release-ci.md)。

## 2. 代码布局

fork 自有代码都放在 `fork/` 目录，和上游零冲突：

- [packages/tui/src/fork/](../../packages/tui/src/fork/)：快捷键表、`/hotkeys` 分组、外壳及其纯函数模块（布局、轮次索引、导航条、选区）、会话侧边栏；`workbench/index.ts` 顶部有上游 API 依赖清单
- [packages/coding-agent/src/fork/](../../packages/coding-agent/src/fork/)：`installWorkbench`（装配到 InteractiveMode，提供会话列表与切换、读取设置）、`workbench-startup.ts`（预绘制时打开、安装时交接、启动缓存）、`workbench-settings.ts`（设置项）
- 测试：`packages/tui/test/fork-workbench-*.test.ts`、`packages/coding-agent/test/fork-workbench.test.ts`

## 3. 上游触点

改动上游文件的地方。"近 30 天"是上游 `main` 上该文件的提交数，越高越容易冲突。

| # | 位置 | 改动 | 近 30 天 | 冲突风险 | 丢失后的表现 / 守护 |
|---|---|---|---|---|---|
| ① | [main.ts:703](../../packages/coding-agent/src/main.ts:703) | setup wizard 之后调用 `installWorkbench(mode)`，+1 import | 71 | 中：`runInteractiveMode` 改动频繁，重构后要重新找"`init()` 和首启向导之后"的位置 | 启动外壳不会被接管，只剩编辑器、看不到对话。**没有测试守护**，同步后要手动启动确认 |
| ② | [app-keybindings.ts:92](../../packages/tui/src/app-keybindings.ts:92) | `KEYBINDINGS` 展开 `...FORK_KEYBINDINGS`，+1 import | 8 | 低 | 工作台快捷键全部失效；外壳测试会失败（测试用的 `KeybindingsManager` 基于完整的 `KEYBINDINGS` 表） |
| ⑤ | [startup-composer.ts:89](../../packages/coding-agent/src/modes/startup-composer.ts:89) | `composer.start(...)` 之前调用 `openStartupWorkbench(composer, cwd)`，+1 import | 5 | 低 | 启动先显示约 1 秒内联界面再切全屏；`fork-workbench.test.ts` 启动用例会失败。挪到 `start` 之后也会失败 |
| ③ | [all-settings.ts](../../packages/coding-agent/src/config/all-settings.ts) | `DOMAINS` 末尾加 `forkWorkbenchSettings`，+1 import | 6 | 低 | 设置面板和 `omp config` 里看不到这两项；配置文件里的值仍然生效（`fork/workbench.ts` 直接 import 了设置模块）。**没有测试守护**，同步后用 `omp config list \| grep workbench` 确认 |
| ⑥ | [tui.ts:1164](../../packages/tui/src/tui.ts:1164) | 新增只读 getter `inputDeferred` | 67 | 低：纯新增，只有上游改到相邻的 getter 才会冲突 | 上游改名或删掉 `#inputDeferred` 时 `bun run check` 报错 |
| ⑦ | [hotkeys-markdown.ts](../../packages/tui/src/hotkeys-markdown.ts) | `hotkeyGroups` 返回前追加 `forkHotkeyGroup(...)`，+1 import | 5 | 低 | `/hotkeys` 不再列出工作台快捷键；`fork-workbench-hotkeys.test.ts` 会失败 |
| — | [AGENTS.md](../../AGENTS.md) | 末尾加"Fork 改造"一节：少与上游冲突、改造要记进本文 | 3 | 低：加在文件末尾，上游改其他章节不会冲突 | agent 不再知道 fork 的改造规则 |
| — | [build-service.ts:49](../../packages/coding-agent/src/cli/build-service.ts:49) | `DEFAULT_BUILD_URL` 改为 fork 构建索引；测试改为引用该常量 | 1 | 低 | 冲突时**必须保留 fork 的地址**，否则 `omp update` 会装回上游版本 |

还改了一个上游测试：[issue-9597-cold-launch-double-clear.test.ts:128](../../packages/coding-agent/test/issue-9597-cold-launch-double-clear.test.ts:128)（近 30 天 4 次）。它检查冷启动只清屏一次；工作台打开期间清屏被推迟，所以断言前先关闭启动外壳（带 `Fork:` 注释）。上游改这个测试时会冲突，保留这几行即可。

方案里预留、尚未实施的触点：④ `tui.ts` 的 `wantAlt` 判断（非全屏弹窗叠在外壳上时的闪烁，目前未处理）。编号沿用 [workbench-plan.md §4.2](workbench-plan.md)。

## 4. 不冲突但可能悄悄失效的依赖

以下上游行为没有文本冲突，但上游一改，外壳就可能出错。完整清单见 [workbench-plan.md §11](workbench-plan.md)，最容易出问题的是：

- **渲染树结构**：外壳只读 `ui.children`，不改动它：用 `instanceof TranscriptContainer` 找到对话区，之前的根节点并入内容区，之后的固定在底部。根节点由 InteractiveMode 的 `setRuntimeChildren` 挂载，上游调整顺序或给对话区再包一层，布局就会错乱。
- **覆盖层与 alt screen**：TUI 只看最顶层覆盖层是否 `fullscreen`，并且每帧重读它的 `mouseTracking`。外壳打开期间清屏会被推迟到退出 alt screen 时执行。
- **输入路由**：外壳的输入监听器排在上游监听器之前；上游的 `ctrl+o`、`ctrl+t` 等在有覆盖层时让出按键，由外壳代为执行。上游改变这种让出行为，这些按键可能失效或被执行两次。
- **对话组件**：`TranscriptContainer` 的 `blockStates`、对话块的 `setTranscriptAllocation`、`UserMessageComponent` 等提问组件（轮次识别）、`stripPromptZones`。
- **启动预绘制**：`beginStartupComposer` 的 `deferInput` 启动、`enableInput()` 的调用时机、`ComposerLease.adopt()`。
- **会话侧边栏**：`SessionManager.listForPicker`、`sessionDisplayName`、`rankSessionSearchMatches`，以及 InteractiveMode 的 `handleResumeSession`、`handleNewCommand`、`session.isStreaming`。签名变化 `bun run check` 能发现；行为变化（例如切换时不再中止当前回合）发现不了。

## 5. 与上游的行为差异

- 启动第一帧就是全屏工作台；`ctrl+n` 可回到上游的内联界面。`fork.workbench.autoOpen: false` 启动停在内联界面，`fork.workbench.enabled: false` 完全不装工作台（都是下次启动生效）。
- 侧边栏的会话列表按项目缓存在同目录的 `workbench-sessions/`，启动第一帧就画出来（先按新会话显示），接管后换成实时列表。
- 侧边栏显示会话名时去掉 emoji 变体选择符 `U+FE0F`：`🛰️` 这类默认文字样式的图标带上它会被算成 2 列，不少终端只占 1 列，整行右侧会错位。代价是图标在严格按规范显示的终端里可能变成单色。
- 预绘制早于设置加载，是否打开取自 `composer.db` 同目录的 `workbench.json`（默认 `~/.omp/agent/cache/`）。在 `/settings` 里改会立即回写；用 `omp config set` 或手动编辑配置文件改后的第一次启动可能先全屏再退回，之后正常。项目级设置不同的两个项目交替启动时每次都会这样。
- 工作台一直开到退出时，启动时的清屏不会执行，终端保留打开 omp 之前的回滚内容（和 vim、less 一样）。
- 进入全屏到切到 raw 输入之间约 0.4 秒，滚轮在部分终端会变成方向键。
- 工作台打开时不能用终端原生搜索和选择（Tabby 按住 Shift、Mac 按住 Option 可绕过）。
- `omp update` 安装 fork 的构建。只改 fork 代码的构建版本号为 `<下一个 patch>-kf.N`（如 `18.12.6-kf.3`），`omp --version` 也显示这个，规则见 [release-ci.md §2.1](release-ci.md)。

## 6. 同步上游检查清单

1. CI 自动合并上游的稳定版 tag。合并冲突时在本地合并，按第 3 节处理触点冲突（流程见 [release-ci.md §7.1](release-ci.md)）。
2. 在 `packages/tui` 和 `packages/coding-agent` 下分别运行 `bun run check`。
3. 运行 fork 相关测试：
   - `packages/tui`：`bun test test/fork-workbench`
   - `packages/coding-agent`：`bun test test/fork-workbench.test.ts test/issue-9597-cold-launch-double-clear.test.ts test/startup-composer test/cli/build-service.test.ts`
4. 手动启动 omp，确认：
   - 第一帧就是全屏，能看到对话内容（触点 ① 没有测试守护）；
   - 滚轮能滚动，`ctrl+n` 能切换；
   - 宽终端左侧有会话列表，单击能切换会话；
   - 退出后终端恢复正常。
5. 第 4 节的依赖如有变化，对照 [workbench-plan.md §11](workbench-plan.md) 修复。
