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
 *       彻底删除：先确认 live session 与 agent 状态，再删除会话日志目录，
 *       最后从 archivedSessionIds 与所属 workspace 的 sessionIds 中移除。
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
import { basename, dirname, join } from "node:path";
import { rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";

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

function unavailable(code, message) {
  return { ok: false, status: 503, code, message };
}

function responseStatus(result) {
  return result && result.status === 503 ? 503 : 200;
}

function sameIds(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((id, index) => id === right[index]);
}

// DSH 0.1.5 returns SessionPersistenceSnapshot { header, revision }, while
// older providers returned bare headers. Normalize at the provider boundary.
async function storedHeaders(persistence) {
  const rows = await persistence.list();
  if (!Array.isArray(rows)) throw new Error("sessionPersistence.list() 未返回数组");
  return rows.map((row) => {
    const header = row?.header ?? row;
    if (!header || typeof header.id !== "string" || header.id.length === 0) {
      throw new Error("sessionPersistence.list() 返回了不兼容的会话快照");
    }
    return header;
  });
}

/**
 * 检查候选目录名是否符合目标会话 ID；这不等同于校验目录内容身份。
 * 真实的无 cwd header 可以合法定位到 `_no-cwd`，不可一概拒绝。
 */
function dirBelongsToSession(dir, sessionId) {
  try {
    return basename(dir) === encodeSegment(sessionId);
  } catch {
    return false;
  }
}

/**
 * 按优先级收集「可能是该会话 artifact 目录」的候选，并只返回真实存在的那些。
 * 顺序即优先顺序：官方 locate 推导出的目录优先，其次是 workspace 记账路径。
 */
function artifactDirCandidates(ctx, dom, persistence, sessionId, header) {
  const candidates = [];
  const push = (dir) => {
    if (typeof dir === "string" && dir.length > 0 && !candidates.includes(dir) && dirBelongsToSession(dir, sessionId)) {
      candidates.push(dir);
    }
  };

  // A genuine cwd-less header belongs in the backend's _no-cwd directory.
  // Pass the normalized header, never the surrounding persistence snapshot.
  if (header !== undefined && typeof persistence.locate === "function") {
    try {
      const loc = persistence.locate(header);
      if (loc && typeof loc.path === "string" && loc.path.length > 0) push(dirname(loc.path));
    } catch {
      /* 交给后续候选 */
    }
  }
  if (header && typeof persistence.locate !== "function") push(sessionDirFor(sessionId, header.cwd));

  // ② workspace 记账记录的 path（兼容回退，并非持久化权威路径），
  //    ③ 以及当前 cwd。两者都可能是会话创建时真实使用的项目目录。
  const recordedPaths = [];
  try {
    const table = dom.table("workspaces");
    for (const [, rec] of table.entries()) {
      if (Array.isArray(rec.sessionIds) && rec.sessionIds.includes(sessionId) && typeof rec.path === "string") {
        recordedPaths.push(rec.path);
      }
    }
  } catch {
    /* ignore */
  }
  try {
    if (typeof ctx.cwd === "string" && ctx.cwd.length > 0) recordedPaths.push(ctx.cwd);
  } catch {
    /* ignore */
  }
  for (const cwd of recordedPaths) push(sessionDirFor(sessionId, cwd));

  try {
    return candidates.filter((dir) => existsSync(dir));
  } catch {
    return [];
  }
}

/**
 * rc.1 的 workspaceRegistry 仍以 state 作为侧边栏归档快照。所有直接状态
 * 兼容访问集中在这里；结构缺失或持久化/内存已失步时，写操作必须停止。
 */
function workspaceStateAdapter(ctx, dom) {
  const registry = ctx.get("workspaceRegistry");
  if (registry === undefined) return unavailable("workspace-registry-unavailable", "workspaceRegistry 服务不可用");
  let durable;
  try {
    durable = dom.global.get();
  } catch (error) {
    return { ok: false, code: "read-failed", message: `读取 workspace 领域失败: ${String(error)}` };
  }
  if (!durable || typeof durable !== "object" || !Array.isArray(durable.archivedSessionIds)) {
    return unavailable("workspace-domain-incompatible", "workspace 领域缺少 archivedSessionIds");
  }
  // 0.1.7 使用公开的归档快照与取消归档方法，避免依赖私有 state/setState。
  if (typeof registry.unarchiveSession === "function" && Array.isArray(registry.archivedSessionIds)) {
    if (!sameIds(durable.archivedSessionIds, registry.archivedSessionIds)) {
      return unavailable("workspace-state-out-of-sync", "workspace 持久化状态与 registry 快照不一致，已拒绝写入");
    }
    return { ok: true, registry, durable, publicApi: true };
  }
  const state = registry.state;
  if (!state || typeof state !== "object" || !Array.isArray(state.archivedSessionIds)) {
    return unavailable("workspace-registry-incompatible", "workspaceRegistry 状态结构与当前插件不兼容");
  }
  if (!sameIds(durable.archivedSessionIds, state.archivedSessionIds)) {
    return unavailable("workspace-state-out-of-sync", "workspace 持久化状态与 registry 快照不一致，已拒绝写入");
  }
  return { ok: true, registry, state, durable, publicApi: false, setState: typeof registry.setState === "function" ? registry.setState.bind(registry) : null };
}

function workspaceMembership(ctx, dom, sessionId) {
  const state = workspaceStateAdapter(ctx, dom);
  if (!state.ok) return state;
  if (typeof state.registry.get !== "function") {
    return unavailable("workspace-registry-incompatible", "workspaceRegistry 缺少 get 能力");
  }
  let table;
  try {
    table = dom.table("workspaces");
  } catch (error) {
    return unavailable("workspace-table-unavailable", `workspace 表不可用: ${String(error)}`);
  }
  if (!table || typeof table.entries !== "function") {
    return unavailable("workspace-table-unavailable", "workspace 表缺少 entries 能力");
  }
  const owners = [];
  for (const [workspaceId, record] of table.entries()) {
    if (Array.isArray(record.sessionIds) && record.sessionIds.includes(sessionId)) owners.push(workspaceId);
  }
  if (owners.length > 1) {
    return unavailable("workspace-membership-invalid", "同一会话同时归属于多个 workspace，已拒绝修改");
  }
  const entities = [];
  for (const workspaceId of owners) {
    const entity = state.registry.get(workspaceId);
    if (!entity || typeof entity.detachSession !== "function") {
      return unavailable("workspace-registry-incompatible", `workspace ${workspaceId} 缺少 detachSession 能力`);
    }
    entities.push({ workspaceId, entity });
  }
  return { ok: true, ...state, entities };
}

/**
 * 读取"归档会话 + 工作区"报告。
 * 返回 { ok:true, archivedSessionIds, workspaces, sessions }。
 * sessions 每项：{ sessionId, workspaceId, workspaceTitle, title, createdAt, cwd }。
 */
async function readArchivedReport(ctx) {
  const dom = workspaceDomain(ctx);
  if (dom === undefined) {
    return unavailable("domain-unavailable", "workspace domain 未挂载（DSH storageDomain 不可用）");
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
    if (persistence !== undefined) headers = await storedHeaders(persistence);
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
  if (dom === undefined) return unavailable("domain-unavailable", "workspace domain 未挂载");
  const global = dom.global.get();
  if (!Array.isArray(global.archivedSessionIds) || !global.archivedSessionIds.includes(sessionId)) {
    return { ok: false, code: "not-archived", message: "会话不在归档集合中" };
  }
  const nextArchived = global.archivedSessionIds.filter((id) => id !== sessionId);

  const membership = workspaceMembership(ctx, dom, sessionId);
  if (!membership.ok) return membership;
  try {
    for (const { entity } of membership.entities) await entity.detachSession(sessionId);
  } catch (error) {
    return { ok: false, code: "write-failed", message: `从 workspace 记账移除失败: ${String(error)}` };
  }
  const remaining = workspaceMembership(ctx, dom, sessionId);
  if (!remaining.ok) return remaining;
  if (remaining.entities.length > 0) {
    return { ok: false, code: "workspace-membership-not-removed", message: "detachSession 完成后 workspace 仍保留该会话，归档状态未修改" };
  }

  const synced = await syncArchivedState(ctx, dom, nextArchived, sessionId);
  if (!synced.ok) return synced;
  return { ok: true, touchedWorkspaces: membership.entities.map(({ workspaceId }) => workspaceId) };
}

/**
 * 持久化新的 archivedSessionIds。新版优先走公开 unarchiveSession；旧版
 * 才回退到 setState/domain 写入。写入前后验证持久化与 registry 快照一致。
 */
async function syncArchivedState(ctx, dom, nextArchived, sessionId) {
  const adapter = workspaceStateAdapter(ctx, dom);
  if (!adapter.ok) return adapter;
  if (adapter.publicApi) {
    if (typeof sessionId !== "string" || !sameIds(adapter.durable.archivedSessionIds.filter((id) => id !== sessionId), nextArchived)) {
      return unavailable("workspace-state-incompatible", "取消归档目标与预期状态不一致");
    }
    try {
      await adapter.registry.unarchiveSession(sessionId);
      const durableAfter = dom.global.get();
      if (!sameIds(durableAfter?.archivedSessionIds, nextArchived) || !sameIds(adapter.registry.archivedSessionIds, nextArchived)) {
        return unavailable("workspace-state-out-of-sync", "取消归档后持久化状态与 registry 快照不一致");
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, code: "write-failed", message: `取消归档失败: ${String(error)}` };
    }
  }
  const nextState = { ...adapter.state, archivedSessionIds: nextArchived.slice() };
  const nextDurable = { ...adapter.durable, archivedSessionIds: nextArchived.slice() };
  try {
    if (adapter.setState !== null) await adapter.setState(nextState);
    else {
      await dom.global.set(nextDurable);
      adapter.registry.state = nextState;
    }
  } catch (error) {
    return { ok: false, code: "write-failed", message: `写入 workspace 归档状态失败: ${String(error)}` };
  }

  let durableAfter;
  try {
    durableAfter = dom.global.get();
  } catch (error) {
    return { ok: false, code: "write-failed", message: `复核 workspace 归档状态失败: ${String(error)}` };
  }
  const memoryAfter = adapter.registry.state;
  if (!sameIds(durableAfter?.archivedSessionIds, nextArchived) || !sameIds(memoryAfter?.archivedSessionIds, nextArchived)) {
    try {
      if (adapter.setState !== null) await adapter.setState(adapter.state);
      else {
        await dom.global.set(adapter.durable);
        adapter.registry.state = adapter.state;
      }
    } catch (rollbackError) {
      return { ok: false, code: "workspace-state-out-of-sync", message: `workspace 状态复核失败且回滚失败: ${String(rollbackError)}` };
    }
    return { ok: false, code: "workspace-state-out-of-sync", message: "workspace 状态复核失败，已回滚" };
  }
  return { ok: true };
}

// ---- 派生数据清理（投影缓存） ----

/** 等待若干毫秒；用于删除后的有界重试，避免定时器长期挂起。 */
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * 删除一个会话的投影缓存记录。
 *
 * 走 `storageDomain` 的域 API 而不是直接 rm 文件：`KvTable.delete` 会把删除排进
 * 该域的写链，持久化后同步更新内存表并发出 `domain/changed`，因此磁盘文档与内存
 * 态一起失效。直接删文件会留下内存残影——列表仍能读到已删会话的缓存值，下次写入
 * 还会把文件重建回来。DSH 官方 README 也把该域声明为「无驱逐/保留面，清理属带外
 * 维护」，所以域 API 是唯一干净通道。
 *
 * 关键竞态：`session/disposed` 时投影缓存用 `void flushSoft(...)` 落盘（fire-and-
 * forget，没有 await）。插件现有的 `persistence.flush()` 只排空日志写入，排不空它。
 * 若那次写回晚于本次删除落地，`<id>.json` 会被重新创建，且记录里的
 * formatVersion/createdAt/cwd 与被删会话完全一致，读侧的身份校验不会丢弃它。因此
 * 删除后必须复核，并在复核仍存在时做有界重试。
 *
 * 旧版 DSH 可能没有挂载该域或结构不同：逐级跳过并如实标注，绝不抛错——派生数据
 * 清理失败不能反过来阻断日志删除。
 *
 * @param ctx DSH 插件上下文。
 * @param sessionId 目标会话 id。
 * @param options.attempts 删后复核的最大尝试次数。
 * @param options.intervalMs 两次尝试之间的等待毫秒数。
 * @returns `{ ok, deleted?, skipped?, code?, message? }`；`ok:false` 表示派生数据残留。
 */
async function purgeProjectionCache(ctx, sessionId, { attempts = 3, intervalMs = 150 } = {}) {
  const storageDomain = ctx.get("storageDomain");
  if (!storageDomain || typeof storageDomain.get !== "function") {
    return { ok: true, skipped: "domain-unavailable" };
  }
  let domain;
  try {
    domain = storageDomain.get("session_projcache");
  } catch {
    return { ok: true, skipped: "domain-unavailable" };
  }
  if (domain === undefined || domain === null) {
    return { ok: true, skipped: "domain-not-open" };
  }
  if (typeof domain.table !== "function") {
    return { ok: true, skipped: "table-incompatible" };
  }
  let table;
  try {
    table = await domain.table("sessions");
  } catch {
    return { ok: true, skipped: "table-incompatible" };
  }
  if (!table || typeof table.delete !== "function" || typeof table.get !== "function") {
    return { ok: true, skipped: "table-incompatible" };
  }

  const rounds = Number.isSafeInteger(attempts) && attempts > 0 ? attempts : 1;
  const wait = Number.isSafeInteger(intervalMs) && intervalMs > 0 ? intervalMs : 0;
  let deleted = false;
  let lastDeleteError = null;
  let lastCheckError = null;

  for (let round = 0; round < rounds; round++) {
    if (round > 0 && wait > 0) await sleep(wait);
    lastDeleteError = null;
    try {
      // delete 在域写链的槽位上判断存在性：先入队的 put 会被本次删除看见。
      if (await table.delete(sessionId) === true) deleted = true;
    } catch (error) {
      lastDeleteError = error;
    }
    lastCheckError = null;
    let present;
    try {
      present = table.get(sessionId) !== undefined;
    } catch (error) {
      lastCheckError = error;
      continue;
    }
    // 内存态同步失效即可判定成功：域保证先持久化再更新内存，所以这里看不到
    // 记录时，磁盘文档也已被移出可读集。
    if (!present) return { ok: true, deleted };
  }

  if (lastCheckError !== null) {
    return {
      ok: false,
      code: "cache-delete-failed",
      deleted,
      message: `复核投影缓存删除结果失败（已尝试 ${rounds} 次）: ${String(lastCheckError)}`
    };
  }
  if (lastDeleteError !== null) {
    return {
      ok: false,
      code: "cache-delete-failed",
      deleted,
      message: `删除投影缓存失败（已尝试 ${rounds} 次）: ${String(lastDeleteError)}`
    };
  }
  return {
    ok: false,
    code: "cache-reappeared",
    deleted,
    message: `投影缓存删除后仍存在（已尝试 ${rounds} 次），可能被 DSH 的异步检查点写回`
  };
}

/** 彻底删除一个归档会话：先删除日志文件（并确认成功），再移除归档与记账。 */
async function deleteSession(ctx, sessionId, fileOps = { rm, stat }) {
  const dom = workspaceDomain(ctx);
  if (dom === undefined) return unavailable("domain-unavailable", "workspace domain 未挂载");
  const global = dom.global.get();
  if (!Array.isArray(global.archivedSessionIds) || !global.archivedSessionIds.includes(sessionId)) {
    return { ok: false, code: "not-archived", message: "会话不在归档集合中" };
  }

  // 删除不可逆：先验证后续每项能力，不能在删完文件后才发现 registry 无法同步。
  const membership = workspaceMembership(ctx, dom, sessionId);
  if (!membership.ok) return membership;
  const persistence = ctx.get("sessionPersistence");
  if (!persistence || typeof persistence.list !== "function") {
    return unavailable("session-persistence-unavailable", "sessionPersistence 服务不可用");
  }
  const sessionsSvc = ctx.get("sessions");
  if (!sessionsSvc || typeof sessionsSvc.get !== "function") {
    return unavailable("sessions-unavailable", "sessions 服务不可用，无法确认会话是否仍在运行");
  }

  // Read failures and unsupported snapshots must never become "already absent".
  try {
    await storedHeaders(persistence);
  } catch (error) {
    return unavailable("persistence-read-failed", `读取会话持久化快照失败: ${String(error)}`);
  }

  // 0) 处理 live session（DSH 内存中的 Session 对象）。
  //    若会话仍在 ctx.sessions（agent 结束后会话保持 attached），仅删文件不会让
  //    DSH 前端移除它：session.list 的 live 部分仍返回它，侧边栏显示"复活"。
  //    - 真正运行中（agent.status === "running"）→ 拒绝删除；
  //    - 空闲 live（agent idle 或没有 agent）→ 先 detachEntered 从内存移除，
  //      触发 session/disposed → api-proxy 推送 host/session-removed → 前端
  //      侧边栏立即移除；DSH 的 agent-loop 也会在 session/disposed 时自动
  //      清理关联的 idle agent（checkReleased）。
  //    必须"先 detach、后删文件"：避免 DSH 后续 flush 该会话把日志写回磁盘。
  let live;
  try {
    live = sessionsSvc.get(sessionId);
  } catch (error) {
    return unavailable("sessions-unavailable", `读取 live session 失败: ${String(error)}`);
  }
  if (live !== undefined) {
    if (typeof sessionsSvc.liveEntryFor !== "function" || typeof sessionsSvc.detachEntered !== "function") {
      return unavailable("sessions-incompatible", "sessions 服务缺少安全移除 live session 的能力");
    }
    // 只拒绝真正 running 的 agent；idle agent（agent 存在但 status 非
    // "running"）视为空闲，允许删除。
    const agents = ctx.get("agents");
    if (!agents || typeof agents.get !== "function") {
      return unavailable("agents-unavailable", "agents 服务不可用，无法确认 live session 是否仍在运行");
    }
    let agent;
    try {
      agent = agents.get(sessionId);
    } catch (error) {
      return unavailable("agents-unavailable", `读取 agent 状态失败: ${String(error)}`);
    }
    if (agent !== undefined && agent.status === "running") {
      return { ok: false, code: "session-running", message: "该会话正在运行，请先停止或等待结束后再删除" };
    }
    if (typeof persistence.flush !== "function") {
      return unavailable("session-persistence-incompatible", "sessionPersistence 缺少 flush 能力，无法安全删除");
    }
    try {
      const entry = sessionsSvc.liveEntryFor(live);
      sessionsSvc.detachEntered(entry);
    } catch (error) {
      return { ok: false, code: "session-detach-failed", message: `从内存移除 live session 失败: ${String(error)}` };
    }

    // 保留 live writer 的排空防护。dispose 的异步 close 不由 detach 返回，
    // flush 排空当前仍活跃的 write handles；这不是本次复现的根因证明。
    try {
      await persistence.flush();
    } catch (error) {
      return unavailable("persistence-flush-failed", `等待会话持久化排空失败: ${String(error)}`);
    }
  }

  // 1) 必须从 { header, revision } 快照解包后查找 ID 和定位目录。
  //    把快照当 header 会误判「不存在」，继而仅清归档标记、留下真实日志。
  let header;
  try {
    const headers = await storedHeaders(persistence);
    header = headers.find((h) => h.id === sessionId);
  } catch (error) {
    return unavailable("persistence-read-failed", `读取会话持久化快照失败: ${String(error)}`);
  }
  const candidates = artifactDirCandidates(ctx, dom, persistence, sessionId, header);

  // 2) 逐个候选执行删除并确认；不存在任何候选时不得谎报成功。
  let deletedDir = null;
  let triedDir = null;
  if (candidates.length === 0) {
    // 没有任何候选目录存在于磁盘上。若该会话仍在持久化列表中，说明它的 artifact
    // 确实还在、只是我们没能定位 —— 必须显式失败，保持归档标记不变。
    const stillListed = header !== undefined;
    if (stillListed) {
      return { ok: false, code: "delete-file-failed", message: "无法定位该会话的日志目录，删除失败（会话仍保留在归档中）" };
    }
    // 会话已不在持久化列表（日志本就不存在）——仅需清理归档与记账。
  } else {
    triedDir = candidates[0];
    let lastError = null;
    for (const dir of candidates) {
      try {
        await fileOps.rm(dir, { recursive: true, force: true });
        const exists = await fileOps.stat(dir).then(() => true).catch((error) => {
          if (error.code === "ENOENT") return false;
          throw error;
        });
        if (!exists) {
          deletedDir = dir;
          break;
        }
        lastError = new Error("目录删除后仍存在");
      } catch (error) {
        lastError = error;
      }
    }
    if (deletedDir === null) {
      return {
        ok: false,
        code: "delete-file-failed",
        message: `删除日志目录失败（已尝试 ${candidates.length} 个候选路径）: ${String(lastError)}`
      };
    }
  }

  // Current DSH exposes an authoritative stat(id), including pending entries.
  // Confirm absence there too: deleting a guessed path is not proof of deletion.
  if (typeof persistence.stat === "function") {
    try {
      if (await persistence.stat(sessionId) !== undefined) {
        return { ok: false, code: "delete-file-failed", message: "持久化服务仍返回该会话，归档状态未修改" };
      }
    } catch (error) {
      return unavailable("persistence-read-failed", `复核会话删除失败: ${String(error)}`);
    }
  }

  // 3) 文件已确认删除（或本就不存在）后，清理该会话的派生数据。
  //    顺序在日志之后：日志是权威数据，派生数据清理失败不能让会话「看起来删掉了
  //    但日志还在」；反过来日志已删时缓存残留只是冗余，不影响正确性。
  //    失败不阻断主流程，只如实上报，由前端在成功提示里附带说明。
  const cache = await purgeProjectionCache(ctx, sessionId).catch((error) => ({
    ok: false,
    code: "cache-delete-failed",
    message: `清理投影缓存时发生异常: ${String(error)}`
  }));

  // 4) 移除归档集合 + workspace 记账。
  const removed = await writeRemove(ctx, sessionId);
  if (!removed.ok) {
    return { ok: false, code: removed.code, message: `记录清理失败: ${removed.message}` };
  }

  return { ok: true, fileDeleted: true, deletedDir, triedDir, cache };
}

// ---- 路由处理器 ----

async function handleList(ctx, res) {
  const report = await readArchivedReport(ctx);
  if (!report.ok) {
    sendJson(res, responseStatus(report), { ok: false, code: report.code, message: report.message });
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
    sendJson(res, 503, { ok: false, code: "domain-unavailable", message: "workspace domain 未挂载" });
    return;
  }
  const global = dom.global.get();
  if (!Array.isArray(global.archivedSessionIds) || !global.archivedSessionIds.includes(sessionId)) {
    sendJson(res, 200, { ok: false, code: "not-archived", message: "会话不在归档集合中" });
    return;
  }
  try {
    const result = await syncArchivedState(
      ctx,
      dom,
      global.archivedSessionIds.filter((id) => id !== sessionId),
      sessionId
    );
    if (!result.ok) {
      sendJson(res, responseStatus(result), { ok: false, code: result.code, message: result.message });
      return;
    }
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
    sendJson(res, responseStatus(result), result);
  } catch (error) {
    ctx.logger.warn("dsh-archive-manager: delete session failed");
    ctx.logger.warn(error);
    sendJson(res, 200, { ok: false, code: "internal", message: "删除会话失败" });
  }
}

async function handleDeleteAll(ctx, res) {
  const report = await readArchivedReport(ctx);
  if (!report.ok) {
    sendJson(res, responseStatus(report), { ok: false, code: report.code, message: report.message });
    return;
  }
  const ids = report.archivedSessionIds.slice();
  const failures = [];
  // 主流程（日志 + 归档记录）失败与会话成功但派生数据残留分开统计：
  // 前者影响 deleted/total，后者只在 cacheFailures 里体现，不改变成功语义。
  let cacheFailures = 0;
  let okCount = 0;
  for (const sid of ids) {
    try {
      const r = await deleteSession(ctx, sid);
      if (r.ok) {
        okCount += 1;
        if (r.cache && r.cache.ok === false) cacheFailures += 1;
      } else {
        failures.push({ sessionId: sid, code: r.code, message: r.message });
      }
    } catch (error) {
      failures.push({ sessionId: sid, code: "internal", message: String(error) });
    }
  }
  const unavailableFailure = okCount === 0 && failures.length > 0 && failures.every((failure) => failure.code.endsWith("-unavailable") || failure.code.endsWith("-incompatible") || failure.code === "workspace-state-out-of-sync");
  if (unavailableFailure) {
    sendJson(res, 503, { ok: false, code: failures[0].code, message: failures[0].message, deleted: 0, total: ids.length, cacheFailures, failures });
    return;
  }
  sendJson(res, 200, { ok: true, deleted: okCount, total: ids.length, cacheFailures, failures });
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

export { name, inject, apply, deleteSession, purgeProjectionCache, readArchivedReport, sessionDirFor };
