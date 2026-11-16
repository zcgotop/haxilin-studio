#!/usr/bin/env node
/**
 * 发布校验模块 —— 产物闸门 + 线上冒烟测试
 *
 * 为什么存在（2026-11-16 两次线上故障的直接教训）：
 *   1. 在上一次构建还没写完 dist/ 时就发起了部署，上传了残缺产物 → 首页 404；
 *   2. 改了读 env 的代码但没有校验端点真的能返回数据 → /api/stats 500。
 *   两次都是「构建退出码 0」骗过了人。构建成功 ≠ 产物可用，所以发布前必须验产物，
 *   部署后必须验线上。
 *
 * 用法：
 *   node admin-tool/release-check.mjs          # 闸门 + 冒烟（冒烟测的是当前线上）
 *   node admin-tool/release-check.mjs gate     # 只校验本地构建产物，不联网、不部署（dry-run）
 *   node admin-tool/release-check.mjs smoke    # 只测线上
 *
 * server.js 的 /api/deploy 会 import 本模块，在构建与部署之间插闸门、在部署之后插冒烟。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(__dirname, "..");

export const SITE_ORIGIN = process.env.SITE_ORIGIN || "https://x.zcgo.top";
export const WORKER_NAME = "haxilin-studio";

/** 阈值来自 2026-11-16 的实测产物：首页 8884B、12 篇文章 → 12 个文章页 → 全站 17 个 HTML */
const MIN_INDEX_BYTES = 3000;

/** 闸门必须存在的关键页面 */
const REQUIRED_PAGES = [
  ["index.html", "首页"],
  ["blog/index.html", "文章列表"],
  ["alt/index.html", "ALT 列表"],
  ["about/index.html", "关于"],
  ["tags/index.html", "标签"],
  ["rss.xml", "RSS"],
];

/** 冒烟测试清单：部署后逐个真实请求线上 */
const SMOKE_CHECKS = [
  { path: "/", label: "首页", pattern: /<!doctype html>/i },
  { path: "/blog", label: "文章列表", pattern: /<a /i },
  { path: "/alt", label: "ALT 列表", pattern: /<a /i },
  { path: "/about", label: "关于页", pattern: /<a /i },
  { path: "/tags", label: "标签页", pattern: /<a /i },
  { path: "/rss.xml", label: "RSS", pattern: /<(rss|feed)/i },
  { path: "/api/stats", label: "统计接口", pattern: /pageviews/, json: true },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isJson(text) {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** src/blog 下所有已发布文章（排除 _drafts 目录） */
function listMarkdown(dir) {
  const acc = [];
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const f = path.join(d, e.name);
      if (!e.isDirectory()) {
        if (e.name.endsWith(".md")) acc.push(f);
      } else if (e.name !== "_drafts" && e.name !== "node_modules") {
        walk(f);
      }
    }
  };
  walk(dir);
  return acc;
}

function sizeOf(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return -1;
  }
}

/**
 * 产物闸门：检查 dist/ 是否是一个「可以上线」的完整构建。
 * 返回 { ok, checks: [{ ok, msg }] }
 */
