/**
 * 客户端槽位注册测试：设置分区 + 官方 0.2.2 新增的分区图标槽。
 *
 * 只加载 bundle、喂一个最小的假 ctx，断言注册了哪些槽、id / order 是否与分区一致。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// bundle 只在首次 import 时向 window.__ModuleLoader__ 注册工厂。
// 多个测试共享它：并发地反复设置 globalThis.window 会让后到的 import 什么都不注册，
// 因此这里缓存工厂，并把测试改为串行（见文件末尾的 { concurrency: 1 } 说明）。
let cachedFactory;
async function loadClientBundle() {
  if (cachedFactory !== undefined) return cachedFactory;
  const previousWindow = globalThis.window;
  let descriptor;
  globalThis.window = {
    __ModuleLoader__: {
      load(next) {
        descriptor = next;
      }
    }
  };
  try {
    const url = new URL("../client.js", import.meta.url);
    url.searchParams.set("test", String(Date.now()));
    await import(url.href);
    assert.ok(descriptor, "client bundle should register with ModuleLoader");
    // 客户端模块加载器按包名查找工厂：注册 id 与 package.json 的 name
    // 不一致时页面会报 "loaded without registering"，插件同步失败。
    const { name: packageName } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    assert.equal(descriptor.id, packageName, "客户端注册 id 必须等于 package.json 的 name");
    cachedFactory = descriptor.factory((name) => {
      if (name === "react") {
        return {
          createElement: (type, props, ...children) => ({ type, props, children }),
          Fragment: "Fragment",
          useState: (value) => [value, () => {}],
          useEffect: () => {},
          useMemo: (factory) => factory(),
          useRef: (value) => ({ current: value }),
          useCallback: (fn) => fn
        };
      }
      if (name === "@deepseek-ai/dsh-client-ui-primitives") {
        return new Proxy({}, { get: () => (props) => ({ type: "primitive", props }) });
      }
      throw new Error(`unexpected client dependency: ${name}`);
    });
    return cachedFactory;
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
}

test("客户端注册 settings.section 与官方 settings.section.icon 两个槽位", async () => {
  const client = await loadClientBundle();
  const registrations = [];
  const injectedSlots = [];
  client.apply({
    // 宿主与浏览器半区走 Cordis 的 ctx.get(name)；这里只喂 locale，其余返回 undefined。
    get(name) {
      if (name === "locale") {
        return {
          register() {},
          bind() {
            return (key) => key;
          }
        };
      }
      return undefined;
    },
    effect(callback) {
      const cleanup = callback();
      if (typeof cleanup === "function") cleanup();
    },
    locale: {
      register() {},
      bind() {
        return (key) => key;
      }
    },
    slots: {
      inject(name, callback) {
        injectedSlots.push(name);
        return callback();
      },
      register(spec) {
        registrations.push(spec);
        return () => {};
      }
    }
  });

  assert.ok(injectedSlots.includes("settings.section"));
  const section = registrations.find((registration) => registration.name === "settings.section");
  assert.equal(section?.id, "archives");
  assert.equal(section?.order, 40);
  assert.equal(section?.icon.props["data-dsh-archive-injected"], "1");

  // 官方 0.2.2 起的分区图标槽：注册 id 必须等于分区 id，壳层才渲染本插件的图标。
  assert.ok(injectedSlots.includes("settings.section.icon"), "应注入官方分区图标槽");
  const icon = registrations.find((registration) => registration.name === "settings.section.icon");
  assert.ok(icon, "应注册分区图标");
  assert.equal(icon.id, "archives");
  assert.equal(icon.order, 40);
});

// ---- 浏览器端分会话 localStorage 清理 ----
// 删除会话后 DSH 不会自己清掉这些键，插件在浏览器侧补做（best-effort）。

/** 用一个内存 Map 模拟 localStorage，记录所有读删操作。 */
function makeFakeStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  const ops = [];
  return {
    map,
    ops,
    getItem(key) { ops.push(["get", key]); return map.has(key) ? map.get(key) : null; },
    removeItem(key) { ops.push(["remove", key]); map.delete(key); },
    setItem(key, value) { map.set(key, String(value)); }
  };
}

async function withFakeLocalStorage(seed, run) {
  const storage = makeFakeStorage(seed);
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true, writable: true });
  try {
    return await run(storage);
  } finally {
    if (previous === undefined) delete globalThis.localStorage;
    else Object.defineProperty(globalThis, "localStorage", previous);
  }
}

