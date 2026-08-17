// Client half of the dsh-archive-manager plugin.
// Hand-written browser bundle in the lazy-CJS format the client module loader
// expects: it only REGISTERS the factory; the body runs at materialization.
// It registers a settings.section entry ("归档") and renders the archived
// sessions page: grouped by workspace, filterable (all / one workspace),
// sortable (name / created time), with per-session "取消归档" and "删除"
// actions plus a top "删除全部" action — every delete guarded by a second
// confirmation dialog. All mutations go through the same-origin routes
// registered by the host half.
window.__ModuleLoader__.load({
  id: "dsh-archive-manager",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");

    const NS = "settings.archiveManager";

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
      filterLabel: "筛选：",
      sortLabel: "排序：",
      sortNameAsc: "按名称 ↑",
      sortNameDesc: "按名称 ↓",
      sortCreatedAsc: "按创建时间 ↑",
      sortCreatedDesc: "按创建时间 ↓",
      deleteAll: "删除全部",
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
      noticeFile: "（清理记录成功，但日志文件删除失败）"
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
      filterLabel: "Filter:",
      sortLabel: "Sort:",
      sortNameAsc: "Name ↑",
      sortNameDesc: "Name ↓",
      sortCreatedAsc: "Created ↑",
      sortCreatedDesc: "Created ↓",
      deleteAll: "Delete all",
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
      confirmPrimary: "Delete",
      cancel: "Cancel",
      ok: "OK",
      unarchiveOk: "Unarchived: {title}",
      unarchiveFail: "Unarchive failed: {message}",
      deleteOk: "Deleted: {title}",
      deleteFail: "Delete failed: {message}",
      deleteAllOk: "Deleted {n} sessions",
      deleteAllPartial: "Some deletions failed ({fail}/{total})",
      noticeFile: "(record cleaned, but log file removal failed)"
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
    function formatTime(ms) {
      if (!ms) return "—";
      const d = new Date(ms);
      const pad = (n) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
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
          arr.sort((a, b) => String(a.title).localeCompare(String(b.title), "zh-Hans-CN"));
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
      wrap: { maxWidth: 720, margin: "0 auto", padding: "16px 20px 40px", fontFamily: "var(--dsw-font-sans, inherit)" },
      title: { margin: "0 0 4px", fontSize: 20, fontWeight: 600, color: "var(--dsw-alias-text-primary)" },
      subtitle: { margin: "0 0 16px", fontSize: 13, color: "var(--dsw-alias-label-tertiary)", lineHeight: 1.5 },
      toolbar: { display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 8 },
      controlGroup: { display: "flex", alignItems: "center", gap: 6 },
      controlLabel: { fontSize: 13, color: "var(--dsw-alias-label-tertiary)" },
      select: {
        fontSize: 13, padding: "4px 8px", borderRadius: 6,
        border: "1px solid var(--dsw-alias-border, #e2e4ea)",
        background: "var(--dsw-surface-canvas, #fff)", color: "var(--dsw-alias-text-primary)"
      },
      buttonsRow: { display: "flex", alignItems: "center", gap: 10, marginLeft: "auto" },
      count: { fontSize: 12, color: "var(--dsw-alias-label-tertiary)" },
      dangerButton: {
        fontSize: 13, padding: "5px 12px", borderRadius: 6, cursor: "pointer",
        border: "1px solid var(--dsw-alias-danger, #d93025)", color: "var(--dsw-alias-danger, #d93025)",
        background: "transparent"
      },
      group: { marginBottom: 20 },
      groupHeader: {
        display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", borderRadius: 6,
        background: "var(--dsw-surface-subtle, #f3f4f6)", color: "var(--dsw-alias-text-secondary)", marginBottom: 4
      },
      groupTitle: { fontWeight: 600, fontSize: 13 },
      groupCount: { fontSize: 12, color: "var(--dsw-alias-label-tertiary)" },
      row: {
        display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", borderRadius: 6,
        borderBottom: "1px solid var(--dsw-alias-hairline, #eceef1)"
      },
      rowTitle: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 14, color: "var(--dsw-alias-text-primary)" },
      rowMeta: { flex: 1, fontSize: 12, color: "var(--dsw-alias-label-tertiary)", whiteSpace: "nowrap" },
      rowActions: { display: "flex", gap: 6, flexShrink: 0 },
      defaultButton: {
        fontSize: 12, padding: "4px 10px", borderRadius: 6, cursor: "pointer",
        border: "1px solid var(--dsw-alias-border, #e2e4ea)",
        background: "var(--dsw-surface-canvas, #fff)", color: "var(--dsw-alias-text-secondary)"
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
        background: "var(--dsw-surface-panel, #fff)", boxShadow: "0 8px 30px rgba(0,0,0,0.18)",
        color: "var(--dsw-alias-text-primary)"
      },
      dialogTitle: { margin: "0 0 10px", fontSize: 16, fontWeight: 600 },
      dialogBody: { fontSize: 14, lineHeight: 1.6, color: "var(--dsw-alias-text-secondary)", marginBottom: 16, wordBreak: "break-word" },
      dialogActions: { display: "flex", justifyContent: "flex-end", gap: 8 },
      primaryDangerButton: {
        fontSize: 13, padding: "6px 14px", borderRadius: 6, cursor: "pointer",
        border: "1px solid var(--dsw-alias-danger, #d93025)",
        background: "var(--dsw-alias-danger, #d93025)", color: "#fff"
      }
    };

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
            React.createElement("button", { style: styles.primaryDangerButton, onClick: onConfirm, disabled: busy }, busy ? "…" : t("confirmPrimary"))
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
        sort: "nameAsc",
        confirm: null, // { kind: 'single'|'all', sessionId?, title? }
        busy: false,
        notice: null
      });

      const set = (patch) => setState((s) => ({ ...s, ...patch }));

      const load = () => {
        set({ loading: true, error: null });
        readList("/api/archive-manager/list")
          .then((res) => {
            if (res && res.ok === true) {
              set({ loading: false, sessions: res.sessions || [], workspaces: res.workspaces || [] });
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
          .then((res) => {
            let notice = null;
            if (res && res.ok === true) {
              notice = onResult ? onResult(res) : null;
            } else {
              notice = (res && res.message) || t("loadError");
            }
            return readList("/api/archive-manager/list").then((listRes) => {
              set({
                busy: false,
                sessions: listRes && listRes.ok ? listRes.sessions || [] : state.sessions,
                workspaces: listRes && listRes.ok ? listRes.workspaces || state.workspaces : state.workspaces,
                notice,
                error: null
              });
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
          (res) => {
            // 删除成功后，让 DSH 前端会话列表立即重拉：
            // 文件删除不会触发 host/session-removed 推送，侧边栏条目会残留到硬刷新。
            if (refreshSessions !== null) refreshSessions();
            const root = t("deleteOk", { title });
            return res.fileDeleted === false ? root + " " + t("noticeFile") : root;
          }
        );
      };
      const onDeleteAll = () => {
        runAction(() => postJson("/api/archive-manager/delete-all", {}), (res) => {
          if (refreshSessions !== null) refreshSessions();
          if (res.deleted === res.total) return t("deleteAllOk", { n: res.deleted });
          return t("deleteAllPartial", { fail: res.failures ? res.failures.length : 0, total: res.total });
        });
      };

      const closeConfirm = () => set({ confirm: null });

      // grouping
      const filtered = state.filter
        ? state.sessions.filter((s) => s.workspaceId === state.filter)
        : state.sessions.slice();
      const sorted = sortSessions(filtered, state.sort);
      const { byWs, ungrouped } = groupSessions(sorted, null);

      const wsTitle = (id) => {
        const found = state.workspaces.find((w) => w.id === id);
        return found ? (found.title || id) : id;
      };

      const confirmNode = state.confirm
        ? React.createElement(ConfirmDialog, {
            title: t("confirmDeleteTitle"),
            body:
              state.confirm.kind === "all"
                ? t("confirmDeleteAll", { n: state.sessions.length })
                : t("confirmDeleteSingle", { title: state.confirm.title || state.confirm.sessionId }),
            busy: state.busy,
            t,
            onCancel: closeConfirm,
            onConfirm: () => {
              if (state.confirm.kind === "all") {
                onDeleteAll();
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
        groups.push({ key: wsId.id, title: wsTitle(wsId.id), items });
      }
      if (ungrouped.length > 0) {
        groups.push({ key: "__ungrouped__", title: t("groupUngrouped"), items: ungrouped });
      }

      const rows = (items) =>
        items.map((s) =>
          React.createElement("div", { key: s.sessionId, style: styles.row },
            React.createElement(
              "div",
              { style: styles.rowTitle, title: s.title },
              s.title
            ),
            React.createElement("div", { style: styles.rowMeta },
              (s.createdAt ? t("createdLabel", { time: formatTime(s.createdAt) }) : "—")
            ),
            React.createElement("div", { style: styles.rowActions },
              React.createElement("button", {
                style: state.busy ? { ...styles.defaultButton, ...styles.defaultButtonDisabled } : styles.defaultButton,
                disabled: state.busy,
                onClick: () => onUnarchive(s.sessionId, s.title)
              }, t("unarchive")),
              React.createElement("button", {
                style: state.busy ? { ...styles.dangerButton, ...styles.defaultButtonDisabled } : styles.dangerButton,
                disabled: state.busy,
                onClick: () => set({ confirm: { kind: "single", sessionId: s.sessionId, title: s.title } })
              }, t("delete"))
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
              state.workspaces.map((w) =>
                React.createElement("option", { key: w.id, value: w.id }, w.title || w.id)
              )
            )
          ),
          React.createElement("div", { style: styles.controlGroup },
            React.createElement("span", { style: styles.controlLabel }, t("sortLabel")),
            React.createElement("select", {
              style: styles.select,
              value: state.sort,
              onChange: (e) => set({ sort: e.target.value })
            },
              React.createElement("option", { value: "nameAsc" }, t("sortNameAsc")),
              React.createElement("option", { value: "nameDesc" }, t("sortNameDesc")),
              React.createElement("option", { value: "createdAsc" }, t("sortCreatedAsc")),
              React.createElement("option", { value: "createdDesc" }, t("sortCreatedDesc"))
            )
          ),
          React.createElement("div", { style: styles.buttonsRow },
            React.createElement("span", { style: styles.count }, t("archiveCount", { n: sorted.length })),
            React.createElement("button", {
              style: state.busy || sorted.length === 0 ? { ...styles.dangerButton, ...styles.defaultButtonDisabled } : styles.dangerButton,
              disabled: state.busy || sorted.length === 0,
              onClick: () => set({ confirm: { kind: "all" } })
            }, t("deleteAll"))
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
                    React.createElement("span", { style: styles.groupCount }, `(${g.items.length})`)
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
      // SessionRuntime.manager.refreshList() 会重新拉取 session.list 并
      // 用新基线剔除已消失的会话；该内部入口在 runtime 版本里长期稳定，
      // 缺失时静默降级（侧边栏残留仍会在硬刷新/重连后消失）。
      const refreshSessions = () => {
        try {
          const sessions = ctx.get("sessions");
          if (sessions && sessions.manager && typeof sessions.manager.refreshList === "function") {
            sessions.manager.refreshList();
          }
        } catch {
          /* ignore */
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
            locale: NS,
            inject: injected
          },
          ArchivePage
        )
      );
    }

    exports.NS = NS;
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
