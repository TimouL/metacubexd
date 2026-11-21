# 小改动：可视化编辑器按钮文案 + 悬浮提示

## 需求 1：Resources 区块两个加号加中文悬浮提示

`packages/ui/pages/profiles/[id]/edit.vue` 里 Resources 区块标题栏有两个加号按钮（约 802-815 行）：
- `addResource('proxy')` → 文案 `t('visualEditorProxy')`（添加节点/proxy）
- `addResource('provider')` → 文案 `t('proxyProviders')`（添加订阅供应商/proxy provider）

给这两个 Button 加 `:title` 中文悬浮提示（多语言都要，复用/新增 i18n key，如 `tooltipAddProxy` = "添加节点"、`tooltipAddProvider` = "添加订阅供应商"）。其他 locale 写对应英文即可。

## 需求 2："验证并应用"改为"验证并保存"（文案 + 多语言 + 悬浮提示）

`visualEditorApply` key 当前是"验证并应用"（zh）/ "Validate and apply"（en）等，用在：
- 保存按钮的显示文案（`activeApplyLabel`）和 `title`

改为"验证并保存" / "Validate and save"（各语言对应改：en/fr/ja/ko/ru/fa/zh 全部）。
- 按钮的 `:title="t('visualEditorApply')"` 会随之变成"验证并保存"悬浮提示，符合"多语言悬浮提示都要改"。
- **功能确认**：`applyChanges()` 调用 `api.applyProfileEditor()`，它把 patch 应用到 profile 并重启内核生效。请确认这个函数是否就是"保存并应用"——如果是，功能保持不变（文案改为"验证并保存"更贴近用户认知）；如果项目里另有"仅保存不应用"的 API 且用户明确要"仅保存"，再考虑切换。默认按"功能不变、只改文案+提示"处理，并在报告里说明你的判断。

## 约束
- typecheck/lint/单测通过，commit。
- 不重建 docker（Hermes 负责），不碰 8080。
- 改动最小。
