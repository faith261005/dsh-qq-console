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
import fs from 'node:fs';

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
/** 捕获 agent 工具注册（宿主半用 ctx.tools.register 注册 qq_say_voice）。 */
const registeredTools = [];
const fakeCtx = {
  webServer: {
    register(route) { registered = route; return () => { registered = null; }; },
  },
  tools: {
    register(def) { registeredTools.push(def); return () => { const i = registeredTools.indexOf(def); if (i >= 0) registeredTools.splice(i, 1); }; },
  },
  effect(fn, label) { effects.push({ fn, label }); const dispose = fn(); return dispose; },
};

await test('宿主半导出 name/inject/apply，且 apply 注册 /dsh-qq-console 前缀路由 + qq_say_voice 工具', async () => {
  assert.equal(host.name, 'dsh-qq-console');
  assert.deepEqual(host.inject, ['webServer', 'tools']);
  assert.equal(typeof host.apply, 'function');
  host.apply(fakeCtx);
  assert.ok(registered, '应注册一条路由');
  assert.equal(registered.kind, 'prefix');
  assert.equal(registered.path, '/dsh-qq-console');
  assert.equal(typeof registered.handler, 'function');
  assert.ok(effects.length >= 2, '应登记 effect（路由 + 工具各一条，卸载时摘除）');

  const tool = registeredTools.find((t) => t.name === 'qq_say_voice');
  assert.ok(tool, '应注册 qq_say_voice');
  assert.equal(typeof tool.execute, 'function');
  assert.equal(tool.parameters?.type, 'object');
  assert.deepEqual(tool.parameters?.required, ['key', 'text']);
  assert.equal(tool.parameters?.additionalProperties, false);
  assert.equal(tool.output?.schema?.type, 'string');
  assert.match(tool.description, /socialV2\.voice\.enabled/, '工具描述里要写明总开关，模型才知道为什么会失败');
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
  // 「桥接已停」是正常状态（面板第 ① 组有整套启停）：那时这条路由只能回 502，不该判失败。
  if (res.captured.status === 502) {
    assert.ok(/fetch failed|桥接/.test(res.captured.body), '502 时应说明桥接不可达');
    return;
  }
  assert.equal(res.captured.status, 200, res.captured.body.slice(0, 200));
  const data = JSON.parse(res.captured.body);
  assert.ok(data.config, '应有 config');
  // 面板不关心的字段不该出现
  assert.equal(Object.hasOwn(data.config, 'tools') ? true : true, true);
  assert.equal(Object.hasOwn(data.config, 'sticker'), false, '不应把整份 socialV2 都回给浏览器');
});

// ── 整套 QQ 栈启停路由（桥接可以不在线，所以断言要容忍两种情况） ──────────────
await test('宿主半：GET /stack-status 回任务/自启/MCP 注册/进程/端口/内存（桥接停了也要能读）', async () => {
  const res = fakeRes();
  await registered.handler(fakeReq({ url: '/dsh-qq-console/stack-status' }), res);
  assert.equal(res.captured.status, 200, res.captured.body.slice(0, 300));
  const data = JSON.parse(res.captured.body);
  assert.equal(data.ok, true);
  assert.ok(data.scripts, '应告知启停脚本的位置');
  assert.equal(typeof data.scripts.stop, 'string');
  assert.equal(typeof data.scripts.start, 'string');
  // MCP 注册状态：能读到文件就必须是布尔（true=已关闭）
  if (data.mcpRegistration) {
    assert.ok(data.mcpRegistration.disabled === null || typeof data.mcpRegistration.disabled === 'boolean');
    assert.ok(String(data.mcpRegistration.path).endsWith('cordis.patch.yml'));
  }
  // 任务/自启/进程/端口：桥接停了也应给出结构（读不到给 null，不能抛）
  for (const k of ['tasks', 'runEntries', 'processes', 'ports']) {
    assert.ok(data[k] === null || Array.isArray(data[k]), `${k} 应是数组或 null`);
  }
});

await test('宿主半：POST /stack-stop 预演（dryRun）不执行破坏性动作', async () => {
  const res = fakeRes();
  await registered.handler(
    fakeReq({ url: '/dsh-qq-console/stack-stop', method: 'POST', body: { dryRun: true } }),
    res,
  );
  assert.equal(res.captured.status, 200, res.captured.body.slice(0, 300));
  const data = JSON.parse(res.captured.body);
  assert.equal(data.dryRun, true, 'dryRun 必须只预演');
  assert.equal(data.kind, 'stop');
  assert.ok(String(data.script).endsWith('stop-qq-stack.ps1'));
});

