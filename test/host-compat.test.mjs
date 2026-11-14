import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { apply, deleteSession, inject, name, purgeProjectionCache, readArchivedReport } from "../index.js";

// Optional integration against the installed DSH backend, not a hand-written list mock.
for (const compression of ["none", "zstd"]) for (const noCwd of [false, true]) test(`real DSH ${compression} snapshots delete ungrouped artifacts (noCwd=${noCwd})`, {
  skip: !process.env.DSH_TEST_INSTALL_ROOT
}, async (t) => {
  const base = process.env.DSH_TEST_INSTALL_ROOT + "/node_modules/@deepseek-ai/";
  const { Context } = await import(base + "cordis/lib/index.js");
  const { default: Backend } = await import(base + "dsh-session-persistence-jsonl/lib/index.js");
  const { SESSION_FORMAT_VERSION } = await import(base + "dsh-session/lib/index.js");
  const root = mkdtempSync(join(tmpdir(), "archive-real-backend-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const backend = new Backend(new Context(), { root, compression });
  const header = { version: SESSION_FORMAT_VERSION, id: "session-1", createdAt: 123, ...(noCwd ? {} : { cwd: root }), isSeeded: false };
  const writer = await backend.create(header);
  await writer.flush();
  await writer.close();
  const artifact = backend.locate(header).path;
  const host = makeHost({ includeRegistry: true, workspacePath: "/unrelated-workspace", services: {
    sessionPersistence: backend, sessions: { get: () => undefined }
  } });
  await host.ctx.get("workspaceRegistry").get("workspace-1").detachSession(header.id);
  const report = await readArchivedReport(host.ctx);
  const response = await invoke(host, "/api/archive-manager/delete", { sessionId: header.id });
  assert.equal(response.body.ok, true);
  assert.equal(existsSync(artifact), false, "successful delete must remove the real DSH artifact");
  assert.deepEqual(await backend.list(), [], "DSH must no longer list the deleted session");
  assert.equal(report.sessions[0].cwd, noCwd ? undefined : root);
  assert.equal(report.sessions[0].createdAt, 123);
});

test("real DSH delete-all removes multiple snapshot-backed artifacts", {
  skip: !process.env.DSH_TEST_INSTALL_ROOT
}, async (t) => {
  const base = process.env.DSH_TEST_INSTALL_ROOT + "/node_modules/@deepseek-ai/";
  const { Context } = await import(base + "cordis/lib/index.js");
  const { default: Backend } = await import(base + "dsh-session-persistence-jsonl/lib/index.js");
  const { SESSION_FORMAT_VERSION } = await import(base + "dsh-session/lib/index.js");
  const root = mkdtempSync(join(tmpdir(), "archive-real-batch-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const backend = new Backend(new Context(), { root, compression: "zstd" });
  const ids = ["session-1", "session-2"];
  for (const id of ids) {
    const writer = await backend.create({ version: SESSION_FORMAT_VERSION, id, createdAt: 123, cwd: root, isSeeded: false });
    await writer.flush();
    await writer.close();
  }
  const host = makeHost({ archived: ids, includeRegistry: true, services: {
    sessionPersistence: backend, sessions: { get: () => undefined }
  } });
  const response = await invoke(host, "/api/archive-manager/delete-all");
  assert.equal(response.body.deleted, 2);
  assert.deepEqual(response.body.failures, []);
  assert.deepEqual(await backend.list(), []);
  assert.deepEqual(host.globalState().archivedSessionIds, []);
  assert.deepEqual(host.workspaceRecord().sessionIds, []);
});

test("unreadable or malformed persistence snapshots never clear archive markers", async () => {
  for (const list of [async () => { throw new Error("read failed"); }, async () => [{ revision: "bad" }]]) {
    let detached = false;
    const host = makeHost({ includeRegistry: true, services: {
      sessionPersistence: { list },
      sessions: { get: () => ({ id: "session-1" }), detachEntered: () => { detached = true; } }
    } });
    const response = await invoke(host, "/api/archive-manager/delete", { sessionId: "session-1" });
    assert.equal(response.body.code, "persistence-read-failed");
    assert.equal(detached, false);
    assert.deepEqual(host.globalState().archivedSessionIds, ["session-1"]);
    assert.deepEqual(host.workspaceRecord().sessionIds, ["session-1"]);
  }
});

test("a listed snapshot without a resolvable artifact is not an already-deleted session", async () => {
  const host = makeHost({ includeRegistry: true, services: {
    sessionPersistence: { list: async () => [{ header: { id: "session-1" }, revision: "r1" }] },
    sessions: { get: () => undefined }
  } });
  const response = await invoke(host, "/api/archive-manager/delete", { sessionId: "session-1" });
  assert.equal(response.body.ok, false);
  assert.deepEqual(host.globalState().archivedSessionIds, ["session-1"]);
});

test("snapshot deletion verifies backend absence before clearing archive records", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "archive-stat-verification-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const outcome of ["absent", "present", "error"]) {
    const dir = join(root, outcome, "session-1");
    mkdirSync(dir, { recursive: true });
    const header = { id: "session-1", cwd: root };
    const host = makeHost({ includeRegistry: true, services: {
      sessions: { get: () => undefined },
      sessionPersistence: {
        list: async () => [{ header, revision: "r1" }],
        locate: (value) => {
          assert.equal(value, header);
          return { path: join(dir, "session.jsonl") };
        },
        stat: async () => {
          if (outcome === "error") throw new Error("backend read failed");
          return outcome === "present" ? { header, revision: "r2" } : undefined;
        }
      }
    } });
    const response = await invoke(host, "/api/archive-manager/delete", { sessionId: header.id });
    assert.equal(response.body.ok, outcome === "absent");
    assert.deepEqual(host.globalState().archivedSessionIds, outcome === "absent" ? [] : [header.id]);
    assert.deepEqual(host.workspaceRecord().sessionIds, outcome === "absent" ? [] : [header.id]);
  }
});

/**
 * 构造一个最小可用的 DSH 宿主替身。
 *
 * `projectionCache` 用于模拟 `session_projcache` 域，缺省（`undefined`）代表旧版
 * DSH 未挂载该域，插件应当跳过缓存清理而不报错。传入一个 `Map` 即视为已挂载：
 * 记录存在其中，`delete` 移除它，`get` 读它。传入 `{ table: ... }` 形式可自定义
 * 表行为（例如模拟「删了又被异步写回」）。
 *
 * `workspaces` 用于多工作区 / 未分组场景：缺省仍是单个 `workspace-1`（SessionIds
 * 等于 archived），传入数组后按 `{ id, title, sessionIds }` 建立记账；未列在任何
 * 工作区里的归档会话即「未分组」。
 */
function makeHost({ archived = ["session-1"], includeRegistry = false, services = {}, workspacePath = "/tmp/project", projectionCache = undefined, workspaces = undefined } = {}) {
  let globalState = { archivedSessionIds: archived.slice() };
  const workspaceRecords = new Map(
    workspaces === undefined
      ? [["workspace-1", { title: "Workspace", path: workspacePath, sessionIds: archived.slice() }]]
      : workspaces.map((ws) => [
          ws.id,
          {
            title: ws.title ?? ws.id,
            path: ws.path ?? workspacePath,
            sessionIds: Array.isArray(ws.sessionIds) ? ws.sessionIds.slice() : []
          }
        ])
  );
  const table = {
    entries: () => workspaceRecords.entries(),
    async update(id, update) {
      workspaceRecords.set(id, update(workspaceRecords.get(id)));
    }
  };
  const domain = {
    global: {
      get: () => structuredClone(globalState),
      async set(next) { globalState = structuredClone(next); }
    },
    table: (name) => {
      assert.equal(name, "workspaces");
      return table;
    }
  };
  // 投影缓存域：`undefined` = 未挂载（旧版 DSH）；`Map` = 由记录表自动派生行为；
  // `{ table }` = 用自定义表模拟竞态或写入失败。
  let projectionDomain;
  if (projectionCache !== undefined) {
    let sessionsTable;
    if (projectionCache instanceof Map) {
      const records = projectionCache;
      sessionsTable = {
        get: (key) => records.get(key),
        async delete(key) {
          const existed = records.has(key);
          records.delete(key);
          return existed;
        }
      };
    } else {
      sessionsTable = projectionCache.table;
    }
    projectionDomain = {
      table: (name) => {
        assert.equal(name, "sessions");
        return sessionsTable;
      }
    };
  }
  const routes = new Map();
  const webServer = {
    register(route) {
      routes.set(route.path, route.handler);
      return () => routes.delete(route.path);
    }
  };
  const registry = {
    state: structuredClone(globalState),
    get(id) {
      if (!workspaceRecords.has(id)) return undefined;
      return {
        async detachSession(sessionId) {
          await table.update(id, (record) => ({ ...record, sessionIds: record.sessionIds.filter((candidate) => candidate !== sessionId) }));
        }
      };
    },
    async setState(next) {
      await domain.global.set(next);
      this.state = structuredClone(next);
    }
  };
  const serviceMap = {
    storageDomain: { get: (name) => name === "workspace" ? domain : (name === "session_projcache" ? projectionDomain : undefined) },
    sessionPersistence: { list: async () => [] },
    ...(includeRegistry ? { workspaceRegistry: registry } : {}),
    ...services
  };
  const ctx = {
    webServer,
    effect(setup) { return setup(); },
    get(name) { return serviceMap[name]; },
    logger: { warn() {} }
  };
  apply(ctx);
  return {
    ctx,
    routes,
    globalState: () => structuredClone(globalState),
    registryState: () => structuredClone(registry.state),
    workspaceRecord: (id = "workspace-1") => structuredClone(workspaceRecords.get(id))
  };
}

async function invoke(host, path, body) {
  const req = Readable.from([JSON.stringify(body ?? {})]);
  req.url = path;
  req.method = "POST";
  let status = null;
  let text = "";
  const res = {
    writeHead(value) { status = value; },
    end(value = "") { text += value; }
  };
  await host.routes.get(path)(req, res);
  return { status, body: JSON.parse(text) };
}

test("unarchive refuses to persist when workspaceRegistry is unavailable", async () => {
  const host = makeHost();
  const response = await invoke(host, "/api/archive-manager/unarchive", { sessionId: "session-1" });

  assert.equal(response.status, 503);
  assert.equal(response.body.code, "workspace-registry-unavailable");
  assert.deepEqual(host.globalState().archivedSessionIds, ["session-1"]);
});

test("mutation-only rc.1 services remain optional host dependencies", () => {
  assert.deepEqual(inject, ["webServer", "storageDomain", "sessionPersistence"]);
  for (const optional of ["workspaceRegistry", "sessionQuery", "sessions", "agents"]) {
    assert.equal(inject.includes(optional), false);
  }
});

test("delete refuses before file or workspace mutation when sessions service is unavailable", async () => {
  const host = makeHost({ includeRegistry: true });
  const response = await invoke(host, "/api/archive-manager/delete", { sessionId: "session-1" });

  assert.equal(response.status, 503);
  assert.equal(response.body.code, "sessions-unavailable");
  assert.deepEqual(host.globalState().archivedSessionIds, ["session-1"]);
  assert.deepEqual(host.workspaceRecord().sessionIds, ["session-1"]);
});

test("list remains available when the optional sessionQuery service is absent", async () => {
  const host = makeHost({
    services: {
      sessionPersistence: { list: async () => [{ id: "session-1", createdAt: 123, cwd: "/tmp/project" }] }
    }
  });
  const response = await invoke(host, "/api/archive-manager/list");

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.sessions[0].title, "session-1");
  assert.equal(response.body.sessions[0].createdAt, 123);
});

test("unarchive updates durable and registry archive snapshots together", async () => {
  const host = makeHost({ includeRegistry: true });
  const response = await invoke(host, "/api/archive-manager/unarchive", { sessionId: "session-1" });

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.deepEqual(host.globalState().archivedSessionIds, []);
  assert.deepEqual(host.registryState().archivedSessionIds, []);
});

test("unarchive prefers the public registry API and preserves unrelated workspace state", async () => {
  const host = makeHost({ includeRegistry: true });
  const registry = host.ctx.get("workspaceRegistry");
  let called = 0;
  registry.state.pinnedSessionIds = ["pinned-session"];
  Object.defineProperty(registry, "archivedSessionIds", { get: () => registry.state.archivedSessionIds });
  registry.unarchiveSession = async (sessionId) => {
    called += 1;
    await registry.setState({ ...registry.state, archivedSessionIds: registry.state.archivedSessionIds.filter((id) => id !== sessionId) });
  };
  registry.setState = registry.setState.bind(registry);
  const response = await invoke(host, "/api/archive-manager/unarchive", { sessionId: "session-1" });
  assert.equal(response.body.ok, true);
  assert.equal(called, 1);
  assert.deepEqual(host.globalState().archivedSessionIds, []);
  assert.deepEqual(registry.state.pinnedSessionIds, ["pinned-session"]);
});

test("unarchive preserves the legacy registry state fallback when setState is absent", async () => {
  const registry = {
    state: { archivedSessionIds: ["session-1"] },
    get: () => undefined
  };
  const host = makeHost({ services: { workspaceRegistry: registry } });
  const response = await invoke(host, "/api/archive-manager/unarchive", { sessionId: "session-1" });

  assert.equal(response.body.ok, true);
  assert.deepEqual(host.globalState().archivedSessionIds, []);
  assert.deepEqual(registry.state.archivedSessionIds, []);
});

test("unarchive rejects a stale registry snapshot without changing durable state", async () => {
  const host = makeHost({
    services: {
      workspaceRegistry: {
        state: { archivedSessionIds: [] },
        get: () => undefined
      }
    }
  });
  const response = await invoke(host, "/api/archive-manager/unarchive", { sessionId: "session-1" });

  assert.equal(response.status, 503);
  assert.equal(response.body.code, "workspace-state-out-of-sync");
  assert.deepEqual(host.globalState().archivedSessionIds, ["session-1"]);
});

test("live deletion refuses when agents service cannot confirm running state", async () => {
  const live = { id: "session-1" };
  let detached = false;
  const host = makeHost({
    includeRegistry: true,
    services: {
      sessions: {
        get: () => live,
        liveEntryFor: () => ({ id: live.id }),
        detachEntered: () => { detached = true; }
      }
    }
  });
  const response = await invoke(host, "/api/archive-manager/delete", { sessionId: "session-1" });

  assert.equal(response.status, 503);
  assert.equal(response.body.code, "agents-unavailable");
  assert.equal(detached, false);
  assert.deepEqual(host.globalState().archivedSessionIds, ["session-1"]);
});

test("running live session deletion is rejected without mutation", async () => {
  const live = { id: "session-1" };
  let detached = false;
  const host = makeHost({
    includeRegistry: true,
    services: {
      sessions: {
        get: () => live,
        liveEntryFor: () => ({ id: live.id }),
        detachEntered: () => { detached = true; }
      },
      agents: { get: () => ({ status: "running" }) }
    }
  });
  const response = await invoke(host, "/api/archive-manager/delete", { sessionId: "session-1" });

  assert.equal(response.status, 200);
  assert.equal(response.body.code, "session-running");
  assert.equal(detached, false);
  assert.deepEqual(host.globalState().archivedSessionIds, ["session-1"]);
});

test("idle live deletion detaches memory, deletes the artifact and cleans both records", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "dsh-archive-locate-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const artifactDir = join(root, "session-1");
  const artifact = join(artifactDir, "events.jsonl");
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(artifact, "{}\n", "utf8");
  const live = { id: "session-1" };
  let detached = false;
  const host = makeHost({
    includeRegistry: true,
    services: {
      sessionPersistence: {
        list: async () => [{ id: "session-1", cwd: "/tmp/project" }],
        locate: () => ({ kind: "jsonl", path: artifact }),
        flush: async () => {}
      },
      sessions: {
        get: () => live,
        liveEntryFor: () => ({ id: live.id }),
        detachEntered: () => { detached = true; }
      },
      agents: { get: () => ({ status: "idle" }) }
    }
  });
  const response = await invoke(host, "/api/archive-manager/delete", { sessionId: "session-1" });

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(detached, true);
  assert.equal(existsSync(artifactDir), false);
  assert.deepEqual(host.globalState().archivedSessionIds, []);
  assert.deepEqual(host.registryState().archivedSessionIds, []);
  assert.deepEqual(host.workspaceRecord().sessionIds, []);
});

