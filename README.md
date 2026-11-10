# Joymind

Joymind 是一个规划中的本地优先、模型无关、工具可扩展的 Agent 工具软件。目标是在明确的权限与预算约束下，让用户通过自然语言完成文件、终端及其他扩展工具支持的任务，同时保留完整、可审计的执行过程。

项目采用“**核心自控、外围复用**”的路线：自行实现 Agent 循环、任务状态、权限、上下文和恢复机制，复用成熟的模型 SDK、MCP、SQLite 与桌面生态，并为未来的 Super Agent 编排保留统一运行时。

> **当前状态：规格与任务拆分阶段，尚未开始代码实现。** 下文描述的是目标能力，不代表当前已发布功能。

## 文档入口

- [软件规格说明书（SPEC）](./SPEC.md)：产品需求、架构契约、安全、数据模型、Super Agent 和验收标准。
- [开发任务清单（TASKS）](./TASKS.md)：面向编码开发 Agent 的任务依赖、交付物、验收标准和执行批次。
- [MIT 许可证](./LICENSE)：第一方源码许可。

## 目标能力

### 单 Agent 与本地工具

- 自然语言任务和流式模型响应。
- 文件读取、搜索、写入、Diff 和终端执行。
- 高风险操作审批、取消、超时和预算控制。
- 本地会话、Run Event、Artifact 和崩溃恢复。
- 桌面端与 CLI 共用同一个 AgentRuntime。

### 灵活扩展

- 可替换的模型 Provider Adapter。
- 版本化 AgentDefinition、Tool 和 Extension Manifest。
- MCP 本地工具接入。
- 隔离的 Extension Host 和明确权限声明。

### Super Agent 演进

- Supervisor 分解目标并维护 TaskGraph。
- 专家子 Agent 使用独立上下文和层级预算。
- DAG 调度、受控并行、Artifact 交换和结果汇总。
- 子 Agent 只能收窄权限，不能突破根 Run 的预算与授权。
- 写冲突通过资源锁、worktree 或临时目录隔离。

Super Agent 将复用单 Agent 的 Run、Tool、Policy、Event 和 Artifact，而不是另建一套运行时。

## 技术架构

| 层次 | 规划选型 |
| --- | --- |
| 语言与运行时 | TypeScript 严格模式、Node.js LTS |
| 工程组织 | pnpm workspace/monorepo |
| 桌面端 | Electron |
| UI | React |
| 本地存储 | SQLite |
| 数据校验 | Zod |
| 工具协议 | MCP SDK |
| 测试 | Vitest、Playwright |
| 可观察性 | 结构化日志，后续接入 OpenTelemetry |

桌面端选择 Electron，是为了让 Node.js AgentRuntime、MCP 和本地进程工具在首版保持简单。React Renderer 不直接访问模型、数据库、密钥、文件系统或终端。

```text
React UI / CLI
      │
      ▼
AgentRuntime ───── RunStore / SQLite
      │
      ├── ContextManager
      ├── ModelProvider Adapters
      └── ToolRuntime
             ├── Built-in Tools
             ├── MCP
             └── Extension Host

未来：AgentRuntime 创建父子 Run，
      Supervisor + DAG Scheduler 提供 Super Agent 编排。
```

更详细的 Module Interface、依赖方向和进程约束见 [SPEC 第 6～8 节](./SPEC.md#6-技术选型)。

## 实施路线

| 里程碑 | 目标 | 主要结果 |
| --- | --- | --- |
| M0 | 工程与领域基础 | monorepo、Run/Event、SQLite、状态机、模拟 Run |
| M1 | 单 Agent 与 CLI | Provider、工具、审批、预算、恢复、真实任务闭环 |
| M2 | 桌面可用版本 | Electron、React、Diff、密钥存储、打包与 P0 验收 |
| M3 | 扩展生态 | MCP、Extension Host、Agent Pack、诊断导出 |
| M4 | Super Agent | Supervisor、DAG、父子 Run、并行隔离和对照评测 |

任务 ID、依赖关系和建议并行方式见 [TASKS.md](./TASKS.md)。在 M2 完整验收前，不应将任何构建称为完整 P0 发布。

## 参与开发

1. 阅读 [SPEC.md](./SPEC.md)，确认任务对应的需求和架构约束。
2. 在 [TASKS.md](./TASKS.md) 中选择依赖已完成的任务，从 M0 开始。
3. 使用独立分支或 worktree，避免多个 Agent 同时修改核心循环、公共 schema 或 migration。
4. 实现功能及相应测试，不省略审批、取消、恢复和迁移要求。
5. 运行相关 lint、类型检查、测试和构建；里程碑还需运行 E2E 与评测。
6. 按 TASKS 中的格式报告验收证据、实际验证命令、平台和已知限制。
7. 如果实际行为需要偏离 SPEC，先提出并记录规格变更，不要静默改变行为。

### 规划中的标准命令

以下命令是工程初始化任务 `JM-M0-001` 的交付目标，**当前仓库尚不可直接运行**：

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
pnpm eval
```

## 安全与隐私原则

- 模型只能提出工具调用意图，不能自行授权。
- 写文件、删除、Shell 和网络操作由宿主 Policy 强制执行约束。
- 默认使用 Workspace 作用域、最小环境变量和高风险操作审批。
- 密钥不写入 SQLite、Run Event、普通日志或 Renderer。
- 工具输出属于不可信数据，不能通过 Prompt Injection 扩大权限。
- 默认不发送遥测；长期记忆和外部工具需要用户明确控制。

安全模型和威胁缓解详见 [SPEC 第 12、14、15、21、27 节](./SPEC.md)。

## 许可证

Joymind 第一方源码采用 [MIT License](./LICENSE)。分发时仍需遵守第三方依赖各自的许可义务；MIT 许可证不授予 Joymind 商标权。
