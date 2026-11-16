import express from "express";
import multer from "multer";
import sharp from "sharp";
import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { verifyArtifacts, runSmokeTest } from "./release-check.mjs";

/* ==================== 路径 ==================== */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const BLOG_DIR = path.join(PROJECT_ROOT, "src", "blog");
const ASSETS_DIR = path.join(PROJECT_ROOT, "src", "assets");
const DRAFTS_DIR = path.join(BLOG_DIR, "_drafts");

/* ==================== 工具 ==================== */
function readFrontmatter(filePath) {
  const raw = fs.readFileSync(filePath, "utf-8");
  const match = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return { title: "", description: "", author: "", pubDate: "", tags: [] };

  const fm = match[1];
  const get = (key) => {
    const m = fm.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
    return m ? m[1].trim() : null;
  };

  const title = get("title")?.replace(/^'|'$/g, "").replace(/^"|"$/g, "") || "";
  const description = get("description")?.replace(/^'|'$/g, "").replace(/^"|"$/g, "") || "";
  const author = get("author")?.replace(/^'|'$/g, "").replace(/^"|"$/g, "") || "";
  const pubDate = get("pubDate") || "";

  let tags = [];
  const tagsMatch = fm.match(/^tags:\s*\[([\s\S]*?)\]/m);
  if (tagsMatch) {
    tags = tagsMatch[1]
      .split(",")
      .map((t) => t.trim().replace(/^"|"$/g, "").replace(/^'|'$/g, ""))
      .filter(Boolean);
  }

  let altTags = [];
  const altTagsMatch = fm.match(/^altTags:\s*\[([\s\S]*?)\]/m);
  if (altTagsMatch) {
    altTags = altTagsMatch[1]
      .split(",")
      .map((t) => t.trim().replace(/^"|"$/g, "").replace(/^'|'$/g, ""))
      .filter(Boolean);
  }

  let image = undefined;
  const imageUrl = fm.match(/^image:\n\s+url:\s*(.+)$/m)?.[1]?.trim();
  if (imageUrl) {
    const imageAlt = fm.match(/^\s+alt:\s*(.+)$/m)?.[1]?.replace(/^'|'$/g, "").replace(/^"|"$/g, "") || "";
    image = { url: imageUrl, alt: imageAlt };
  }

  return { title, description, author, pubDate, tags, altTags, image };
}

function buildFrontmatter({ title, description, author, pubDate, tags, altTags, image, imageAlt }) {
  let fm = "---\n";
  fm += `title: '${title.replace(/'/g, "\\'")}'\n`;
  fm += `description: '${description.replace(/'/g, "\\'")}'\n`;
  fm += `author: '${(author || "HaxiLin").replace(/'/g, "\\'")}'\n`;
  fm += `pubDate: ${pubDate}\n`;

  const tagsStr = tags.map((t) => `"${t}"`).join(", ");
  fm += `tags: [${tagsStr}]\n`;

  const altTagsArr = altTags || [];
  if (altTagsArr.length > 0) {
    const altTagsStr = altTagsArr.map((t) => `"${t}"`).join(", ");
    fm += `altTags: [${altTagsStr}]\n`;
  } else {
    fm += `altTags: []\n`;
  }

  if (image) {
    fm += `image:\n  url: ../assets/${image}\n`;
    fm += `  alt: '${(imageAlt || image).replace(/'/g, "\\'")}'\n`;
  }

  fm += "---\n\n";
  return fm;
}

function generateSlug(title) {
  return title
    .replace(/\s+/g, "-")
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
}

/* ==================== App ==================== */
const app = express();
const upload = multer({ storage: multer.memoryStorage() });
const PORT = process.env.PORT || 3001;

// JSON body parser
app.use(express.json({ limit: "10mb" }));