test("delete falls back to the encoded cwd path when persistence locate fails", async (t) => {
  const dshHome = mkdtempSync(join(tmpdir(), "dsh-archive-home-"));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = dshHome;
  t.after(() => {
    rmSync(dshHome, { recursive: true, force: true });
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  });
  const artifactDir = join(dshHome, "sessions", "--tmp-archive-project--", "session-1");
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(join(artifactDir, "events.jsonl"), "{}\n", "utf8");
  const host = makeHost({
    includeRegistry: true,
    workspacePath: "/tmp/archive-project",
    services: {
      sessionPersistence: {
        list: async () => [{ id: "session-1", cwd: "/tmp/archive-project" }],
        locate: () => { throw new Error("backend locate unavailable"); },
        load: async () => ({ header: { id: "session-1", cwd: "/tmp/archive-project" } })
      },
      sessions: { get: () => undefined }
    }
  });
  const response = await invoke(host, "/api/archive-manager/delete", { sessionId: "session-1" });

  assert.equal(response.body.ok, true);
  assert.equal(existsSync(artifactDir), false);
  assert.deepEqual(host.globalState().archivedSessionIds, []);
});

test("file deletion failure preserves archive and workspace records", async () => {
  const artifactDir = join(tmpdir(), "dsh-archive-delete-failure");
  const host = makeHost({
    includeRegistry: true,
    services: {
      sessionPersistence: {
        list: async () => [{ id: "session-1", cwd: "/tmp/project" }],
        locate: () => ({ kind: "jsonl", path: join(artifactDir, "events.jsonl") })
      },
      sessions: { get: () => undefined }
    }
  });
  const result = await deleteSession(host.ctx, "session-1", {
    rm: async () => { throw new Error("permission denied"); },
    stat: async () => { throw new Error("unused"); }
  });

  assert.equal(result.code, "delete-file-failed");
  assert.deepEqual(host.globalState().archivedSessionIds, ["session-1"]);
  assert.deepEqual(host.workspaceRecord().sessionIds, ["session-1"]);
});

