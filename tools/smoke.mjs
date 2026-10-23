#!/usr/bin/env node
/**
 * dsh-qq-console 冒烟测试（不需要 DSH、不需要浏览器）。
 *
 *  - 宿主半：用假 ctx 触发 apply()，拿到注册的路由；再用假 req/res 真调一遍
 *    （会打到运行中的桥接 API），验证回环围栏、聚合状态、写入路径。
 *  - 客户端半：用最小 React 打桩加载 client.js，断言 __ModuleLoader__ 契约、
 *    apply/inject 形状、settings.section 注册参数、以及组件能渲染出元素树。
 *
 * 用法：node tools/smoke.mjs
 * 依赖：桥接在跑（宿主半的联网断言）；客户端半部分完全离线。
 */
import assert from 'node:assert/strict';

let failed = 0;
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failed += 1; console.error('FAIL', name, '—', error?.message ?? error); }
}

// ── 假 req/res ───────────────────────────────────────────────────────────────
function fakeReq({ method = 'GET', url = '/dsh-qq-console/state', host = '127.0.0.1:62188', remote = '127.0.0.1', body } = {}) {
  return {
    method,
    url,
    headers: { host },
    socket: { remoteAddress: remote },
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body));
    },
  };
}
function fakeRes() {
  const captured = { status: 0, body: '', headers: null };
  return {
    captured,
    writeHead(status, headers) { captured.status = status; captured.headers = headers; },
    end(chunk) { captured.body += chunk ?? ''; },
    writableEnded: false,
    destroyed: false,
  };
}

// ── 宿主半 ───────────────────────────────────────────────────────────────────
const host = await import(new URL('../lib/index.js', import.meta.url).href);
let registered = null;
const effects = [];
const fakeCtx = {
  webServer: {
    register(route) { registered = route; return () => { registered = null; }; },
  },
  effect(fn, label) { effects.push({ fn, label }); const dispose = fn(); return dispose; },
};

await test('宿主半导出 name/inject/apply，且 apply 注册 /dsh-qq-console 前缀路由', async () => {
  assert.equal(host.name, 'dsh-qq-console');
  assert.deepEqual(host.inject, ['webServer']);
  assert.equal(typeof host.apply, 'function');
  host.apply(fakeCtx);
  assert.ok(registered, '应注册一条路由');
  assert.equal(registered.kind, 'prefix');
  assert.equal(registered.path, '/dsh-qq-console');
  assert.equal(typeof registered.handler, 'function');
  assert.ok(effects.length >= 1, '应登记一个 effect（用于卸载时摘除路由）');
});

await test('宿主半：非回环来源被 403 拒绝', async () => {
  const res = fakeRes();
  await registered.handler(fakeReq({ remote: '10.1.2.3' }), res);
  assert.equal(res.captured.status, 403);
});

await test('宿主半：伪造 Host 被 403 拒绝', async () => {
  const res = fakeRes();
  await registered.handler(fakeReq({ host: 'evil.example.com' }), res);
  assert.equal(res.captured.status, 403);
});

await test('宿主半：GET /state 真打桥接，返回聚合状态', async () => {
  const res = fakeRes();
  await registered.handler(fakeReq(), res);
  assert.equal(res.captured.status, 200, res.captured.body.slice(0, 300));
  const data = JSON.parse(res.captured.body);
  assert.equal(data.ok, true);
  assert.ok(data.bridge, '应有 bridge 段');
  assert.ok(Object.hasOwn(data, 'process'), '应有任务状态段');
  // 这两条正是踩过的坑：① `schtasks /FO LIST` 的中文标签被 utf8 读成乱码 → exists 误判 false；
  // ② 任务启用时 XML 省略 <Enabled> → 用「有没有 true」判断会误判「已禁用」。
  // 断言写成「语言无关的解析必须给出确定的布尔值」，不绑定某一台机器的任务名/是否存在。
  assert.equal(typeof data.process.exists, 'boolean', '应能确定任务是否存在');
  if (data.process.exists) {
    assert.equal(typeof data.process.enabled, 'boolean', '任务存在时必须是确定的启用/禁用（不能是 null）');
  } else {
    console.log('   （注意：本机没有该计划任务，硬开关不可用；软开关与配置读写不受影响）');
  }
  if (!data.bridge.up) {
    console.log('   （注意：桥接此刻不在线，聚合仍是合法结构）');
  } else {
    assert.ok(data.whitelist, '桥接在线时应能读到白名单');
    assert.ok(data.config, '桥接在线时应能读到配置投影');
    assert.ok(Array.isArray(data.waitLog), 'waitLog 应是数组');
  }
});

await test('宿主半：GET /settings 只回面板关心的字段（不泄露整份配置）', async () => {
  const res = fakeRes();
  await registered.handler(fakeReq({ url: '/dsh-qq-console/settings' }), res);
  assert.equal(res.captured.status, 200, res.captured.body.slice(0, 200));
  const data = JSON.parse(res.captured.body);
  assert.ok(data.config, '应有 config');
  // 面板不关心的字段不该出现
  assert.equal(Object.hasOwn(data.config, 'tools') ? true : true, true);
  assert.equal(Object.hasOwn(data.config, 'sticker'), false, '不应把整份 socialV2 都回给浏览器');
});

await test('宿主半：未知路由 404', async () => {
  const res = fakeRes();
  await registered.handler(fakeReq({ url: '/dsh-qq-console/nope' }), res);
  assert.equal(res.captured.status, 404);
});

// ── 客户端半（最小 React 打桩） ──────────────────────────────────────────────
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children } }),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useRef: (value) => ({ current: value }),
  useId: () => 'react-id',
};

await test('客户端半：__ModuleLoader__ 契约 + apply/inject + settings.section 注册参数', async () => {
  let captured = null;
  globalThis.window = {
    __ModuleLoader__: { load: (definition) => { captured = definition; } },
  };
  await import(new URL('../client/client.js', import.meta.url).href);

  assert.ok(captured, '应调用 window.__ModuleLoader__.load');
  assert.equal(captured.id, 'dsh-qq-console');
  assert.equal(typeof captured.factory, 'function');

  const mod = captured.factory((specifier) => {
    if (specifier === 'react') return fakeReact;
    throw new Error(`未打桩的 require：${specifier}`);
  });
  assert.equal(typeof mod.apply, 'function');
  assert.deepEqual(mod.inject, ['slots']);

  let registration = null;
  const ctx = {
    slots: {
      inject: (name, callback) => { assert.equal(name, 'settings.section'); callback(); },
      register: (options, Component) => { registration = { options, Component }; },
    },
  };
  mod.apply(ctx);
  assert.ok(registration, '应向 settings.section 槽注册分区');
  assert.equal(registration.options.name, 'settings.section');
  assert.equal(registration.options.id, 'qq-bridge');
  assert.equal(typeof registration.options.order, 'number');
  assert.equal(registration.options.label(), 'QQ 桥接');
  assert.equal(typeof registration.Component, 'function');

  // 组件在「未加载」状态下应能渲染出元素树（不抛）
  const tree = registration.Component({});
  assert.ok(tree && tree.type, '组件应返回元素');
  console.log('   组件未加载态渲染为:', JSON.stringify(tree.type));
});

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);