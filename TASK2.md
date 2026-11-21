# 新需求：按钮悬浮提示 + 手机端配置文件入口

## 需求 1：为配置文件相关按钮提供悬浮提示（tooltip）

目标：鼠标悬浮在配置相关按钮上时显示中文说明。暂时只需要保证简体中文文案完整（其他语言可用英文或 key fallback）。

实现：
1. `packages/ui/components/Button.vue`：新增可选 `title?: string` prop，透传到根 `<button :title="title">`（浏览器原生 tooltip，简单可靠）。
2. 给以下按钮加 `title`（值用 `t('某key')`，复用现有 i18n key 优先，不够则新增中文 key 到 zh.json，其他 locale 可加英文）：
   - `packages/ui/pages/profiles.vue` 订阅卡片按钮（约 470-540 行）：花括号(Visual editor)、铅笔(Edit)、刷新(Refresh)、刷新并应用(Refresh and apply)、复制(Duplicate)、分享(Share)、删除(Delete)
   - merge/script 卡片的铅笔/删除按钮（约 650-750 行）
   - 页内编辑框按钮（约 780 行起）：保存(Save)、验证(Validate)、取消(Cancel)，以及刚加的"从订阅添加供应商"云朵按钮
   - `packages/ui/pages/profiles/[id]/edit.vue` 编辑器顶部工具栏按钮：Visual/YAML 切换、云朵(从订阅添加供应商)、预览、应用/保存、重置等（凡是有 icon 的都加）
3. 新增的 i18n key 只需中文写准确文案（英文等 locale 可写对应英文），key 命名如 `tooltipVisualEditor`、`tooltipRefreshAndApply` 等；也可用现有 `visualEditor`/`profilesEdit` 等 key。

## 需求 2：手机界面提供配置文件（profiles）入口

现状：`packages/ui/components/MobileBottomNav.vue` 的 `secondaryItems`（FAB "+" 弹出面板）只有 Data Usage / Logs / Config / Control Center，**没有 Profiles**——手机上无法进入配置文件页。

实现：
- 在 `MobileBottomNav.vue` 的 `secondaryItems` 加入 `{ href: '/profiles', name: t('profiles'), icon: IconFileCode }`，并像 Sidebar.vue 那样用 `hasFeature('profiles')` 控制显示（避免无 profiles 特性的纯 web 模式出现坏入口）。
- import `IconFileCode`（@tabler/icons-vue）。
- 位置：建议放在 Config 之前或 Data Usage 之前，UI 上醒目即可。

## 约束
- TDD / typecheck / lint / 单测必须通过，commit。
- 不重建 docker（由 Hermes 负责构建部署）。
- 不碰 8080 生产容器。
- 改动尽量小、可审查。
