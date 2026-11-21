# TASK4：可视化编辑器"验证并保存"（不激活）+ 两个加号悬浮提示

## 背景

当前 `packages/ui/pages/profiles/[id]/edit.vue` 的保存按钮（图标软盘，文案 `activeApplyLabel`）调用 `api.applyProfileEditor(id, patch)` → agent `profileEditor.apply()`。该函数做三件事：
1. 验证（conflicts + diagnostics + supervisor.validate）
2. 保存（remote profile 写入/更新 merge overlay；local profile `profiles.update(id,{content})`）
3. **`await profiles.setActive(id)` + `await supervisor.restart()`**（激活为使用状态并重启内核）

用户要求：把保存按钮改成"验证并保存"——**保留 1+2，去掉 3**（不激活、不重启、不改变当前使用中的订阅）。

## 需求 1：保存按钮功能改为"验证并保存但不激活"

方案（向后兼容，默认行为不变）：
1. `packages/agent/src/profile-editor.ts`：`apply(id, patch, options?: { activate?: boolean })`。当 `options.activate === false` 时跳过 `profiles.setActive(id)` 和 `supervisor.restart()`；返回的 `activeId` 应为当前真实激活的 profile id（用 `profiles.getActiveId()`），不是传入的 id。接口类型 `ProfileEditorApplyResult` 相应保持兼容。
2. `packages/agent/src/http.ts`：`PUT /profiles/:id/editor` 从 body 读可选 `activate?: boolean`，传给 `profileEditor.apply(id, patch, { activate })`。body 解析已存在（readEditorPatch），扩展它读 activate 字段。
3. `packages/ui/composables/useControlApi.ts`：`applyProfileEditor(id, patch, options?: { activate?: boolean })`，body 加 `activate: options?.activate`（undefined 时不写，保持默认 true）。
4. `packages/ui/pages/profiles/[id]/edit.vue`：`applyChanges()` 调 `api.applyProfileEditor(profileId, patch, { activate: false })`；成功 toast 用新 key；成功后不要错误地认为该 profile 已激活（`snapshot.active` 从重新 load 获取）。
5. 按钮文案：`visualEditorApply` 各语言从"验证并应用"改为"验证并保存"（zh: 验证并保存；en: Validate and save；fr/ja/ko/ru/fa 对应翻译）。按钮 `:title` 用同 key 已自动跟随。注意 `activeApplyLabel` 对非 active profile 用 `visualEditorActivate`——保存按钮现在不应再显示"激活"，两种情况都用保存语义（可统一用 `visualEditorApply` 新文案，或新增专用 key；简单起见让 `activeApplyLabel` 始终返回保存文案）。
6. 新增/调整测试覆盖：activate:false 时不调用 setActive/restart；activate 默认(true)时仍调用（兼容）；UI 传 activate:false。

## 需求 2：Resources 两个加号加中文悬浮提示

`edit.vue` 约 802-814 行 Resources 标题栏两个 Button：
- `addResource('proxy')`（节点）加 `:title="t('tooltipAddProxy')"`（zh: 添加节点）
- `addResource('provider')`（订阅供应商）加 `:title="t('tooltipAddProvider')"`（zh: 添加订阅供应商）
各 locale 加对应英文文案。

## 约束
- typecheck/lint/单测通过，commit。
- 不重建 docker（Hermes 负责），不碰 8080。
- 保持向后兼容：默认 activate=true 行为不变，只有 UI 保存按钮显式传 false。