export function verifyArtifacts(root = PROJECT_ROOT) {
  const checks = [];
  const add = (ok, msg) => {
    checks.push({ ok, msg });
    return ok;
  };

  const client = path.join(root, "dist", "client");
  const server = path.join(root, "dist", "server");
  const adapterPath = path.join(server, "wrangler.json");

  // 1) 适配器生成的部署配置——真正被 wrangler 使用的那份，不是根目录的 wrangler.jsonc
  let adapter = null;
  if (add(fs.existsSync(adapterPath), fs.existsSync(adapterPath)
    ? "部署配置 dist/server/wrangler.json 已生成"
    : "部署配置 dist/server/wrangler.json 缺失（适配器没跑完，根目录的 wrangler.jsonc 不能单独用）")) {
    try {
      adapter = JSON.parse(fs.readFileSync(adapterPath, "utf-8"));
    } catch (e) {
      add(false, `部署配置无法解析：${e.message}`);
    }
  }

  if (adapter) {
    // 2) Worker 入口
    const entry = adapter.main ? path.join(server, adapter.main) : null;
    if (!adapter.main) add(false, "部署配置里没有 main —— Worker 代码不会上线，只剩静态壳");
    else add(sizeOf(entry) > 0, `Worker 入口 ${adapter.main}（${sizeOf(entry)} B）`);

    // 3) 静态资源绑定：缺了它 = 全站 404（今天第一次故障的形态）
    if (add(!!(adapter.assets && adapter.assets.directory), adapter.assets && adapter.assets.directory
      ? `静态资源目录 ${adapter.assets.directory}（绑定 ${(adapter.assets.binding) || "ASSETS"}）`
      : "部署配置里没有 assets.directory —— 部署后站点没有页面，全站 404")) {
      const assetsDir = path.resolve(server, adapter.assets.directory);
      add(sizeOf(path.join(assetsDir, "index.html")) >= MIN_INDEX_BYTES,
        `资源目录解析到 ${path.relative(root, assetsDir)}，首页产物 ${sizeOf(path.join(assetsDir, "index.html"))} B`);
    }

    // 4) Worker 名称：写错会把站点发到另一个 Worker 上
    add(!adapter.name || adapter.name === WORKER_NAME,
      adapter.name === WORKER_NAME ? `目标 Worker：${adapter.name}` : `目标 Worker 是「${adapter.name}」，与线上 ${WORKER_NAME} 不一致`);

    // 5) KV 绑定：评论区依赖 SESSION，丢了就是功能静默失效
    const hasSession = (adapter.kv_namespaces || []).some((k) => k.binding === "SESSION");
    add(hasSession, hasSession ? "SESSION KV 绑定在位（评论区可用）" : "缺少 SESSION KV 绑定，部署后评论区会失效");
  }

  // 6) 首页产物
  const indexBytes = sizeOf(path.join(client, "index.html"));
  add(indexBytes >= MIN_INDEX_BYTES,
    indexBytes < 0 ? "dist/client/index.html 不存在（首页会 404）"
      : `首页产物 index.html ${indexBytes} B${indexBytes < MIN_INDEX_BYTES ? `，低于 ${MIN_INDEX_BYTES} B 疑似空壳` : ""}`);

  // 7) 关键页面逐个确认
  for (const [rel, label] of REQUIRED_PAGES) {
    if (rel === "index.html") continue;
    const bytes = sizeOf(path.join(client, rel));
    add(bytes > 0, bytes > 0 ? `${label}：${rel}（${bytes} B）` : `${label} 缺失：${rel}`);
  }

  // 8) 文章不变量：每篇已发布源文件都必须产出页面。
  //    用「源文件数 == 文章页数」而不是「HTML 总数 ≥ N」，因为后者会在你删文章时误拦。
  const srcPosts = listMarkdown(path.join(root, "src", "blog"));
  const postsDir = path.join(client, "posts");
  const builtPosts = new Set(
    (() => {
      if (!fs.existsSync(postsDir)) return [];
      return fs
        .readdirSync(postsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && fs.existsSync(path.join(postsDir, e.name, "index.html")))
        .map((e) => e.name);
    })()
  );
  // 源文件名（去扩展名）与产物 slug 不一定逐字相等（中文文件名会转 slug），
  // 所以这里只比数量，并把差额报出来供人工确认。
  const missingCount = srcPosts.length - builtPosts.size;
  add(
    srcPosts.length > 0 && missingCount === 0,
    builtPosts.size === 0 && srcPosts.length > 0
      ? `源文件有 ${srcPosts.length} 篇文章，但 dist/client/posts 下一个页面都没有`
      : `文章页面 ${builtPosts.size} 个 / 源文件 ${srcPosts.length} 篇${missingCount === 0 ? "，一致" : `，差 ${missingCount} 篇（构建中断或 slug 变更，请人工确认）`}`
  );

  return { ok: checks.every((c) => c.ok), checks };
}

/** 单个端点探测，失败自动重试一次（给部署传播留时间） */
async function probe(url, pattern, json) {
  let last = { status: 0, ok: false, note: "请求失败" };
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(15000),
        headers: { "User-Agent": "haxilin-release-smoke/1.0", "Cache-Control": "no-cache" },
      });
      const body = await res.text().catch(() => "");
      let note = "";
      if (res.status !== 200) note = `状态码 ${res.status}`;
      else if (pattern && !pattern.test(body)) note = "状态 200 但内容特征不符";
      else if (json && !isJson(body)) note = "返回不是合法 JSON";
      // /api/stats 会优雅地返回 error JSON，这种情况要判失败
      else if (json && /"error"/.test(body)) note = "接口自报错误：" + body.slice(0, 120);
      last = { status: res.status, ok: note === "", note };
      if (last.ok) return last;
    } catch (e) {
      last = { status: 0, ok: false, note: e.message };
    }
    if (attempt < 2) await sleep(2500);
  }
  return last;
}

/**
 * 冒烟测试：部署完成后逐个真实请求线上。
 * onLine(type, msg) 用于把结果推给 SSE 或打印到终端。
 */
export async function runSmokeTest(onLine = () => {}) {
  const failed = [];
  for (const c of SMOKE_CHECKS) {
    const r = await probe(SITE_ORIGIN + c.path, c.pattern, c.json);
    onLine(r.ok ? "info" : "error",
      `${r.ok ? "✔" : "✖"} ${c.label} ${c.path} → ${r.status || "网络失败"}${r.ok ? "" : `（${r.note}）`}`);
    if (!r.ok) failed.push(`${c.label} ${c.path}${r.status ? `(${r.status})` : ""}`);
    await sleep(300);
  }
  return { ok: failed.length === 0, failed };
}

/* ==================== CLI ==================== */
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const mode = (process.argv[2] || "all").toLowerCase();
  const print = (line) => console.log(line);
  let exitCode = 0;

  if (mode === "gate" || mode === "all") {
    print("🔍 产物闸门（本地 dist，不联网、不部署）");
    const gate = verifyArtifacts();
    for (const c of gate.checks) print(`  ${c.ok ? "✔" : "✖"} ${c.msg}`);
    print(gate.ok ? "✅ 闸门通过，可以部署" : "⛔ 闸门未通过，禁止部署");
    if (!gate.ok) exitCode = 1;
  }

  if ((mode === "smoke" || mode === "all") && exitCode === 0) {
    print(`\n🌐 冒烟测试（线上 ${SITE_ORIGIN}）`);
    const smoke = await runSmokeTest((type, msg) => print(`  ${msg}`));
    print(smoke.ok ? "✅ 冒烟全部通过" : `⚠️ ${smoke.failed.length} 项异常：${smoke.failed.join("、")}`);
    if (!smoke.ok) exitCode = 2;
  }

  process.exit(exitCode);
}
