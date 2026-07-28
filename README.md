# mingxu

`mingxu` 是一个最小化的 TypeScript Agent Runtime 骨架。你可以把它理解成”Agent 的发动机底盘”：它先把模型调用、工具执行、配置加载、插件扩展和会话保存这些基础零件拼起来，让你能从源码跑通一个最小可用的 Agent。

底层 runtime 的完整设计蓝图和执行计划见：[docs/agent-runtime-design.md](docs/agent-runtime-design.md)。这份文档按 A/B/C 阶段说明每一部分用什么代码、要做什么设计、怎么分阶段实现和验证。

> 当前版本是 `0.1.0` 开发阶段，npm 包仍为 `private`，请从源码运行。README 只描述现在已经真实具备的能力；规划中的能力见 `docs/plans/development-roadmap.md`。

下面的内容重点讲**新配置结构怎么用**。

现在已经可以真实使用的能力有：

- 最小 Agent Loop：用户消息 → 模型响应 → 工具调用 → 下一轮模型请求。
- CLI 参数：`--config`、`--prompt`、`--help`、`--version`。
- 新版多模型配置：`defaultModel + models`。
- 旧版单模型配置兼容：`model` 会自动归一化成新版结构。
- 内建 provider：`anthropic`、`openai-compatible`、`openai`、`deepseek`、`kimi`、`zhipu`、`glm`、`gemini`、`custom`。
- provider 别名、provider 默认参数、自定义 provider 模块加载。
- 内建 `echo`、`readFile` 工具和统一 Tool Registry。
- 本地 JavaScript 插件动态加载；当前插件只支持注册 Tool。
- 可选版本化本地 Session 文档，支持继续同一段对话、列最近 Session 和 `resume` 恢复。
- 可选版本化 runtime 事件与内建 JSONL audit 写盘。
- 最小核心 Policy / Approval 链：当前 tool call 已支持规范化、`allow/deny/ask` 决策、预授权匹配、非交互默认拒绝和审计事件。
- 最小 `secretRef`：当前支持 `env:` 引用写法，并在错误、session 与审计路径上做基础脱敏。
- 运行时预算与结果边界：最大轮次 / 模型请求 / 工具调用限制、消息数裁剪、工具大结果 Artifact 降载、usage 累计与稳定终止原因。
- TypeScript 公共 API，可嵌入其他 Node.js 项目。

这里有两个边界要先说清楚，避免把“已经有一点雏形”和“已经正式支持”混在一起：

- `customProviders.module` 现在可以作为**实验性兼容入口**使用，也就是“先让你从本地模块接进一个自定义 provider”；它还不是稳定的正式 provider 插件 API。
- README 现在不把 streaming（流式输出，也就是模型边生成边返回）算作 v0.1 已承诺能力。路线图已经明确要求把这项能力按真实状态收紧，避免文档先说得太满。

## 当前还没有实现

下面这些能力已经在路线图里，但当前版本还不能宣称已经完成：

- `mingxu init`、`mingxu doctor`、`mingxu plugin` 等子命令。
- plugin manifest、插件权限审批、allowlist / blocklist。
- 完整的企业级 Policy / Approval 平台（当前只有最小核心授权链，主要覆盖工具调用与文件访问）。
- MCP connector、长期 Memory、声明式 Agent Preset。
- 不可信插件隔离、容器沙箱、调度和多 Agent Workflow。
- 企业级 Secret Provider（当前只支持最小 `env:` secretRef）。

如果你想看这些能力后面怎么推进，可以看：

- 开发路线图：`docs/plans/development-roadmap.md`
- v0.1 发布门禁记录：`docs/plans/v0.1-release-gate.md`
- 架构决策文档：
  - `docs/architecture/adr-001-v0x-deployment-mode.md`
  - `docs/architecture/adr-002-plugin-trust-and-isolation.md`
  - `docs/architecture/adr-003-core-plugin-boundaries.md`
  - `docs/architecture/adr-004-runtime-entity-model.md`

## v0.1 当前能力边界

这部分可以理解成“这版产品现在到底算做到哪一步”。路线图这次把边界收得更严格，所以 README 也要跟着说得更准确。

