// AI-dashboard Worker
// Bridges userscripts (POST usage limits), a PWA dashboard (GET state + Web Push
// subscribe), and CLI hooks (POST "task done" -> Web Push to iPhone).

import { buildPushPayload } from '@block65/webcrypto-web-push';

const PUSH_TIMEOUT_MS = 10_000;

// ---- helpers ---------------------------------------------------------------

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || 'https://jerzysukiennik.github.io',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(body, env, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(env),
      ...extraHeaders,
    },
  });
}

// Plain compare is acceptable here per spec.
function authorized(request, secret) {
  if (!secret) return false;
  const header = request.headers.get('Authorization') || '';
  const prefix = 'Bearer ';
  if (!header.startsWith(prefix)) return false;
  return header.slice(prefix.length) === secret;
}

async function sha256Hex(input) {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

function validSubscription(sub) {
  return (
    sub &&
    typeof sub === 'object' &&
    isNonEmptyString(sub.endpoint) &&
    sub.keys &&
    typeof sub.keys === 'object' &&
    isNonEmptyString(sub.keys.p256dh) &&
    isNonEmptyString(sub.keys.auth)
  );
}

// ---- route handlers --------------------------------------------------------

async function handleIngest(request, env) {
  if (!authorized(request, env.INGEST_SECRET)) return json({ ok: false, error: 'unauthorized' }, env, 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'invalid json' }, env, 400);
  }

  if (!body || !isNonEmptyString(body.account)) {
    return json({ ok: false, error: 'account required' }, env, 400);
  }

  const record = {
    account: body.account,
    plan: body.plan ?? null,
    session: body.session ?? null,
    weekly: body.weekly ?? null,
    updatedAt: isNonEmptyString(body.updatedAt) ? body.updatedAt : new Date().toISOString(),
  };

  await env.AI_LIMITS_KV.put(`state:${body.account}`, JSON.stringify(record));
  return json({ ok: true }, env);
}

async function handleState(request, env) {
  const out = [];
  let cursor;
  do {
    const list = await env.AI_LIMITS_KV.list({ prefix: 'state:', cursor });
    for (const key of list.keys) {
      const val = await env.AI_LIMITS_KV.get(key.name);
      if (val) {
        try {
          out.push(JSON.parse(val));
        } catch {
          // skip corrupt entry
        }
      }
    }
    cursor = list.list_complete ? undefined : list.cursor;
  } while (cursor);

  return json(out, env, 200, { 'Cache-Control': 'no-store' });
}

async function handleSubscribe(request, env) {
  if (!authorized(request, env.SUBSCRIBE_SECRET)) return json({ ok: false, error: 'unauthorized' }, env, 401);

  let sub;
  try {
    sub = await request.json();
  } catch {
    return json({ ok: false, error: 'invalid json' }, env, 400);
  }

  if (!validSubscription(sub)) {
    return json({ ok: false, error: 'invalid subscription' }, env, 400);
  }

  const id = await sha256Hex(sub.endpoint);
  await env.AI_LIMITS_KV.put(`sub:${id}`, JSON.stringify(sub));
  return json({ ok: true }, env);
}

async function handleUnsubscribe(request, env) {
  if (!authorized(request, env.SUBSCRIBE_SECRET)) return json({ ok: false, error: 'unauthorized' }, env, 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'invalid json' }, env, 400);
  }

  if (!body || !isNonEmptyString(body.endpoint)) {
    return json({ ok: false, error: 'endpoint required' }, env, 400);
  }

  const id = await sha256Hex(body.endpoint);
  await env.AI_LIMITS_KV.delete(`sub:${id}`);
  return json({ ok: true }, env);
}

async function handleNotify(request, env) {
  if (!authorized(request, env.NOTIFY_SECRET)) return json({ ok: false, error: 'unauthorized' }, env, 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'invalid json' }, env, 400);
  }

  if (!body || !isNonEmptyString(body.tool) || !isNonEmptyString(body.task)) {
    return json({ ok: false, error: 'tool and task required' }, env, 400);
  }

  const vapid = {
    subject: env.VAPID_SUBJECT,
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
  };

  const payloadData = {
    title: body.tool,
    body: body.task,
    account: body.account ?? null,
  };

  const message = {
    data: payloadData,
    options: { ttl: 60, urgency: 'high' },
  };

  // Collect all subscriptions.
  const subs = [];
  let cursor;
  do {
    const list = await env.AI_LIMITS_KV.list({ prefix: 'sub:', cursor });
    for (const key of list.keys) {
      const val = await env.AI_LIMITS_KV.get(key.name);
      if (val) {
        try {
          subs.push({ key: key.name, sub: JSON.parse(val) });
        } catch {
          // skip corrupt entry
        }
      }
    }
    cursor = list.list_complete ? undefined : list.cursor;
  } while (cursor);

  let sent = 0;
  let failed = 0;
  let removed = 0;

  await Promise.all(
    subs.map(async ({ key, sub }) => {
      try {
        const init = await buildPushPayload(message, sub, vapid);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), PUSH_TIMEOUT_MS);
        let res;
        try {
          res = await fetch(sub.endpoint, { ...init, signal: controller.signal });
        } finally {
          clearTimeout(timer);
        }

        if (res.status === 404 || res.status === 410) {
          await env.AI_LIMITS_KV.delete(key);
          removed += 1;
          failed += 1;
        } else if (res.ok) {
          sent += 1;
        } else {
          failed += 1;
        }
      } catch {
        failed += 1;
      }
    })
  );

  return json({ ok: true, sent, failed, removed }, env);
}

// ---- router ----------------------------------------------------------------

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const { pathname } = url;
      const method = request.method;

      if (method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders(env) });
      }

      if (pathname === '/ingest' && method === 'POST') return await handleIngest(request, env);
      if (pathname === '/state' && method === 'GET') return await handleState(request, env);
      if (pathname === '/subscribe' && method === 'POST') return await handleSubscribe(request, env);
      if (pathname === '/subscribe' && method === 'DELETE') return await handleUnsubscribe(request, env);
      if (pathname === '/notify' && method === 'POST') return await handleNotify(request, env);

      return json({ ok: false, error: 'not found' }, env, 404);
    } catch (err) {
      return json({ ok: false, error: 'internal error', detail: String(err && err.message || err) }, env, 500);
    }
  },
};
