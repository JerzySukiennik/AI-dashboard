# AI-dashboard — Hooki powiadomień

Skrypty, które pingują Workera dashboardu (`/notify`), gdy agent skończy zadanie.

| Plik | Rola |
|------|------|
| `claude-code-stop-hook.sh` | Hook **Stop** w Claude Code — powiadamia po zakończeniu tury. |
| `claude-code-settings-snippet.json` | Fragment do wklejenia w `~/.claude/settings.json`. |
| `codex-notify.sh` | Program `notify` dla Codex CLI. |
| `notify-task` | Ręczny fallback z terminala. |

We wszystkich plikach `__WORKER_URL__` / `__NOTIFY_SECRET__` podstawia orchestrator. Wszystkie `.sh` wymagają `chmod +x`.

## Claude Code (hook Stop)

1. Skopiuj skrypt:
   ```
   cp claude-code-stop-hook.sh ~/.claude/hooks/ai-dashboard-stop.sh
   chmod +x ~/.claude/hooks/ai-dashboard-stop.sh
   ```
2. Wmerguj `claude-code-settings-snippet.json` do `~/.claude/settings.json` (dołóż do istniejącego `hooks`, nie nadpisuj całości).
3. Skrypt czyta JSON ze stdin, bierze pierwszą linię ostatniej wiadomości (≈120 znaków) i nazwę projektu (basename `cwd`). Pomija powiadomienie, gdy `stop_reason == "tool_use"`. **Zawsze kończy się `exit 0`** — nie zablokuje Claude Code.

## Codex CLI

1. Skopiuj skrypt:
   ```
   cp codex-notify.sh ~/.codex/ai-dashboard-notify.sh
   chmod +x ~/.codex/ai-dashboard-notify.sh
   ```
2. W `~/.codex/config.toml` dodaj:
   ```toml
   notify = ["/Users/jurek/.codex/ai-dashboard-notify.sh"]
   ```
3. Codex woła skrypt z finalnym argumentem JSON (`{"type":"agent-turn-complete","turn-id":"..."}`). Etykieta zadania: `last-assistant-message`/`input_messages` jeśli są, inaczej `Task finished (turn <id>)`. Zawsze `exit 0`.

## Ręczny fallback

```
cp notify-task ~/bin/notify-task     # lub inny katalog w PATH
chmod +x ~/bin/notify-task
notify-task "Skończyłem render" "Blender"
```

Wysyła `{tool: tool||"Manual", task: label}` i wypisuje potwierdzenie lub błąd (kod HTTP).

## Zależności

`jq` jest preferowane; jeśli go brak, skrypty używają `python3`. Bez obu — Claude/Codex hooki po cichu wychodzą `exit 0` (nie psują niczego).
