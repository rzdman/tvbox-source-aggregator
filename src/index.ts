// TVBox 源聚合 CF Worker 入口

import { fetchConfigs } from './fetcher';
import { mergeConfigs } from './merger';
import { batchSpeedTest, filterBySpeed } from './speedtest';
import {
  KV_MERGED_CONFIG,
  KV_SOURCE_URLS,
  KV_LAST_UPDATE,
  KV_MANUAL_SOURCES,
  DEFAULT_SPEED_TIMEOUT_MS,
  DEFAULT_FETCH_TIMEOUT_MS,
} from './config';
import { dashboardHtml } from './dashboard';
import { adminHtml } from './admin';
import type { Env, SourcedConfig, SourceEntry } from './types';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/admin')) {
      return handleAdmin(request, url.pathname, env, ctx);
    }

    switch (url.pathname) {
      case '/':
        return handleGetConfig(env);
      case '/status':
        return handleDashboard();
      case '/status-data':
        return handleGetStatus(env);
      case '/refresh':
        return handleRefresh(request, env, ctx);
      default:
        return new Response('Not Found', { status: 404 });
    }
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runAggregation(env));
  },
};

// ─── Admin 路由 ────────────────────────────────────────────

async function handleAdmin(
  request: Request,
  pathname: string,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  // GET /admin — 返回管理页面
  if (pathname === '/admin' && request.method === 'GET') {
    return new Response(adminHtml, {
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' },
    });
  }

  // 其余 admin API 需要鉴权
  if (!verifyAdmin(request, env)) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  if (pathname === '/admin/sources' && request.method === 'GET') {
    return handleGetSources(env);
  }

  if (pathname === '/admin/sources' && request.method === 'POST') {
    return handleAddSource(request, env);
  }

  if (pathname === '/admin/sources' && request.method === 'DELETE') {
    return handleRemoveSource(request, env);
  }

  return new Response('Not Found', { status: 404 });
}

function verifyAdmin(request: Request, env: Env): boolean {
  const token = env.ADMIN_TOKEN;
  if (!token) return false;
  const auth = request.headers.get('Authorization');
  return auth === `Bearer ${token}`;
}

async function handleGetSources(env: Env): Promise<Response> {
  const raw = await env.KV.get(KV_MANUAL_SOURCES);
  const sources: SourceEntry[] = raw ? JSON.parse(raw) : [];
  return jsonResponse(sources);
}

async function handleAddSource(request: Request, env: Env): Promise<Response> {
  let body: { name?: string; url?: string };
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON' }, 400);
  }

  const url = body.url?.trim();
  if (!url) {
    return jsonResponse({ error: 'URL is required' }, 400);
  }

  try {
    new URL(url);
  } catch {
    return jsonResponse({ error: 'Invalid URL format' }, 400);
  }

  const name = body.name?.trim() || '';
  const raw = await env.KV.get(KV_MANUAL_SOURCES);
  const sources: SourceEntry[] = raw ? JSON.parse(raw) : [];

  if (sources.some((s) => s.url === url)) {
    return jsonResponse({ error: 'Source already exists' }, 409);
  }

  sources.push({ name, url });
  await env.KV.put(KV_MANUAL_SOURCES, JSON.stringify(sources));

  return jsonResponse({ success: true });
}

async function handleRemoveSource(request: Request, env: Env): Promise<Response> {
  let body: { url?: string };
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON' }, 400);
  }

  const url = body.url?.trim();
  if (!url) {
    return jsonResponse({ error: 'URL is required' }, 400);
  }

  const raw = await env.KV.get(KV_MANUAL_SOURCES);
  const sources: SourceEntry[] = raw ? JSON.parse(raw) : [];
  const filtered = sources.filter((s) => s.url !== url);
  await env.KV.put(KV_MANUAL_SOURCES, JSON.stringify(filtered));

  return jsonResponse({ success: true });
}

// ─── 原有路由 ──────────────────────────────────────────────

async function handleGetConfig(env: Env): Promise<Response> {
  const config = await env.KV.get(KV_MERGED_CONFIG);

  if (!config) {
    return new Response(
      JSON.stringify({ error: 'No config available yet. Add sources in /admin and trigger a refresh.' }),
      {
        status: 503,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      },
    );
  }

  return new Response(config, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=1800',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

async function handleDashboard(): Promise<Response> {
  return new Response(dashboardHtml, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
    },
  });
}

