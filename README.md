# prime-receipt-dashboard

A local, read-only web dashboard for
[hermes-prime-rlm](../hermes-prime-rlm) verification receipts. Point it at a
Prime RLM `runs/` directory and it renders every run's status, host-executed
check results, and full hash-chained receipt — the human side of the
"agent claims nothing, evidence decides everything" pipeline.

TypeScript (Node 22+, zero runtime dependencies), strict mode, GET-only API.

![statuses](docs/statuses.png)

## Run it

```bash
npm install
PRIME_RLM_RUNS="C:/Users/<you>/AppData/Local/hermes/plugin-data/agent-plugin-prime-rlm-946728fa/runs" \
  npm start
# → http://localhost:8787
```

or `npx tsx server.ts --runs <path-to-runs-dir>`.

## What you'll see

| Column | Source field |
|---|---|
| status | `receipt.status` — VERIFIED / FAILED_VERIFICATION / UNCERTAIN / … |
| run | `run_id` (click a row for the full receipt JSON) |
| checks | independently executed host checks, passed/total |
| files | candidate changed paths |
| events | Prime event-stream record count |
| retry | always "never" — one invocation = one Prime process |

## API

| Route | Purpose |
|---|---|
| `GET /api/runs` | summaries parsed from every `receipt.json` in the runs dir |
| `GET /api/receipt/:runId` | one full receipt (strict UUID validation) |
| `GET /api/health` | liveness + which runs dir is mounted |

Read-only by construction: there are no mutating endpoints, the runs path is
fixed at startup (never taken from requests), run ids are validated against a
strict UUID pattern before touching the filesystem, and static serving is
jailed to `public/`.

## Type safety

`types.ts` mirrors the Python receipt schema (`schema_version: 1`). The server
parses defensively: a run directory without a complete receipt is skipped, not
guessed.
