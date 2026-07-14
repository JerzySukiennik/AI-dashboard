// ==UserScript==
// @name         AI-dashboard — ChatGPT / Codex Usage Collector
// @namespace    ai-dashboard
// @version      1.0.0
// @description  Capture ChatGPT (and Codex) rate-limit / usage info and POST to the AI-dashboard Worker.
// @author       AI-dashboard
// @match        https://chatgpt.com/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      workers.dev
// ==/UserScript==

/*
 * MAINTENANCE NOTE — READ THIS
 * ----------------------------
 * ChatGPT does NOT publish a stable usage API. Rate-limit info shows up embedded
 * in some conversation / backend responses, and Codex usage lives behind the
 * chatgpt.com/codex settings screens. Endpoint paths, response shapes and DOM
 * selectors WILL drift and this script WILL need occasional updating.
 *
 * When it breaks, edit ONLY the CONFIG object below — it is the single place to
 * fix URLs, regexes, field mappings and selectors. Everything else is plumbing.
 *
 * Placeholders __WORKER_URL__ / __INGEST_SECRET__ are substituted by the
 * orchestrator before this file is handed to you.
 */

(function () {
  'use strict';

  // =========================================================================
  // CONFIG — the ONLY place you should need to edit when things break.
  // =========================================================================
  const CONFIG = {
    DEBUG: false,

    account: 'ChatGPT',
    workerUrl: '__WORKER_URL__',            // e.g. https://xxx.workers.dev  (no trailing /ingest)
    ingestSecret: '__INGEST_SECRET__',

    // Any response URL matching this regex is treated as a candidate usage payload.
    usageUrlRegex: /rate_limit|rate-limit|usage|limits|conversation_limit/i,

    repostIntervalMs: 5 * 60 * 1000,
    noCaptureWarnMs: 2 * 60 * 1000,
    knownEndpointKey: 'chatgpt_usage_endpoint',

    /*
     * FIELD MAPPING
     * Turn a parsed JSON body into { plan, session, weekly } or null.
     * ChatGPT rate-limit blobs often look like:
     *   { "rate_limits": { ... } } or a field on a message-completion response.
     * Probes below are best-effort — extend as you learn the real shape.
     */
    mapResponse(json) {
      if (!json || typeof json !== 'object') return null;

      const root = json.rate_limits || json.rate_limit || json.usage
                 || json.limits || json.data || json;

      const pick = (obj, keys) => {
        for (const k of keys) if (obj && obj[k] != null) return obj[k];
        return null;
      };

      const sessionRaw = pick(root, [
        'primary', 'session', 'current', 'short', 'hourly', 'daily', 'gpt'
      ]);
      const weeklyRaw = pick(root, [
        'weekly', 'week', 'secondary', 'long', 'monthly'
      ]);

      if (!sessionRaw && !weeklyRaw && root.utilization == null
          && root.used == null && root.remaining == null) {
        return null;
      }

      const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);

      const normBucket = (b) => {
        if (!b || typeof b !== 'object') return { used: null, limit: null, resetsAt: null };

        let used = num(pick(b, ['used', 'consumed', 'count', 'usage']));
        let limit = num(pick(b, ['limit', 'max', 'cap', 'total', 'quota']));
        const remaining = num(pick(b, ['remaining', 'left']));

        // If we have limit + remaining but not used, derive used.
        if (used == null && limit != null && remaining != null) used = limit - remaining;

        const pct = num(pick(b, ['utilization', 'percent', 'percentage', 'used_percent', 'pct']));
        if ((used == null || limit == null) && pct != null) { used = pct; limit = 100; }

        const resetsAt = pick(b, [
          'resets_at', 'resetsAt', 'reset_at', 'resetAt', 'reset',
          'reset_after', 'next_reset', 'expires_at', 'resets_after_seconds'
        ]);

        return { used, limit, resetsAt: resetsAt != null ? String(resetsAt) : null };
      };

      let session, weekly;
      if (!sessionRaw && !weeklyRaw) {
        session = normBucket(root);
        weekly = { used: null, limit: null, resetsAt: null };
      } else {
        session = normBucket(sessionRaw);
        weekly = normBucket(weeklyRaw);
      }

      const plan = pick(root, ['plan', 'plan_type', 'subscription', 'tier', 'account_plan']);

      return {
        plan: plan != null ? String(plan) : null,
        session,
        weekly
      };
    },

    // DOM fallback for the ChatGPT / Codex settings usage screens.
    // Selectors WILL drift — update here.
    dom: {
      pageMatch: /\/codex|\/settings|\/usage/i,
      planSelector: '[data-testid="plan-name"], .plan-name',
      sessionText: '[data-testid="usage-session"], [data-testid="rate-limit-primary"]',
      weeklyText: '[data-testid="usage-weekly"], [data-testid="rate-limit-weekly"]'
    }
  };

  // =========================================================================
  // Plumbing — normally no need to touch.
  // =========================================================================

  const TAG = '[AI-dashboard]';
  const log = (...a) => { if (CONFIG.DEBUG) console.log(TAG, ...a); };
  const warn = (...a) => console.warn(TAG, ...a);

  let lastData = null;
  let captured = false;

  const safe = (fn) => { try { return fn(); } catch (e) { log('caught', e); return undefined; } };
  const isUsageUrl = (url) => safe(() => CONFIG.usageUrlRegex.test(String(url))) || false;

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
        warn('no usage captured yet. Open chatgpt.com/codex settings or a chat, or update the endpoint/regex in CONFIG. Set CONFIG.DEBUG=true for verbose logs.');
      }
    }, CONFIG.noCaptureWarnMs);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', onReady);
  } else {
    onReady();
  }

  log('ChatGPT usage collector loaded');
})();
