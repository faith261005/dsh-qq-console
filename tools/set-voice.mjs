#!/usr/bin/env node
/**
 * 切换 QQ 语音的「默认声音」——写 <qq-bridge>/state/qq-voice.json，一处改、处处生效。
 *
 * 为什么需要它：dsh-plugin-tts 的 `speak` 接口只从请求里的 `custom` 读模型/参考音频
 * （rvcConfig/cosyConfig 的源码如此），所以 QQ 侧的调用方必须自己带上这些；
 * 与其每次手打，不如存成"默认声音"。
 *
 * 用法（--k=v 与 --k v 都支持）：
 *   node tools/set-voice.mjs                        # 看当前默认声音
 *   node tools/set-voice.mjs edge-tts zh-CN-YunxiNeural
 *   node tools/set-voice.mjs rvc
 *   node tools/set-voice.mjs rvc --model E:\path\x.pth --index E:\path\x.index
 *   node tools/set-voice.mjs cosyvoice --prompt zero_shot_prompt.wav --prompt-text "<它的文字稿>"
 *   node tools/set-voice.mjs cosyvoice --prompt mine.wav --prompt-text "你好呀。" --base-url http://127.0.0.1:7890
 */
import fs from 'node:fs';
import path from 'node:path';

const BRIDGE = process.env.DSH_QQ_BRIDGE_DIR || 'C:\\Users\\faith\\qq-bridge';
const FILE = path.join(BRIDGE, 'state', 'qq-voice.json');
const PROVIDERS = ['edge-tts', 'rvc', 'index-tts2', 'cosyvoice'];
/** 各本地引擎的固定默认服务地址（**不从上一个引擎继承**，否则会把地址串错）。 */
const DEFAULT_BASE = {
  rvc: 'http://127.0.0.1:4892',
  'index-tts2': 'http://127.0.0.1:7880',
  cosyvoice: 'http://127.0.0.1:7890',
};

const argv = process.argv.slice(2);
const flags = new Map();
const positional = [];
// 同时支持 `--k=v` 与 `--k v`（后者把紧随其后的非 -- 参数当值）
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith('--')) { positional.push(a); continue; }
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  const key = m[1];
  if (m[2] !== undefined) { flags.set(key, m[2]); continue; }
  const next = argv[i + 1];
  if (next !== undefined && !next.startsWith('--')) { flags.set(key, next); i++; }
  else flags.set(key, 'true');
}

function read() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return null; }
}

const current = read();
const provider = positional[0];

if (!provider) {
  console.log(`默认声音文件：${FILE}`);
  console.log(current ? JSON.stringify(current, null, 2) : '（还没有；用本工具设置，或直接在面板第 ⑥ 组里改）');
  console.log('\n可选引擎：' + PROVIDERS.join(' / '));
  process.exit(0);
}
if (!PROVIDERS.includes(provider)) {
  console.error(`未知引擎 ${provider}（可选：${PROVIDERS.join(' / ')}）`);
  process.exit(2);
}

const prev = current?.provider === provider ? (current.custom ?? {}) : {};
let doc;

if (provider === 'edge-tts') {
  const voice = positional[1] || (current?.provider === 'edge-tts' ? current.voice : '') || '';
  doc = { provider, voice, custom: {}, _note: 'Edge TTS 预设音色；voice 留空则用 zh-CN-XiaoxuanNeural' };
} else if (provider === 'rvc') {
  const custom = {
    baseUrl: flags.get('base-url') || DEFAULT_BASE.rvc,
    model: flags.get('model') || prev.model || 'E:\\dsh-rvc\\assets\\weights\\guanguanV1.pth',
    index: flags.get('index') || prev.index || 'E:\\dsh-rvc\\logs\\guanguanV1.index',
  };
  for (const k of ['model', 'index']) if (!fs.existsSync(custom[k])) console.warn(`⚠️ ${k} 文件不存在：${custom[k]}`);
  doc = { provider, voice: '', custom, _note: 'RVC 自定义音色（模型 + 索引）' };
} else if (provider === 'cosyvoice') {
  const prompt = flags.get('prompt') || prev.voice;
  const promptText = flags.get('prompt-text') || flags.get('promptText') || prev.promptText;
  if (!prompt || !promptText) {
    console.error('cosyvoice 需要 --prompt <提示音频文件名> 与 --prompt-text "<该音频的文字稿>"');
    console.error('提示音频要先放进服务端语音库（面板「本地克隆（CosyVoice）」的上传按钮，或 POST /dsh-tts-api/cosy-upload）');
    process.exit(2);
  }
  doc = {
    provider,
    voice: '',
    custom: {
      baseUrl: flags.get('base-url') || DEFAULT_BASE.cosyvoice,
      voice: prompt,
      promptText,
      speed: flags.get('speed') || prev.speed || '1.0',
      seed: flags.get('seed') || prev.seed || '0',
    },
    _note: 'CosyVoice 零样本克隆（提示音频 + 文字稿）；首次合成会注册说话人并缓存',
  };
} else {
  const voice = positional[1] || prev.voice || '';
  doc = {
    provider,
    voice,
    custom: { baseUrl: flags.get('base-url') || DEFAULT_BASE['index-tts2'], voice },
    _note: 'Index-TTS2 参考音频音色',
  };
}

doc._updatedAt = new Date().toISOString();
fs.mkdirSync(path.dirname(FILE), { recursive: true });
fs.writeFileSync(FILE, JSON.stringify(doc, null, 2) + '\n', 'utf8');
console.log(`已把默认声音设为 ${provider}：`);
console.log(JSON.stringify(doc, null, 2));
if (provider !== 'edge-tts') {
  console.log('\n提示：宿主半的 /dsh-qq-console/voice 路由与 AI 工具 qq_say_voice 需要重启一次 DSH 才用上新代码；');
  console.log('      tools/say-voice.mjs 直接读这个文件，**不用重启**即可生效。');
}