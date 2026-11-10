# Joymind 软件规格说明书（SPEC）

| 项目 | 内容 |
| --- | --- |
| 文档编号 | JM-SPEC-001 |
| 文档版本 | 0.1.0 |
| 状态 | Proposed |
| 产品名称 | Joymind |
| 技术路线 | TypeScript 全栈、React、Electron、SQLite、MCP |
| 目标形态 | 本地优先的桌面 Agent 工具，同时提供 CLI |
| 许可证 | MIT |
| 演进方向 | 单 Agent → 可扩展 Agent → Super Agent |

本文中的“必须（MUST）”“禁止（MUST NOT）”“应该（SHOULD）”“可以（MAY）”具有需求约束含义。`P0` 表示首个可用版本必须完成，`P1` 表示后续增强，`P2` 表示 Super Agent 阶段能力。

## 1. 产品概述

### 1.1 产品定位

Joymind 是一个本地优先、模型无关、工具可扩展的 Agent 工具软件。用户通过自然语言提交目标，Joymind 在明确的权限策略下调用模型和工具，展示完整执行过程，并支持暂停、取消、审批、失败恢复和结果追踪。

Joymind 的核心价值不是某一种模型或提示词，而是：

1. 可靠的任务执行闭环。
2. 可观察、可介入、可审计的执行过程。
3. 可替换的模型、工具和 Agent 配置。
4. 从单 Agent 平滑演进到 Super Agent 的运行时。
5. 本地数据控制和清晰的许可证边界。

### 1.2 产品目标

- 用户可以用自然语言完成文件、终端、搜索及其他扩展工具支持的任务。
- 用户可以在高风险操作发生前审批，并在执行中随时取消。
- 同一种 Agent 能力可以运行在桌面端和 CLI 中。
- 模型 Provider、工具、Agent 定义可以独立扩展。
- 应用崩溃或重启后，可以恢复任务记录，并安全地继续或明确标记无法恢复的步骤。
- 未来可以加入监督者 Agent、专家子 Agent、并行任务和跨 Agent Artifact，而不重写核心运行时。

### 1.3 非目标

P0 明确不追求：

- 多智能体数量上的堆叠或无监督的全自动协作。
- 可视化拖拽工作流编辑器。
- 插件市场、账号体系、支付和团队协作后端。
- 自研模型、向量数据库或通用分布式任务平台。
- 对所有工具副作用提供“恰好一次”执行保证。
- 通过 Prompt 替代操作系统级安全隔离。
- 同时支持 Electron 和 Tauri 两套桌面实现。

### 1.4 成功指标

首个公开测试版至少达到：

- P0 回归评测集任务成功率不低于 80%，且每次发布不得显著倒退。
- 所有写文件、终端执行、外部网络等风险操作均经过策略判定；默认策略下必须审批的操作不得绕过。
- 运行记录完整覆盖模型请求、模型响应摘要、工具调用、审批、错误和最终状态。
- 应用重启后，历史任务可查询；正在执行的任务可恢复或进入明确的 `interrupted` 状态。
- 新增一个 OpenAI 兼容 Provider 不需要修改 Agent 核心逻辑。
- 新增一个内置工具不需要修改 UI 和 Agent 核心状态机。

## 2. 领域术语

| 术语 | 定义 |
| --- | --- |
| Workspace | 用户授权访问的项目或目录，是文件与工具权限的默认作用域。 |
| Session | 用户围绕一个工作上下文进行的一组交互，包含消息和 Run 引用。 |
| Run | 一次有明确目标、状态、预算和终态的 Agent 执行。 |
| Task | Super Agent 中可调度的工作项；一个 Task 通常对应一个子 Run。 |
| AgentDefinition | Agent 的版本化声明，包括模型、Prompt、工具、预算和权限要求。 |
| AgentRuntime | 执行 AgentDefinition 并管理 Run 生命周期的核心 Module。 |
| Supervisor | Super Agent 模式下负责分解目标、调度子 Run、汇总结果的 Agent。 |
| Sub-agent | 由父 Run 创建、拥有独立上下文和预算的专家 Agent。 |
| Provider | 模型服务提供方或其适配器。 |
| Tool | 可被 Agent 调用的强类型能力，如文件读取、写入或终端执行。 |
| ToolCall | 一次具体工具调用，包含参数、权限、审批、执行状态和结果。 |
| Policy | 判断某个操作是否允许、拒绝或需要审批的规则集合。 |
| Approval | 用户对一次或一类操作的明确授权记录。 |
| Artifact | Run 或 Task 产生的可寻址结果，如文件、报告、补丁或结构化数据。 |
| Event | 描述 Run 变化的不可变记录，具有单调递增的序号。 |
| Extension | 通过受控 Interface 增加 Tool、Provider 或 AgentDefinition 的扩展包。 |
| MCP | Model Context Protocol，用于连接外部工具和资源。 |
| Budget | 对 Token、费用、工具次数、并发、深度和墙钟时间的限制。 |

本文中的 Module、Interface、Implementation、Adapter 和 Seam 用于描述架构：Module 对外只暴露小而稳定的 Interface，复杂性封装在 Implementation 内；Adapter 在明确的 Seam 上满足对应 Interface。

## 3. 总体设计原则

### 3.1 核心自控，外围复用

必须自行掌握 Agent 循环、Run 状态机、工具权限、上下文、持久化和评测。模型 SDK、MCP SDK、UI 组件、SQLite 和日志设施优先复用成熟实现。

### 3.2 稳定核心，显式扩展点

- 不允许扩展直接修改核心内部状态。
- 扩展只能通过版本化 Interface 交互。
- 只有存在两个以上真实 Implementation 或明确跨进程需求时才建立通用 Seam。
- 不预先设计无实际使用者的通用 Hook 系统。
- 新能力优先放入现有深 Module 的 Implementation，而不是增加一层透传 Module。

### 3.3 本地优先，UI 与执行解耦

- P0 的权威执行状态保存在本地。
- React UI 不直接访问模型、文件系统、终端或数据库。
- CLI 和桌面 UI 使用同一个 AgentRuntime。
- 远程 Runtime 是后续 Adapter，不改变核心领域模型。

