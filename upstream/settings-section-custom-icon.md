# 上游提案：settings.section 支持自定义导航图标（custom per-section `icon`）

## 背景

DeepSeek Harness 的设置面板（`@deepseek-ai/dsh-client-ui-settings-general`）对左侧
导航每个分区条目渲染一个图标，但图标由壳层 `navIcon(id)` **按分区 id 硬编码**：

```ts
function navIcon(id: string) {
  if (id === 'models') return <IconDataOutline16 …/>
  if (id === 'agent-presets') return <IconAgentPresetOutline16 …/>
  if (id === 'plugins') return <IconPersonalizationOutline16 …/>
  return <IconSettingsOutline16 …/>   // 其它所有分区 → 默认“设置”齿轮
}
```

因此第三方插件无法为它注册的分区指定自己的图标（例如
`dsh-archive-manager` 的「归档」分区只能显示默认齿轮）。

本提案给 `settings.section` 条目新增一个可选 `icon` 选项（React 元素），壳层优先渲染
自定义图标，缺失时才退回 id 字形/默认齿轮。改动向后兼容：不提供 `icon` 的分区行为不变。

> 本插件（dsh-archive-manager）同步内置了一个「运行时兜底注入」：在 DSH 尚未合入本特性、
> 未打补丁的安装上，插件会在设置面板 DOM（`[role="dialog"] nav button`，按本插件当前
> 语言下的导航标签匹配）中找到自己的导航行，把图标占位替换为归档 SVG。因此哪怕本提案
> 尚未合入，`dsh-plugin --profile web add dsh-archive-manager` 装完即可显示该图标；
> 一旦 DSH 合入本特性，插件自带的 `icon` 注册被壳层原生渲染，兜底逻辑会识别并跳过。

---

## 涉及文件与改动（基于 deepseek-ai/deepseek-harness master）

### 1. `packages/client/ui-slots/src/index.ts` — slots 条目选项白名单保留 `icon`

客户端 `register()` 构造 `entry.options` 时对选项做了白名单过滤（只保留
`key/id/order/label/priority`），`icon` 会被静默丢弃。两处修改：

a) 选项类型（registrant-facing）追加：

```ts
  /** Optional custom presentation glyph (e.g. a settings section nav icon) carried verbatim into `entry.options`. */
  icon?: unknown
```

b) `StoredEntry.options` 类型追加（第 ~558 行附近的 `options: {...}` 类型里加一项）：

```ts
  /** Optional custom presentation glyph contributed by the registrant. */
  icon?: unknown | undefined
```

c) `entry` 构造处（`const entry: StoredEntry = { component, options: { … } }` 的
`options` 对象里，`priority` 之后追加一行）：

```ts
        ...(options.icon !== undefined ? { icon: options.icon } : {}),
```

### 2. `packages/client/ui-settings-general/src/client/index.ts` — 行投影带上 `icon`

`sections` 快照里 `rows = ctx.slots.entries('settings.section').map(e => ({…}))` 追加：

```ts
                icon: e.options.icon,
```

### 3. `packages/client/ui-settings-general/src/client/shell-contract.ts` — 行类型追加

```ts
export interface SettingsSectionRow {
  id: string
  order: number
  label: string
  /** Optional custom nav glyph (React node) rendered instead of the id-derived default. */
  icon?: unknown
}
```

### 4. `packages/client/ui-settings-general/src/client/SettingsRoot.tsx` — 优先渲染自定义图标

新增：

```tsx
/**
 * Render a custom per-section nav glyph when the entry carries one
 * (`icon` in its slot options), else fall back to the id-glyph map/gear.
 */
function sectionRowIcon(row: SettingsSectionRow) {
  if (row.icon !== undefined) {
    return <span className={css.navIcon}>{row.icon}</span>
  }
  return navIcon(row.id)
}
```

并把导航行渲染处：

```tsx
                {navIcon(row.id)}
```

改为：

```tsx
                {sectionRowIcon(row)}
```

---

## 说明

- 行为完全向后兼容：不提供 `icon` 的分区依旧走 `navIcon(id)`（默认齿轮）。
- `icon` 为 React 元素（第三方在 client 侧构造，例如内联 `<svg>`），由壳层直接渲染，
  尺寸样式由壳层 `.navIcon` 统一约束，避免各插件自行拼 DOM。
- 本机运行中的 DSH 已通过等价补丁验证（壳层 `sectionRowIcon` + slots 白名单），
  dsh-archive-manager 的「归档」图标即走这条链路；未打补丁的安装则由插件兜底注入。
