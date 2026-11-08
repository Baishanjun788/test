/**
 * 小号获取 · 服务端转发
 *
 * 作用：
 *   浏览器受同源策略/CORS 限制，无法直接调用 https://api.4399pc.cc/claim_by_key
 *   （该接口对带 Origin 头的请求返回 403，且不响应 OPTIONS 预检）。
 *   本服务运行在服务器上，由它代为请求上游接口，再把结果返回给浏览器。
 *   服务器之间的请求不经过浏览器的 CORS 检查，因此可以正常拿到数据。
 *
 * 特点：
 *   - 零第三方依赖，只需要 Node.js 18+（内置 fetch）
 *   - 静态托管 public/ 目录下的网页
 *   - 提供 /api/claim 转发接口
 *   - 可选访问口令（设置 ACCESS_TOKEN 后生效）
 *   - 简单的按 IP 限速
 *   - API Key 保存在服务端，不暴露给前端
 */

"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

/* ------------------------------------------------------------------ */
/* 配置（可用环境变量覆盖）                                             */
/* ------------------------------------------------------------------ */

const CONFIG = {
  PORT: parseInt(process.env.PORT || "8787", 10),
  HOST: process.env.HOST || "0.0.0.0",

  // 上游接口
  UPSTREAM: process.env.UPSTREAM || "https://api.4399pc.cc/claim_by_key",

  // 两套 API Key。前端只传 api1 / api2 这个标识，真实 Key 始终留在服务端。
  API_KEYS: {
    api1: process.env.API_KEY_1 || "aku_6648b8a4a0204d6168e180086b206ac47d96a29e",
    api2: process.env.API_KEY_2 || "aku_b625effc303427b2e8ae1dd817756ad38717f639",
  },

  // 访问口令：留空表示不校验。设置后，前端需要输入相同口令才能使用。
  // 建议公网部署时务必设置，避免别人白嫖你的额度。
  ACCESS_TOKEN: process.env.ACCESS_TOKEN || "",

  // 单个 IP 的限速：LIMIT_WINDOW_MS 时间窗口内最多 LIMIT_MAX 次
  LIMIT_WINDOW_MS: parseInt(process.env.LIMIT_WINDOW_MS || "60000", 10),
  LIMIT_MAX: parseInt(process.env.LIMIT_MAX || "10", 10),

  // 请求上游的超时时间
  UPSTREAM_TIMEOUT_MS: parseInt(process.env.UPSTREAM_TIMEOUT_MS || "25000", 10),

  // 允许的跨域来源，* 表示全部（部署在同域下时用不到）
  CORS_ORIGIN: process.env.CORS_ORIGIN || "*",
};

const PUBLIC_DIR = path.join(__dirname, "public");

/* ------------------------------------------------------------------ */
/* 工具函数                                                            */
/* ------------------------------------------------------------------ */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
};

function log(...args) {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.log(`[${ts}]`, ...args);
}

function sendJson(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": CONFIG.CORS_ORIGIN,
    "Access-Control-Allow-Headers": "Content-Type, X-Access-Token",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  });
  res.end(body);
}

function getClientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length) return fwd.split(",")[0].trim();
  if (req.headers["cf-connecting-ip"]) return String(req.headers["cf-connecting-ip"]);
  if (req.headers["x-real-ip"]) return String(req.headers["x-real-ip"]);
  return (req.socket && req.socket.remoteAddress) || "unknown";
}

/* ------------------------------------------------------------------ */
/* 限速                                                                */
/* ------------------------------------------------------------------ */

const rateBuckets = new Map(); // ip -> { count, resetAt }

function rateLimited(ip) {
  const now = Date.now();
  let b = rateBuckets.get(ip);

  if (!b || now >= b.resetAt) {
    b = { count: 0, resetAt: now + CONFIG.LIMIT_WINDOW_MS };
    rateBuckets.set(ip, b);
  }

  b.count += 1;

  // 周期清理，防止 Map 无限增长
  if (rateBuckets.size > 5000) {
    for (const [k, v] of rateBuckets) {
      if (now >= v.resetAt) rateBuckets.delete(k);
    }
  }

  if (b.count > CONFIG.LIMIT_MAX) {
    return { limited: true, retryAfter: Math.ceil((b.resetAt - now) / 1000) };
  }
  return { limited: false, remaining: Math.max(CONFIG.LIMIT_MAX - b.count, 0) };
}

/* ------------------------------------------------------------------ */
/* 读取请求体                                                          */
/* ------------------------------------------------------------------ */

