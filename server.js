import http from 'node:http';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';

const PORT = Number(process.env.PORT || 3000);
const TINYFISH_API_KEY = process.env.TINYFISH_API_KEY || '';
const BRIDGE_API_KEY = process.env.BRIDGE_API_KEY || '';
const TINYFISH_BASE_URL = 'https://agent.tinyfish.ai';
const RATE_LIMIT_PER_MINUTE = Math.max(1, Math.min(120, Number(process.env.RATE_LIMIT_PER_MINUTE || 20)));
const MAX_BODY_BYTES = 64 * 1024;
const MAX_GOAL_LENGTH = 6000;
const CONSOLE_HTML = readFileSync(new URL('./public/console.html', import.meta.url), 'utf8');
const allowedHosts = new Set(
  (process.env.ALLOWED_HOSTS || 'console.cloud.google.com,news.ycombinator.com')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean),
);

const rateState = new Map();

function commonHeaders(contentType) {
  return {
    'content-type': contentType,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
    'x-frame-options': 'DENY',
  };
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...commonHeaders('application/json; charset=utf-8'),
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function html(res, status, body) {
  res.writeHead(status, {
    ...commonHeaders('text/html; charset=utf-8'),
    'content-length': Buffer.byteLength(body),
    'content-security-policy': "default-src 'none'; connect-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'; img-src 'none'",
  });
  res.end(body);
}

function redirect(res, location) {
  res.writeHead(302, {
    ...commonHeaders('text/plain; charset=utf-8'),
    location,
    'content-length': '0',
  });
  res.end();
}

function secureEqual(a, b) {
  if (!a || !b) return false;
  const left = crypto.createHash('sha256').update(String(a)).digest();
  const right = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(left, right);
}

export function isAuthorized(headers = {}) {
  const presented = headers['x-bridge-key'] || headers['X-Bridge-Key'];
  return secureEqual(presented, BRIDGE_API_KEY);
}

export function validateTargetUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, error: 'invalid_url' };
  }

  if (url.protocol !== 'https:') return { ok: false, error: 'https_required' };

  const host = url.hostname.toLowerCase();
  const allowed = [...allowedHosts].some((candidate) => host === candidate || host.endsWith(`.${candidate}`));
  if (!allowed) return { ok: false, error: 'host_not_allowed' };

  return { ok: true, url: url.toString() };
}

function sanitizeRun(run) {
  if (!run || typeof run !== 'object') return run;
  return {
    run_id: run.run_id ?? null,
    status: run.status ?? null,
    created_at: run.created_at ?? null,
    started_at: run.started_at ?? null,
    finished_at: run.finished_at ?? null,
    num_of_steps: run.num_of_steps ?? null,
    result: run.result ?? null,
    error: run.error ?? null,
  };
}

function sanitizeUpstreamFailure(error) {
  const body = error?.body && typeof error.body === 'object' ? error.body : {};
  const nested = body.error && typeof body.error === 'object' ? body.error : {};

  return {
    upstreamStatus: Number.isInteger(error?.status) ? error.status : null,
    upstreamCode:
      typeof nested.code === 'string'
        ? nested.code
        : typeof body.error === 'string'
          ? body.error
          : null,
    upstreamMessage:
      typeof nested.message === 'string'
        ? nested.message.slice(0, 500)
        : typeof body.message === 'string'
          ? body.message.slice(0, 500)
          : null,
    upstreamRequestId: typeof body.request_id === 'string' ? body.request_id.slice(0, 200) : null,
  };
}

function checkRateLimit(req) {
  const now = Date.now();
  const windowStart = now - 60_000;
  const key = req.socket.remoteAddress || 'unknown';
  const existing = (rateState.get(key) || []).filter((timestamp) => timestamp > windowStart);
  if (existing.length >= RATE_LIMIT_PER_MINUTE) {
    rateState.set(key, existing);
    return false;
  }
  existing.push(now);
  rateState.set(key, existing);
  return true;
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('body_too_large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('invalid_json');
  }
}

