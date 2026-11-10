# Joymind 开发任务清单

本文将 [`SPEC.md`](./SPEC.md) 拆分为可分配给编码开发 Agent 的实施任务。任务以可审查、可测试的垂直切片为单位，不以“搭好某某框架”作为完成标准。

| 项目 | 内容 |
| --- | --- |
| 文档版本 | 0.1.0 |
| 对应 SPEC | JM-SPEC-001 0.1.0 |
| 当前阶段 | M0，尚未开始实现 |
| 目标 | 先交付可靠的单 Agent，再扩展桌面、Extension 和 Super Agent |

## 1. 编码开发 Agent 执行规则

1. 开始任务前阅读 `SPEC.md` 的相关章节、本任务及所有依赖任务。
2. 每次默认只领取一个任务；完成后更新任务状态、验证结果和必要的文档。
3. 不得为了减少工作量而删除 SPEC 的安全、恢复、迁移或端到端验收要求。
4. 发现 SPEC 矛盾或技术选型不可行时，先记录问题并提出变更，不得在 Implementation 中静默偏离。
5. 遵守现有包结构和依赖方向，不让 React、Electron、Provider SDK 或 SQLite 类型泄漏到 Core Interface。
6. 新代码使用 TypeScript 严格模式；外部输入必须通过 Zod 或等价 schema 校验。
7. 核心行为必须通过公开 Interface 测试；真实 Provider 测试与确定性 Fake Provider 测试分开。
8. 不在仓库中提交密钥、真实用户数据、模型响应中的敏感信息或本地配置。
9. 每个任务完成后至少运行与改动相关的测试、类型检查和 lint；里程碑完成时运行完整构建和 E2E。
10. 任务只有满足全部验收标准、验证通过且文档同步后才能标记为 `done`。

## 2. 状态与任务格式

任务状态使用：

- `todo`：尚未开始。
- `in_progress`：已领取，需注明开发 Agent 或分支。
- `blocked`：依赖未完成或存在外部阻塞，需注明原因。
- `done`：实现、测试、文档和审查均完成。

当前所有任务均为 `todo`。任务 ID 不因拆分子任务而复用；新增任务使用下一个未占用编号。

每个任务包含：

- **依赖**：开始前必须完成的任务。
- **范围**：允许修改的主要 Module 或目录。
- **交付**：必须产生的代码、配置或文档。
- **验收**：可验证的完成条件。
- **验证**：最低测试要求。

## 3. 总体依赖与并行策略

```text
M0 工程与领域基础
  → M1 单 Agent + CLI 垂直闭环
    → M2 Electron + React 桌面闭环
      → M3 MCP 与 Extension
        → M4 Super Agent

M0 内部：001 → 002 → 003/004 → 005/006
M1 内部：Provider、Tool、Context 可并行；008 必须最后集成
M2 内部：Electron 壳与 UI 基础可并行；E2E 必须最后集成
```

可以并行的任务必须使用独立分支或 worktree。共享 `SPEC.md`、公共类型、数据库 migration 和根构建配置时，需要显式协调，避免多个 Agent 同时重写。

## 4. M0：工程骨架与领域契约

### JM-M0-001：初始化 monorepo 与质量工具

- **依赖**：无。
- **范围**：根目录构建配置、`packages/*`、CI。
- **交付**：
  - pnpm workspace、TypeScript 严格模式和包 exports。
  - ESLint 依赖方向规则、格式化配置、Vitest 基础配置。
  - `packages/core`、`providers`、`tools`、`storage`、`app`、`desktop`、`cli` 的最小包结构。
  - GitHub Actions 或等价 CI，执行 install、lint、typecheck、test、build。
  - 根命令：`pnpm lint`、`typecheck`、`test`、`build`。
- **验收**：干净环境仅按照 README 即可完成安装和全量检查；Core 不依赖 React、Electron、Provider SDK。
- **验证**：CI 全绿；依赖方向违规的测试用例被 lint 拒绝。

