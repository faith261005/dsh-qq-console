/**
 * dsh-qq-console — 宿主半。
 *
 * 职责：把 qq-bridge 自带的本地控制台 API 包一层，供 DSH 设置页里的「QQ 桥接」面板使用；
 * 另外补上桥接 API 管不到的一件事——**进程级开关**（走 Windows 任务计划）。
 *
 * 设计要点（都来自实测，详见同目录 DESIGN.md / README.md）：
 *   · 桥接的写接口自己会做字段归一化 + 原子落盘 + 热更新，所以这里只做**转发**，
 *     不直接改 config.json（否则会和桥接的内存态打架）。
 *   · 桥接控制台令牌从 <bridge>/state/console-token 现读，不缓存、不下发到浏览器。
 *   · 任务带「每 1 分钟保活」触发器 ⇒ 只杀进程会被拉回来，必须先 /Change /DISABLE。
 *   · 本进程只服务 DSH 自己的 Web GUI，路由做**回环围栏**（loopback + Host 校验），
 *     与 DSH 平台一致（webserver 本身不提供全局鉴权，路由主人自负）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const name = 'dsh-qq-console';
/** 需要宿主提供 webServer 服务（dsh-host-webserver）才激活。 */
export const inject = ['webServer'];

/** 桥接安装目录（本机固定路径；将来若换位置，改这一处）。 */
const BRIDGE_DIR = process.env.DSH_QQ_BRIDGE_DIR || 'C:\\Users\\faith\\qq-bridge';
const BRIDGE_BASE = process.env.DSH_QQ_BRIDGE_API || 'http://127.0.0.1:3100';
const ROUTE_PREFIX = '/dsh-qq-console';
/** 桥接的保活计划任务名（改这里就能换成别的部署方式）。 */
const BRIDGE_TASK = process.env.DSH_QQ_BRIDGE_TASK || 'DSH-qq-bridge';
const SNOWLUMA_TASK = process.env.DSH_QQ_SNOWLUMA_TASK || 'SnowLuma-QQ';
/** 单次调用桥接 API 的超时。 */
const API_TIMEOUT_MS = 8000;

function log(...args) {
  // DSH 宿主会把插件日志写进自己的日志通道；这里只保证不抛。
  try { console.log(`[dsh-qq-console]`, ...args); } catch {}
}

/** 现读桥接控制台令牌（每次请求都读：控制台换令牌后无需重启插件）。 */
function readBridgeToken() {
  const file = path.join(BRIDGE_DIR, 'state', 'console-token');
  const token = fs.readFileSync(file, 'utf8').trim();
  if (!token) throw new Error(`控制台令牌为空：${file}`);
  return token;
}

/** 调用桥接控制台 API。返回 { ok, status, data } —— 不抛（调用方拿到错误自行决定怎么回）。 */
async function callBridge(pathname, { method = 'GET', body } = {}) {
  const target = `${BRIDGE_BASE}${pathname}`;
  try {
    const res = await fetch(target, {
      method,
      headers: {
        'x-console-token': readBridgeToken(),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 2000) }; }
    return { ok: res.ok, status: res.status, data };
  } catch (error) {
    return { ok: false, status: 0, data: { error: String(error?.message ?? error) } };
  }
}

/**
 * 回环围栏：只允许本机发来的请求。
 *
 * 为什么不是「同源 + 浏览器鉴权 cookie」：DSH 的 web GUI 与插件路由在同一个 origin，
 * 浏览器请求天然带 Host=127.0.0.1:<port>；而 webserver 可能被配置成绑非回环地址，
 * 那时任何能访问该地址的人都能打到这条路由。官方插件族的共享围栏（pair-access）也是
 * 「loopback 直接放行」，这里保持同一档：回环 + Host 必须是回环字面量。
 */
function isLoopbackRequest(req) {
  const addr = String(req.socket?.remoteAddress ?? '');
  const loopbackAddr = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
  if (!loopbackAddr) return false;
  const host = String(req.headers?.host ?? '').toLowerCase();
  // Host 允许 127.0.0.1 / localhost / [::1]，可带端口
  return /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host);
}

function sendJson(res, status, obj) {
  const payload = JSON.stringify(obj, null, 2);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(payload);
}

async function readJsonBody(req, limit = 1_000_000) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  return JSON.parse(text);
}

