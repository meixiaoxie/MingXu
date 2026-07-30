# MingXu 开发路线图

这份文档只记录当前真实状态，不把未完成能力写成已完成。

## 阶段总览

| 阶段 | 主题 | 状态 | 说明 |
| --- | --- | --- | --- |
| 0 | 基线与文档 | 已完成 | ADR、第三方来源说明、基线测试和文档修正已补齐。 |
| 1 | 统一事件 | 已完成 | Runtime event 和基础审计链已经统一。 |
| 2 | 统一模型流边界 | 已完成 | `ModelExecutor` 成为唯一流式边界。 |
| 3 | 统一工具生命周期 | 已完成 | policy / approval / audit / executor 收敛到单入口。 |
| 4 | Session 迁移 | 已完成 | 新会话路径切到 JSONL，legacy 输入仍兼容。 |
| 5 | AgentSession / CLI 收口 | 已完成 | `CLI -> AgentSession -> Agent -> runAgentLoop` 已成主链。 |
| 6 | 上下文压缩 | 已完成 | compaction、切点和 overflow recovery 已接入。 |
| 7 | 指令、Memory、资源和安全边界 | 已完成 | 五层指令、Memory、Resource 和安全边界已落地。 |
| 8 | Extensions / MCP / Skills / Subagent | 已完成 | 本地扩展、MCP、Skills、Preset 和 Subagent 的本地 MVP 已接入。 |
| 9 | 旧轨道清理 | 已完成 | 旧入口和旧兼容导出已收口。 |
| 10 | CLI 0.2 闭环 | 已完成 | 安装、首次配置、聊天、resume、continue、doctor 已可用。 |
| 11 | 0.4 扩展安装与治理闭环 | 已完成 | 本地扩展的协议、安装、更新、启停、删除、诊断和 Windows 使用说明已经收口。 |
| 12 | 成品 CLI 收口 | 规划中 | inline scrollback、差分渲染、输入、Overlay、真实扩展样例和跨平台验收按专项计划推进。 |
| 13 | 更完整的生态兼容 | 规划中 | 第三方生态 adapter、更多搜索后端和更完整的扩展安装体验留到后续版本。 |

## 0.4 当前已经完成的内容

- `@mingxu/plugin-sdk` 已经拆成独立协议包骨架。
- `@mingxu/coding-tools` 已经有独立官方编码插件骨架。
- `@mingxu/web-search` 已经有独立联网搜索插件骨架。
- CLI 已经有 `extensions` 命令树，可以做本地扩展管理。
- 扩展安装、更新、启用、停用、删除、列表、诊断和初始化已经接上同一套治理流。
- README 已经补上 Windows 安装、AI 接入和 `extensions` 使用说明。
- 0.4 的版本口径已经调整为“扩展安装与治理闭环”，不再把插件市场和远程 registry 写成完成项。

## 0.4 仍在推进的内容

- 官方 `coding-tools` 的真实执行器和更完整的工具实现。
- `web-search` 的 Brave / Tavily / SearXNG 后端接入。
- 第三方开源插件与生态 adapter 的完整接入。
- 更完整的用户可视化体验，但仍然不走全屏 TUI。

## 当前阶段的产品边界

- MingXu 本体继续只做治理层和运行层。
- 文件、命令、联网搜索、PDF、浏览器、数据库等“手脚”默认不内置。
- 用户通过本地插件或 MCP 接入自己需要的专用能力。
- 本地插件和 provider 代码仍然属于可信代码，不是 OS 或容器沙箱。

## 下一步建议

完整实施顺序、验收标准和完成定义见 [MingXu 成品 CLI 收口计划](./cli-productization-plan.md)。

1. 先冻结终端基线，完成真正的 inline scrollback 和差分活动区域。
2. 收口 Editor、语义 Transcript、Overlay 和运行事件投影。
3. 用真实 `coding-tools` 插件验证完整扩展治理闭环。
4. 完成 Windows、非 TTY、真实 tarball 和跨平台发布验收。
