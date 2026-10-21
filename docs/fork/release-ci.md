# fork 的构建发布与 omp 更新

本文说明 fork 如何自动跟进上游发布、构建并发布自己的 omp 二进制，以及本机 omp 怎样安装和更新到 fork 的构建。

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

只跟上游**稳定版发布 tag**（`vX.Y.Z`，不含 `-canary.*`），不跟上游 `main`，原因是：

- 版本号与 npm 上的预编译 native 插件一一对应，CI 不用编译 Rust；
- 发布版比 `main` 稳定。

## 2. 工作流做了什么

触发时机：

- 每 6 小时一次（`cron: 17 */6 * * *`，UTC）；
- 推送到 `custom`；
- 在 Actions 页面手动运行，或执行 `gh workflow run fork-release.yml -R Grosser-Kurfuerst/oh-my-pi --ref custom`。

同一时间只运行一个实例，后来的排队，不取消正在运行的。

| 步骤 | 内容 |
|---|---|
| Merge latest upstream release | 拉取上游 `v*` tag，取最新的稳定版。`custom` 已包含它就跳过；否则 `git merge --no-ff`，提交信息为 `chore(fork): merge upstream vX.Y.Z`，再普通 push 回 `custom`。冲突时撤销合并，并以 `::error::` 失败 |
| Resolve build id | 版本号取自 `packages/coding-agent/package.json`，release tag 为 `kf-v<版本>-<commit 前 8 位>`。这个 tag 已有 Release 时，后续步骤全部跳过 |
| 安装依赖、native 插件 | `bun install --frozen-lockfile`；从 npm 下载同版本的 `@oh-my-pi/pi-natives-linux-x64`，把 `baseline`、`modern` 两个 `.node` 放进 `packages/natives/native/` |
| Build binary | `RELEASE_TARGETS=linux-x64 bun run ci:release:build-binaries`，和上游 release 构建用同一个命令；产物运行 `--version` 做冒烟测试 |
| Publish GitHub release | 上传 `omp-linux-x64`，tag 指向本次构建的 commit，标记为 latest |
| Update build index | 计算大小和 sha256，写入 `build-index` 分支并 push |
| Prune old releases | 只保留最近 3 个 `kf-v*` Release，其余连同 tag 一起删除（每个约 250MB） |

先发 Release 再写索引，所以索引不会指向不存在的文件。每个 commit 都用唯一的 tag，所以索引和文件不会因为缓存而对不上。

CI 往 `custom` 推合并提交时会再触发一次运行。那次运行发现上游已合并、Release 已存在，就什么都不做。

## 3. 仓库配置（已完成，换机器或重建 fork 时参考）

1. **默认分支设为 `custom`**（Settings → General）。定时任务只会运行默认分支上的工作流文件。
2. **禁用上游的工作流**：`ci.yml`、`nix.yml`、`bun-cache-warm.yml` 依赖上游的自托管 runner，在 fork 里会一直排队。禁用是按工作流记住的，上游以后修改这些文件也保持禁用。
   ```bash
   gh workflow disable ci.yml -R Grosser-Kurfuerst/oh-my-pi
   ```
3. **Secret `FORK_SYNC_TOKEN`**：fine-grained PAT，只授权本仓库，需要以下权限：
   - **Contents: Read and write**：push、发 Release；
   - **Workflows: Read and write**：合并上游时，如果上游改了 `.github/workflows/`，没有这个权限会被拒绝推送。

   默认的 `GITHUB_TOKEN` 不能用：它没有推送工作流文件的权限，并且用它 push 不会触发后续的工作流。

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

如果 fork 构建的版本号不高于当前版本，需要加 `--force`。切换后，fork 版内置了索引地址，以后不需要再带 `PI_BUILD_URL`。

确认装的是 fork 的构建（版本号相同时，只看 `omp --version` 分辨不出官方版和 fork 版）：

```bash
sha256sum ~/.local/bin/omp
```

结果应该等于索引里的 `sha256`。也可以直接看 fork 的功能（工作台等）是否出现。

### 5.2 日常更新

| 场景 | 操作 |
|---|---|
| 上游发了新版 | CI 自动合并、构建、发布；omp 启动时照常提示更新（设置项 `startup.checkUpdate`），执行 `omp update` |
| 只改了 fork 自己的代码 | 版本号没变，omp 不会提示。等 Actions 运行完，执行 `omp update --force` |
| 查看是否有更新 | `omp update --check` |

注意：

- 不要切换到 canary 渠道（`omp update --canary`）。fork 只发布稳定版，索引不区分渠道。
- raw.githubusercontent 大约有 5 分钟缓存，刚发布的构建可能要过几分钟才能检测到。
- 每次更新都下载约 250MB 的完整文件，因为没有官方的增量补丁。
- 已经在运行的 omp 进程仍然是旧版本，需要重启。

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

## 6. 本地开发流程

本地需要先添加上游远程（只做一次）：

```bash
git remote add upstream https://github.com/can1357/oh-my-pi.git
```

1. 开始改代码前先 `git pull`。CI 可能已经推过上游的合并提交。忘了也没关系：push 会因为落后远程被拒绝，`git pull` 之后再 push 即可。
2. 改代码、提交、`git push`，CI 会自动构建发布。
3. 等运行完成，执行 `omp update --force`。

改造规则（代码放在 `src/fork/`、上游触点最小化、在 [README.md](README.md) 登记）见 [AGENTS.md](../../AGENTS.md) 的“Fork 改造”一节。

## 7. 维护与排障

### 7.1 合并上游冲突

现象：工作流在 `Merge latest upstream release` 失败，日志中有 `Merging vX.Y.Z conflicts`，GitHub 会发邮件通知。

处理：

```bash
git pull
```

```bash
git fetch upstream --tags
```

```bash
git merge vX.Y.Z
```

按 [README.md §3](README.md) 处理上游触点的冲突。`build-service.ts` 冲突时**必须保留 fork 的 `DEFAULT_BUILD_URL`**，否则 `omp update` 会装回官方版。然后按 [README.md §6](README.md) 的检查清单验证，提交后普通 `git push`，push 会触发构建。

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
| 安装 native 插件时下载 404 | 上游刚发布，npm 包还没上传；或者 `custom` 不在上游发布 tag 上 | 稍后手动重新运行；确认 `custom` 是从上游 `vX.Y.Z` 合并来的 |
| 定时任务不再运行 | 公开仓库 60 天没有活动时，GitHub 会停用定时任务 | 在 Actions 页面重新启用。上游发版频繁，`build-index` 会经常有提交，一般不会出现 |
| 构建报 native 版本戳不匹配 | fork 改了 `crates/` 或 `packages/natives`，npm 上的预编译插件对不上 | 需要在工作流里安装 Rust 工具链，用 `bun run build:native` 自行编译 |

### 7.4 限制

- 只构建 linux-x64（`linux-x86_64` / `omp-linux-x64`）。要支持其他平台，需要按 `resolveBuildHost` 的命名增加构建矩阵，并为每个平台写一份索引。
- fork 改动 Rust 代码时，不能使用 npm 上的预编译插件（见 §7.3）。
- `actions/checkout@v4` 有 Node.js 20 的弃用警告，不影响运行，以后可以升级。
