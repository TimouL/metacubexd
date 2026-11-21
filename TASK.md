# 任务：在 metacubexd 面板增加"把已有订阅选为本配置供应商"的图形化功能

## 背景

metacubexd 是 mihomo 的面板。当前 profile 体系里，remote（订阅）和 local（本地 YAML）是平级的独立 profile。用户想在 local profile 里引用已有订阅作为 proxy-provider（即 `proxy-providers:` 里 `type: http, url: 订阅地址`），目前只能手敲 YAML。iOS 上的 Clash（clash.md）有"创建配置时勾选订阅作节点来源"的向导，体验很好。我们要在 metacubexd 里实现类似能力。

## 功能需求（最小可用版 + 流量显示）

### 功能 A：在 local profile 编辑器里一键插入订阅作为 provider

1. 在 profile 编辑页（`packages/ui/pages/profiles/[id]/edit.vue` 或对应组件）增加一个入口按钮，文案类似 "Add subscription as provider" / "从订阅添加供应商"。
2. 点击后弹出选择器：
   - **列出当前所有 remote 类型的 profile**（通过现有 Control API `/api/control/profiles` 获取），显示每个的名字、URL、以及能拿到的流量/到期信息（见功能 B）；
   - 同时提供"手动输入订阅 URL"的输入框，作为不在 profile 列表里的订阅的补充入口。
3. 用户选中一个订阅（或填 URL）并确认后，在 Monaco 编辑器当前 YAML 中**自动插入**：
   - `proxy-providers:` 段下一个新条目：`name: <唯一名>, type: http, url: <订阅URL>, interval: 21600, health-check: {enable: true, url: https://www.gstatic.com/generate_204, interval: 600, lazy: true}, override: {additional-prefix: "[名字] "}`（名字需处理唯一性，避免和已有 provider 重名）；
   - 如果 YAML 里已有 select/url-test 类型的 `proxy-groups`，把新 provider 加入其 `use:` 列表（如果之前没有 use 则创建）；若没有合适的组，至少确保 provider 本身被正确定义（用户可以自己接规则）；
   - 插入必须是**合法 YAML**，用成熟库做 AST 级编辑或至少保证缩进正确，不要破坏用户已有内容。
4. 提供明确的成功提示和错误提示（例如订阅列表为空、YAML 解析失败）。

### 功能 B：在选择器里显示订阅的流量/到期信息

1. 后端 Control Agent（`packages/agent`）已经能解析 `Subscription-Userinfo`（profile 卡片上就显示 upload/download/total/expire）——复用同样的逻辑。
2. 在选择器列出 remote profile 时，把该订阅的已用流量、总量、到期时间一起显示出来（例如 "已用 12.3 GB / 共 100 GB · 到期 2026-12-01"）。如果没有这些信息（订阅未提供响应头），显示 "流量信息不可用"。
3. 手动输入的 URL：如果用户填了 URL，可以选择性地 fetch 一次拿 `Subscription-Userinfo` 预览（可选，不强求）。

## 约束与实现指引

- **技术栈**：TypeScript + Vue/Nuxt（packages/ui），后端控制 agent 在 packages/agent，已有 `packages/config-editor` 包提供 Monaco + mihomo YAML schema 能力，尽量复用。
- **不改动**：内核管理、Clash API 交互、现有 profile 导入/激活逻辑。这是一个**纯增量功能**。
- **API 复用**：profile 列表用 `/api/control/profiles`（已有），单个 profile 内容用 `/api/control/profiles/{id}`（已有）。流量信息如果现有 API 没直接返回，可在 agent 侧加一个返回 userinfo 的字段或新端点，但保持向后兼容。
- **YAML 编辑安全性**：插入 provider 时不要覆盖用户已有配置；用 js-yaml 或现有 schema 工具解析/生成；插入后前端应能立即在编辑器里看到结果。
- **i18n**：UI 文案加英文 key（项目有 i18n 目录），中文可按现有 locale 情况处理。
- **代码风格**：遵循仓库现有 lint/typecheck（`pnpm typecheck`、`pnpm lint` 必须通过）。

## 验收标准

1. `pnpm typecheck` 和 `pnpm lint` 通过。
2. 构建 server 镜像能成功。
3. 启动后，在 local profile 编辑页能看到新入口；点开能列出已有的 remote 订阅及流量/到期；选中后 YAML 里出现正确的 `proxy-providers` 条目；激活 profile 后内核能正常加载该 provider 并拉到节点。
4. 不破坏原有 profile 导入/编辑/激活流程。

## 注意

- 只改本仓库代码，不要碰用户正在运行的 8080 生产容器（那是旧镜像）。
- 每个可编译的阶段结束就 `git commit`，方便中断后恢复。
- 遇到需要用户决策的设计问题，在代码注释里标注 `TODO(DECISION):` 并选一个合理默认值继续，不要停下来等确认（本任务为无人值守执行）。
