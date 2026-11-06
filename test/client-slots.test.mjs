/**
 * 客户端槽位注册测试：设置分区 + 官方 0.2.2 新增的分区图标槽。
 *
 * 只加载 bundle、喂一个最小的假 ctx，断言注册了哪些槽、id / order 是否与分区一致。
 */
import assert from "node:assert/strict";
import test from "node:test";

async function loadClientBundle() {
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
    return descriptor.factory((name) => {
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
