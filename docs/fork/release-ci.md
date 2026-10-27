# fork 的构建发布与 omp 更新

本文说明 fork 如何自动跟进上游发布、构建并发布自己的 omp 二进制，以及本机 omp 怎样安装和更新到 fork 的构建。

> 交给别人或 AI 维护时，先读 [§8 维护规则](#8-维护规则)。

## 1. 整体结构

```
can1357/oh-my-pi ──(定时拉取 v* 稳定版 tag)──▶ Grosser-Kurfuerst/oh-my-pi
                                              ├─ custom：上游 tag + fork 改造（merge，只追加不改写）
                                              ├─ Releases：kf-v<版本>-<commit>/omp-linux-x64
                                              └─ build-index：静态 JSON，冒充构建服务
本机 omp ──(DEFAULT_BUILD_URL 指向 build-index)──▶ omp update 安装 fork 的构建
```

- 工作流：[.github/workflows/fork-release.yml](../../.github/workflows/fork-release.yml)
- 构建服务客户端：[build-service.ts](../../packages/coding-agent/src/cli/build-service.ts)。`DEFAULT_BUILD_URL` 已改为 fork 的索引地址（上游触点见 [README.md §3](README.md)），环境变量 `PI_BUILD_URL` 仍可覆盖。
- 索引分支：`build-index`，孤儿分支，只有 `README.md` 和 `api/` 下的 JSON，不含源码。

只跟上游**已发到 npm 的稳定版发布 tag**（`vX.Y.Z`，不含 `-canary.*`），不跟上游 `main`，原因是：

- 版本号与 npm 上的预编译 native 插件一一对应，CI 不用编译 Rust；
- 发布版比 `main` 稳定。

## 2. 工作流做了什么

触发时机：

- 每 6 小时一次（`cron: 17 */6 * * *`，UTC）；
- 推送到 `custom`（包括只改文档的提交，每次 push 都会重新构建一次）；
- 在 Actions 页面手动运行，或执行 `gh workflow run fork-release.yml -R Grosser-Kurfuerst/oh-my-pi --ref custom`。

同一时间只运行一个实例，后来的排队，不取消正在运行的。

| 步骤 | 内容 |
|---|---|
| Merge latest upstream release | 拉取上游 `v*` tag，取最新的稳定版。`custom` 已包含它就跳过；npm 上还没有这个版本的 `pi-natives-linux-x64` 也跳过（输出 `::notice::`，照常构建当前的 `custom`）；否则 `git merge --no-ff`，提交信息为 `chore(fork): merge upstream vX.Y.Z`，再普通 push 回 `custom`。冲突时撤销合并，并以 `::error::` 失败 |
| Resolve build id | 按 §2.1 算出 fork 版本号，release tag 为 `kf-v<fork 版本>-<commit 前 8 位>`。这个 tag 已有 Release 时，后续步骤全部跳过 |
| 安装依赖、native 插件 | `bun install --frozen-lockfile`；按**上游版本号**从 npm 下载 `@oh-my-pi/pi-natives-linux-x64`，把 `baseline`、`modern` 两个 `.node` 放进 `packages/natives/native/` |
| Stamp fork version | 只在构建机上把 `packages/utils/package.json` 的 `version` 改成 fork 版本号，不提交 |
| Build binary | `RELEASE_TARGETS=linux-x64 bun run ci:release:build-binaries`，和上游 release 构建用同一个命令；产物的 `--version` 必须等于 `omp/<fork 版本>`，否则失败 |
| Publish GitHub release | 上传 `omp-linux-x64`，tag 指向本次构建的 commit，标记为 latest |
| Update build index | 计算大小和 sha256，写入 `build-index` 分支并 push |
| Prune old releases | 只保留最近 3 个 `kf-v*` Release，其余连同 tag 一起删除（每个约 250MB） |

先发 Release 再写索引，所以索引不会指向不存在的文件。每个 commit 都用唯一的 tag，所以索引和文件不会因为缓存而对不上。

CI 往 `custom` 推合并提交时会再触发一次运行。那次运行发现上游已合并、Release 已存在，就什么都不做。

某一步失败后不需要手动收拾：合并已经推上去的话，下一次运行会跳过合并，发现 Release 不存在，就重新构建。

### 2.1 版本号规则

| `custom` 的状态 | fork 版本号 | 例子（上游 `v18.12.5`） |
|---|---|---|
| 刚合并完上游 tag，之后没有 fork 提交 | 和上游相同 | `18.12.5` |
| 合并之后有 N 个 fork 提交 | 下一个 patch 加 `-kf.N` | `18.12.6-kf.3` |

- `kf` 是 fork 的标记（Kurfuerst），N 是上游合并提交之后，`custom` 第一父链上的提交数。`custom` 只追加，所以 N 只增不减。
- 比较顺序：`18.12.5` < `18.12.6-kf.1` < `18.12.6-kf.2` < 上游的 `18.12.6`。所以只改 fork 代码时 omp 也会正常提示更新；上游发了 `18.12.6` 后，合并出来的 `18.12.6` 又比所有 `18.12.6-kf.N` 高。
- 上游版本号取自 `packages/natives/package.json`。合并提交的判断依据是第二父提交正好是 `v<上游版本>` 这个 tag，所以 `custom` 必须通过合并上游 tag 来同步（§7.1）。

两个硬性约束，改工作流时不能破坏：

1. **二进制报告的版本必须等于索引里的版本。** omp 的 `VERSION` 只来自 `packages/utils/package.json`，构建时改的就是它；`Build binary` 会核对 `--version` 的输出。两者不一致时，omp 会一直提示有更新。
2. **native 插件的版本号不能改。** `packages/natives/package.json` 保持上游版本，npm 上的插件也按上游版本下载，因为 `embed-native.ts` 会核对插件里的版本戳。

版本号改动只发生在构建机上、不提交。如果提交到仓库，每次合并上游都会在 `version` 这一行冲突。仓库里各个 `package.json` 的版本号始终和上游一致，从源码运行时显示的也是上游版本。

## 3. 仓库配置（已完成，换机器或重建 fork 时参考）

1. **默认分支设为 `custom`**（Settings → General）。定时任务只会运行默认分支上的工作流文件。
2. **禁用上游的工作流**：`ci.yml`、`nix.yml`、`bun-cache-warm.yml` 依赖上游的自托管 runner，在 fork 里会一直排队。禁用是按工作流记住的，上游以后修改这些文件也保持禁用。
   ```bash
   gh workflow disable ci.yml -R Grosser-Kurfuerst/oh-my-pi
   ```
   上游以后**新增**的工作流文件合并进来后默认是启用的，见 [§7.1](#71-合并上游冲突) 的检查。
3. **Secret `FORK_SYNC_TOKEN`**：fine-grained PAT，只授权本仓库，需要以下权限：
   - **Contents: Read and write**：push、发 Release；
   - **Workflows: Read and write**：合并上游时，如果上游改了 `.github/workflows/`，没有这个权限会被拒绝推送。

   默认的 `GITHUB_TOKEN` 不能用：它没有推送工作流文件的权限，并且用它 push 不会触发后续的工作流。

   PAT 有到期时间，在创建它的账号下 Settings → Developer settings → Personal access tokens → Fine-grained tokens 查看，到期前重新生成并更新 Secret。Secret 只能覆盖，不能读出原值。
4. **失败通知**：定时运行失败的邮件只发给最后修改 `cron` 那一行的人（没人改过就是创建工作流的人）；push 触发的运行发给推送者，CI 自己推送的合并提交算作 PAT 所属账号。换人维护时，新维护者要自己留意 Actions 页面，或者在仓库 Watch 设置里订阅 Actions。

## 4. build-index 索引格式

omp 请求 `{origin}/api/products/omp/latest/{target}?channel=...`；安装指定版本时请求 `{origin}/api/products/omp/versions/{version}/{target}`。raw.githubusercontent 会忽略查询参数，所以 `channel` 不起作用。

```
api/products/omp/latest/linux-x86_64
api/products/omp/versions/<版本>/linux-x86_64
```

```json
{
  "build": { "version": "18.12.5" },
  "file": { "name": "omp-linux-x64", "size": 256890848, "sha256": "<64 位小写 hex>" },
  "download": "https://github.com/Grosser-Kurfuerst/oh-my-pi/releases/download/kf-v18.12.5-9b12d84f/omp-linux-x64"
}
```

校验规则见 `parseBuildAnswer`：

- `file.name` 必须等于 `resolveBuildHost` 给出的文件名；
- `size`、`sha256` 必须和文件完全一致；
- `download` 必须是 HTTPS。

不提供 `patch` 字段，omp 会下载完整文件。

这个分支**由 CI 维护**：每次发布新 Release，CI 追加一个 `chore(build-index): publish kf-v...` 提交，覆盖 `latest/`，并写入当前版本的 `versions/` 文件。没有新构建时不会改动，也从不改写历史。

- `latest/` 是独立二进制 `omp update` 和启动检查唯一读取的文件。
- `versions/` 只在 bun/npm 全局安装被接管成独立二进制时用到。每个 fork 版本号一个文件。旧版本的文件不会删除，Release 被清理后，这些文件会指向已经删除的下载地址。
- 本地的 `build-index` 分支不会自动更新，落后远程是正常的。要看最新内容就 `git fetch origin build-index`，然后看 `origin/build-index`。

检查当前索引：

```bash
curl -s https://raw.githubusercontent.com/Grosser-Kurfuerst/oh-my-pi/build-index/api/products/omp/latest/linux-x86_64
```

## 5. 本机 omp 的使用

### 5.1 首次从官方版切换到 fork 版

官方二进制同样读取 `PI_BUILD_URL`，用它把官方版换成 fork 的构建：

```bash
cp ~/.local/bin/omp ~/.local/bin/omp.official
```

```bash
PI_BUILD_URL=https://raw.githubusercontent.com/Grosser-Kurfuerst/oh-my-pi/build-index omp update --check
```

```bash
PI_BUILD_URL=https://raw.githubusercontent.com/Grosser-Kurfuerst/oh-my-pi/build-index omp update
```

如果 fork 构建的版本号不高于当前版本（例如两边都是 `18.12.5`），需要加 `--force`。切换后，fork 版内置了索引地址，以后不需要再带 `PI_BUILD_URL`。

确认装的是 fork 的构建（`omp --version` 带 `-kf.N` 的一定是 fork 版；和上游版本号相同时分辨不出，要看 sha256）：

```bash
sha256sum ~/.local/bin/omp
```

结果应该等于索引里的 `sha256`。也可以直接看 fork 的功能（工作台等）是否出现。

### 5.2 日常更新

| 场景 | 操作 |
|---|---|
| 上游发了新版 | CI 自动合并、构建、发布；omp 启动时照常提示更新（设置项 `startup.checkUpdate`），执行 `omp update` |
| 只改了 fork 自己的代码 | CI 发布 `-kf.N` 版本（§2.1），omp 照常提示，执行 `omp update` |
| 查看是否有更新 | `omp update --check` |

注意：

- 不要切换到 canary 渠道（`omp update --canary`）。fork 只发布稳定版，索引不区分渠道。
- raw.githubusercontent 大约有 5 分钟缓存，刚发布的构建可能要过几分钟才能检测到。
- 每次更新都下载约 250MB 的完整文件，因为没有官方的增量补丁。
- 已经在运行的 omp 进程仍然是旧版本，需要重启。
- 从源码目录运行的 omp 不会提示更新。

### 5.3 回退到官方版

用备份恢复：

```bash
cp ~/.local/bin/omp.official ~/.local/bin/omp
```

或者直接从官方构建服务安装最新的官方版：

```bash
PI_BUILD_URL=https://build.stencil.so omp update --force
```

官方版之后的 `omp update` 会回到官方的更新渠道。想再切回 fork 版，重复 5.1。

### 5.4 回退到 fork 的上一个构建

`omp update` 只能安装 `latest`，不能选旧构建。新构建有问题时，从 Releases 页面下载之前的构建（只保留最近 3 个），手动替换：

```bash
curl -fL -o ~/.local/bin/omp.new https://github.com/Grosser-Kurfuerst/oh-my-pi/releases/download/<旧的 kf-v tag>/omp-linux-x64
```

```bash
chmod +x ~/.local/bin/omp.new && mv ~/.local/bin/omp.new ~/.local/bin/omp
```

这只救本机，源头的修复见 [§7.6](#76-坏构建怎么处理)。

## 6. 本地开发流程

需要：仓库写权限；本地装好 bun（运行检查和测试）；可选装好 `gh` 并登录（看 CI 日志）。

本地需要先添加上游远程（只做一次）：

```bash
git remote add upstream https://github.com/can1357/oh-my-pi.git
```

1. 开始改代码前先 `git pull`。CI 可能已经推过上游的合并提交。忘了也没关系：push 会因为落后远程被拒绝，`git pull` 之后再 push 即可。
2. 改代码、提交、`git push`，CI 会自动构建发布。
3. 等运行完成，执行 `omp update`。

改造规则（代码放在 `src/fork/`、上游触点最小化、在 [README.md](README.md) 登记）见 [AGENTS.md](../../AGENTS.md) 的“Fork 改造”一节。

## 7. 维护与排障

### 7.1 合并上游冲突

现象：工作流在 `Merge latest upstream release` 失败，日志中有 `Merging vX.Y.Z conflicts`。

处理：

```bash
git pull
```

```bash
git fetch upstream --tags
```

```bash
git merge --no-ff -m "chore(fork): merge upstream vX.Y.Z" vX.Y.Z
```

提交信息和 CI 自动合并时保持一致。合并前先确认 npm 上已有 `@oh-my-pi/pi-natives-linux-x64` 的 `X.Y.Z` 版本，否则构建会在下载 native 插件时 404。解决冲突时：

- 按 [README.md §3](README.md) 处理上游触点的冲突。`build-service.ts` 冲突时**必须保留 fork 的 `DEFAULT_BUILD_URL`**，否则 `omp update` 会装回官方版。
- `bun.lock` 冲突时取上游的版本（`git checkout --theirs bun.lock`），再执行 `bun install` 确认没有变化。fork 没有加依赖，正常不会冲突。
- 检查上游有没有新增工作流文件，有的话 push 之后禁用（见 §3）：
  ```bash
  git diff --name-status --diff-filter=A HEAD vX.Y.Z -- .github/workflows/
  ```

然后按 [README.md §6](README.md) 的检查清单验证，提交后普通 `git push`，push 会触发构建。

CI 自动合并成功时，上游新增的工作流也会进来，同样要检查。看最近一次上游合并带进来的新工作流：

```bash
m=$(git log -1 --merges --grep='merge upstream' --format=%H origin/custom); git diff --name-status --diff-filter=A "$m^1" "$m" -- .github/workflows/
```

可以先执行 `git config rerere.enabled true`，让 git 记住冲突的解决方式，下次遇到同样的冲突自动套用。

### 7.2 查看失败原因

- 本机装好 `gh` 并登录后：
  ```bash
  gh run list -R Grosser-Kurfuerst/oh-my-pi
  ```
  ```bash
  gh run view --log-failed -R Grosser-Kurfuerst/oh-my-pi
  ```
- 没有登录凭据时，日志接口返回 403。可以用公开接口查看失败步骤和注解：`/repos/Grosser-Kurfuerst/oh-my-pi/actions/runs/<run_id>/jobs` 看哪一步失败，`/repos/Grosser-Kurfuerst/oh-my-pi/check-runs/<job_id>/annotations` 看报错和退出码。

### 7.3 已知问题与原因

| 现象 | 原因 | 处理 |
|---|---|---|
| 同步步骤 `exit code 2`，没有 `::error::` | `head` 提前关闭管道，runner 忽略 SIGPIPE，`grep` 报 Broken pipe，加上 `pipefail` 后整步失败 | 已改用 `awk` 读完全部输入。以后在 `pipefail` 下不要用 `\| head` 截断大输出 |
| `Publish GitHub release` 失败，fork 没有 Release | 添加 `upstream` 远程后，`gh` 默认操作上游仓库 | 已在 job 环境变量加 `GH_REPO: ${{ github.repository }}`，所有 `gh` 命令都指向 fork |
| checkout 失败或推送 403 | `FORK_SYNC_TOKEN` 过期或权限不足 | 重新生成 PAT（权限见 §3），更新 Secret |
| 推送时提示需要 `workflow` 权限 | 上游改了 `.github/workflows/`，PAT 缺少 Workflows 权限 | 给 PAT 加上 Workflows: Read and write |
| 同步步骤出现 `vX.Y.Z is tagged but its natives are not on npm yet` | 上游先推 tag，CI 测试全部通过后才发 npm；测试失败或还在跑时，npm 上没有这个版本 | 不用管，这次运行照常构建当前的 `custom`。上游发到 npm 后，下一次运行会合并；上游放弃这个版本、直接发下一个，也会自动跟上 |
| 安装 native 插件时下载 404 | `packages/natives/package.json` 的版本号被改过；或者手动合并了一个还没发到 npm 的上游 tag | 前一种恢复成上游的版本号；后一种等上游发到 npm 后重新运行。不要 revert 合并提交，以后再合并同一版本会出问题 |
| `Resolve build id` 报 `No merge of vX.Y.Z found` | `custom` 不是通过合并上游 tag `vX.Y.Z` 同步的（比如合并了上游 `main`，或者用了 rebase） | 按 §7.1 合并上游 tag |
| `Build binary` 报 `Binary reports ..., expected ...` | 二进制的版本和 fork 版本号不一致，通常是 `Stamp fork version` 被改坏，或者 `VERSION` 不再来自 `packages/utils/package.json` | 查看 `packages/utils/src/dirs.ts` 中 `VERSION` 的来源，相应调整 `Stamp fork version` |
| Actions 里有上游的工作流一直排队或失败 | 上游新增了工作流文件，合并进来后默认启用 | 用 `gh workflow disable` 禁用，见 §3 |
| 定时任务不再运行 | 公开仓库 60 天没有活动时，GitHub 会停用定时任务 | 在 Actions 页面重新启用。上游发版频繁，`build-index` 会经常有提交，一般不会出现 |
| 构建报 native 版本戳不匹配 | fork 改了 `crates/` 或 `packages/natives`，npm 上的预编译插件对不上 | 需要在工作流里安装 Rust 工具链，用 `bun run build:native` 自行编译 |

### 7.4 限制

- 只构建 linux-x64（`linux-x86_64` / `omp-linux-x64`）。要支持其他平台，需要按 `resolveBuildHost` 的命名增加构建矩阵，并为每个平台写一份索引。
- fork 改动 Rust 代码时，不能使用 npm 上的预编译插件（见 §7.3）。
- 只保留最近 3 个 Release，更早的构建无法回退（见 §4 关于 `versions/` 的说明）。
- `actions/checkout@v4` 有 Node.js 20 的弃用警告，不影响运行，以后可以升级。

### 7.5 健康检查

确认整条链路正常：

1. 最近一次运行成功：
   ```bash
   gh run list -R Grosser-Kurfuerst/oh-my-pi -w fork-release.yml -L 5
   ```
2. 索引指向 `custom` 的最新提交：用 [§4](#4-build-index-索引格式) 的命令取出 `download`，其中 tag 的最后 8 位应该等于下面命令的输出（刚 push、构建还没跑完时会落后一个提交）：
   ```bash
   git fetch origin && git rev-parse --short=8 origin/custom
   ```
3. 下载地址可用，返回 `200`：
   ```bash
   curl -sIL -o /dev/null -w '%{http_code}\n' <download 地址>
   ```
4. 本机装的就是索引里的构建：`sha256sum ~/.local/bin/omp` 等于索引里的 `sha256`。

### 7.6 坏构建怎么处理

构建能通过冒烟测试，但运行有问题时：

1. 本机先按 [§5.4](#54-回退到-fork-的上一个构建) 换回上一个构建。
2. 在 `custom` 上修复，或者 `git revert` 出问题的提交，普通 `git push`。CI 会用新提交构建，覆盖 `latest`。
3. 运行完成后，执行 `omp update`。新提交的版本号更高，会正常更新。

不要用手改索引的方式回退（见 §8）。

### 7.7 修改工作流

- 工作流文件只在 `custom` 上，上游没有这个文件，不会冲突。
- 改完推到 `custom` 就会触发一次运行，这次运行就是测试；只想重跑时用手动运行。
- 保留 job 环境变量里的 `GH_REPO`，否则 `gh` 会去操作上游仓库。
- `set -o pipefail` 下不要用 `| head` 之类提前关闭管道的写法（见 §7.3）。
- 改动 `BUILD_TARGET`、`BINARY_NAME` 前先对照 `resolveBuildHost`，名字对不上 omp 会拒绝安装。
- 不要破坏 §2.1 的两个硬性约束。版本号计算可以在本地检出的 `custom` 上单独运行 `Resolve build id` 里的脚本来验证（去掉 `gh` 和 `GITHUB_OUTPUT` 两部分）。

## 8. 维护规则

不要做：

- **不要 force push `custom` 或 `build-index`。** 两个分支都只追加不改写，CI 和本地都依赖普通 push/pull。
- **不要合并上游的 `main` 或 canary tag。** 只合并稳定版 tag `vX.Y.Z`，否则版本号和 npm 上的 native 插件对不上，fork 版本号也算不出来，构建失败。
- **不要提交任何 `package.json` 的版本号改动。** fork 版本号只在构建机上生成（§2.1）；`packages/natives/package.json` 尤其不能改。
- **不要手改 `build-index` 下 `api/` 里的 JSON。** `size`、`sha256` 对不上时 omp 会拒绝安装；手改的内容也会在下一次发布时被覆盖。README 等说明文件可以改。
- **不要把本地的 `build-index` 分支直接 push。** 它通常落后远程，要改说明文件时，先 `git fetch origin build-index`，基于 `origin/build-index` 修改。
- **不要改掉或丢掉 fork 的 `DEFAULT_BUILD_URL`**（合并冲突时尤其注意）。
- **不要把构建产物提交进仓库**（`packages/coding-agent/binaries/`、`packages/natives/native/*.node`）。
- **不要删掉工作流里的 `GH_REPO`**，不要换回默认的 `GITHUB_TOKEN`（原因见 §3）。

要做：

- 每次合并上游后，检查有没有新增的上游工作流（§7.1）。
- 改了上游文件就在 [README.md §3](README.md) 登记触点。
- PAT 到期前更新 Secret（§3）。
