// 服务端代理：从 umami 拉取本站 30 天访问统计
// 用 umami 自带的 Website Share 机制（免账号、免 admin session token）。
// shareId 在 umami 后台 "Website → Share" 启用后生成，永不过期，可随时撤销。
//
// 认证流程：
//   1. GET /api/share/{shareId}  → 返回 { token: <JWT>, shareId: <uuid>, ... }
//   2. GET /api/websites/{wid}/stats  + 两个 header:
//        x-umami-share-token:   <JWT>
//        x-umami-share-context: <shareId (短或 UUID 都行)>
//
// JWT 不带 exp 字段，理论上永不过期；但每次冷启动都重新拿一次 JWT，
// 这样即便 umami 后台撤销/重新启用 Share，也能自适应。
export const prerender = false;

const UMAMI_BASE = "https://umami.zcgo.top";
const WEBSITE_ID = "1d73d696-35c2-4d95-9e6a-3401713004c9";
const SHARE_ID = "r1SYxjBt0NcOG5ch";

// isolate 内缓存 JWT，避免每次请求都打 /api/share
let cachedJwt = null;
let cachedJwtAt = 0;
const JWT_CACHE_MS = 6 * 3600 * 1000; // 6 小时，远短于 JWT 实际寿命

async function getShareJwt() {
  if (cachedJwt && Date.now() - cachedJwtAt < JWT_CACHE_MS) {
    return cachedJwt;
  }
  const resp = await fetch(`${UMAMI_BASE}/api/share/${SHARE_ID}`, {
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
  return cachedJwt;
}

export async function GET() {
  const endAt = Date.now();
  const startAt = endAt - 30 * 86400000;

  try {
    const jwt = await getShareJwt();
    const res = await fetch(
      `${UMAMI_BASE}/api/websites/${WEBSITE_ID}/stats?startAt=${startAt}&endAt=${endAt}`,
      {
        headers: {
          "x-umami-share-token": jwt,
          "x-umami-share-context": SHARE_ID,
          Accept: "application/json",
          "User-Agent": "haxilin-astro/1.0",
        },
      }
    );

    if (!res.ok) {
      // JWT 失效或 umami 抖动，清缓存让下次重拿
      cachedJwt = null;
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
      { error: "unavailable", reason: String(err.message || err).slice(0, 200), range: "30d" },
      200,
      { "Cache-Control": "public, max-age=60" }
    );
  }
}

function json(obj, status, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...extra },
  });
}