### 3.4 默认安全，权限在模型之外执行

模型只能提出工具调用意图，不能自行授予权限。路径约束、审批、网络策略、进程终止和预算必须由宿主强制执行。

### 3.5 可恢复但不隐瞒不确定性

对于已经产生外部副作用的工具，崩溃后不能盲目重放。无法确认结果时必须标记为 `unknown`，要求核对或人工处理。

### 3.6 Super Agent 是编排模式，不是另一个产品内核

Super Agent 必须复用 Run、Tool、Policy、Event、Budget 和 Artifact。父子 Run、独立上下文和任务依赖是 P0 数据模型需要预留的能力，但 P0 不实现复杂调度器。

## 4. 目标用户与核心场景

### 4.1 目标用户

- 需要本地文件和终端自动化的高级个人用户。
- 需要可审计编程助手的开发者。
- 需要接入内部模型和 MCP 工具的技术团队。
- 希望基于 MIT 项目进行二次开发的个人或组织。

### 4.2 P0 核心场景

1. 用户选择 Workspace，创建会话并输入目标。
2. Agent 读取项目文件，解释下一步并请求写入审批。
3. 用户查看 Diff，批准或拒绝修改。
4. Agent 执行终端命令，实时展示退出码和脱敏输出。
5. 用户取消长时间运行的任务，已执行步骤保持可追溯。
6. 应用重启后恢复会话，并提示中断步骤的处理方式。
7. 用户在设置中切换 Provider 和模型，而不改变现有工具配置。

### 4.3 P1 扩展场景

- 安装并启用一个本地 MCP Server。
- 导入自定义 AgentDefinition，例如“代码审查员”或“文档整理员”。
- 将常用 Run 导出为脱敏诊断包。
- 在后台运行长任务，并在需要审批时收到通知。

### 4.4 P2 Super Agent 场景

用户提出“分析这个项目并完成指定改造”。Supervisor 将目标拆成代码分析、实现、验证等 Task，分别交给专家 Sub-agent；部分 Task 并行执行，共享显式 Artifact，最终由 Supervisor 汇总结果。任何子 Agent 都不能突破父 Run 的权限和总预算。

## 5. 需求优先级总览

| 能力 | P0 | P1 | P2 |
| --- | --- | --- | --- |
| 单 Agent Run 生命周期 | 必须 | 增强 | 复用 |
| React 桌面 UI、Electron、CLI | 必须 | 增强 | 增强 |
| OpenAI 兼容与第二类 Provider Adapter | 必须 | 增加 | 复用 |
| 文件、终端、搜索工具 | 必须 | 增加 | 复用 |
| 审批、取消、预算、审计 | 必须 | 增强 | 层级继承 |
| SQLite 持久化与迁移 | 必须 | 备份导出 | 任务图查询 |
| MCP Client | 可选 | 必须 | 复用 |
| 第三方 Extension Host | 不支持 | 受限支持 | 按能力授权 |
| 自定义 AgentDefinition | 基础支持 | 完整支持 | 专家 Agent |
| Supervisor 与 DAG 调度 | 预留模型 | 原型 | 必须 |
| 子 Agent 并行与 Artifact 交换 | 预留模型 | 原型 | 必须 |
| 远程/分布式执行 | 不支持 | 评估 | 可选，非默认 |

## 6. 技术选型

### 6.1 固定选型

| 层次 | 选型 | 理由 |
| --- | --- | --- |
| 语言 | TypeScript，严格模式 | 桌面、CLI、核心共享类型和实现 |
| 运行时 | Node.js LTS | 模型、MCP 和本地工具生态完整 |
| 包管理 | pnpm workspace/monorepo | 明确包边界和依赖方向 |
| 桌面 | Electron | Node 与核心同进程体系，避免 P0 引入 Tauri sidecar |
| UI | React | 生态成熟，适合桌面和复杂执行视图 |
| 数据校验 | Zod | 内部类型、持久化输入和扩展配置统一校验 |
| 本地数据库 | SQLite | 本地优先、事务、低运维成本 |
| 模型适配 | 厂商 SDK 与 OpenAI 兼容 Adapter | 避免绑定单一 Provider |
| 外部工具 | MCP SDK | 标准化连接工具生态 |
| 日志追踪 | 结构化日志；OpenTelemetry 为 P1 | P0 保持轻量，后续可关联 Run/ToolCall |
| 测试 | Vitest、Playwright | 覆盖核心、进程集成和 UI E2E |

### 6.2 Electron 进程约束

- Main Process：运行 Runtime、数据库、Provider、工具宿主和系统能力。
- Renderer Process：只运行 React UI，禁用 Node Integration，启用 Context Isolation。
- Preload：暴露最小、强类型、基于 Promise/事件流的 IPC Interface。
- Renderer 不得接收 Provider 密钥、任意文件系统句柄或原始进程句柄。
- 所有 IPC 输入即使在内部调用也必须进行 schema 校验。

### 6.3 依赖方向

允许：

```text
app / desktop / cli → core → domain
providers / tools / storage → core 的公开 Interface
core 的组合根 → providers / tools / storage 的 Adapter
```

禁止：

- `core` 的业务逻辑直接 import React、Electron 或某个厂商 SDK。
- Provider Adapter import Tool Implementation。
- UI 直接 import SQLite 或文件工具。
- 子 Agent 绕过 Runtime 直接创建另一个子 Agent。

依赖方向可通过 ESLint 边界规则和包级 `package.json` exports 强制检查。

## 7. 系统架构