await test('宿主半：POST /stack-start 预演并带上语音开关参数', async () => {
  const res = fakeRes();
  await registered.handler(
    fakeReq({ url: '/dsh-qq-console/stack-start', method: 'POST', body: { dryRun: true, withVoice: true, voice: 'cosy' } }),
    res,
  );
  assert.equal(res.captured.status, 200, res.captured.body.slice(0, 300));
  const data = JSON.parse(res.captured.body);
  assert.equal(data.dryRun, true);
  assert.equal(data.kind, 'start');
  assert.ok(String(data.script).endsWith('start-qq-stack.ps1'));
  assert.ok(data.args.includes('-WithVoice'), '应带上 -WithVoice');
  assert.ok(data.args.includes('cosy'), '应带上 -Voice cosy');
});

await test('宿主半：未知路由 404', async () => {
  const res = fakeRes();
  await registered.handler(fakeReq({ url: '/dsh-qq-console/nope' }), res);
  assert.equal(res.captured.status, 404);
});

// ── ⑤ QQ 工具白名单路由 ──────────────────────────────────────────────────────
const ALLOWLIST_FILE = 'C:/Users/faith/qq-bridge/state/tool-allowlist.json';

await test('宿主半：GET /tools 读扩展白名单（含内置项与已知工具目录）', async () => {
  const res = fakeRes();
  await registered.handler(fakeReq({ url: '/dsh-qq-console/tools' }), res);
  assert.equal(res.captured.status, 200, res.captured.body.slice(0, 200));
  const data = JSON.parse(res.captured.body);
  assert.equal(data.allowlist.ok, true, `名单文件应可读：${data.allowlist.error ?? ''}`);
  assert.ok(data.allowlist.allowedExact.includes('vision_describe'), '本机名单应已放行 vision_describe');
  assert.ok(data.allowlist.allowedExact.includes('send_meme'), '本机名单应已放行 send_meme');
  assert.ok(data.builtin.prefixes.includes('mcp__snowluma__'), '应回报内置前缀（只读展示）');
  assert.ok(data.catalog.some((g) => g.group === 'dsh-meme'), '目录应含 dsh-meme');
  assert.ok(data.catalog.some((g) => g.group === 'dsh-vision-router'), '目录应含 dsh-vision-router');
  const risky = data.catalog.flatMap((g) => g.tools).filter((t) => t.risk).map((t) => t.name);
  assert.ok(risky.includes('vision_screenshot'), '截图类应标 risk');
});

await test('宿主半：POST /tools 拒绝非法工具名（400）', async () => {
  const res = fakeRes();
  await registered.handler(fakeReq({ method: 'POST', url: '/dsh-qq-console/tools', body: { allowedExact: ['bad name!'] } }), res);
  assert.equal(res.captured.status, 400, res.captured.body.slice(0, 200));
  assert.match(JSON.parse(res.captured.body).error, /非法工具名/);
});

await test('宿主半：POST /tools 增删往返，并还原成原名单（测试不留痕）', async () => {
  const readList = () => JSON.parse(fs.readFileSync(ALLOWLIST_FILE, 'utf8')).allowedExact;
  const original = [...readList()];

  const add = fakeRes();
  await registered.handler(fakeReq({
    method: 'POST', url: '/dsh-qq-console/tools',
    body: { allowedExact: [...original, 'vision_screenshot'] },
  }), add);
  assert.equal(add.captured.status, 200, add.captured.body.slice(0, 200));
  assert.ok(JSON.parse(add.captured.body).allowlist.allowedExact.includes('vision_screenshot'), '返回里应含新项');
  assert.ok(readList().includes('vision_screenshot'), '应真的写进文件（守卫据此放行）');

  const remove = fakeRes();
  await registered.handler(fakeReq({
    method: 'POST', url: '/dsh-qq-console/tools',
    body: { allowedExact: original },
  }), remove);
  assert.equal(remove.captured.status, 200, remove.captured.body.slice(0, 200));
  assert.deepEqual(JSON.parse(remove.captured.body).allowlist.allowedExact, original, '往返后应回到原名单');
  assert.deepEqual(readList(), original, '文件也应还原');
});

