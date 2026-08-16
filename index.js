/**
 * dsh-archive-manager — host half.
 *
 * 在 DSH web 服务器上注册同源 JSON 路由，供设置页「归档」使用：
 *
 *   GET  /api/archive-manager/list
 *       返回全部已归档会话 + 工作区清单。每项含：sessionId、归属
 *       workspaceId（无则 null → 侧边栏 Ungrouped）、会话标题、创建时间。
 *       数据源：storageDomain.get('workspace') 的 global.archivedSessionIds
 *       与 tables.workspaces[*].sessionIds（决定分组）。
 *
 *   POST /api/archive-manager/unarchive   { sessionId }
 *       取消归档：从 global.archivedSessionIds 移除该 id，保留日志与记账，
 *       会话恢复到侧边栏对应工作区分组并可重新打开。
 *       写入 global 的同时触发 domain/changed → api-proxy 推 stream
 *       host/archived-sessions-changed，浏览器侧边栏即时刷新。
 *
 *   POST /api/archive-manager/delete      { sessionId }
 *       彻底删除：先从 archivedSessionIds 与其所属 workspace 的 sessionIds
 *       中移除（先保证 DSH 状态一致，再尽力删除会话日志目录）。
 *
 *   POST /api/archive-manager/delete-all
 *       对当前全部归档会话逐个执行删除。
 *
 * 归档机制与安全约定：
 *   - DSH 没有官方的 "unarchiveSession" / "删除会话" API（workspaceRegistry
 *     host 只暴露 archiveSession）。因此本插件直接读写 storageDomain 的
 *     'workspace' 领域存储（~/.dsh/storages/workspace.json），严格保持其
 *     schema（initialized / workspaceIds / archivedSessionIds /
 *     tables.workspaces[*].sessionIds），不做就地字段改写，避免破坏 DSH
 *     启动时的 fail-loud 校验。
 *   - workspace.json 是该领域的持久化 medium，删除会话日志后，DSH 的
 *     SQLite 搜索索引会在下一次 reconciliation 自动清理该会话。
 *   - 删除为不可恢复操作，且只在会话确实处于归档集合时才执行。
 *
 * 浏览器契约（同源 fetch）：
 *   list/delete/delete-all 返回 { ok:true, ... }
 *   失败返回 { ok:false, code, message }
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { rm, stat } from "node:fs/promises";

const name = "dsh-archive-manager";
const inject = ["webServer", "storageDomain", "sessionPersistence"];

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};

function sendJson(res, status, body) {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

// ---- 会话日志目录定位（复刻 dsh-session-persistence-jsonl 的路径编码） ----

function encodeSegment(raw) {
  if (raw.length === 0) throw new Error("cannot encode an empty path segment");
  if (raw === ".") return "~002E";
  if (raw === "..") return "~002E~002E";
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
    else out += "~" + code.toString(16).toUpperCase().padStart(4, "0");
  }
  return out;
}

function projectKey(cwd) {
  if (cwd.length === 0) throw new Error("cannot encode an empty project path");
  let readable = "";
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === "/" || ch === "\\" || ch === ":") {
      if (!separatorRun) readable += "-";
      separatorRun = true;
    } else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += "~" + code.toString(16).toUpperCase().padStart(4, "0");
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
}

/** DSH home 的 sessions 根目录。 */
function sessionsRoot() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ""
    ? process.env.DSH_HOME
    : join(homedir(), ".dsh");
  return join(home, "sessions");
}

/** 定位某个会话的日志目录；cwd 未知时返回 null（交由调用方降级处理）。 */
function sessionDirFor(sessionId, cwd) {
  if (typeof cwd !== "string" || cwd.length === 0) return null;
  try {
    return join(sessionsRoot(), projectKey(cwd), encodeSegment(sessionId));
  } catch {
    return null;
  }
}

// ---- workspace 领域读写 ----

function workspaceDomain(ctx) {
  const storageDomain = ctx.get("storageDomain");
  if (storageDomain === undefined) return undefined;
  return storageDomain.get("workspace");
}

