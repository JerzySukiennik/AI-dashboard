// ==UserScript==
// @name         AI-dashboard — Claude Usage Collector
// @namespace    ai-dashboard
// @version      1.0.0
// @description  Capture Claude.ai session (5h) + weekly usage limits and POST to the AI-dashboard Worker.
// @author       AI-dashboard
// @match        https://claude.ai/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      workers.dev
// ==/UserScript==

/*
 * MAINTENANCE NOTE
 * ----------------
 * Claude.ai's internal usage endpoints and DOM are NOT a public API and WILL
 * change over time. When collection breaks, fix things ONLY in the CONFIG object
 * below — that's the single source of truth for URLs, regexes, field mappings and
 * selectors. Everything under CONFIG is plumbing.
 *
 * Placeholders __WORKER_URL__ / __INGEST_SECRET__ are substituted by the
 * orchestrator before this file is handed to you. Do not commit filled values.
 */

(function () {
  'use strict';

  // =========================================================================
  // CONFIG — the ONLY place you should need to edit when things break.
  // =========================================================================
  const CONFIG = {
    DEBUG: false,

    account: 'Claude',
    workerUrl: '__WORKER_URL__',            // e.g. https://xxx.workers.dev  (no trailing /ingest)
    ingestSecret: '__INGEST_SECRET__',

    // Any response URL matching this regex is treated as a candidate usage payload.
    usageUrlRegex: /usage|rate_limit|rate-limit|limits/i,

    // Re-POST cadence (ms). We only POST when we actually have data.
    repostIntervalMs: 5 * 60 * 1000,

    // Warn in console if nothing captured after this long.
    noCaptureWarnMs: 2 * 60 * 1000,

    // GM key under which we remember a working usage endpoint URL for proactive polling.
    knownEndpointKey: 'claude_usage_endpoint',

    /*
     * FIELD MAPPING
     * Given a parsed JSON object from a usage response, produce a normalized shape:
     *   { plan, session:{used,limit,resetsAt}, weekly:{used,limit,resetsAt} }
     * Return null if the object clearly isn't usage data.
     *
     * Because Claude's schema is undocumented and shifts, this fn is intentionally
     * defensive: it probes several likely field names. Add/adjust probes here.
     */
    mapResponse(json) {
      if (!json || typeof json !== 'object') return null;

      // Common container names seen in the wild; fall back to root.
      const root = json.usage || json.data || json.limits || json;

      // Pull a section by a list of candidate keys.
      const pick = (obj, keys) => {
        for (const k of keys) {
          if (obj && obj[k] != null) return obj[k];
        }
        return null;
      };

      const sessionRaw = pick(root, [
        'five_hour', 'fiveHour', 'session', 'rolling', 'current', 'short'
      ]);
      const weeklyRaw = pick(root, [
        'seven_day', 'sevenDay', 'weekly', 'week', 'long'
      ]);

      // If we found neither known section, this probably isn't usage data.
      if (!sessionRaw && !weeklyRaw && root.utilization == null && root.used == null) {
        return null;
      }

      const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);

      // Normalize one bucket into {used, limit, resetsAt}.
      // Handles both used/limit and percentage-only ("utilization") shapes.
      const normBucket = (b) => {
        if (!b || typeof b !== 'object') return { used: null, limit: null, resetsAt: null };

        let used = num(pick(b, ['used', 'consumed', 'count', 'usage']));
        let limit = num(pick(b, ['limit', 'max', 'cap', 'total', 'quota']));

        const pct = num(pick(b, ['utilization', 'percent', 'percentage', 'used_percent', 'pct']));
        // Percent-only source → used=percent, limit=100.
        if ((used == null || limit == null) && pct != null) {
          used = pct;
          limit = 100;
        }

        const resetsAt = pick(b, [
          'resets_at', 'resetsAt', 'reset_at', 'resetAt',
          'reset', 'next_reset', 'expires_at', 'window_reset'
        ]);

        return { used, limit, resetsAt: resetsAt != null ? String(resetsAt) : null };
      };

      // If the payload is a flat percentage (no per-bucket split), treat it as session.
      let session, weekly;
      if (!sessionRaw && !weeklyRaw) {
        session = normBucket(root);
        weekly = { used: null, limit: null, resetsAt: null };
      } else {
        session = normBucket(sessionRaw);
        weekly = normBucket(weeklyRaw);
      }

      const plan = pick(root, ['plan', 'plan_type', 'subscription', 'tier']);

      return {
        plan: plan != null ? String(plan) : null,
        session,
        weekly
      };
    },

    // DOM fallback selectors for the Settings → Usage page.
    // These WILL drift; update here. Each selector should resolve to text like "12 / 45" or "34%".
    dom: {
      // Only run DOM scrape when on a usage-ish URL/path.
      pageMatch: /\/settings\/usage|\/usage/i,
      planSelector: '[data-testid="plan-name"], .plan-name',
      sessionText: '[data-testid="session-usage"], [data-testid="five-hour-usage"]',
      weeklyText: '[data-testid="weekly-usage"], [data-testid="seven-day-usage"]'
    }
  };

  // =========================================================================
  // Plumbing below — normally no need to touch.
  // =========================================================================

  const TAG = '[AI-dashboard]';
  const log = (...a) => { if (CONFIG.DEBUG) console.log(TAG, ...a); };
  const warn = (...a) => console.warn(TAG, ...a);

  let lastData = null;      // last successfully normalized + POSTed payload
  let captured = false;     // have we ever captured anything this pageview?

  function safe(fn) {
    try { return fn(); } catch (e) { log('caught', e); return undefined; }
  }

  function isUsageUrl(url) {
    return safe(() => CONFIG.usageUrlRegex.test(String(url))) || false;
  }

  // Build the final ingest body and POST it.
  function postData(normalized) {
    if (!normalized) return;
    const body = {
      account: CONFIG.account,
      plan: normalized.plan,
      session: normalized.session,
      weekly: normalized.weekly,
      updatedAt: new Date().toISOString()
    };
    lastData = body;

    const url = CONFIG.workerUrl.replace(/\/+$/, '') + '/ingest';
    log('POST', url, body);

    safe(() => GM_xmlhttpRequest({
      method: 'POST',
      url,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + CONFIG.ingestSecret
      },
      data: JSON.stringify(body),
      timeout: 8000,
      onload: (r) => log('ingest ok', r.status),
      onerror: (e) => log('ingest error', e),
      ontimeout: () => log('ingest timeout')
    }));
  }

  // Try to turn a raw response body (string or object) into normalized data + POST.
  function handleCandidate(url, rawBody) {
    safe(() => {
      let json = rawBody;
      if (typeof rawBody === 'string') {
        try { json = JSON.parse(rawBody); } catch { return; }
      }
      const norm = CONFIG.mapResponse(json);
      if (!norm) { log('candidate did not map', url); return; }
      log('captured usage from', url);
      captured = true;
      safe(() => GM_setValue(CONFIG.knownEndpointKey, String(url)));
      postData(norm);
    });
  }

  // --- fetch hook -------------------------------------------------------------
  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (...args) {
      const p = origFetch.apply(this, args);
      safe(() => {
        const reqUrl = (args[0] && args[0].url) ? args[0].url : args[0];
        if (!isUsageUrl(reqUrl)) return;
        p.then((res) => {
          safe(() => {
            const clone = res.clone();
            clone.text().then((t) => handleCandidate(reqUrl, t)).catch(() => {});
          });
        }).catch(() => {});
      });
      return p;
    };
    log('fetch hook installed');
  }

  // --- XHR hook ---------------------------------------------------------------
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__ai_url = url;
    return origOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    safe(() => {
      this.addEventListener('load', () => {
        safe(() => {
          if (!isUsageUrl(this.__ai_url)) return;
          handleCandidate(this.__ai_url, this.responseText);
        });
      });
    });
    return origSend.apply(this, args);
  };
  log('xhr hook installed');

  // --- proactive poll of a known endpoint ------------------------------------
  function proactiveFetch() {
    safe(() => {
      const known = GM_getValue(CONFIG.knownEndpointKey, null);
      if (!known) return;
      log('proactive fetch', known);
      // Use page fetch so cookies/auth ride along (same-origin claude.ai).
      origFetch(known, { credentials: 'include' })
        .then((r) => r.text())
        .then((t) => handleCandidate(known, t))
        .catch((e) => log('proactive fetch failed', e));
    });
  }

  // --- DOM fallback -----------------------------------------------------------
  function parseUsageText(txt) {
    if (!txt) return { used: null, limit: null, resetsAt: null };
    const frac = txt.match(/(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/);
    if (frac) return { used: parseFloat(frac[1]), limit: parseFloat(frac[2]), resetsAt: null };
    const pct = txt.match(/(\d+(?:\.\d+)?)\s*%/);
    if (pct) return { used: parseFloat(pct[1]), limit: 100, resetsAt: null };
    return { used: null, limit: null, resetsAt: null };
  }

  function domScrape() {
    safe(() => {
      if (!CONFIG.dom.pageMatch.test(location.pathname + location.search)) return;
      const q = (sel) => { const el = document.querySelector(sel); return el ? el.textContent.trim() : ''; };
      const session = parseUsageText(q(CONFIG.dom.sessionText));
      const weekly = parseUsageText(q(CONFIG.dom.weeklyText));
      if (session.used == null && weekly.used == null) return;
      log('DOM scrape captured');
      captured = true;
      postData({ plan: q(CONFIG.dom.planSelector) || null, session, weekly });
    });
  }

  // --- lifecycle --------------------------------------------------------------
  function onReady() {
    proactiveFetch();
    domScrape();

    setInterval(() => {
      proactiveFetch();
      domScrape();
      // Re-POST last known data on cadence so the dashboard sees a fresh heartbeat.
      if (lastData) {
        lastData.updatedAt = new Date().toISOString();
        postData({
          plan: lastData.plan,
          session: lastData.session,
          weekly: lastData.weekly
        });
      }
    }, CONFIG.repostIntervalMs);

    setTimeout(() => {
      if (!captured) {
        warn('no usage captured yet. Open Settings → Usage, or update the endpoint/regex in CONFIG. Set CONFIG.DEBUG=true for verbose logs.');
      }
    }, CONFIG.noCaptureWarnMs);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', onReady);
  } else {
    onReady();
  }

  log('Claude usage collector loaded');
})();
