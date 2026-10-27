#!/usr/bin/env node
/**
 * 不依赖 git 的发版器：在 GitHub 上打 tag + 建 Release，可选上传附件（zip/asar）。
 *
 * 用途（2026-10-27）：本机没有 git，仓库也没有 tag。GitHub 的
 *   POST /repos/{r}/releases 只要给 tag_name 就会**自动在那个提交上打 tag**，
 * 所以「发布作品」不需要 git，一条 API 就够了。
 *
 * 用法：
 *   set GITHUB_TOKEN=ghp_xxx           # classic：repo scope；fine-grained：Contents=Read and write
 *   node tools/gh-release.mjs --tag v0.1.0 --name "dsh-qq-console v0.1.0" --notes-file notes.md [--asset out.zip] [--draft]
 *
 * 幂等：同名 tag/release 已存在时不会重复创建，只把结果报给你（要改内容请先删掉旧 release）。
 */
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const flag = (name, def = null) => {
  const i = argv.indexOf(name);
  return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true) : def;
};
const REPO = String(flag('--repo', process.env.DSH_GH_REPO ?? 'faith261005/dsh-qq-console'));
const TAG = String(flag('--tag', ''));
const NAME = String(flag('--name', TAG ? `dsh-qq-console ${TAG}` : ''));
const NOTES_FILE = flag('--notes-file', null);
const ASSET = flag('--asset', null);
const DRAFT = argv.includes('--draft');
const PRE = argv.includes('--prerelease');
const TARGET = String(flag('--target', 'main'));
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || String(flag('--token', ''));

if (!TAG) { console.error('缺少 --tag（例如 --tag v0.1.0）'); process.exit(2); }
if (!TOKEN) { console.error('缺少 GITHUB_TOKEN（classic 需 repo scope；fine-grained 需 Contents: Read and write）'); process.exit(2); }
const body = NOTES_FILE && fs.existsSync(String(NOTES_FILE)) ? fs.readFileSync(String(NOTES_FILE), 'utf8') : String(flag('--notes', ''));

const H = { accept: 'application/vnd.github+json', 'user-agent': 'dsh-release', authorization: `Bearer ${TOKEN}` };
const call = async (method, url, json, raw = false) => {
  const r = await fetch(url.startsWith('http') ? url : `https://api.github.com${url}`, {
    method, headers: { ...H, ...(json || raw ? { 'content-type': raw ? 'application/zip' : 'application/json' } : {}) },
    body: json ? JSON.stringify(json) : (raw ?? undefined), signal: AbortSignal.timeout(120000),
  });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch { /* 可能不是 JSON */ }
  if (!r.ok) {
    const hint = r.status === 403 ? '（权限不足：classic 需 repo scope / fine-grained 需 Contents: Read and write）' : '';
    throw new Error(`HTTP ${r.status} ${method} ${url} ${hint}\n${text.slice(0, 300)}`);
  }
  return j;
};

console.log(`仓库 ${REPO}｜tag ${TAG}｜附件 ${ASSET ?? '(无)'}`);
// 已存在就直接报告（避免重复建 tag/release）
try {
  const ex = await call('GET', `/repos/${REPO}/releases/tags/${TAG}`);
  console.log(`⚠️ tag ${TAG} 的 release 已存在：${ex.html_url}（要改内容请先在 GitHub 上删掉它）`);
  process.exit(0);
} catch { /* 404 = 还没有，继续 */ }

const rel = await call('POST', `/repos/${REPO}/releases`, {
  tag_name: TAG, target_commitish: TARGET, name: NAME || TAG, body, draft: DRAFT, prerelease: PRE,
});
console.log(`✅ 已创建 Release：${rel.html_url}`);
console.log(`   tag ${rel.tag_name} → 提交 ${String(rel.target_commitish)}｜draft=${rel.draft} prerelease=${rel.prerelease}`);

if (ASSET && fs.existsSync(String(ASSET))) {
  const buf = fs.readFileSync(String(ASSET));
  const name = path.basename(String(ASSET));
  const up = await fetch(`https://uploads.github.com/repos/${REPO}/releases/${rel.id}/assets?name=${encodeURIComponent(name)}`, {
    method: 'POST', headers: { ...H, 'content-type': 'application/zip' }, body: buf, signal: AbortSignal.timeout(300000),
  });
  const uj = await up.json().catch(() => null);
  if (!up.ok) throw new Error(`附件上传失败 HTTP ${up.status}：${JSON.stringify(uj).slice(0, 200)}`);
  console.log(`✅ 附件已上传：${name}（${(buf.length / 1024).toFixed(0)} KB）→ ${uj.browser_download_url}`);
} else if (ASSET) {
  console.log(`⚠️ 附件不存在，跳过：${ASSET}`);
}