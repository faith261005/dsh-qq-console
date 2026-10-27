#!/usr/bin/env node
/**
 * 命令行发 QQ 语音：文本 → TTS 合成 → 落进桥接语音库 → 桥接「操作者通道」发成语音条。
 *
 * 与 dsh-qq-console 面板第 ⑥ 张卡片走的是**同一套调用**（同一组端点、同样的顺序），
 * 区别只是这个脚本不依赖浏览器、也不需要重启 DSH——宿主半还没加载新路由时用它就能发。
 *
 * 用法：
 *   node tools/say-voice.mjs private:1104286533 "晚上好，我发条语音试试"
 *   node tools/say-voice.mjs group:706109857 "在的" zh-CN-YunxiNeural
 *   node tools/say-voice.mjs private:1104286533 "只在语音库里生成，不发送" --dry
 *   可选：--dsh=http://127.0.0.1:<端口>   （默认从桥接 config.json 的 dsh.baseUrl 读）
 *
 * 前置：① DSH 装了 dsh-plugin-tts（提供 /dsh-tts-api/speak，Edge TTS 免 key）；
 *      ② 桥接在跑、目标会话在它的白名单里；
 *      ③ 音色名以微软 Edge TTS 为准，默认 zh-CN-XiaoxuanNeural。
 * 注意：本脚本走**操作者通道**，不检查 socialV2.voice.enabled（那个开关只管 AI 自己发）。
 */
import fs from 'node:fs';
import path from 'node:path';

const BRIDGE = process.env.DSH_QQ_BRIDGE_DIR || 'C:\\Users\\faith\\qq-bridge';
const bridgeConfigPath = path.join(BRIDGE, 'config.json');

function readBridgeConfig() {
  try { return JSON.parse(fs.readFileSync(bridgeConfigPath, 'utf8')); } catch { return {}; }
}

const argv = process.argv.slice(2);
const flags = new Map();
const positional = [];
for (const a of argv) {
  const m = /^--([^=]+)=?(.*)$/.exec(a);
  if (m) flags.set(m[1], m[2] === '' ? 'true' : m[2]);
  else positional.push(a);
}

const cfg = readBridgeConfig();
const DSH = String(flags.get('dsh') || cfg?.dsh?.baseUrl || 'http://127.0.0.1:3080').replace(/\/+$/, '');
const BRIDGE_API = String(process.env.DSH_QQ_BRIDGE_API || 'http://127.0.0.1:3100').replace(/\/+$/, '');
const target = positional[0];
const text = positional[1];
/** 默认声音（面板 ⑥ 保存的那份）：provider / voice / custom 从 state/qq-voice.json 读。 */
const voiceSettings = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(BRIDGE, 'state', 'qq-voice.json'), 'utf8')); } catch { return {}; }
})();
const provider = String(flags.get('provider') || voiceSettings.provider || 'edge-tts');
const voice = positional[2] || String(voiceSettings.voice || '') || 'zh-CN-XiaoxuanNeural';
/** 需要 custom 的引擎（rvc / index-tts2 / cosyvoice）带上默认声音里的模型/参考音频。 */
const custom = ['rvc', 'index-tts2', 'cosyvoice'].includes(provider) && voiceSettings.custom ? voiceSettings.custom : undefined;
const dryRun = flags.has('dry');

if (!target || !text) {
  console.error('用法：node tools/say-voice.mjs <group:群号|private:QQ号> "<要说的话>" [音色] [--provider=rvc] [--dry] [--dsh=http://127.0.0.1:端口]');
  process.exit(2);
}
if (!/^(group|private):[1-9]\d*$/.test(target)) {
  console.error(`目标格式应为 group:群号 或 private:QQ号，收到：${target}`);
  process.exit(2);
}

let token;
try { token = fs.readFileSync(path.join(BRIDGE, 'state', 'console-token'), 'utf8').trim(); }
catch (error) { console.error(`读不到桥接控制台令牌：${error.message}`); process.exit(2); }
if (!token) { console.error('桥接控制台令牌是空的'); process.exit(2); }

/** 语音库目录（相对桥接根目录；读不出来退回 audio/）。 */
function voiceDir() {
  const d = String(cfg?.socialV2?.voice?.dir ?? 'audio').trim() || 'audio';
  return path.isAbsolute(d) ? d : path.join(BRIDGE, d);
}

console.log(`DSH=${DSH} | 桥接=${BRIDGE_API} | 目标=${target} | 音色=${voice}${dryRun ? ' | 预检模式' : ''}`);
console.log(`文本（${text.length} 字）：${text}`);

// ① 合成（本地克隆引擎冷启动可达数十秒：原来写 45 秒会误杀，改成 240 秒）
const t0 = Date.now();
const TTS_TIMEOUT_MS = Number(process.env.DSH_QQ_TTS_TIMEOUT_MS ?? '') || 240000;
let speakRes;
try {
  speakRes = await fetch(`${DSH}/dsh-tts-api/speak`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, voice, provider, ...(custom === undefined ? {} : { custom }) }),
    signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
  });
} catch (error) {
  console.error(`调用 TTS 失败（DSH 在 ${DSH} 吗？装了 dsh-plugin-tts 吗？）：${error?.message ?? error}`);
  process.exit(1);
}
const speakJson = await speakRes.json().catch(() => ({}));
console.log(`① speak → HTTP ${speakRes.status} ${JSON.stringify(speakJson).slice(0, 120)}（${Date.now() - t0}ms）`);
if (!speakJson.url) { console.error('TTS 没有返回音频地址，终止'); process.exit(1); }

// ② 取音频
const audioRes = await fetch(`${DSH}${speakJson.url}`, { signal: AbortSignal.timeout(45000) });
const buf = Buffer.from(await audioRes.arrayBuffer());
console.log(`② 取音频 → HTTP ${audioRes.status} | ${buf.length} 字节 | ${audioRes.headers.get('content-type')}`);
if (!buf.length) { console.error('音频为空，终止'); process.exit(1); }

// ③ 落进语音库（扩展名按实际容器定：Edge 出 mp3，RVC/本地引擎出 wav）
const dir = voiceDir();
fs.mkdirSync(dir, { recursive: true });
const ext = String(audioRes.headers.get('content-type') ?? '').includes('wav') ? 'wav' : 'mp3';
const file = `tts-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 6)}.${ext}`;
fs.writeFileSync(path.join(dir, file), buf);
console.log(`③ 落盘 → ${path.join(dir, file)}`);

// ④ 桥接操作者通道
const sendRes = await fetch(`${BRIDGE_API}/api/voice/send`, {
  method: 'POST',
  headers: { 'x-console-token': token, 'content-type': 'application/json' },
  body: JSON.stringify({ target, file, ...(dryRun ? { dryRun: true } : {}) }),
  signal: AbortSignal.timeout(60000),
});
const sendJson = await sendRes.json().catch(() => ({}));
console.log(`④ 桥接 voice/send → HTTP ${sendRes.status}`);
console.log(JSON.stringify(sendJson, null, 1));

const ok = sendRes.ok && sendJson?.ok !== false;
if (dryRun) console.log(ok ? '\n✅ 预检通过（没有真的发出去）' : '\n❌ 预检失败');
else console.log(ok ? `\n✅ 已发出${sendJson.verified === true ? '（桥接回读到 record 段，确认落地）' : ''}` : '\n❌ 发送失败');
process.exit(ok ? 0 : 1);