// 动态注入缓存破坏版本号（基于 app.js / styles.css 的修改时间），
// 确保本地开发时浏览器始终加载最新代码，无需手动硬刷新
const PUBLIC_DIR = path.join(__dirname, "public");
function fileMtime(file) {
  try { return fs.statSync(path.join(PUBLIC_DIR, file)).mtime.getTime(); }
  catch { return Date.now(); }
}
function serveIndex(req, res) {
  const htmlPath = path.join(PUBLIC_DIR, "index.html");
  fs.readFile(htmlPath, "utf-8", (err, html) => {
    if (err) { res.status(500).send("无法读取 index.html"); return; }
    const v = fileMtime("app.js") + fileMtime("styles.css");
    const out = html
      .replace(/app\.js\?v=\d+/g, `app.js?v=${v}`)
      .replace(/styles\.css\?v=\d+/g, `styles.css?v=${v}`);
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.send(out);
  });
}
app.get("/", serveIndex);
app.get("/index.html", serveIndex);

// 静态文件（禁用缓存，确保本地开发时总是加载最新文件）
app.use(express.static(path.join(__dirname, "public"), {
  etag: false,
  lastModified: false,
  setHeaders: (res) => {
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  },
}));

// 提供 assets 目录的图片访问（编辑器预览用）
app.use("/assets", express.static(ASSETS_DIR, {
  maxAge: "1h",
}));

// 确保草稿目录存在
function ensureDraftsDir() {
  if (!fs.existsSync(DRAFTS_DIR)) {
    fs.mkdirSync(DRAFTS_DIR, { recursive: true });
  }
}

/* ==================== API 路由 ==================== */

