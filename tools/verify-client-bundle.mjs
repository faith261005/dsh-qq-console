#!/usr/bin/env node
/**
 * 确认「客户端半真的会被浏览器执行」——不靠肉眼，靠 GUI 自己吐出来的 boot 载荷。
 *
 * 原理：DSH 的 index.html 内联了 `globalThis["__DSH_BOOT__"]`，其中
 *   · entries[i] = { id, url, rev, inject }  —— 每个客户端插件一条
 *   · batches[] = { phase, url, entries[] } —— 浏览器实际会去拉的合并请求（`plugins/??…`）
 * 所以：① 我的 id 必须在 entries 里；② 拉它所在的 batch，响应里必须真有我的模块源码。
 *
 * 鉴权：离线铸造浏览器会话 Cookie（~/.dsh/.credentials.yaml 的签名密钥，与桥接同款）。
 * 用法：node tools/verify-client-bundle.mjs [BASE_URL]；退出码 0 = 通过。
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** qq-bridge 源码目录：借它的 DSH 会话签名工具铸造浏览器会话 Cookie（可用 DSH_QQ_BRIDGE_DIR 覆盖）。 */
const BRIDGE_DIR = process.env.DSH_QQ_BRIDGE_DIR || 'C:\\Users\\faith\\qq-bridge';
const { readBrowserSessionSecret, mintBrowserSessionCookie } = await import(
  pathToFileURL(path.join(BRIDGE_DIR, 'src', 'dsh-client.js')).href
);

const BASE = process.argv[2] || process.env.DSH_BASE_URL || 'http://127.0.0.1:62188';
const ID = 'dsh-qq-console';
const MARKER = '开关与状态'; // 面板里的独有文案，用来确认拿到的是我的模块而不是同名壳

const secret = readBrowserSessionSecret();
if (!secret) { console.error('读不到浏览器会话签名密钥'); process.exit(1); }
const cookie = mintBrowserSessionCookie(BASE, secret);

const html = await (await fetch(`${BASE}/`, { headers: { cookie } })).text();
const at = html.indexOf('globalThis["__DSH_BOOT__"]');
if (at < 0) { console.error('index.html 里没有 __DSH_BOOT__'); process.exit(1); }
const raw = html.slice(html.indexOf('{', at), html.indexOf('</script>', at)).trim().replace(/;\s*$/, '');
const boot = JSON.parse(raw);

const entry = (boot.entries ?? []).find((e) => String(e.id).includes(ID));
console.log('① entries 里有我的客户端条目:', Boolean(entry));
if (entry) console.log('   ', JSON.stringify(entry));
else {
  console.log('   现有条目 id（前 20）:', JSON.stringify((boot.entries ?? []).slice(0, 20).map((e) => e.id)));
  process.exit(1);
}

const batch = (boot.batches ?? []).find((b) => JSON.stringify(b.entries ?? []).includes(entry.id));
console.log('② 我所在的 batch:', batch ? `${batch.phase}（${batch.entries.length} 个成员）` : '未找到');
if (!batch) process.exit(1);

const url = new URL(batch.url, `${BASE}/`).toString();
const res = await fetch(url, { headers: { cookie } });
const body = await res.text();
const okStatus = res.status === 200;
const hasModule = body.includes(ID);
const hasMarker = body.includes(MARKER);
console.log(`③ 拉取该 batch：HTTP ${res.status}，${body.length} 字节`);
console.log(`   响应里含本插件模块: ${hasModule} | 含面板文案「${MARKER}」: ${hasMarker}`);

const ok = okStatus && hasModule && hasMarker;
console.log(ok ? '\n✅ 客户端半会被浏览器执行（boot 载荷 + 合并请求都验证过了）' : '\n❌ 客户端半没被正确服务');
process.exit(ok ? 0 : 1);