/**
 * 读取"归档会话 + 工作区"报告。
 * 返回 { ok:true, archivedSessionIds, workspaces, sessions }。
 * sessions 每项：{ sessionId, workspaceId, workspaceTitle, title, createdAt, cwd }。
 */
async function readArchivedReport(ctx) {
  const dom = workspaceDomain(ctx);
  if (dom === undefined) {
    return { ok: false, code: "domain-unavailable", message: "workspace domain 未挂载（DSH storageDomain 不可用）" };
  }
  let global;
  try {
    global = dom.global.get();
  } catch (error) {
    return { ok: false, code: "read-failed", message: `读取 workspace 领域失败: ${String(error)}` };
  }
  const archived = Array.isArray(global.archivedSessionIds) ? global.archivedSessionIds : [];

  // 工作区记录
  const workspaces = [];
  const ownerBySession = new Map();
  let table = undefined;
  try {
    table = dom.table("workspaces");
    for (const [wid, rec] of table.entries()) {
      const ws = {
        id: wid,
        title: rec.title,
        path: rec.path,
        sessionIds: Array.isArray(rec.sessionIds) ? rec.sessionIds.slice() : []
      };
      workspaces.push(ws);
      for (const sid of ws.sessionIds) ownerBySession.set(sid, wid);
    }
  } catch {
    /* 表读取失败时仍可返回仅有 archivedSessionIds 的列表 */
  }

  // 会话 header（id/createdAt/cwd）
  let headers = [];
  try {
    const persistence = ctx.get("sessionPersistence");
    if (persistence !== undefined) headers = await persistence.list();
  } catch {
    /* header 列表读取失败时降级：用 workspace 记账推断属主，标题留空 */
  }
  const headerById = new Map(headers.map((h) => [h.id, h]));

  const wsById = new Map(workspaces.map((w) => [w.id, w]));

  // 批量解析标题（可选 service；失败则退回仅用 id）
  const sessionQuery = ctx.get("sessionQuery");
  const titleById = new Map();
  const titleFromObservation = (obs) => {
    if (obs && typeof obs === "object" && obs.title && typeof obs.title === "object" && typeof obs.title.title === "string") {
      return obs.title.title.trim() !== "" ? obs.title.title : undefined;
    }
    if (obs && typeof obs === "object" && typeof obs.title === "string" && obs.title.trim() !== "") {
      return obs.title.trim();
    }
    return undefined;
  };
  if (sessionQuery !== undefined && archived.length > 0) {
    try {
      const results = await sessionQuery.readTitleSnapshots(archived);
      if (Array.isArray(results)) {
        for (const r of results) {
          if (!r || typeof r !== "object") continue;
          if (r.status === "fulfilled" && r.value && typeof r.value === "object" && r.sessionId !== undefined) {
            const t = titleFromObservation(r.value);
            if (t !== undefined) titleById.set(r.sessionId, t);
          }
        }
      }
    } catch {
      /* fall through */
    }
  }
  if (titleById.size < archived.length && sessionQuery !== undefined) {
    for (const sid of archived) {
      if (titleById.has(sid)) continue;
      try {
        const snap = await sessionQuery.readTitle(sid);
        const t = titleFromObservation(snap);
        if (t !== undefined) titleById.set(sid, t);
      } catch {
        /* fall through */
      }
    }
  }

  const sessions = archived.map((sid) => {
    const header = headerById.get(sid);
    const wsId = ownerBySession.get(sid);
    const ws = wsId !== undefined ? wsById.get(wsId) : undefined;
    const title = titleById.get(sid);
    const cwd = header && typeof header.cwd === "string" ? header.cwd : (ws ? ws.path : undefined);
    return {
      sessionId: sid,
      workspaceId: ws ? ws.id : null,
      workspaceTitle: ws ? ws.title : null,
      title: typeof title === "string" && title.trim() !== "" ? title : sid,
      createdAt: header && typeof header.createdAt === "number" ? header.createdAt : null,
      cwd
    };
  });

  return {
    ok: true,
    archivedSessionIds: archived.slice(),
    workspaces: workspaces.map((w) => ({ id: w.id, title: w.title, path: w.path })),
    sessions
  };
}

