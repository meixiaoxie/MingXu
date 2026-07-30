# MingXu 开发路线图

这份文件只记录当前真实状态，不把未完成的能力写成已完成。

## 当前版本状态

| 阶段 | 主题 | 状态 | 说明 |
| --- | --- | --- | --- |
| 0 | 基线和文档 | 已完成 | ADR、第三方来源说明、基线测试和文档修正已补齐。 |
| 1 | 统一事件 | 已完成 | Runtime event 和基础审计链已统一。 |
| 2 | 统一模型流边界 | 已完成 | `ModelExecutor` 成为唯一流式边界。 |
| 3 | 统一工具生命周期 | 已完成 | policy / approval / audit / executor 收敛到单入口。 |
| 4 | Session 迁移 | 已完成 | 新会话路径切到 JSONL，legacy 输入仍兼容。 |
| 5 | AgentSession / CLI 收口 | 已完成 | `CLI -> AgentSession -> Agent -> runAgentLoop` 已成为主链。 |
| 6 | 上下文压缩 | 已完成 | compaction、切点和 overflow recovery 已接入。 |
| 7 | 指令、Memory、资源和安全 | 已完成 | 五层指令、Memory、Resource 和安全边界已落地。 |
| 8 | Extensions / MCP / Skills / Subagent | 已完成 | MCP、Skills、Preset、Subagent 的本地 MVP 已接入。 |
| 9 | 旧轨道清理 | 已完成 | 旧入口和旧兼容出口已经收口。 |
| 10 | CLI 0.2 闭环 | 已完成 | 安装、首次配置、聊天、resume、continue、doctor 已可用。 |
| 11 | 0.4.0 通用大脑边界 | 进行中 | 默认安装已收紧为零内建工具，插件协议和包边界正在继续完善。 |

## 0.4.0 当前重点

- 默认安装不再默认带文件、命令、浏览器、联网搜索等手脚工具。
- `@mingxu/plugin-sdk` 正在作为独立协议面向插件开发者收口。
- `skill` 和 `resource` 已进入插件/manifest schema，后续会继续补本地安装和扩展中心闭环。
- package、build、test、smoke、pack 已同步到 `0.4.0`。

## 近期已完成

- CLI 默认工具注册已收紧为零。
- 本地插件 metadata 现在可以表达更完整的 v1 类型。
- smoke 安装链已验证 `mingxu.cmd` / `mingxu` 包装可用。

## 接下来要做

1. 补本地插件安装器和扩展中心的完整生命周期。
2. 继续完善 official `coding-tools` 独立插件包。
3. 把更多外部能力统一放到本地插件和 MCP 中。
4. 持续收紧 TUI 和 session 状态投影，让默认安装保持干净。