test("delete keeps the archive marker when detachSession leaves workspace membership behind", async () => {
  const host = makeHost({
    services: {
      workspaceRegistry: {
        state: { archivedSessionIds: ["session-1"] },
        get: () => ({ detachSession: async () => {} })
      },
      sessionPersistence: { list: async () => [] },
      sessions: { get: () => undefined }
    }
  });
  const response = await invoke(host, "/api/archive-manager/delete", { sessionId: "session-1" });

  assert.equal(response.body.ok, false);
  assert.equal(response.body.code, "workspace-membership-not-removed");
  assert.deepEqual(host.globalState().archivedSessionIds, ["session-1"]);
  assert.deepEqual(host.workspaceRecord().sessionIds, ["session-1"]);
});

test("delete waits for the detached session's final writer flush before removing the artifact", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "dsh-archive-final-drain-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const artifactDir = join(root, "session-1");
  const artifact = join(artifactDir, "events.jsonl");
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(artifact, "{}\n", "utf8");

  // DSH 的 session/disposed 监听器只执行 writer.close().catch(…)，不把这个 Promise
  // 交回调用方：最终 drain 无条件落地，与插件是否等待无关。这里让写回由一个「无人
  // 等待也会完成」的 drain Promise 触发（固定 20ms），flush 只负责把这个 Promise
  // 暴露给调用方。修复前插件不等它 → rm 之后 artifact 在同一 tick 内被重建。
  // list() 是 DSH session.list 的扫描入口：只有磁盘上仍存在 artifact 时才会把该
  // 会话报回侧边栏 —— 用它直接断言用户可见症状（删除后又出现在侧边栏）。
  let settled = 0;
  let drain = null;
  const persistence = {
    list: async () => (existsSync(artifactDir) ? [{ id: "session-1", cwd: "/tmp/project" }] : []),
    locate: () => ({ kind: "jsonl", path: artifact }),
    flush() {
      return drain ?? Promise.resolve();
    }
  };
  const host = makeHost({
    includeRegistry: true,
    services: {
      sessionPersistence: persistence,
      sessions: {
        get: () => ({ id: "session-1" }),
        liveEntryFor: () => ({ id: "session-1" }),
        detachEntered: () => {
          drain = new Promise((resolve) => {
            setTimeout(() => {
              // 最终 drain：把仍是「关闭中」的会话 artifact 重新落盘。
              mkdirSync(artifactDir, { recursive: true });
              writeFileSync(artifact, "{}\n", "utf8");
              settled += 1;
              resolve();
            }, 20);
          });
          drain.catch(() => {});
        }
      },
      agents: { get: () => ({ status: "idle" }) }
    }
  });

  const response = await invoke(host, "/api/archive-manager/delete", { sessionId: "session-1" });
  const artifactGoneAtReturn = !existsSync(artifactDir);
  await new Promise((resolve) => setTimeout(resolve, 40));
  // 模拟删除成功后客户端 refreshSessions() → DSH session.list 重新扫描磁盘。
  const listedAfterRefresh = await persistence.list();

  assert.equal(response.body.ok, true);
  assert.equal(settled, 1);
  assert.equal(artifactGoneAtReturn, true);
  assert.equal(existsSync(artifactDir), false);
  assert.deepEqual(listedAfterRefresh, []);
  assert.deepEqual(host.globalState().archivedSessionIds, []);
  assert.deepEqual(host.registryState().archivedSessionIds, []);
  assert.deepEqual(host.workspaceRecord().sessionIds, []);
});