### 现在可以真实说已经能做的事

- 跑通最小端到端链路：配置读取 → 默认模型选择 → provider 加载 → 插件加载 → Agent 执行。
- 使用 provider 别名和 provider 默认参数。
- 加载本地自定义 provider 模块。
- 加载本地工具插件。
- 保存会话文件。

### 现在不能真实宣称已经完成的事

- 不能说 v0.1 发布门禁已经完整通过。
- 不能说插件平台已经完成到可以支持所有插件类型。
- 不能说已经有 plugin manifest、权限审批、审计、allowlist、blocklist。
- 不能说已经支持 provider 插件、memory 插件、MCP 接入、插件安装命令。
- 不能说当前 CLI 不支持 `--model <key>`；这个能力已经实现，但 README 仍不能把它说成“多模型完整调度系统”。
- 不能说现在还只有“messages KV”级会话保存；当前已经有版本化本地 Session 文档、revision 冲突保护、legacy 迁移和最小 `resume` / recent sessions 能力，但还不是企业级会话数据库。
- 不能说已经有完整企业级 Policy / Approval 平台；当前只有最小核心授权链和版本化事件/审计主链。
- 不能说已经支持 streaming，或把它当成 v0.1 对外承诺的一部分。

### 这版 v0.1 的插件范围

当前 v0.1 里的“插件”要收敛理解成：

- 本地 ESM / JS 工具插件。
- 通过 `registerTool` 扩展现有工具表。
- `customProviders.module` 只是实验性兼容入口，不纳入稳定 plugin API 承诺。
- 不能把它描述成已经具备多类型插件生态的平台。

换句话说，现在的插件更像“给 Agent 增加一个本地小工具”，还不是完整的插件生态平台。

## 安全边界

### 本地插件是可信代码

当前插件直接在 `mingxu` 的 Node.js 进程里执行，可以访问 `process.env`、文件系统和网络。

> 安装或配置插件，等于执行第三方代码。

当前版本没有 manifest 和沙箱。只加载你已经审查并信任的本地插件。自定义 provider 模块同样属于可信本地代码。

如果你把“信任等级”理解成门卫的放行规则，现在 v0.x 路线图收敛到的长期方向是：插件要么是 `trusted_local`（你明确允许的本地可信代码），要么是 `blocked`（禁止加载）。也就是说，它不是“已经隔离好的安全插件系统”，而是“你自己决定要不要把这段本地代码放进进程里执行”。

### 内建文件工具

`readFile` 默认只能读取启动 `mingxu` 时当前工作目录内的 UTF-8 文件，单个文件默认不超过 1 MiB，并会检查符号链接是否逃出目录。

当前版本已经把 `readFile` 接进最小核心 Policy 链，也就是说模型提出读取文件时，runtime 会先把请求规范化成文件访问动作，再做 allow/deny/ask 决策，然后才真正执行工具。同时工具内部仍保留 `realpath`、根目录和大小限制检查，形成“双保险”。

不过这还不是完整的文件治理平台：目前主要覆盖读取、根目录约束、非交互默认拒绝和预授权匹配；更细的敏感文件规则、写入/删除策略和企业级文件审批范围还在后续阶段。

### API Key

不要把真实 API Key 写进 `mingxu.config.json`，也不要提交到 Git。当前更推荐把 key 放到环境变量里，让 provider 在运行时读取。

## 运行环境与支持范围

支持矩阵就是“项目在哪些环境里会被持续检查”的清单。目前的质量基线如下：

| 项目 | 支持范围 | 自动验证 |
| --- | --- | --- |
| Node.js | 22 LTS、24 LTS | GitHub Actions |
| 包管理器 | pnpm 10（仓库当前固定为 10.12.1） | GitHub Actions |
| 操作系统 | Ubuntu、Windows、macOS 的 GitHub Actions 最新稳定镜像 | GitHub Actions |
| 模块格式 | ESM（ECMAScript Module，Node.js 的现代模块格式） | 构建与打包 smoke test |

`package.json` 会拒绝 Node.js 22 以下版本。Node.js 22 和 24 是当前明确持续测试的版本；其他大于 22 的非 LTS 版本可能可用，但不属于质量保证范围。

