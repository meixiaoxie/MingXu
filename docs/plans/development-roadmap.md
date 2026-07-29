# 开发路线图与阶段执行记录

这份文档只做一件事：记录 `mingxu` 当前重构计划的执行状态。

- 阶段说明来自 [`docs/agent-runtime-design.md`](../agent-runtime-design.md) 和 `.claude/plans/` 里的执行计划。
- 每完成一个阶段，就在这里更新一次状态，避免 README 和代码状态脱节。

## 当前状态

| 阶段 | 目标 | 状态 | 说明 |
| --- | --- | --- | --- |
| 0 | 基线冻结 | 已完成 | 已补齐 ADR-005~009、第三方来源说明、基线测试与文档修正。 |
| 1 | 统一消息与事件 | 已完成 | 已新增统一事件类型、事件总线兼容层和基线测试。 |
| 2 | 统一模型流边界 | 已完成 | 已让 `ModelExecutor` 成为唯一流式边界，`createRuntimeStreamFn` 只做转换。 |
| 3 | 统一工具生命周期 | 已完成 | 已新增 `tool-lifecycle`，把 policy、approval、audit、tool executor 串成单层入口，并补了对应测试。 |
| 4 | Session 迁移 | 已完成 | 新会话主路径切到 JSONL，旧 JSON / legacy messages 继续作为兼容输入，并补了 bootstrap 与恢复测试。 |
| 5 | AgentSession 与 CLI 切换 | 已完成 | CLI、`AgentSession` 与 `Agent` 已统一进入 `runAgentLoop`，工具调用统一经过 policy、approval、audit 与 Session 生命周期。 |
| 6 | 上下文压缩 | 已完成 | compaction、切分点、摘要生成与 context overflow 单次恢复已接入统一 loop。 |
| 7 | 指令、Memory、资源与安全 | 待开始 | 区分指令、长期 Memory 和 Session。 |
| 8 | Extensions / MCP / Skills / Subagent | 待开始 | 在核心稳定后再接扩展层。 |
| 9 | 删除旧轨 | 已完成 | 旧实现和旧兼容导出已收口，根入口只保留正式 API。 |

## 阶段记录

### 2026-07-29：阶段 5 完成

- `CLI -> AgentSession -> Agent -> runAgentLoop -> ModelExecutor.stream` 已成为唯一运行主链；无原生流能力的模型继续使用 generate fallback。
- streaming、hook、compaction、受限并行工具调度和稳定结果顺序已迁入 `runAgentLoop`，旧 streaming loop 及重复工具执行逻辑已删除。
- CLI 现在传递 audit sink、目录模式 `SessionStore` 和 resume ID；新会话返回 `AgentLoopResult.sessionId`，resume 会加载历史且 continue 不再追加空用户消息。
- 所有正常、预算、取消、超时和异常退出都会先持久化终态；审批 fingerprint 现在绑定 principal，旧 fingerprint 按不兼容变更失效。

### 2026-07-29：阶段 6 完成

- 上下文压缩已接入 `runAgentLoop`，支持 token 预算、稳定切分点、摘要生成和近期消息保留。
- provider 返回 context overflow 时会使用更保守的压缩设置重试一次，避免形成无限恢复循环。
- compaction 的公开配置与 hook 保持可用，并由核心测试覆盖压缩与无需压缩两类路径。

### 2026-07-29：阶段 0 完成

本阶段完成了下面这些事情：

- 新增 `ADR-005` 到 `ADR-009`，把唯一主链、append-only Session、权限与沙箱、Memory 与资源、第三方来源边界写清楚。
- 新增 `LICENSES/pi-mono-MIT.txt` 和 `THIRD_PARTY_NOTICES.md`，把后续复用 `pi-mono` 代码时需要保留的来源信息提前固定下来。
- 新增 `tests/e2e/current-runtime-characterization.test.ts`，作为当前运行时的基线快照。
- 修正 README、CHANGELOG、SECURITY 和 npm 打包文件清单，让仓库的文字说明和当前代码事实对齐。

### 2026-07-29：阶段 4 完成

本阶段完成了下面这些事情：

- 新的主会话路径切换到 `JsonlSessionStore`，CLI 现在通过 JSONL 目录读写会话。
- 旧的 `session/v1` 文档和 legacy `{messages}` 文档仍可读，并可在首次访问时 bootstrap 成 JSONL transcript。
- 新增会话恢复测试，覆盖 JSONL 正常恢复和 legacy 文档迁移到 JSONL 的场景。


本阶段完成了下面这些事情：

- 新增 `src/tools/tool-lifecycle.ts`，把工具执行前后的决策链收敛到一个入口。
- `runAgentLoop()` 现在只负责循环、状态推进和消息落盘，工具的 policy、approval 和执行都交给生命周期层。
- 补了 `tests/tool-lifecycle.test.ts`，并更新核心回归测试，确认阶段 3 的新分层不会破坏现有行为。


- 每完成一个阶段，就把对应行改成“已完成”。
- 如果阶段目标发生变化，先更新 ADR 或计划文件，再改这里的状态。
- 如果发现某个阶段无法继续，先在这里写明阻塞原因，再处理代码。