test("delete-all reuses the wait-for-final-drain path for every archived session", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "dsh-archive-drain-all-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const artifactDir = join(root, "session-1");
  const artifact = join(artifactDir, "events.jsonl");
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(artifact, "{}\n", "utf8");

  let settled = 0;
  let drain = null;
  const persistence = {
    list: async () => [{ id: "session-1", cwd: "/tmp/project" }],
    locate: () => ({ kind: "jsonl", path: artifact }),
    flush() {
      return drain ?? Promise.resolve();
    }
  };
  const host = makeHost({
    archived: ["session-1"],
    includeRegistry: true,
    services: {
      sessionPersistence: persistence,
      sessions: {
        get: () => ({ id: "session-1" }),
        liveEntryFor: () => ({ id: "session-1" }),
        detachEntered: () => {
          drain = new Promise((resolve) => {
            setTimeout(() => {
              mkdirSync(artifactDir, { recursive: true });
              writeFileSync(artifact, "{}\n", "utf8");
              settled += 1;
              resolve();
            }, 20);
          });
          drain.catch(() => {});
        }
      },
      agents: { get: () => ({ status: "idle" }) }
    }
  });

  const response = await invoke(host, "/api/archive-manager/delete-all", {});
  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.equal(response.body.ok, true);
  assert.equal(response.body.deleted, 1);
  assert.equal(settled, 1);
  assert.equal(existsSync(artifactDir), false);
  assert.deepEqual(host.globalState().archivedSessionIds, []);
  assert.deepEqual(host.registryState().archivedSessionIds, []);
  assert.deepEqual(host.workspaceRecord().sessionIds, []);
});