async function tinyfishFetch(path, options = {}) {
  const response = await fetch(`${TINYFISH_BASE_URL}${path}`, {
    ...options,
    headers: {
      'X-API-Key': TINYFISH_API_KEY,
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(30_000),
  });

  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { message: 'TinyFish returned a non-JSON response.' };
    }
  }

  if (!response.ok) {
    const error = new Error('tinyfish_request_failed');
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

async function handleCreateRun(req, res) {
  const body = await readJson(req);
  const urlCheck = validateTargetUrl(body.url);
  if (!urlCheck.ok) return json(res, 400, { ok: false, error: urlCheck.error });

  const goal = typeof body.goal === 'string' ? body.goal.trim() : '';
  if (!goal) return json(res, 400, { ok: false, error: 'goal_required' });
  if (goal.length > MAX_GOAL_LENGTH) return json(res, 400, { ok: false, error: 'goal_too_long' });

  const browserProfile = body.browserProfile === 'stealth' ? 'stealth' : 'lite';
  const useProfile = body.useProfile === true;
  const profileId = typeof body.profileId === 'string' ? body.profileId.trim() : '';
  if (profileId && !/^prof_[A-Za-z0-9_-]{6,128}$/.test(profileId)) {
    return json(res, 400, { ok: false, error: 'invalid_profile_id' });
  }
  if (profileId && !useProfile) {
    return json(res, 400, { ok: false, error: 'profile_id_requires_use_profile' });
  }

  const payload = {
    url: urlCheck.url,
    goal,
    browser_profile: browserProfile,
    api_integration: 'voyage-automation-bridge',
  };
  if (useProfile) payload.use_profile = true;
  if (profileId) payload.profile_id = profileId;

  const upstream = await tinyfishFetch('/v1/automation/run-async', {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  return json(res, 202, {
    ok: true,
    run_id: upstream?.run_id ?? null,
    error: upstream?.error ?? null,
  });
}

async function handleGetRun(res, runId) {
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(runId)) {
    return json(res, 400, { ok: false, error: 'invalid_run_id' });
  }
  const upstream = await tinyfishFetch(`/v1/runs/${encodeURIComponent(runId)}`);
  return json(res, 200, { ok: true, run: sanitizeRun(upstream) });
}

async function handler(req, res) {
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;

    if (req.method === 'GET' && pathname === '/') {
      return redirect(res, '/console');
    }

    if (req.method === 'GET' && (pathname === '/console' || pathname === '/console/')) {
      return html(res, 200, CONSOLE_HTML);
    }

    if (req.method === 'GET' && pathname === '/health') {
      return json(res, 200, {
        ok: true,
        service: 'voyage-automation-bridge',
        tinyfishConfigured: Boolean(TINYFISH_API_KEY),
        bridgeAuthConfigured: Boolean(BRIDGE_API_KEY),
      });
    }

    if (!TINYFISH_API_KEY || !BRIDGE_API_KEY) {
      return json(res, 503, { ok: false, error: 'service_not_configured' });
    }

    if (!isAuthorized(req.headers)) {
      return json(res, 401, { ok: false, error: 'unauthorized' });
    }

    if (!checkRateLimit(req)) {
      return json(res, 429, { ok: false, error: 'rate_limited' });
    }

    if (req.method === 'POST' && pathname === '/v1/tinyfish/runs') {
      return await handleCreateRun(req, res);
    }

    const runMatch = pathname.match(/^\/v1\/tinyfish\/runs\/([A-Za-z0-9_-]+)$/);
    if (req.method === 'GET' && runMatch) {
      return await handleGetRun(res, runMatch[1]);
    }

    return json(res, 404, { ok: false, error: 'not_found' });
  } catch (error) {
    if (error?.message === 'body_too_large') return json(res, 413, { ok: false, error: 'body_too_large' });
    if (error?.message === 'invalid_json') return json(res, 400, { ok: false, error: 'invalid_json' });
    if (error?.message === 'tinyfish_request_failed') {
      return json(res, 502, {
        ok: false,
        error: 'tinyfish_request_failed',
        ...sanitizeUpstreamFailure(error),
      });
    }
    console.error('[bridge] request failed', error?.message || 'unknown_error');
    return json(res, 500, { ok: false, error: 'internal_error' });
  }
}

export function createServer() {
  return http.createServer(handler);
}

if (process.argv[1] && new URL(import.meta.url).pathname.endsWith(process.argv[1].replaceAll('\\', '/'))) {
  createServer().listen(PORT, '0.0.0.0', () => {
    console.log(`[bridge] listening on port ${PORT}`);
  });
}