```text
┌───────────────────────────────┐
│ React UI / CLI                │
└───────────────┬───────────────┘
                │ typed commands + event stream
┌───────────────▼───────────────┐
│ Application Composition Root  │
└───────┬───────────┬───────────┘
        │           │
┌───────▼──────┐  ┌─▼──────────────┐
│ AgentRuntime │  │ Session/Query  │
│ Run lifecycle│  │ read models    │
└──┬────┬────┬─┘  └────────────────┘
   │    │    │
   │    │    └───────────────┐
   │    ▼                    ▼
   │ ┌──────────────┐   ┌───────────┐
   │ │ Context      │   │ RunStore  │
   │ │ Manager      │   │ SQLite    │
   │ └──────────────┘   └───────────┘
   ▼
┌──────────────┐      ┌──────────────┐
│ Model        │      │ ToolRuntime  │
│ Provider Port│      │ Policy/Budget│
└──────────────┘      └──────┬───────┘
                             │
                    ┌────────┼─────────┐
                    ▼        ▼         ▼
                 Built-in   MCP    Extension Host

P2: AgentRuntime 通过同一入口创建 child Run；
    SupervisorPolicy + DAG Scheduler 负责依赖、并发与汇总。
```

## 8. 核心 Module 与 Interface

以下代码是架构契约示意，不要求逐字作为最终源码，但语义必须保持。

### 8.1 AgentRuntime

AgentRuntime 是最核心的深 Module。调用者只需启动 Run、发送控制命令、读取快照和订阅事件；模型循环、重试、持久化、工具编排和恢复均隐藏在 Implementation 内。

```ts
export interface AgentRuntime {
  start(request: StartRunRequest): Promise<RunSnapshot>;
  command(runId: string, command: RunCommand & { commandId: string }): Promise<RunSnapshot>;
  get(runId: string): Promise<RunSnapshot>;
  events(runId: string, afterSeq?: number): AsyncIterable<RunEvent>;
}

export type RunCommand =
  | { type: "pause" }
  | { type: "resume" }
  | { type: "cancel"; reason?: string }
  | { type: "approve"; approvalId: string }
  | { type: "reject"; approvalId: string; reason?: string }
  | { type: "answer"; requestId: string; answer: string };
```

约束：

- `start` 必须同步持久化初始 Run 后才能启动模型调用。
- 所有状态迁移必须由 Runtime 内部完成并追加 Event。
- `command` 必须幂等处理重复 `commandId`；传输层需要附带命令 ID。
- `events` 支持断线后按 `afterSeq` 重放。
- Runtime 不得把厂商 SDK 的原始消息类型暴露给 UI。
- P2 的 `StartRunRequest` 复用本 Interface，通过 `parentRunId`、`taskId` 和 `agentDefinitionId` 创建子 Run，不新增平行运行时。

### 8.2 ModelProvider

```ts
export interface ModelProvider {
  capabilities(model: string): Promise<ModelCapabilities>;
  stream(request: ModelRequest): AsyncIterable<ModelEvent>;
}
```

`ModelRequest` 使用 Joymind 内部规范化消息和工具定义。`ModelEvent` 至少包括文本增量、工具调用增量/完成、用量、完成原因和规范化错误。

Provider Implementation 负责：

- 厂商消息格式转换。
- 流式增量拼接和工具参数完整性处理。
- 速率限制和可重试错误的规范化。
- 密钥读取和脱敏。
- 模型能力探测或静态能力声明。

Provider 不负责 Run 状态、上下文裁剪、工具执行或权限审批。

### 8.3 ToolRuntime

```ts
export interface ToolRuntime {
  list(scope: ToolScope): Promise<ToolDescriptor[]>;
  execute(call: ToolCallRequest, context: ToolContext): Promise<ToolResult>;
}
```

ToolRuntime 内部统一完成：

1. 参数 schema 校验。
2. Workspace、权限和预算检查。
3. 审批创建与等待。
4. 超时和取消。
5. 输出大小限制与敏感信息脱敏。
6. ToolCall 状态及审计事件持久化。
7. 幂等键、重试和副作用不确定性处理。

Tool 不得直接写 Run 状态，也不得自行决定暂停或终止整个 Run。

### 8.4 RunStore

RunStore 是内部持久化 Seam，P0 至少具有 SQLite 和内存测试 Adapter。它必须提供事务化追加 Event、更新物化状态和查询恢复点的能力。业务代码不得拼接 SQL。

### 8.5 ContextManager

ContextManager 负责将 Session、Run Event、Artifact 引用和工具结果构造为模型请求。它必须隐藏：

- Token 预算与消息优先级。
- 工具输出的截断和摘要。
- 系统 Prompt 与 AgentDefinition 的合成。
- 父子 Run 之间的显式上下文传递。
- 模型上下文窗口差异。

禁止把所有历史消息无限制地传给模型，也禁止子 Agent 默认继承父 Agent 的完整对话。

## 9. Run 状态机与执行协议

### 9.1 状态

```text
queued
  → running
  → waiting_for_approval | waiting_for_input | paused
  → running
  → completed | failed | cancelled | interrupted
```

状态定义：

- `queued`：已持久化，尚未开始执行。
- `running`：模型或工具正在推进任务。
- `waiting_for_approval`：存在一个或多个阻塞审批。
- `waiting_for_input`：需要用户补充信息。
- `paused`：用户或系统暂停，不启动新的模型/工具步骤。
- `completed`：目标完成，最终结果和 Artifact 已记录。
- `failed`：在重试和恢复策略后仍无法完成。
- `cancelled`：用户或上级 Run 取消。
- `interrupted`：进程退出或崩溃导致无法自然继续，需要恢复处理。

### 9.2 状态不变量

- 每个 Run 同时只能有一个权威状态。
- 进入终态后不得自动回到 `running`；继续工作必须创建新 Run 或显式恢复操作。
- `waiting_for_approval` 时不得执行对应工具。
- `paused` 或 `cancelled` 后不得启动新的模型请求或工具调用。
- 取消正在运行的工具时，必须区分“已停止”“拒绝停止”和“结果未知”。
- 状态迁移和 Event 必须在同一数据库事务中提交。
- 所有终态必须记录 `finishReason`。

### 9.3 标准 Agent 循环

1. 校验 AgentDefinition、Workspace、Provider 和预算。
2. ContextManager 构造模型请求。
3. 持久化模型请求元数据，调用 Provider 流式接口。
4. 将文本、工具调用和用量写入 Run Event。
5. 如果没有工具调用，则依据完成条件结束或继续。
6. 对工具调用进行 schema、策略、预算和审批检查。
7. 执行工具，记录结构化结果或错误。
8. 将结果加入上下文，进入下一轮。
9. 达到步数、Token、费用、时间或无进展阈值时停止，并给出可诊断原因。

