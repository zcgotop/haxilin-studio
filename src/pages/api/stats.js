// 服务端代理：从 umami 拉取本站 30 天访问统计
// 用 umami 自带的 Website Share 机制（免账号、免 admin session token）。
//
// 凭据来自 Worker secret，不写进源码（仓库是 PUBLIC）：
//   生产：wrangler secret put UMAMI_SHARE_ID
//   本地：.dev.vars（已被 .gitignore 忽略）
//
// 注意：Astro v6 起 `locals.runtime.env` 已被移除（访问即抛错），
// Cloudflare 环境变量的正确取法是 `import { env } from "cloudflare:workers"`。
export const prerender = false;

import { env as cfEnv } from "cloudflare:workers";

const UMAMI_BASE = "https://umami.zcgo.top";
// Website ID 不是凭据（Umami 控制台 URL 里就有），留默认值方便本地跑，仍可用 env 覆盖。
const DEFAULT_WEBSITE_ID = "1d73d696-35c2-4d95-9e6a-3401713004c9";

let cachedJwt = null;
let cachedJwtAt = 0;
let cachedJwtFor = null;
const JWT_CACHE_MS = 6 * 3600 * 1000; // 6 小时，远短于 JWT 实际寿命

function resolveEnv() {
  try {
    if (cfEnv && typeof cfEnv === "object") return { env: cfEnv, from: "cloudflare:workers" };
  } catch {
    /* 本地 dev 或非 workerd 环境下取不到，走下面的兜底 */
  }
  return { env: {}, from: null };
}

async function getShareJwt(shareId) {
  if (cachedJwt && cachedJwtFor === shareId && Date.now() - cachedJwtAt < JWT_CACHE_MS) {
    return cachedJwt;
  }
  const resp = await fetch(`${UMAMI_BASE}/api/share/${encodeURIComponent(shareId)}`, {
    headers: { Accept: "application/json" },
  });
  if (!resp.ok) {
    throw new Error(`/api/share responded ${resp.status}`);
  }
  const data = await resp.json();
  if (!data.token) {
    throw new Error("/api/share did not return a token");
  }
  cachedJwt = data.token;
  cachedJwtAt = Date.now();
  cachedJwtFor = shareId;
  return cachedJwt;
}

export async function GET() {
  try {
    const { env, from } = resolveEnv();
    const shareId = env.UMAMI_SHARE_ID;
    const websiteId = env.UMAMI_WEBSITE_ID || DEFAULT_WEBSITE_ID;

    if (!shareId) {
      return json(
        { error: "misconfigured", envSource: from, range: "30d" },
        200,
        { "Cache-Control": "no-store" }
      );
    }

    const endAt = Date.now();
    const startAt = endAt - 30 * 86400000;
    const jwt = await getShareJwt(shareId);
    const res = await fetch(
      `${UMAMI_BASE}/api/websites/${websiteId}/stats?startAt=${startAt}&endAt=${endAt}`,
      {
        headers: {
          "x-umami-share-token": jwt,
          "x-umami-share-context": shareId,
          Accept: "application/json",
          "User-Agent": "haxilin-astro/1.0",
        },
      }
    );

    if (!res.ok) {
      // JWT 失效或 umami 抖动，清缓存让下次重拿
      cachedJwt = null;
      cachedJwtFor = null;
      return json(
        { error: "unavailable", status: res.status, range: "30d" },
        200,
        { "Cache-Control": "public, max-age=60" }
      );
    }

    const data = await res.json();
    return json(
      {
        pageviews: data.pageviews ?? 0,
        visitors: data.visitors ?? 0,
        visits: data.visits ?? 0,
        bounces: data.bounces ?? 0,
        totaltime: data.totaltime ?? 0,
        range: "30d",
      },
      200,
      { "Cache-Control": "public, max-age=300" }
    );
  } catch (err) {
    return json(
      {
        error: "exception",
        name: err && err.name,
        message: String((err && err.message) || err).slice(0, 300),
        range: "30d",
      },
      200,
      { "Cache-Control": "no-store" }
    );
  }
}

function json(obj, status, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...extra },
  });
}
