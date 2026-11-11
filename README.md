# Joymind

Joymind 是一个本地优先、模型无关、工具可扩展的 Agent 工具软件。用户可以在明确的权限与预算约束下，通过自然语言完成文件、终端及其他工具支持的任务，并审查完整执行过程。

项目采用“**核心自控、外围复用**”的路线：自行实现 Agent 循环、任务状态、权限、上下文和恢复机制，复用成熟的模型协议、SQLite 与桌面生态，并为未来的 Super Agent 编排保留统一运行时。

> **当前状态：权限模式与产品化版（0.4.0），不是完整 P0 发布。** 已实现 Core、CLI、Electron/React 桌面代码，以及三种权限审批模式、通用偏好、运行详略视图、安全 Markdown 渲染和中英文系统菜单；M3/M4 尚未实现。外部厂商真实 API、非 Windows 平台和签名安装包发布状态以验收记录为准。

## 文档入口

- [软件规格说明书（SPEC）](./SPEC.md)：产品需求、架构契约、安全、数据模型、Super Agent 和验收标准。
- [开发任务清单（TASKS）](./TASKS.md)：面向编码开发 Agent 的任务依赖、交付物、验收标准和执行批次。
- [MIT 许可证](./LICENSE)：第一方源码许可。

## 当前能力

### 多模型与双语体验

- 内置 OpenAI、DeepSeek、Anthropic、Google Gemini、Moonshot Kimi、阿里 Qwen、智谱 GLM、自定义 OpenAI 兼容端点和离线 Scripted Provider。
- 点击“获取模型列表”读取账户实际可用模型，支持 Anthropic/Gemini/Qwen 分页、自定义模型 ID、Base URL 覆盖、连接测试和最近选择持久化。
- 当前回退预设按 2026-11-11 官方资料更新；DeepSeek 使用 `deepseek-flash` / `deepseek-v4-pro`，不再推荐已停用的旧 ID。完整来源见 [Provider 模型目录调研](./docs/provider-model-catalog.md)。
- 桌面与 CLI 支持简体中文/English 切换；桌面默认跟随系统语言并记住选择。
- 原生文件夹选择、首次使用引导、示例目标和缺少配置时的操作提示。
- API 密钥使用 Electron 异步 safeStorage 加密保存，也可使用环境变量；密钥不进入偏好文件。
- 设置中的“获取模型列表”、连接测试和模型选择结果均按 Provider 协议处理，不伪造不支持的在线目录。

### 权限审批模式与通用偏好

- 支持三种权限模式：
  - **询问（Ask）**：每个非只读工具调用都逐次审批，保持默认安全行为。
  - **自动（Auto）**：Agent 对每个非只读调用显式给出 `execute`/`ask` 评估及原因；只有合法的 `execute` 才免审批，缺失、非法或选择 `ask` 时失败关闭并进入审批。
  - **自主（Autonomous）**：用户启动前委托本次 Run，非只读工具不再逐次审批，但仍受 Workspace、工具白名单、预算、取消和工具安全策略约束。
- Run 事件与快照记录本次实际权限模式；自动模式还记录评估原因，便于审计。
- 通用偏好支持默认权限模式、运行过程“详细/简略”显示，以及工具时间线显隐；简略模式只隐藏已完成工具的参数、Diff 和输出摘要，审批卡片始终完整显示。
- Assistant 回复以渲染后的 Markdown 呈现（GFM 标题、列表、代码块、表格、链接等），并经过 DOMPurify 消毒；脚本、样式注入和外部图片被禁止，链接仅允许 HTTP(S) 并通过系统浏览器打开。
- Electron 系统菜单提供中文/English 的文件、编辑、视图、语言、帮助菜单，语言切换即时生效并持久化。

### 单 Agent 与本地工具

- 流式响应、文件读取/搜索/写入、写前 Diff 和终端执行。
- 三种权限模式、高风险操作审批、暂停、恢复、取消、超时和预算控制。
- SQLite/Memory Store、Run Event、Artifact 元数据和中断恢复。
- 桌面端与 CLI 共用同一个 AgentRuntime。

### 后续扩展与 Super Agent

以下属于 M3/M4 规划，当前尚未实现：MCP、第三方 Extension Host、Supervisor、TaskGraph、并行子 Agent 和写隔离。

Super Agent 的既定设计包括：

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

## 快速开始

要求 Node.js 22.12+ 和 pnpm 11。首次 Electron E2E 会下载 Electron 二进制。

```bash
pnpm install
pnpm build
pnpm dev
```

构建 Windows unpacked 桌面包（输出到 `packages/desktop/release/win-unpacked`）：

```bash
pnpm dist
```

