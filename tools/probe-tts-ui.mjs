#!/usr/bin/env node
/**
 * 「自定义声音的入口到底在哪」探针。
 *
 * 背景：dsh-plugin-tts 按 README 会在设置里给一节「语音」，但**Edge 模式下 RVC 面板是隐藏的**，
 * 只留一行「需要克隆音色？」入口；而它的客户端半又要注入 `@deepseek-ai/dsh-client-ui-slots`
 * （桌面版没有这个包）。所以"找不到自定义声音"可能有两种原因，必须用浏览器分开查证：
 *   ① 界面没挂上（缺注入模块）→ 连「语音」分区都不该出现；
 *   ② 界面挂上了，但自定义音色入口藏在某处（如「需要克隆音色？」链接 / 下方的高级区）。
 *
 * 用法：node tools/probe-tts-ui.mjs [http://127.0.0.1:<DSH端口>]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const BRIDGE_DIR = process.env.DSH_QQ_BRIDGE_DIR || 'C:\\Users\\faith\\qq-bridge';
const PROFILE_DIR = process.env.DSH_PROFILE_DIR || path.join(os.homedir(), '.dsh', 'profiles', 'desktop');
const cfg = JSON.parse(fs.readFileSync(path.join(BRIDGE_DIR, 'config.json'), 'utf8'));
const BASE = (process.argv[2] || process.env.DSH_BASE_URL || cfg?.dsh?.baseUrl || '').replace(/\/+$/, '');
const EDGE = process.env.EDGE_PATH || [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => fs.existsSync(p));

const { readBrowserSessionSecret, mintBrowserSessionCookie } = await import(
  pathToFileURL(path.join(BRIDGE_DIR, 'src', 'dsh-client.js')).href
);
const require = createRequire(path.join(PROFILE_DIR, 'package.json'));
const puppeteer = require('puppeteer-core');

const cookieString = mintBrowserSessionCookie(BASE, readBrowserSessionSecret());
const eq = cookieString.indexOf('=');
console.log(`DSH = ${BASE} | Edge = ${EDGE}`);

// ── ① boot 载荷：它的客户端半要注入什么、桌面版有没有 ─────────────────────────
const html = await (await fetch(`${BASE}/`, { headers: { cookie: cookieString } })).text();
const at = html.indexOf('globalThis["__DSH_BOOT__"]');
const boot = JSON.parse(html.slice(html.indexOf('{', at), html.indexOf('</script>', at)).trim().replace(/;\s*$/, ''));
const entry = (boot.entries ?? []).find((e) => String(e.id).includes('dsh-plugin-tts'));
console.log('\n① boot 载荷里的 TTS 客户端条目：');
console.log('  ', entry ? JSON.stringify(entry) : '(没有)');
const asarPkgs = ['@deepseek-ai/dsh-client-ui-slots'];
for (const want of asarPkgs) {
  const present = fs.existsSync(path.join('E:\\DSH\\resources\\app.asar.unpacked', 'dsh', 'node_modules', want));
  console.log(`   它要注入的 ${want} 在 unpacked 里${present ? '存在' : '不存在'}（asar 内已另行确认：不存在）`);
}

// ── ② 浏览器：打开设置，列出导航项，找「语音」 ────────────────────────────────
const browser = await puppeteer.launch({ executablePath: EDGE, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
const page = await browser.newPage();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await page.setCookie({ name: cookieString.slice(0, eq), value: cookieString.slice(eq + 1), domain: '127.0.0.1', path: '/' });
await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => (document.body?.innerText ?? '').length > 200, { timeout: 90000 });
await sleep(2500);
const clickText = async (label) => page.evaluate((t) => {
  const cands = [...document.querySelectorAll('button,div,span,a')].filter((el) => (el.innerText ?? '').trim() === t);
  cands.sort((a, b) => a.innerText.trim().length - b.innerText.trim().length);
  if (!cands[0]) return false;
  cands[0].click();
  return true;
}, label);
for (const l of ['刷新页面', '继续', '知道了']) { if (await clickText(l)) await sleep(2500); }

await page.keyboard.down('Control'); await page.keyboard.down('Alt'); await page.keyboard.press(',');
await page.keyboard.up('Alt'); await page.keyboard.up('Control');
await sleep(3500);

const nav = await page.evaluate(() => {
  const cells = [...document.querySelectorAll('button')].filter((b) => /navCell/i.test(b.className || ''));
  return cells.map((c) => (c.innerText ?? '').trim()).filter(Boolean);
});
console.log('\n② 设置导航项：');
console.log('  ' + (nav.join(' | ') || '(没抓到 navCell，退化为全部按钮)'));
if (!nav.length) {
  const all = await page.evaluate(() => [...document.querySelectorAll('button')].map((b) => (b.innerText ?? '').trim()).filter((t) => t && t.length < 24));
  console.log('  ' + all.slice(0, 40).join(' | '));
}

const voiceNav = nav.find((n) => /语音|朗读|TTS|音色|speech|voice/i.test(n));
console.log(`\n③ 导航里和语音相关的项：${voiceNav ?? '(没有！⇒ 它的界面没挂上)'}`);
if (voiceNav) {
  await page.evaluate((label) => {
    const cell = [...document.querySelectorAll('button')].find((b) => /navCell/i.test(b.className || '') && (b.innerText ?? '').trim() === label);
    cell?.click();
  }, voiceNav);
  await sleep(3000);
  const panel = await page.evaluate(() => (document.body?.innerText ?? '').replace(/\s*\n\s*/g, '\n'));
  const idx = panel.indexOf(voiceNav);
  const slice = panel.slice(Math.max(0, idx), Math.max(0, idx) + 2600);
  console.log('   —— 该分区正文（前 2600 字）——');
  console.log(slice);
  for (const needle of ['需要克隆音色', 'RVC', 'CosyVoice', 'Index', '自定义音色', '提示音频', '参考音频', '音色包', '上传']) {
    if (panel.includes(needle)) console.log(`   · 命中「${needle}」`);
  }
}
await browser.close();