/** 从 archivedSessionIds 与所属 workspace 的 sessionIds 中移除；作用于持久化领域。 */
async function writeRemove(ctx, sessionId) {
  const dom = workspaceDomain(ctx);
  if (dom === undefined) return { ok: false, code: "domain-unavailable", message: "workspace domain 未挂载" };
  const global = dom.global.get();
  if (!Array.isArray(global.archivedSessionIds) || !global.archivedSessionIds.includes(sessionId)) {
    return { ok: false, code: "not-archived", message: "会话不在归档集合中" };
  }
  const nextArchived = global.archivedSessionIds.filter((id) => id !== sessionId);

  const registry = ctx.get("workspaceRegistry");
  const touched = [];

  // 从所有 workspace 的 sessionIds 中移除该 id。
  // 优先走官方 WorkspaceEntity.detachSession（会更新 entity.record 缓存、
  // stamping updatedAt、修剪无效记账并发出 domain/changed），
  // 避免裸 table.update 导致 registry 内存缓存与存储失步。
  let table;
  try {
    table = dom.table("workspaces");
  } catch {
    table = undefined;
  }
  if (table !== undefined) {
    try {
      for (const [wid, rec] of table.entries()) {
        const ids = Array.isArray(rec.sessionIds) ? rec.sessionIds : [];
        if (!ids.includes(sessionId)) continue;
        const entity = registry !== undefined ? registry.get(wid) : undefined;
        if (entity !== undefined && typeof entity.detachSession === "function") {
          await entity.detachSession(sessionId);
        } else {
          const next = ids.filter((id) => id !== sessionId);
          await table.update(wid, (r) => ({ ...r, sessionIds: next }));
        }
        touched.push(wid);
      }
    } catch (error) {
      return { ok: false, code: "write-failed", message: `从 workspace 记账移除失败: ${String(error)}` };
    }
  }

  await syncArchivedState(ctx, dom, nextArchived);
  return { ok: true, touchedWorkspaces: touched };
}

/**
 * 持久化新的 archivedSessionIds，并将 workspaceRegistry 的内存 state 同步到
 * 同一值。DSH 的 WorkspaceRegistry 是单一写入者（其 `archivedSessionIds`
 * getter 直接读内存 `this.state`），若只写存储不写内存，后续侧边栏再归档/
 * 排序等写入会基于旧缓存覆盖本次变更（实测：取消归档后再归档不显示、
 * 硬刷新后会话消失）。因此这里两者必须一起更新。
 */
async function syncArchivedState(ctx, dom, nextArchived) {
  const global = dom.global.get();
  await dom.global.set({ ...global, archivedSessionIds: nextArchived });
  const registry = ctx.get("workspaceRegistry");
  if (registry !== undefined && registry.state !== undefined && registry.state !== null) {
    registry.state = { ...registry.state, archivedSessionIds: nextArchived.slice() };
  }
}