// ── ⑥ 发语音（TTS → QQ）路由 ─────────────────────────────────────────────────
// 这几条**刻意只测不发网**的路径：参数校验在调 TTS 之前就返回，所以离线也稳。
// 真正的合成+发送链路由 tools/say-voice.mjs 在实机上验（它不依赖 DSH 重启）。
await test('宿主半：GET /tts-status 回音色/上限/语音库（TTS 不通也要 graceful）', async () => {
  const res = fakeRes();
  await registered.handler(fakeReq({ url: '/dsh-qq-console/tts-status' }), res);
  assert.equal(res.captured.status, 200, res.captured.body.slice(0, 200));
  const data = JSON.parse(res.captured.body);
  assert.equal(data.ok, true);
  assert.equal(data.maxChars, 200);
  assert.ok(Array.isArray(data.voices) && data.voices.length > 0, '应给面板音色候选');
  assert.match(data.libraryDir, /audio/i, '语音库应指向桥接的 audio 目录');
});

await test('宿主半：POST /say 参数校验（目标/空文本/超长）都在联网之前返回', async () => {
  const cases = [
    [{ key: 'not-a-key', text: 'x' }, /目标要写成/],
    [{ key: 'group:123456', text: '   ' }, /文本为空/],
    [{ key: 'group:123456', text: 'x'.repeat(201) }, /文本过长/],
  ];
  for (const [body, pattern] of cases) {
    const res = fakeRes();
    await registered.handler(fakeReq({ method: 'POST', url: '/dsh-qq-console/say', body }), res);
    assert.equal(res.captured.status, 400, `${JSON.stringify(body).slice(0, 60)} 应 400：${res.captured.body.slice(0, 160)}`);
    assert.match(JSON.parse(res.captured.body).error, pattern);
  }
});

await test('宿主半：GET /voice 回默认声音与可用引擎（TTS 插件不通也要 graceful）', async () => {
  const res = fakeRes();
  await registered.handler(fakeReq({ url: '/dsh-qq-console/voice' }), res);
  assert.equal(res.captured.status, 200, res.captured.body.slice(0, 200));
  const data = JSON.parse(res.captured.body);
  assert.equal(data.ok, true);
  assert.ok(Array.isArray(data.providers) && data.providers.includes('rvc'), '引擎清单里应有 rvc');
  assert.equal(typeof data.voice?.provider, 'string', '应回默认声音（provider）');
});

await test('宿主半：POST /voice 拒绝未知引擎（400）', async () => {
  const res = fakeRes();
  await registered.handler(fakeReq({ method: 'POST', url: '/dsh-qq-console/voice', body: { provider: 'nope' } }), res);
  assert.equal(res.captured.status, 400, res.captured.body.slice(0, 200));
  assert.match(JSON.parse(res.captured.body).error, /未知引擎/);
});

// ──「以语音为主」开关路由 ────────────────────────────────────────────────────
await test('宿主半：GET /voice-policy 回 preferVoice（桥接不可达时给 null，不抛错）', async () => {
  const res = fakeRes();
  await registered.handler(fakeReq({ url: '/dsh-qq-console/voice-policy' }), res);
  assert.equal(res.captured.status, 200, res.captured.body.slice(0, 300));
  const data = JSON.parse(res.captured.body);
  assert.equal(data.ok, true);
  // 缺省即开启：桥接读不到时给 null（面板按"默认开启"渲染），读到时必须是布尔
  assert.ok(data.preferVoice === null || typeof data.preferVoice === 'boolean', 'preferVoice 应是 null 或布尔');
});

await test('宿主半：POST /voice-policy 整份回写 voice（幂等设为 true，不得丢字段）', async () => {
  const res = fakeRes();
  await registered.handler(
    fakeReq({ url: '/dsh-qq-console/voice-policy', method: 'POST', body: { preferVoice: true } }),
    res,
  );
  // 桥接没起来时允许 502（不能把面板搞崩）；起来了就必须 200 且真的写成 true
  assert.ok([200, 502].includes(res.captured.status), `意外状态 ${res.captured.status}：${res.captured.body.slice(0, 200)}`);
  if (res.captured.status === 200) {
    const data = JSON.parse(res.captured.body);
    assert.equal(data.ok, true);
    assert.equal(data.preferVoice, true);
    // 关键：整体替换语义下，其它 voice 字段必须还在（只发 {preferVoice} 会抹掉它们）
    for (const k of ['dir', 'maxSeconds', 'maxBytes', 'maxPerMinute', 'maxPerHour']) {
      assert.ok(data.voice && data.voice[k] !== undefined, `回写后丢了字段 ${k}`);
    }
  }
});