桌面端打开后，可在右上角切换中文/English，也可使用顶部“语言”菜单切换；系统菜单会随当前语言即时更新。通过“设置”选择 Provider，输入或选择模型（可点击“获取模型列表”读取账户实际可用模型），保存密钥并测试连接。在“通用”偏好中设置默认权限模式、运行过程详略和工具时间线显隐。回到主界面选择项目文件夹、描述目标并启动；本次权限模式会显示在输入框附近，历史 Run 标题也会显示快照中的实际模式。文件写入、删除和 Shell 命令是否等待审批取决于当前权限模式：`ask` 逐次审批，`auto` 仅在 Agent 给出合法 `execute` 评估时免审批，`autonomous` 在启动前一次性委托后不再逐次询问。Assistant 的最终回复会按 Markdown 渲染，点击其中链接会交给系统浏览器打开。Scripted 离线演示无需密钥，但只用于熟悉运行流程，不会替代真实模型完成任务。

CLI 离线冒烟与 Provider 目录：

```bash
node packages/cli/dist/index.js run "检查当前项目" --workspace . --locale zh-CN
node packages/cli/dist/index.js providers list
```

DeepSeek 示例：

```bash
DEEPSEEK_API_KEY=<你的密钥> node packages/cli/dist/index.js run "检查当前项目" --workspace . --provider deepseek --model deepseek-flash --locale zh-CN
```

CLI 的 `run` 子命令同样支持 `--permission ask|auto|autonomous`（默认 `ask`）；权限模式会写入 AgentDefinition 与 Run 快照。

| Provider | 密钥环境变量 | Base URL 环境变量 |
| --- | --- | --- |
| OpenAI | `OPENAI_API_KEY` | `OPENAI_BASE_URL` |
| DeepSeek | `DEEPSEEK_API_KEY` | `DEEPSEEK_BASE_URL` |
| Anthropic | `ANTHROPIC_API_KEY` | `ANTHROPIC_BASE_URL` |
| Google Gemini | `GEMINI_API_KEY` | `GEMINI_BASE_URL` |
| Moonshot Kimi | `MOONSHOT_API_KEY` | `MOONSHOT_BASE_URL` |
| Qwen / DashScope | `DASHSCOPE_API_KEY` | `DASHSCOPE_BASE_URL` |
| Zhipu GLM | `ZHIPUAI_API_KEY` | `ZHIPUAI_BASE_URL` |
| 自定义 OpenAI 兼容 | `OPENAI_COMPATIBLE_API_KEY`（可选） | `OPENAI_COMPATIBLE_BASE_URL`（必需） |

所有 Provider 均可用 `--model <模型ID>` 覆盖预设。桌面设置中的 Base URL 留空时使用官方端点；自定义兼容端点必须填写 URL。点击“获取模型列表”可读取当前账户实际可用模型，再选择和保存；静态预设仅用于回退。

Qwen 的在线获取还需要单独填写“模型列表 Base URL”，例如 `https://<workspace>.cn-beijing.maas.aliyuncs.com`，用于 `/api/v1/models` 管理接口；聊天仍使用兼容端点。智谱 GLM 暂无已文档化的模型列表 API，因此保留最新静态预设与手工输入。

偏好保存于桌面用户数据目录的 `preferences.json`，加密密钥单独保存于 `private/provider-secrets.json`。在线模型列表仅在当前设置会话中缓存，不写入 Run/Event。

## 验证命令

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
pnpm eval
```

E2E 使用独立临时 Workspace、数据库、桌面用户数据目录和本地 HTTP/SSE 服务，覆盖未审批零副作用、审批后真实文件修改、历史持久化、Electron IPC 与 Renderer 隔离、DeepSeek 模型连接、双语切换、偏好重载、三种权限模式、Markdown/XSS 防护和中英文系统菜单。

## 安全与隐私原则

- 模型只能提出工具调用意图，不能自行授权。
- 写文件、删除、Shell 和网络操作由宿主 Policy 强制执行约束。
- 默认使用 Workspace 作用域、最小环境变量和高风险操作审批。
- 密钥不写入 SQLite、Run Event 或普通日志；已保存密钥不回传 Renderer，新密钥仅通过专用 IPC 临时提交给 Electron Main。
- 工具输出属于不可信数据，不能通过 Prompt Injection 扩大权限。
- 默认不发送遥测；长期记忆和外部工具需要用户明确控制。
- Provider 默认拒绝 HTTP 重定向，避免自定义认证头被转发到其他源。

已知边界：当前路径校验不能抵御本地攻击者在校验和使用之间切换符号链接/junction 的竞态；不要把可被不可信进程并发修改的目录作为 Workspace，后续需要原生目录句柄或 OS Sandbox。CLI 与桌面使用同一默认数据库，但不提供跨进程实时事件推送；重新选择或刷新 Run 可读取最新事件。

外部厂商 API（包括 DeepSeek）需要持有效密钥单独验收；自动化中的协议服务是本地 HTTP/SSE 测试服务器，不代表外部厂商已验证。模型预设不是实时模型目录，若厂商调整模型，可直接输入新的模型 ID。

安全模型和威胁缓解详见 [SPEC 第 12、14、15、21、27 节](./SPEC.md)。

## 许可证

Joymind 第一方源码采用 [MIT License](./LICENSE)。分发时仍需遵守第三方依赖各自的许可义务；MIT 许可证不授予 Joymind 商标权。