### JM-M0-002：定义领域模型、配置 schema 与错误模型

- **依赖**：JM-M0-001。
- **范围**：`packages/core`。
- **交付**：
  - Workspace、Session、Run、RunEvent、ToolCall、Approval、Artifact、Budget 类型。
  - `RunStatus`、Tool 状态、`RunCommand`、NormalizedError。
  - `AgentDefinition` v1alpha1 Zod schema 和版本拒绝规则。
  - Run 的 `parentRunId`、`rootRunId`、`mode` 等 Super Agent 预留字段。
- **验收**：未知配置字段被拒绝；类型不包含任何厂商 SDK/Electron/SQLite 类型；状态与 SPEC 第 9 节一致。
- **验证**：合法/非法配置、Budget 默认值、状态枚举和错误规范化单元测试。

### JM-M0-003：实现 SQLite RunStore 与内存 Adapter

- **依赖**：JM-M0-002。
- **范围**：`packages/storage`、Core Store Interface。
- **交付**：
  - 统一 RunStore Interface、SQLite 和内存 Adapter。
  - `schema_migrations`、Workspaces/Sessions/Runs/Events/Messages/ToolCalls/Approvals/Artifacts 表。
  - `(run_id, seq)` 唯一约束、事务化 Event 追加与物化状态更新。
  - WAL、外键、分页查询和 Run 版本并发检查。
- **验收**：同一 Event 不会重复提交；非提交状态不可见；进程重开后可读取旧数据；两个 Adapter 通过同一 Contract 测试。
- **验证**：事务回滚、并发命令、重复 Event、分页和至少一次升级 migration 测试。

### JM-M0-004：实现 Run 状态机与幂等命令处理器

- **依赖**：JM-M0-002。
- **范围**：`packages/core`。
- **交付**：
  - SPEC 第 9 节状态迁移和不变量。
  - 带 `commandId` 的幂等 pause/resume/cancel/approve/reject/answer 命令。
  - `interrupted`、终态保护和 `finishReason`。
- **验收**：非法迁移被拒绝；重复命令无副作用；暂停/取消后无法启动新步骤。
- **验证**：状态转移表全覆盖、重复/乱序命令、终态写入和预算耗尽测试。

### JM-M0-005：实现 Event 发布、重放与查询模型

- **依赖**：JM-M0-003、JM-M0-004。
- **范围**：`packages/core`、`packages/storage`。
- **交付**：
  - `events(runId, afterSeq)` 重放和实时订阅。
  - 单调 `seq`、correlation/causation ID、订阅清理。
  - Run Snapshot 与 Event 的一致事务。
- **验收**：订阅者断线后不重不漏地重放已提交 Event；取消订阅无资源泄漏；UI 不可看到未提交状态。
- **验证**：多订阅者、断线重连、重复订阅、提交失败和高事件量分页测试。

### JM-M0-006：实现 Budget 与确定性模拟 Run

- **依赖**：JM-M0-004、JM-M0-005。
- **范围**：`packages/core`。
- **交付**：
  - Step、ToolCall、Token、费用、墙钟时间和无进展预算计数。
  - 不依赖真实模型的 Fake Provider 与模拟 Tool。
  - 从 `start` 到终态的确定性 AgentRuntime 骨架。
- **验收**：预算超限进入规定终态；给定相同 Fake 输入可重现 Event 序列；M0 不需要 UI。
- **验证**：预算边界、模拟完成/失败、重放和进程恢复测试。

### M0 里程碑验收

- 全部 JM-M0 任务为 `done`。
- 纯 Core 集成测试可以启动、暂停、恢复、取消和完成模拟 Run。
- SQLite 与内存 Store 均通过 Contract 测试。
- CI、类型检查、lint、测试和构建全绿。

## 5. M1：单 Agent 与 CLI 垂直闭环

### JM-M1-001：定义 Provider Contract 与流式归一化