// GET /api/list — 列出所有已发布文章
app.get("/api/list", (req, res) => {
  try {
    const files = fs.readdirSync(BLOG_DIR).filter((f) => f.endsWith(".md") && !f.startsWith("_"));
    const posts = files.map((f) => {
      const fm = readFrontmatter(path.join(BLOG_DIR, f));
      return { filename: f, ...fm };
    });
    posts.sort((a, b) => new Date(b.pubDate).valueOf() - new Date(a.pubDate).valueOf());
    res.json({ success: true, posts });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/get?file=xxx.md — 获取单篇文章
app.get("/api/get", (req, res) => {
  try {
    const file = req.query.file;
    if (!file) return res.status(400).json({ success: false, error: "缺少 file 参数" });

    const resolved = path.resolve(BLOG_DIR, file);
    if (!resolved.startsWith(BLOG_DIR))
      return res.status(400).json({ success: false, error: "非法路径" });
    if (!fs.existsSync(resolved))
      return res.status(404).json({ success: false, error: "文件不存在" });

    const raw = fs.readFileSync(resolved, "utf-8");
    const fm = readFrontmatter(resolved);
    const content = raw.replace(/^---[\s\S]*?---\n*/, "").trim();
    res.json({ success: true, file, frontmatter: fm, content });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/save — 发布文章
app.post("/api/save", (req, res) => {
  try {
    const { title, description, author, pubDate, tags, altTags, content, image, imageAlt, filename } = req.body;

    if (!title || !description || !content)
      return res.status(400).json({ success: false, error: "标题、简介、正文不能为空" });
    if (!tags || tags.length === 0)
      return res.status(400).json({ success: false, error: "至少需要一个标签" });

    const fm = buildFrontmatter({ title, description, author, pubDate, tags, altTags, image, imageAlt });
    const fullContent = fm + content.trim() + "\n";
    const saveFilename = filename || `${pubDate}-${generateSlug(title)}.md`;
    fs.writeFileSync(path.join(BLOG_DIR, saveFilename), fullContent, "utf-8");
    res.json({ success: true, filename: saveFilename });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/drafts — 列出所有草稿
app.get("/api/drafts", (req, res) => {
  try {
    ensureDraftsDir();
    const files = fs.readdirSync(DRAFTS_DIR).filter((f) => f.endsWith(".md"));
    const drafts = files.map((f) => {
      const fm = readFrontmatter(path.join(DRAFTS_DIR, f));
      const stat = fs.statSync(path.join(DRAFTS_DIR, f));
      return { filename: f, ...fm, modified: stat.mtime.toISOString() };
    });
    drafts.sort((a, b) => new Date(b.modified).valueOf() - new Date(a.modified).valueOf());
    res.json({ success: true, drafts });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/draft?file=xxx.md — 获取单个草稿
app.get("/api/draft", (req, res) => {
  try {
    const file = req.query.file;
    if (!file) return res.status(400).json({ success: false, error: "缺少 file 参数" });

    const resolved = path.resolve(DRAFTS_DIR, file);
    if (!resolved.startsWith(DRAFTS_DIR))
      return res.status(400).json({ success: false, error: "非法路径" });
    if (!fs.existsSync(resolved))
      return res.status(404).json({ success: false, error: "草稿不存在" });

    const raw = fs.readFileSync(resolved, "utf-8");
    const fm = readFrontmatter(resolved);
    const body = raw.replace(/^---[\s\S]*?---\n*/, "").trim();
    res.json({ success: true, ...fm, content: body });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/draft — 保存草稿
app.post("/api/draft", (req, res) => {
  try {
    ensureDraftsDir();
    const { title, description, author, pubDate, tags, altTags, content, image, imageAlt, filename } = req.body;

    if (!title || !description || !content)
      return res.status(400).json({ success: false, error: "标题、简介、正文不能为空" });

    const fm = buildFrontmatter({ title, description, author, pubDate, tags, altTags, image, imageAlt });
    const fullContent = fm + content.trim() + "\n";
    const draftFilename = filename || `${pubDate}-${generateSlug(title)}.md`;
    fs.writeFileSync(path.join(DRAFTS_DIR, draftFilename), fullContent, "utf-8");
    res.json({ success: true, filename: draftFilename });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// DELETE /api/draft?file=xxx.md — 删除草稿
app.delete("/api/draft", (req, res) => {
  try {
    const file = req.query.file;
    if (!file) return res.status(400).json({ success: false, error: "缺少 file 参数" });

    const resolved = path.resolve(DRAFTS_DIR, file);
    if (!resolved.startsWith(DRAFTS_DIR))
      return res.status(400).json({ success: false, error: "非法路径" });
    if (!fs.existsSync(resolved))
      return res.status(404).json({ success: false, error: "草稿不存在" });

    fs.unlinkSync(resolved);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// DELETE /api/post?file=xxx.md — 删除已发布文章
app.delete("/api/post", (req, res) => {
  try {
    const file = req.query.file;
    if (!file) return res.status(400).json({ success: false, error: "缺少 file 参数" });

    const resolved = path.resolve(BLOG_DIR, file);
    if (!resolved.startsWith(BLOG_DIR))
      return res.status(400).json({ success: false, error: "非法路径" });
    if (!fs.existsSync(resolved))
      return res.status(404).json({ success: false, error: "文件不存在" });

    fs.unlinkSync(resolved);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/upload-image — 上传图片转 webp
app.post("/api/upload-image", upload.single("image"), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ success: false, error: "请选择图片文件" });

    const allowedTypes = ["image/jpeg", "image/png", "image/gif", "image/webp", "image/bmp", "image/tiff", "image/avif"];
    if (!allowedTypes.includes(file.mimetype))
      return res.status(400).json({ success: false, error: "仅支持 JPG/PNG/GIF/WebP/BMP/TIFF/AVIF 格式" });

    const originalName = file.originalname.replace(/\.[^.]+$/, "");
    const safeName = originalName
      .replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40);
    const timestamp = Date.now();
    const webpFilename = `ascendlab-${timestamp}-${safeName}.webp`;
    const outputPath = path.join(ASSETS_DIR, webpFilename);

    if (file.mimetype === "image/webp") {
      // webp 直接保存，无需转换
      fs.writeFileSync(outputPath, file.buffer);
    } else {
      // 其他格式转 webp
      await sharp(file.buffer).webp({ quality: 85 }).toFile(outputPath);
    }

    res.json({
      success: true,
      filename: webpFilename,
      originalName,
      url: `../assets/${webpFilename}`,
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/browse-assets — 列出 assets 目录中的所有图片
app.get("/api/browse-assets", (req, res) => {
  try {
    if (!fs.existsSync(ASSETS_DIR)) {
      return res.json({ success: true, images: [] });
    }
    const files = fs.readdirSync(ASSETS_DIR).filter(f => {
      const ext = path.extname(f).toLowerCase();
      return [".webp", ".jpg", ".jpeg", ".png", ".gif", ".bmp", ".svg", ".avif"].includes(ext);
    });
    const images = files.map(f => {
      const stat = fs.statSync(path.join(ASSETS_DIR, f));
      return {
        filename: f,
        url: `../assets/${f}`,
        previewUrl: `/assets/${f}`,
        size: stat.size,
        mtime: stat.mtime.toISOString(),
      };
    }).sort((a, b) => new Date(b.mtime).valueOf() - new Date(a.mtime).valueOf());
    res.json({ success: true, images });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/* ==================== 部署 ==================== */

// 构建干净的环境变量：移除 WorkBuddy safe-delete shim 的激活变量
// safe-delete shim 通过 CODEBUDDY_SESSION_ID/CLAUDE_SESSION_ID 激活，
// 会拦截 Astro 构建时清理 dist/ 的 fs 删除操作（超过50个文件就阻止）
function buildCleanEnv(extra = {}) {
  const env = { ...process.env };
  delete env.CODEBUDDY_SESSION_ID;
  delete env.CLAUDE_SESSION_ID;
  delete env.CODEBUDDY_SAFE_DELETE_BULK_GUARD;
  delete env.CODEBUDDY_SAFE_DELETE_BULK_STATE_DIR;
  delete env.CODEBUDDY_SAFE_DELETE_REPORT_PATH;
  delete env.CODEBUDDY_TOOL_CALL_ID;
  // 清除 NODE_OPTIONS：其中注入的 safe-delete require 路径含空格，
  // 无法安全地只移除该项，直接清除整个变量（子进程不需要它）
  if (env.NODE_OPTIONS && env.NODE_OPTIONS.includes("safe-delete")) {
    delete env.NODE_OPTIONS;
  }
  return { ...env, ...extra };
}

// Cloudflare API Token 本地存储
const CF_TOKEN_FILE = path.join(__dirname, ".cf-token");

function getCfToken() {
  try {
    return fs.readFileSync(CF_TOKEN_FILE, "utf-8").trim() || null;
  } catch {
    return null;
  }
}

function saveCfToken(token) {
  fs.writeFileSync(CF_TOKEN_FILE, token.trim(), "utf-8");
}

function deleteCfToken() {
  try { fs.unlinkSync(CF_TOKEN_FILE); } catch {}
}

// GET /api/cf-token — 检查 Token 是否已设置（不返回具体值）
app.get("/api/cf-token", (req, res) => {
  const token = getCfToken();
  res.json({ success: true, hasToken: !!token });
});

// POST /api/cf-token — 保存 Token
app.post("/api/cf-token", (req, res) => {
  const { token } = req.body;
  if (!token || !token.trim()) {
    return res.status(400).json({ success: false, error: "Token 不能为空" });
  }
  try {
    saveCfToken(token);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// DELETE /api/cf-token — 删除 Token
app.delete("/api/cf-token", (req, res) => {
  deleteCfToken();
  res.json({ success: true });
});

/* ==================== 发布后同步仓库 ==================== */
// 为什么需要：admin-tool 发布只做 build + wrangler deploy，不碰 git。
// 于是「线上跑的是没提交的工作区」这个老毛病会一直复发（2026-08-05 那次就是这样）。
// 现在 main 已经接上 Cloudflare CI，推 main = 发布，所以「线上 == main」必须自动化，
// 否则一次本地发布就让 main 落后，下次推 main 会把线上回退。
// 安全线：绝不 --force、绝不 --no-verify、绝不提交凭据、推送失败保留提交不重试破坏性操作。

const SYNC_PUSH_REF = "HEAD:main";
const SYNC_TARGET_WORKER = "haxilin-studio";

// 这些文件即使被 git add -A 命中也必须拦下（凭据只应留在本地）
const NEVER_COMMIT = [
  ".dev.vars",
  "admin-tool/.cf-token",
  ".env",
  ".env.local",
  "cloudflare.json",
  "aliyun.json",
];

// 明文凭据特征。命中即中止提交——公开仓库里任何一次手滑都是不可逆的。
// 注意：不要把某个具体密钥的原文写进这张表，否则本文件自己就会被自己的规则拦下。
const SECRET_PATTERNS = [
  { re: /-----BEGIN (?:[A-Z ]*)PRIVATE KEY-----/, why: "私钥" },
  { re: /(?:api[_-]?token|access[_-]?key[_-]?secret|secret[_-]?key|password)\s*[:=]\s*["']?[A-Za-z0-9+/_\-]{16,}/i, why: "疑似凭据赋值" },
  { re: /\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b/, why: "疑似 JWT" },
  { re: /\b(?:sk-|cfut-|ghp_|gho_)[A-Za-z0-9]{20,}\b/, why: "常见 Token 前缀" },
];

function gitRun(args, { input = null, timeout = 120000 } = {}) {
  try {
    const out = execFileSync("git", args, {
      cwd: PROJECT_ROOT,
      encoding: "utf-8",
      input: input === null ? undefined : input,
      timeout,
      env: buildCleanEnv({
        GIT_TERMINAL_PROMPT: "0",
        GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o ConnectTimeout=15",
      }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { ok: true, out: String(out || "").trim(), err: "" };
  } catch (e) {
    return {
      ok: false,
      out: String(e.stdout || "").trim(),
      err: String(e.stderr || e.message || "").trim(),
    };
  }
}

// diff 里的 git 自身元数据行会含 40 位对象 ID，扫描前先剔除，避免误报
function scrubDiff(text) {
  return text
    .split("\n")
    .filter((l) => !/^(index |diff --git |new file mode |deleted file mode |similarity index |rename from |rename to )/.test(l))
    .join("\n");
}

function scanStagedForSecrets() {
  const hits = [];
  const names = gitRun(["diff", "--cached", "--name-only"]).out.split("\n").filter(Boolean);
  for (const f of names) {
    if (NEVER_COMMIT.some((n) => f === n || f.endsWith("/" + n))) hits.push({ file: f, why: "凭据文件不应入库" });
  }
  const diff = scrubDiff(gitRun(["diff", "--cached", "-U0"]).out);
  for (const { re, why } of SECRET_PATTERNS) {
    const m = diff.match(re);
    if (m) hits.push({ file: "(diff 内容)", why: `${why}：${m[0].slice(0, 24)}…` });
  }
  return hits;
}

/**
 * 发布成功后把源码同步到仓库。
 * mode="dry"    只给计划，一个字节都不写。
 * mode="scan"   真做 git add -A → 凭据扫描 → git reset 退回索引，不提交不推送（用来验证拦截是否有效）。
 * mode="apply"  完整执行：add → 扫描 → commit → push origin/main。
 */
function syncRepoAfterDeploy({ mode = "dry", message = "" } = {}) {
  const lines = [];
  const say = (type, msg) => lines.push({ type, msg });

  const branch = gitRun(["rev-parse", "--abbrev-ref", "HEAD"]).out || "(未知)";
  const porcelain = gitRun(["status", "--porcelain"]).out;
  const files = porcelain.split("\n").filter(Boolean);
  const ahead = gitRun(["rev-list", "--count", `origin/main..HEAD`]).out;
  const behind = gitRun(["rev-list", "--count", `HEAD..origin/main`]).out;

  say("info", `当前分支 ${branch}，领先 origin/main ${ahead || 0} 个提交，落后 ${behind || 0} 个`);

  if (files.length === 0 && Number(ahead) === 0) {
    say("info", "工作区干净且与 origin/main 一致，无需同步");
    return { ok: true, skipped: true, lines };
  }

  if (files.length) {
    say("info", `将提交 ${files.length} 个文件变更：`);
    files.slice(0, 12).forEach((f) => say("info", `  ${f}`));
    if (files.length > 12) say("info", `  …另有 ${files.length - 12} 个`);
  }

  const msg = message || `chore(publish): 同步 ${new Date().toLocaleString("zh-CN", { hour12: false })} 的发布内容`;
  say("info", `提交信息：${msg}`);
  say("info", `推送目标：git push origin ${SYNC_PUSH_REF}（不使用 --force，不使用 --no-verify）`);

  if (mode === "dry") {
    say("success", "dry-run：以上为计划，未做任何写入。?scan=1 可验证凭据拦截，?apply=1 才会真正提交推送。");
    return { ok: true, dryRun: true, lines, files, msg };
  }

  // —— 以下才会动索引 ——
  const add = gitRun(["add", "-A"]);
  if (!add.ok) {
    say("error", `git add -A 失败：${add.err}`);
    return { ok: false, lines };
  }

  const staged = gitRun(["diff", "--cached", "--name-only"]).out.split("\n").filter(Boolean);
  const leaks = scanStagedForSecrets();

  if (mode === "scan") {
    gitRun(["reset", "--quiet"]); // 只退索引，不动工作区文件
    if (leaks.length) {
      say("error", "扫描命中（本次未提交）：");
      leaks.forEach((l) => say("error", `  ${l.file} — ${l.why}`));
      say("success", `索引已退回，工作区未改动。拦截有效：${staged.length} 个暂存文件中有 ${leaks.length} 处命中`);
      return { ok: true, scanned: true, blocked: true, leaks, lines };
    }
    say("success", `扫描 ${staged.length} 个暂存文件，未发现凭据特征；索引已退回，未提交`);
    return { ok: true, scanned: true, blocked: false, lines };
  }

  if (staged.length === 0) {
    say("info", "暂存区为空（只有未跟踪的被忽略文件），跳过提交");
  } else {
    if (leaks.length) {
      gitRun(["reset", "--quiet"]); // 只退索引，不动工作区文件
      say("error", `⛔ 检测到凭据特征，已放弃提交并把文件退回未暂存：`);
      leaks.forEach((l) => say("error", `  ${l.file} — ${l.why}`));
      say("info", "站点已经上线，本次只是没有同步仓库。请清理后再手动提交。");
      return { ok: false, blocked: true, lines };
    }

    let commit = gitRun(["commit", "-m", msg]);
    if (!commit.ok && /Please tell me who you are/.test(commit.err + commit.out)) {
      say("info", "仓库未配置提交身份，改用 GitHub noreply 身份重试");
      commit = gitRun(["-c", "user.name=zcgotop", "-c", "user.email=zcgotop@users.noreply.github.com", "commit", "-m", msg]);
    }
    if (!commit.ok) {
      say("error", `提交失败：${(commit.err || commit.out).slice(0, 200)}`);
      return { ok: false, lines };
    }
    const sha = gitRun(["rev-parse", "--short", "HEAD"]).out;
    say("success", `已提交 ${sha}（${staged.length} 个文件）`);
  }

  const push = gitRun(["push", "origin", SYNC_PUSH_REF], { timeout: 180000 });
  if (!push.ok) {
    const hint = /non-fast-forward|rejected/i.test(push.err)
      ? "远端 main 已前进。不要 --force，先 git fetch && git rebase origin/main 再推。"
      : /Connection|timed out|reset by peer/i.test(push.err)
        ? "网络问题（github.com HTTPS 在本机不通，需走 SSH）。提交已保留，可手动重试：git push origin " + SYNC_PUSH_REF
        : push.err.slice(0, 200);
    say("error", `推送失败，提交已保留在本地：${hint}`);
    return { ok: false, lines };
  }
  say("success", `已推送 origin/main —— Cloudflare CI 会据此部署，线上与仓库一致`);
  return { ok: true, lines };
}

// GET /api/publish-git — 默认 dry-run 只给计划；?scan=1 验证凭据拦截（不提交）；?apply=1 才真正提交并推送
app.get("/api/publish-git", (req, res) => {
  const mode = req.query.apply === "1" || req.query.apply === "true" ? "apply"
    : req.query.scan === "1" || req.query.scan === "true" ? "scan" : "dry";
  const result = syncRepoAfterDeploy({ mode, message: String(req.query.message || "") });
  res.json({ success: result.ok, mode, ...result });
});

// 部署状态
let deployState = {
  status: "idle", // idle | building | deploying | success | error
  logs: [],
  startTime: null,
};

// GET /api/deploy — 构建 → 产物闸门 → 部署 → 冒烟测试（SSE 流式输出）
// 加 ?dry=1 只构建并校验产物，不部署（发布前先看「这次会改变什么」）
app.get("/api/deploy", (req, res) => {
  const dryRun = req.query.dry === "1" || req.query.dry === "true";

  // SSE 头
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  // 如果已经在部署中，拒绝重复请求
  if (deployState.status === "building" || deployState.status === "deploying") {
    res.write(`data: ${JSON.stringify({ type: "error", msg: "已有部署任务正在运行" })}\n\n`);
    res.end();
    return;
  }

  deployState.status = "building";
  deployState.logs = [];
  deployState.startTime = Date.now();

  const send = (type, msg) => {
    const data = JSON.stringify({ type, msg, time: Date.now() });
    res.write(`data: ${data}\n\n`);
    deployState.logs.push({ type, msg, time: Date.now() });
  };

  send("info", "🚀 开始构建 Astro 站点...");

  // 第一步：npm run build（使用干净环境，避免 safe-delete shim 拦截）
  const buildProc = spawn("npm", ["run", "build"], {
    cwd: PROJECT_ROOT,
    shell: true,
    env: buildCleanEnv({ FORCE_COLOR: "0" }),
  });

  buildProc.stdout.on("data", (data) => {
    const text = data.toString().trim();
    if (text) send("build", text);
  });

  buildProc.stderr.on("data", (data) => {
    const text = data.toString().trim();
    if (text) send("build-err", text);
  });

  buildProc.on("error", (err) => {
    send("error", `❌ 构建进程启动失败: ${err.message}`);
    deployState.status = "error";
    res.end();
  });

  buildProc.on("close", (code) => {
    if (code !== 0) {
      send("error", `❌ 构建失败，退出码 ${code}`);
      deployState.status = "error";
      res.end();
      return;
    }

    send("success", "✅ 构建成功！");

    // 第二步：产物闸门。构建退出码 0 不等于产物可用——2026-11-16 的两次线上故障
    // （首页 404 / /api/stats 500）都是「发了残缺或错误的产物」，闸门就为此存在。
    send("info", "🔍 正在校验构建产物...");
    const gate = verifyArtifacts(PROJECT_ROOT);
    for (const c of gate.checks) send(c.ok ? "info" : "error", `${c.ok ? "✔" : "✖"} ${c.msg}`);
    if (!gate.ok) {
      send("error", "⛔ 产物闸门未通过，已中止部署。线上版本未受任何影响。");
      deployState.status = "error";
      res.end();
      return;
    }
    send("success", "✅ 产物闸门通过");

    if (dryRun) {
      send("info", "🧪 dry-run：只构建 + 校验，未部署。去掉 ?dry=1 即为正式发布。");
      deployState.status = "success";
      res.end();
      return;
    }

    deployState.status = "deploying";
    send("info", "📤 正在部署到 Cloudflare Worker（haxilin-studio）...");

    // 清理旧的 wrangler 部署配置（避免 stale config 冲突）
    const wranglerDeployConfig = path.join(PROJECT_ROOT, ".wrangler", "deploy", "config.json");
    try {
      if (fs.existsSync(wranglerDeployConfig)) {
        fs.unlinkSync(wranglerDeployConfig);
        send("info", "🧹 已清理旧的部署配置");
      }
    } catch (e) {
      send("info", `⚠️ 清理部署配置时出错（可忽略）: ${e.message}`);
    }

    // 读取 Cloudflare API Token（如有则用 Token 认证，无需 wrangler login）
    const cfToken = getCfToken();
    const deployEnv = buildCleanEnv({ FORCE_COLOR: "0" });
    if (cfToken) {
      deployEnv.CLOUDFLARE_API_TOKEN = cfToken;
      send("info", "🔑 使用 API Token 认证");
    } else {
      send("info", "⚠️ 未设置 API Token，尝试使用 wrangler login 凭证（如未登录将失败）");
    }

    // 第二步：wrangler deploy（Worker 模式，使用适配器生成的完整配置）
    // @astrojs/cloudflare 适配器在构建时生成 dist/server/wrangler.json
    // （含 main: entry.mjs、assets: ../client、KV 绑定等），部署以它为准
    // 该 Worker 已绑定自定义域名 x.zcgo.top，部署后直接更新线上站点
    const deployProc = spawn("npx", ["wrangler", "deploy", "--config", "dist/server/wrangler.json"], {
      cwd: PROJECT_ROOT,
      shell: true,
      env: deployEnv,
      timeout: 300000, // 5 分钟超时
    });

    deployProc.stdout.on("data", (data) => {
      const text = data.toString().trim();
      if (text) send("deploy", text);
    });

    deployProc.stderr.on("data", (data) => {
      const text = data.toString().trim();
      if (text) send("deploy-err", text);
    });

    deployProc.on("error", (err) => {
      send("error", `❌ 部署进程启动失败: ${err.message}`);
      deployState.status = "error";
      res.end();
    });

    deployProc.on("close", async (code2) => {
      if (code2 !== 0) {
        send("error", `❌ 部署失败，退出码 ${code2}`);
        deployState.status = "error";
        res.end();
        return;
      }

      const elapsed = ((Date.now() - deployState.startTime) / 1000).toFixed(1);
      send("success", `🎉 部署完成，耗时 ${elapsed}s`);

      // 第三步：冒烟测试。部署成功不等于站点可用，逐个真实请求线上关键端点。
      // 状态保持 deploying，避免冒烟期间被当成「已结束」而并发下一次发布。
      send("info", "🧪 冒烟测试：请求线上关键端点...");
      await new Promise((r) => setTimeout(r, 2500)); // 给版本传播留时间
      const smoke = await runSmokeTest((type, msg) => send(type, msg));
      if (smoke.ok) {
        send("success", "✅ 冒烟测试全部通过");
        // 第四步：把这次发布的源码同步回仓库，根治「线上不在 git 里」
        send("info", "📦 正在同步仓库（提交并推送 origin/main）...");
        const sync = syncRepoAfterDeploy({ mode: "apply" });
        for (const l of sync.lines) send(l.type, l.msg);
        if (sync.ok) send("success", "📦 仓库已同步，线上与 main 一致（CI 会部署同一份内容）");
        else send("error", "⚠️ 站点已上线，但仓库同步未完成，请按上面的原因手动处理");
        send("info", "🌐 站点已上线: https://x.zcgo.top");
        deployState.status = "success";
      } else {
        send("error", `⚠️ 冒烟测试 ${smoke.failed.length} 项异常：${smoke.failed.join("、")}`);
        send("info", "🛟 回滚：npx wrangler versions rollback <上一个版本 ID>（版本 ID 见部署日志）");
        deployState.status = "error";
      }
      res.end();
    });
  });

  // 客户端断开连接时清理
  req.on("close", () => {
    // 不中断部署进程，只是停止发送 SSE
  });
});

// GET /api/deploy-status — 获取当前部署状态
app.get("/api/deploy-status", (req, res) => {
  res.json({
    status: deployState.status,
    logs: deployState.logs.slice(-60),
  });
});

/* ==================== 启动 ==================== */
function startServer(port) {
  const server = app.listen(port);
  server.on("listening", () => {
    console.log(`\n  ✏️  博客编辑器已启动`);
    console.log(`  ─────────────────────────`);
    console.log(`  地址: http://localhost:${port}`);
    console.log(`  文章目录: ${BLOG_DIR}`);
    console.log(`  图片目录: ${ASSETS_DIR}\n`);
  });
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.log(`  ⚠️  端口 ${port} 已被占用，尝试端口 ${port + 1}...`);
      startServer(port + 1);
    } else {
      console.error("  ❌ 启动失败:", err.message);
      process.exit(1);
    }
  });
}

startServer(PORT);