#!/usr/bin/env node
// 最小 asar 读取器（只读，只为把 DSH 自带的类型定义/包读出来）。
//
// 用法：
//   node asar-ls.mjs <app.asar> [路径前缀]      # 列出匹配的路径
//   node asar-extract.mjs <app.asar> <输出目录> <路径前缀...>   # 抽取匹配的文件
//
// asar 布局（2026-10-23 用 `tools/_probe.mjs` 在本机 app.asar 上实测出来的，不是猜的）：
//
//   偏移 0 : u32 = 4                       pickle 的 size 字段长度
//   偏移 4 : u32 = headerSize              payload 大小
//   偏移 8 : u32 = headerSize - 4          另一个长度字段
//   偏移 12: u32 = headerSize - 8          JSON 字符串长度
//   偏移 16: JSON 头（{"files":{...}}）
//   内容区 : 8 + headerSize（相对内容的 offset 字段即以此为基准）
//
// 校验：16 + (headerSize - 8) === 8 + headerSize ✓（本机实测 4779796）
import fs from 'node:fs';
import path from 'node:path';

export function readAsarHeader(asarPath) {
  const fd = fs.openSync(asarPath, 'r');
  try {
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    const sizeField = head.readUInt32LE(0);
    const headerSize = head.readUInt32LE(4);
    const jsonLen = head.readUInt32LE(12);
    if (sizeField !== 4) throw new Error(`意外的 pickleSize=${sizeField}`);
    if (jsonLen !== headerSize - 8) throw new Error(`header 长度自相矛盾：jsonLen=${jsonLen} headerSize=${headerSize}`);
    const jsonBuf = Buffer.alloc(jsonLen);
    fs.readSync(fd, jsonBuf, 0, jsonLen, 16);
    const header = JSON.parse(jsonBuf.toString('utf8'));
    const contentOffset = 8 + headerSize;
    return { header, contentOffset, fd };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

/** 深度遍历 header，返回 [相对路径, entry] 列表。 */
export function walkAsar(header) {
  const out = [];
  const visit = (node, prefix) => {
    for (const [name, entry] of Object.entries(node.files ?? {})) {
      const p = prefix ? `${prefix}/${name}` : name;
      if (entry.files) visit(entry, p);
      else out.push([p, entry]);
    }
  };
  visit(header, '');
  return out;
}

const isCli = process.argv[1] && /asar\.mjs$/i.test(process.argv[1]);
if (isCli) {
  const mode = process.argv[2];
  const asarPath = process.argv[3];
  if (mode === 'ls') {
    const prefix = process.argv[4] ?? '';
    const { header } = readAsarHeader(asarPath);
    const entries = walkAsar(header).filter(([p]) => p.startsWith(prefix));
    console.log(`匹配 ${entries.length} 个文件（前缀 "${prefix}"）`);
    for (const [p, e] of entries.slice(0, 400)) console.log(`  ${String(e.size).padStart(9)}  ${p}`);
    if (entries.length > 400) console.log(`  … 还有 ${entries.length - 400} 个`);
  } else if (mode === 'extract') {
    const outDir = process.argv[4];
    const prefixes = process.argv.slice(5);
    if (!outDir || prefixes.length === 0) {
      console.error('用法: node asar.mjs extract <app.asar> <输出目录> <前缀...>');
      process.exit(1);
    }
    const r = extractAsar(asarPath, outDir, prefixes);
    console.log(`匹配 ${r.matched} 个，写出 ${r.written} 个 -> ${outDir}`);
  } else {
    console.error('用法:\n  node asar.mjs ls <app.asar> [前缀]\n  node asar.mjs extract <app.asar> <输出目录> <前缀...>');
    process.exit(1);
  }
}

/** 抽取匹配前缀的文件到 outDir（保持相对目录结构）。 */
export function extractAsar(asarPath, outDir, prefixes) {
  const { header, contentOffset, fd } = readAsarHeader(asarPath);
  const entries = walkAsar(header).filter(([p]) => prefixes.some((pre) => p.startsWith(pre)));
  let written = 0;
  for (const [p, e] of entries) {
    if (typeof e.offset !== 'string') continue;
    const dest = path.join(outDir, p);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const size = Number(e.size);
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, contentOffset + Number(e.offset));
    fs.writeFileSync(dest, buf);
    written += 1;
  }
  fs.closeSync(fd);
  return { matched: entries.length, written };
}