test("live deletion refuses when the durability barrier is missing or failing", async () => {
  const running = async (persistence) => {
    const host = makeHost({
      includeRegistry: true,
      services: {
        sessionPersistence: persistence,
        sessions: {
          get: () => ({ id: "session-1" }),
          liveEntryFor: () => ({ id: "session-1" }),
          detachEntered: () => {}
        },
        agents: { get: () => ({ status: "idle" }) }
      }
    });
    return { host, response: await invoke(host, "/api/archive-manager/delete", { sessionId: "session-1" }) };
  };

  const missing = await running({ list: async () => [] });
  assert.equal(missing.response.status, 503);
  assert.equal(missing.response.body.code, "session-persistence-incompatible");
  assert.deepEqual(missing.host.globalState().archivedSessionIds, ["session-1"]);
  assert.deepEqual(missing.host.workspaceRecord().sessionIds, ["session-1"]);

  const failing = await running({
    list: async () => [],
    flush: async () => { throw new Error("drain failed"); }
  });
  assert.equal(failing.response.status, 503);
  assert.equal(failing.response.body.code, "persistence-flush-failed");
  assert.deepEqual(failing.host.globalState().archivedSessionIds, ["session-1"]);
  assert.deepEqual(failing.host.workspaceRecord().sessionIds, ["session-1"]);
});

