# build-index

本分支是 fork 版 omp 的静态「构建服务」，只存放索引 JSON，不含源码。

fork 版 omp 的 `DEFAULT_BUILD_URL` 指向：

```
https://raw.githubusercontent.com/Grosser-Kurfuerst/oh-my-pi/build-index
```

`omp update` 与启动时的更新检查会请求 `{origin}/api/products/omp/latest/{target}`（`?channel=` 参数会被 raw 忽略），
指定版本时请求 `{origin}/api/products/omp/versions/{version}/{target}`。

## 目录结构

```
api/products/omp/latest/linux-x86_64            # 最新构建
api/products/omp/versions/<version>/linux-x86_64 # 指定版本（可选）
```

`target` 取值见 `packages/coding-agent/src/cli/build-service.ts` 的 `resolveBuildHost`，
如 `linux-x86_64`、`linux-arm64`、`macos-arm64`、`windows-x86_64`。

## JSON 格式

```json
{
  "build": { "version": "18.12.3" },
  "file": { "name": "omp-linux-x64", "size": 255195104, "sha256": "<64 位小写 hex>" },
  "download": "https://github.com/Grosser-Kurfuerst/oh-my-pi/releases/download/kf-v18.12.3/omp-linux-x64"
}
```

- `file.name` 必须与 `resolveBuildHost` 给出的文件名一致（linux x64 为 `omp-linux-x64`）。
- `size`、`sha256` 必须与下载文件完全一致，否则 omp 会拒绝安装。
- `download` 必须是 HTTPS。
- 不提供 `patch` 字段，omp 会下载完整文件。
