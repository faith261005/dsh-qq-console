#!/usr/bin/env node
/**
 * 端到端检查：在真实浏览器里打开 DSH GUI → 头像菜单 → 设置 → 「QQ 桥接」面板是否渲染。
 *
 * 前置：DSH 在跑；desktop profile 里有 puppeteer-core；系统装了 Edge。
 * 鉴权：离线铸造浏览器会话 Cookie（同桥接的做法）。
 * 用法：node tools/browser-check.mjs [BASE_URL]
 * 退出码 0 = 面板渲染正常。
 */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** qq-bridge 源码目录：借它的 DSH 会话签名工具（可用 DSH_QQ_BRIDGE_DIR 覆盖）。 */
const BRIDGE_DIR = process.env.DSH_QQ_BRIDGE_DIR || 'C:\\Users\\faith\\qq-bridge';
/** DSH profile 目录：puppeteer-core 装在这里（可用 DSH_PROFILE_DIR 覆盖）。 */
const PROFILE_DIR = process.env.DSH_PROFILE_DIR || path.join(os.homedir(), '.dsh', 'profiles', 'desktop');
/** DSH Web GUI 地址：端口每次启动都变，建议显式传入（argv[2] 或 DSH_BASE_URL）。 */
const BASE = process.argv[2] || process.env.DSH_BASE_URL || 'http://127.0.0.1:62188';
const EDGE = process.env.EDGE_PATH || [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p)) || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const { readBrowserSessionSecret, mintBrowserSessionCookie } = await import(
  pathToFileURL(path.join(BRIDGE_DIR, 'src', 'dsh-client.js')).href
);
const require = createRequire(path.join(PROFILE_DIR, 'package.json'));
const puppeteer = require('puppeteer-core');

const cookieString = mintBrowserSessionCookie(BASE, readBrowserSessionSecret());
const eq = cookieString.indexOf('=');
const cookie = { name: cookieString.slice(0, eq), value: cookieString.slice(eq + 1), domain: '127.0.0.1', path: '/' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
const browser = await puppeteer.launch({ executablePath: EDGE, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
let ok = false;

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 960 });
  await page.setCookie(cookie);
  page.on('pageerror', (e) => errors.push(`pageerror: ${e?.message ?? e}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });

  const text = () => page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
  const clickText = (needle, { exact = false, last = true } = {}) => page.evaluate((n, ex, la) => {
    const list = [...document.querySelectorAll('button,a,[role=button],[role=tab],[role=menuitem],div,span,li')];
    const hits = list.filter((el) => {
      const t = (el.innerText ?? '').trim();
      return ex ? t === n : t.includes(n);
    });
    const target = la ? hits[hits.length - 1] : hits[0];
    if (!target) return false;
    target.click();
    return (target.innerText ?? '').trim().slice(0, 60);
  }, needle, exact, last);

  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => (document.body?.innerText ?? '').length > 200, { timeout: 90000 });
  await sleep(2500);

  // 关掉「预览版说明」与「插件已热重载 → 刷新页面」
  for (const label of ['刷新页面', '继续', '知道了']) {
    const hit = await clickText(label, { exact: true });
    if (hit) { console.log(`关掉提示「${label}」`); await sleep(3000); }
  }
  // 刷新后弹窗可能再来一次
  await clickText('继续', { exact: true });
  await sleep(1500);

  console.log('打开设置：先用菜单里显示的快捷键 Ctrl+Alt+,');
  await page.keyboard.down('Control');
  await page.keyboard.down('Alt');
  await page.keyboard.press(',');
  await page.keyboard.up('Alt');
  await page.keyboard.up('Control');
  await sleep(3000);

  let body = await text();
  let hasMine = body.includes('QQ 桥接');
  if (!hasMine) {
    // 退路：点最内层那个以「设置」开头的元素（避免点到外层容器）
    console.log('  快捷键没生效，改点菜单项');
    const hit = await page.evaluate(() => {
      const cands = [...document.querySelectorAll('*')]
        .filter((el) => (el.innerText ?? '').trim().startsWith('设置'));
      cands.sort((a, b) => a.innerText.trim().length - b.innerText.trim().length);
      if (!cands[0]) return false;
      cands[0].click();
      return cands[0].innerText.trim().slice(0, 30);
    });
    console.log('  点「设置」->', hit);
    await sleep(3000);
    body = await text();
    hasMine = body.includes('QQ 桥接');
  }
  console.log('设置页里含「QQ 桥接」:', hasMine);

  if (!hasMine) {
    // 诊断：列出设置左侧导航的分区名
    const nav = await page.evaluate(() => [...document.querySelectorAll('[role=tab],[role=menuitem],nav *,aside *')]
      .map((el) => (el.innerText ?? '').trim()).filter((t) => t && t.length < 24));
    console.log('  设置导航候选:', JSON.stringify([...new Set(nav)].slice(0, 40)));
    console.log('  正文摘录:', body.slice(0, 600));
  }

  if (hasMine) {
    // 精确找那个文本就是「QQ 桥接」的最内层元素，再用真鼠标点它的中心
    const box = await page.evaluate(() => {
      const cands = [...document.querySelectorAll('*')]
        .filter((el) => (el.innerText ?? '').trim() === 'QQ 桥接');
      cands.sort((a, b) => (a.innerText ?? '').length - (b.innerText ?? '').length);
      const target = cands[0];
      if (!target) return null;
      const r = target.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, tag: target.tagName, cls: String(target.className).slice(0, 40) };
    });
    console.log('  导航项:', JSON.stringify(box));
    if (box) { await page.mouse.click(box.x, box.y); }
    await sleep(3500);
    body = await text();
    const markers = ['① 开关与状态', '② 白名单', '③ 响应速度', '④ 等待锁', '保存白名单', '保存等待锁参数', '暂停 AI 活动'];
    const seen = markers.filter((m) => body.includes(m));
    console.log('  面板标记:', seen.join(' / ') || '（无）');
    console.log('  显示了桥接状态行:', /在线（模式|离线/.test(body));
    if (seen.length >= 5) {
      ok = true;
      console.log('\n✅ 面板在 DSH 设置页里渲染正常');
      console.log('   正文摘录:', body.slice(0, 500));
    } else {
      console.log('\n⚠️ 面板入口可见但内容不全，正文摘录:');
      console.log(body.slice(0, 1200));
    }
  }

  if (errors.length) {
    console.log('\n控制台错误（前 10 条）:');
    for (const e of errors.slice(0, 10)) console.log('  -', e);
  }
} finally {
  await browser.close();
}
process.exit(ok ? 0 : 1);