- **依赖**：JM-M0-006。
- **范围**：`packages/providers`、Core Provider Interface。
- **交付**：
  - ModelRequest、ModelEvent、ModelCapabilities、Provider 配置 schema。
  - 文本和 ToolCall 流式拼接、取消、用量和完成原因。
  - Provider 错误分类与重试判定。
- **验收**：Core 只消费统一事件；不完整 ToolCall 不会被执行；取消传递到 Provider。
- **验证**： fragmented stream、断流、无效 JSON 参数、用量缺失和 AbortSignal 测试。

### JM-M1-002：实现 OpenAI 兼容 Provider Adapter

- **依赖**：JM-M1-001。
- **范围**：`packages/providers/openai-compatible`。
- **交付**：可配置 base URL、模型、密钥引用、超时和重试；支持流式文本、工具调用和能力声明。
- **验收**：通过真实兼容服务完成对话与工具调用；密钥不进入日志/Event；认证错误不无限重试。
- **验证**：Contract 测试、模拟限流/服务端错误，以及一个真实服务的手工或受控 CI 验收记录。

### JM-M1-003：实现第二类独立 Provider Adapter

- **依赖**：JM-M1-001。
- **范围**：新增独立 Provider 包。
- **交付**：采用不同消息格式的真实 Provider Adapter、配置文档和能力映射。
- **验收**：无需修改 AgentRuntime 即可切换 Provider；两个 Adapter 均通过 Contract 测试。
- **验证**：流式、工具、认证失败、限流、取消和模型能力降级测试。
- **备注**：具体厂商由 SPEC 第 28 节决策确定；未确定前此任务为外部决策阻塞，不得伪造支持。

### JM-M1-004：实现 ContextManager 与上下文裁剪

- **依赖**：JM-M0-006、JM-M1-001。
- **范围**：`packages/core`。
- **交付**：
  - 系统约束、AgentDefinition、当前目标、历史、Tool 结果的请求构造。
  - Token 估算、模型窗口适配、摘要和大输出 Artifact 引用。
  - ToolCall/ToolResult 配对保护。
- **验收**：超长历史不会超出配置窗口；未解决 ToolCall 不丢失配对；摘要不会覆盖安全指令。
- **验证**：不同窗口、长工具输出、摘要触发、配对完整性和 Prompt Injection 内容隔离测试。

### JM-M1-005：实现 ToolRuntime、Policy 与 Approval

- **依赖**：JM-M0-004、JM-M0-005。
- **范围**：`packages/core`、`packages/tools`。
- **交付**：
  - ToolDescriptor/ToolDefinition、注册、schema 校验、统一 ToolResult。
  - allow/deny/require_approval 决策、作用域和有效期。
  - Tool 超时、取消、预算、审计和输出限制。
- **验收**：模型不能绕过 Policy；审批前工具不执行；重复 ToolCall 不重复产生已确认的副作用。
- **验证**：权限矩阵、审批等待/拒绝、超时、取消、输出截断和恶意参数测试。

### JM-M1-006：实现 Workspace 文件工具

- **依赖**：JM-M1-005。
- **范围**：`packages/tools/fs`。
- **交付**：`fs.read`、`fs.list`、`fs.search`、`fs.write`、`fs.delete`；路径规范化、符号链接检查、Diff 和 Artifact。
- **验收**：Workspace 外路径默认拒绝；写和删按策略审批；写入结果可追溯；不会因前缀路径判断产生逃逸。
- **验证**：`..`、绝对路径、符号链接、长文件、二进制、并发写和删除保护测试。

### JM-M1-007：实现 Shell 工具与进程控制

- **依赖**：JM-M1-005。
- **范围**：`packages/tools/shell`、OS Adapter。
- **交付**：`shell.exec`、审批展示、工作目录、最小环境、输出流、超时、取消和进程树终止。
- **验收**：每次默认审批；取消能停止子进程树；输出大小受限；密钥环境变量不默认注入。
- **验证**：成功/失败命令、长输出、超时、拒绝取消、Windows 与至少一个 POSIX 平台测试。

