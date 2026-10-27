#!/usr/bin/env node
/**
 * 命令行版「语音发送限制调试」—— 与面板第 ⑦ 张卡片同一套判据，但不依赖 DSH。
 *
 * 为什么要有它：宿主半的路由改动**必须重启 DSH** 才生效（见 README「改动后的生效范围」），
 * 而改限制/查额度这件事恰恰是「现在就想知道」的。这个脚本直接跟桥接控制台 API 说话，
 * 改完即生效、不用重启任何东西。
 *
 * 用法：
 *   node tools/voice-limits.mjs                       # 看当前限制 + 实际用量 + 语音库
 *   node tools/voice-limits.mjs --check               # 预检：按当前限制判「现在还能不能发」
 *   node tools/voice-limits.mjs --check --text="晚上好" --file=tts-xxx.mp3
 *   node tools/voice-limits.mjs --set maxPerMinute=5 --set maxSeconds=120
 *   node tools/voice-limits.mjs --reset               # 恢复默认（保留 dir / ffmpegPath）
 *
 * 退出码：0 = 正常/预检通过；1 = 预检会被拒；2 = 参数或环境错误。
 */
import fs from 'node:fs';
import path from 'node:path';

const BRIDGE = process.env.DSH_QQ_BRIDGE_DIR || 'C:\\Users\\faith\\qq-bridge';
const BRIDGE_API = String(process.env.DSH_QQ_BRIDGE_API || 'http://127.0.0.1:3100').replace(/\/+$/, '');
/** 与面板工具一致的文本硬上限（面板的 /say 在 TTS 之前就拒掉更长的）。 */
const TTS_MAX_CHARS = 200;
/** 与桥接 voiceCfg() 同一套默认值（桥接没写这些键时用它兜底）。 */
const DEFAULTS = {
  enabled: false, dir: 'audio', maxSeconds: 300, maxBytes: 20 * 1024 * 1024,
  maxPerMinute: 2, maxPerHour: 10, allowAbsolutePath: false,
  defaultVolume: 1, loudness: 'normal', ffmpegPath: '', autoReadback: true,
};

// ── 参数 ────────────────────────────────────────────────────────────────────
// 注意 `--set maxPerMinute=1` 的写法：shell（PowerShell / cmd）会把 `--set` 与
// `maxPerMinute=1` 拆成两个 argv，所以必须**看下一个 token**，不能只靠 `--k=v` 正则。
const argv = process.argv.slice(2);
const flags = new Map();
const sets = [];
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  if (!m) continue;
  const key = m[1];
  if (key === 'set') {
    // 支持 `--set k=v`、`--set=k=v`、`--set k=v --set k2=v2`
    const inline = m[2];
    const value = inline !== undefined && inline !== '' ? inline : argv[++i];
    if (value === undefined || value === '') {
      console.error('--set 后面要跟 key=value，例如 --set maxPerMinute=5');
      process.exit(2);
    }
    sets.push(value);
    continue;
  }
  flags.set(key, m[2] === undefined || m[2] === '' ? 'true' : m[2]);
}
const wantCheck = flags.has('check');
const wantReset = flags.has('reset');
const text = String(flags.get('text') ?? '');
const file = String(flags.get('file') ?? '');

// ── 工具 ────────────────────────────────────────────────────────────────────
function readToken() {
  try {
    const t = fs.readFileSync(path.join(BRIDGE, 'state', 'console-token'), 'utf8').trim();
    if (!t) throw new Error('令牌是空的');
    return t;
  } catch (error) {
    console.error(`读不到桥接控制台令牌（${path.join(BRIDGE, 'state', 'console-token')}）：${error.message}`);
    process.exit(2);
  }
}
const TOKEN = readToken();

