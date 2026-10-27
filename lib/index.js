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
/** 需要宿主提供 webServer（路由）与 tools（注册 agent 工具）两个服务。 */
export const inject = ['webServer', 'tools'];

/** 桥接安装目录（本机固定路径；将来若换位置，改这一处）。 */
const BRIDGE_DIR = process.env.DSH_QQ_BRIDGE_DIR || 'C:\\Users\\faith\\qq-bridge';
const BRIDGE_BASE = process.env.DSH_QQ_BRIDGE_API || 'http://127.0.0.1:3100';
const ROUTE_PREFIX = '/dsh-qq-console';
/** 桥接的保活计划任务名（改这里就能换成别的部署方式）。 */
const BRIDGE_TASK = process.env.DSH_QQ_BRIDGE_TASK || 'DSH-qq-bridge';
const SNOWLUMA_TASK = process.env.DSH_QQ_SNOWLUMA_TASK || 'SnowLuma-QQ';
/** 单次调用桥接 API 的超时。 */
const API_TIMEOUT_MS = 8000;

// ── 整套 QQ 栈的启停 ─────────────────────────────────────────────────────────
//
// 为什么需要它（2026-10-25 操作者反馈）：只「停桥接进程」是不够的 ——
// SnowLuma 网关、RVC/CosyVoice 语音服务各有三套保活（计划任务每分钟、HKCU 登录自启、
// DSH 的 MCP 注册会被按需重启），直接杀会被立刻拉回来，内存也降不下来。
// 完整顺序是：断自启 → 关 MCP 注册 → 杀进程 → 复查。
// 这套逻辑的**唯一实现**是桥接目录里的 stop-qq-stack.ps1 / start-qq-stack.ps1
// （命令行双击与控制台走同一份，避免两处行为漂移）；本组路由只把它包成 HTTP 并把输出回给面板。
const STACK_TASKS = [BRIDGE_TASK, SNOWLUMA_TASK, 'DSH-RVC-Server', 'DSH-Cosy-Server'];
const STACK_RUN_NAMES = ['DSH-RVC-Server', 'DSH-Cosy-Server'];
/** stop 脚本给 MCP 注册打的注释前缀（据此判断"注册是开还是关"）。 */
const STACK_OFF_TAG = '# [qq-stack-off] ';
/** DSH 的 patch 文件：QQ 的 MCP 注册写在这里。 */
const DSH_PATCH_FILE = path.join(process.env.USERPROFILE || 'C:\\Users\\faith', '.dsh', 'profiles', 'desktop', 'cordis.patch.yml');

/** 跑一段 PowerShell 并收回 stdout（本插件在 DSH 宿主进程里跑，不是受限沙箱）。 */
function runPowerShell(script, timeoutMs = 120000) {
  const r = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024,
  });
  return { ok: r.status === 0, status: r.status, out: String(r.stdout ?? '').trim(), err: String(r.stderr ?? '').trim() };
}

/** 整套栈的当前状态：任务开关、登录自启、MCP 注册、相关进程与端口、内存。 */
function stackStatus() {
  const list = STACK_TASKS.map((t) => `'${t}'`).join(',');
  const runs = STACK_RUN_NAMES.map((t) => `'${t}'`).join(',');
  const ps = [
    `$tasks = @(foreach ($t in @(${list})) { $x = Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue;`,
    `  [pscustomobject]@{ name = $t; exists = [bool]$x; state = $(if ($x) { [string]$x.State } else { '' }) } })`,
    `$props = Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -ErrorAction SilentlyContinue`,
    `$runs = @(foreach ($t in @(${runs})) { [pscustomobject]@{ name = $t; present = [bool]$props.$t } })`,
    `$procs = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -and $_.CommandLine -match 'start-qqbridge|qq-bridge\\\\src|rvc-server|cosy-server|C:\\\\SnowLuma' -and $_.CommandLine -notmatch 'DeepSeek Harness|app\\.asar|dsh-runtimes' } | ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; name = $_.Name } })`,
    `$ports = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in 3100,4892,7880,7890 } | ForEach-Object { $_.LocalPort })`,
    `$os = Get-CimInstance Win32_OperatingSystem`,
    `[pscustomobject]@{ tasks = $tasks; runEntries = $runs; processes = $procs; ports = @($ports);`,
    `  memory = [pscustomobject]@{ freeMB = [int]($os.FreePhysicalMemory / 1KB); totalMB = [int]($os.TotalVisibleMemorySize / 1KB) } } | ConvertTo-Json -Depth 4 -Compress`,
  ].join('; ');
  const r = runPowerShell(ps, 60000);
  let data = null;
  try { data = JSON.parse(r.out); } catch { /* 桥接未起/策略受限时给 null，不抛 */ }
  let mcpDisabled = null;
  try { mcpDisabled = fs.readFileSync(DSH_PATCH_FILE, 'utf8').includes(STACK_OFF_TAG); } catch { mcpDisabled = null; }
  return {
    ok: true,
    tasks: data?.tasks ?? null,
    runEntries: data?.runEntries ?? null,
    mcpRegistration: { path: DSH_PATCH_FILE, disabled: mcpDisabled },
    processes: data?.processes ?? null,
    ports: data?.ports ?? null,
    memory: data?.memory ?? null,
    scripts: {
      stop: path.join(BRIDGE_DIR, 'stop-qq-stack.ps1'),
      start: path.join(BRIDGE_DIR, 'start-qq-stack.ps1'),
      exists: fs.existsSync(path.join(BRIDGE_DIR, 'stop-qq-stack.ps1')) && fs.existsSync(path.join(BRIDGE_DIR, 'start-qq-stack.ps1')),
    },
    error: r.ok ? undefined : (r.err || `PowerShell 退出码 ${r.status}`).slice(0, 300),
  };
}