### JM-M1-008：集成完整 AgentRuntime 执行循环

- **依赖**：JM-M1-002、JM-M1-004、JM-M1-005、JM-M1-006、JM-M1-007。
- **范围**：`packages/core` 组合根。
- **交付**：模型→工具→观察→继续的闭环，重试、审批等待、取消、恢复和最终 Artifact。
- **验收**：可完成真实 Workspace 修改；暂停和拒绝行为正确；崩溃后副作用未知步骤标记 `unknown`，不静默重放。
- **验证**：Fake Provider 全流程、真实 Provider E2E、各阶段崩溃恢复和无进展终止测试。

### JM-M1-009：实现 CLI 与机器可读输出

- **依赖**：JM-M1-008。
- **范围**：`packages/cli`。
- **交付**：SPEC 第 19 节命令、TTY 审批、`--json`、退出码和非交互策略。
- **验收**：CLI 不复制 Agent 循环；非交互模式默认拒绝待审批操作；输出可被脚本解析。
- **验证**：CLI E2E、TTY/非 TTY、取消信号、退出码和 JSON schema 测试。

### JM-M1-010：建立版本化任务评测与故障注入

- **依赖**：JM-M1-008、JM-M1-009。
- **范围**：`evals`、测试工具、CI。
- **交付**：SPEC 第 22～23 节 P0 任务集、结果格式、配置清单和基线报告。
- **验收**：每次运行记录模型、Prompt、Agent、Tool 和评测集版本；能比较成功率、成本和耗时。
- **验证**：故障注入覆盖断流、限流、崩溃、超时、审批拒绝和大输出。

### M1 里程碑验收

- CLI 使用真实 Provider 完成至少一个真实文件修改任务。
- 默认策略下，未审批的写文件与 Shell 操作均不能执行。
- 取消、超时、拒绝、恢复和预算行为通过 E2E。
- 第二类 Provider 若仍未完成，M1 不得声明完整符合 SPEC，只能明确标记阶段受限。

## 6. M2：Electron 与 React 桌面闭环

### JM-M2-001：实现安全 Electron 壳与 IPC

- **依赖**：JM-M1-008。
- **范围**：`packages/desktop`。
- **交付**：Main/Preload/Renderer 分离、Context Isolation、禁用 Node Integration、强类型 IPC 和事件重连。
- **验收**：Renderer 无法直接访问 Node、数据库、密钥或任意进程；所有 IPC 输入经过校验。
- **验证**：非法 IPC 输入、刷新/重连、窗口关闭和 Main 异常测试。

### JM-M2-002：实现 React 应用状态与本地查询

- **依赖**：JM-M2-001、JM-M0-005。
- **范围**：`packages/app`。
- **交付**：Workspace/Session 列表、Run Snapshot、增量 Event reducer、分页和取消订阅。
- **验收**：UI 不成为权威 Run 状态；事件重放后视图一致；长列表不全量加载。
- **验证**：乱序/重复 Event、重连、分页和大量事件性能测试。

### JM-M2-003：实现对话与 Run 执行视图

- **依赖**：JM-M2-002。
- **范围**：`packages/app`。
- **交付**：用户输入、流式文本、ToolCall 时间线、错误、长输出折叠和 Run 控制。
- **验收**：暂停/恢复/取消反映真实状态；工具风险不被流式文本掩盖；关键操作支持键盘。
- **验证**：组件测试和 Playwright 对话→工具→完成/失败流程。

### JM-M2-004：实现审批、Diff 与终端输出 UI

- **依赖**：JM-M2-003。
- **范围**：`packages/app`、Preload IPC。
- **交付**：风险说明、参数摘要、Diff、允许/拒绝、同类授权作用域和终端视图。
- **验收**：高风险允许按钮不是默认焦点；拒绝原因进入 Run；审批过期和重复处理正确。
- **验证**：写文件、删除、Shell、并发审批和拒绝流程 E2E。

### JM-M2-005：实现 Provider 设置与 OS 密钥存储