test("non-live deletion does not require the durability barrier", async () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-archive-non-live-"));
  const artifactDir = join(root, "session-1");
  mkdirSync(artifactDir, { recursive: true });
  const host = makeHost({
    includeRegistry: true,
    services: {
      sessionPersistence: {
        list: async () => [{ id: "session-1", cwd: "/tmp/project" }],
        locate: () => ({ kind: "jsonl", path: join(artifactDir, "events.jsonl") })
      },
      sessions: { get: () => undefined }
    }
  });
  try {
    const response = await invoke(host, "/api/archive-manager/delete", { sessionId: "session-1" });
    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    assert.equal(existsSync(artifactDir), false);
    assert.deepEqual(host.globalState().archivedSessionIds, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("delete falls back to workspace bookkeeping when the stored header has no cwd", async (t) => {
  const dshHome = mkdtempSync(join(tmpdir(), "dsh-archive-nocwd-"));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = dshHome;
  t.after(() => {
    rmSync(dshHome, { recursive: true, force: true });
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  });
  const projectPath = "/tmp/archive-project";
  const artifactDir = join(dshHome, "sessions", "--tmp-archive-project--", "session-1");
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(join(artifactDir, "events.jsonl"), "{}\n", "utf8");

  // 真实 DSH 的 persistence.list() 对「已进入内存但还没落盘的 live 会话」会回放
  // tracker 里的 header，这种快照可能缺 cwd；此时按官方 locate() 推导出的路径落在
  // `_no-cwd/…`，rm 静默 no-op。旧实现因此返回 ok:true 却一个文件都没删。
  const host = makeHost({
    archived: ["session-1"],
    includeRegistry: true,
    workspacePath: projectPath,
    services: {
      sessionPersistence: {
        list: async () => [{ id: "session-1" }],
        locate: () => ({ kind: "jsonl", path: join(dshHome, "sessions", "_no-cwd", "session-1", "events.jsonl") })
      },
      sessions: { get: () => undefined }
    }
  });

  const response = await invoke(host, "/api/archive-manager/delete", { sessionId: "session-1" });

  assert.equal(response.body.ok, true);
  assert.equal(existsSync(artifactDir), false);
  assert.deepEqual(host.globalState().archivedSessionIds, []);
  assert.deepEqual(host.registryState().archivedSessionIds, []);
  assert.deepEqual(host.workspaceRecord().sessionIds, []);
});

test("delete refuses to claim success when nothing could be deleted", async () => {
  const host = makeHost({
    archived: ["session-1"],
    includeRegistry: true,
    services: {
      sessionPersistence: {
        list: async () => [{ id: "session-1" }],
        locate: () => ({ kind: "jsonl", path: "/tmp/_no-cwd/session-1/events.jsonl" })
      },
      sessions: { get: () => undefined }
    }
  });

  // 该会话只有归档标记：任何目录都不存在，删除必须显式失败，而不是假成功。
  const result = await deleteSession(host.ctx, "session-1");

  assert.equal(result.ok, false);
  assert.equal(result.code, "delete-file-failed");
  assert.deepEqual(host.globalState().archivedSessionIds, ["session-1"]);
  assert.deepEqual(host.workspaceRecord().sessionIds, ["session-1"]);
});

test("delete-all reports 503 when destructive session checks are unavailable", async () => {
  const host = makeHost({ archived: ["session-1", "session-2"], includeRegistry: true });
  const response = await invoke(host, "/api/archive-manager/delete-all", {});

  assert.equal(response.status, 503);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.code, "sessions-unavailable");
  assert.equal(response.body.deleted, 0);
  assert.deepEqual(host.globalState().archivedSessionIds, ["session-1", "session-2"]);
});

// ---- 派生数据（投影缓存）清理 ----

/** 构造一个能走到「文件已删、进入记录清理」阶段的宿主。 */
function makeDeletableHost(extra = {}) {
  const root = mkdtempSync(join(tmpdir(), "archive-cache-purge-"));
  const dir = join(root, "session-1");
  mkdirSync(dir, { recursive: true });
  const header = { id: "session-1", cwd: root };
  const host = makeHost({
    archived: ["session-1"],
    includeRegistry: true,
    ...extra,
    services: {
      sessions: { get: () => undefined },
      sessionPersistence: {
        list: async () => [{ header, revision: "r1" }],
        locate: () => ({ path: join(dir, "session.v4.jsonl.zstd") }),
        stat: async () => undefined
      },
      ...(extra.services || {})
    }
  });
  return { host, root, header };
}

test("purgeProjectionCache deletes through the domain API when the domain is mounted", async (t) => {
  const records = new Map([["session-1", { identity: {}, rows: {} }]]);
  const { host, root } = makeDeletableHost({ projectionCache: records });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = await purgeProjectionCache(host.ctx, "session-1");

  assert.equal(result.ok, true);
  assert.equal(result.deleted, true);
  assert.equal(records.has("session-1"), false, "域 API 删除必须同时失效内存态");
});

test("purgeProjectionCache skips without failing when the domain is not mounted", async () => {
  const { root } = makeDeletableHost();
  const host = makeHost({ includeRegistry: true });
  try {
    const result = await purgeProjectionCache(host.ctx, "session-1");
    assert.equal(result.ok, true, "未挂载该域是跳过而非失败");
    assert.equal(result.skipped, "domain-not-open");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("purgeProjectionCache skips when the domain exposes no deletable table", async () => {
  const host = makeHost({ includeRegistry: true, projectionCache: { table: {
    get: () => undefined
    // 故意不给 delete：旧版或结构不同的实现
  } } });
  const result = await purgeProjectionCache(host.ctx, "session-1");

  assert.equal(result.ok, true);
  assert.equal(result.skipped, "table-incompatible");
});

test("purgeProjectionCache retries and reports cache-reappeared when a write races back in", async (t) => {
  // 模拟 session/disposed 的 fire-and-forget 检查点：delete 之后记录又出现。
  let calls = 0;
  const table = {
    get: () => ({ identity: {}, rows: {} }),
    async delete() {
      calls += 1;
      return true;
    }
  };
  const { host, root } = makeDeletableHost({ projectionCache: { table } });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = await purgeProjectionCache(host.ctx, "session-1", { attempts: 3, intervalMs: 1 });

  assert.equal(result.ok, false);
  assert.equal(result.code, "cache-reappeared");
  assert.equal(calls, 3, "三次尝试都要真正发起删除");
});

test("purgeProjectionCache reports cache-delete-failed when the domain write throws", async (t) => {
  // 真实的 KvTable.delete 只在持久化成功后才更新内存，因此写入链抛错时
  // 记录仍留在内存态：get 依然能读到它。
  const { host, root } = makeDeletableHost({ projectionCache: { table: {
    get: () => ({ identity: {}, rows: {} }),
    async delete() { throw new Error("domain write chain quarantined"); }
  } } });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = await purgeProjectionCache(host.ctx, "session-1", { attempts: 2, intervalMs: 1 });

  assert.equal(result.ok, false);
  assert.equal(result.code, "cache-delete-failed");
});

test("purgeProjectionCache treats an already-absent record as success", async () => {
  // 缓存本就不存在（例如会话从未 checkpoint 过）：删除是 no-op，不该报失败。
  const host = makeHost({ includeRegistry: true, projectionCache: new Map() });
  const result = await purgeProjectionCache(host.ctx, "session-1");

  assert.equal(result.ok, true);
  assert.equal(result.deleted, false, "记录本就不存在时 deleted 应为 false");
});

test("deleteSession removes the projection cache after the log directory", async (t) => {
  const records = new Map([["session-1", { identity: {}, rows: {} }]]);
  const { host, root } = makeDeletableHost({ projectionCache: records });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = await deleteSession(host.ctx, "session-1");

  assert.equal(result.ok, true);
  assert.equal(result.fileDeleted, true);
  assert.equal(result.cache.ok, true);
  assert.equal(records.has("session-1"), false);
  assert.deepEqual(host.globalState().archivedSessionIds, []);
  assert.deepEqual(host.workspaceRecord().sessionIds, []);
});

test("a projection-cache failure never blocks the log deletion or archive cleanup", async (t) => {
  const { host, root } = makeDeletableHost({ projectionCache: { table: {
    get: () => ({ identity: {}, rows: {} }),
    async delete() { return true; }
  } } });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = await deleteSession(host.ctx, "session-1");

  assert.equal(result.ok, true, "派生数据残留不得让主流程失败");
  assert.equal(result.fileDeleted, true);
  assert.equal(result.cache.ok, false);
  assert.deepEqual(host.globalState().archivedSessionIds, [], "归档标记仍必须清除");
  assert.deepEqual(host.workspaceRecord().sessionIds, []);
});

test("delete-all counts cache residue separately from hard failures", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "archive-cache-batch-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ids = ["session-1", "session-2"];
  const dirs = new Map();
  for (const id of ids) {
    const dir = join(root, id);
    mkdirSync(dir, { recursive: true });
    dirs.set(id, dir);
  }
  // 两个会话的缓存都无法删除：主流程全部成功，但 cacheFailures 应为 2。
  const host = makeHost({
    archived: ids,
    includeRegistry: true,
    projectionCache: { table: {
      get: () => ({ identity: {}, rows: {} }),
      async delete() { return true; }
    } },
    services: {
      sessions: { get: () => undefined },
      sessionPersistence: {
        list: async () => ids.map((id) => ({ header: { id, cwd: root }, revision: "r1" })),
        locate: (header) => ({ path: join(dirs.get(header.id), "session.v4.jsonl.zstd") }),
        stat: async () => undefined
      }
    }
  });

  const response = await invoke(host, "/api/archive-manager/delete-all", {});

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.deleted, 2);
  assert.equal(response.body.cacheFailures, 2);
  assert.deepEqual(response.body.failures, []);
  assert.deepEqual(host.globalState().archivedSessionIds, []);
});

// ---- 按工作区整组删除 ----

test("delete-workspace only removes the requested workspace's archived sessions", async () => {
  const host = makeHost({
    archived: ["session-a1", "session-a2", "session-b1", "session-u1"],
    includeRegistry: true,
    workspaces: [
      { id: "workspace-a", title: "Alpha", sessionIds: ["session-a1", "session-a2"] },
      { id: "workspace-b", title: "Beta", sessionIds: ["session-b1"] }
    ],
    services: { sessions: { get: () => undefined } }
  });

  const response = await invoke(host, "/api/archive-manager/delete-workspace", { workspaceId: "workspace-a" });

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.workspaceId, "workspace-a");
  assert.equal(response.body.deleted, 2);
  assert.equal(response.body.total, 2);
  assert.deepEqual(response.body.failures, []);
  assert.deepEqual(host.globalState().archivedSessionIds, ["session-b1", "session-u1"]);
  assert.deepEqual(host.workspaceRecord("workspace-a").sessionIds, []);
  assert.deepEqual(host.workspaceRecord("workspace-b").sessionIds, ["session-b1"]);
});

test("delete-workspace with workspaceId null removes only ungrouped sessions", async () => {
  const host = makeHost({
    archived: ["session-a1", "session-u1", "session-u2"],
    includeRegistry: true,
    workspaces: [{ id: "workspace-a", title: "Alpha", sessionIds: ["session-a1"] }],
    services: { sessions: { get: () => undefined } }
  });

  const response = await invoke(host, "/api/archive-manager/delete-workspace", { workspaceId: null });

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.deleted, 2);
  assert.deepEqual(host.globalState().archivedSessionIds, ["session-a1"]);
  assert.deepEqual(host.workspaceRecord("workspace-a").sessionIds, ["session-a1"]);
});

test("delete-workspace rejects a missing or invalid workspaceId without deleting", async () => {
  const host = makeHost({
    archived: ["session-a1"],
    includeRegistry: true,
    workspaces: [{ id: "workspace-a", title: "Alpha", sessionIds: ["session-a1"] }],
    services: { sessions: { get: () => undefined } }
  });

  const missing = await invoke(host, "/api/archive-manager/delete-workspace", {});
  const invalid = await invoke(host, "/api/archive-manager/delete-workspace", { workspaceId: 42 });

  assert.equal(missing.body.ok, false);
  assert.equal(missing.body.code, "bad-request");
  assert.equal(invalid.body.ok, false);
  assert.equal(invalid.body.code, "bad-request");
  assert.deepEqual(host.globalState().archivedSessionIds, ["session-a1"]);
  assert.deepEqual(host.workspaceRecord("workspace-a").sessionIds, ["session-a1"]);
});

test("delete-workspace with an unknown workspace is an idempotent no-op", async () => {
  const host = makeHost({
    archived: ["session-a1"],
    includeRegistry: true,
    workspaces: [{ id: "workspace-a", title: "Alpha", sessionIds: ["session-a1"] }],
    services: { sessions: { get: () => undefined } }
  });

  const response = await invoke(host, "/api/archive-manager/delete-workspace", { workspaceId: "workspace-missing" });

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.deleted, 0);
  assert.equal(response.body.total, 0);
  assert.deepEqual(host.globalState().archivedSessionIds, ["session-a1"]);
});

