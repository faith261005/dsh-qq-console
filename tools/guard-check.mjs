#!/usr/bin/env node
/**
 * 验证 QQ preset 的执行期工具白名单（守卫 qq-tool-restrict）：
 *   ① 内置放行项仍然放行（MCP 命名空间、ask_user_question、todo_write）；
 *   ② 扩展项来自 state/tool-allowlist.json —— 本机已放行 dsh-meme 与 dsh-vision-router 的分析类工具；
 *   ③ **风险项默认仍被拒**：vision_screenshot / vision_html_screenshot / vision_materialize / vision_long_screenshot_ocr；
 *   ④ **改文件即生效**（守卫按 mtime 读取，不需要重新 apply、更不需要重启 DSH）；
 *   ⑤ 未知/空工具名 fail-closed；
 *   ⑥ preset 目录下的 re-export 壳也能拿到同一套行为与导出。
 *
 * 用法：node tools/guard-check.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const REPO = 'C:/Users/faith/qq-bridge';
const GUARD = `${REPO}/plugins/qq-agent-presets/qq-tool-restrict.mjs`;
const SHIM = `${REPO}/dsh/agent-presets/qq-chat-v2/qq-tool-restrict.mjs`;
const LIVE_ALLOWLIST = `${REPO}/state/tool-allowlist.json`;

let failed = 0;
/** 等一小会儿（默认 30ms：足够跨过常见的 mtime 粒度，又不必等 TTL）。 */
const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failed += 1; console.error('FAIL', name, '—', error?.message ?? error); }
}

/** 加载守卫并捕获它的 guard 回调。 */
async function captureGuard(modulePath) {
  const mod = await import(`${pathToFileURL(modulePath).href}?v=${Math.random()}`);
  let guard;
  const restricted = [];
  mod.apply({ tools: { restrict: ({ deny }) => restricted.push(...deny), guard: (fn) => { guard = fn; } } });
  assert.equal(typeof guard, 'function', 'apply 必须注册 guard');
  return { mod, guard, restricted };
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-guard-'));
const tmpAllowlist = path.join(tmpDir, 'tool-allowlist.json');
const writeTmp = (doc) => { fs.writeFileSync(tmpAllowlist, JSON.stringify(doc, null, 2)); };

await test('内置放行项与 fail-closed 行为不因扩展而改变', async () => {
  const { guard, restricted, mod } = await captureGuard(GUARD);
  assert.ok(restricted.includes('dev_install_package'), '危险工具仍要进 restrict 名单');
  assert.ok(Array.isArray(mod.RESTRICTED_TOOL_NAMES) && mod.RESTRICTED_TOOL_NAMES.length > 0, '仍导出 RESTRICTED_TOOL_NAMES');

  for (const name of ['mcp__snowluma__qq_send_message', 'mcp__snowluma-host__snowluma_status',
    'mcp__web-search-safe__web_search', 'ask_user_question', 'todo_write']) {
    assert.equal(guard({ name }), undefined, `${name} 应放行`);
  }
  for (const name of ['', null, undefined, 'totally_new_tool', 'mcp__untrusted__web_fetch', 'web_fetch', 'bash', 'read_file']) {
    assert.equal(typeof guard({ name }), 'string', `${JSON.stringify(name)} 必须被拒（fail-closed）`);
  }
});

await test('本机名单文件已放行 dsh-meme 与 dsh-vision-router 的分析类工具', async () => {
  assert.ok(fs.existsSync(LIVE_ALLOWLIST), `名单文件应存在：${LIVE_ALLOWLIST}`);
  const { guard } = await captureGuard(GUARD);
  for (const name of ['send_meme', 'learn_meme', 'vision_describe', 'vision_ocr', 'vision_crop',
    'vision_ground', 'vision_detect', 'vision_colors', 'vision_pixel_diff',
    'vision_extract_foreground', 'vision_trace', 'vision_present', 'vision_bootstrap', 'vision_activate']) {
    assert.equal(guard({ name }), undefined, `${name} 应被放行（扩展名单里）`);
  }
});

await test('风险项默认仍被拒（截图 / 写文件类）', async () => {
  const { guard } = await captureGuard(GUARD);
  for (const name of ['vision_screenshot', 'vision_html_screenshot', 'vision_materialize', 'vision_long_screenshot_ocr']) {
    const verdict = guard({ name });
    assert.equal(typeof verdict, 'string', `${name} 默认应被拒（会把本机画面/文件暴露给群里的人）`);
  }
});

await test('QQ_TOOL_ALLOWLIST=off 时退回硬编码名单（证明放行确实来自文件）', async () => {
  const { guard } = await captureGuard(GUARD);
  assert.equal(guard({ name: 'vision_describe' }), undefined, '先确认默认（读文件）时放行');
  process.env.QQ_TOOL_ALLOWLIST = 'off';
  const denied = guard({ name: 'vision_describe' });
  assert.equal(typeof denied, 'string', 'off 时应拒绝（只用硬编码名单）');
  assert.match(denied, /不在 QQ 桥接白名单内/);
  delete process.env.QQ_TOOL_ALLOWLIST;
  assert.equal(guard({ name: 'vision_describe' }), undefined, '去掉 off 后应恢复放行');
});

await test('前缀放行 + 改文件即生效（mtime/size + TTL 热加载，不重新 apply）', async () => {
  writeTmp({ allowedExact: [], allowedPrefixes: [] })
  process.env.QQ_TOOL_ALLOWLIST = tmpAllowlist
  try {
    const { guard } = await captureGuard(GUARD)
    assert.equal(typeof guard({ name: 'vision_screenshot' }), 'string', '空前缀时应拒绝')

    // 写入后立刻断言：缓存键含 size ⇒ 长度变化当场就重读（不等 TTL）
    writeTmp({ allowedExact: [], allowedPrefixes: ['vision_'] })
    await tick()
    assert.equal(guard({ name: 'vision_screenshot' }), undefined, '加前缀后（不重启、不重新 apply）应放行')
    assert.equal(guard({ name: 'vision_materialize' }), undefined, '前缀对同族工具都生效')

    writeTmp({ allowedExact: ['send_meme'], allowedPrefixes: [] })
    await tick()
    assert.equal(typeof guard({ name: 'vision_screenshot' }), 'string', '去掉前缀后应立刻恢复拒绝')
    assert.equal(guard({ name: 'send_meme' }), undefined, '精确名放行生效')

    // 等长改写（大小不变）由 2 秒 TTL 兜底
    writeTmp({ allowedExact: ['send_meme'], allowedPrefixes: ['vision_'] })
    await tick(2200)
    assert.equal(guard({ name: 'vision_screenshot' }), undefined, '等长改写应由 TTL 兜底重读')

    fs.writeFileSync(tmpAllowlist, '{ 这不是 JSON')
    await tick(2200)
    assert.equal(typeof guard({ name: 'send_meme' }), 'string', '文件损坏时应退回硬编码名单（不放宽）')
  } finally {
    delete process.env.QQ_TOOL_ALLOWLIST // 必须恢复：否则污染后面的用例（第一次就踩过）
  }
});

await test('preset 目录的 re-export 壳行为一致', async () => {
  const { guard, mod } = await captureGuard(SHIM);
  assert.equal(typeof mod.readAllowedTools, 'function', '壳应一并导出 readAllowedTools');
  assert.equal(guard({ name: 'mcp__snowluma__qq_send_message' }), undefined);
  assert.equal(guard({ name: 'vision_describe' }), undefined);
  assert.equal(typeof guard({ name: 'vision_screenshot' }), 'string');
});

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);