# AI-dashboard Worker

Cloudflare Worker bridging userscripts (POST usage limits), a PWA dashboard on
GitHub Pages (GET state + Web Push subscribe), and CLI hooks (POST "task done"
-> Web Push to iPhone).

## Endpoints

| Method | Path | Auth | Body | Returns |
| ------ | ---- | ---- | ---- | ------- |
| POST | `/ingest` | `Bearer INGEST_SECRET` | `{ account, plan, session:{used,limit,resetsAt}, weekly:{used,limit,resetsAt}, updatedAt }` | `{ok:true}` |
| GET | `/state` | public | — | JSON array of all `state:*` records (`Cache-Control: no-store`) |
| POST | `/subscribe` | `Bearer SUBSCRIBE_SECRET` | PushSubscription `{endpoint, keys:{p256dh, auth}}` | `{ok:true}` |
| DELETE | `/subscribe` | `Bearer SUBSCRIBE_SECRET` | `{endpoint}` | `{ok:true}` |
| POST | `/notify` | `Bearer NOTIFY_SECRET` | `{ tool, account?, task }` | `{ok:true, sent, failed, removed}` |
| OPTIONS | any | — | — | 204 (CORS preflight) |

- `/ingest` validates `account` is a non-empty string; stores under KV key
  `state:<account>`, filling `updatedAt` with the server ISO time if absent.
- `/state` never exposes subscriptions or secrets — only `state:*` records.
- `/subscribe` stores under `sub:<sha256 hex of endpoint>`.
- `/notify` pushes `{ title: tool, body: task, account }` to every stored
  subscription (TTL 60, Urgency high). Subscriptions returning 404/410 are
  deleted from KV.
- CORS: `Access-Control-Allow-Origin` = `env.ALLOWED_ORIGIN`
  (`https://jerzysukiennik.github.io`); allowed headers `Content-Type`,
  `Authorization`; methods `GET, POST, DELETE, OPTIONS`. Applied on all responses.
- Anything else -> 404 JSON. Handlers are wrapped; failures return 500 JSON.

## Web Push

Uses [`@block65/webcrypto-web-push`](https://github.com/block65/webcrypto-web-push)
(`buildPushPayload(message, subscription, vapid)`), which runs on the Workers
runtime via Web Crypto (no Node APIs). It handles RFC 8291 (aes128gcm) payload
encryption and RFC 8292 VAPID (ES256 JWT). `buildPushPayload` returns a `fetch`
init object that we send to `subscription.endpoint`.

VAPID keys are the standard output of the `web-push` CLI (`npx web-push
generate-vapid-keys`): base64url public (65-byte uncompressed P-256 point) and
private (32-byte scalar). Pass them as-is to the secrets below.

## Config (wrangler.toml)

- KV binding `AI_LIMITS_KV` -> id `4fde39d2f68e4add89c4d97e1a6e6069`
- Vars: `VAPID_SUBJECT = mailto:gzowotesla@gmail.com`,
  `ALLOWED_ORIGIN = https://jerzysukiennik.github.io`

## Secrets (set before deploy)

```
wrangler secret put INGEST_SECRET
wrangler secret put NOTIFY_SECRET
wrangler secret put SUBSCRIBE_SECRET
wrangler secret put VAPID_PUBLIC_KEY
wrangler secret put VAPID_PRIVATE_KEY
```

## Deploy

```
npm install        # required: pulls @block65/webcrypto-web-push
wrangler deploy
```
