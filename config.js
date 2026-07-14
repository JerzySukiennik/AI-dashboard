// Deployment config. The orchestrator replaces https://ai-dashboard.gzowo.workers.dev after the worker deploys.
export const WORKER_URL = "https://ai-dashboard.gzowo.workers.dev";
export const VAPID_PUBLIC_KEY = "BItR0NlTZK2_rKoaqJubt-yTxFXhr5Hm3dUqcqKPUA27kYWbqGIqmw2J5inJOm51PBKSEkOBdHoAw2QTM7K3u58";
// Sent as a Bearer token on POST /subscribe. Public-ish, just anti-spam.
export const SUBSCRIBE_SECRET = "268f98a6f5379f006442c44253f6d3d9ce7193c46d905fc6";

// Accounts we expect to see even before the first sync arrives.
export const EXPECTED_ACCOUNTS = ["Claude", "ChatGPT"];
