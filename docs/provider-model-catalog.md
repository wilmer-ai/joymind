# Provider 模型目录与模型列表 API 调研

- **核对日期：2026-11-11（UTC+8）**。本报告中的“当前”“最新”均以该日期为准。
- 范围：OpenAI、DeepSeek、Anthropic、Google Gemini、Moonshot Kimi、阿里云百炼 Qwen/DashScope、智谱 GLM；同时核对 `packages/providers/src/catalog.ts` 中已有预设。
- 只采用服务商官方文档、官方 API 规范、官方 SDK/代码仓库和官方发布记录。未使用第三方模型聚合站作为事实依据。
- 本次是文档与公开 API 规范调研，**未使用真实 API Key 调用列表接口**。因此，文档所述接口契约已核对，但具体账号、地域、套餐实际可见的模型仍应以在线返回为准。
- Google 的 `ai.google.dev` / `aistudio.google.com` 页面在当前网络环境下无法直接连接；Gemini 部分改用 Google 官方 `googleapis` API  proto 规范、官方 `google-gemini` 文档仓库及 Google 官方博客交叉核对。无法直接复核的内容单独标明，不作猜测。

## 关键结论

1. **DeepSeek 用户指出的问题已被官方资料证实，而且不仅是“预设不是最新”**：`deepseek-chat` 和 `deepseek-reasoner` 已于 **2026-07-24 停用**。当前直连 DeepSeek API 的模型 ID 是 `deepseek-flash` 与 `deepseek-v4-pro`。[DeepSeek 模型与价格](https://api-docs.deepseek.com/quick_start/pricing)、[DeepSeek 更新日志](https://api-docs.deepseek.com/updates/)
2. `DeepSeek-V3.2`、`DeepSeek-V4.1-Flash-1017` 是**模型版本/展示版本**，不能直接当作 DeepSeek 官方 API 的当前模型 ID。历史上 `deepseek-chat` / `deepseek-reasoner` 分别指向 V3.2 的非思考/思考模式；当前 `deepseek-flash` 指向 V4.1 Flash 最新版本。[DeepSeek 更新日志](https://api-docs.deepseek.com/updates/)
3. 仓库中 Kimi 的三个预设 `kimi-k2-0905-preview`、`moonshot-v1-32k`、`moonshot-v1-128k` 均被官方明确列为“已下线”。当前应关注 `kimi-k3.1-pro`、`kimi-k3.1-pro-highspeed`、`kimi-k3`。[Kimi 模型列表](https://platform.kimi.com/docs/models)
4. OpenAI、DeepSeek、Anthropic、Gemini、Kimi、阿里百炼均有官方模型列表 GET 接口；**智谱 GLM 官方文档索引和主 OpenAPI 规范中未找到模型目录列表接口**，不能因其兼容 OpenAI Chat Completions 就假定支持 `GET /models`。
5. 阿里百炼的模型发现接口是带业务空间和地域的 **`/api/v1/models`**，不是 OpenAI 兼容路径下的 `/models`；官方明确说明 OpenAI 兼容端点不提供后者。[百炼查询模型列表](https://help.aliyun.com/zh/model-studio/list-models)、[百炼接入说明](https://help.aliyun.com/zh/model-studio/deepseek-harness)

## 对“点击从服务商获取模型列表”的约束

- 可优先实现统一 `id` 提取，但响应解析不能完全统一：OpenAI/DeepSeek/Kimi 使用 `data[]`，Anthropic 使用 `data[]` 加游标，Gemini 使用 `models[]` 加 `nextPageToken`，百炼使用 `output.models[]` 加页码。
- 必须实现分页的服务至少包括 Anthropic、Gemini 和百炼；只取第一页会得到不完整目录。
- 列表是账号、项目、业务空间、地域和套餐视角下的目录，不等于所有公开模型，也不保证每个模型都支持当前应用所用的推理端点。应保留客户端能力筛选，例如 Gemini 的 `supportedGenerationMethods`、百炼的 `capabilities` / `features`。
- GLM 应保留手工模型 ID/静态目录回退，并说明“官方未提供已文档化的模型列表接口”，不要伪造在线获取成功。
- 静态预设仍适合作为默认推荐和回退，但不应覆盖在线目录；旧 ID 是否可继续调用要以生命周期信息和在线列表共同判断。

---

## 1. OpenAI

官方来源（访问日期均为 2026-11-11）：[模型选择](https://platform.openai.com/docs/models)、[List models API](https://platform.openai.com/docs/api-reference/models/list)、[模型弃用与停用](https://platform.openai.com/docs/deprecations)。

### 当前推荐与旧 ID

- 官方模型选择页当前建议：复杂推理和编码使用 **`gpt-6-astra`**；智能/成本平衡使用 **`gpt-6.1-sol`**；成本敏感和高吞吐使用 **`gpt-6-luna`**。同页还列出 **`gpt-6.1-terra`**。
- 仓库旧预设仍属于 API ID，但已经不是当前推荐：
  - `gpt-5`、`gpt-5-mini` 已弃用，官方列出的停用日期为 **2026-12-11**；访问日尚未到该日期。
  - `gpt-4.1`、`gpt-4.1-mini` 已弃用，官方列出的停用日期为 **2027-01-14**；访问日尚未到该日期。
- “尚未停用”不等于“仍推荐”。应从默认预设移除旧模型，并根据账号实际列表决定是否保留为可选项。

### 模型列表接口

- **Endpoint**：`GET https://api.openai.com/v1/models`
- **鉴权头**：`Authorization: Bearer $OPENAI_API_KEY`
- **响应结构**：顶层为 `{ "object": "list", "data": [...] }`；每项至少包含 `id`、`object: "model"`、`created`（Unix 秒）、`owned_by`。官方弃用文档还说明可通过模型对象的可选 `shutdown_date` 检查已宣布的停用日期。
- **分页/过滤**：该 List models 参考页未列出查询参数、分页游标或过滤参数；不要自行套用其他 OpenAI 列表接口的 `limit` / `after` 语义。返回项可能具有不同模态和端点能力，需按应用所需能力另外筛选。

---

## 2. DeepSeek

官方来源（访问日期均为 2026-11-11）：[模型与价格](https://api-docs.deepseek.com/quick_start/pricing)、[更新日志](https://api-docs.deepseek.com/updates/)、[获取模型列表](https://api-docs.deepseek.com/zh-cn/api/list-models)。

### 当前推荐与旧 ID

| API 模型 ID | 当前对应模型版本 | 说明 |
| --- | --- | --- |
| `deepseek-flash` | `DeepSeek-V4.1-Flash-1017` | 当前 Flash API 名称；支持思考和非思考模式 |
| `deepseek-v4-pro` | `DeepSeek-V4-Pro-0813` | 当前 Pro API 名称 |

- **`deepseek-chat` / `deepseek-reasoner` 已停用**。官方 2026-04-24 更新记录明确写明两个旧 API 名称将在三个月后即 **2026-07-24** 停用；当前模型页也不再列出它们。
- 2025-12-01 的历史记录只表示当时两个 API ID 已升级到 DeepSeek-V3.2：`deepseek-chat` 对应非思考模式，`deepseek-reasoner` 对应思考模式。**这不表示 `DeepSeek-V3.2` 是可直接填入 `model` 的 API ID，也不表示两个旧 ID 现在仍有效。**
- 另有兼容别名 `deepseek-v4-flash`、`deepseek-v4-flash-vision-exp` 暂被接受并路由到当前 Flash，但原对应模型已退役；它们也不应作为新预设。
- 阿里云等第三方服务上的 DeepSeek 模型 ID 属于该第三方目录，不能与 DeepSeek 官方直连 API 的 ID 混用。

### 模型列表接口

- **Endpoint**：`GET https://api.deepseek.com/models`（注意没有 `/v1` 前缀）。
- **鉴权头**：`Authorization: Bearer ${DEEPSEEK_API_KEY}`。
- **响应结构**：顶层 `{ "object": "list", "data": [...] }`；每项必有 `id`、`object: "model"`、`owned_by`，还可包含 `name`、`context_window`、`max_output_tokens`、`input_modalities`、`output_modalities`、`effort`、`api_capabilities`。元数据不可得时字段可能缺省。
- **分页/过滤**：官方规范未列出查询参数、分页或过滤机制；按完整当前列表处理，不要假设支持 `limit` 或游标。

---

## 3. Anthropic

官方来源（访问日期均为 2026-11-11）：[模型概览](https://docs.anthropic.com/en/docs/about-claude/models/overview)、[模型选择](https://docs.anthropic.com/en/docs/about-claude/models/choosing-a-model)、[List Models API](https://docs.anthropic.com/en/api/models-list)、[生命周期与弃用](https://docs.anthropic.com/en/docs/about-claude/model-deprecations)、[API 发布记录](https://docs.anthropic.com/en/release-notes/api)。

### 当前推荐与旧 ID

- 官方当前建议多数工作负载从 **`claude-opus-5-5`** 开始；更高难度推理和长程 Agent 工作可选 **`claude-fable-5-2`**。
- 其他当前主力 ID：**`claude-sonnet-5-5`**（速度与智能平衡）、**`claude-haiku-5-5`**（高吞吐、低延迟）。Fable 5.2 于 2026-11-09 发布，不能沿用旧报告或旧 SDK 中的 Fable 5 / 5.1 预设。
- 仓库旧预设状态：
  - `claude-sonnet-4-5`：别名所指向的 `claude-sonnet-4-5-20250929` 已于 2026-09-30 弃用，但仍可调用，计划 **2026-11-30** 退役。
  - `claude-opus-4-1`：对应 `claude-opus-4-1-20250805` 已于 **2026-08-05** 退役，请求会失败。
  - `claude-haiku-4-5`：对应快照 `claude-haiku-4-5-20251001` 在官方状态表中仍为 Active；但已不是最新 Haiku。
- Anthropic 的 alias 与带日期快照不能混为一谈；当前 Models API 的 `lifecycle` 是判断 active / deprecated / retired 的直接依据。

### 模型列表接口

- **Endpoint**：`GET https://api.anthropic.com/v1/models`
- **鉴权/版本头**：官方当前示例使用 `Authorization: Bearer $ANTHROPIC_API_KEY`；`anthropic-version` 为可选版本头（示例值 `2026-10-21`）。可跨 Workspace 的凭据还可使用可选 `anthropic-workspace-id`。
- **响应结构**：顶层为 `data[]`、`first_id`、`last_id`、`has_more`。`data[]` 包含 `type: "model"`、`id`、`display_name`、`created_at`、`lifecycle`、`deprecated_at`、`retires_at`、`line`、`capabilities`、`max_input_tokens`、`max_tokens` 等。
- **分页**：`limit` 默认 20，范围 1–1000；用 `after_id` / `before_id` 双向游标翻页，`has_more` 判断对应方向是否还有结果。较新模型排在前面。
- **过滤**：`lifecycle` 可重复/多值传入 `active`、`deprecated`、`retired`，最多 3 个。缺省只返回 active 和 deprecated；**retired 必须显式请求**。不要从 `id` 推测系列，应该使用响应中的 `line`。

---

## 4. Google Gemini

官方来源（访问日期均为 2026-11-11）：[Google 官方 Gemini API 开发指引仓库](https://github.com/google-gemini/gemini-skills/blob/main/skills/gemini-api-dev/SKILL.md)、[官方迁移参考](https://github.com/google-gemini/gemini-skills/blob/main/skills/gemini-api-dev/references/migration.md)、[Gemini 4 Carbon 发布公告](https://blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-4-carbon-now-available/)、[ListModels 官方 proto 规范](https://github.com/googleapis/googleapis/blob/master/google/ai/generativelanguage/v1beta/model_service.proto)、[Model 官方 proto 规范](https://github.com/googleapis/googleapis/blob/master/google/ai/generativelanguage/v1beta/model.proto)、[官方 Python SDK 鉴权实现](https://github.com/googleapis/python-genai/blob/main/google/genai/_api_client.py)。

### 当前推荐与旧 ID

- 当前最强模型为 **`gemini-4-carbon`**，适合复杂推理、编码和研究；官方 2026-11-10 公告称其已通过 Google AI Studio 的 Gemini API 付费层向开发者提供。
- 快速、均衡的 Agent/多模态选择为 **`gemini-3.8-flash`**；高吞吐、低成本选择为 **`gemini-3.5-flash-lite`**。
- 仓库旧预设 `gemini-2.5-pro`、`gemini-2.5-flash` 已不应作为默认模型。同一官方文档仓库的当前开发指引把 `gemini-2.5-*` 标为 **legacy and deprecated**；迁移参考又把二者放在 **Active Legacy Models（建议迁移）** 表中，推荐分别迁移到 `gemini-4-carbon`、`gemini-3.8-flash` 或 `gemini-3.5-flash-lite`。两处用词并不完全一致，本报告保留这一差异，不把“仍能调用”写成确定结论。
- **不确定项**：由于 Gemini deprecations/changelog 页面本次无法直接访问，本报告不给出 2.5 模型具体停用日期或未来重定向日期；实际账号是否仍返回/接受这些 ID 应通过 ListModels 和真实调用核实。Vertex AI / Gemini Enterprise 的生命周期也不能套用到 Gemini Developer API。

### 模型列表接口

- **Endpoint**：`GET https://generativelanguage.googleapis.com/v1beta/models`。
- **鉴权头**：`x-goog-api-key: $GEMINI_API_KEY`，不加 `Bearer`；官方 Python SDK 对 Gemini Developer API 的 HTTP 头实现与此一致。
- **响应结构**：JSON 顶层为 `models[]` 和可选 `nextPageToken`。模型项主要字段包括：
  - `name`：资源名，格式 `models/{model}`；
  - `baseModelId`：传给生成请求的基础模型 ID；
  - `version`、`displayName`、`description`；
  - `inputTokenLimit`、`outputTokenLimit`；
  - `supportedGenerationMethods`；
  - 以及温度/top-p/top-k 默认值和 `thinking` 等元数据。
- **分页**：`pageSize` 缺省 50，服务端每页最多 1000；将上一响应的 `nextPageToken` 作为下一请求的 `pageToken`，未返回该字段表示没有下一页。翻页时其他参数必须与产生 token 的请求一致。
- **过滤**：普通 `ListModelsRequest` 只有 `page_size` / `page_token`，**没有模型过滤参数**；`ListTunedModels` 的 `filter` 不属于普通模型列表。客户端应依据 `supportedGenerationMethods` 等字段筛选。

---

## 5. Moonshot Kimi

官方来源（访问日期均为 2026-11-11）：[当前模型与下线清单](https://platform.kimi.com/docs/models)、[列出模型 API](https://platform.kimi.com/docs/api/list-models)、[API 文档索引](https://platform.kimi.com/docs/llms.txt)。

### 当前推荐与旧 ID

- 当前旗舰：**`kimi-k3.1-pro`**；高速版：**`kimi-k3.1-pro-highspeed`**；上一代仍列在当前目录：**`kimi-k3`**。
- 仓库旧预设 `kimi-k2-0905-preview`、`moonshot-v1-32k`、`moonshot-v1-128k` **全部已下线**，不能继续作为 API 预设。
- `kimi-k2.7-code`、`kimi-k2.7-code-highspeed`、`kimi-k2.6` 已停止向新注册用户提供；2026-11-01 前注册的用户暂可继续使用，官方预计在 2026 年 12 月底全面下线。它们不适合作为新默认预设。
- 中国区 `platform.kimi.com` / `api.moonshot.cn` 与国际平台的 Key 不可混用；列表结果也受账号权限影响。

### 模型列表接口

- **Endpoint**：`GET https://api.moonshot.cn/v1/models`。
- **鉴权头**：`Authorization: Bearer $MOONSHOT_API_KEY`。
- **响应结构**：顶层 `{ "object": "list", "data": [...] }`；每项包含 `id`、`object: "model"`、`created`、`owned_by`，并可提供 `context_length`、`supports_image_in`、`supports_video_in`、`supports_reasoning`。
- **分页/过滤**：官方接口文档和该端点 OpenAPI 片段未列出查询参数、分页或过滤参数。不要额外发明 `limit` / `after`。
- 列表接口适合作为当前账号的可用性检查；若后续对话请求返回 `resource_not_found_error`，还需检查 ID 拼写和账号 tier。

---

## 6. 阿里云 Qwen / DashScope（百炼 Model Studio）

官方来源（访问日期均为 2026-11-11）：[文本生成与视觉理解模型选择](https://help.aliyun.com/zh/model-studio/text-generation-model/)、[查询模型列表](https://help.aliyun.com/zh/model-studio/list-models)、[模型上下架与更新](https://help.aliyun.com/zh/model-studio/newly-released-models)、[OpenAI 兼容 Chat API](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions)、[OpenAI 兼容端点限制](https://help.aliyun.com/zh/model-studio/deepseek-harness)。

### 当前推荐与旧 ID

- 官方当前选择：
  - 效果优先：**`qwen4-max-preview`**，但页面明确标注**仅 Token Plan**，不能作为所有按量计费账号的通用默认；
  - 均衡：**`qwen3.7-plus`**；
  - 成本优先：**`qwen3.8-flash`**；
  - 当前推荐表还列出 **`qwen3.8-max`**。
- 仓库旧 ID 仍出现在百炼官方 API 文档中，但已非首选：
  - `qwen-plus` 出现在旧版模型表中，官方更新记录也保留该 ID 及快照；
  - `qwen-turbo` 仍在模型更新记录中，属于 Qwen3 Turbo 系列；
  - `qwen3-max` 仍在官方更新记录和当前 OpenAI 兼容 Chat API 文档的支持范围中。
- 上述“文档仍列出”不等于所有地域/账号均可用。应使用 `model=<ID>` 精确查询目标业务空间，并参考 `inference_offline_info`；新预设应迁移到当前推荐系列。

### 模型列表接口

**专用模型管理 endpoint，不是 OpenAI 兼容 endpoint：**

| 地域 | Endpoint |
| --- | --- |
| 华北 2（北京） | `GET https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api/v1/models` |
| 新加坡 | `GET https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/api/v1/models` |
| 中国香港 | `GET https://{WorkspaceId}.cn-hongkong.maas.aliyuncs.com/api/v1/models` |
| 日本（东京） | `GET https://{WorkspaceId}.ap-northeast-1.maas.aliyuncs.com/api/v1/models` |
| 德国（法兰克福） | `GET https://{WorkspaceId}.eu-central-1.maas.aliyuncs.com/api/v1/models` |
| 美国（弗吉尼亚） | `GET https://dashscope-us.aliyuncs.com/api/v1/models` |

- **鉴权头**：`Authorization: Bearer $DASHSCOPE_API_KEY`；官方示例还带 `Content-Type: application/json`。
- **响应结构**：顶层含 `request_id`、`code`、`message`、`success` 和 `output`；`output` 包含 `total`、`page_no`、`page_size`、`models[]`。模型项使用 **`model`** 作为 API 模型 ID，并有 `name`、`description`、`provider`、`inference_provider`、`capabilities`、`features`、`published_time`、`inference_metadata`、`model_info`、`prices`、`equivalent_snapshot`、`inference_offline_info` 等。
- **分页**：`page_no` 从 1 开始，默认 1；`page_size` 默认 20。递增 `page_no` 直至覆盖 `output.total`。Python SDK 的分页对象为 `resp.models` / `resp.total_count`，字段与 HTTP 不同。
- **过滤**：
  - `name` 模糊搜索，`model` 按模型 ID 精确查询，`language` 控制返回语言；
  - `providers=qwen` 可限定千问，`capabilities=TG` 限定文本生成，`capabilities=Reasoning` 限定推理；
  - 还可按 `inference_providers`、`features`、`service_site`、`supports`、部署方式等过滤；
  - 多数组值重复参数名，例如 `capabilities=TG&capabilities=Reasoning`，语义为“文本生成或推理”；
  - `context_window` 是“**严格小于**指定值”过滤；`supports` 默认 `inference`。
- SDK 限制：官方说明 Python SDK `client.models.list()` 仅支持 `page_no`、`page_size` 和客户端侧当前页 `provider` 过滤；完整筛选应使用 HTTP API。
- **不要调用** `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/models`：官方明确说明百炼 OpenAI 兼容端点不提供 `GET /models`。Token Plan / Coding Plan 的模型可见性也应按各自套餐文档确认，不能假定上述业务空间接口覆盖所有套餐。

---

## 7. 智谱 GLM

官方来源（访问日期均为 2026-11-11）：[模型概览](https://docs.bigmodel.cn/cn/guide/start/model-overview)、[GLM-5.3](https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3)、[GLM-4.6](https://docs.bigmodel.cn/cn/guide/models/text/glm-4.6)、[GLM-4.5](https://docs.bigmodel.cn/cn/guide/models/text/glm-4.5)、[HTTP API 与鉴权](https://docs.bigmodel.cn/cn/guide/develop/http/introduction)、[官方文档索引](https://docs.bigmodel.cn/llms.txt)、[官方主 OpenAPI 规范](https://docs.bigmodel.cn/openapi/openapi.json)。

### 当前推荐与旧 ID

- 最新旗舰文本模型：**`glm-5.3`**；最新原生多模态系列：**`glm-5.3-flash`**、**`glm-5.3-flashx`**。
- `glm-5.3` 始终开启思考，不支持 `thinking.type: "disabled"`；从旧模型迁移时不能只换 ID，还需检查思考参数。
- 仓库旧预设：
  - `glm-4.6` 仍有官方模型与 API 调用文档，但已不是最新；
  - `glm-4.5` 仍有调用示例，但官方明确标注 **GLM-4.5 / GLM-4.5-X 即将下线**，建议迁移；
  - `glm-4.5-air` 仍在官方模型目录中，但应让位于当前系列。

### 模型列表接口：未找到官方接口

- 截至访问日，官方文档索引的“模型 API”只列出对话、异步结果、图像/视频、语音、向量等接口；官方主 OpenAPI 规范中也未列出普通模型目录的 `GET /models` 或 `GET /paas/v4/models`。文档中的“音色列表”“文件列表”“知识库列表”都不是模型目录。
- 因此本项的 **GET endpoint、响应结构、分页/过滤均为不适用/未提供**。不能把“支持 OpenAI SDK 的 Chat Completions”解释为支持 `client.models.list()`。
- 通用推理 API 的鉴权头仍为 `Authorization: Bearer YOUR_API_KEY`，Base URL 为 `https://open.bigmodel.cn/api/paas/v4/`；这只用于已文档化推理接口，不构成模型列表接口存在的证据。
- 实现上应使用官方模型概览维护静态回退并允许手工输入；若未来增加在线获取，需先找到新的官方接口规范，再补充响应契约。

---

## 建议的预设更新方向（不含实现）

| Provider | 建议默认/首选 | 其他当前选项 | 旧预设处理 |
| --- | --- | --- | --- |
| OpenAI | `gpt-6.1-sol`（均衡）或 `gpt-6-astra`（能力优先） | `gpt-6.1-terra`、`gpt-6-luna` | GPT-5 / 4.1 标记弃用并给迁移提示 |
| DeepSeek | `deepseek-flash` | `deepseek-v4-pro` | 移除已停用的 `deepseek-chat` / `deepseek-reasoner` |
| Anthropic | `claude-opus-5-5` | `claude-fable-5-2`、`claude-sonnet-5-5`、`claude-haiku-5-5` | 移除已退役 Opus 4.1；Sonnet 4.5 提示即将退役 |
| Gemini | `gemini-3.8-flash`（均衡）或 `gemini-4-carbon`（能力优先） | `gemini-3.5-flash-lite` | 2.5 标记 legacy，实际可见性在线核实 |
| Kimi | `kimi-k3.1-pro` | `kimi-k3.1-pro-highspeed`、`kimi-k3` | 移除三个已下线旧预设 |
| Qwen / 百炼 | `qwen3.7-plus`（通用按量场景） | `qwen3.8-max`、`qwen3.8-flash`；Token Plan 可选 `qwen4-max-preview` | Plus/Turbo/Qwen3-Max 保留为旧版而非默认，按业务空间查询 |
| GLM | `glm-5.3` | `glm-5.3-flash`、`glm-5.3-flashx` | 4.5 提示即将下线；无官方在线列表时保留静态/手工回退 |

以上只是模型目录与接口依据；实际更新默认模型前还应核对现有请求参数是否兼容，尤其是 GLM-5.3 的强制思考，以及 Gemini 新 Interactions API 与旧 `generateContent` 的参数差异。
