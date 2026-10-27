#!/usr/bin/env node
/**
 * 不依赖 git 的发布器：把本目录（dsh-qq-console）整棵源码树推到 GitHub。
 *
 * 为什么需要它：本机**没有 git、没有 gh**，而且这个插件目录也不是 git 仓库（2026-10-27 实测）。
 * 于是直接用 GitHub 的 Git Data API 走一趟「blob → tree → commit → 更新 ref」，
 * 效果等价于一次 `git push`：**一个提交、全部文件**，保留未改动的文件（用 base_tree）。
 *
 * 用法（令牌从环境变量或参数取，别写进文件）：
 *   set GITHUB_TOKEN=ghp_xxx      # fine-grained PAT：Contents = Read and write
 *   node tools/gh-push.mjs --dry-run                 # 只看会传什么，不写任何东西
 *   node tools/gh-push.mjs --message "聊天记录：..."  # 真正推送
 *
 * 选填：
 *   --repo owner/name（默认 faith261005/dsh-qq-console）
 *   --branch main
 *   --include-refs     把 refs/ 研究资料也带上（默认排除）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');           // 插件根目录
const argv = process.argv.slice(2);
const flag = (name, def = null) => {
  const i = argv.indexOf(name);
  return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true) : def;
};
const DRY = argv.includes('--dry-run');
const REPO = String(flag('--repo', process.env.DSH_GH_REPO ?? 'faith261005/dsh-qq-console'));
const BRANCH = String(flag('--branch', 'main'));
const INCLUDE_REFS = argv.includes('--include-refs');
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || String(flag('--token', ''));
const MESSAGE = String(flag('--message', `chore: 同步 dsh-qq-console（${new Date().toISOString().slice(0, 10)}）`));

const API = 'https://api.github.com';
const headers = {
  accept: 'application/vnd.github+json',
  'user-agent': 'dsh-qq-console-publisher',
  'x-github-api-version': '2022-11-28',
  ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
};
const call = async (method, url, body) => {
  const r = await fetch(url.startsWith('http') ? url : `${API}${url}`, {
    method, headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60000),
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* 非 JSON 响应 */ }
  if (!r.ok) {
    const hint = r.status === 401 ? '（令牌无效/已过期）' : r.status === 403 ? '（令牌权限不足：需要 Contents: Read and write）' : '';
    throw new Error(`HTTP ${r.status} ${method} ${url} ${hint}\n${text.slice(0, 300)}`);
  }
  return json;
};

// ── 收集要发布的文件（与 --dry-run 共用同一套规则） ───────────────────────────
const SKIP_DIRS = new Set(['.git', 'state', 'node_modules', ...(INCLUDE_REFS ? [] : ['refs'])]);
const collect = (dir, rel = '') => {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (SKIP_DIRS.has(e.name)) continue;
    if (/\.(bak|log)$/i.test(e.name)) continue;
    if (e.isDirectory()) out.push(...collect(path.join(dir, e.name), r));
    else out.push({ path: r, size: fs.statSync(path.join(dir, e.name)).size });
  }
  return out;
};
const files = collect(ROOT).sort((a, b) => a.path.localeCompare(b.path));
console.log(`仓库: ${REPO}（分支 ${BRANCH}）｜令牌: ${TOKEN ? '有' : '无'}｜目录: ${ROOT}`);
console.log(`待发布 ${files.length} 个文件 / ${(files.reduce((s, f) => s + f.size, 0) / 1024).toFixed(0)} KB：`);
for (const f of files) console.log(`   ${f.path}  ${(f.size / 1024).toFixed(1)}KB`);

if (DRY) {
  console.log('\n--dry-run：只列清单，没有向 GitHub 写任何东西。');
  if (TOKEN) {
    try {
      const repo = await call('GET', `/repos/${REPO}`);
      console.log(`能读到 ${repo.full_name}（默认分支 ${repo.default_branch}，最近推送 ${repo.pushed_at}）`);
      console.log('⚠️ 注意：public 仓库**不需要任何权限也能读** —— 所以"能读"不代表令牌有写权限；'
        + '写权限由真推送时的探针确认（需要 Contents: Read and write）。');
    } catch (e) { console.log(`令牌检查失败：${e.message.split('\n')[0]}`); }
  } else {
    console.log('没有令牌 ⇒ 真推送时请设置 GITHUB_TOKEN（fine-grained PAT，Contents: Read and write）。');
  }
  process.exit(0);
}