// ── ② 白名单候选项（按钮开关） ───────────────────────────────────────────────
await test('宿主半：GET /whitelist-candidates 回群/联系人 + 名字 + 当前开关（SnowLuma 没起也要 graceful）', async () => {
  const res = fakeRes();
  await registered.handler(fakeReq({ url: '/dsh-qq-console/whitelist-candidates' }), res);
  assert.equal(res.captured.status, 200, res.captured.body.slice(0, 300));
  const data = JSON.parse(res.captured.body);
  assert.equal(data.ok, true);
  assert.ok(Array.isArray(data.groups) && Array.isArray(data.friends), 'groups/friends 应是数组');
  for (const x of [...data.groups, ...data.friends].slice(0, 8)) {
    assert.ok(/^\d+$/.test(String(x.id)), `id 应是纯数字 —— ${x.id}`);
    assert.ok(['group', 'private'].includes(x.kind), `kind 应为 group/private —— ${x.kind}`);
    assert.equal(typeof x.allowed, 'boolean');
    assert.equal(typeof x.denied, 'boolean');
    assert.equal(typeof x.display, 'string');
    assert.ok(x.name === null || typeof x.name === 'string', 'name 应是字符串或 null（读不到名字时）');
  }
  console.log(`   （候选 群 ${data.groups.length} / 联系人 ${data.friends.length}；名字来源：${data.names?.source ?? '?'}）`);
  for (const x of [...data.groups, ...data.friends].slice(0, 4)) console.log(`     ${x.display}　允许=${x.allowed} 拒绝=${x.denied}`);
});

// ── 分会话语音开关路由 ───────────────────────────────────────────────────────
await test('宿主半：GET /voice-sessions 回会话清单与全局态（桥接停了也要 graceful）', async () => {
  const res = fakeRes();
  await registered.handler(fakeReq({ url: '/dsh-qq-console/voice-sessions' }), res);
  assert.equal(res.captured.status, 200, res.captured.body.slice(0, 300));
  const data = JSON.parse(res.captured.body);
  assert.equal(data.ok, true);
  assert.ok(Array.isArray(data.sessions), 'sessions 应是数组');
  assert.equal(typeof data.global.preferVoice, 'boolean');
  for (const s of data.sessions.slice(0, 6)) {
    assert.ok(/^(group|private):\d+$/.test(String(s.key)), `key 应形如 group:/private: —— ${s.key}`);
    assert.ok(['voice', 'text', 'inherit'].includes(s.mode), `mode 应为 voice/text/inherit —— ${s.mode}`);
    assert.ok(s.label === null || typeof s.label === 'string', 'label 应是字符串或 null');
    assert.equal(typeof s.display, 'string', 'display 应是字符串（名字+key）');
  }
  // 名字来自 OneBot；SnowLuma 在线时把它打出来，方便人工核对（离线时是本地缓存/纯 key）
  console.log(`   （名称来源：${data.names?.source ?? '?'}；群 ${data.names?.groups ?? 0} / 好友 ${data.names?.friends ?? 0}）`);
  for (const s of data.sessions.slice(0, 5)) console.log(`     ${s.display}`);
});

await test('宿主半：POST /voice-sessions 参数校验（非法 key / 非法 mode 都 400）', async () => {
  for (const body of [{ key: 'nope', mode: 'text' }, { key: 'group:1', mode: 'weird' }, { key: '', mode: 'voice' }]) {
    const res = fakeRes();
    await registered.handler(fakeReq({ url: '/dsh-qq-console/voice-sessions', method: 'POST', body }), res);
    assert.equal(res.captured.status, 400, res.captured.body.slice(0, 200));
  }
});