### 9.4 取消和超时

- 用户取消后，UI 必须在 500 ms 内显示“正在取消”的反馈；该指标不包含强制终止外部进程所需时间。
- Provider 请求和工具必须接收 `AbortSignal`。
- 工具未响应协作式取消时，宿主可以终止其进程树。
- 已产生副作用的工具不得因为取消而被静默标记为未执行。

### 9.5 恢复

- 启动时扫描非终态 Run。
- 可以安全继续的 Run 从最后已提交 Event 恢复。
- 正在执行的副作用 ToolCall 若无法确认结果，进入 `unknown`，Run 标记为 `interrupted`。
- 自动重试仅适用于明确无副作用或具有可靠幂等保证的操作。

## 10. Event 与消息模型

### 10.1 Event 信封

```ts
export interface RunEvent<T = unknown> {
  id: string;
  runId: string;
  seq: number;
  type: string;
  occurredAt: string;
  actor: "user" | "agent" | "tool" | "system";
  payload: T;
  correlationId?: string;
  causationId?: string;
}
```

- `seq` 在同一 Run 内严格递增，用于 UI 重放和去重。
- `correlationId` 关联同一模型请求或 ToolCall。
- `causationId` 表示因果来源，P2 可追踪父子任务。
- Event 只追加，不原地修改；快照是可重建的查询优化。

### 10.2 P0 Event 类型

- `run.started`、`run.paused`、`run.resumed`、`run.completed`、`run.failed`、`run.cancelled`、`run.interrupted`
- `message.user`、`message.assistant.delta`、`message.assistant.completed`
- `model.requested`、`model.completed`、`model.failed`
- `tool.requested`、`tool.approval_required`、`tool.started`、`tool.output`、`tool.completed`、`tool.failed`
- `approval.approved`、`approval.rejected`
- `artifact.created`
- `budget.updated`、`budget.exceeded`

### 10.3 日志与隐私

Event 必须满足查询和恢复需要，但不得默认持久化完整密钥、认证头或未脱敏环境变量。大文本和二进制内容存入 Artifact，Event 只保留引用、大小、媒体类型和摘要。

## 11. 模型 Provider 规范

### 11.1 P0 要求

- 支持一个通用 OpenAI 兼容 Adapter。
- 支持至少一个使用独立消息格式的真实 Adapter，以证明 Seam 有效；若发布范围缩减，必须在发布说明中明确。
- 支持流式文本、工具调用、取消、用量统计和错误规范化。
- Provider 和模型配置与 AgentDefinition 分离。
- 模型不可用时提供明确错误，不得无限重试。

### 11.2 能力声明

```ts
export interface ModelCapabilities {
  streaming: boolean;
  toolCalling: boolean;
  structuredOutput: boolean;
  vision: boolean;
  maxContextTokens?: number;
  maxOutputTokens?: number;
}
```

Runtime 必须根据能力选择协议路径。不支持工具调用的模型不得假装支持完整 Agent 模式，可以降级为纯对话并明确提示。

### 11.3 重试策略

- 网络中断、限流和服务端临时错误可以指数退避并加入随机抖动。
- 参数错误、认证失败和模型不存在不得自动重复请求。
- 重试次数、总耗时和退避上限受 Run Budget 限制。
- 每次尝试必须记录，但密钥和认证头必须脱敏。

### 11.4 密钥

- 优先使用操作系统安全存储；不支持时明确提示风险。
- 密钥不得进入 SQLite、Run Event、普通日志、崩溃报告或前端状态。
- UI 只显示是否已配置和必要的掩码信息。

## 12. 工具系统与安全策略

### 12.1 工具定义

```ts
export interface ToolDefinition<I, O> {
  name: string;
  version: string;
  description: string;
  inputSchema: Schema<I>;
  outputSchema: Schema<O>;
  risk: "read" | "write" | "execute" | "network" | "external";
  capabilities: string[];
  idempotency: "safe" | "idempotent" | "unknown";
  execute(input: I, context: ToolContext): Promise<O>;
}
```

工具名称必须全局唯一并带命名空间，例如 `fs.read`、`fs.write`、`shell.exec`、`mcp.files.read`。

### 12.2 P0 内置工具

| 工具 | 默认风险 | 默认策略 |
| --- | --- | --- |
| `fs.read` | read | Workspace 内允许 |
| `fs.list` | read | Workspace 内允许 |
| `fs.search` | read | Workspace 内允许 |
| `fs.write` | write | 审批并展示 Diff |
| `fs.delete` | write | 每次审批，禁止递归默认授权 |
| `shell.exec` | execute | 每次审批，展示命令和工作目录 |
| `web.fetch`（若启用） | network/external | 域名策略与审批 |

P0 可以不启用 `web.fetch`，但 Policy 模型必须支持网络能力。

### 12.3 决策结果

```text
allow | deny | require_approval
```

决策必须综合：Workspace、AgentDefinition、Tool capability、目标路径/域名、用户策略、父 Run 权限和当前预算。最终权限只能是父权限的子集。

### 12.4 路径与命令安全

- 所有文件路径必须规范化并解析符号链接后再检查作用域。
- 禁止仅通过字符串前缀判断路径包含关系。
- Workspace 外访问默认拒绝。
- Shell 不使用模型生成的权限参数绕过宿主策略。
- 终端必须控制环境变量传递，默认不注入全部宿主环境。
- 高风险命令不能仅依靠正则黑名单保证安全；需要用户审批，后续使用 OS Sandbox。
- 工具输出必须限制字节数、行数和执行时间，超限结果截断为 Artifact 引用。

### 12.5 审批

审批请求至少展示：

- Tool 名称和版本。
- 人类可读的操作说明。
- 参数摘要、目标路径/命令/域名。
- Diff 或影响范围（适用时）。
- 风险等级和来源 Agent。
- 本次允许、拒绝；策略支持的范围内可以“同类允许”。

“同类允许”必须具有明确作用域和有效期，禁止默认转化为整个会话无限授权。

### 12.6 工具结果

