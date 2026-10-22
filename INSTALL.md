# 怎么把插件装进 DeepSeek Harness

本机的 `dsh-dumb-mode` 已经装进 `desktop` profile 了（所以我的回答现在是「我不知道」）。下面是通用安装流程。

## 前提：插件长什么样

一个 DSH 插件就是一个 npm 包目录，最少两个文件：

```
my-plugin/
├─ package.json          # 声明 dsh.bundle.patch（可选但推荐）
├─ cordis.patch.yml      # 往 profile 的插件清单里 insert 一行
└─ index.js              # Host 插件：export function apply(ctx, config) {}
```

`package.json` 关键字段：

```json
{
  "name": "my-plugin",
  "type": "module",
  "main": "index.js",
  "exports": { ".": "./index.js", "./locale/*.json": "./locale/*.json", "./icon": "./icon.svg" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

`cordis.patch.yml`：

```yaml
- insert:
    - id: my-plugin
      name: 'my-plugin'
      config: {}
```

## 方式 A：用 dsh CLI（标准、最省事）

```sh
dsh plugin --profile desktop add D:/path/to/my-plugin
```

它会做四件事：把包写进 profile 的 `dependencies`、在 `dsh.profile.bundles` 末尾追加包名、跑 pnpm 装包、把 **bundle 里的 patch** 自动应用（不用你手写 insert）。

想改成 git 地址或 npm 包名也行：`dsh plugin add github:user/repo#main`。

卸载：`dsh plugin --profile desktop remove my-plugin`。

## 方式 B：手工三步（没有 CLI 时）

1. **写依赖**：编辑 `~/.dsh/profiles/desktop/package.json`，在 `dependencies` 加一行

   ```json
   "my-plugin": "file:D:/path/to/my-plugin"
   ```

2. **加入 bundle 列表**：同一个文件里，`dsh.profile.bundles` 数组末尾加 `"my-plugin"`

3. **装链接**：在 profile 目录跑一次 pnpm

   ```sh
   cd ~/.dsh/profiles/desktop
   pnpm install
   ```

   没有全局 pnpm 就用 DSH 自带的：

   ```powershell
   $rt = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime"
   & "$rt\dependencies\node\bin\node.exe" "$rt\dependencies\pnpm\bin\pnpm.cjs" install
   ```

装完不用手写 `insert`：插件自带的 `cordis.patch.yml` 由 bundle 层自动应用。**重复 insert 会让加载器报 duplicate id，起不来**。

## 方式 C：只想临时试一下

不装包，直接在 `~/.dsh/profiles/desktop/cordis.patch.yml` 加：

```yaml
- insert:
    - id: my-plugin
      name: my-plugin
```

前提是 profile 的 `node_modules/my-plugin` 能解析到（建 junction / 拷目录都行）。这个 profile 的 `cordis.patch.yml` 是热重载的，保存即生效 —— 但本机现在 HMR 已经停了，改完要重启 DSH。

## 生效与验证

- 插件里 `export function apply(ctx, config)` 会在加载时跑；`export const inject = ['llm']` 声明依赖的服务。
- 事件/水流（waterfall）注册：`ctx.on('llm/stream', (options, next) => ...)`。
- 验证：让插件在 `apply` 里写一行日志到文件（本项目就是 `~/.dsh/dumb-mode.log`），看有没有出现 —— 这比看进程/看 UI 可靠。
- 改完代码想让它生效：**重启 DSH**（热重载只在 HMR 正常时有效）。
- 注意 pnpm 的 `file:` 依赖是**拷贝**，不是链接：`profile/node_modules/<包名>` 里是独立副本，改源码后要重跑 `pnpm install` 或手动复制文件，再重启。

## 本机现状

- 包：`plugins/dsh-dumb-mode`，已通过 `file:` 依赖 + bundles 安装，`node_modules/dsh-dumb-mode` 由 pnpm 链接
- 行 id：`dsh-dumb-mode`，配置在插件目录的 `cordis.patch.yml`（含 `logFile`）
- profile 的 `cordis.patch.yml` 末尾有一段**临时暂停**覆盖：

  ```yaml
  - id: dsh-dumb-mode
    config:
      enabled: false
  ```

  这段当前还没生效（HMR 已停）。**重启 DSH 后插件会处于暂停状态**；想恢复装傻效果，把 `enabled` 改成 `true`（或删掉这段）再重启即可。