- **依赖**：JM-M1-002、JM-M2-001。
- **范围**：`packages/app`、`packages/desktop`、OS Secret Adapter。
- **交付**：Provider/模型配置、密钥保存/删除、连接测试、掩码显示和无安全存储降级提示。
- **验收**：密钥不进入 SQLite、Renderer、日志和崩溃报告；配置错误可诊断。
- **验证**：密钥生命周期、日志扫描、Provider 切换和无效凭据测试。

### JM-M2-006：实现 Agent、预算和历史 Run 设置

- **依赖**：JM-M2-003。
- **范围**：`packages/app`。
- **交付**：AgentDefinition 选择/校验、Budget 设置、历史 Run、Event/Artifact 查看和 Session 删除。
- **验收**：非法配置不能启动；删除展示影响范围；历史记录可分页查询。
- **验证**：配置、预算边界、删除和大数据量 UI 测试。

### JM-M2-007：完成桌面打包、自动启动恢复与发布检查

- **依赖**：JM-M2-004、JM-M2-005、JM-M2-006。
- **范围**：桌面构建、CI、发布配置。
- **交付**：安装包、版本信息、迁移备份/恢复、启动时非终态 Run 扫描和发布说明。
- **验收**：Windows 安装包从干净环境完成完整场景；重启后 Run 可恢复或标记 interrupted；数据库升级保留历史。
- **验证**：干净机 E2E、升级/降级保护、崩溃恢复和安装包安全检查。

### JM-M2-008：执行 P0 发布验收与文档同步

- **依赖**：M2 其他全部任务、JM-M1-003、JM-M1-010。
- **范围**：全仓库。
- **交付**：SPEC 第 23.2 节逐项验收记录、平台支持矩阵、用户快速开始和已知限制。
- **验收**：两个 Provider、真实 Workspace 修改、审批、控制、恢复、迁移、桌面/CLI 数据兼容均有实际证据。
- **验证**：完整 `lint`、`typecheck`、`test`、`build`、`test:e2e`、`eval` 全绿。

### M2 里程碑验收

- 只有 JM-M2-008 完成后才能发布“完整 P0”。
- README 中的功能、平台和使用说明必须与实际产物一致。
- 不得把开发模式运行成功等同于安装包验收。

## 7. M3：MCP 与 Extension 生态

### JM-M3-001：实现本地 MCP stdio Client

- **依赖**：JM-M2-008。
- **范围**：`packages/tools/mcp`。
- **交付**：Server 配置、进程生命周期、Tool 发现、命名空间映射、超时、取消和工具快照。
- **验收**：所有 MCP 调用经过 ToolRuntime；Server 故障不破坏 RunStore；工具变化不在单次请求中静默发生。
- **验证**：真实 MCP Server 集成、崩溃、无响应、恶意描述和输出限制测试。

### JM-M3-002：实现 MCP 设置与最小环境变量策略

- **依赖**：JM-M3-001、JM-M2-005。
- **范围**：`packages/app`、`packages/desktop`。
- **交付**：Server 启停、命令/目录/环境展示、日志和权限设置。
- **验收**：默认不继承全部宿主环境；启动配置对用户可见；敏感值脱敏。
- **验证**：环境隔离、Server 重启、配置错误和密钥泄漏测试。

### JM-M3-003：实现 Extension Manifest、发现与兼容检查

- **依赖**：JM-M2-008。
- **范围**：`packages/extensions`、Core 注册 Interface。
- **交付**：Manifest schema、版本/权限/贡献点、安装启用状态和故障隔离。
- **验收**：不兼容扩展被拒绝；故障扩展不阻止应用启动；升级增加权限需重新确认。
- **验证**：版本矩阵、未知字段、权限升级和损坏扩展测试。

### JM-M3-004：实现隔离 Extension Host