```ts
export interface ToolResult {
  status: "success" | "error" | "cancelled" | "unknown";
  content: Array<
    | { type: "text"; text: string }
    | { type: "artifact"; artifactId: string }
  >;
  error?: NormalizedError;
  metadata: {
    durationMs: number;
    truncated: boolean;
    retryable: boolean;
  };
}
```

## 13. 上下文、记忆与 Artifact

### 13.1 上下文优先级

从高到低：

1. 安全与系统约束。
2. 当前用户目标和未解决的审批/输入。
3. 当前步骤相关的工具结果。
4. 最近对话。
5. 历史摘要。
6. 可选长期记忆或检索内容。

裁剪时不得丢失未处理 ToolCall 与对应结果的配对关系。

### 13.2 记忆分级

- Run Memory：当前执行上下文，P0 必须。
- Session Memory：会话摘要和关键用户决定，P0 基础支持。
- Workspace Memory：用户明确保存的项目事实，P1。
- Global Memory：默认关闭，P1 评估。

长期记忆必须可查看、编辑、删除和禁用。不得把工具输出默认永久保存为“事实”。

### 13.3 Artifact

Artifact 用于保存大输出、文件、Diff、报告和结构化任务结果。每条记录包含 ID、来源 Run、媒体类型、大小、校验和、存储位置和可选保留期。

P2 子 Agent 之间优先通过 Artifact 和明确消息交换结果，不共享可随意读写的隐藏内存。

## 14. AgentDefinition 与扩展体系

### 14.1 AgentDefinition

```yaml
apiVersion: joymind.dev/v1alpha1
kind: AgentDefinition
metadata:
  id: coding-assistant
  version: 1.0.0
  name: Coding Assistant
spec:
  model:
    provider: default
    model: user-selected
  prompt:
    template: builtin://coding-assistant
  tools:
    allow:
      - fs.read
      - fs.list
      - fs.search
      - fs.write
      - shell.exec
  budget:
    maxSteps: 40
    maxToolCalls: 60
    maxWallTimeMinutes: 30
  runtime:
    mode: single
```

约束：

- 配置加载必须通过 Zod 或等价 schema 校验。
- 未知字段默认拒绝，避免拼写错误被静默忽略。
- AgentDefinition 声明的是权限上限，不代表自动获得权限。
- Prompt、模型和工具版本变更应提升定义版本。
- `builtin://` 指向应用内置资源；文件引用需要 Workspace/Extension 权限。

### 14.2 扩展类型

P1 支持：

- Tool Extension。
- Provider Extension。
- AgentDefinition Pack。
- MCP Server 配置。

P0 只保证内置注册接口稳定，不承诺任意第三方代码安全沙箱。

### 14.3 Extension Manifest

```yaml
apiVersion: joymind.dev/v1alpha1
kind: Extension
metadata:
  id: example.tools
  version: 1.0.0
spec:
  runtime: node-worker
  entry: dist/index.js
  permissions:
    - tools.register
  contributes:
    tools:
      - example.lookup
```

扩展必须声明版本、最低宿主版本、权限和贡献点。安装前展示权限，升级增加权限时必须重新确认。

### 14.4 Extension Host

- P1 使用独立 Worker/Process，禁止在 Electron Main 中直接执行不受信扩展。
- 宿主通过版本化消息协议调用扩展，设置超时、内存和输出限制。
- 扩展崩溃不得破坏数据库和 Run Event。
- 扩展不能获得任意 IPC、密钥库或其他扩展的私有状态。
- P2 的 Agent Extension 仍须通过 AgentRuntime 创建 Run，不能直接操作调度器内部结构。

### 14.5 版本兼容

- Interface 使用语义化版本。
- `v1alpha1` 可以按文档声明发生破坏性变化；稳定 `v1` 不允许。
- 主版本不兼容时，宿主必须拒绝加载并说明原因。
- 扩展发现、注册和执行错误不得导致整个应用无法启动；禁用故障扩展并显示诊断。

## 15. MCP 支持

P1 必须支持 MCP Client，优先 stdio，本地 Server 由用户明确启用。

- MCP Tool 映射到统一 ToolDescriptor，并保留原始 Server 和 Tool 标识。
- 所有 MCP 调用仍经过 ToolRuntime、Policy 和 Budget。
- Server 启动命令、工作目录和环境变量必须可见且可配置。
- 环境变量默认最小化传递，禁止自动继承全部敏感变量。
- 工具列表变化通过版本化快照通知 Run，不在单次模型请求中静默变化。
- Server 无响应必须受超时和取消控制。
- MCP 的权限声明只是元数据，不能替代宿主策略。
- Streamable HTTP 等远程传输在后续阶段加入，并增加 Origin、认证和网络策略。

## 16. Super Agent 架构与演进

### 16.1 定义

本 SPEC 将 Super Agent 定义为：一个 Supervisor 在统一权限和预算下，动态分解目标、选择专家 Agent、调度有依赖关系的 Task、聚合 Artifact，并对整体结果负责的编排架构。它不是单纯增加 Agent 数量，也不要求每个步骤都由模型决定。

### 16.2 核心结构

```text
User Goal
   │
   ▼
Supervisor Run
   ├── Plan / TaskGraph
   ├── Budget & Policy envelope
   ├── Scheduler
   │      ├── child Run: Researcher
   │      ├── child Run: Implementer
   │      └── child Run: Reviewer
   ├── Artifact exchange
   └── Final synthesis / verification
```

### 16.3 与单 Agent 共用的基础

P0 数据模型必须预留：

- `Run.parentRunId`、`Run.rootRunId`。
- `Run.agentDefinitionId`。
- `Run.mode`，初始值为 `single`。
- 可选 `taskId` 和依赖元数据。
- Artifact 的来源 Run 引用。
- 层级 Budget 和 Policy 的约束语义。

P0 不需要实现 TaskGraph UI、动态 Agent 市场或分布式调度。

### 16.4 TaskGraph

Task 至少包括：

```ts
export interface TaskSpec {
  id: string;
  title: string;
  objective: string;
  dependsOn: string[];
  agentDefinitionId?: string;
  inputArtifactIds: string[];
  acceptanceCriteria: string[];
  budget: Budget;
}
```

