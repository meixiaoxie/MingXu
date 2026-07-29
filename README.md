# mingxu

> Current release: 0.3.0.
> The interactive CLI now uses a product TUI shell with live conversation, approval overlays, extensions, agents, and context panels.

`mingxu` 是一个最小但可真正跑起来的 TypeScript Agent Runtime。它把模型调用、工具执行、审批、审计、会话持久化和配置发现收敛到一条主链上，目标不是做一个花哨框架，而是让你可以用 CLI 把一个受治理的 Agent 真正跑起来。

完整的运行时设计与阶段规划见：

- [docs/agent-runtime-design.md](docs/agent-runtime-design.md)
- [docs/plans/development-roadmap.md](docs/plans/development-roadmap.md)

当前版本是 `0.3.0`，npm 包仍然是 `private`，请从源码或本地打包安装。

## 现在已经能做什么

- CLI 交互聊天：`mingxu` 或 `mingxu chat`
- TUI 输入层：`/` 菜单、Tab 补全、方向键选择、`/steer`、`/context`、`/extensions`、`/agents`
- 单轮执行：`mingxu --prompt "..."` 或直接传入位置参数
- 会话恢复：`resume`、`--continue`、`sessions`
- 首次启动配置向导：TTY 下无配置时自动引导初始化
- 全局 / 项目配置发现与信任控制
- `init --global` 和 `init --project`
- `doctor` 离线检查配置、路径、secret 引用和信任状态
- 统一运行链：`CLI -> AgentSession -> Agent -> runAgentLoop -> ModelExecutor.stream`
- 工具治理：policy、approval、audit、abort、session 生命周期都走同一条链
- 长期 Memory、Resources、MCP、Skills、Preset 和 Subagent 的本地 MVP 能力

## 现在还没有做什么

下面这些能力不是当前版本的承诺，README 不把它们说成“已经完成”：

- 全屏 TUI
- 插件市场
- 自动安装插件
- 远程 registry
- 真正的 OS / 容器级沙箱
- 旧 SSE MCP 协议
- 分布式 Subagent

本地插件和本地 provider 模块仍然属于可信代码；`mingxu` 提供的是治理链，而不是隔离沙箱。

## 安装

### 1. 拉依赖并构建

```powershell
pnpm install --frozen-lockfile
pnpm build
```

### 2. 本地运行

```powershell
node dist/cli/entry.js --help
```

### 3. 全局安装

```powershell
npm install -g .
mingxu --help
```

Windows 会生成 `mingxu.cmd`，Unix 会生成 `mingxu` 可执行文件。

## 快速开始

### 第一次启动

如果当前没有可用配置，并且你在一个交互式终端里运行 `mingxu`，CLI 会先进入首次配置向导，帮助你选择 provider、模型 ID 和必要的环境变量名。

它不会把真实 API Key 写进配置文件。推荐做法是把密钥放到当前 shell 的环境变量里，例如：

```powershell
$env:ANTHROPIC_API_KEY = "your-key"
```

### 初始化配置

你也可以显式初始化：

```powershell
mingxu init --global
mingxu init --project
```

`--global` 会写入用户级配置目录；`--project` 会在当前项目生成项目配置。

### 启动聊天

```powershell
mingxu
```

或：

```powershell
mingxu chat
mingxu chat "帮我总结这个仓库现在的能力"
```

如果你只想跑单轮：

```powershell
mingxu --prompt "Say hello"
```

也可以直接传位置参数：

```powershell
mingxu "Say hello"
```

### 恢复会话

```powershell
mingxu sessions
mingxu resume <session-id>
mingxu --continue
```

`--continue` 会直接恢复当前工作区最近一次会话；`resume` 不传 ID 时，交互模式会给出选择列表。

### 常用斜杠命令

在交互聊天里可以用：

- `/help`
- `/status`
- `/model`
- `/tools`
- `/session`
- `/sessions`
- `/resume <id>`
- `/new`
- `/clear`
- `/exit`
- `/context`
- `/extensions`
- `/agents`
- `/audit`
- `/trust`
- `/preset`
- `/compact`
- `/steer`

## 配置发现与信任

CLI 会按层读取配置：

1. 全局配置
2. 当前项目配置
3. 具体运行参数

全局配置位置默认是：

- Windows：`%APPDATA%\mingxu\config.json`
- Unix：`${XDG_CONFIG_HOME:-~/.config}/mingxu/config.json`

`MINGXU_USER_CONFIG_DIR` 可以覆盖全局配置目录。

项目配置会从当前目录向上查找最近的 `mingxu.config.json`。CLI 会对自动发现的项目配置做信任检查；未受信项目层不会自动加载插件、MCP、Skills 或项目级资源。

配置里可以用 `env:NAME` 引用环境变量，CLI 会在创建 provider、MCP header 或 env 之前解析它；缺失变量会直接报错。

## doctor

`doctor` 默认是离线检查：

```powershell
mingxu doctor
```

它主要检查：

- 配置来源和合并结果
- 路径是否真实存在
- `env:` 引用是否可解析
- 项目是否受信
- 插件和资源路径是否合理

需要真实连通性时才显式加：

```powershell
mingxu doctor --online
```

## 当前能力边界

为了避免误解，这里把当前版本的边界再写清楚一次：

- `mingxu` 已经可以作为 CLI 直接聊天、恢复会话和做离线配置检查。
- 运行时已经统一到一条主链，工具、审批、审计、会话保存都走同一条路径。
- 长期 Memory、Resources、MCP、Skills、Preset 和 Subagent 已有本地 MVP 能力，但仍然是通过配置显式启用，不是“自动全开”。
- 本地插件没有真正沙箱；它们仍然是进程内可信代码。
- 这不是一个已经完成的企业级平台，但它已经足够作为本地可用的受治理 Agent CLI。

## 开发与验证

常用命令：

```powershell
pnpm typecheck
pnpm test
pnpm build
pnpm test:smoke
pnpm pack:dry-run
pnpm audit --prod
```

如果你想了解项目现在做到哪一步，推荐看：

- [docs/plans/development-roadmap.md](docs/plans/development-roadmap.md)
- [CHANGELOG.md](CHANGELOG.md)