- **依赖**：JM-M3-003。
- **范围**：`packages/extensions`、进程/Worker Adapter。
- **交付**：版本化消息协议、Tool/Provider 注册、超时、取消、输出和资源限制。
- **验收**：扩展不在 Electron Main 直接执行；扩展崩溃不损坏主进程；无法任意访问密钥和其他扩展状态。
- **验证**：崩溃、死循环、大数据、非法消息和权限绕过测试。

### JM-M3-005：实现 AgentDefinition Pack 与 Workspace Memory

- **依赖**：JM-M3-003。
- **范围**：Agent 配置、Artifact/Storage、设置 UI。
- **交付**：可安装 Agent Pack、Workspace Memory 查看/编辑/删除/禁用和保留策略。
- **验收**：Agent 权限上限不被安装过程自动授予；记忆可完全删除；版本冲突有诊断。
- **验证**：Pack 导入、权限收窄、记忆生命周期和迁移测试。

### JM-M3-006：实现脱敏诊断导出与备份

- **依赖**：JM-M3-001。
- **范围**：Storage、CLI、桌面设置。
- **交付**：Run 诊断包、Artifact 选择、密钥/敏感字段脱敏、备份和恢复说明。
- **验收**：导出不含密钥与认证头；用户能选择导出范围；备份恢复保留 Event 顺序。
- **验证**：敏感信息扫描、导出/恢复 round-trip 和损坏备份测试。

### M3 里程碑验收

- 安装一个真实本地 MCP Server 和一个测试 Extension，均完成端到端调用。
- 扩展故障、升级和权限变化均通过安全测试。
- 所有第三方能力默认关闭或由用户明确启用。

## 8. M4：Super Agent

### JM-M4-001：扩展父子 Run、Root Budget 与查询模型

- **依赖**：JM-M3-004。
- **范围**：Core、Storage、Event。
- **交付**：父/根 Run 关联、子 Run 创建、层级用量汇总、权限交集和最大深度/数量约束。
- **验收**：子 Agent 不能扩大父权限；所有后代消耗计入 Root；达到限制后拒绝创建新 Run。
- **验证**：多层树、预算竞争、取消传播、权限交集和恢复测试。

### JM-M4-002：实现 TaskGraph 与 DAG Scheduler

- **依赖**：JM-M4-001。
- **范围**：Core Scheduler、Storage Task 表。
- **交付**：TaskSpec、依赖校验、ready/running/blocked 状态、并发限制和失败传播。
- **验收**：环依赖被拒绝；依赖失败默认阻塞后续 Task；并发不超配置和 Provider 限制。
- **验证**：复杂 DAG、重复调度、失败/取消、进程恢复和确定性调度测试。

### JM-M4-003：实现 Supervisor AgentDefinition 与规划协议

- **依赖**：JM-M4-002。
- **范围**：Core、内置 Agent Pack。
- **交付**：结构化 Plan、验收条件、Task 去重、重新规划和无进展检测。
- **验收**：新 Task 有目标、验收和预算；重复计划/无限委派会停止或请求用户介入。
- **验证**：无效 Plan、重复 Task、预算不足、验收持续失败和人工介入测试。

### JM-M4-004：实现子 Agent 上下文与 Artifact 交换

- **依赖**：JM-M4-001。
- **范围**：ContextManager、Artifact Store。
- **交付**：显式输入 Artifact、结构化子 Run 摘要、结果引用和审计链。
- **验收**：子 Agent 不默认继承父完整对话；无共享可任意写消息数组；结果可追溯到来源。
- **验证**：上下文最小化、大 Artifact、父子恢复和敏感信息传递测试。

### JM-M4-005：实现资源锁与写 Workspace 隔离

- **依赖**：JM-M4-002、JM-M1-006。
- **范围**：ToolRuntime、Scheduler、FS/SCM Adapter。
- **交付**：Workspace 写锁、并行只读、写任务默认串行，以及编程场景的 worktree/临时目录隔离原型。
- **验收**：写同一资源不会无保护并行；合并展示 Diff/冲突；锁在取消和崩溃后可恢复。
- **验证**：竞争写、锁超时、进程崩溃、合并冲突和清理测试。