当前仓库已经准备好了发布所需的技术门禁，包括：

- `pnpm test:smoke` 的真实 tarball 安装验证
- `pnpm pack:dry-run` 的 tarball内容预览
- `.github/workflows/release.yml` 中基于 OIDC / provenance 的发布流程定义

但“真正执行对外发布”仍应以 release gate 和人工在线验收记录为准，不能只因为本地命令通过就默认已经对外发布成功。

## 安装与质量检查

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm test:smoke
pnpm pack:dry-run
```

这些命令依次负责：

- 按锁文件安装依赖。
- 检查 TypeScript 类型。
- 运行测试。
- 生成 `dist` 构建产物。
- 执行 smoke test（冒烟测试，也就是用最短路径确认成品能启动）。
- 预览最终 npm tarball 会打进哪些文件。

当前 smoke test 会真的打出 npm 安装包，在临时目录安装它，然后验证：

- 安装后的 `mingxu` CLI 能执行 `--help`；
- 安装包包含 CLI、公共 JavaScript API 和类型声明；
- 安装后的公共 API 能被 Node.js 正常导入；
- 能从空目录完成 `init -> 离线 run -> doctor -> session -> audit` 的最小闭环。

GitHub Actions 会在提交到 `main`、Pull Request 和手动触发时，对上面的 Node.js 与操作系统组合运行安装、类型检查、完整测试、构建和 smoke test。正式发布则通过单独的 release workflow 执行 `typecheck`、`test`、`build`、`test:smoke`、`npm pack --dry-run` 和带 provenance 的 npm 发布流程。Vitest 现在不再允许“没有任何测试也算通过”，这样测试文件被误删时 CI 会直接失败。

## 快速开始

### 1. 安装依赖

```powershell
pnpm install
```

如果 Windows PowerShell 阻止执行 `pnpm.ps1`，可以直接使用：

```powershell
pnpm.cmd install
```

### 2. 设置模型凭据

以 Anthropic 为例，在当前 PowerShell 会话中设置：

```powershell
$env:ANTHROPIC_API_KEY = "你的 API Key"
```

这个值只在当前终端窗口有效，不会写入项目配置。

### 3. 创建配置

你现在可以直接用 CLI 生成起步配置，而不是手写整个 JSON。

最小配置：

```powershell
node dist/cli/entry.js init --profile minimal
```

如果你更希望一开始就打开本地 Session、Audit 和更保守的运行限制，可以使用：

```powershell
node dist/cli/entry.js init --profile secure-local
```

这会在当前目录生成 `mingxu.config.json`。如果文件已经存在，CLI 会拒绝覆盖，避免把你现有配置悄悄改坏。

如果你更想自己写，也可以在项目根目录手动创建 `mingxu.config.json`：

```json
{
  "name": "mingxu",
  "systemPrompt": "You are a helpful agent.",
  "defaultModel": "primary",
  "models": {
    "primary": {
      "provider": "anthropic",
      "model": "claude-sonnet-5"
    }
  },
  "maxIterations": 10,
  "plugins": []
}
```

如果你只有一个模型，这已经够用了。

### 4. 检查配置和本地环境

生成配置后，你可以先跑一次本地自检：

```powershell
node dist/cli/entry.js doctor
```

默认的 `doctor` 是**离线检查**，主要看：

- 配置文件能不能读、格式对不对
- 模型/provider 引用是不是成立
- `env:` secretRef 对应的环境变量是否存在
- 插件路径、session 路径、audit 路径是否合理

如果你明确想检查真实模型连通性，可以显式启用在线探针：

```powershell
node dist/cli/entry.js doctor --online
```

`doctor --online` 会访问你配置的 provider，所以它会额外提示网络访问和可能费用。默认不加 `--online` 时不会触网。

### 5. 构建并运行

```powershell
pnpm build
node dist/cli/entry.js --config mingxu.config.json "Say hello"
```

也可以使用 `--prompt`：

```powershell
node dist/cli/entry.js --config mingxu.config.json --prompt "Say hello"
```

## CLI

当前 CLI 既支持直接运行 prompt，也支持几个最小子命令：
