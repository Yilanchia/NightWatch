# Nightwatch

**English** | [中文](README.md)

> A read-only host security watcher: baseline diffs, append-only evidence, daily inspections,
> cross-node correlation. It proposes fixes; it never applies them.

Nightwatch keeps an eye on Linux hosts you own. On a schedule it reads listening ports, the
effective SSH configuration and backup freshness, writes every change into an append-only
evidence log, and produces a daily report. When something deserves attention it produces a
reviewable judgment and proposal instead of changing the machine itself.

## What it does

- **Read-only collection**: listening ports, effective SSH config (`sshd -T` on Linux),
  `authorized_keys` fingerprints, backup age. Commands are hard-coded in the collector; commands
  suggested by a model are never executed.
- **Baseline diffs and finding lifecycle**: new ports, widened listen scopes, SSH config changes,
  key additions/removals. Sustained / resolved / recurring states are recorded, and replay from the
  log gives the same result across restarts.
- **Append-only evidence with a rebuildable view**: `watch.jsonl` is the single source of truth;
  SQLite is only a materialized view that can be deleted and rebuilt at startup.
- **Daily inspections and health**: runs without any model. Blind spots are reported honestly —
  "not read" is not the same as "nothing there".
- **Multiple nodes**: each host exports a **signed summary** (never raw facts or evidence); a
  coordinator pulls them over SSH and correlates by fact key, surfacing problems that hit several
  machines at once.
- **Read-only panel**: local HTTP bound to `127.0.0.1` by default, reached through an SSH tunnel.
  There are no write endpoints.
- **Alerts and notifications**: high-severity findings enter a deterministic queue with rate
  limiting, quiet hours and escalation. Optional outbound push to webhooks such as WeCom, Feishu or
  Bark (local file by default; nothing leaves the host unless configured).

## What it does not do

- **No automatic changes**: `watch_apply_fix` is not registered by default and the write path stays
  closed. Opening it requires an isolation drill and one-time approval.
- **No raw evidence upload**: cross-node traffic carries signed summaries only, with no facts,
  evidence or detail payloads.
- **No inference presented as fact**: in structured judgments, `confirmed` must point at a real
  observation; inference lives separately under candidates, counter and gaps.

## Quick start

Requires **Node.js 24+** (for the built-in `node:sqlite`) and **pnpm**.

```bash
pnpm install
npx tsc -b

# run one real inspection in a temporary home
node scripts/nightwatch.mjs smoke

# your own home: record a baseline, then inspect
node scripts/nightwatch.mjs baseline ./.nightwatch-home
node scripts/nightwatch.mjs tick ./.nightwatch-home      # 0 ok / 2 partial / 1 failed
node scripts/nightwatch.mjs health ./.nightwatch-home
```

Run it continuously with
`node scripts/nightwatch.mjs daemon ./.nightwatch-home 1440` (single-writer lock, one catch-up run
after a restart, no overlapping inspections).

## Commands

| Command | What it does |
|---|---|
| `baseline <home>` | Collect once and record it as the baseline; refuses when there are blind spots |
| `tick <home>` | Run a full inspection and write the daily report; `0` ok / `2` partial / `1` failed |
| `daemon <home> [minutes]` | Built-in scheduler, stays in the foreground |
| `health <home>` | Last run / last all-green, blind spots, stale data, collectors that never ran |
| `timeline <home> <key> [days]` | Replay the timeline of a single fact |
| `panel <home> [port] [host]` | Read-only panel (default `127.0.0.1:3092`) |
| `export <home> [days]` | Signed summary (findings + health, no raw facts) |
| `verify <bundle.json>` | Verify summary signature and node ID |
| `pull-correlate <nodes.json>` | Pull summaries over SSH, ingest, correlate by key; exit code 2 on cross-node high findings |
| `alerts <home> [ack <id>]` | List or acknowledge deterministic alerts |
| `notify <home>` | Send pending alerts under the notification policy (local file by default) |
| `acceptance <home> [days]` | Release gate: daily runs/reports plus rebuild consistency |
| `version` | Print the version |

## Data layout

| Path | What it is | Safe to delete? |
|---|---|---|
| `watch.jsonl` | This machine's history, append-only | **Never** |
| `watch.db` | SQLite materialized view, rebuilt from the log at startup | Yes |
| `watch-reports/` | Daily Markdown reports | Yes |
| `audit.jsonl` | Plugin audit trail | No |
| `judgments.jsonl` / `alerts.jsonl` / `investigations-pending.jsonl` | Judgments / alerts / investigation queue | With care |

Deleting `watch.db` loses nothing: the next start rebuilds it from `watch.jsonl`, and the release
gate checks exactly that consistency.

## Deployment (systemd)

```ini
[Unit]
Description=Nightwatch read-only inspection daemon
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=/opt/nightwatch
Environment=NIGHTWATCH_INTERVAL_MINUTES=1440
ExecStart=/usr/local/bin/node /opt/nightwatch/scripts/nightwatch.mjs daemon /var/lib/nightwatch
Restart=on-failure
RestartSec=30

[Install]
WantedBy=multi-user.target
```

The panel runs as its own unit:
`ExecStart=... panel /var/lib/nightwatch 3092 127.0.0.1` — localhost only.

## Multiple nodes

```bash
# on each node
node scripts/nightwatch.mjs export /var/lib/nightwatch 7

# on the coordinator: pull over SSH, register, ingest, correlate
node scripts/nightwatch.mjs pull-correlate ./nodes.json
```

- Transport is SSH (encrypted); the non-TLS HTTP prototype is not used.
- The coordinator's key is restricted on the target to `export` only (`command=` plus no pty and
  no forwarding).
- `ingestBundle` rejects older sequence numbers (replay/reordering) and is idempotent for the same
  sequence.
- `coordinator-state.json` is the single aggregate and can be rebuilt from node bundles; do not
  edit it by hand.

`nodes.example.json` is a placeholder template — copy it to a private config and fill in real
targets.

## Security boundaries

1. Collection commands are hard-coded; a model can only choose which collector to run, never
   compose a command.
2. A failed collection becomes a "blind spot" in the report, never "all ports disappeared".
3. Execution has one narrow path (three specific SSH line edits, file paths from config rather
   than from the model) and is off by default. Enabling it still requires the guard and one-time
   approval.
4. `.env`, tokens and private keys never enter the store; `authorized_keys` is stored as algorithm
   and fingerprints only.
5. Collected text is data, not instructions.
6. Cross-node traffic carries signed summaries only; outbound notifications are projected and
   redacted first.

## Status

- `v0.1.0`: single-host read-only inspection, evidence log, daily reports, panel, structured
  investigation, alerts.
- `v0.2.0`: two-node watch, SSH-based cross-node correlation, coordinator, multi-node panel view,
  alert discipline and outbound push interface.

See [docs/CHANGELOG.md](docs/CHANGELOG.md) for details.

## Documentation

Docs are currently in Chinese:

- [docs/nightwatch.md](docs/nightwatch.md) — configuration, data and security boundaries
- [docs/design.md](docs/design.md) — multi-node defence network design
- [docs/CHANGELOG.md](docs/CHANGELOG.md) — changelog