if (!TOKEN) {
  console.error('\n缺少令牌：请设置环境变量 GITHUB_TOKEN（或 GH_TOKEN），它需要对该仓库有 Contents: Read and write 权限。');
  process.exit(2);
}

// ── 真推送：blob → tree(base_tree) → commit → 更新 ref ────────────────────────
const repoInfo = await call('GET', `/repos/${REPO}`);
console.log(`\n目标仓库: ${repoInfo.full_name}（私有 ${repoInfo.private}，默认分支 ${repoInfo.default_branch}）`);
// 预检写权限：**只能用"真写一次"来判断**。
// 2026-10-27 两次踩坑：
//   ① 直接上传才在第一个 blob 收到 403「Resource not accessible by personal access token」；
//   ② 改用 GET /repos/{r} 的 permissions.push 判断 —— 那是**用户**对仓库的权限（你是 owner ⇒ admin），
//      与**令牌被授予的权限**无关，于是误判成"有权"。
// 所以这里建一个 1 字节的孤儿 blob 当探针：被拒就立刻停下并给准确指引，且不会改动仓库任何引用
// （孤儿 blob 不被任何 commit 引用，会被 GitHub 自行清理）。
{
  let probeOk = true; let probeMsg = '';
  try {
    await call('POST', `/repos/${REPO}/git/blobs`, { content: Buffer.from('ok').toString('base64'), encoding: 'base64' });
  } catch (e) { probeOk = false; probeMsg = e.message; }
  if (!probeOk) {
    throw new Error(
      `令牌没有写权限（写探针被拒）：\n${probeMsg.split('\n')[0]}\n`
      + `注意：仓库是 public，所以"能读"不代表有权限 —— 请把令牌的 Repository permissions → Contents 设为`
      + ` "Read and write"（https://github.com/settings/personal-access-tokens 编辑该令牌），`
      + `或改用带 repo scope 的 classic 令牌。`,
    );
  }
  console.log('  写权限预检通过（1 字节探针 blob 已建，无引用、无害）');
}
const ref = await call('GET', `/repos/${REPO}/git/ref/heads/${BRANCH}`);
const parentSha = ref.object.sha;
const parent = await call('GET', `/repos/${REPO}/git/commits/${parentSha}`);
// 注意：/git/commits/{sha} 返回的就是提交对象本身（message 在顶层）；只有 /git/ref/... 才是 {object:{sha}} 那层包装
// —— 第一次这里写成 parent.commit.message，直接 TypeError 中断（幸好发生在写 GitHub 之前）。
console.log(`当前 ${BRANCH} = ${parentSha.slice(0, 10)}（${String(parent.message ?? '').split('\n')[0].slice(0, 60)}）`);

console.log('\n上传 blob…');
const entries = [];
for (const f of files) {
  const content = fs.readFileSync(path.join(ROOT, f.path));
  const blob = await call('POST', `/repos/${REPO}/git/blobs`, { content: content.toString('base64'), encoding: 'base64' });
  entries.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha });
  process.stdout.write(`   ${f.path} -> ${blob.sha.slice(0, 8)}\n`);
}

const tree = await call('POST', `/repos/${REPO}/git/trees`, { base_tree: parent.tree.sha, tree: entries });
const commit = await call('POST', `/repos/${REPO}/git/commits`, { message: MESSAGE, tree: tree.sha, parents: [parentSha] });
await call('PATCH', `/repos/${REPO}/git/refs/heads/${BRANCH}`, { sha: commit.sha, force: false });
console.log(`\n✅ 已推送 ${files.length} 个文件`);
console.log(`   提交: ${commit.sha}`);
console.log(`   查看: https://github.com/${REPO}/commit/${commit.sha}`);