- TaskGraph 必须是有向无环图（DAG）。
- Task 状态包括 `pending`、`ready`、`running`、`blocked`、`succeeded`、`failed`、`cancelled`。
- 依赖失败时，后续 Task 默认阻塞，不得无条件执行。
- Scheduler 根据依赖、并发限制、Provider 限流和资源预算调度。
- 确定性依赖和调度由代码保证，不依赖 Supervisor 自觉遵守。

### 16.5 层级预算与权限

- 子 Run 的 Token、费用、时间、工具次数和最大深度从父 Run 预算中分配。
- 所有后代消耗必须汇总到 Root Run。
- 子 Run 只能收窄权限，不能扩大权限。
- 根 Run 达到预算上限时，必须停止创建新子 Run，并按策略取消或收尾现有子 Run。
- 必须设置 `maxDepth`、`maxChildren`、`maxParallelRuns` 和 `maxTotalRuns`，防止递归膨胀。

P2 默认建议值：`maxDepth = 2`、`maxParallelRuns = 3`、`maxChildren = 8`；实际默认值需经评测调整。

### 16.6 上下文隔离

- 每个子 Agent 有独立消息历史和上下文预算。
- 父 Agent 只传递目标、必要输入 Artifact、约束和验收条件。
- 子 Agent 返回结构化摘要、Artifact 引用、用量和失败原因。
- 禁止所有 Agent 无限制读写同一个对话数组。
- 必须支持对同一输入重建各子 Run 的审计链。

### 16.7 并行与副作用冲突

- 只读研究任务默认可并行。
- 写同一 Workspace 的任务不得默认并行。
- P2 编程场景可以通过独立 worktree、临时目录或资源锁隔离写操作。
- 合并必须由显式步骤完成，并展示 Diff 和冲突。
- ToolRuntime 需要资源锁声明，例如 `workspace:<id>:write`。
- 调度器不能把“模型决定并行”视为安全性证明。

### 16.8 监督、终止与反死循环

Supervisor 只能在以下情况继续分解：

- 新 Task 有明确目标和验收条件。
- 新 Task 不重复现有 Task 的语义目标。
- 剩余预算足够。
- 深度和子任务数未超限。
- 最近步骤产生了可验证的新信息。

出现以下情况必须停止或请求用户介入：重复计划、无进展、验收持续失败、子 Agent 互相无限委派、预算不足或权限不足。

### 16.9 Super Agent 完成条件

- 所有必要 Task 已终态。
- 验收条件已由工具或独立验证步骤检查。
- 失败和未验证项必须明确披露。
- Supervisor 汇总不得把子 Agent 的声明当作已验证事实。
- 最终结果必须链接关键 Artifact 和子 Run。

### 16.10 暂不采用的能力

除非有明确产品需求，P2 仍不默认加入：去中心化 Agent 自由通信、跨设备分布式执行、自动安装任意 Agent、Agent 自主扩权、无预算递归规划。

## 17. 数据模型与持久化

### 17.1 主要实体

| 表/实体 | 关键字段 |
| --- | --- |
| workspaces | id、name、root_path、created_at、last_opened_at |
| sessions | id、workspace_id、title、created_at、updated_at |
| runs | id、session_id、parent_run_id、root_run_id、agent_definition_id、mode、status、version、timestamps |
| run_events | run_id、seq、id、type、payload_json、occurred_at |
| messages | id、session_id、run_id、role、content_ref、created_at |
| tool_calls | id、run_id、tool_name、status、args_ref、result_ref、risk、timestamps |
| approvals | id、tool_call_id、decision、scope、expires_at、decided_at |
| artifacts | id、run_id、kind、path、mime、size、checksum、created_at |
| tasks（P2） | id、root_run_id、depends_on_json、status、assigned_run_id |
| extensions | id、version、enabled、permissions_json、install_source |
| schema_migrations | version、applied_at |

具体 SQL 由 Implementation 决定，但外键、唯一约束和索引必须满足以下要求：

- `(run_id, seq)` 唯一。
- Event 按 `run_id, seq` 查询高效。
- 子 Run 按 `parent_run_id` 查询高效。
- ToolCall、Approval 和 Artifact 可按 Run 查询。
- JSON 字段保留 schema 版本，迁移不能依赖当前内存结构强转旧数据。

### 17.2 一致性与并发

- SQLite 启用适合桌面单写者的 WAL 模式。
- 状态迁移使用事务和 Run 版本检查，避免重复 UI 命令覆盖状态。
- 大 Artifact 不写入 SQLite BLOB，除非后续有明确理由。
- Event 写入数据库成功后才能对外发布，避免 UI 看见无法恢复的状态。
- 数据库损坏时不得删除用户数据自动重建；进入恢复/导出流程。

### 17.3 数据位置与生命周期

- 数据目录遵循操作系统应用数据规范。
- Workspace 文件不因创建 Session 而被复制到应用目录。
- 支持删除 Session、Run 和关联 Artifact。
- 删除操作展示影响范围；外部工具已产生的副作用无法随数据库删除而撤销。
- P1 支持脱敏导出和备份。

## 18. UI/UX 规范

### 18.1 主要页面

P0：

1. Workspace 与会话列表。
2. 对话和 Run 执行视图。
3. ToolCall 时间线。
4. 审批对话框和 Diff 视图。
5. Provider/模型设置。
6. AgentDefinition 与预算设置。
7. 历史 Run 和错误详情。

P2 增加 TaskGraph、子 Agent 树、并发状态和 Artifact 浏览。

### 18.2 执行视图

- 区分用户消息、Agent 文本、工具调用、审批和系统事件。
- 流式文本不能掩盖工具风险和错误。
- 每个工具调用展示状态、耗时、参数摘要和输出。
- 长输出默认折叠，可查看完整 Artifact。
- 暂停、恢复和取消按钮必须反映真实状态，而不是仅修改 UI。
- Super Agent 模式下默认展示汇总，可下钻到任一子 Run。

### 18.3 审批体验

