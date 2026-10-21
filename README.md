# build-index

本分支是 fork 版 omp 的静态「构建服务」，只存放索引 JSON，不含源码。

**`api/` 下的文件由 CI（`custom` 分支上的 `.github/workflows/fork-release.yml`）自动维护，不要手改。** 每次发布新构建，CI 追加一个 `chore(build-index): publish kf-v...` 提交；没有新构建时不会改动，也从不改写历史。维护方式见 `custom` 分支的 `docs/fork/release-ci.md`。

fork 版 omp 的 `DEFAULT_BUILD_URL` 指向：

```
https://raw.githubusercontent.com/Grosser-Kurfuerst/oh-my-pi/build-index
```

`omp update` 与启动时的更新检查会请求 `{origin}/api/products/omp/latest/{target}`（`?channel=` 参数会被 raw 忽略）。
bun/npm 全局安装被接管成独立二进制时，请求 `{origin}/api/products/omp/versions/{version}/{target}`。

## 目录结构

```
api/products/omp/latest/linux-x86_64             # 最新构建，每次发布都覆盖
api/products/omp/versions/<version>/linux-x86_64 # 该版本最后一次构建
```

目前只构建 `linux-x86_64`。`target` 的取值见 `packages/coding-agent/src/cli/build-service.ts` 的 `resolveBuildHost`。

## JSON 格式

```json
{
  "build": { "version": "18.12.5" },
  "file": { "name": "omp-linux-x64", "size": 256890848, "sha256": "<64 位小写 hex>" },
  "download": "https://github.com/Grosser-Kurfuerst/oh-my-pi/releases/download/kf-v18.12.5-9b12d84f/omp-linux-x64"
}
```

- Release tag 为 `kf-v<版本>-<commit 前 8 位>`，每个 commit 一个。
- `file.name` 必须与 `resolveBuildHost` 给出的文件名一致（linux x64 为 `omp-linux-x64`）。
- `size`、`sha256` 必须与下载文件完全一致，否则 omp 会拒绝安装。
- `download` 必须是 HTTPS。
- 不提供 `patch` 字段，omp 会下载完整文件。
- 只保留最近 3 个 Release，更早版本的 `versions/` 文件会指向已删除的下载地址。
