import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { apply, deleteSession, inject } from "../index.js";

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
        locate: () => ({ kind: "jsonl", path: artifact })
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

test("delete-all reports 503 when destructive session checks are unavailable", async () => {
  const host = makeHost({ archived: ["session-1", "session-2"], includeRegistry: true });
  const response = await invoke(host, "/api/archive-manager/delete-all", {});

  assert.equal(response.status, 503);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.code, "sessions-unavailable");
  assert.equal(response.body.deleted, 0);
  assert.deepEqual(host.globalState().archivedSessionIds, ["session-1", "session-2"]);
});