- 审批对话框必须是不可忽略的显式状态。
- 默认焦点不能落在高风险“允许”按钮上。
- 拒绝后允许用户给出原因，并作为 Run 输入。
- 多个子 Agent 的审批必须显示来源和根目标，避免用户失去上下文。

### 18.4 可访问性与本地化

- 关键操作支持键盘。
- 状态不能仅通过颜色表达。
- P0 文案采用可外部化资源，不将 UI 字符串散落硬编码。
- 时间、路径和错误显示适配 Windows、macOS、Linux。

## 19. CLI 规范

P0 最小命令：

```bash
joymind run "任务描述" --workspace . --agent coding-assistant
joymind runs list
joymind runs show <run-id>
joymind runs events <run-id>
joymind runs cancel <run-id>
joymind providers list
joymind tools list
```

- 默认输出适合终端；`--json` 提供稳定机器可读输出。
- 交互审批必须在 TTY 中明确展示；非交互模式默认拒绝需要审批的工具，除非提供作用域明确的策略文件。
- CLI 与桌面端不得通过复制 Agent 循环实现。
- 退出码至少区分成功、用户取消、执行失败、配置错误和需要审批。

## 20. 错误模型

### 20.1 分类

- `configuration_error`：配置或 AgentDefinition 无效。
- `authentication_error`：认证失败。
- `permission_denied`：策略拒绝。
- `approval_required`：需要用户审批。
- `rate_limited`：Provider 或工具限流。
- `timeout`：超过步骤或工具超时。
- `cancelled`：主动取消。
- `provider_error`：模型服务异常。
- `tool_error`：工具执行异常。
- `budget_exceeded`：预算耗尽。
- `conflict`：并发状态或写资源冲突。
- `internal_error`：未预期错误。

### 20.2 规范化错误

```ts
export interface NormalizedError {
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
  causeRef?: string;
}
```

- UI 显示可行动的信息，不只显示堆栈。
- 内部日志保留关联 ID 和必要堆栈，但必须脱敏。
- 扩展错误使用同一模型，不得把任意对象直接跨 IPC 传递。

## 21. 非功能需求

### 21.1 性能

在常规开发机、本地 SQLite、无模型网络耗时的条件下：

- UI 本地命令反馈 P95 小于 100 ms。
- Run Event 从提交到本地 UI 可见 P95 小于 200 ms。
- 10 万条 Event 的会话列表仍能分页查询，禁止一次性加载全部事件。
- 工具输出有明确大小上限，避免长输出阻塞 Renderer。
- 冷启动目标 P95 小于 3 秒；超过时展示可诊断的启动阶段。

以上指标不将模型生成时间计入应用开销。

### 21.2 可靠性

- 每次状态迁移持久化后再对外可见。
- 应用异常退出不损坏已提交 Run。
- Provider、MCP 和 Extension 故障相互隔离。
- 所有外部调用必须有超时和取消路径。
- 数据库迁移在升级前提供备份或可恢复策略。

### 21.3 可维护性

- 核心 Module 测试只通过公开 Interface 进行。
- 核心逻辑不依赖真实模型即可完整测试。
- 每个 Adapter 的协议转换集中在自身 Module 内。
- 禁止跨包导入内部路径。
- 公共 Interface 的变更需要更新 SPEC 和迁移说明。

### 21.4 可移植性

- 支持当前主流 Windows、macOS 和 Linux 桌面版本。
- P0 至少完整验证 Windows；其他平台在发布矩阵中如实标注。
- 路径、进程树终止、密钥存储等 OS 差异集中在 Adapter。
- CLI 不应假设 Bash 在全部平台可用。

### 21.5 隐私与遥测

- 默认不发送遥测。
- 若后续加入遥测，必须明确选择加入，列出字段并提供关闭方式。
- 模型请求所发送的内容应在设置和文档中可理解。
- 诊断导出默认脱敏，不包含密钥。

## 22. 可观察性与评测

### 22.1 日志

结构化日志至少包含：`runId`、`sessionId`、`toolCallId`、`provider`、`model`、`durationMs`、`status` 和错误码。日志不得包含密钥、完整认证头或默认未脱敏的用户内容。

### 22.2 指标

P0 本地统计：

- Run 成功率、取消率、失败率和恢复率。
- 每 Run 模型轮数、Token、估算费用和耗时。
- 工具失败率、审批率、平均耗时。
- 无进展终止和预算耗尽次数。

P2 增加：

- 每 Root Run 的子 Agent 数量和并行度。
- Task 重试、重复计划和冲突次数。
- Super Agent 相对单 Agent 的成功率、成本和延迟增量。

### 22.3 评测集

建立版本化真实任务集，至少包括：

- 纯问答和无需工具的任务。
- 单文件、多文件读取与修改。
- 命令成功、失败、超时和取消。
- 工具参数错误、Provider 限流和进程崩溃。
- 用户拒绝审批和修改目标。
- 大输出截断与 Artifact 恢复。
- P2 的 DAG 依赖、并行只读、写冲突和预算传播。

每次发布记录模型、Prompt、AgentDefinition、工具和评测集版本。不能把不同配置下的成功率直接比较。

## 23. 测试与验收策略

### 23.1 测试层级

1. Domain/Core 单元测试：状态机、预算、上下文、策略和迁移。
2. Contract 测试：所有 Provider、Tool 和 Store Adapter 遵循同一 Interface。
3. 集成测试：真实 SQLite、流式模型模拟、MCP 进程和工具取消。
4. Electron/CLI E2E：从用户输入到审批、工具执行和最终 Artifact。
5. 故障注入：崩溃、重复事件、断流、超时、磁盘错误和扩展崩溃。
6. 安全测试：路径逃逸、符号链接、恶意工具输出、IPC 非法输入和密钥泄漏。

### 23.2 P0 发布门槛

必须端到端验证：

- 创建 Workspace 和 Session。
- 使用至少两个 Provider Adapter 完成流式对话。
- 使用工具完成一次真实 Workspace 修改。
- 写操作未经审批不能执行。
- Diff、终端输出和错误可查看。
- 暂停、恢复、取消和重启恢复行为符合状态机。
- 桌面与 CLI 复用核心并能读取同一数据格式。
- 数据库升级迁移保留旧 Run。
- 全部自动化测试、类型检查和构建通过。