/** 彻底删除一个归档会话：先删除日志文件（并确认成功），再移除归档与记账。 */
async function deleteSession(ctx, sessionId) {
  const dom = workspaceDomain(ctx);
  if (dom === undefined) return { ok: false, code: "domain-unavailable", message: "workspace domain 未挂载" };
  const global = dom.global.get();
  if (!Array.isArray(global.archivedSessionIds) || !global.archivedSessionIds.includes(sessionId)) {
    return { ok: false, code: "not-archived", message: "会话不在归档集合中" };
  }

  // 1) 定位会话日志目录。
  //    优先使用官方 sessionPersistence.locate(header)（backend 权威 artifact 路径）；
  //    不可用时回退到 header.cwd / workspace 记账 path 自行编码目录名。
  let targetDir = null;
  let located = false;
  const persistence = ctx.get("sessionPersistence");
  try {
    if (persistence !== undefined) {
      // 先取 header（list 是轻量元数据列出，不解析完整日志）
      let header;
      try {
        const headers = await persistence.list();
        header = headers.find((h) => h.id === sessionId);
      } catch {
        /* ignore */
      }
      if (header !== undefined && typeof persistence.locate === "function") {
        const loc = persistence.locate(header);
        if (loc && typeof loc.path === "string" && loc.path.length > 0) {
          const { dirname } = await import("node:path");
          targetDir = dirname(loc.path);
          located = true;
        }
      }
    }
  } catch {
    /* fall back below */
  }

  if (!located) {
    // 回退：用 header.cwd 或 workspace 记账 path 编码
    let cwd;
    try {
      if (persistence !== undefined) {
        try {
          const inspected = await persistence.load(sessionId);
          if (inspected && inspected.header && typeof inspected.header.cwd === "string") cwd = inspected.header.cwd;
        } catch {
          /* fall back to workspace 记账 */
        }
      }
    } catch {
      /* ignore */
    }
    if (cwd === undefined) {
      try {
        const table = dom.table("workspaces");
        for (const [, rec] of table.entries()) {
          if (Array.isArray(rec.sessionIds) && rec.sessionIds.includes(sessionId) && typeof rec.path === "string") {
            cwd = rec.path;
            break;
          }
        }
      } catch {
        /* ignore */
      }
    }
    targetDir = sessionDirFor(sessionId, cwd);
  }

  // 2) 先删除日志目录并确认成功。
  //    删除失败时返回错误且不改动归档状态 —— 会话保持隐藏，不会"复活"到侧边栏。
  if (targetDir !== null) {
    try {
      await rm(targetDir, { recursive: true, force: true });
      const exists = await stat(targetDir).then(() => true).catch(() => false);
      if (exists) {
        return { ok: false, code: "delete-file-failed", message: "日志目录删除后仍存在" };
      }
    } catch (error) {
      return { ok: false, code: "delete-file-failed", message: `删除日志目录失败: ${String(error)}` };
    }
  } else {
    // 无法定位日志目录：若该会话在持久化列表中仍存在，则属于不可删除的异常状态；
    // 保持归档标记不变，返回失败，避免"半删"造成会话复活。
    let stillListed = false;
    try {
      if (persistence !== undefined) {
        const headers = await persistence.list();
        stillListed = headers.some((h) => h.id === sessionId);
      }
    } catch {
      /* ignore */
    }
    if (stillListed) {
      return { ok: false, code: "delete-file-failed", message: "无法定位该会话的日志目录，删除失败（会话仍保留在归档中）" };
    }
    // 会话已不在持久化列表（日志已丢失/被清理）——视作可删除：仅需清理归档与记账。
  }

  // 3) 文件已确认删除（或日志本就不存在）后，移除归档集合 + workspace 记账。
  const removed = await writeRemove(ctx, sessionId);
  if (!removed.ok) {
    return { ok: false, code: removed.code, message: `记录清理失败: ${removed.message}` };
  }

  return { ok: true, fileDeleted: true };
}

// ---- 路由处理器 ----

async function handleList(ctx, res) {
  const report = await readArchivedReport(ctx);
  if (!report.ok) {
    sendJson(res, 200, { ok: false, code: report.code, message: report.message });
    return;
  }
  sendJson(res, 200, {
    ok: true,
    archivedSessionIds: report.archivedSessionIds,
    workspaces: report.workspaces,
    sessions: report.sessions
  });
}