test("delete-workspace reports 503 when destructive session checks are unavailable", async () => {
  const host = makeHost({
    archived: ["session-a1"],
    includeRegistry: true,
    workspaces: [{ id: "workspace-a", title: "Alpha", sessionIds: ["session-a1"] }]
  });

  const response = await invoke(host, "/api/archive-manager/delete-workspace", { workspaceId: "workspace-a" });

  assert.equal(response.status, 503);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.code, "sessions-unavailable");
  assert.equal(response.body.deleted, 0);
  assert.deepEqual(host.globalState().archivedSessionIds, ["session-a1"]);
});

test("delete-workspace counts cache residue separately from hard failures", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "archive-workspace-cache-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ids = ["session-a1", "session-a2"];
  const dirs = new Map();
  for (const id of ids) {
    const dir = join(root, id);
    mkdirSync(dir, { recursive: true });
    dirs.set(id, dir);
  }
  // 两个会话的缓存都无法删除：主流程全部成功，但 cacheFailures 应为 2。
  const host = makeHost({
    archived: ids,
    includeRegistry: true,
    workspaces: [{ id: "workspace-a", title: "Alpha", sessionIds: ids }],
    projectionCache: { table: {
      get: () => ({ identity: {}, rows: {} }),
      async delete() { return true; }
    } },
    services: {
      sessions: { get: () => undefined },
      sessionPersistence: {
        list: async () => ids.map((id) => ({ header: { id, cwd: root }, revision: "r1" })),
        locate: (header) => ({ path: join(dirs.get(header.id), "session.v4.jsonl.zstd") }),
        stat: async () => undefined
      }
    }
  });

  const response = await invoke(host, "/api/archive-manager/delete-workspace", { workspaceId: "workspace-a" });

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.deleted, 2);
  assert.equal(response.body.cacheFailures, 2);
  assert.deepEqual(response.body.failures, []);
  assert.deepEqual(host.globalState().archivedSessionIds, []);
});