/** 跑整套启停脚本；dryRun 只回"将要执行什么"，不真的执行（面板与冒烟测试都用它预演）。 */
function runStackScript(kind, { withVoice = false, voice = 'both', dryRun = false } = {}) {
  const file = path.join(BRIDGE_DIR, kind === 'stop' ? 'stop-qq-stack.ps1' : 'start-qq-stack.ps1');
  if (!fs.existsSync(file)) return { ok: false, error: `找不到脚本：${file}（整套启停脚本应放在桥接目录）` };
  const args = ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file];
  if (kind === 'start') {
    if (withVoice) args.push('-WithVoice');
    if (voice && voice !== 'both') args.push('-Voice', voice);
  }
  if (dryRun) {
    return { ok: true, dryRun: true, kind, script: file, args: args.slice(4), note: '仅预演，没有真的执行' };
  }
  const r = spawnSync('powershell.exe', args, { encoding: 'utf8', timeout: 180000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  const output = String(r.stdout ?? '').trim();
  return {
    ok: r.status === 0,
    kind,
    script: file,
    status: r.status,
    output: output.slice(-3000),
    ...(r.status === 0
      ? {}
      : { error: (String(r.stderr ?? '').trim().slice(0, 500) || `脚本退出码 ${r.status}`) }),
    hint: kind === 'stop'
      ? 'MCP 子进程要等重启一次 DSH 才会彻底不再出现'
      : '恢复 MCP 注册后，需重启一次 DSH 才会重新出现 QQ 工具',
  };
}

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

/** 进程级开关：start / stop / restart。返回 { ok, actions: [...] }。
 *
 *  2026-10-25 修正：原来只动 BRIDGE_TASK，于是出现过「桥接起来了、SnowLuma 网关却还是 Disabled，
 *  QQ 实际不通」这种自相矛盾的状态（操作者就在面板上看到过 `SnowLuma 任务 SnowLuma-QQ：已禁用`）。
 *  桥接与网关本来就该同生共死 —— 网关是桥接连 OneBot 的前置。现在 start/stop 一起处理两者。
 *
 *  注意：DSH 的 QQ MCP 注册**不**在这里动（那是 ① 卡片「整套启停」的职责）；
 *  但 start 时若发现注册是关的，就回一条 warning，由面板显式提示。
 */
function controlProcess(action) {
  const actions = [];
  const run = (label, args) => {
    const r = schtasks(args);
    actions.push({ label, ok: r.code === 0, exitCode: r.code ?? null });
  };
  const mcpDisabled = () => {
    try { return fs.readFileSync(DSH_PATCH_FILE, 'utf8').includes(STACK_OFF_TAG); } catch { return null; }
  };
  // 停止前必须先禁用保活（否则 ≤1 分钟就被拉回，实测见 DESIGN.md）
  if (action === 'stop') {
    for (const [label, task] of [['桥接', BRIDGE_TASK], ['SnowLuma 网关', SNOWLUMA_TASK]]) {
      run(`禁用${label}保活触发器`, ['/Change', '/TN', task, '/DISABLE']);
      run(`结束${label}进程`, ['/End', '/TN', task]);
    }
    return { ok: actions.every((a) => a.ok), action, actions };
  }
  if (action === 'start') {
    // 先起网关再起桥接：桥接启动时会去连 OneBot(3000)，顺序反了会先记一串连接失败日志。
    for (const [label, task] of [['SnowLuma 网关', SNOWLUMA_TASK], ['桥接', BRIDGE_TASK]]) {
      run(`启用${label}保活触发器`, ['/Change', '/TN', task, '/ENABLE']);
      run(`启动${label}`, ['/Run', '/TN', task]);
    }
    return {
      ok: actions.every((a) => a.ok),
      action,
      actions,
      ...(mcpDisabled() === true
        ? { warning: 'DSH 的 QQ MCP 注册当前是关闭的：AI 还没有 QQ 工具。点「整套启动」可恢复它（需重启一次 DSH 才会出现）。' }
        : {}),
    };
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

// ── QQ 工具白名单（执行期守卫的扩展项） ───────────────────────────────────────
//
// 守卫在 `plugins/qq-agent-presets/qq-tool-restrict.mjs`（QQ preset 的执行期白名单），
// 硬编码放行三类 MCP 命名空间 + ask_user_question/todo_write，其余一律拒绝；
// 它另外会按 mtime 读取下面这个 JSON 的扩展项 ⇒ 这里改文件即生效（不必重启 DSH）。
const TOOL_ALLOWLIST_FILE = () => path.join(BRIDGE_DIR, 'state', 'tool-allowlist.json');

/** 硬编码放行项（只读展示；真值在守卫源码里，这里只是给面板看的副本）。 */
const BUILTIN_PREFIXES = ['mcp__snowluma__', 'mcp__snowluma-host__', 'mcp__web-search-safe__'];
const BUILTIN_EXACT = ['ask_user_question', 'todo_write'];

/** 工具名允许的字符集：插件注册的名字都是 [A-Za-z0-9_.-]（加 .- 以防万一）。 */
const TOOL_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;

/** 面板里可一键添加的「已知插件工具」目录（risk=true 会带 ⚠️ 说明）。 */
const TOOL_CATALOG = [
  {
    group: 'dsh-meme',
    note: '表情包插件（v0.1.60 注册的全部工具）',
    tools: [
      { name: 'send_meme', desc: '从本地图库挑一张贴题的表情包发出去' },
      { name: 'learn_meme', desc: '把一张图收进图库（会写入插件自己的数据目录）' },
    ],
  },
  {
    group: 'dsh-vision-router',
    note: '看图/分析类默认放行；截图与写文件类默认**不放**（会把本机画面/文件暴露给群里的人）',
    tools: [
      { name: 'vision_describe', desc: '让视觉模型描述一张图' },
      { name: 'vision_ocr', desc: '图片文字识别' },
      { name: 'vision_crop', desc: '裁剪图片（给后续分析用）' },
      { name: 'vision_ground', desc: '定位图中目标' },
      { name: 'vision_detect', desc: '检测图中元素' },
      { name: 'vision_colors', desc: '取图中主要颜色' },
      { name: 'vision_pixel_diff', desc: '两张图做像素差' },
      { name: 'vision_extract_foreground', desc: '抠前景' },
      { name: 'vision_trace', desc: '把图片转成可继续处理的矢量/描边' },
      { name: 'vision_present', desc: '把处理后的图展示给对话方' },
      { name: 'vision_bootstrap', desc: '视觉链路的初始化说明（其它 vision_* 常用）' },
      { name: 'vision_activate', desc: '激活本会话的视觉链路' },
      { name: 'vision_screenshot', desc: '截取本机桌面并交给模型', risk: true },
      { name: 'vision_html_screenshot', desc: '渲染 HTML 并截图（会跑本机渲染器）', risk: true },
      { name: 'vision_materialize', desc: '把图片/中间产物写成文件', risk: true },
      { name: 'vision_long_screenshot_ocr', desc: '长截图 OCR（隐含截图能力）', risk: true },
    ],
  },
];

/** 读扩展白名单文件（宽容：不存在/损坏都当空，并回报原因）。 */
function readToolAllowlist() {
  const file = TOOL_ALLOWLIST_FILE();
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    const clean = (arr) => (Array.isArray(arr) ? arr.map((x) => String(x).trim()).filter((x) => TOOL_NAME_RE.test(x)) : []);
    return {
      ok: true,
      path: file,
      allowedExact: [...new Set(clean(doc.allowedExact))],
      allowedPrefixes: [...new Set(clean(doc.allowedPrefixes))],
    };
  } catch (error) {
    return { ok: false, path: file, allowedExact: [], allowedPrefixes: [], error: String(error?.message ?? error) };
  }
}

/** 写扩展白名单（保留 _doc/_notes 等既有键，tmp+rename 原子替换）。 */
function writeToolAllowlist({ allowedExact, allowedPrefixes }) {
  const file = TOOL_ALLOWLIST_FILE();
  const sanitize = (arr) => {
    if (arr === undefined || arr === null) return null;
    if (!Array.isArray(arr)) throw new Error('allowedExact/allowedPrefixes 必须是数组');
    const out = [];
    for (const raw of arr) {
      const name = String(raw ?? '').trim();
      if (!name) continue;
      if (!TOOL_NAME_RE.test(name)) throw new Error(`非法工具名：${JSON.stringify(name)}（只允许 [A-Za-z0-9_.-]，≤64 字符）`);
      if (!out.includes(name)) out.push(name);
    }
    if (out.length > 300) throw new Error('条目过多（>300）');
    return out;
  };
  const exact = sanitize(allowedExact);
  const prefixes = sanitize(allowedPrefixes);
  const current = (() => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } })();
  const next = {
    ...current,
    allowedExact: exact ?? (Array.isArray(current.allowedExact) ? current.allowedExact : []),
    allowedPrefixes: prefixes ?? (Array.isArray(current.allowedPrefixes) ? current.allowedPrefixes : []),
    _updatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
  return readToolAllowlist();
}

// ── TTS → QQ 语音（操作者通道，2026-10-25 接入 dsh-plugin-tts） ────────────────
//
// 为什么这么接（每一环都是实测出来的）：
//   ① 文本→音频用 dsh-plugin-tts 的宿主路由：`POST /dsh-tts-api/speak`
//      （Edge TTS，免 API key；实测 `GET /dsh-tts-api/diagnose` 里 edge.ok=true）
//      返回 `{ url: '/dsh-tts-audio/<id>' }`，短文本走单条分支（>12 秒语音才走分块）。
//   ② 音频是自己去 GET 那个 url 拿字节（落 os.tmpdir()，不能直接读文件，随机名且会被清理）。
//   ③ 存进桥接的「语音库」目录（config.json 的 socialV2.voice.dir，默认 audio/）。
//      桥接的语音引用默认只从库里取（AI 通道强制如此；操作者通道也优先按库解析）。
//   ④ 交给桥接的 **操作者通道** `POST /api/voice/send {target, file}`：
//      由控制台令牌鉴权、且**明确不检查 socialV2.voice.enabled**
//      （bridge.js:5534-5537 的注释原文：那个开关只该管"AI 能不能发语音"，
//        不该连手动试发一起关掉）⇒ 所以"代你发"不需要给 AI 开语音能力。
//      最后由 SnowLuma 网关把 mp3 转成 NT SILK 发成 QQ 语音条（桥接不做预转码）。
//
// 用请求自身的 Host 推导 DSH 源：路由入口已经用 isLoopbackRequest 校验过
// Host ∈ {127.0.0.1, localhost, [::1]}(:port)，所以这里拿它是可信的、也不会依赖
// config.json 里那个可能滞后的 dsh.baseUrl。
const TTS_SPEAK_PATH = '/dsh-tts-api/speak';
const TTS_DIAGNOSE_PATH = '/dsh-tts-api/diagnose';
/**
 * TTS 合成 / 取音频的超时。
 *
 * 教训（2026-10-25 实测）：原来写死 30 秒，结果 AI 第一次调 `qq_say_voice` 时
 * CosyVoice 正处在"冷启动 + 长句"状态，合成约 33 秒被我的 30 秒 abort 掐断
 * （插件侧反而没记错——它的内部超时是 60s/900s，**我这条链才是最紧的一环**）。
 * 本地克隆引擎冷启动可达数十秒，所以给 240 秒；取音频给 120 秒。
 * 两者都可用环境变量覆盖（**宿主半改动要重启 DSH 才生效**）。
 */
const TTS_TIMEOUT_MS = Number(process.env.DSH_QQ_TTS_TIMEOUT_MS ?? '') || 240000;
const TTS_AUDIO_TIMEOUT_MS = Number(process.env.DSH_QQ_TTS_AUDIO_TIMEOUT_MS ?? '') || 120000;
/** 单条语音的文本上限：QQ 语音条不宜太长，也让它留在 speak 的单条分支里。 */
const TTS_MAX_CHARS = 200;
/**
 * 面板下拉里的音色候选。**只放有直接证据的两个**（插件默认值 + 它的 RVC baseVoice），
 * 其余让用户自己填：Edge 音色名以微软侧为准，凭印象列一串反而会给人"这些都是验证过的"错觉。
 */
const TTS_VOICES = [
  { id: 'zh-CN-XiaoxuanNeural', label: '晓萱（插件默认）' },
  { id: 'zh-CN-YunyangNeural', label: '云扬（插件 baseVoice）' },
];
/** 语音库保留的最新文件数（超出的旧 tts-* 会被清理，避免无限堆积）。 */
const VOICE_LIBRARY_KEEP = 50;

function dshOriginOf(req) {
  return `http://${String(req.headers?.host ?? '').trim()}`;
}

/** 语音库目录（相对桥接根目录；config.json 读不出来就退回 audio/）。 */
function voiceLibraryDir() {
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(BRIDGE_DIR, 'config.json'), 'utf8'));
    const dir = String(doc?.socialV2?.voice?.dir ?? 'audio').trim() || 'audio';
    return path.isAbsolute(dir) ? dir : path.join(BRIDGE_DIR, dir);
  } catch {
    return path.join(BRIDGE_DIR, 'audio');
  }
}