### JM-M4-006：实现 Super Agent UI 与层级审批

- **依赖**：JM-M4-003、JM-M4-004、JM-M4-005。
- **范围**：React、CLI、IPC。
- **交付**：TaskGraph、子 Agent 树、并发/预算状态、Artifact 浏览和带来源的审批。
- **验收**：用户可从 Root 下钻子 Run；取消 Root 正确传播；审批显示根目标和来源 Agent。
- **验证**：并行执行、子任务失败、审批阻塞、Root 取消和重启恢复 E2E。

### JM-M4-007：建立 Super Agent 对照评测与性能治理

- **依赖**：JM-M4-006。
- **范围**：`evals`、指标、CI。
- **交付**：单 Agent/Super Agent 同任务对照，记录成功率、Token、费用、延迟、子任务数和冲突。
- **验收**：目标任务上有量化结果；无收益或成本不可接受的场景明确不推荐 Super Agent。
- **验证**：DAG、并行只读、写冲突、预算传播、无限规划和取消故障注入。

### JM-M4-008：执行 P2 发布验收

- **依赖**：M4 其他全部任务。
- **范围**：全仓库。
- **交付**：SPEC 第 23.3 节逐项证据、Super Agent 用户文档、默认限制和已知风险。
- **验收**：父子层级、权限/预算、冲突、审计、Root 取消和副作用恢复全部实际验证。
- **验证**：全量测试、安装包 E2E、真实 Provider 场景和对照 eval。

## 9. 横向任务与持续要求

以下要求不是独立阶段，也不能留到最后补做：

### JM-X-001：安全审查

- 每个里程碑检查路径逃逸、Prompt Injection、Shell 风险、IPC、密钥、MCP 和 Extension 权限。
- 发现高风险问题时，对应里程碑不得完成。

### JM-X-002：文档与 SPEC 同步

- 公共 Interface、配置、CLI、数据库 schema 或许可依赖发生变化时，同步 README、SPEC、TASKS 和迁移文档。
- 实际行为与 SPEC 不一致时，不得只修改测试来掩盖偏差。

### JM-X-003：依赖与许可证治理

- 新依赖记录用途、版本和许可证。
- 发布产物包含第三方许可清单。
- GPL/AGPL/SSPL/专有许可依赖必须单独评审。

### JM-X-004：性能和容量回归

- M1 起覆盖长输出和事件分页；M2 起覆盖大量历史；M4 起覆盖并发和层级预算。
- 达到 SPEC 指标后才可标记对应性能任务完成。

## 10. 建议开发顺序与领取批次

### 批次 1：建立核心

顺序领取：`JM-M0-001 → JM-M0-002 → JM-M0-003/JM-M0-004 → JM-M0-005 → JM-M0-006`。

### 批次 2：打通 CLI

`JM-M1-001` 后，可并行领取 Provider、Context 和 ToolRuntime 任务；`JM-M1-008` 由单独 Agent 集成，避免多方同时修改核心循环。

### 批次 3：桌面产品化

先完成安全 IPC，再并行 UI 视图；密钥、审批和打包不可省略。`JM-M2-008` 独立进行全量验收。

### 批次 4：扩展与 Super Agent

M3 完成前不进入 M4。Super Agent 调度、Supervisor 和 UI 应分开实现，最后通过真实场景集成，避免一次性重写核心。

## 11. 每个开发 Agent 的完成汇报格式

```markdown
### 任务
- ID：<TASK-ID>
- 状态：done / blocked
- 变更摘要：<实现内容>

### 验收证据
- <对应验收标准及实际结果>
- <真实端到端场景及结果>

### 验证
- <执行的命令>
- <测试数量、构建结果、平台>

### 偏差与后续
- <SPEC 偏差、已知限制、新增任务；无则写“无”>
```

如果测试失败、真实 Provider 未验证、平台未覆盖或依赖决策未确定，任务不得报告为完全完成。
