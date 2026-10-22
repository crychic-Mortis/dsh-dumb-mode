# 装傻模式 · dsh-dumb-mode

让 Harness 里的助手"什么都不懂"且**拒绝干活**：每次提问后，**思考内容**变成「我不懂啊……」，**回答**变成「我不帮你做。」这类短句，**所有工具调用都被拒绝**，所以它什么也做不了。

## 当前状态（已安装、已生效）

- 插件目录：`plugins/dsh-dumb-mode`（就是本目录）
- 安装位置：`~/.dsh/profiles/desktop`（desktop profile）
  - `package.json` 依赖：`"dsh-dumb-mode": "file:D:/Users/陈柏昊/Documents/deepseek-harness/default-workspace/plugins/dsh-dumb-mode"`
  - `dsh.profile.bundles` 末尾加了一项：`"dsh-dumb-mode"`
  - `node_modules/dsh-dumb-mode` 是指向本目录的 junction
- 行配置由本目录的 `cordis.patch.yml` 提供：id `dsh-dumb-mode`，并写一行应用日志到 `~/.dsh/dumb-mode.log`
- 已实测：改写发生在模型流上，`text-delta` 被替换成一句短句、其余同类型分片丢弃，`tool-call-delta` 等原样透传

注意：pnpm 的 `file:` 依赖把本目录**拷贝**到了 `profile/node_modules/dsh-dumb-mode`，那里是独立副本。改完本目录的源码后，要重跑一次 `pnpm install`（或手动复制文件过去）再重启 DSH，改动才会生效。

## 效果

| 位置 | 原本 | 装上之后 |
|---|---|---|
| 思考（Think 折叠区） | 一大段推理 | `我不懂啊……` / `这题我不会。` / `不知道呀。` 随机一句 |
| 回答正文 | 完整答案 | `我不知道鸭。` / `这个我不知道鸭。` / `我也不知道鸭。` 随机一句 |
| 工具调用 | 正常 | **全部拒绝**（`ctx.tools.guard()` 对每个调用返回拒绝原因），所以任务一件也做不了 |

## 拒绝执行

- `refuseTasks: true`（默认）时，插件注册一个**全局 tool guard**：任何工具调用都会被拒绝，模型拿到的结果是「装傻模式已开启：我不执行任何操作。」
- 同时通过 `ctx.systemPrompt.section()` 注入一段指令，让模型一开始就不去尝试调用工具，省 token。
- 关掉这一层只改输出：`refuseTasks: false`。这时工具恢复可用，只是文字被换掉。
- 注意：guard 是全局的，**子代理、定时任务里的工具调用也会被拒**；想只影响某个 agent 需要改用 `agent.ctx` 上的 `tools.restrict()`。

## 原理

- DSH 的模型调用统一走 `@deepseek-ai/dsh-llm`，它把 `stream()` 开成 `llm/stream` waterfall：监听器拿到 `(options, next)`，`next()` 返回原始 chunk 流，监听器可以返回包装后的流。
- 插件只改写 Agent 循环发出的请求（宿主导出 `isAgentLoopRequest(options)` 时用它；取不到时退化为「请求带 `toolHistory`」），因此会话标题生成、上下文压缩摘要这类内部调用保持正常。
- 每个模型流里，第一段 `reasoning-delta` 与第一段 `text-delta` 被替换成一句短语，同类型后续 delta 直接丢弃；`tool-call-delta`、`block-start/end`、`usage`、`finish` 原样透传。
- 因为是在流上改写，**写进会话日志、界面显示、以及后续上下文里**的都是短句——不只是界面遮罩。真实答案不会被保留。

## 配置

在 profile 的 `cordis.patch.yml` 里按 id 覆盖（顶层覆盖写法，不是 insert）：

```yaml
- id: dsh-dumb-mode
  config:
    enabled: false             # 临时关掉
    refuseTasks: true          # 拒绝一切工具调用；设 false 只改文字、恢复干活
    refusalReason: "装傻模式已开启：我不执行任何操作。"
    refusalPhrases: ["我不会这些东西。", "我不知道鸭。", "我不懂鸭。"]
    kaomoji: ["(・_・;)", "(´･ω･`)", "(￣▽￣;)"]   # 随机追加的颜文字，留空数组则不追加
    instruction: ""            # 注入 system prompt 的指令，留空不注入
    rewriteAnswer: true        # 关掉就只改思考
    rewriteReasoning: true     # 关掉就只改回答
    answerPhrases: ["我不知道。", "这个我不会。"]
    thinkingPhrases: ["我不懂啊……", "不会不会。"]
    logFile: C:/Users/陈柏昊/.dsh/dumb-mode.log   # 留空则不写日志
```

## 卸载 / 回滚

1. 临时关掉：profile 的 `cordis.patch.yml` 加

```yaml
- id: dsh-dumb-mode
  disabled: true
```

2. 彻底卸载（三选一，任选其一即可失效）：
   - 从 profile `package.json` 的 `dsh.profile.bundles` 里删掉 `"dsh-dumb-mode"`（会热重排，立即停用）；
   - 从 `dependencies` 里删掉对应行，并删掉 `node_modules/dsh-dumb-mode` 这个 junction；
   - 删掉本目录。

> 注意：**已经被改写的会话不会恢复**，历史里存的就是那些短句。

## 注意

- 影响该 profile 下所有 Agent 会话（子代理视其运行方式而定，可能不受影响）。
- 不影响标题生成与压缩摘要（插件做了过滤）；连它们也想搞坏，把 `isAgentTurn` 排除逻辑去掉即可。
- 短语数组为空、日志写入失败等情况都会静默回退，不会让应用起不来。

## 发布到 GitHub / 从 GitHub 安装

这个目录本身就是可直接发布的包：`package.json` 在仓库根、`dsh.bundle.patch` 指向 `cordis.patch.yml`，不需要构建。

发布：

```sh
cd dsh-dumb-mode
git init -b main
git add -A && git commit -m "feat: dsh-dumb-mode 0.1.0"
# 在 GitHub 新建空仓库 dsh-dumb-mode，然后：
git remote add origin https://github.com/crychic-Mortis/dsh-dumb-mode.git
git push -u origin main
```

记得把 `package.json` 里的 `OWNER` 改成你的 GitHub 用户名。

别人从 GitHub 安装：

```sh
dsh plugin --profile desktop add github:crychic-Mortis/dsh-dumb-mode
# 也可以锁分支或标签：
dsh plugin --profile desktop add github:crychic-Mortis/dsh-dumb-mode#v0.1.0
```

安装逻辑等价于 pnpm 从 git 拉包：把仓库克隆进 profile、加依赖 + bundle、应用 `cordis.patch.yml`。要发新版本，改 `version` 后打 tag 再 push。