test("purgeSessionLocalStorage removes every per-session key of the deleted session", async () => {
  const client = await loadClientBundle();
  const sid = "session-11111111-2222-3333-4444-555555555555";
  const other = "session-99999999-8888-7777-6666-555555555555";
  const seed = {};
  for (const prefix of client.SESSION_LS_PREFIXES) {
    seed[prefix + sid] = "value-for-deleted";
    seed[prefix + other] = "value-for-survivor";
  }
  seed["dsh.workspace.view.v5"] = "unrelated";

  await withFakeLocalStorage(seed, ({ map }) => {
    const removed = client.purgeSessionLocalStorage(sid);

    assert.equal(removed, client.SESSION_LS_PREFIXES.length, "每个已存在的分会话键都应被移除");
    for (const prefix of client.SESSION_LS_PREFIXES) {
      assert.equal(map.has(prefix + sid), false, `应移除 ${prefix}<id>`);
      assert.equal(map.get(prefix + other), "value-for-survivor", "不得误删其他会话的键");
    }
    assert.equal(map.get("dsh.workspace.view.v5"), "unrelated", "不得触碰非会话键");
  });
});

test("purgeSessionLocalStorage clears the current-session pointer only when it names the deleted session", async () => {
  const client = await loadClientBundle();
  const sid = "session-aaaa1111-2222-3333-4444-555555555555";
  const pointerKey = client.CURRENT_SESSION_KEY;

  // 指针指向被删会话 → 整键移除，避免 DSH 下次启动去打开一个不存在的会话。
  await withFakeLocalStorage({ [pointerKey]: JSON.stringify({ sessionId: sid }) }, ({ map }) => {
    client.purgeSessionLocalStorage(sid);
    assert.equal(map.has(pointerKey), false);
  });

  // 指针指向别的会话 → 必须保留。
  const other = "session-bbbb1111-2222-3333-4444-555555555555";
  await withFakeLocalStorage({ [pointerKey]: JSON.stringify({ sessionId: other }) }, ({ map }) => {
    client.purgeSessionLocalStorage(sid);
    assert.equal(map.get(pointerKey), JSON.stringify({ sessionId: other }), "不得清除指向其他会话的指针");
  });
});

test("purgeSessionLocalStorage degrades silently when localStorage is unavailable", async () => {
  const client = await loadClientBundle();
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  // 隐私模式下访问 localStorage 本身就会抛。
  Object.defineProperty(globalThis, "localStorage", {
    get() { throw new Error("access denied"); },
    configurable: true
  });
  try {
    assert.doesNotThrow(() => client.purgeSessionLocalStorage("session-x"));
    assert.equal(client.purgeSessionLocalStorage("session-x"), 0);
  } finally {
    if (previous === undefined) delete globalThis.localStorage;
    else Object.defineProperty(globalThis, "localStorage", previous);
  }
});

test("purgeSessionLocalStorage ignores a missing or malformed session id", async () => {
  const client = await loadClientBundle();
  await withFakeLocalStorage({}, () => {
    assert.equal(client.purgeSessionLocalStorage(undefined), 0);
    assert.equal(client.purgeSessionLocalStorage(""), 0);
    assert.equal(client.purgeSessionLocalStorage(null), 0);
  });
});

// ---- 会话名称悬停提示 ----
// 气泡固定定位，必须夹在视口内：留 8px 边距，鼠标偏移 14px / 16px。

test("titleTooltipPosition 按鼠标位置偏移并夹在视口内", async () => {
  const client = await loadClientBundle();
  const position = client.titleTooltipPosition;

  // 鼠标居中：无夹取，坐标 = 鼠标 + 偏移。
  assert.deepEqual(position(400, 300, 100, 40, 1000, 800), { left: 414, top: 316 });

  // 右下角：夹取到 视口 - 气泡尺寸 - 8。
  assert.deepEqual(position(990, 790, 100, 40, 1000, 800), { left: 892, top: 752 });

  // 负坐标：夹取到 8px 安全边距。
  assert.deepEqual(position(-10, -10, 100, 40, 1000, 800), { left: 8, top: 8 });

  // 视口比气泡还小：仍回落到 8px 边距，不出现负坐标。
  assert.deepEqual(position(50, 20, 200, 100, 100, 50), { left: 8, top: 8 });

  // 首次显示时气泡尺寸未知（0）：右侧仍按视口宽度做保守夹取。
  assert.deepEqual(position(990, 300, 0, 0, 1000, 800), { left: 992, top: 316 });
});