// 与已安装的 DSH 真实存储栈联调（需要 DSH_TEST_INSTALL_ROOT）。
test("real DSH storageDomain drops a session_projcache record", {
  skip: !process.env.DSH_TEST_INSTALL_ROOT
}, async (t) => {
  const base = process.env.DSH_TEST_INSTALL_ROOT + "/node_modules/@deepseek-ai/";
  const { Context } = await import(base + "cordis/lib/index.js");
  const { defineDomain, domainTable } = await import(base + "dsh-storage-domain/lib/index.js");
  // zod 是普通依赖（不在 @deepseek-ai 作用域下），从安装根的 node_modules 解析。
  const zodRoot = process.env.DSH_TEST_INSTALL_ROOT.replace(/\/dsh$/, "");
  const { z } = await import(zodRoot + "/node_modules/zod/index.js");

  const root = mkdtempSync(join(tmpdir(), "archive-real-projcache-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  // 与会话投影缓存同形状的领域声明：验证「域 API 删除」这条通道本身。
  const spec = defineDomain({
    name: "session_projcache",
    version: 1,
    layout: "per-record",
    tables: {
      sessions: domainTable(z.object({ identity: z.unknown(), rows: z.unknown() }))
    }
  });

  // 直接挂载存储栈所需的三个插件，再打开该领域。
  // dsh-storage 走 default（Service 子类）；另两个只导出 apply/inject，没有 default，
  // 因此要挑出 { apply, inject } 形状的插件对象交给 plugin()。
  const ctx = new Context();
  t.after(() => ctx.root?.dispose?.());

  const storage = await import(base + "dsh-storage/lib/index.js");
  const storageJson = await import(base + "dsh-storage-json/lib/index.js");
  const storageDomain = await import(base + "dsh-storage-domain/lib/index.js");
  const asPlugin = (ns) => (ns.default ?? { apply: ns.apply, inject: ns.inject });

  ctx.plugin(storage.default ?? storage, {});
  ctx.plugin(asPlugin(storageJson), { root: join(root, "storages") });
  ctx.plugin(asPlugin(storageDomain), { backend: "json" });
  await new Promise((resolve) => setTimeout(resolve, 200));

  const domain = await ctx.storageDomain.open(spec);
  const table = domain.table("sessions");
  await table.put("session-1", { identity: { a: 1 }, rows: { title: "x" } });
  assert.notEqual(table.get("session-1"), undefined);

  const result = await purgeProjectionCache(
    { get: (name) => (name === "storageDomain" ? ctx.storageDomain : undefined) },
    "session-1"
  );

  assert.equal(result.ok, true, `真实域上删除应成功，实际: ${JSON.stringify(result)}`);
  assert.equal(table.get("session-1"), undefined, "删除后内存态必须同步失效");
  assert.equal(table.size, 0, "该会话的记录已从域表移除");
  await domain.close();
});

// 包名是安装、补丁层与客户端模块加载器共用的唯一标识；改名后必须同步
// package.json、cordis.patch.yml、index.js 的 name 与 client.js 的注册 id。
test("宿主 name 与 package.json 的 name 一致", () => {
  const { name: packageName } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(name, packageName);
});