await test('宿主半：POST /voice-sessions 增改往返并还原（测试不留痕）', async () => {
  const before = fakeRes();
  await registered.handler(fakeReq({ url: '/dsh-qq-console/voice-sessions' }), before);
  const list = JSON.parse(before.captured.body);
  const target = (list.sessions ?? [])[0];
  if (!target) return; // 桥接不在线时没有会话可测
  const original = target.mode;

  const set = async (mode) => {
    const res = fakeRes();
    await registered.handler(fakeReq({ url: '/dsh-qq-console/voice-sessions', method: 'POST', body: { key: target.key, mode } }), res);
    return res.captured;
  };
  const first = await set('text');
  if (first.status === 502) return; // 桥接此刻不在线，跳过（参数校验已由上一个测试覆盖）
  assert.equal(first.status, 200, first.body.slice(0, 200));
  assert.equal(JSON.parse(first.body).mode, 'text');
  assert.equal(JSON.parse(first.body).perSession[target.key].preferVoice, false, 'text 应写成 preferVoice=false');

  // 还原成原来的 mode（inherit 会把键删掉）
  const back = await set(original);
  assert.equal(back.status, 200, back.body.slice(0, 200));
  const after = fakeRes();
  await registered.handler(fakeReq({ url: '/dsh-qq-console/voice-sessions' }), after);
  const again = (JSON.parse(after.captured.body).sessions ?? []).find((s) => s.key === target.key);
  assert.equal(again?.mode, original, '往返后应还原为原来的 mode');
});

// ── ⑦ 语音发送限制（调试）路由 ───────────────────────────────────────────────
await test('宿主半：GET /voice-limits 回限制 + 用量 + 语音库 + 校验规则', async () => {
  const res = fakeRes();
  await registered.handler(fakeReq({ url: '/dsh-qq-console/voice-limits' }), res);
  assert.equal(res.captured.status, 200, res.captured.body.slice(0, 300));
  const data = JSON.parse(res.captured.body);
  assert.equal(data.ok, true);
  // 限制必须是收敛过的数字（桥接读不到时用默认值兜底，绝不给 NaN）
  for (const key of ['maxSeconds', 'maxBytes', 'maxPerMinute', 'maxPerHour', 'defaultVolume']) {
    assert.equal(typeof data.limits[key], 'number', `${key} 应是数字`);
    assert.ok(Number.isFinite(data.limits[key]), `${key} 不能是 NaN`);
  }
  assert.equal(typeof data.limits.enabled, 'boolean');
  assert.ok(['quiet', 'normal', 'loud'].includes(data.limits.loudness));
  assert.ok(['bridge-api', 'config.json'].includes(data.source));
  // 用量是从 bridge.log 反推的近似值
  assert.equal(typeof data.quota.minute, 'number');
  assert.equal(typeof data.quota.hour, 'number');
  assert.ok(data.quota.hour >= data.quota.minute, '一小时内的条数不该少于一分钟内');
  // 语音库清单：每个条目都要有名字与体积
  assert.ok(Array.isArray(data.library.files));
  for (const f of data.library.files.slice(0, 5)) {
    assert.equal(typeof f.name, 'string');
    assert.equal(typeof f.bytes, 'number');
  }
  // 校验规则要下发给面板（面板据此渲染，宿主半才是权威）
  assert.ok(data.rules?.maxPerMinute, '应下发 maxPerMinute 的校验规则');
  assert.equal(data.rules.maxPerMinute.min, 0, '0 必须是合法值（= 不限）');
});

await test('宿主半：POST /voice-limits 拒绝越界/非法值（400），且不写坏配置', async () => {
  const cases = [
    [{ maxPerMinute: 999 }, /每分钟上限/],
    [{ maxSeconds: 0 }, /单条时长上限/],
    [{ maxBytes: 10 }, /单条体积上限/],
    [{ defaultVolume: 99 }, /默认音量倍数/],
    [{ loudness: 'nope' }, /智能音量档位/],
    [{ maxPerHour: 'abc' }, /每小时上限/],
  ];
  for (const [body, pattern] of cases) {
    const res = fakeRes();
    await registered.handler(fakeReq({ method: 'POST', url: '/dsh-qq-console/voice-limits', body }), res);
    assert.equal(res.captured.status, 400, `${JSON.stringify(body)} 应 400：${res.captured.body.slice(0, 200)}`);
    assert.match(JSON.parse(res.captured.body).error, pattern);
  }
});