function readBody(req, limitBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/* ------------------------------------------------------------------ */
/* 核心：转发到上游接口                                                */
/* ------------------------------------------------------------------ */

async function claimFromUpstream(apiKey) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.UPSTREAM_TIMEOUT_MS);

  try {
    const upstreamRes = await fetch(CONFIG.UPSTREAM, {
      method: "POST",
      // 关键：不携带浏览器语义的 Origin / Referer，上游才不会拒绝
      headers: {
        "X-API-Key": apiKey,
        "Accept": "application/json",
        "User-Agent": "xiaohao-server/1.0",
      },
      signal: controller.signal,
    });

    const text = await upstreamRes.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch (_) {
      body = null;
    }

    return {
      ok: upstreamRes.ok,
      status: upstreamRes.status,
      retryAfter: upstreamRes.headers.get("retry-after"),
      body,
      text,
    };
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/* 静态文件                                                            */
/* ------------------------------------------------------------------ */

function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split("?")[0]);
  if (rel === "/" || rel === "") rel = "/index.html";

  // 目录穿越防护
  const safePath = path.normalize(rel).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(PUBLIC_DIR, safePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("403 Forbidden");
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("404 Not Found");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const type = MIME[ext] || "application/octet-stream";

    res.writeHead(200, {
      "Content-Type": type,
      "Content-Length": stat.size,
      "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=3600",
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

/* ------------------------------------------------------------------ */
/* 服务入口                                                            */
/* ------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  // CORS 预检
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": CONFIG.CORS_ORIGIN,
      "Access-Control-Allow-Headers": "Content-Type, X-Access-Token",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Max-Age": "86400",
    });
    res.end();
    return;
  }

  /* ---------------- 健康检查 ---------------- */
  if (pathname === "/healthz") {
    sendJson(res, 200, {
      ok: true,
      service: "xiaohao-server",
      upstream: CONFIG.UPSTREAM,
      tokenRequired: Boolean(CONFIG.ACCESS_TOKEN),
      apis: Object.keys(CONFIG.API_KEYS),
    });
    return;
  }

  /* ---------------- 转发接口 ---------------- */
  if (pathname === "/api/claim") {
    if (req.method !== "POST") {
      sendJson(res, 405, { code: 0, msg: "method not allowed, use POST" });
      return;
    }

    const ip = getClientIp(req);

    // 请求体只读一次（流只能消费一次），口令与 api 标识都从这里取
    let payload = {};
    try {
      const raw = await readBody(req);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") payload = parsed;
      }
    } catch (_) {
      // 无请求体或非法 JSON，继续用默认值
    }

    // 口令校验（请求头优先，其次请求体）
    if (CONFIG.ACCESS_TOKEN) {
      const token = req.headers["x-access-token"] || payload.token || "";
      if (String(token) !== CONFIG.ACCESS_TOKEN) {
        log(`401 unauthorized from ${ip}`);
        sendJson(res, 401, { code: 0, msg: "口令错误或未提供" });
        return;
      }
    }

    // 限速
    const rl = rateLimited(ip);
    if (rl.limited) {
      log(`429 rate limited ip=${ip}`);
      res.setHeader("Retry-After", String(rl.retryAfter));
      sendJson(res, 429, { code: 0, msg: `请求过于频繁，请 ${rl.retryAfter} 秒后再试` });
      return;
    }

    // 选择 API
    let apiId = "api1";
    if (typeof payload.api === "string") apiId = payload.api;

    if (apiId !== "api1" && apiId !== "api2") {
      sendJson(res, 400, { code: 0, msg: "未知的 api 标识，应为 api1 或 api2" });
      return;
    }

    const apiKey = CONFIG.API_KEYS[apiId];
    if (!apiKey) {
      sendJson(res, 500, { code: 0, msg: `服务端未配置 ${apiId} 的 Key` });
      return;
    }

    log(`claim start ip=${ip} api=${apiId}`);

    try {
      const result = await claimFromUpstream(apiKey);

      if (!result.ok && !result.body) {
        log(`claim fail ip=${ip} api=${apiId} http=${result.status}`);
        sendJson(res, 502, {
          code: 0,
          msg: `上游返回异常：HTTP ${result.status}`,
        });
        return;
      }

      log(
        `claim done ip=${ip} api=${apiId} code=${result.body ? result.body.code : "?"} ` +
        `remaining=${result.body && result.body.remaining !== undefined ? result.body.remaining : "?"}`
      );

      // 把上游的 JSON 原样返回，前端逻辑与直连时完全一致
      sendJson(res, result.ok ? 200 : result.status, result.body || { code: 0, msg: "上游返回无法解析" });
    } catch (err) {
      const isAbort = err && err.name === "AbortError";
      log(`claim error ip=${ip} api=${apiId}: ${err && err.message}`);
      sendJson(res, 504, {
        code: 0,
        msg: isAbort ? "上游接口超时" : `转发失败：${err && err.message}`,
      });
    }
    return;
  }

  /* ---------------- 静态文件 ---------------- */
  if (req.method === "GET" || req.method === "HEAD") {
    serveStatic(req, res, pathname);
    return;
  }

  sendJson(res, 405, { code: 0, msg: "method not allowed" });
});

server.listen(CONFIG.PORT, CONFIG.HOST, () => {
  log("==============================================");
  log(`  小号获取 服务已启动`);
  log(`  监听地址: http://${CONFIG.HOST}:${CONFIG.PORT}/`);
  log(`  上游接口: ${CONFIG.UPSTREAM}`);
  log(`  可用 API: ${Object.keys(CONFIG.API_KEYS).join(", ")}`);
  log(`  访问口令: ${CONFIG.ACCESS_TOKEN ? "已启用" : "未设置（公网部署建议设置）"}`);
  log(`  限速策略: 每 IP 每 ${CONFIG.LIMIT_WINDOW_MS / 1000} 秒最多 ${CONFIG.LIMIT_MAX} 次`);
  log("==============================================");
});

// 优雅退出
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    log(`收到 ${sig}，正在关闭...`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