async function handleGetStatus(env: Env): Promise<Response> {
  const lastUpdate = await env.KV.get(KV_LAST_UPDATE);
  const sources = await env.KV.get(KV_MANUAL_SOURCES);
  const config = await env.KV.get(KV_MERGED_CONFIG);

  let siteCount = 0;
  let parseCount = 0;
  let liveCount = 0;
  if (config) {
    try {
      const parsed = JSON.parse(config);
      siteCount = parsed.sites?.length || 0;
      parseCount = parsed.parses?.length || 0;
      liveCount = parsed.lives?.length || 0;
    } catch {
      // ignore
    }
  }

  const status = {
    lastUpdate: lastUpdate || 'never',
    sourceCount: sources ? JSON.parse(sources).length : 0,
    sites: siteCount,
    parses: parseCount,
    lives: liveCount,
  };

  return new Response(JSON.stringify(status, null, 2), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

async function handleRefresh(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  if (env.REFRESH_TOKEN || env.ADMIN_TOKEN) {
    const auth = request.headers.get('Authorization');
    const validTokens = [env.REFRESH_TOKEN, env.ADMIN_TOKEN].filter(Boolean);
    if (!validTokens.some((t) => auth === `Bearer ${t}`)) {
      return new Response('Unauthorized', { status: 401 });
    }
  }

  ctx.waitUntil(runAggregation(env));

  return new Response(JSON.stringify({ success: true, message: 'Refresh started' }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

// ─── 核心聚合流程 ──────────────────────────────────────────

async function runAggregation(env: Env): Promise<void> {
  const startTime = Date.now();
  console.log('[aggregation] Starting...');

  const speedTimeoutMs = parseInt(env.SPEED_TIMEOUT_MS) || DEFAULT_SPEED_TIMEOUT_MS;
  const fetchTimeoutMs = parseInt(env.FETCH_TIMEOUT_MS) || DEFAULT_FETCH_TIMEOUT_MS;

  // Step 1: 读取手动配置的源
  console.log('[aggregation] Step 1: Loading sources...');
  const raw = await env.KV.get(KV_MANUAL_SOURCES);
  const sources: SourceEntry[] = raw ? JSON.parse(raw) : [];

  if (sources.length === 0) {
    console.warn('[aggregation] No sources configured, nothing to do');
    return;
  }

  console.log(`[aggregation] ${sources.length} sources configured`);
  await env.KV.put(KV_SOURCE_URLS, JSON.stringify(sources));

  // Step 2: 批量 fetch 配置 JSON
  console.log('[aggregation] Step 2: Fetching configs...');
  const sourcedConfigs = await fetchConfigs(sources, fetchTimeoutMs);

  if (sourcedConfigs.length === 0) {
    console.warn('[aggregation] No valid configs fetched, keeping previous cache');
    return;
  }

  // Step 3: 测速（如果有 API key）
  let filteredConfigs: SourcedConfig[] = sourcedConfigs;

  if (env.ZBAPE_API_KEY) {
    console.log('[aggregation] Step 3: Speed testing config URLs...');
    const configUrls = sourcedConfigs.map((c) => c.sourceUrl);
    const speedResults = await batchSpeedTest(configUrls, env.ZBAPE_API_KEY);
    const passedUrls = filterBySpeed(speedResults, speedTimeoutMs);

    filteredConfigs = sourcedConfigs.filter((c) => passedUrls.has(c.sourceUrl));

    if (filteredConfigs.length === 0) {
      console.warn('[aggregation] All configs failed speed test, using all fetched configs');
      filteredConfigs = sourcedConfigs;
    }
  } else {
    console.log('[aggregation] Step 3: Skipping speed test (no API key)');
  }

  // Step 4: 合并
  console.log('[aggregation] Step 4: Merging configs...');
  const merged = mergeConfigs(filteredConfigs);

  // Step 5: 存入 KV
  const mergedJson = JSON.stringify(merged);
  await env.KV.put(KV_MERGED_CONFIG, mergedJson);
  await env.KV.put(KV_LAST_UPDATE, new Date().toISOString());

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(
    `[aggregation] Done in ${elapsed}s. ` +
      `${merged.sites?.length} sites, ${merged.parses?.length} parses, ${merged.lives?.length} lives`,
  );
}

// ─── 工具函数 ──────────────────────────────────────────────

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
