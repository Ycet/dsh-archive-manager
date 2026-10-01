import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { apply, deleteSession, inject, readArchivedReport } from "../index.js";

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

function makeHost({ archived = ["session-1"], includeRegistry = false, services = {}, workspacePath = "/tmp/project" } = {}) {
  let globalState = { archivedSessionIds: archived.slice() };
  const workspaceRecords = new Map([
    ["workspace-1", { title: "Workspace", path: workspacePath, sessionIds: archived.slice() }]
  ]);
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
    storageDomain: { get: (name) => name === "workspace" ? domain : undefined },
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
    workspaceRecord: () => structuredClone(workspaceRecords.get("workspace-1"))
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