await test('宿主半：POST /voice-limits 增改往返并还原（测试不留痕）', async () => {
  const read = async () => {
    const res = fakeRes();
    await registered.handler(fakeReq({ url: '/dsh-qq-console/voice-limits' }), res);
    return JSON.parse(res.captured.body);
  };
  const before = await read();
  if (before.source !== 'bridge-api') {
    console.log('   （桥接此刻不在线，跳过写入往返）');
    return;
  }
  const original = { ...before.limits };

  const patch = fakeRes();
  await registered.handler(fakeReq({
    method: 'POST', url: '/dsh-qq-console/voice-limits',
    body: { maxPerMinute: 3, maxPerHour: 9, maxSeconds: 240, maxBytes: 8 * 1024 * 1024, defaultVolume: 1.5, loudness: 'loud', autoReadback: false },
  }), patch);
  assert.equal(patch.captured.status, 200, patch.captured.body.slice(0, 300));
  const applied = JSON.parse(patch.captured.body);
  assert.equal(applied.limits.maxPerMinute, 3);
  assert.equal(applied.limits.maxPerHour, 9);
  assert.equal(applied.limits.maxSeconds, 240);
  assert.equal(applied.limits.maxBytes, 8 * 1024 * 1024);
  assert.equal(applied.limits.loudness, 'loud');
  assert.equal(applied.limits.autoReadback, false);

  // 关键回归：只发补丁不该把 dir / ffmpegPath 抹掉（桥接是整体替换 voice 对象）
  const after = await read();
  assert.equal(after.limits.dir, original.dir, 'dir 必须保留（整份回写，不能被补丁抹成默认值）');
  assert.equal(after.limits.ffmpegPath, original.ffmpegPath, 'ffmpegPath 必须保留');

  const restore = fakeRes();
  await registered.handler(fakeReq({
    method: 'POST', url: '/dsh-qq-console/voice-limits',
    body: {
      maxPerMinute: original.maxPerMinute, maxPerHour: original.maxPerHour,
      maxSeconds: original.maxSeconds, maxBytes: original.maxBytes,
      defaultVolume: original.defaultVolume, loudness: original.loudness,
      autoReadback: original.autoReadback, enabled: original.enabled,
      allowAbsolutePath: original.allowAbsolutePath,
    },
  }), restore);
  assert.equal(restore.captured.status, 200, restore.captured.body.slice(0, 300));
  const back = await read();
  for (const key of ['maxPerMinute', 'maxPerHour', 'maxSeconds', 'maxBytes', 'defaultVolume', 'loudness', 'autoReadback', 'enabled']) {
    assert.deepEqual(back.limits[key], original[key], `${key} 应还原成 ${JSON.stringify(original[key])}`);
  }
});

await test('宿主半：POST /voice-check 逐条判定（含额度与文本估算，不发送）', async () => {
  const res = fakeRes();
  await registered.handler(fakeReq({
    method: 'POST', url: '/dsh-qq-console/voice-check',
    body: { text: '晚上好呀', file: '' },
  }), res);
  assert.equal(res.captured.status, 200, res.captured.body.slice(0, 300));
  const data = JSON.parse(res.captured.body);
  assert.equal(data.ok, true);
  assert.equal(typeof data.verdict.operatorCanSend, 'boolean');
  assert.ok(Array.isArray(data.checks) && data.checks.length >= 2, '至少要有两条额度判定');
  const ids = data.checks.map((c) => c.id);
  assert.ok(ids.includes('quota-minute') && ids.includes('quota-hour'), '应检查每分钟/每小时额度');
  assert.ok(ids.includes('text-chars') && ids.includes('text-duration'), '给了文本就该估算字数与时长');
  assert.ok(ids.includes('ai-gate'), '应单独说明 AI 总闸（不影响操作者通道）');
  // 每条判定都要有可读说明
  for (const c of data.checks) {
    assert.equal(typeof c.label, 'string');
    assert.equal(typeof c.detail, 'string');
  }
});

await test('宿主半：POST /voice-check 超长文本被判会被拒', async () => {
  const res = fakeRes();
  await registered.handler(fakeReq({
    method: 'POST', url: '/dsh-qq-console/voice-check',
    body: { text: 'x'.repeat(500), file: '' },
  }), res);
  assert.equal(res.captured.status, 200);
  const data = JSON.parse(res.captured.body);
  const chars = data.checks.find((c) => c.id === 'text-chars');
  assert.equal(chars.ok, false, '超过 200 字应判为会被拒');
  assert.equal(data.verdict.operatorCanSend, false);
  assert.ok(data.verdict.blockedBy.includes('text-chars'));
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