/** 只保留最新的 N 个 tts-*.mp3/wav，避免语音库无限增长。 */
function pruneVoiceLibrary(keep = VOICE_LIBRARY_KEEP) {
  try {
    const dir = voiceLibraryDir();
    const mine = fs.readdirSync(dir)
      .filter((n) => /^(tts|rvc)-/i.test(n) && /\.(mp3|wav|m4a|ogg|opus)$/i.test(n))
      .map((n) => ({ n, t: fs.statSync(path.join(dir, n)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const { n } of mine.slice(keep)) fs.unlinkSync(path.join(dir, n));
    return mine.length;
  } catch {
    return 0;
  }
}

/** 调 TTS 合成。返回 { ok, url, status, error }。custom/prosody 只对本地引擎有意义（见 TTS 插件各指南）。 */
async function ttsSynthesize(origin, { text, voice, provider, custom, prosody }) {
  try {
    const res = await fetch(`${origin}${TTS_SPEAK_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text,
        voice,
        provider,
        ...(custom === undefined ? {} : { custom }),
        ...(prosody === undefined ? {} : { prosody }),
      }),
      signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, status: res.status, error: String(body?.error ?? `TTS 合成失败（HTTP ${res.status}）`) };
    if (!body?.url) return { ok: false, status: res.status, error: 'TTS 没有返回音频地址' };
    return { ok: true, url: String(body.url), cached: body.cached === true, status: res.status };
  } catch (error) {
    return { ok: false, status: 0, error: `调用 TTS 失败：${error?.message ?? error}` };
  }
}

/** 取音频字节。返回 { ok, buffer, contentType, error }。 */
async function ttsFetchAudio(origin, url) {
  try {
    if (!url.startsWith('/dsh-tts-audio/')) throw new Error('音频地址不在 /dsh-tts-audio/ 下');
    const res = await fetch(`${origin}${url}`, { signal: AbortSignal.timeout(TTS_AUDIO_TIMEOUT_MS) });
    if (!res.ok) return { ok: false, error: `取音频失败（HTTP ${res.status}）` };
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length === 0) return { ok: false, error: '音频是空的' };
    return { ok: true, buffer, contentType: String(res.headers.get('content-type') ?? '') };
  } catch (error) {
    return { ok: false, error: `取音频失败：${error?.message ?? error}` };
  }
}

/** 从桥接 config.json 读 DSH 地址（桥接会自愈它）。给**工具**用——工具没有请求可拿 Host。 */
function dshBaseFromConfig() {
  const fromEnv = String(process.env.DSH_BASE_URL ?? '').trim();
  if (fromEnv) return fromEnv.replace(/\/+$/, '');
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(BRIDGE_DIR, 'config.json'), 'utf8'));
    const url = String(doc?.dsh?.baseUrl ?? '').trim();
    if (url) return url.replace(/\/+$/, '');
  } catch { /* 读不出来就返回空，调用方会给出可读错误 */ }
  return '';
}

/**
 * 「AI 能不能主动发语音」的总开关 = 桥接的 socialV2.voice.enabled。
 * 读不到就当**关**（fail-closed）：宁可让 AI 发不出语音，也不要意外开口。
 */
function aiVoiceEnabled() {
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(BRIDGE_DIR, 'config.json'), 'utf8'));
    return doc?.socialV2?.voice?.enabled === true;
  } catch {
    return false;
  }
}

/**
 * 「合成 + 发语音」的唯一实现：HTTP 路由（面板 / tools/say-voice.mjs）与 agent 工具都走它。
 * @returns {{status:number, body:object}} —— 不抛；调用方直接当响应发出去。
 */
async function performSay({ origin, key, text, voice, provider, custom, prosody, dryRun, volume, normalize }) {
  const k = String(key ?? '').trim();
  const t = String(text ?? '').trim();
  // 引擎/音色/custom 的解析统一走"默认声音"那一套：显式参数 > state/qq-voice.json > 内置兜底
  const choice = resolveVoiceChoice({ provider, voice, custom });
  const v = choice.voice;
  const p = choice.provider;
  if (!/^(group|private):[1-9]\d*$/.test(k)) {
    return { status: 400, body: { ok: false, error: '目标要写成 group:群号 或 private:QQ号' } };
  }
  if (!t) return { status: 400, body: { ok: false, error: '文本为空' } };
  if (t.length > TTS_MAX_CHARS) {
    return { status: 400, body: { ok: false, error: `文本过长（${t.length} > ${TTS_MAX_CHARS} 字）` } };
  }
  if (!origin) {
    return { status: 503, body: { ok: false, error: '拿不到 DSH 地址（读不到桥接 config.json 的 dsh.baseUrl，也没设 DSH_BASE_URL）' } };
  }

  const synth = await ttsSynthesize(origin, { text: t, voice: v, provider: p, custom: choice.custom, prosody });
  if (!synth.ok) return { status: 502, body: { ok: false, stage: 'synthesize', error: synth.error } };
  const audio = await ttsFetchAudio(origin, synth.url);
  if (!audio.ok) return { status: 502, body: { ok: false, stage: 'fetch', error: audio.error } };

  const ext = audio.contentType.includes('wav') ? 'wav' : 'mp3';
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const file = `tts-${stamp}-${Math.random().toString(36).slice(2, 6)}.${ext}`;
  const dir = voiceLibraryDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, file), audio.buffer);
  } catch (error) {
    return { status: 500, body: { ok: false, stage: 'save', error: `写入语音库失败：${error?.message ?? error}` } };
  }
  pruneVoiceLibrary();

  const sent = await callBridge('/api/voice/send', {
    method: 'POST',
    body: {
      target: k,
      file,
      ...(dryRun === true ? { dryRun: true } : {}),
      ...(volume === undefined ? {} : { volume }),
      ...(normalize === true ? { normalize: true } : {}),
    },
  });
  return {
    status: sent.ok === false ? (sent.status || 502) : 200,
    body: {
      ok: sent.ok === true && sent.data?.ok !== false,
      ...(sent.data?.ok === false && sent.data?.error ? { error: String(sent.data.error) } : {}),
      tts: { url: synth.url, cached: synth.cached === true, bytes: audio.buffer.length, file, dir, voice: v, provider: p, chars: t.length },
      bridge: sent.data,
    },
  };
}

// ── 语音发送限制（调试） ──────────────────────────────────────────────────────
//
// 桥接的 `socialV2.voice` 里有一整套「能不能发 / 发多长 / 发多大 / 发多快」的限制，
// 但它们散在 config.json 里，而且**没有任何一处 UI 会告诉你"这一条现在会不会被拒"**。
// 这一组路由就是给那张卡片用的：
//   · GET  /voice-limits   —— 当前限制 + 从 bridge.log 反推的**实际用量** + 语音库清单
//   · POST /voice-limits   —— 改限制（整份 voice 回写，见下）
//   · POST /voice-check    —— 预检：给一段文本或语音库里的一个文件，逐条判会不会被拒
//
// 为什么改限制要「整份回写」：桥接的 `POST /api/socialV2/config` 对 `voice` 是
// `merged = {...current, ...body}`（浅合并，见 bridge.js:4402），而运行时落地是
// `cfg.socialV2 = {...cfg.socialV2, ...merged}` —— 也就是说我们提交的 voice 对象会**整体替换**
// 运行时那一份。只发 `{maxPerMinute: 5}` 会把 ffmpegPath / dir / loudness 一起抹掉
// （下一次 voiceCfg() 就退回默认值）。所以这里先读全量、再合并、再整份回写。
const VOICE_LIMIT_DEFAULTS = {
  enabled: false,
  dir: 'audio',
  maxSeconds: 300,
  maxBytes: 20 * 1024 * 1024,
  maxPerMinute: 2,
  maxPerHour: 10,
  allowAbsolutePath: false,
  defaultVolume: 1,
  loudness: 'normal',
  ffmpegPath: '',
  autoReadback: true,
};
const VOICE_LIMIT_KEYS = Object.keys(VOICE_LIMIT_DEFAULTS);

/**
 * 面板**可写**的限制项（其余如 dir / ffmpegPath 只读展示）。
 * 上下限不是随便定的：`maxPerMinute: 0` 在桥接里是「不限」（voiceCfg 用 `>= 0`），
 * 而 `maxSeconds: 0` 不是「不限」而是「退回默认 300 秒」—— 所以这里最小给 1，避免用户以为关掉了。
 */
const VOICE_LIMIT_RULES = {
  enabled: { kind: 'boolean', label: 'AI 能发语音（总闸）' },
  maxSeconds: { kind: 'int', min: 1, max: 3600, label: '单条时长上限（秒）' },
  maxBytes: { kind: 'int', min: 64 * 1024, max: 100 * 1024 * 1024, label: '单条体积上限（字节）' },
  maxPerMinute: { kind: 'int', min: 0, max: 120, label: '每分钟上限（0 = 不限）' },
  maxPerHour: { kind: 'int', min: 0, max: 2000, label: '每小时上限（0 = 不限）' },
  allowAbsolutePath: { kind: 'boolean', label: '允许绝对路径（AI 通道已不再放宽）' },
  defaultVolume: { kind: 'number', min: 0.1, max: 4, label: '默认音量倍数' },
  autoReadback: { kind: 'boolean', label: '发送后自动回读校验' },
  loudness: { kind: 'enum', values: ['quiet', 'normal', 'loud'], label: '智能音量档位' },
};

/** 语音库里的音频扩展名（与桥接 voice-core 的 AUDIO_EXTS 保持同一档）。 */
const VOICE_EXTS = /\.(mp3|wav|m4a|ogg|opus|silk|amr|flac|aac|wma)$/i;

function clampNumber(value, min, max, fallback, round = false) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const clamped = Math.min(max, Math.max(min, n));
  return round ? Math.round(clamped) : clamped;
}

/** 桥接 voiceCfg() 的同一套兜底：读不出来 / 写坏了都收敛到安全值，绝不把 NaN 回给面板。 */
function projectVoiceLimits(src) {
  const v = { ...VOICE_LIMIT_DEFAULTS, ...pick(src, VOICE_LIMIT_KEYS) };
  return {
    enabled: v.enabled === true,
    dir: String(v.dir ?? 'audio').trim() || 'audio',
    maxSeconds: clampNumber(v.maxSeconds, 1, 3600, 300, true),
    maxBytes: clampNumber(v.maxBytes, 64 * 1024, 100 * 1024 * 1024, 20 * 1024 * 1024, true),
    maxPerMinute: clampNumber(v.maxPerMinute, 0, 120, 2, true),
    maxPerHour: clampNumber(v.maxPerHour, 0, 2000, 10, true),
    allowAbsolutePath: v.allowAbsolutePath === true,
    defaultVolume: clampNumber(v.defaultVolume, 0.1, 4, 1),
    loudness: ['quiet', 'normal', 'loud'].includes(String(v.loudness)) ? String(v.loudness) : 'normal',
    ffmpegPath: String(v.ffmpegPath ?? ''),
    autoReadback: v.autoReadback !== false,
  };
}

/** 直接读 config.json 里的 voice 段（桥接 API 不通时的兜底）。 */
function readVoiceLimitsFromFile() {
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(BRIDGE_DIR, 'config.json'), 'utf8'));
    const v = doc?.socialV2?.voice;
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

/** 校验并归一化面板提交的限制补丁；非法项进 errors，合法项进 patch。 */
function normalizeVoiceLimitPatch(body) {
  const patch = {};
  const errors = [];
  const warnings = [];
  for (const [key, rule] of Object.entries(VOICE_LIMIT_RULES)) {
    if (!body || !Object.prototype.hasOwnProperty.call(body, key)) continue;
    const raw = body[key];
    if (raw === null || raw === '') continue; // 留空 = 不改
    if (rule.kind === 'boolean') {
      patch[key] = raw === true || raw === 'true';
      continue;
    }
    if (rule.kind === 'enum') {
      const s = String(raw).trim();
      if (!rule.values.includes(s)) errors.push(`${rule.label}只能是 ${rule.values.join(' / ')}，收到「${s}」`);
      else patch[key] = s;
      continue;
    }
    const n = Number(String(raw).trim());
    if (!Number.isFinite(n)) { errors.push(`${rule.label}必须是数字，收到「${raw}」`); continue; }
    if (n < rule.min || n > rule.max) {
      errors.push(`${rule.label}需在 ${rule.min} ~ ${rule.max} 之间，收到 ${n}`);
      continue;
    }
    const value = rule.kind === 'int' ? Math.round(n) : n;
    if (value !== n) warnings.push(`${rule.label}已取整为 ${value}`);
    patch[key] = value;
  }
  if (patch.maxPerMinute === 0 || patch.maxPerHour === 0) {
    warnings.push('频率上限写 0 = 不限（桥接用 >= 0 判断，0 不会退回默认值）');
  }
  return { patch, errors, warnings };
}

/** 读桥接日志的原始行（含轮转备份 .1；只用尾部，避免整文件扫）。 */
function readBridgeLogLines(maxLines = 4000) {
  const out = [];
  for (const name of ['bridge.log.1', 'bridge.log']) {
    try {
      const raw = fs.readFileSync(path.join(BRIDGE_DIR, 'state', name), 'utf8');
      const lines = raw.split(/\r?\n/).filter(Boolean);
      out.push(...lines.slice(-maxLines));
    } catch { /* 没有这个文件就跳过 */ }
  }
  return out;
}

/**
 * 从日志反推「最近 1 分钟 / 1 小时实际发了几条语音」。
 *
 * ⚠️ 这是**调试用的近似值**，不是桥接的权威计数：
 *   · 桥接的计数器在内存里（voiceSendTimes，按 scope 分桶），重启即清零；
 *   · 日志行只有 `HH:MM:SS` 没有日期，跨零点要靠「时间戳比现在还晚 ⇒ 当昨天」来纠正；
 *   · 桥接有 2000 行上限并轮转，非常密集时可能丢更早的行。
 * 但排查「为什么现在发不出去了」时，这个数字足够看出是不是撞上了限流。
 */
function voiceSendQuota() {
  const lines = readBridgeLogLines();
  const now = new Date();
  const nowSec = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
  const sends = [];
  for (const line of lines) {
    const m = /^(\d{2}):(\d{2}):(\d{2}) \[bridge\] \[voice\] (.*)$/.exec(line);
    if (!m) continue;
    const body = m[4];
    if (!body.includes('已发送语音')) continue;
    let delta = nowSec - (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]));
    if (delta < -5) delta += 86400; // 跨零点：那条是昨天的
    if (delta < 0 || delta > 86400) continue;
    sends.push({ clock: line.slice(0, 8), ageSec: delta, operator: body.includes('(操作者)'), line: line.slice(0, 240) });
  }
  const inMinute = sends.filter((s) => s.ageSec < 60);
  const inHour = sends.filter((s) => s.ageSec < 3600);
  return {
    minute: inMinute.length,
    hour: inHour.length,
    operatorMinute: inMinute.filter((s) => s.operator).length,
    operatorHour: inHour.filter((s) => s.operator).length,
    aiMinute: inMinute.filter((s) => !s.operator).length,
    aiHour: inHour.filter((s) => !s.operator).length,
    lastAt: sends.length ? sends.reduce((a, b) => (a.ageSec <= b.ageSec ? a : b)).clock : null,
    lastAgeSec: sends.length ? Math.min(...sends.map((s) => s.ageSec)) : null,
    source: 'state/bridge.log（近似值，桥接重启后内存计数会清零）',
  };
}

/** 最近的 [voice] 日志行（排「语音为什么发不出去」用）。 */
function tailVoiceLog(limit = 20) {
  return readBridgeLogLines()
    .filter((l) => /\[bridge\] \[voice\]/.test(l))
    .slice(-limit)
    .map((l) => l.slice(0, 240));
}

/** 语音库清单（最多两层目录，够覆盖桥接 listAudioFiles 的常见用法）。 */
function listVoiceLibraryFiles(limit = 200) {
  const root = voiceLibraryDir();
  const out = [];
  const walk = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (out.length >= limit) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth > 0) walk(full, depth - 1);
        continue;
      }
      if (!VOICE_EXTS.test(entry.name)) continue;
      let bytes = 0;
      let mtimeMs = 0;
      try { const st = fs.statSync(full); bytes = st.size; mtimeMs = st.mtimeMs; } catch { /* 读不到就留 0 */ }
      out.push({ name: path.relative(root, full).split(path.sep).join('/'), bytes, mtimeMs });
    }
  };
  walk(root, 1);
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** 取当前限制：优先桥接 API（含默认值合并），拿不到就退回 config.json。 */
async function currentVoiceLimits() {
  const cfg = await callBridge('/api/socialV2/config');
  if (cfg.ok && cfg.data?.config) {
    return {
      limits: projectVoiceLimits(cfg.data.config.voice),
      raw: cfg.data.config.voice ?? {},
      source: 'bridge-api',
      error: null,
    };
  }
  const raw = readVoiceLimitsFromFile();
  return {
    limits: projectVoiceLimits(raw),
    raw,
    source: 'config.json',
    error: cfg.data?.error ?? `桥接 API HTTP ${cfg.status}`,
  };
}

/** 预检里挑一个「一定能通过白名单」的默认目标（dryRun 也要过 modeAllowed）。 */
async function defaultVoiceTarget() {
  const wl = await callBridge('/api/whitelist');
  const allow = wl.ok ? (wl.data?.allow ?? {}) : {};
  const group = (allow.groups ?? [])[0];
  if (group) return `group:${group}`;
  const priv = (allow.private ?? [])[0];
  if (priv) return `private:${priv}`;
  return '';
}

/** agent 工具的输出契约（照抄 DSH 自带 vision-router 的 stringOutput 写法）。 */
const SAY_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value ?? '') }],
};

// ── 默认声音（面板 ⑥ / CLI / AI 工具共用一份） ────────────────────────────────
//
// 为什么要有这个小文件：TTS 插件的 `speak` 接口**只从请求里的 `custom` 读模型/索引**
// （`rvcConfig(custom)` 的源码如此——存储的那份配置是给它的浏览器面板用的）。
// QQ 侧的调用者（我的工具、命令行、面板）因此必须自己带上 model/index；
// 与其每次手打，不如把「用哪个引擎 + 哪个音色 + 哪些 custom」存在这里，一处改、处处生效。
const VOICE_SETTINGS_FILE = () => path.join(BRIDGE_DIR, 'state', 'qq-voice.json');
/** 允许的引擎（与 dsh-plugin-tts 的 provider id 对齐）。 */
const VOICE_PROVIDERS = ['edge-tts', 'rvc', 'index-tts2', 'cosyvoice'];
/** 需要 custom（模型/参考音频等）的引擎。 */
const PROVIDERS_NEEDING_CUSTOM = ['rvc', 'index-tts2', 'cosyvoice'];

function readVoiceSettings() {
  const file = VOICE_SETTINGS_FILE();
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    const provider = VOICE_PROVIDERS.includes(String(doc.provider)) ? String(doc.provider) : 'edge-tts';
    return {
      ok: true,
      path: file,
      provider,
      voice: String(doc.voice ?? '').trim(),
      custom: doc.custom && typeof doc.custom === 'object' ? doc.custom : {},
    };
  } catch (error) {
    return { ok: false, path: file, provider: 'edge-tts', voice: '', custom: {}, error: String(error?.message ?? error) };
  }
}

function writeVoiceSettings({ provider, voice, custom }) {
  const file = VOICE_SETTINGS_FILE();
  const nextProvider = provider === undefined ? readVoiceSettings().provider : String(provider).trim();
  if (!VOICE_PROVIDERS.includes(nextProvider)) throw new Error(`未知引擎 ${JSON.stringify(nextProvider)}（可选：${VOICE_PROVIDERS.join(' / ')}）`);
  const nextCustom = {};
  if (custom && typeof custom === 'object') {
    for (const [k, value] of Object.entries(custom)) {
      const s = String(value ?? '').trim();
      if (s) nextCustom[k] = s; // 空值即"不设置"，避免把上一版的字段留成空串
    }
  }
  const doc = { provider: nextProvider, voice: String(voice ?? '').trim(), custom: nextCustom, _updatedAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
  return readVoiceSettings();
}

/**
 * 算出本次实际使用的 engine/voice/custom：显式参数优先，其次默认声音文件，最后内置兜底。
 * rvc/index-tts2/cosyvoice 这三类引擎缺 custom 就由插件报"未配置模型/音色"，所以这里只负责把默认值带上。
 */
function resolveVoiceChoice({ provider, voice, custom }) {
  const settings = readVoiceSettings();
  const p = String(provider ?? '').trim() || settings.provider || 'edge-tts';
  const v = String(voice ?? '').trim() || settings.voice || 'zh-CN-XiaoxuanNeural';
  let c = custom;
  if (c === undefined && PROVIDERS_NEEDING_CUSTOM.includes(p)) {
    c = Object.keys(settings.custom ?? {}).length ? settings.custom : undefined;
  }
  return { provider: p, voice: v, custom: c, settings };
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
          toolAllowlist: readToolAllowlist(),
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

      // ── QQ 工具白名单（守卫的扩展项，改文件即生效） ────────────────────────
      if (req.method === 'GET' && route === '/tools') {
        sendJson(res, 200, {
          ok: true,
          allowlist: readToolAllowlist(),
          builtin: { prefixes: BUILTIN_PREFIXES, exact: BUILTIN_EXACT },
          catalog: TOOL_CATALOG,
        });
        return;
      }
      if (req.method === 'POST' && route === '/tools') {
        const body = await readJsonBody(req);
        try {
          const allowlist = writeToolAllowlist({
            allowedExact: body.allowedExact,
            allowedPrefixes: body.allowedPrefixes,
          });
          sendJson(res, 200, {
            ok: true,
            allowlist,
            builtin: { prefixes: BUILTIN_PREFIXES, exact: BUILTIN_EXACT },
            catalog: TOOL_CATALOG,
          });
        } catch (error) {
          sendJson(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
        return;
      }

      // ── TTS → QQ 语音（操作者通道） ────────────────────────────────────────
      if (req.method === 'GET' && route === '/tts-status') {
        const origin = dshOriginOf(req);
        let diagnose = null;
        try {
          const res = await fetch(`${origin}${TTS_DIAGNOSE_PATH}`, { signal: AbortSignal.timeout(20000) });
          diagnose = await res.json().catch(() => null);
        } catch (error) {
          diagnose = { ok: false, error: String(error?.message ?? error) };
        }
        const checks = Array.isArray(diagnose?.checks) ? diagnose.checks : [];
        sendJson(res, 200, {
          ok: true,
          libraryDir: voiceLibraryDir(),
          maxChars: TTS_MAX_CHARS,
          defaultVoice: 'zh-CN-XiaoxuanNeural',
          voices: TTS_VOICES,
          voice: readVoiceSettings(),
          edge: checks.find((c) => c?.id === 'edge') ?? null,
          checks,
        });
        return;
      }

      if (req.method === 'POST' && route === '/say') {
        const body = await readJsonBody(req);
        const result = await performSay({
          origin: dshOriginOf(req),
          key: body.key ?? body.target,
          text: body.text,
          voice: body.voice,
          provider: body.provider,
          custom: body.custom && typeof body.custom === 'object' ? body.custom : undefined,
          prosody: body.prosody && typeof body.prosody === 'object' ? body.prosody : undefined,
          dryRun: body.dryRun === true,
          volume: body.volume,
          normalize: body.normalize === true,
        });
        sendJson(res, result.status, result.body);
        return;
      }

      // ── 默认声音（GET 读 / POST 存） ───────────────────────────────────────
      if (req.method === 'GET' && route === '/voice') {
        // 顺带把 TTS 插件侧的 RVC 配置读出来，面板就能显示"当前用的模型是哪个"
        let rvc = null;
        try {
          const r = await fetch(`${dshOriginOf(req)}/dsh-tts-api/rvc-config`, { signal: AbortSignal.timeout(10000) });
          const j = await r.json().catch(() => null);
          rvc = j?.rvc ?? null;
        } catch { /* 插件没装/没起来时不影响读默认声音 */ }
        sendJson(res, 200, { ok: true, voice: readVoiceSettings(), providers: VOICE_PROVIDERS, rvc });
        return;
      }
      if (req.method === 'POST' && route === '/voice') {
        const body = await readJsonBody(req);
        try {
          const voice = writeVoiceSettings({ provider: body.provider, voice: body.voice, custom: body.custom });
          sendJson(res, 200, { ok: true, voice, providers: VOICE_PROVIDERS });
        } catch (error) {
          sendJson(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
        return;
      }

      // ── 「以语音为主」开关（写桥接 socialV2.voice.preferVoice） ────────────────
      //
      // 这条要求由桥接在**每一回合的提示词**里下发（bridge.js 的 voicePolicyBlock()，挂在 withSlangContext 上），
      // 所以：① 覆盖所有会话与所有唤醒路径；② 改完只需重启桥接（几秒），**不用重启 DSH**。
      // 写回时必须带上 voice 的**全部字段**：/api/socialV2/config 对 voice 是整体替换（浅合并），
      // 只发 {preferVoice: true} 会把 dir / 限流 / enabled 一起抹掉。
      if (req.method === 'GET' && route === '/voice-policy') {
        const r = await callBridge('/api/socialV2/config');
        const voice = r.data?.config?.voice ?? null;
        sendJson(res, 200, {
          ok: true,
          preferVoice: voice ? voice.preferVoice !== false : null, // 缺省即开启
          voice,
        });
        return;
      }
      if (req.method === 'POST' && route === '/voice-policy') {
        const body = await readJsonBody(req);
        const want = body.preferVoice !== false;
        const cur = await callBridge('/api/socialV2/config');
        const voice = cur.data?.config?.voice;
        if (!voice || typeof voice !== 'object') {
          sendJson(res, 502, { ok: false, error: '读不到桥接的 socialV2.voice（桥接没起来？）' });
          return;
        }
        const w = await callBridge('/api/socialV2/config', { method: 'POST', body: { voice: { ...voice, preferVoice: want } } });
        sendJson(res, w.ok ? 200 : (w.status || 502), {
          ok: w.ok === true,
          preferVoice: w.data?.config?.voice?.preferVoice !== false,
          voice: w.data?.config?.voice ?? null,
          ...(w.ok === false && w.data?.error ? { error: String(w.data.error) } : {}),
        });
        return;
      }

      // ── 会话名称（群名 / 好友昵称） ───────────────────────────────────────────────
//
// 面板列表里只有 `group:656528595` 这种数字 ID 是没法用的 —— 得显示"蓝桉（群主的🍔们）"。
// 名字来自 SnowLuma 的 OneBot HTTP 接口（get_group_list / get_friend_list），
// 端口与令牌就写在 SnowLuma 的 onebot_*.json 里（networks.httpServers[0]）。
// 三类降级，保证 SnowLuma 没起时面板也不会变成一片数字：
//   ① 内存缓存（10 分钟）→ ② <bridge>/state/session-names.json → ③ 只显示 ID
const SESSION_NAMES_FILE = path.join(BRIDGE_DIR, 'state', 'session-names.json');
const NAMES_TTL_MS = 10 * 60 * 1000;
let namesCache = null; // { at, groups, friends, stale? }

/** 去掉 QQ 对"不支持的表情"留下的占位（形如 `<$ÿĀB >`），它们会让列表很难看。
 *  注意占位里除了私有区字符还夹着 `$`/`ÿ`/`Ā` 这类普通字符，所以不能只按码位范围删——
 *  要连整个 `<...>` 一起吃掉（第一次就踩了这个：正则只认 PUA，名字里照样带着 `<$ÿĀB >`）。 */
function cleanName(raw) {
  return String(raw ?? '')
    .replace(/<\$[^>]*>/g, '')
    .replace(/<[\uE000-\uF8FF\uFFFD][^>]*>/g, '')
    .replace(/[\uE000-\uF8FF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 旧缓存里存的是原始名字，读出来也要过一遍清洗。 */
function cleanNameMap(o) {
  const out = {};
  for (const [k, v] of Object.entries(o ?? {})) out[k] = cleanName(v);
  return out;
}

/** 找 SnowLuma 的 OneBot 配置（可用 DSH_ONEBOT_CONFIG / DSH_ONEBOT_PORT / DSH_ONEBOT_TOKEN 覆盖）。
 *  2026-10-26：SnowLuma 被搬到 `E:\SnowLuma`（C 盘那份被杀软/清理工具整个删掉过一次），
 *  所以这里**两个位置都找**，免得面板的群名/昵称刷新因为路径写死而失灵。 */
function onebotConfig() {
  const explicit = process.env.DSH_ONEBOT_CONFIG;
  const candidates = explicit ? [explicit] : [];
  for (const dir of ['E:\\SnowLuma\\config', 'C:\\SnowLuma\\config']) {
    try {
      for (const f of fs.readdirSync(dir)) if (/^onebot.*\.json$/i.test(f)) candidates.push(path.join(dir, f));
    } catch { /* 这个位置没有就换下一个 */ }
  }
  for (const f of candidates) {
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      const http = j?.networks?.httpServers?.[0] ?? j;
      const port = Number(process.env.DSH_ONEBOT_PORT ?? http?.port ?? 0);
      const token = String(process.env.DSH_ONEBOT_TOKEN ?? http?.accessToken ?? '');
      if (Number.isFinite(port) && port > 0) return { file: f, port, token };
    } catch { /* 换下一个候选 */ }
  }
  return null;
}

/** 调一次 OneBot 动作（拿不到就返回 null，绝不抛）。 */
async function onebotCall(action, body = {}, timeoutMs = 12000) {
  const c = onebotConfig();
  if (!c) return null;
  try {
    const r = await fetch(`http://127.0.0.1:${c.port}/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(c.token ? { authorization: `Bearer ${c.token}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const j = await r.json().catch(() => ({}));
    return (j?.status === 'ok' || j?.retcode === 0) ? (j.data ?? []) : null;
  } catch {
    return null;
  }
}

/** 取"会话名"表：内存 → 磁盘缓存 → 现场问 OneBot（refresh=true 强制问）。 */
async function sessionNames({ refresh = false } = {}) {
  if (!refresh && namesCache && Date.now() - namesCache.at < NAMES_TTL_MS) return namesCache;
  if (!refresh) {
    try {
      const j = JSON.parse(fs.readFileSync(SESSION_NAMES_FILE, 'utf8'));
      if (j?.groups || j?.friends) {
        namesCache = { at: Date.now(), groups: cleanNameMap(j.groups), friends: cleanNameMap(j.friends) };
        return namesCache;
      }
    } catch { /* 没有缓存就现场问 */ }
  }
  const [groupsRaw, friendsRaw] = await Promise.all([onebotCall('get_group_list'), onebotCall('get_friend_list')]);
  if (groupsRaw || friendsRaw) {
    const groups = {};
    const friends = {};
    for (const g of groupsRaw ?? []) groups[String(g.group_id)] = cleanName(g.group_name);
    for (const f of friendsRaw ?? []) friends[String(f.user_id)] = cleanName(f.remark || f.nickname || '');
    namesCache = { at: Date.now(), groups, friends };
    try {
      fs.mkdirSync(path.dirname(SESSION_NAMES_FILE), { recursive: true });
      fs.writeFileSync(SESSION_NAMES_FILE, JSON.stringify({ at: new Date().toISOString(), groups, friends }, null, 2), 'utf8');
    } catch { /* 写不进缓存不影响本次返回 */ }
    return namesCache;
  }
  try {
    const j = JSON.parse(fs.readFileSync(SESSION_NAMES_FILE, 'utf8'));
    namesCache = { at: Date.now(), groups: cleanNameMap(j.groups), friends: cleanNameMap(j.friends), stale: true };
  } catch {
    namesCache = { at: Date.now(), groups: {}, friends: {}, stale: true };
  }
  return namesCache;
}

      // ── 分会话语音开关（覆盖全局 preferVoice） ─────────────────────────────────
      //
      // 需求（2026-10-25）：语音启停要能"分群、分聊天"。要三层一致才真的有效：
      //   ① 提示词：桥接 voicePolicyBlock(key) 每回合按 key 解析 perSession > 全局（bridge.js）
      //   ② 工具：qq_say_voice 在本会话被判为"文字"时直接拒绝（否则模型能绕过提示词硬发）
      //   ③ 面板：下面两条路由 + ⑥ 卡片那张表
      // 数据落在桥接的 socialV2.voice.perSession[key].preferVoice：
      //   true=语音优先 / false=只用文字 / 缺省=跟随全局。
      // 写回**必须整份 voice 对象**——/api/socialV2/config 对 voice 是整体替换（浅合并会抹掉 dir/限流等）。
      if (req.method === 'GET' && route === '/voice-sessions') {
        const [cfgRes, wlRes] = await Promise.all([callBridge('/api/socialV2/config'), callBridge('/api/whitelist')]);
        const voice = cfgRes.data?.config?.voice ?? {};
        const per = (voice.perSession && typeof voice.perSession === 'object' && !Array.isArray(voice.perSession)) ? voice.perSession : {};
        const wl = wlRes.data ?? {};
        const keys = new Map();
        const groups = wl.allow?.groups ?? wl.groups ?? [];
        const privates = wl.allow?.private ?? wl.private ?? [];
        for (const g of groups) keys.set(`group:${g}`, { key: `group:${g}`, kind: 'group', id: String(g), inWhitelist: true });
        for (const p of privates) keys.set(`private:${p}`, { key: `private:${p}`, kind: 'private', id: String(p), inWhitelist: true });
        // "按聊天记录"：从桥接日志尾部提取出现过的会话 key（越靠后越新）
        const recent = new Map();
        try {
          const lines = fs.readFileSync(path.join(BRIDGE_DIR, 'state', 'bridge.log'), 'utf8').split(/\r?\n/).slice(-500);
          for (const line of lines) {
            const m = /(group|private):(\d+)/.exec(line);
            if (m) recent.set(`${m[1]}:${m[2]}`, line.slice(0, 8));
          }
        } catch { /* 日志读不到就不给"最近"信息 */ }
        for (const [k, t] of recent) {
          if (!keys.has(k)) keys.set(k, { key: k, kind: k.split(':')[0], id: k.split(':')[1], inWhitelist: false, lastSeen: t });
        }
        for (const k of Object.keys(per)) {
          if (!keys.has(k)) keys.set(k, { key: k, kind: k.split(':')[0], id: k.split(':')[1], inWhitelist: false, onlyOverride: true });
        }
        // 会话名（群名 / 好友昵称）：?refresh=1 强制重新问 SnowLuma
        const wantRefresh = /[?&]refresh=1/.test(String(req.url ?? ''));
        const names = await sessionNames({ refresh: wantRefresh });
        const sessions = [...keys.values()].map((s) => {
          const o = per[s.key];
          const mode = (o && typeof o.preferVoice === 'boolean') ? (o.preferVoice ? 'voice' : 'text') : 'inherit';
          const label = (s.kind === 'group' ? names.groups?.[s.id] : names.friends?.[s.id]) || '';
          return { ...s, mode, label: label || null, display: label ? `${label}（${s.key}）` : s.key };
        }).sort((a, b) => String(b.lastSeen ?? '').localeCompare(String(a.lastSeen ?? '')) || a.key.localeCompare(b.key));
        sendJson(res, 200, {
          ok: true,
          global: { preferVoice: voice.preferVoice !== false },
          sessions,
          names: {
            stale: names.stale === true,
            groups: Object.keys(names.groups ?? {}).length,
            friends: Object.keys(names.friends ?? {}).length,
            source: names.stale === true ? '本地缓存（SnowLuma 没答上来）' : 'OneBot get_group_list / get_friend_list',
          },
          note: 'mode：voice=语音优先 / text=只用文字 / inherit=跟随全局；写在桥接 socialV2.voice.perSession。'
            + '?refresh=1 会重新拉一次群名/昵称。',
        });
        return;
      }
      if (req.method === 'POST' && route === '/voice-sessions') {
        const body = await readJsonBody(req);
        const key = String(body.key ?? '').trim();
        if (!/^(group|private):\d+$/.test(key)) {
          sendJson(res, 400, { ok: false, error: 'key 必须是 group:群号 或 private:QQ号' });
          return;
        }
        const mode = String(body.mode ?? '').trim();
        if (!['voice', 'text', 'inherit'].includes(mode)) {
          sendJson(res, 400, { ok: false, error: 'mode 必须是 voice / text / inherit' });
          return;
        }
        const cur = await callBridge('/api/socialV2/config');
        const voice = cur.data?.config?.voice;
        if (!voice || typeof voice !== 'object') {
          sendJson(res, 502, { ok: false, error: '读不到桥接的 socialV2.voice（桥接没起来？）' });
          return;
        }
        const per = { ...((voice.perSession && typeof voice.perSession === 'object' && !Array.isArray(voice.perSession)) ? voice.perSession : {}) };
        if (mode === 'inherit') delete per[key];
        else per[key] = { preferVoice: mode === 'voice' };
        const w = await callBridge('/api/socialV2/config', { method: 'POST', body: { voice: { ...voice, perSession: per } } });
        sendJson(res, w.ok ? 200 : (w.status || 502), {
          ok: w.ok === true,
          key,
          mode,
          perSession: w.data?.config?.voice?.perSession ?? per,
          ...(w.ok === false && w.data?.error ? { error: String(w.data.error) } : {}),
        });
        return;
      }

      // ── 语音发送限制（调试） ───────────────────────────────────────────────
      if (req.method === 'GET' && route === '/voice-limits') {
        const [current, target] = await Promise.all([currentVoiceLimits(), defaultVoiceTarget()]);
        sendJson(res, 200, {
          ok: true,
          limits: current.limits,
          raw: current.raw,
          source: current.source,
          sourceError: current.error,
          rules: VOICE_LIMIT_RULES,
          defaults: VOICE_LIMIT_DEFAULTS,
          quota: voiceSendQuota(),
          library: { dir: voiceLibraryDir(), files: listVoiceLibraryFiles() },
          defaultTarget: target,
          log: tailVoiceLog(20),
        });
        return;
      }

      if (req.method === 'POST' && route === '/voice-limits') {
        const body = await readJsonBody(req);
        const current = await currentVoiceLimits();
        // 整份回写：以「桥接现在生效的那一份」为底，避免只发补丁把 dir/ffmpegPath 抹掉。
        const base = { ...VOICE_LIMIT_DEFAULTS, ...current.raw };
        let next;
        let warnings = [];
        if (body.reset === true) {
          next = { ...VOICE_LIMIT_DEFAULTS, dir: base.dir, ffmpegPath: base.ffmpegPath };
          warnings.push('已恢复默认限制（保留了语音库目录与 ffmpeg 路径）');
        } else {
          const { patch, errors, warnings: warns } = normalizeVoiceLimitPatch(body);
          warnings = warns;
          if (errors.length) { sendJson(res, 400, { ok: false, error: errors.join('；'), errors }); return; }
          if (Object.keys(patch).length === 0) { sendJson(res, 400, { ok: false, error: '没有可写入的限制项' }); return; }
          next = { ...base, ...patch };
        }
        const written = await callBridge('/api/socialV2/config', { method: 'POST', body: { voice: next } });
        if (!written.ok) {
          sendJson(res, written.status || 502, { ok: false, error: written.data?.error ?? `桥接返回 HTTP ${written.status}`, detail: written.data });
          return;
        }
        // 回读一次：桥接会在 voiceCfg() 里再收敛一遍，直接把它算出来的值回给面板更可信。
        const after = await currentVoiceLimits();
        sendJson(res, 200, { ok: true, limits: after.limits, warnings, source: after.source, quota: voiceSendQuota() });
        return;
      }

      /**
       * 预检：不发送，逐条判断「这一条现在会不会被拒」。
       *
       * 分两段，各补对方的短板：
       *   ① 本插件侧（离线）：频率额度。桥接的 dryRun 分支**刻意不查** voiceBudgetCheck
       *      （额度只在真发出去后才记账，见 bridge.js:5590-5602），所以限流只能在发之前靠日志反推。
       *   ② 桥接侧（联网）：dryRun 会走真实的路径解析 + inspectAudio（时长/体积）+ 白名单，
       *      所以「文件太大 / 太长 / 不在库里 / 目标不在白名单」都由桥接给权威结论。
       */
      if (req.method === 'POST' && route === '/voice-check') {
        const body = await readJsonBody(req);
        const text = String(body.text ?? '').trim();
        const file = String(body.file ?? '').trim();
        const current = await currentVoiceLimits();
        const lim = current.limits;
        const quota = voiceSendQuota();
        const checks = [];

        // ① 频率额度（含本次这一条）
        if (lim.maxPerMinute > 0) {
          const would = quota.minute + 1;
          checks.push({
            id: 'quota-minute',
            label: `每分钟额度（${quota.minute} 已用 / 上限 ${lim.maxPerMinute}）`,
            ok: would <= lim.maxPerMinute,
            detail: would <= lim.maxPerMinute ? '这一条还能发' : '会被拒：语音发送频率超限（每分钟）',
          });
        } else {
          checks.push({ id: 'quota-minute', label: '每分钟额度', ok: true, detail: '上限 0 = 不限' });
        }
        if (lim.maxPerHour > 0) {
          const would = quota.hour + 1;
          checks.push({
            id: 'quota-hour',
            label: `每小时额度（${quota.hour} 已用 / 上限 ${lim.maxPerHour}）`,
            ok: would <= lim.maxPerHour,
            detail: would <= lim.maxPerHour ? '这一条还能发' : '会被拒：语音发送频率超限（每小时）',
          });
        } else {
          checks.push({ id: 'quota-hour', label: '每小时额度', ok: true, detail: '上限 0 = 不限' });
        }

        // ② 文本 → 时长估算（TTS 合成前唯一的判断手段）
        if (text) {
          const chars = [...text].length;
          // 中文 TTS 大约 4.5~5.5 字/秒，取 5 字/秒作保守估计（宁可估长一点）。
          const estSeconds = Math.max(1, Math.round(chars / 5));
          checks.push({
            id: 'text-chars',
            label: `文本长度（${chars} 字）`,
            ok: chars <= TTS_MAX_CHARS,
            detail: chars <= TTS_MAX_CHARS
              ? `面板工具的硬上限 ${TTS_MAX_CHARS} 字，通过`
              : `会被面板工具拒掉：文本过长（${chars} > ${TTS_MAX_CHARS} 字）`,
          });
          checks.push({
            id: 'text-duration',
            label: `预计时长（约 ${estSeconds} 秒，按 5 字/秒估）`,
            ok: estSeconds <= lim.maxSeconds,
            detail: estSeconds <= lim.maxSeconds
              ? `低于上限 ${lim.maxSeconds} 秒`
              : `大概率被拒：预计超过 ${lim.maxSeconds} 秒上限（估算是粗的，合成后用「预览」看真实时长）`,
          });
        }

        // ③ 桥接侧 dryRun（真实解析 + 时长/体积 + 白名单）
        let bridgePreview = null;
        if (file) {
          const target = String(body.key ?? '').trim() || (await defaultVoiceTarget());
          if (!target) {
            checks.push({ id: 'bridge-dryrun', label: '桥接预检', ok: false, detail: '白名单里没有任何会话，无法挑一个安全的目标做预检' });
          } else {
            const dry = await callBridge('/api/voice/send', { method: 'POST', body: { target, file, dryRun: true } });
            bridgePreview = dry.data;
            const okDry = dry.ok && dry.data?.ok !== false;
            checks.push({
              id: 'bridge-dryrun',
              label: `桥接预检（目标 ${target}）`,
              ok: okDry,
              detail: okDry
                ? `通过：${dry.data?.detail ?? '已校验'}`
                : `会被拒：${dry.data?.error ?? `HTTP ${dry.status}`}`,
            });
            if (okDry && dry.data?.bytes != null) {
              checks.push({
                id: 'file-bytes',
                label: `文件体积（${Math.round(dry.data.bytes / 1024)} KB）`,
                ok: dry.data.bytes <= lim.maxBytes,
                detail: `上限 ${Math.round(lim.maxBytes / 1024)} KB`,
              });
            }
            if (Array.isArray(dry.data?.warnings) && dry.data.warnings.length) {
              for (const [i, w] of dry.data.warnings.entries()) {
                checks.push({ id: `warn-${i}`, label: '桥接提示', ok: true, detail: String(w) });
              }
            }
          }
        }

        // ④ AI 通道总闸（操作者通道不受它影响，单独说明，避免误判）
        checks.push({
          id: 'ai-gate',
          label: 'AI 通道总闸（socialV2.voice.enabled）',
          ok: true,
          detail: lim.enabled
            ? '已打开：AI 的 qq_send_voice 可以用'
            : '已关闭：AI 发不了语音；但面板/命令行走「操作者通道」，不受这个开关影响',
        });

        const blocking = checks.filter((c) => !c.ok && c.id !== 'ai-gate');
        sendJson(res, 200, {
          ok: true,
          verdict: {
            operatorCanSend: blocking.length === 0,
            aiCanSend: lim.enabled && blocking.length === 0,
            blockedBy: blocking.map((c) => c.id),
          },
          checks,
          limits: lim,
          quota,
          bridgePreview,
          source: current.source,
        });
        return;
      }

      // ── 写：白名单 ────────────────────────────────────────────────────────
      // ── 白名单候选项（按钮开关用）：所有群/联系人 + 名字 + 当前是否放行 ──────────
      //
      // 需求（2026-10-25）：白名单别再让人手打群号/QQ 号，改成"带名字的按钮开关"。
      // 名字复用 sessionNames()（OneBot get_group_list / get_friend_list + 缓存），
      // 并把「已在白名单里的」「在黑名单里的」以及「列表里查不到名字的历史条目」一并带上，
      // 免得出现"开关里看不到、但配置里还生效"的幽灵条目。
      if (req.method === 'GET' && route === '/whitelist-candidates') {
        const [names, wlRes] = await Promise.all([
          sessionNames({ refresh: /[?&]refresh=1/.test(String(req.url ?? '')) }),
          callBridge('/api/whitelist'),
        ]);
        const wl = wlRes.data ?? {};
        const allowG = new Set((wl.allow?.groups ?? []).map(String));
        const allowP = new Set((wl.allow?.private ?? []).map(String));
        const denyG = new Set((wl.deny?.groups ?? []).map(String));
        const row = (kind, id, name, extra = {}) => ({
          kind,
          id: String(id),
          key: `${kind}:${id}`,
          name: name || null,
          display: name ? `${name}（${id}）` : String(id),
          known: Boolean(name),
          allowed: (kind === 'group' ? allowG : allowP).has(String(id)),
          denied: kind === 'group' ? denyG.has(String(id)) : false,
          ...extra,
        });
        const groups = new Map();
        for (const [id, name] of Object.entries(names.groups ?? {})) groups.set(String(id), row('group', id, name));
        for (const id of [...allowG, ...denyG]) if (!groups.has(id)) groups.set(id, row('group', id, null, { orphan: true }));
        const friends = new Map();
        for (const [id, name] of Object.entries(names.friends ?? {})) friends.set(String(id), row('private', id, name));
        for (const id of allowP) if (!friends.has(id)) friends.set(id, row('private', id, null, { orphan: true }));
        const sortRows = (a, b) => Number(b.allowed) - Number(a.allowed)
          || Number(b.denied) - Number(a.denied)
          || String(a.name ?? a.id).localeCompare(String(b.name ?? b.id), 'zh');
        sendJson(res, 200, {
          ok: true,
          groups: [...groups.values()].sort(sortRows),
          friends: [...friends.values()].sort(sortRows),
          ownerQQ: wl.ownerQQ ?? null,
          names: {
            stale: names.stale === true,
            groups: Object.keys(names.groups ?? {}).length,
            friends: Object.keys(names.friends ?? {}).length,
            source: names.stale === true ? '本地缓存（SnowLuma 没答上来）' : 'OneBot get_group_list / get_friend_list',
          },
          note: '点按钮改的是桥接的 allow.groups / allow.private / deny.groups（整份回写白名单）；'
            + 'orphan=true 表示这个 ID 当前不在 OneBot 的群/好友列表里（可能已退群/删好友），但配置里仍然有效。',
        });
        return;
      }

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

      // ── 整套 QQ 栈的启停（桥接 + SnowLuma + 语音服务 + 自启 + DSH 的 MCP 注册） ──
      // 实现在桥接目录的 stop/start-qq-stack.ps1（唯一来源）；这里只包一层并把输出回给面板。
      if (req.method === 'GET' && route === '/stack-status') {
        sendJson(res, 200, stackStatus());
        return;
      }
      if (req.method === 'POST' && route === '/stack-stop') {
        const body = await readJsonBody(req);
        const r = runStackScript('stop', { dryRun: body.dryRun === true });
        sendJson(res, r.ok ? 200 : 502, r);
        return;
      }
      if (req.method === 'POST' && route === '/stack-start') {
        const body = await readJsonBody(req);
        const r = runStackScript('start', {
          withVoice: body.withVoice === true,
          voice: ['both', 'rvc', 'cosy'].includes(body.voice) ? body.voice : 'both',
          dryRun: body.dryRun === true,
        });
        sendJson(res, r.ok ? 200 : 502, r);
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

  // ── agent 工具：让 QQ 里的 AI 能主动「开口说话」 ─────────────────────────────
  //
  // 为什么必须是工具而不是只留 HTTP 路由：QQ 会话里的 agent 没有浏览器，它只能通过
  // 工具调用触达宿主。工具名 `qq_say_voice` 不在守卫（qq-tool-restrict）的硬编码白名单里，
  // 需要在 state/tool-allowlist.json 的 allowedExact 里显式放行——正是面板第 ⑤ 组管的那份文件。
  try {
    if (!ctx.tools || typeof ctx.tools.register !== 'function') throw new Error('宿主没有 tools 服务');
    const disposeTool = ctx.tools.register({
      name: 'qq_say_voice',
      description:
        '在 QQ 里「开口说话」：把 text 用 TTS 合成语音，作为 QQ 语音条发到 key 指定的会话。'
        + '**本会话的默认发言方式是「以语音为主、文字为辅」：能用语音说的就用语音说**，'
        + '不要只用文字工具发消息。语音内容要短、要口语化（一次 1~2 句、建议 10~40 字），像真人开口说话。'
        + '这些情况仍用文字：内容很长或需要精确转达（数字/路径/链接/代码/清单/需要反复查看的信息）、'
        + '语音合成失败、或对方明确要求打字。'
        + 'key 用当前会话的键（group:群号 / private:QQ号），从你的上下文里取，不要猜。'
        + '限制：text ≤200 字；受桥接限流（每分钟/每小时有上限），超限会被拒。'
        + '总开关是桥接的 socialV2.voice.enabled，关掉时本工具一律拒绝（面板第 ⑥ 组可切换）。'
        + '返回里 verified=true 才代表语音真的落地（桥接回读了 get_msg 的 record 段）；只有这时才能对群友说「我发了条语音」。',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: '会话键：group:群号 或 private:QQ号（就是当前这个会话）' },
          text: { type: 'string', description: '要说的话：中文短句，建议 ≤60 字，最多 200 字' },
          voice: { type: 'string', description: '音色，默认 zh-CN-XiaoxuanNeural（Edge TTS）；配了自定义音色后填其名称' },
          provider: { type: 'string', description: 'TTS 引擎：edge-tts（默认）/ rvc / index-tts2 / cosyvoice' },
        },
        required: ['key', 'text'],
        additionalProperties: false,
      },
      output: SAY_OUTPUT,
      async execute(args) {
        if (!aiVoiceEnabled()) {
          return '语音发送被关闭（桥接 socialV2.voice.enabled=false）。这是「AI 能不能发语音」的总开关，'
            + '可在 dsh-qq-console 面板第 ⑥ 组或桥接控制台打开；打开前请不要对群友说你要发语音。';
        }
        // 分会话门禁（2026-10-25）：桥接会在每回合提示词里告诉模型本会话该用语音还是文字，
        // 但提示词是可以被绕过的——所以这里再挡一道：本会话被判"文字"就直接不发。
        // 读不到配置时**放行**（不能因为读配置失败就把语音全禁掉）。
        const gateKey = String(args?.key ?? '').trim();
        if (/^(group|private):\d+$/.test(gateKey)) {
          try {
            const cur = await callBridge('/api/socialV2/config');
            const voice = cur.data?.config?.voice ?? {};
            const per = (voice.perSession && typeof voice.perSession === 'object' && !Array.isArray(voice.perSession)) ? voice.perSession : {};
            const o = per[gateKey];
            const effective = (o && typeof o.preferVoice === 'boolean') ? o.preferVoice : (voice.preferVoice !== false);
            if (!effective) {
              return `没有发语音：本会话（${gateKey}）被设置为「只用文字」（面板 ⑥ 的「分会话语音开关」/ 桥接 socialV2.voice.perSession）。`
                + '请直接用 qq_send_message 或 qq_reply 发文字。若对方明确要求你发语音，可以把这情况告诉对方，'
                + '由操作者在面板里把该会话改回「语音」或「跟随全局」。';
            }
          } catch { /* 读不到就按允许走 */ }
        }
        const result = await performSay({
          origin: dshBaseFromConfig(),
          key: args?.key,
          text: args?.text,
          voice: args?.voice,
          provider: args?.provider,
        });
        const b = result.body ?? {};
        if (!b.ok) return `发语音失败：${b.error ?? `HTTP ${result.status}`}`;
        const sent = b.bridge ?? {};
        const warn = Array.isArray(sent.warnings) && sent.warnings.length ? `；提示：${sent.warnings.join('；')}` : '';
        return `已发出语音 ${b.tts?.file ?? '(未知)'}（${Math.round((b.tts?.bytes ?? 0) / 1024)} KB，`
          + `${b.tts?.chars ?? '?'} 字，引擎 ${b.tts?.provider ?? '?'}）｜messageId=${sent.messageId ?? '?'}`
          + `｜verified=${sent.verified === true}${sent.detail ? `｜${sent.detail}` : ''}${warn}`;
      },
    });
    ctx.effect(() => () => { try { disposeTool(); } catch {} }, 'dsh-qq-console: qq_say_voice');
    log('已注册 agent 工具 qq_say_voice（要在 QQ 会话里可用，还需在 tool-allowlist.json 放行它）');
  } catch (error) {
    log('注册 qq_say_voice 失败（HTTP 路由不受影响）：', error?.message ?? error);
  }

  log(`已挂载 ${ROUTE_PREFIX}/*（桥接 ${BRIDGE_BASE}，任务 ${BRIDGE_TASK}）`);
}