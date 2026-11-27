// Client half of the dsh-archive-manager plugin.
// Hand-written browser bundle in the lazy-CJS format the client module loader
// expects: it only REGISTERS the factory; the body runs at materialization.
// It registers a settings.section entry ("归档") and renders the archived
// sessions page: grouped by workspace, filterable (all / one workspace),
// sortable (name / created time), with per-session "取消归档" (DSH unarchive
// icon) and "删除" (red trash icon) actions, a per-workspace group delete
// trash icon, and a top "删除全部" trash icon — every delete guarded by a
// second confirmation dialog whose confirm button is a red-text/red-outline
// ghost button. All mutations go through the same-origin routes registered by
// the host half.
window.__ModuleLoader__.load({
  // 注册 id 必须与 package.json 的 name 完全一致，否则客户端模块加载器
  // 会报 "loaded without registering"，插件在页面上同步失败。
  id: "dsh-archive-manager-ycet",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");

    // ---- 归档导航图标（来源：assets/icons/归档.svg，DSH IconArchiveOutline20） ----
    // DSH 设置面板对每个分区条目默认渲染“设置”齿轮图标；为让本插件显示自己
    // 的图标，本条目在注册选项里带一个 `icon`（React 元素）。此处内联的是
    // DSH 官方图标库 @deepseek-ai/dsh-client-ui-primitives 的 IconArchiveOutline20
    // 矢量路径（20×20 画布按 16×16 渲染），fill=currentColor 使其随导航文字
    // 颜色适配浅色/深色主题，与 DSH 其它导航图标风格一致。
    const ARCHIVE_ICON_D1 = "M15.8659 2.05975C17.2603 2.05995 18.3913 3.19096 18.3914 4.58527V5.4874C18.3914 6.02747 18.2192 6.52672 17.9303 6.93735C17.9336 6.96524 17.9388 6.99318 17.9388 7.02195V12.8884C17.9388 13.6345 17.9395 14.2379 17.8996 14.7254C17.8642 15.1593 17.7936 15.5499 17.6373 15.9141L17.5654 16.0685C17.278 16.6328 16.8405 17.1046 16.3038 17.434L16.0679 17.5661C15.66 17.7739 15.2196 17.8598 14.7237 17.9003C14.2362 17.9401 13.6327 17.9405 12.8867 17.9405H7.11122C6.36511 17.9405 5.76171 17.9401 5.27418 17.9003C4.84051 17.8649 4.44949 17.7952 4.08545 17.6391L3.93104 17.5661C3.36673 17.2785 2.89392 16.8414 2.56465 16.3044L2.43245 16.0685C2.22473 15.6608 2.13878 15.2211 2.09825 14.7254C2.05841 14.2379 2.05912 13.6345 2.05912 12.8884V7.02195C2.05912 6.99284 2.06422 6.96449 2.06758 6.93629C1.77931 6.52592 1.60858 6.02687 1.60858 5.4874V4.58527C1.60876 3.19084 2.73962 2.05975 4.1341 2.05975H15.8659ZM16.4984 7.92936C16.296 7.98169 16.0847 8.01288 15.8659 8.01291H4.1341C3.91478 8.01291 3.70246 7.98194 3.49955 7.92936V12.8884C3.49955 13.6582 3.50053 14.1927 3.53445 14.608C3.56769 15.0146 3.62923 15.244 3.71635 15.415L3.7925 15.5514C3.98339 15.8627 4.25749 16.1165 4.58464 16.2833L4.72529 16.3435C4.88095 16.3993 5.08638 16.4402 5.39158 16.4651C5.80685 16.4991 6.34138 16.5001 7.11122 16.5001H12.8867C13.6564 16.5001 14.1911 16.499 14.6063 16.4651C15.0128 16.432 15.2423 16.3703 15.4133 16.2833L15.5508 16.2061C15.8618 16.0152 16.116 15.7419 16.2827 15.415L16.3429 15.2732C16.3985 15.1177 16.4396 14.9128 16.4645 14.608C16.4985 14.1927 16.4984 13.6583 16.4984 12.8884V7.92936ZM4.1341 3.50019C3.53511 3.50019 3.0492 3.98631 3.04902 4.58527V5.4874C3.04902 6.08649 3.535 6.57248 4.1341 6.57248H15.8659C16.4648 6.57228 16.951 6.08638 16.951 5.4874V4.58527C16.9509 3.98644 16.4647 3.50038 15.8659 3.50019H4.1341Z";
    const ARCHIVE_ICON_D2 = "M12.7962 12.5661V11.0832H7.20548V12.5661L12.7962 12.5661Z";
    const ARCHIVE_ICON = React.createElement(
      "svg",
      { viewBox: "0 0 20 20", width: 16, height: 16, "aria-hidden": true, focusable: "false", "data-dsh-archive-injected": "1", style: { display: "block" } },
      React.createElement("path", { fillRule: "evenodd", clipRule: "evenodd", fill: "currentColor", d: ARCHIVE_ICON_D1 }),
      React.createElement("path", { fill: "currentColor", d: ARCHIVE_ICON_D2 })
    );

    // ---- 删除图标（来源：00_assets/icons/dsh-awesome-hud/ic-trash-outline-16.svg） ----
    // 16×16 画布、单路径的描边垃圾桶（同目录资产：assets/icons/trash.svg）；
    // fill=currentColor，图标颜色由按钮的 color 决定（本页统一为红色
    // state-error-primary），无需另存图片资源。
    const TRASH_ICON_PATH = "M14.4782 4.84067L14.2138 10.1152C14.1102 12.1872 14.067 13.0115 13.3866 13.9607C13.1044 14.3546 12.7498 14.6912 12.3424 14.9535C11.8239 15.2872 11.2415 15.4316 10.5585 15.4998C9.88727 15.5668 9.04946 15.5656 7.99998 15.5656C6.95051 15.5656 6.1127 15.5668 5.44142 15.4998C4.75851 15.4316 4.17602 15.2872 3.65753 14.9535C3.25012 14.6912 2.89559 14.3546 2.61332 13.9607C1.93296 13.0115 1.88979 12.1872 1.78619 10.1152L1.52179 4.84067L2.89006 4.77277L3.15343 10.0463C3.26221 12.2218 3.32452 12.6015 3.72646 13.1624C3.90825 13.4161 4.13686 13.6334 4.39927 13.8023C4.66204 13.9714 5.00263 14.0792 5.57825 14.1367C6.16562 14.1953 6.92298 14.1963 7.99998 14.1963C9.07699 14.1963 9.83434 14.1953 10.4217 14.1367C10.9973 14.0792 11.3379 13.9714 11.6007 13.8023C11.8631 13.6334 12.0917 13.4161 12.2735 13.1624C12.6755 12.6015 12.7378 12.2218 12.8465 10.0463L13.1099 4.77277L14.4782 4.84067ZM5.43011 6.22849H6.7994V11.3909H5.43011V6.22849ZM9.20056 6.22849H10.5699V11.3909H9.20056V6.22849ZM8.53597 0.434431C9.17976 0.434431 9.6522 0.426926 10.0966 0.571258C10.2357 0.616451 10.3717 0.672554 10.502 0.738948C10.9182 0.951107 11.2464 1.29099 11.7015 1.74612L12.4978 2.54136H15.3742V3.91169H0.625732V2.54136H3.50218L4.29845 1.74612C4.75358 1.29099 5.08174 0.951107 5.49801 0.738948C5.62831 0.672554 5.76425 0.616451 5.90334 0.571258C6.34776 0.426926 6.82021 0.434431 7.46399 0.434431H8.53597ZM7.46399 1.80476C6.73208 1.80476 6.51641 1.81187 6.32617 1.87369C6.25545 1.89667 6.18668 1.92533 6.12041 1.95907C5.96398 2.03878 5.82348 2.16253 5.44142 2.54136H10.5585C10.1765 2.16253 10.036 2.03878 9.87955 1.95907C9.81329 1.92533 9.74452 1.89667 9.6738 1.87369C9.48356 1.81187 9.26789 1.80476 8.53597 1.80476H7.46399Z";
    const TRASH_ICON = React.createElement(
      "svg",
      { viewBox: "0 0 16 16", width: 16, height: 16, fill: "none", "aria-hidden": true, focusable: "false", style: { display: "block" } },
      React.createElement("path", { fill: "currentColor", d: TRASH_ICON_PATH })
    );

    // ---- 取消归档图标（来源：DSH 内置 unarchive-outline 图标） ----
    // 与侧栏会话「取消归档」按钮同款：归档盒轮廓 + 向上的箭头（同目录资产：
    // assets/icons/unarchive.svg）。盒体与导航图标共用同一条路径
    // （ARCHIVE_ICON_D1），箭头为描边，故此处单独给出。
    const UNARCHIVE_ICON = React.createElement(
      "svg",
      { viewBox: "0 0 20 20", width: 16, height: 16, fill: "none", "aria-hidden": true, focusable: "false", style: { display: "block" } },
      React.createElement("path", { fillRule: "evenodd", clipRule: "evenodd", fill: "currentColor", d: ARCHIVE_ICON_D1 }),
      React.createElement("path", {
        d: "M10 14.1V10.1M7.85 12.05L10 9.9L12.15 12.05",
        stroke: "currentColor",
        strokeWidth: 1.5,
        strokeLinecap: "round",
        strokeLinejoin: "round"
      })
    );

    const NS = "settings.archiveManager";

    // 筛选菜单中「未分组」选项的 value（覆盖 workspaceId 为 null/undefined 的
    // 归档会话；与下方分组渲染使用的组 key 保持一致）。
    const UNGROUPED_FILTER = "__ungrouped__";

    const inject = ["slots", "locale"];

    const zh = {
      nav: "归档",
      title: "归档会话",
      subtitle: "在此查看并管理已归档的 DSH 会话。与会话对应的工作区，以及可凭此恢复/删除。",
      empty: "没有已归档的会话。",
      loadError: "加载归档会话失败",
      loadRetry: "重试",
      groupAll: "全部工作区",
      groupUngrouped: "(未分组)",
      filterUngrouped: "未分组",
      filterLabel: "筛选：",
      sortLabel: "排序：",
      // 用「升序/降序」明确方向，避免 ↑/↓ 被误读为滚动方向或时间远近。
      sortNameAsc: "名称：升序",
      sortNameDesc: "名称：降序",
      sortCreatedAsc: "创建时间：升序",
      sortCreatedDesc: "创建时间：降序",
      deleteAll: "删除全部",
      deleteGroup: "删除本组",
      unarchive: "取消归档",
      delete: "删除",
      unarchiving: "正在取消归档…",
      deleting: "正在删除…",
      archiveCount: "共 {n} 个已归档会话",
      emptyGroup: "无归档会话",
      createdLabel: "创建于 {time}",
      // confirm dialog
      confirmDeleteTitle: "确认删除会话？",
      confirmDeleteSingle: "将永久删除会话「{title}」及其全部聊天记录，此操作无法撤销。确定要删除吗？",
      confirmDeleteAll: "将永久删除全部 {n} 个已归档会话及其聊天记录，此操作无法撤销。确定要删除全部吗？",
      confirmDeleteWorkspaceTitle: "确认删除该工作区的归档会话？",
      confirmDeleteGroupTitle: "确认删除「未分组」的归档会话？",
      confirmDeleteWorkspace: "将永久删除工作区「{workspace}」下的 {n} 个已归档会话及其聊天记录，此操作无法撤销。确定要删除吗？",
      confirmDeleteUngrouped: "将永久删除「未分组」下的 {n} 个已归档会话及其聊天记录，此操作无法撤销。确定要删除吗？",
      confirmPrimary: "确认删除",
      cancel: "取消",
      ok: "确定",
      // results
      unarchiveOk: "已取消归档：{title}",
      unarchiveFail: "取消归档失败：{message}",
      deleteOk: "已删除：{title}",
      deleteFail: "删除失败：{message}",
      deleteAllOk: "已删除 {n} 个会话",
      deleteAllPartial: "部分删除失败（{fail}/{total}）",
      deleteWorkspaceOk: "已删除「{workspace}」下的 {n} 个会话",
      deleteWorkspaceOkResidue: "已删除「{workspace}」下的 {n} 个会话（其中 {residue} 个的投影缓存残留，重启 DSH 可彻底清除）",
      noticeFile: "（清理记录成功，但日志文件删除失败）",
      noticeCacheResidue: "（投影缓存可能在下次检查点后被重建，重启 DSH 可彻底清除）",
      deleteAllOkResidue: "已删除 {n} 个会话（其中 {residue} 个的投影缓存残留，重启 DSH 可彻底清除）"
    };

    const en = {
      nav: "Archives",
      title: "Archived Sessions",
      subtitle: "View and manage archived DSH sessions here.",
      empty: "No archived sessions.",
      loadError: "Failed to load archived sessions",
      loadRetry: "Retry",
      groupAll: "All workspaces",
      groupUngrouped: "(Ungrouped)",
      filterUngrouped: "Ungrouped",
      filterLabel: "Filter:",
      sortLabel: "Sort:",
      // 英文文案同样用 ascending/descending 明确方向，避免 ↑/↓ 被误读。
      sortNameAsc: "Name: ascending",
      sortNameDesc: "Name: descending",
      sortCreatedAsc: "Created time: ascending",
      sortCreatedDesc: "Created time: descending",
      deleteAll: "Delete all",
      deleteGroup: "Delete group",
      unarchive: "Unarchive",
      delete: "Delete",
      unarchiving: "Unarchiving…",
      deleting: "Deleting…",
      archiveCount: "{n} archived sessions",
      emptyGroup: "No archived sessions",
      createdLabel: "created {time}",
      confirmDeleteTitle: "Delete session?",
      confirmDeleteSingle: "Permanently delete session “{title}” and all of its chat history? This cannot be undone.",
      confirmDeleteAll: "Permanently delete all {n} archived sessions and their chat history? This cannot be undone.",
      confirmDeleteWorkspaceTitle: "Delete this workspace's archived sessions?",
      confirmDeleteGroupTitle: "Delete the ungrouped archived sessions?",
      confirmDeleteWorkspace: "Permanently delete the {n} archived session(s) in workspace “{workspace}” and their chat history? This cannot be undone.",
      confirmDeleteUngrouped: "Permanently delete the {n} ungrouped archived session(s) and their chat history? This cannot be undone.",
      confirmPrimary: "Delete",
      cancel: "Cancel",
      ok: "OK",
      unarchiveOk: "Unarchived: {title}",
      unarchiveFail: "Unarchive failed: {message}",
      deleteOk: "Deleted: {title}",
      deleteFail: "Delete failed: {message}",
      deleteAllOk: "Deleted {n} sessions",
      deleteAllPartial: "Some deletions failed ({fail}/{total})",
      deleteWorkspaceOk: "Deleted {n} session(s) from “{workspace}”",
      deleteWorkspaceOkResidue: "Deleted {n} session(s) from “{workspace}” ({residue} with projection-cache residue; restart DSH to clear it fully)",
      noticeFile: "(record cleaned, but log file removal failed)",
      noticeCacheResidue: "(projection cache may be rewritten by the next checkpoint; restart DSH to clear it fully)",
      deleteAllOkResidue: "Deleted {n} sessions ({residue} with projection-cache residue; restart DSH to clear it fully)"
    };

    // ---- i18n helper ----
    // The page and the sidebar label follow DSH's active locale through two
    // official channels (no hand-rolled locale state):
    //  1. `locale: NS` on the slot registration — the renderer derives a
    //     namespace-bound `t` seat from (locale face, NS, revision) and injects
    //     it as a prop; a locale switch bumps the revision, mints a NEW `t`
    //     reference and re-renders every outlet (see dsh-client-web-react
    //     localeSeat / useLocaleRevision).
    //  2. `ctx.locale.bind(NS)` for the nav label thunk — resolveSlotLabel
    //     re-evaluates label thunks at read time, and the settings shell
    //     re-renders its section rows on every locale revision change.
    // `zhT` below is only a last-resort fallback when the locale service is
    // absent (should never happen: `locale: NS` requires the installed face).
    const zhT = (key, params) => {
      let s = zh[key] !== undefined ? zh[key] : key;
      if (params) {
        for (const [k, v] of Object.entries(params)) {
          s = s.split("{" + k + "}").join(String(v));
        }
      }
      return s;
    };

    // ---- list helpers ----
    function readList(path) {
      return fetch(path, { headers: { Accept: "application/json" } }).then((r) => r.json());
    }
    function postJson(path, body) {
      return fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body || {})
      }).then((r) => r.json());
    }

    // ---- 浏览器端分会话状态清理 ----
    // DSH 把每个会话的一些 UI 状态存进 localStorage（侧栏布局、输入框草稿、追问
    // 草稿、侧栏浏览器状态），键名都是「前缀 + 完整 sessionId」。这些键没有清理
    // 入口：DSH 既不会在删除会话时移除它们，也不会自动过期，于是删掉的会话仍会
    // 在这里留下可读的残留（例如草稿文本）。
    //
    // 前缀不是公开契约，DSH 升级可能改名。因此这里集中维护、逐个容错：任一个键
    // 读失败或被移除都继续处理其余键，整体失败也静默降级——清理失败不能影响
    // 主机侧已经完成的删除结果。
    const SESSION_LS_PREFIXES = [
      "dsh.sidebar-right.v1.",          // dsh-client-ui-sidebar-right：右侧栏布局
      "dsh.conversation.",              // dsh-client-ui-session：输入框草稿与视图
      "dsh.user-questions.drafts.v1.",  // dsh-client-ui-user-questions：追问草稿
      "dsh.sidebar-browser.v1."         // dsh-better-sidebar：侧栏浏览器状态（第三方）
    ];
    // 「上次打开的会话」指针。被删的正好是当前会话时，指针会指向一个已不存在的
    // 会话，下次启动 DSH 会尝试打开它。
    const CURRENT_SESSION_KEY = "dsh.sessions.current";

    /**
     * 移除一个会话在 localStorage 中的全部分会话键。
     * @returns 实际移除的键数量（仅用于诊断，不参与成功判定）。
     */
    function purgeSessionLocalStorage(sessionId) {
      if (typeof sessionId !== "string" || sessionId.length === 0) return 0;
      let storage;
      try {
        storage = typeof localStorage === "undefined" ? null : localStorage;
      } catch {
        storage = null; // 某些环境下访问 localStorage 本身就会抛（隐私模式等）
      }
      if (storage === null) return 0;

      let removed = 0;
      for (const prefix of SESSION_LS_PREFIXES) {
        try {
          const key = prefix + sessionId;
          if (storage.getItem(key) !== null) {
            storage.removeItem(key);
            removed += 1;
          }
        } catch {
          /* 单个键失败不影响其余键 */
        }
      }
      // 当前会话指针：值是形如 {"sessionId":"session-<uuid>"} 的 JSON。
      // 命中时整键移除，让 DSH 回落到默认会话，而不是指向已删会话。
      try {
        const raw = storage.getItem(CURRENT_SESSION_KEY);
        if (typeof raw === "string" && raw.indexOf(sessionId) !== -1) {
          storage.removeItem(CURRENT_SESSION_KEY);
        }
      } catch {
        /* ignore */
      }
      return removed;
    }

    function formatTime(ms) {
      if (!ms) return "—";
      const d = new Date(ms);
      const pad = (n) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
    // 归档页默认按创建时间升序（最早创建的在最前）。用户仍可在工具条切换
    // 名称/创建时间的升序或降序；未知排序键也按创建时间升序兜底。
    const DEFAULT_SORT = "createdAsc";
    function sortSessions(sessions, sortKey) {
      const arr = sessions.slice();
      switch (sortKey) {
        case "nameAsc":
          arr.sort((a, b) => String(a.title).localeCompare(String(b.title), "zh-Hans-CN"));
          break;
        case "nameDesc":
          arr.sort((a, b) => String(b.title).localeCompare(String(a.title), "zh-Hans-CN"));
          break;
        case "createdAsc":
          arr.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
          break;
        case "createdDesc":
          arr.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
          break;
        default:
          // 未知排序键也回落到创建时间升序。
          arr.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
      }
      return arr;
    }
    function groupSessions(sessions, workspaceFilter) {
      const ungrouped = [];
      const byWs = new Map();
      for (const s of sessions) {
        if (workspaceFilter && s.workspaceId !== workspaceFilter) continue;
        if (s.workspaceId === null || s.workspaceId === undefined) ungrouped.push(s);
        else {
          if (!byWs.has(s.workspaceId)) byWs.set(s.workspaceId, []);
          byWs.get(s.workspaceId).push(s);
        }
      }
      return { byWs, ungrouped };
    }

    // ---- styles ----
    const styles = {
      wrap: { maxWidth: 720, margin: "0 auto", padding: "16px 20px 40px", fontFamily: "var(--dsw-font-family, inherit)" },
      title: { margin: "0 0 4px", fontSize: 20, fontWeight: 600, color: "var(--dsw-alias-label-primary, #0f1115)" },
      subtitle: { margin: "0 0 16px", fontSize: 13, color: "var(--dsw-alias-label-tertiary)", lineHeight: 1.5 },
      toolbar: { display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 8 },
      controlGroup: { display: "flex", alignItems: "center", gap: 6 },
      controlLabel: { fontSize: 13, color: "var(--dsw-alias-label-tertiary)" },
      select: {
        fontSize: 13, padding: "4px 8px", borderRadius: 6,
        border: "1px solid var(--dsw-alias-border-l2, #0000001a)",
        background: "var(--dsw-alias-bg-layer-2, #fff)", color: "var(--dsw-alias-label-primary, #0f1115)"
      },
      buttonsRow: { display: "flex", alignItems: "center", gap: 10, marginLeft: "auto" },
      count: { fontSize: 12, color: "var(--dsw-alias-label-tertiary)" },
      // 图标按钮：对齐 DSH 自带的会话行 iconButton（24×24、无边框、透明底），
      // 上下各 -4px 的外边距让按钮的行高与文字行保持一致，不把列表行撑高。
      iconButton: {
        flex: "none", display: "inline-flex", alignItems: "center", justifyContent: "center",
        width: 24, height: 24, marginTop: -4, marginBottom: -4, padding: 0,
        border: "none", borderRadius: 6, background: "transparent",
        color: "var(--dsw-alias-label-tertiary, #61666b)", lineHeight: 0, cursor: "pointer"
      },
      // 悬停：底色用极淡的中性色块，图标提亮到主文字色（危险按钮除外）。
      iconButtonHover: {
        background: "var(--dsw-alias-bg-module-platform, rgba(127,127,127,0.14))",
        color: "var(--dsw-alias-label-primary, #0f1115)"
      },
      // 危险图标按钮：图标恒为红色，悬停时只加深底色，不改变图标颜色。
      iconButtonDanger: { color: "var(--dsw-alias-state-error-primary, #d93025)" },
      iconButtonDangerHover: { background: "rgba(217, 48, 37, 0.12)" },
      // 分组头部右侧的整组删除图标：靠 marginLeft:auto 右对齐。
      groupIconButton: { marginLeft: "auto", flexShrink: 0 },
      group: { marginBottom: 20 },
      groupHeader: {
        display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", borderRadius: 6,
        background: "var(--dsw-alias-bg-module-platform, #f5f6f7)", color: "var(--dsw-alias-label-secondary, #61666b)", marginBottom: 4
      },
      groupTitle: { fontWeight: 600, fontSize: 13, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
      groupCount: { fontSize: 12, color: "var(--dsw-alias-label-tertiary)", flexShrink: 0 },
      row: {
        display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", borderRadius: 6,
        borderBottom: "1px solid var(--dsw-alias-border-l1, #0000000a)"
      },
      // 标题列本身不再裁剪：省略号交给内部 span，fixed 定位的悬停提示才不会被裁剪。
      rowTitle: { flex: 1, minWidth: 0, fontSize: 14, color: "var(--dsw-alias-label-primary, #0f1115)" },
      // 只有文字本身（含省略号区域）是悬停目标；inline-block + maxWidth 让短名称
      // 不会占满整列，鼠标停在名称右侧空白处不会误触发提示。
      rowTitleText: {
        display: "inline-block", maxWidth: "100%", overflow: "hidden",
        textOverflow: "ellipsis", whiteSpace: "nowrap", verticalAlign: "top",
        lineHeight: "20px", cursor: "default"
      },
      // 会话名称悬停气泡：跟随鼠标的 fixed 定位，配色沿用 DSH 自带的 tooltip token。
      titleTooltip: {
        position: "fixed", zIndex: 9999, pointerEvents: "none",
        maxWidth: "min(420px, calc(100vw - 32px))",
        padding: "6px 10px", borderRadius: 8,
        background: "var(--dsw-alias-tooltip-bg, #43454a)",
        color: "var(--dsw-alias-tooltip-label, #fff)",
        fontSize: 12, lineHeight: 1.5, overflowWrap: "anywhere",
        boxShadow: "0 8px 24px rgba(0, 0, 0, 0.28)", whiteSpace: "normal", textAlign: "left"
      },
      rowMeta: { flex: 1, fontSize: 12, color: "var(--dsw-alias-label-tertiary)", whiteSpace: "nowrap" },
      rowActions: { display: "flex", gap: 6, flexShrink: 0 },
      defaultButton: {
        fontSize: 12, padding: "4px 10px", borderRadius: 6, cursor: "pointer",
        border: "1px solid var(--dsw-alias-border-l2, #0000001a)",
        background: "var(--dsw-alias-button-elevated-fill, #fff)", color: "var(--dsw-alias-label-secondary, #61666b)"
      },
      defaultButtonDisabled: { opacity: 0.6, cursor: "default" },
      hint: { padding: "24px 0", textAlign: "center", color: "var(--dsw-alias-label-tertiary)", fontSize: 13 },
      // confirm dialog overlay
      overlay: {
        position: "fixed", inset: 0, zIndex: 10000, display: "flex", alignItems: "center", justifyContent: "center",
        background: "rgba(0,0,0,0.35)"
      },
      dialog: {
        width: 420, maxWidth: "90vw", borderRadius: 10, padding: "20px",
        background: "var(--dsw-alias-bg-layer-3, #fff)", boxShadow: "0 8px 30px rgba(0,0,0,0.18)",
        color: "var(--dsw-alias-label-primary, #0f1115)"
      },
      dialogTitle: { margin: "0 0 10px", fontSize: 16, fontWeight: 600 },
      dialogBody: { fontSize: 14, lineHeight: 1.6, color: "var(--dsw-alias-label-secondary, #61666b)", marginBottom: 16, wordBreak: "break-word" },
      dialogActions: { display: "flex", justifyContent: "flex-end", gap: 8 },
      // 二次确认弹窗里的危险主按钮：按产品要求改成「红色文字 + 红色描边 + 透明底」
      // 的描边按钮，不再整块红色填充；破坏性语义由红色文字与描边承担。
      primaryDangerButton: {
        fontSize: 13, padding: "6px 14px", borderRadius: 6, cursor: "pointer",
        border: "1px solid var(--dsw-alias-state-error-primary, #d93025)",
        background: "transparent",
        color: "var(--dsw-alias-state-error-primary, #d93025)"
      }
    };

    // ---- IconButton ----
    // 把「取消归档」「删除」等动作收成纯图标：文字只留在 title / aria-label 里，
    // 供悬停提示与读屏使用；图标的颜色由 danger 决定（危险动作为红色）。
    function IconButton({ label, ariaLabel, onClick, disabled, danger, style, children }) {
      const [hover, setHover] = React.useState(false);
      const active = hover && !disabled;
      const composed = {
        ...styles.iconButton,
        ...(active ? styles.iconButtonHover : null),
        ...(danger ? styles.iconButtonDanger : null),
        ...(active && danger ? styles.iconButtonDangerHover : null),
        ...(disabled ? styles.defaultButtonDisabled : null),
        ...style
      };
      return React.createElement(
        "button",
        {
          type: "button",
          style: composed,
          title: label,
          "aria-label": ariaLabel || label,
          disabled,
          onClick,
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false)
        },
        children
      );
    }

    // ---- 会话名称悬停提示 ----
    // 原生 title 无法控制位置、样式与延迟，而且会和自绘提示重复；这里改为
    // 悬停 250ms 后在鼠标位置展示完整标题，移出立即隐藏。
    const TITLE_TOOLTIP_DELAY_MS = 250;
    const TITLE_TOOLTIP_MARGIN = 8;
    const TITLE_TOOLTIP_OFFSET_X = 14;
    const TITLE_TOOLTIP_OFFSET_Y = 16;

    /**
     * 把提示气泡夹在视口内（四周至少留 margin 像素）。
     * 纯函数，便于单元测试；宽高未知时传 0，渲染后会用实测尺寸再修正一次。
     * @param {number} clientX 鼠标 X 坐标
     * @param {number} clientY 鼠标 Y 坐标
     * @param {number} width 气泡宽度
     * @param {number} height 气泡高度
     * @param {number} viewportWidth 视口宽度
     * @param {number} viewportHeight 视口高度
     * @returns {{ left: number, top: number }} 夹取后的 fixed 定位坐标
     */
    function titleTooltipPosition(clientX, clientY, width, height, viewportWidth, viewportHeight) {
      // 视口比气泡还小时，max* 会小于 margin，用 max() 兜底到 margin，避免负坐标。
      const maxLeft = Math.max(TITLE_TOOLTIP_MARGIN, viewportWidth - width - TITLE_TOOLTIP_MARGIN);
      const maxTop = Math.max(TITLE_TOOLTIP_MARGIN, viewportHeight - height - TITLE_TOOLTIP_MARGIN);
      return {
        left: Math.min(Math.max(TITLE_TOOLTIP_MARGIN, clientX + TITLE_TOOLTIP_OFFSET_X), maxLeft),
        top: Math.min(Math.max(TITLE_TOOLTIP_MARGIN, clientY + TITLE_TOOLTIP_OFFSET_Y), maxTop)
      };
    }

    // 布局阶段测量气泡尺寸，避免首次出现时先落到视口外再跳回；
    // 旧环境没有 useLayoutEffect 时退化为 useEffect。
    const useTitleTooltipLayoutEffect = React.useLayoutEffect || React.useEffect;

    // 会话名称 + 悬停提示。每个会话行独立维护自己的定时器与气泡状态，
    // 互不影响；组件卸载时清理定时器，不挂全局监听。
    function SessionTitle({ text }) {
      const [tip, setTip] = React.useState(null); // {x,y,left,top} | null
      const timerRef = React.useRef(0);
      const pendingRef = React.useRef({ x: 0, y: 0 });
      const sizeRef = React.useRef({ width: 0, height: 0 });
      const measuredRef = React.useRef(false);
      const tipRef = React.useRef(null);

      const clearTimer = () => {
        if (timerRef.current) {
          clearTimeout(timerRef.current);
          timerRef.current = 0;
        }
      };

      // 按鼠标坐标 + 当前已知气泡尺寸计算最终位置。
      const place = (clientX, clientY) => {
        const width = typeof window === "undefined" ? 0 : window.innerWidth;
        const height = typeof window === "undefined" ? 0 : window.innerHeight;
        return {
          x: clientX,
          y: clientY,
          ...titleTooltipPosition(clientX, clientY, sizeRef.current.width, sizeRef.current.height, width, height)
        };
      };

      const onEnter = (event) => {
        clearTimer();
        pendingRef.current = { x: event.clientX, y: event.clientY };
        timerRef.current = setTimeout(() => {
          timerRef.current = 0;
          setTip(place(pendingRef.current.x, pendingRef.current.y));
        }, TITLE_TOOLTIP_DELAY_MS);
      };

      const onMove = (event) => {
        // 延迟到点前移动鼠标：只更新「待显示位置」，气泡仍等 250ms；
        // 已显示时：跟随鼠标更新位置。
        pendingRef.current = { x: event.clientX, y: event.clientY };
        if (!tip) return;
        setTip(place(event.clientX, event.clientY));
      };

      const onLeave = () => {
        clearTimer();
        setTip(null);
        measuredRef.current = false;
      };

      useTitleTooltipLayoutEffect(() => {
        if (!tip || measuredRef.current) return;
        const el = tipRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        sizeRef.current = { width: rect.width, height: rect.height };
        measuredRef.current = true;
        const next = titleTooltipPosition(
          tip.x, tip.y, rect.width, rect.height,
          window.innerWidth, window.innerHeight
        );
        if (Math.abs(next.left - tip.left) > 0.5 || Math.abs(next.top - tip.top) > 0.5) {
          setTip((current) => (current ? { ...current, ...next } : current));
        }
      }, [tip]);

      // 卸载时清掉未触发的定时器，避免对已卸载组件 setState。
      React.useEffect(() => () => clearTimer(), []);

      return React.createElement(
        "div",
        { style: styles.rowTitle },
        React.createElement(
          "span",
          {
            style: styles.rowTitleText,
            onMouseEnter: onEnter,
            onMouseMove: onMove,
            onMouseLeave: onLeave
          },
          text
        ),
        tip
          ? React.createElement("div", {
              ref: tipRef,
              role: "tooltip",
              style: { ...styles.titleTooltip, left: tip.left, top: tip.top }
            }, text)
          : null
      );
    }

    // ---- ConfirmDialog ----
    function ConfirmDialog({ title, body, onConfirm, onCancel, busy, t }) {
      return React.createElement(
        "div",
        { style: styles.overlay, onClick: busy ? undefined : onCancel },
        React.createElement(
          "div",
          { style: styles.dialog, onClick: (e) => e.stopPropagation() },
          React.createElement("h3", { style: styles.dialogTitle }, title),
          React.createElement("div", { style: styles.dialogBody }, body),
          React.createElement(
            "div",
            { style: styles.dialogActions },
            React.createElement("button", { style: styles.defaultButton, onClick: onCancel, disabled: busy }, t("cancel")),
            React.createElement("button", {
              style: busy ? { ...styles.primaryDangerButton, ...styles.defaultButtonDisabled } : styles.primaryDangerButton,
              onClick: onConfirm,
              disabled: busy
            }, busy ? "…" : t("confirmPrimary"))
          )
        )
      );
    }

    // ---- ArchivePage ----
    function ArchivePage(props) {
      // `t` is injected by the slot renderer from the entry's `locale: NS`
      // declaration — it follows DSH's active locale and gets a fresh
      // reference on every locale switch (which re-renders this component).
      const t = props && typeof props.t === "function" ? props.t : zhT;
      const refreshSessions = props && typeof props.refreshSessions === "function" ? props.refreshSessions : null;
      const [state, setState] = React.useState({
        loading: true,
        error: null,
        sessions: [],
        workspaces: [],
        filter: "",
        sort: DEFAULT_SORT,
        confirm: null, // { kind:'single'|'all'|'workspace', sessionId?, title?, workspaceId?, count?, sessionIds? }
        busy: false,
        notice: null
      });

      const set = (patch) => setState((s) => (typeof patch === "function" ? patch(s) : { ...s, ...patch }));

      // 把 /list 响应合并进 state。若当前筛选的工作区已没有任何归档会话
      // （例如刚取消了该工作区最后一个归档会话，或已全部删除），自动把筛选
      // 重置回「全部工作区」，避免 <select> 的 value 指向已不存在的选项。
      const applyList = (res, extra) => {
        setState((s) => {
          const sessions = res && res.ok === true ? res.sessions || [] : s.sessions;
          const workspaces = res && res.ok === true ? res.workspaces || [] : s.workspaces;
          const liveWsIds = new Set();
          let hasUngrouped = false;
          for (const x of sessions) {
            if (!x) continue;
            if (x.workspaceId === null || x.workspaceId === undefined) hasUngrouped = true;
            else liveWsIds.add(x.workspaceId);
          }
          let filter = s.filter;
          if (filter === UNGROUPED_FILTER) {
            // 「未分组」筛选仅在仍有未分组归档会话时有效
            if (!hasUngrouped) filter = "";
          } else if (filter !== "" && !liveWsIds.has(filter)) {
            filter = "";
          }
          return {
            ...s,
            sessions,
            workspaces,
            filter,
            error: null,
            ...extra
          };
        });
      };

      const load = () => {
        set({ loading: true, error: null });
        readList("/api/archive-manager/list")
          .then((res) => {
            if (res && res.ok === true) {
              applyList(res, { loading: false });
            } else {
              set({ loading: false, error: (res && res.message) || t("loadError") });
            }
          })
          .catch(() => set({ loading: false, error: t("loadError") }));
      };

      React.useEffect(() => {
        load();
      }, []);

      const runAction = (action, onResult) => {
        set({ busy: true, confirm: null });
        action()
          .then(async (res) => {
            let notice = null;
            if (res && res.ok === true) {
              notice = onResult ? await onResult(res) : null;
            } else {
              notice = (res && res.message) || t("loadError");
            }
            return readList("/api/archive-manager/list").then((listRes) => {
              applyList(listRes, { busy: false, notice });
            });
          })
          .catch(() => set({ busy: false, error: t("loadError") }));
      };

      const onUnarchive = (sessionId, title) => {
        runAction(
          () => postJson("/api/archive-manager/unarchive", { sessionId }),
          () => t("unarchiveOk", { title })
        );
      };
      const onDelete = (sessionId, title) => {
        runAction(
          () => postJson("/api/archive-manager/delete", { sessionId }),
          async (res) => {
            // 主机侧已经删掉了日志与投影缓存；浏览器侧的分会话状态只能在这里清。
            // 清理是 best-effort：结果只影响提示文案，不改变"已删除"的结论。
            purgeSessionLocalStorage(sessionId);
            // 删除成功后，让 DSH 前端会话列表立即重拉：
            // 文件删除不会触发 host/session-removed 推送，侧边栏条目会残留到硬刷新。
            if (refreshSessions !== null) await refreshSessions();
            const root = t("deleteOk", { title });
            const notes = [];
            if (res.fileDeleted === false) notes.push(t("noticeFile"));
            // 投影缓存残留：主机侧重试后仍在（多半是被 DSH 的异步检查点写回）。
            if (res.cache && res.cache.ok === false) notes.push(t("noticeCacheResidue"));
            if (notes.length === 0) return root;
            return root + " " + notes.join(" ");
          }
        );
      };
      const onDeleteAll = () => {
        runAction(() => postJson("/api/archive-manager/delete-all", {}), async (res) => {
          // 批量删除：主机侧响应只带计数，逐会话的 localStorage 清理需要各自 id。
          // 这里按列表快照逐个清理（列表在删除前已加载）。
          const targets = state.sessions.map((s) => s.sessionId);
          for (const sid of targets) purgeSessionLocalStorage(sid);
          if (refreshSessions !== null) await refreshSessions();
          const residue = typeof res.cacheFailures === "number" ? res.cacheFailures : 0;
          if (res.deleted === res.total) {
            return residue > 0 ? t("deleteAllOkResidue", { n: res.deleted, residue }) : t("deleteAllOk", { n: res.deleted });
          }
          return t("deleteAllPartial", { fail: res.failures ? res.failures.length : 0, total: res.total });
        });
      };
      // 按工作区整组删除：请求只带 workspaceId（未分组为 null），目标会话由
      // 服务端从权威归档报告重新过滤；这里的 sessionIds 仅用于删除后清理浏览器
      // 分会话状态（快照取自点击确认时的当前组）。
      const onDeleteWorkspace = (target) => {
        runAction(
          () => postJson("/api/archive-manager/delete-workspace", { workspaceId: target.workspaceId }),
          async (res) => {
            for (const sid of target.sessionIds) purgeSessionLocalStorage(sid);
            if (refreshSessions !== null) await refreshSessions();
            const label = target.workspaceId === null ? t("filterUngrouped") : target.title;
            const residue = typeof res.cacheFailures === "number" ? res.cacheFailures : 0;
            if (res.deleted === res.total) {
              return residue > 0
                ? t("deleteWorkspaceOkResidue", { workspace: label, n: res.deleted, residue })
                : t("deleteWorkspaceOk", { workspace: label, n: res.deleted });
            }
            return t("deleteAllPartial", { fail: res.failures ? res.failures.length : 0, total: res.total });
          }
        );
      };

      const closeConfirm = () => set({ confirm: null });

      // grouping
      const filtered = state.filter === UNGROUPED_FILTER
        ? state.sessions.filter((s) => s.workspaceId === null || s.workspaceId === undefined)
        : state.filter
          ? state.sessions.filter((s) => s.workspaceId === state.filter)
          : state.sessions.slice();
      const sorted = sortSessions(filtered, state.sort);
      const { byWs, ungrouped } = groupSessions(sorted, null);

      // 筛选菜单只列出「至少有一个已归档会话」的工作区；没有任何归档会话的
      // 工作区不出现，避免菜单展示全部 DSH 工作区（例如某工作区全部会话都
      // 未归档时，其不在筛选菜单中）。
      const filterableWorkspaces = state.workspaces.filter((w) =>
        state.sessions.some((s) => s.workspaceId === w.id)
      );
      // 存在未分组（不属于任何工作区）的归档会话时，筛选菜单追加「未分组」选项。
      const hasUngrouped = state.sessions.some(
        (s) => s.workspaceId === null || s.workspaceId === undefined
      );

      const wsTitle = (id) => {
        const found = state.workspaces.find((w) => w.id === id);
        return found ? (found.title || id) : id;
      };

      const confirmNode = state.confirm
        ? React.createElement(ConfirmDialog, {
            title:
              state.confirm.kind === "workspace"
                ? state.confirm.workspaceId === null
                  ? t("confirmDeleteGroupTitle")
                  : t("confirmDeleteWorkspaceTitle")
                : t("confirmDeleteTitle"),
            body:
              state.confirm.kind === "all"
                ? t("confirmDeleteAll", { n: state.sessions.length })
                : state.confirm.kind === "workspace"
                  ? state.confirm.workspaceId === null
                    ? t("confirmDeleteUngrouped", { n: state.confirm.count })
                    : t("confirmDeleteWorkspace", { workspace: state.confirm.title, n: state.confirm.count })
                  : t("confirmDeleteSingle", { title: state.confirm.title || state.confirm.sessionId }),
            busy: state.busy,
            t,
            onCancel: closeConfirm,
            onConfirm: () => {
              if (state.confirm.kind === "all") {
                onDeleteAll();
              } else if (state.confirm.kind === "workspace") {
                onDeleteWorkspace(state.confirm);
              } else {
                onDelete(state.confirm.sessionId, state.confirm.title);
              }
            }
          })
        : null;

      if (state.loading) {
        return React.createElement("div", { style: styles.wrap },
          React.createElement("h2", { style: styles.title }, t("title")),
          React.createElement("div", { style: styles.hint }, "…")
        );
      }

      if (state.error) {
        return React.createElement("div", { style: styles.wrap },
          React.createElement("h2", { style: styles.title }, t("title")),
          React.createElement("div", { style: styles.hint },
            t("loadError") + (state.error ? ": " + state.error : ""),
            React.createElement("div", { style: { marginTop: 8 } },
              React.createElement("button", { style: styles.defaultButton, onClick: load }, t("loadRetry"))
            )
          )
        );
      }

      const groups = [];
      for (const wsId of state.workspaces) {
        const items = byWs.get(wsId.id) || [];
        if (items.length === 0) continue;
        groups.push({ key: wsId.id, workspaceId: wsId.id, title: wsTitle(wsId.id), items });
      }
      if (ungrouped.length > 0) {
        groups.push({ key: "__ungrouped__", workspaceId: null, title: t("groupUngrouped"), items: ungrouped });
      }

      const rows = (items) =>
        items.map((s) =>
          React.createElement("div", { key: s.sessionId, style: styles.row },
            // 名称列：内部 span 负责省略号，悬停 250ms 后显示完整名称气泡。
            React.createElement(SessionTitle, { text: s.title }),
            React.createElement("div", { style: styles.rowMeta },
              (s.createdAt ? t("createdLabel", { time: formatTime(s.createdAt) }) : "—")
            ),
            React.createElement("div", { style: styles.rowActions },
              // 取消归档：DSH 内置 unarchive 图标（归档盒 + 向上箭头）
              React.createElement(IconButton, {
                label: t("unarchive"),
                disabled: state.busy,
                onClick: () => onUnarchive(s.sessionId, s.title)
              }, UNARCHIVE_ICON),
              // 删除：红色垃圾桶图标
              React.createElement(IconButton, {
                label: t("delete"),
                ariaLabel: `${t("delete")}：${s.title}`,
                danger: true,
                disabled: state.busy,
                onClick: () => set({ confirm: { kind: "single", sessionId: s.sessionId, title: s.title } })
              }, TRASH_ICON)
            )
          )
        );

      return React.createElement("div", { style: styles.wrap },
        React.createElement("h2", { style: styles.title }, t("title")),
        React.createElement("p", { style: styles.subtitle }, t("subtitle")),

        React.createElement("div", { style: styles.toolbar },
          React.createElement("div", { style: styles.controlGroup },
            React.createElement("span", { style: styles.controlLabel }, t("filterLabel")),
            React.createElement("select", {
              style: styles.select,
              value: state.filter,
              onChange: (e) => set({ filter: e.target.value })
            },
              React.createElement("option", { value: "" }, t("groupAll")),
              filterableWorkspaces.map((w) =>
                React.createElement("option", { key: w.id, value: w.id }, w.title || w.id)
              ),
              hasUngrouped
                ? React.createElement("option", { key: UNGROUPED_FILTER, value: UNGROUPED_FILTER }, t("filterUngrouped"))
                : null
            )
          ),
          React.createElement("div", { style: styles.controlGroup },
            React.createElement("span", { style: styles.controlLabel }, t("sortLabel")),
            React.createElement("select", {
              style: styles.select,
              value: state.sort,
              onChange: (e) => set({ sort: e.target.value })
            },
              // 默认项放在第一项，便于用户从下拉菜单直接看出当前默认排序。
              React.createElement("option", { value: "createdAsc" }, t("sortCreatedAsc")),
              React.createElement("option", { value: "createdDesc" }, t("sortCreatedDesc")),
              React.createElement("option", { value: "nameAsc" }, t("sortNameAsc")),
              React.createElement("option", { value: "nameDesc" }, t("sortNameDesc"))
            )
          ),
          React.createElement("div", { style: styles.buttonsRow },
            // 计数与「删除全部」都按全部归档会话统计，不受筛选影响；避免出现
            // 「显示筛选后的 N 个、实际删掉全部」的误解。
            React.createElement("span", { style: styles.count }, t("archiveCount", { n: state.sessions.length })),
            // 「删除全部」：红色垃圾桶图标按钮
            React.createElement(IconButton, {
              label: t("deleteAll"),
              danger: true,
              disabled: state.busy || state.sessions.length === 0,
              onClick: () => set({ confirm: { kind: "all" } })
            }, TRASH_ICON)
          )
        ),

        state.notice ? React.createElement("div", { style: { fontSize: 12, color: "var(--dsw-alias-label-tertiary)", margin: "4px 0 8px" } }, state.notice) : null,

        sorted.length === 0
          ? React.createElement("div", { style: styles.hint }, t("empty"))
          : React.createElement("div", null,
              groups.map((g) =>
                React.createElement("div", { key: g.key, style: styles.group },
                  React.createElement("div", { style: styles.groupHeader },
                    React.createElement("span", { style: styles.groupTitle }, g.title),
                    React.createElement("span", { style: styles.groupCount }, `(${g.items.length})`),
                    React.createElement(IconButton, {
                      label: t("deleteGroup"),
                      ariaLabel: `${t("deleteGroup")}：${g.title}`,
                      danger: true,
                      disabled: state.busy,
                      style: styles.groupIconButton,
                      onClick: () => set({
                        confirm: {
                          kind: "workspace",
                          workspaceId: g.workspaceId,
                          title: g.title,
                          count: g.items.length,
                          // 删除成功后逐个清理这些会话的浏览器分会话状态。
                          sessionIds: g.items.map((s) => s.sessionId)
                        }
                      })
                    }, TRASH_ICON)
                  ),
                  rows(g.items)
                )
              )
            ),

        confirmNode
      );
    }

    function apply(ctx) {
      const locale = ctx.get("locale");
      // Namespace-bound translate following DSH's active locale at call time
      // (the nav label thunk re-reads it whenever the settings shell
      // re-renders, i.e. on every locale revision change).
      const t = locale !== undefined ? locale.bind(NS) : zhT;
      if (locale !== undefined) {
        try {
          ctx.effect(() => locale.register(NS, { zh, en }), "dsh-archive-manager: dictionaries");
        } catch {
          /* ignore */
        }
      }
      // 删除会话后让 DSH 前端会话列表立即重拉（移除残留条目）。
      // 优先使用公开会话刷新接口；旧版客户端回退到内部列表刷新入口。
      const refreshSessions = async () => {
        try {
          const sessions = ctx.get("sessions");
          if (sessions && typeof sessions.refresh === "function") {
            await sessions.refresh();
          } else if (sessions && sessions.manager && typeof sessions.manager.refreshList === "function") {
            await sessions.manager.refreshList();
          }
        } catch (error) {
          ctx.logger?.warn?.(`dsh-archive-manager: 会话列表刷新失败: ${String(error)}`);
        }
      };
      const injected = () => ({ refreshSessions });
      // NOTE: `t` must NOT come from `inject` — the renderer's locale seat
      // (derived from `locale: NS` + revision) would be shadowed by a plain
      // prop and the page would stop following DSH's language switch.
      ctx.slots.inject("settings.section", () =>
        ctx.slots.register(
          {
            name: "settings.section",
            id: "archives",
            order: 40,
            label: () => t("nav"),
            icon: ARCHIVE_ICON,
            locale: NS,
            inject: injected
          },
          ArchivePage
        )
      );

      // 官方 0.2.2 起提供正式的分区导航图标插槽 settings.section.icon：
      // 注册 id 必须等于对应 settings.section 的 id，命中后壳层不再渲染默认齿轮。
      // 旧版壳没有该插槽，inject 静默不注册，继续由下面的 DOM 钩子兜底；
      // 两条路径靠 svg 上的 data-dsh-archive-injected 标记互斥，不会重复绘制。
      ctx.slots.inject("settings.section.icon", () =>
        ctx.slots.register(
          {
            name: "settings.section.icon",
            id: "archives",
            order: 40,
            label: () => t("nav"),
            locale: NS
          },
          () => ARCHIVE_ICON
        )
      );

      // ---- 设置导航图标兜底注入（保证在任意 DSH 安装上都显示本插件图标） ----
      // 上游 DSH 的 settings.section 目前不原生支持“每个分区自定义图标”：设置
      // 壳层的 navIcon() 只对 models / agent-presets / plugins 三个固定 id 有
      // 专属图标，其余分区一律渲染默认“设置”齿轮。为让本插件在任何 DSH 版本
      // （包括没有打过对应补丁、尚未合并上游特性）的安装上“装完即显示”归档
      // 图标，这里用一个健壮的运行时兜底：监听设置面板（[role=dialog] 内的
      // nav）的 DOM 变化，找到文本与本插件当前导航标签（随 DSH 语言切换）一致
      // 的导航行，把该行的图标元素替换为我们的归档 SVG。
      // - 若所在 DSH 已原生支持分区 icon（壳层直接渲染了带 data-dsh-archive-injected
      //   标记的图标），观察器识别后会跳过，不重复注入。
      // - 图标占位兼容两种壳层结构：旧壳层把图标包在 span 里（navIcon 占位
      //   span），新壳层（0.1.1-rc.2+）把图标渲染为裸 <svg>。定位方式不依赖
      //   具体标签：先按导航文本找到 label span，取它前一个兄弟作为图标槽。
      // - 壳层重渲染时 React 会重放齿轮，下一次 DOM 变更会再次注入，终态一致。
      ctx.effect(() => {
        if (typeof document === "undefined" || typeof MutationObserver === "undefined") {
          return () => {};
        }
        const SVG_NS = "http://www.w3.org/2000/svg";
        const ICON_MARK = "data-dsh-archive-injected";
        const makeIcon = () => {
          const svg = document.createElementNS(SVG_NS, "svg");
          svg.setAttribute("viewBox", "0 0 20 20");
          svg.setAttribute("width", "16");
          svg.setAttribute("height", "16");
          svg.setAttribute("aria-hidden", "true");
          svg.setAttribute(ICON_MARK, "1");
          svg.style.display = "block";
          const addPath = (d, evenodd) => {
            const p = document.createElementNS(SVG_NS, "path");
            p.setAttribute("fill", "currentColor");
            if (evenodd) {
              p.setAttribute("fill-rule", "evenodd");
              p.setAttribute("clip-rule", "evenodd");
            }
            p.setAttribute("d", d);
            svg.appendChild(p);
          };
          addPath(ARCHIVE_ICON_D1, true);
          addPath(ARCHIVE_ICON_D2, false);
          return svg;
        };
        const alreadyOurs = (btn) => {
          const svg = btn.querySelector("svg[" + ICON_MARK + "]");
          if (!svg) return false;
          const first = svg.querySelector("path");
          return !!(first && first.getAttribute("d") === ARCHIVE_ICON_D1);
        };
        const inject = () => {
          let label;
          try { label = t("nav"); } catch { label = undefined; }
          if (!label) return;
          const rows = document.querySelectorAll('[role="dialog"] nav button');
          for (let i = 0; i < rows.length; i++) {
            const btn = rows[i];
            if (btn.textContent.replace(/\s+/g, " ").trim() !== label) continue;
            if (alreadyOurs(btn)) continue;
            // 图标槽 = 导航 label span 的前一个兄弟；找不到 label span 时，
            // 若首个子元素不是 span（裸 svg 结构）也视作图标槽直接替换。
            const children = Array.from(btn.children);
            const labelIdx = children.findIndex(
              (c) => c.tagName === "SPAN" && c.textContent.replace(/\s+/g, " ").trim() === label
            );
            const slot = labelIdx > 0 ? children[labelIdx - 1] : null;
            if (!slot) continue;
            const icon = makeIcon();
            if (slot.tagName === "SVG") {
              slot.replaceWith(icon);
            } else {
              while (slot.firstChild) slot.removeChild(slot.firstChild);
              slot.appendChild(icon);
            }
          }
        };
        inject();
        const mo = new MutationObserver(inject);
        mo.observe(document.body, { childList: true, subtree: true, characterData: true });
        return () => mo.disconnect();
      }, "dsh-archive-manager: settings nav icon injection");
    }

    exports.NS = NS;
    exports.apply = apply;
    exports.inject = inject;
    // 供测试直接验证分会话 localStorage 清理（浏览器侧无其他可观测入口）。
    exports.SESSION_LS_PREFIXES = SESSION_LS_PREFIXES;
    exports.CURRENT_SESSION_KEY = CURRENT_SESSION_KEY;
    exports.purgeSessionLocalStorage = purgeSessionLocalStorage;
    // 供测试直接验证会话名称悬停提示的视口夹取逻辑（浏览器侧无其他可观测入口）。
    exports.titleTooltipPosition = titleTooltipPosition;
    // 供测试验证归档页默认排序与排序比较逻辑。
    exports.DEFAULT_SORT = DEFAULT_SORT;
    exports.sortSessions = sortSessions;
    return module.exports;
  }
});