async function handleUnarchive(ctx, req, res) {
  let payload = {};
  try {
    payload = JSON.parse((await readBody(req)) || "{}");
  } catch {
    sendJson(res, 200, { ok: false, code: "bad-json", message: "请求体不是合法 JSON" });
    return;
  }
  const sessionId = payload.sessionId;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    sendJson(res, 200, { ok: false, code: "bad-request", message: "缺少 sessionId" });
    return;
  }
  const dom = workspaceDomain(ctx);
  if (dom === undefined) {
    sendJson(res, 200, { ok: false, code: "domain-unavailable", message: "workspace domain 未挂载" });
    return;
  }
  const global = dom.global.get();
  if (!Array.isArray(global.archivedSessionIds) || !global.archivedSessionIds.includes(sessionId)) {
    sendJson(res, 200, { ok: false, code: "not-archived", message: "会话不在归档集合中" });
    return;
  }
  try {
    await syncArchivedState(
      ctx,
      dom,
      global.archivedSessionIds.filter((id) => id !== sessionId)
    );
    sendJson(res, 200, { ok: true, sessionId });
  } catch (error) {
    sendJson(res, 200, { ok: false, code: "write-failed", message: `取消归档失败: ${String(error)}` });
  }
}

async function handleDelete(ctx, req, res) {
  let payload = {};
  try {
    payload = JSON.parse((await readBody(req)) || "{}");
  } catch {
    sendJson(res, 200, { ok: false, code: "bad-json", message: "请求体不是合法 JSON" });
    return;
  }
  const sessionId = payload.sessionId;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    sendJson(res, 200, { ok: false, code: "bad-request", message: "缺少 sessionId" });
    return;
  }
  try {
    const result = await deleteSession(ctx, sessionId);
    sendJson(res, 200, result);
  } catch (error) {
    ctx.logger.warn("dsh-archive-manager: delete session failed");
    ctx.logger.warn(error);
    sendJson(res, 200, { ok: false, code: "internal", message: "删除会话失败" });
  }
}

async function handleDeleteAll(ctx, res) {
  const report = await readArchivedReport(ctx);
  if (!report.ok) {
    sendJson(res, 200, { ok: false, code: report.code, message: report.message });
    return;
  }
  const ids = report.archivedSessionIds.slice();
  const failures = [];
  let okCount = 0;
  for (const sid of ids) {
    try {
      const r = await deleteSession(ctx, sid);
      if (r.ok) okCount += 1;
      else failures.push({ sessionId: sid, code: r.code, message: r.message });
    } catch (error) {
      failures.push({ sessionId: sid, code: "internal", message: String(error) });
    }
  }
  sendJson(res, 200, { ok: true, deleted: okCount, total: ids.length, failures });
}

// ---- 插件主体 ----

function apply(ctx) {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "exact",
        path: "/api/archive-manager/list",
        handler: async (req, res) => {
          try {
            await handleList(ctx, res);
          } catch (error) {
            ctx.logger.warn("dsh-archive-manager: list route failed");
            ctx.logger.warn(error);
            sendJson(res, 500, { ok: false, code: "internal", message: "internal error" });
          }
        }
      }),
    "dsh-archive-manager: list route"
  );

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "exact",
        path: "/api/archive-manager/unarchive",
        handler: async (req, res) => {
          try {
            await handleUnarchive(ctx, req, res);
          } catch (error) {
            ctx.logger.warn("dsh-archive-manager: unarchive route failed");
            ctx.logger.warn(error);
            sendJson(res, 500, { ok: false, code: "internal", message: "internal error" });
          }
        }
      }),
    "dsh-archive-manager: unarchive route"
  );

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "exact",
        path: "/api/archive-manager/delete",
        handler: async (req, res) => {
          try {
            await handleDelete(ctx, req, res);
          } catch (error) {
            ctx.logger.warn("dsh-archive-manager: delete route failed");
            ctx.logger.warn(error);
            sendJson(res, 500, { ok: false, code: "internal", message: "internal error" });
          }
        }
      }),
    "dsh-archive-manager: delete route"
  );

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "exact",
        path: "/api/archive-manager/delete-all",
        handler: async (req, res) => {
          try {
            await handleDeleteAll(ctx, res);
          } catch (error) {
            ctx.logger.warn("dsh-archive-manager: delete-all route failed");
            ctx.logger.warn(error);
            sendJson(res, 500, { ok: false, code: "internal", message: "internal error" });
          }
        }
      }),
    "dsh-archive-manager: delete-all route"
  );
}

export { name, inject, apply };