### 23.3 P2 发布门槛

- 用同一 Runtime 完成至少三级中的两层父子 Run，且达到深度限制后停止。
- 并行只读 Task 不相互覆盖状态。
- 写冲突被锁或隔离机制阻止。
- 子 Agent 无法扩大父权限或突破根预算。
- 任一子 Agent 失败不会丢失其他 Task 的审计记录。
- 可取消整个 Root Run，并正确处理正在执行的副作用。
- Super Agent 相对单 Agent 的增益通过同一评测集量化。

## 24. 构建、发布与依赖治理

### 24.1 标准工程命令

实现仓库后统一提供：

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
pnpm eval
```

命令必须可通过 CI 重复执行。不得仅依赖开发者本机全局工具。

### 24.2 发布产物

- Windows、macOS、Linux 桌面安装包按验证进度发布。
- CLI npm 包或独立二进制。
- 版本化 AgentDefinition/Extension schema。
- Release Notes、迁移说明和第三方许可声明。

### 24.3 依赖许可证

- Joymind 第一方源码采用 MIT。
- 默认接受 MIT、Apache-2.0、BSD、ISC 等宽松许可依赖，但仍需保留必要声明。
- 引入 GPL、AGPL、SSPL 或专有许可依赖前必须单独评审。
- 不得因复制上游代码而静默改变其原始许可义务。
- 生成并分发第三方许可清单；MIT 不授予 Joymind 商标权。

## 25. 分阶段实施路线

### M0：工程骨架与领域契约

交付：monorepo、核心类型、Event/Run schema、SQLite 迁移、内存 Store、测试基础。

验收：不依赖 UI 和真实模型即可执行确定性模拟 Run，状态迁移可重放。

### M1：单 Agent 垂直闭环

交付：Provider Adapter、AgentRuntime、文件与终端工具、CLI、审批和预算。

验收：CLI 能完成真实文件修改任务，取消和崩溃恢复符合规范。

### M2：桌面可用版本

交付：Electron、React 会话视图、Diff、设置、历史记录、安全密钥存储。

验收：通过 P0 全部发布门槛和平台验证矩阵。

### M3：扩展生态

交付：MCP Client、Extension Manifest、隔离 Extension Host、AgentDefinition Pack、诊断导出。

验收：第三方工具崩溃不影响主进程；扩展权限变更需重新确认。

### M4：Super Agent

交付：Supervisor、DAG Scheduler、父子 Run、层级预算、Artifact 交换、子 Agent UI、写隔离。

验收：通过 P2 发布门槛，并证明相对单 Agent 在目标任务上有可量化收益。

## 26. 关键 ADR 决策

### ADR-001：P0 使用 Electron 而非 Tauri

选择 Electron，因为核心 Runtime 为 Node.js/TypeScript，P0 需要大量本地进程、MCP 和文件集成。Tauri 会要求额外 Rust 宿主或 Node sidecar。未来如安装体积成为主要问题，可新增桌面 Adapter，但不得改变 Core Interface。

### ADR-002：自研轻量 Agent 循环，不依赖重型编排框架

核心状态、安全和恢复是产品差异化能力。P0 使用明确的内部状态机；后续可以引入框架作为 Implementation，但不能让框架类型泄漏到公开 Interface。

### ADR-003：不可变 Event + 物化状态

Event 提供审计、恢复和 UI 重放；物化状态提供高效查询。不是完整事件溯源系统，外部副作用仍按不确定性处理。

### ADR-004：Super Agent 复用父子 Run

不创建独立多 Agent Runtime。子 Agent 是具有父引用、独立上下文和预算的普通 Run，降低核心分叉和测试成本。

### ADR-005：扩展权限由宿主执行

Prompt、MCP 元数据和扩展声明均不是授权依据。只有宿主 Policy、ToolRuntime 和操作系统机制能够执行权限。

## 27. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| Provider 格式差异导致核心复杂 | 规范化 ModelRequest/Event，厂商差异留在 Adapter |
| Event 数据快速增长 | Artifact 外置、分页、保留策略、索引与压缩评估 |
| 工具输出包含 Prompt Injection | 标记为不可信数据，权限不来自输出，高风险操作仍需审批 |
| Shell 工具破坏用户环境 | 默认审批、作用域、最小环境、超时；后续 OS Sandbox |
| 第三方扩展执行恶意代码 | 默认不启用、权限展示、进程隔离；明确进程隔离不等于完整 Sandbox |
| Super Agent 成本和延迟失控 | 根预算、深度/并发限制、无进展检测、与单 Agent 对照评测 |
| 并行写任务冲突 | 默认串行、资源锁、worktree/临时目录、显式合并 |
| 过早抽象造成维护负担 | 只有真实变化点建立 Seam，通过 Module 删除测试审查浅抽象 |
| MIT 与上游许可混淆 | 依赖扫描、NOTICE/第三方清单、引入前评审 |

## 28. 明确保留的产品决策

以下决策不阻塞 P0 核心开发，但在对应里程碑前必须确定：

- 首个非 OpenAI 兼容 Provider 的具体厂商。
- P0 默认模型、上下文预算和费用估算方式。
- Windows 之外的发布优先级。
- Extension Host 的具体隔离强度和签名策略。
- Workspace 长期记忆的默认保留期限。
- Super Agent 的专家 Agent 初始集合及默认调度策略。
- 是否增加远程 Runtime；若增加，必须另行完成认证、加密和远程副作用威胁建模。

## 29. 规范完成定义

一份 Implementation 只有满足以下条件，才能声明符合本 SPEC：

1. 对应阶段的所有“必须”需求已实现。
2. 用户原始场景通过真实模型或明确标注的确定性测试 Provider 完成端到端验证；真实发布必须使用真实 Provider 再验收。
3. 构建、类型检查、测试和 E2E 全部通过。
4. 权限、取消、恢复和迁移有实际验证证据。
5. 公共 Interface、schema、文档和迁移说明保持一致。
6. 未实现或平台受限能力在发布说明中明确披露，不得宣称为已支持。