async function api(pathname, { method = 'GET', body } = {}) {
  const res = await fetch(`${BRIDGE_API}${pathname}`, {
    method,
    headers: {
      'x-console-token': TOKEN,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

/** 桥接 voiceCfg() 的同一套收敛：读不到/写坏了都给安全值，绝不打印 NaN。 */
function normalize(src) {
  const v = { ...DEFAULTS, ...(src && typeof src === 'object' ? src : {}) };
  const int = (x, min, max, fb) => {
    const n = Number(x);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fb;
  };
  const num = (x, min, max, fb) => {
    const n = Number(x);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fb;
  };
  return {
    enabled: v.enabled === true,
    dir: String(v.dir ?? 'audio').trim() || 'audio',
    maxSeconds: int(v.maxSeconds, 1, 3600, 300),
    maxBytes: int(v.maxBytes, 64 * 1024, 100 * 1024 * 1024, 20 * 1024 * 1024),
    maxPerMinute: int(v.maxPerMinute, 0, 120, 2),
    maxPerHour: int(v.maxPerHour, 0, 2000, 10),
    allowAbsolutePath: v.allowAbsolutePath === true,
    defaultVolume: num(v.defaultVolume, 0.1, 4, 1),
    loudness: ['quiet', 'normal', 'loud'].includes(String(v.loudness)) ? String(v.loudness) : 'normal',
    ffmpegPath: String(v.ffmpegPath ?? ''),
    autoReadback: v.autoReadback !== false,
  };
}

function voiceDirOf(raw) {
  const d = String(raw?.dir ?? 'audio').trim() || 'audio';
  return path.isAbsolute(d) ? d : path.join(BRIDGE, d);
}

/** 语音库清单（两层目录）。 */
function listLibrary(dir) {
  const out = [];
  const walk = (base, depth) => {
    let entries;
    try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(base, e.name);
      if (e.isDirectory()) { if (depth > 0) walk(full, depth - 1); continue; }
      if (!/\.(mp3|wav|m4a|ogg|opus|silk|amr|flac|aac|wma)$/i.test(e.name)) continue;
      let st = null;
      try { st = fs.statSync(full); } catch {}
      out.push({ name: path.relative(dir, full).split(path.sep).join('/'), bytes: st?.size ?? 0, mtimeMs: st?.mtimeMs ?? 0 });
    }
  };
  walk(dir, 1);
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * 从 bridge.log 反推最近 1 分钟 / 1 小时发了几条。
 * 近似值：桥接的计数在内存里（重启清零），日志行只有时分秒（跨零点按「比现在还晚 ⇒ 昨天」纠正）。
 */
function quotaFromLog() {
  const lines = [];
  for (const name of ['bridge.log.1', 'bridge.log']) {
    try { lines.push(...fs.readFileSync(path.join(BRIDGE, 'state', name), 'utf8').split(/\r?\n/).filter(Boolean)); } catch {}
  }
  const now = new Date();
  const nowSec = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
  const sends = [];
  for (const line of lines) {
    const m = /^(\d{2}):(\d{2}):(\d{2}) \[bridge\] \[voice\] (.*)$/.exec(line);
    if (!m || !m[4].includes('已发送语音')) continue;
    let delta = nowSec - (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]));
    if (delta < -5) delta += 86400;
    if (delta < 0 || delta > 86400) continue;
    sends.push({ ageSec: delta, operator: m[4].includes('(操作者)'), clock: line.slice(0, 8) });
  }
  const minute = sends.filter((s) => s.ageSec < 60);
  const hour = sends.filter((s) => s.ageSec < 3600);
  return {
    minute: minute.length,
    hour: hour.length,
    operatorMinute: minute.filter((s) => s.operator).length,
    operatorHour: hour.filter((s) => s.operator).length,
    aiMinute: minute.filter((s) => !s.operator).length,
    aiHour: hour.filter((s) => !s.operator).length,
    lastAt: sends.length ? sends.reduce((a, b) => (a.ageSec <= b.ageSec ? a : b)).clock : null,
    lastAgeSec: sends.length ? Math.min(...sends.map((s) => s.ageSec)) : null,
  };
}

const kb = (n) => `${Math.round(n / 1024)} KB`;
const mb = (n) => `${Math.round((n / 1024 / 1024) * 10) / 10} MB`;

// ── 主流程 ──────────────────────────────────────────────────────────────────
const cfg = await api('/api/socialV2/config');
if (!cfg.ok) {
  console.error(`桥接不可用（${BRIDGE_API}）：HTTP ${cfg.status} ${cfg.data?.error ?? ''}`);
  console.error('先启动桥接（面板第 ① 组 / schtasks / start-qqbridge.bat）再试。');
  process.exit(2);
}
const rawVoice = cfg.data?.config?.voice ?? {};
const limits = normalize(rawVoice);
const dir = voiceDirOf(rawVoice);
const library = listLibrary(dir);
const quota = quotaFromLog();

// --reset / --set：整份回写（桥接对 voice 是整体替换，只发补丁会抹掉 dir/ffmpegPath）
if (wantReset || sets.length) {
  let next;
  if (wantReset) {
    next = { ...DEFAULTS, dir: limits.dir, ffmpegPath: limits.ffmpegPath };
    console.log('恢复默认限制（保留 dir / ffmpegPath）');
  } else {
    next = { ...DEFAULTS, ...rawVoice };
    for (const pair of sets) {
      const eq = pair.indexOf('=');
      if (eq < 0) { console.error(`--set 要写成 key=value，收到「${pair}」`); process.exit(2); }
      const key = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (!Object.hasOwn(DEFAULTS, key)) {
        console.error(`未知键「${key}」。可用：${Object.keys(DEFAULTS).join(' / ')}`);
        process.exit(2);
      }
      if (typeof DEFAULTS[key] === 'boolean') next[key] = value === 'true' || value === '1';
      else if (key === 'loudness') {
        if (!['quiet', 'normal', 'loud'].includes(value)) { console.error('loudness 只能是 quiet / normal / loud'); process.exit(2); }
        next[key] = value;
      } else if (key === 'dir' || key === 'ffmpegPath') next[key] = value;
      else {
        const n = Number(value);
        if (!Number.isFinite(n)) { console.error(`${key} 必须是数字，收到「${value}」`); process.exit(2); }
        next[key] = n;
      }
    }
  }
  const written = await api('/api/socialV2/config', { method: 'POST', body: { voice: next } });
  if (!written.ok) {
    console.error(`写入失败：HTTP ${written.status} ${written.data?.error ?? ''}`);
    process.exit(2);
  }
  const after = normalize(written.data?.config?.voice ?? {});
  console.log('已写入，桥接生效值：');
  console.log(JSON.stringify(after, null, 2));
  console.log('\n（桥接热更新，立即生效；不用重启任何东西）');
  process.exit(0);
}

// ── 展示 ────────────────────────────────────────────────────────────────────
console.log(`桥接 ${BRIDGE_API}　语音库 ${dir}（${library.length} 个文件）`);
console.log('');
console.log('当前限制：');
const rows = [
  ['AI 能发语音（总闸）', limits.enabled ? '开' : '关（AI 发不了；操作者通道不受影响）'],
  ['单条时长上限', `${limits.maxSeconds} 秒`],
  ['单条体积上限', mb(limits.maxBytes)],
  ['每分钟上限', limits.maxPerMinute === 0 ? '不限（0）' : `${limits.maxPerMinute} 条`],
  ['每小时上限', limits.maxPerHour === 0 ? '不限（0）' : `${limits.maxPerHour} 条`],
  ['默认音量', `${limits.defaultVolume} 倍`],
  ['智能音量档位', limits.loudness],
  ['发送后自动回读', limits.autoReadback ? '开' : '关'],
  ['允许绝对路径', limits.allowAbsolutePath ? '开（AI 通道已不再放宽）' : '关'],
  ['ffmpeg', limits.ffmpegPath || '(走 PATH / FFMPEG_PATH)'],
];
for (const [k, v] of rows) console.log(`  ${k.padEnd(16, ' ')} ${v}`);

console.log('');
console.log('实际用量（从 bridge.log 反推的近似值）：');
console.log(`  1 分钟 ${quota.minute} 条（AI ${quota.aiMinute} / 操作者 ${quota.operatorMinute}）`
  + `　1 小时 ${quota.hour} 条（AI ${quota.aiHour} / 操作者 ${quota.operatorHour}）`);
console.log(`  最后一次 ${quota.lastAt ?? '无记录'}${quota.lastAgeSec != null ? `（${quota.lastAgeSec}s 前）` : ''}`);
console.log('  ⚠️ 桥接的限流计数在内存里，重启即清零；日志行只有时分秒，跨零点靠时间戳纠正。');

if (library.length) {
  console.log('');
  console.log('语音库（最新 8 个）：');
  for (const f of library.slice(0, 8)) {
    const over = f.bytes > limits.maxBytes ? ' ❌ 超体积上限' : '';
    console.log(`  ${f.name}　${kb(f.bytes)}${over}`);
  }
}

// ── 预检 ────────────────────────────────────────────────────────────────────
if (wantCheck) {
  console.log('');
  console.log('预检：');
  const checks = [];
  const push = (id, label, ok, detail) => checks.push({ id, label, ok, detail });

  if (limits.maxPerMinute > 0) {
    push('quota-minute', `每分钟额度（${quota.minute} 已用 / 上限 ${limits.maxPerMinute}）`,
      quota.minute + 1 <= limits.maxPerMinute,
      quota.minute + 1 <= limits.maxPerMinute ? '这一条还能发' : '会被拒：语音发送频率超限（每分钟）');
  } else push('quota-minute', '每分钟额度', true, '上限 0 = 不限');

  if (limits.maxPerHour > 0) {
    push('quota-hour', `每小时额度（${quota.hour} 已用 / 上限 ${limits.maxPerHour}）`,
      quota.hour + 1 <= limits.maxPerHour,
      quota.hour + 1 <= limits.maxPerHour ? '这一条还能发' : '会被拒：语音发送频率超限（每小时）');
  } else push('quota-hour', '每小时额度', true, '上限 0 = 不限');

  if (text) {
    const chars = [...text].length;
    const est = Math.max(1, Math.round(chars / 5)); // 中文 TTS 约 5 字/秒，保守估长
    push('text-chars', `文本长度（${chars} 字）`, chars <= TTS_MAX_CHARS,
      chars <= TTS_MAX_CHARS ? `面板工具硬上限 ${TTS_MAX_CHARS} 字，通过` : `会被面板工具拒掉：文本过长（${chars} > ${TTS_MAX_CHARS}）`);
    push('text-duration', `预计时长（约 ${est} 秒，按 5 字/秒估）`, est <= limits.maxSeconds,
      est <= limits.maxSeconds ? `低于上限 ${limits.maxSeconds} 秒` : `大概率被拒：预计超过 ${limits.maxSeconds} 秒上限`);
  }

  let target = String(flags.get('key') ?? '').trim();
  if (file) {
    if (!target) {
      const wl = await api('/api/whitelist');
      const allow = wl.ok ? (wl.data?.allow ?? {}) : {};
      const g = (allow.groups ?? [])[0];
      const p = (allow.private ?? [])[0];
      target = g ? `group:${g}` : (p ? `private:${p}` : '');
    }
    if (!target) {
      push('bridge-dryrun', '桥接预检', false, '白名单里没有任何会话，无法挑安全目标做预检');
    } else {
      const dry = await api('/api/voice/send', { method: 'POST', body: { target, file, dryRun: true } });
      const okDry = dry.ok && dry.data?.ok !== false;
      push('bridge-dryrun', `桥接预检（目标 ${target}）`, okDry,
        okDry ? `通过：${dry.data?.detail ?? '已校验'}` : `会被拒：${dry.data?.error ?? `HTTP ${dry.status}`}`);
      if (okDry && dry.data?.bytes != null) {
        push('file-bytes', `文件体积（${kb(dry.data.bytes)}）`, dry.data.bytes <= limits.maxBytes, `上限 ${mb(limits.maxBytes)}`);
      }
      for (const [i, w] of (dry.data?.warnings ?? []).entries()) push(`warn-${i}`, '桥接提示', true, String(w));
    }
  }

  push('ai-gate', 'AI 通道总闸', true, limits.enabled ? '已打开：AI 的 qq_send_voice 可以用'
    : '已关闭：AI 发不了语音；但操作者通道（面板/命令行）不受影响');

  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.label} —— ${c.detail}`);
  const blocking = checks.filter((c) => !c.ok && c.id !== 'ai-gate');
  console.log('');
  if (blocking.length) {
    console.log(`结论：现在发会被拒（${blocking.map((c) => c.id).join('、')}）`);
    process.exit(1);
  }
  console.log(`结论：操作者通道可以发${limits.enabled ? '；AI 通道也可以' : '；AI 通道被总闸关着'}`);
}

process.exit(0);
