# Deck ◈

Mission control for the Bun app fleet. One screen to see what's running, start/stop apps, edit their env files, sweep ports for stray listeners, and read logs — mobile-first.

Bun + SQLite, zero npm dependencies. Binds to **127.0.0.1 only** — this is a local tool; it can start processes and read secrets, so never expose it beyond your machine. Auth is TOTP-only: no usernames or passwords stored anywhere; the secret never leaves the server after first-run setup.

## Run

```sh
bun src/server.ts        # http://127.0.0.1:3020 (PORT env overrides)
```

First boot auto-registers the known fleet (`~/workspace/your_files/*`) and re-adopts any apps still running from a previous session.

**First visit:** Deck is locked behind TOTP two-factor auth. Scan the QR with your authenticator app (or type the setup key), enter the 6-digit code, and you're signed in for 30 days on that browser. Sessions are random 256-bit tokens stored hashed in SQLite; login is rate-limited with timing-safe comparison. The 🔒 button signs you out or disables two-factor (requires a current code).

## What it does

- **Fleet cards** — one per app: favicon, status dot, name, port. Tap a card for the
  glassy detail sheet — live stats (status, uptime, PID, port) plus Start/Stop,
  Restart, Env, Logs, and Settings. Port conflicts (two apps on `:3010`, say)
  get a warning banner and a ⚠ flag on the card. Apps without a favicon get a
  letter tile; icons are fetched from each app's own port and cached for a day.
- **▦ Stats widgets** — the apps-icon button in the top bar slides in glassy
  widgets: fleet running/total, port conflicts, stray listeners. Tap a widget
  to jump to the relevant section.
- **Theme** — follows your OS light/dark setting automatically; the ◐ button
  cycles auto → light → dark. Motion is subtle throughout and fully disabled
  under `prefers-reduced-motion`.
- **Env editor** — reads/writes the app's `.env`. Secret-looking keys (`TOKEN`, `KEY`, `SECRET`, `PASSWORD`…) stay masked until you explicitly reveal one; untouched secrets are never sent back to the client. Saving while the app runs offers a one-tap restart.
- **On the wire** — ⌁ Scan sweeps a port range on loopback (default `:3000–:3030`), shows listeners with no registered app, and lets you **Adopt** them into the fleet.
- **Logs** — last 300 lines per app with a follow mode, tailed live from the spawned process.

## Opinions

- **Deck owns `PORT`.** At start time it injects `PORT=<registered port>` over the app's `.env`. A `PORT` line in `.env` is stripped on save with a warning. Change the port on the app card instead.
- **The app's `.env` is the source of truth** for everything else; Deck merges it over its own environment when spawning.
- **Start command** defaults to `bun src/server.ts`, editable per app.
- Logs live in `data/logs/<id>.log` (rotated past ~512KB); runtime PIDs in `data/deck.db`. Both are gitignored.

## API

```
GET    /api/apps                 fleet with live status + port conflicts
POST   /api/apps                 {name, dir, port, start_cmd?}
PATCH  /api/apps/:id             {name?, dir?, port?, start_cmd?}
DELETE /api/apps/:id             (stops first)
POST   /api/apps/:id/start|stop|restart
GET    /api/apps/:id/env         secrets masked
POST   /api/apps/:id/env/reveal  {key}
PUT    /api/apps/:id/env         {vars:[{key, value?|keep?}]}
GET    /api/apps/:id/logs?lines=200
POST   /api/scan                 {from?, to?}
GET    /api/discover             unregistered app-looking directories
GET    /api/health
```

## Tests

```sh
bun run test   # node-based suites: envfile, db, procs, scan, api smoke
```