/** 跑 schtasks 并返回 { code, text }（spawn 本身失败时 code=null）。 */
function schtasks(args) {
  const r = spawnSync('schtasks.exe', args, { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  if (r.error) return { code: null, text: '' };
  // ⚠️ 中文 Windows 上 schtasks 会输出本地化文本，用 utf8 读进来是乱码 —— 所以
  // **绝不把这段文本回给浏览器**，只认退出码；状态另走语言无关的 XML（见 taskState）。
  return { code: r.status, text: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/**
 * 读一个计划任务的状态。
 *
 * 为什么走 `/XML` 而不是 `/FO LIST`：LIST 输出的字段名是**本地化**的（中文 Windows 上是「状态：」），
 * 用 utf8 读会变乱码，正则匹配不到——实测「已禁用」的任务被解析成 `status: ''`，
 * 于是面板永远显示「停止桥接」按钮（该显示「启动桥接」时也显示错）。
 * XML 里的 `<Settings><Enabled>true|false</Enabled>` 是语言无关的，退出码判断存在性也可靠。
 */
function taskState(taskName) {
  const r = schtasks(['/Query', '/TN', taskName, '/XML']);
  if (r.code !== 0 || !r.text) return { exists: false, enabled: null, status: '未找到' };
  // 只看 <Settings> 块里的 Enabled：触发器自己也有 <Enabled>，混在一起会误判。
  // ⚠️ 实测：任务**启用**时这个元素会被整个省略（schema 里默认 true），只有**禁用**时
  // 才出现 `<Enabled>false</Enabled>` —— 所以判据是「有没有 false」，不是「有没有 true」。
  const settings = /<Settings>([\s\S]*?)<\/Settings>/i.exec(r.text)?.[1] ?? '';
  const enabled = !/<Enabled>\s*false\s*<\/Enabled>/i.test(settings);
  return { exists: true, enabled, status: enabled ? '已启用' : '已禁用' };
}

/** 进程级开关：start / stop / restart。返回 { ok, actions: [...] }。 */
function controlProcess(action) {
  const actions = [];
  const run = (label, args) => {
    const r = schtasks(args);
    actions.push({ label, ok: r.code === 0, exitCode: r.code ?? null });
  };
  // 停止前必须先禁用保活（否则 ≤1 分钟就被拉回，实测见 DESIGN.md）
  if (action === 'stop') {
    run('禁用保活触发器', ['/Change', '/TN', BRIDGE_TASK, '/DISABLE']);
    run('结束桥接进程', ['/End', '/TN', BRIDGE_TASK]);
    return { ok: actions.every((a) => a.ok), action, actions };
  }
  if (action === 'start') {
    run('启用保活触发器', ['/Change', '/TN', BRIDGE_TASK, '/ENABLE']);
    run('启动桥接', ['/Run', '/TN', BRIDGE_TASK]);
    return { ok: actions.every((a) => a.ok), action, actions };
  }
  return { ok: false, action, actions, error: `未知 action：${action}` };
}

/** 只放行面板真正会写的字段（防止误把整份 socialV2 覆盖进去）。 */
const SPEED_KEYS = {
  top: ['autoReplyCheckMs'],
  wake: ['batchWindowMs', 'maxWakePerMinute', 'maxWakePerHour', 'recommendedProbability', 'preSleepWaitMs'],
  send: ['gapBaseMs', 'gapPerCharMs', 'burstIntervalMinMs', 'burstIntervalMaxMs', 'maxSendPerMinute', 'maxSendPerHour'],
};
const WAIT_KEYS = {
  wait: ['minMs', 'defaultMs', 'maxMs', 'defaultQuietMs', 'minQuietAfterNewMs', 'leaseMs'],
};

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj && Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
  return out;
}

/** 从 socialV2 配置里挑出面板关心的字段（读回用）。 */
function projectConfig(cfg) {
  return {
    autoReplyCheckMs: cfg?.autoReplyCheckMs ?? null,
    wake: pick(cfg?.wake, SPEED_KEYS.wake),
    send: pick(cfg?.send, SPEED_KEYS.send),
    wait: pick(cfg?.wait, ['minMs', 'defaultMs', 'maxMs', 'defaultQuietMs', 'minQuietAfterNewMs', 'leaseMs']),
    tools: { sendVoice: cfg?.tools?.sendVoice === true, setStickerRemark: cfg?.tools?.setStickerRemark === true },
    enabled: cfg?.enabled !== false,
    agentPreset: cfg?.agentPreset ?? null,
  };
}

/** 带 `[wait]` 的最近日志行（排「等待锁」用）。 */
function tailWaitLog(lines = 40) {
  const file = path.join(BRIDGE_DIR, 'state', 'bridge.log');
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const hits = raw.split(/\r?\n/).filter((l) => l.includes('[wait]') || l.includes('等待'));
    return hits.slice(-lines);
  } catch {
    return [];
  }
}

export function apply(ctx) {
  const handle = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const route = url.pathname.slice(ROUTE_PREFIX.length) || '/';

    if (!isLoopbackRequest(req)) {
      sendJson(res, 403, { ok: false, error: '只允许本机回环请求' });
      return;
    }

    try {
      // ── 只读：聚合状态 ────────────────────────────────────────────────────
      if (req.method === 'GET' && (route === '/' || route === '/state')) {
        const [status, whitelist, config, activity] = await Promise.all([
          callBridge('/api/status'),
          callBridge('/api/whitelist'),
          callBridge('/api/socialV2/config'),
          callBridge('/api/socialV2/activity'),
        ]);
        sendJson(res, 200, {
          ok: true,
          bridge: {
            up: status.ok,
            api: BRIDGE_BASE,
            dir: BRIDGE_DIR,
            status: status.ok ? status.data : null,
            error: status.ok ? null : (status.data?.error ?? `HTTP ${status.status}`),
          },
          process: { task: BRIDGE_TASK, ...taskState(BRIDGE_TASK) },
          snowluma: { task: SNOWLUMA_TASK, ...taskState(SNOWLUMA_TASK) },
          paused: activity.ok ? activity.data?.paused === true : null,
          whitelist: whitelist.ok ? whitelist.data : null,
          config: config.ok ? projectConfig(config.data?.config) : null,
          waitLog: tailWaitLog(20),
        });
        return;
      }

      if (req.method === 'GET' && route === '/settings') {
        const cfg = await callBridge('/api/socialV2/config');
        sendJson(res, cfg.ok ? 200 : 502, cfg.ok ? { ok: true, config: projectConfig(cfg.data?.config) } : cfg.data);
        return;
      }

      if (req.method === 'GET' && route === '/waitlog') {
        sendJson(res, 200, { ok: true, lines: tailWaitLog(60) });
        return;
      }

      // ── 写：白名单 ────────────────────────────────────────────────────────
      if (req.method === 'POST' && route === '/whitelist') {
        const body = await readJsonBody(req);
        const payload = {};
        for (const side of ['allow', 'deny']) {
          if (body[side] && typeof body[side] === 'object') {
            payload[side] = pick(body[side], ['groups', 'private']);
          }
        }
        if (body.ownerQQ !== undefined) payload.ownerQQ = body.ownerQQ;
        const r = await callBridge('/api/whitelist', { method: 'POST', body: payload });
        sendJson(res, r.ok ? 200 : (r.status || 502), r.data);
        return;
      }

      // ── 写：响应速度 + 等待锁 ─────────────────────────────────────────────
      if (req.method === 'POST' && route === '/settings') {
        const body = await readJsonBody(req);
        const payload = {};
        if (body.autoReplyCheckMs !== undefined) payload.autoReplyCheckMs = body.autoReplyCheckMs;
        if (body.wake) payload.wake = { ...pick(body.wake, SPEED_KEYS.wake), ...pick(body.wake, WAIT_KEYS.wait) };
        if (body.send) payload.send = pick(body.send, SPEED_KEYS.send);
        if (body.wait) payload.wait = pick(body.wait, WAIT_KEYS.wait);
        if (Object.keys(payload).length === 0) {
          sendJson(res, 400, { ok: false, error: '没有可写入的字段' });
          return;
        }
        const r = await callBridge('/api/socialV2/config', { method: 'POST', body: payload });
        sendJson(res, r.ok ? 200 : (r.status || 502), r.ok ? { ok: true, config: projectConfig(r.data?.config) } : r.data);
        return;
      }

      // ── 写：暂停/恢复 AI 活动（软开关） ────────────────────────────────────
      if (req.method === 'POST' && route === '/activity') {
        const body = await readJsonBody(req);
        const r = await callBridge('/api/socialV2/activity', { method: 'POST', body: { paused: body.paused === true } });
        sendJson(res, r.ok ? 200 : (r.status || 502), r.data);
        return;
      }

      // ── 写：进程级开关（硬开关，走任务计划） ──────────────────────────────
      if (req.method === 'POST' && route === '/process') {
        const body = await readJsonBody(req);
        if (body.action === 'restart') {
          // 让桥接自己退出；守护（start-qqbridge.mjs）会在 5 秒后拉起
          const r = await callBridge('/api/restart', { method: 'POST', body: {} });
          sendJson(res, r.ok ? 200 : (r.status || 502), { ok: r.ok, action: 'restart', detail: r.data });
          return;
        }
        const r = controlProcess(String(body.action ?? ''));
        sendJson(res, r.ok ? 200 : 400, r);
        return;
      }

      // ── 写：发一条测试消息（复用桥接的 /api/test-send） ───────────────────
      if (req.method === 'POST' && route === '/test-send') {
        const body = await readJsonBody(req);
        const r = await callBridge('/api/test-send', { method: 'POST', body: pick(body, ['key', 'text', 'message']) });
        sendJson(res, r.ok ? 200 : (r.status || 502), r.data);
        return;
      }

      sendJson(res, 404, { ok: false, error: `未知路由 ${route}` });
    } catch (error) {
      log('路由异常:', error?.message ?? error);
      try { sendJson(res, 500, { ok: false, error: String(error?.message ?? error) }); } catch {}
    }
  };

  const dispose = ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: handle });
  ctx.effect(() => () => { try { dispose(); } catch {} }, 'dsh-qq-console: routes');
  log(`已挂载 ${ROUTE_PREFIX}/*（桥接 ${BRIDGE_BASE}，任务 ${BRIDGE_TASK}）`);
}