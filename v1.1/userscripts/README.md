# AI-dashboard — Userscripts (kolektory zużycia)

Dwa userscripty Tampermonkey, które czytają limity zużycia AI i wysyłają je do Workera dashboardu.

- `claude-usage.user.js` — działa na `claude.ai/*`, konto **Claude** (limit 5h + tygodniowy).
- `chatgpt-usage.user.js` — działa na `chatgpt.com/*`, konto **ChatGPT** (rate-limit + Codex).

## Instalacja

1. Zainstaluj rozszerzenie **Tampermonkey** (Chrome / Safari / Firefox).
2. Otwórz plik `*.user.js` — Tampermonkey wykryje nagłówek i pokaże ekran instalacji. Kliknij **Install / Zainstaluj**.
   - Alternatywnie: dashboard Tampermonkey → *Create new script* → wklej całą zawartość → zapisz (Ctrl/Cmd+S).
3. Wejdź na `claude.ai` (Settings → Usage pomaga złapać dane) i na `chatgpt.com`.
4. Dane lecą do Workera po każdym przechwyceniu oraz co 5 min jako heartbeat.

## Konfiguracja i naprawa

Wszystko, co może się zepsuć (endpointy, regexy, mapowanie pól, selektory DOM), siedzi w obiekcie **`CONFIG`** na górze każdego pliku — to jedyne miejsce do edycji.

- `CONFIG.DEBUG = true` → gadatliwe logi w konsoli z prefiksem `[AI-dashboard]`.
- Jeśli po 2 min nic nie przechwycono, skrypt wypisze ostrzeżenie w konsoli.
- `__WORKER_URL__`, `__INGEST_SECRET__` — podstawia orchestrator (nie commituj wypełnionych wartości).

> Uwaga: Claude.ai i ChatGPT nie mają publicznego API zużycia. Kształt odpowiedzi i selektory **będą się zmieniać** — od czasu do czasu trzeba będzie zaktualizować `CONFIG`.

## Jak to działa (skrót)

1. **Primary:** hook na `fetch` + `XMLHttpRequest` — łapie odpowiedzi, których URL pasuje do `CONFIG.usageUrlRegex`, parsuje JSON i mapuje pola.
2. **Proactive:** raz złapany działający endpoint jest zapamiętany (`GM_setValue`) i odpytywany co 5 min.
3. **Fallback:** scraping DOM na stronie Settings → Usage wg selektorów z `CONFIG.dom`.

Procenty są normalizowane: jeśli źródło daje tylko `utilization`/`percent`, ustawiamy `used = percent`, `limit = 100`.
