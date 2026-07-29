# 开发路线图与阶段执行记录

这份文档只记录一件事：`mingxu` 现在真正走到哪一步了。

- 阶段定义来自 [`docs/agent-runtime-design.md`](../agent-runtime-design.md) 和 `.claude/plans/` 里的执行计划。
- 每完成一个阶段，就更新这里，避免 README、代码和路线图彼此脱节。

## 当前状态

| 阶段 | 目标 | 状态 | 说明 |
| --- | --- | --- | --- |
| 0 | 基线冻结 | 已完成 | 已补齐 ADR-005~009、第三方来源说明、基线测试与文档修正。 |
| 1 | 统一消息与事件 | 已完成 | 已新增统一事件类型、事件总线兼容层和基线测试。 |
| 2 | 统一模型流边界 | 已完成 | `ModelExecutor` 成为唯一流式边界；`createRuntimeStreamFn` 只做转换。 |
| 3 | 统一工具生命周期 | 已完成 | `tool-lifecycle` 已将 policy、approval、audit、tool executor 收敛到单入口。 |
| 4 | Session 迁移 | 已完成 | 新会话主路径切到 JSONL，旧 JSON / legacy messages 继续兼容输入。 |
| 5 | AgentSession 与 CLI 切换 | 已完成 | CLI、`AgentSession` 和 `Agent` 已统一进入 `runAgentLoop`。 |
| 6 | 上下文压缩 | 已完成 | compaction、切分点、摘要生成与 overflow 恢复已并入统一 loop。 |
| 7 | 指令、Memory、资源与安全 | 已完成 | 五层指令、长期 Memory、受治理资源加载与安全边界已落地为本地 MVP。 |
| 8 | Extensions / MCP / Skills / Subagent | 已完成 | MCP、Skills、Preset、Subagent 与插件扩展能力已落地为本地 MVP。 |
| 9 | 删除旧轨道 | 已完成 | 旧实现和旧兼容导出已收口，根入口只保留正式 API。 |
| 10 | CLI 0.2 闭环 | 已完成 | CLI 配置发现、首次向导、交互聊天、resume/continue、trust-project 和 doctor 已可用。 |

## 阶段记录

### 2026-07-29：阶段 10 完成

- CLI 已从单次 runner 收敛为长生命周期 `CliRuntime` 语义：配置、provider、插件、MCP、事件 sink 和当前 `AgentSession` 可以贯穿交互过程。
- 交互模式已支持 `mingxu` / `mingxu chat`，并可通过 `resume`、`--continue` 继续同一工作区的历史会话。
- 全局配置、项目配置和项目信任已经可用；首次启动向导会在 TTY 下帮助用户完成最小配置。
- `doctor` 已成为离线优先的配置与路径自检入口，`--online` 才会做连通性检查。
- `env:NAME` 会先解析成真实环境变量再进入 provider / MCP / runtime 配置。

### 2026-07-29：阶段 8 完成

- MCP 支持 stdio 与 Streamable HTTP。
- MCP tools 通过稳定命名空间注册到工具注册表，并保留原始映射。
- Skills、Preset、Subagent 与受治理的资源加载已经接入主链。

### 2026-07-29：阶段 7 完成

- 五层指令已按 `Managed -> User -> Project -> Local -> Session` 组装。
- 长期 Memory 已收敛到 `managed/user/project/local`，并提供查询、保存、删除工具。
- Resource / Memory / instruction 的 discover / load / query / save / delete / error 审计链已接入。
- session 只保留在 `SessionStore` 中，不再混入长期 Memory。

### 2026-07-29：阶段 6 完成

- compaction 已接入 `runAgentLoop`。
- provider 报告 context overflow 时会进入更保守的压缩重试。
- hook 仍然可用，并且有专门测试覆盖压缩与非压缩路径。

### 2026-07-29：阶段 5 完成

- `CLI -> AgentSession -> Agent -> runAgentLoop -> ModelExecutor.stream` 已成为唯一运行主链。
- streaming、hook、并行工具调度和稳定结果顺序都被统一到 `runAgentLoop`。
- 新会话会返回 `AgentLoopResult.sessionId`，resume 会加载历史，continue 不再追加空 user 消息。
- 审批 fingerprint 已绑定 principal，旧 fingerprint 不再跨主体复用。

### 2026-07-29：阶段 4 完成

- 新的主会话路径已切到 `JsonlSessionStore`。
- 旧 `session/v1` 文档和 legacy `{messages}` 文档仍可读，并可在首次访问时 bootstrap 为 JSONL transcript。

### 2026-07-29：阶段 3 完成

- 新增 `src/tools/tool-lifecycle.ts`。
- 工具执行前后的 policy、approval、audit、executor 链路已收敛到单入口。

### 2026-07-29：阶段 0 完成

- 补齐 ADR-005 到 ADR-009。
- 新增第三方来源说明。
- 新增 `tests/e2e/current-runtime-characterization.test.ts` 作为当前运行时基线。
- 修正 README、CHANGELOG、SECURITY 和打包文件清单。

## 说明

- 如果阶段目标发生变化，先更新 ADR 或执行计划，再改这里。
- 如果某个阶段出现回退，也只在这里记录真实状态，不在 README 里“假装已经完成”。

