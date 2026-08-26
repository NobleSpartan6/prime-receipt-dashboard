# prime-receipt-dashboard

A local, read-only projection for
[hermes-prime-rlm](https://github.com/NobleSpartan6/hermes-prime-rlm)
host-observed review receipts.

The dashboard validates each receipt's schema-v1 structure, recomputes its
canonical payload self-hash, binds `run_id` to its directory, and renders a
path-minimized summary. It does **not** prove evidence custody, rehash every
referenced artifact, or authenticate the receipt signer. Receipts are displayed
as `SELF_HASH_VALID` and `UNSIGNED` so those limits remain visible.

TypeScript, strict mode, zero production dependencies. The service binds only
to `127.0.0.1` and exposes GET/HEAD routes only.

## Build and run

Requires Node.js 20 or 22.

```bash
npm ci
npm run build
PRIME_RLM_RUNS="C:/path/to/hermes/plugin-data/prime-rlm/runs" npm start
# http://127.0.0.1:8787
```

`npm run build` emits the exact programs served at runtime:

```text
dist/server.js
public/app.js
public/index.html
public/style.css
```

`npm start` executes plain Node against `dist/server.js`; `tsx` is not a
runtime dependency.

## What it shows

| Field | Meaning |
|---|---|
| status | The validated receipt status (`VERIFIED`, `UNCERTAIN`, etc.) |
| self-hash | `SELF_HASH_VALID`, `HASH_MISMATCH`, or `MALFORMED` |
| authenticity | `UNSIGNED` for receipt schema v1 |
| execution | Whether Prime reached a completed, failed, or uncertain boundary |
| evidence | `RECORDED_NOT_REVALIDATED`: referenced artifacts were not rehashed by this UI |
| verification | Whether recorded checks passed, failed, or did not run |
| authority | Who selected the checks (`MODEL_PROPOSED`, `OPERATOR_POLICY`, or `NONE`) |
| candidate | `UNQUIESCED` until process-tree quiescence is actually proven |
| acceptance | Human disposition (`PENDING`, `ACCEPTED`, or `REJECTED`) |
| checks | Host-observed check records with validated `passed` statuses |
| files | Total changed paths across modified/deleted/renamed/untracked buckets |
| events | Prime lifecycle-event record count |
| retry | Whether the receipt permits automatic retry (v0.1 receipts say never) |

Only runs with an atomically written `status.txt` completion marker matching
the receipt status are served. Malformed or hash-mismatched receipts become
isolated `INVALID_RECEIPT` rows instead of failing the whole listing.

## API

| Route | Purpose |
|---|---|
| `GET /api/runs` | Validated, path-minimized run summaries |
| `GET /api/receipt/:runId` | Validated redacted detail DTO |
| `GET /api/health` | Path-free liveness response |

The detail DTO excludes absolute repository/candidate paths, the effective
Prime argv, and Prime's free-form final text. The on-disk receipt is never
modified.

## Security properties

- Receipts are untrusted input; TypeScript assertions are not used as runtime validation.
- Receipt-controlled browser text is inserted with `textContent`, never `innerHTML`.
- Static files are realpath-contained under `public/`, including symlink resolution.
- Requests receive a restrictive CSP and `X-Content-Type-Options: nosniff`.
- The runs directory is fixed at startup and never selected by an HTTP request.
- Receipt and completion-marker files are read through one opened handle with
  hard byte ceilings; run directories are streamed, total traversed entries are
  capped, and receipt loads use a bounded worker pool.

This is a local review UI, not an attestation verifier. A process with authority
to rewrite a receipt can also recompute its unsigned self-hash.

The convenience status `VERIFIED` means that recorded host-observed checks
passed. It does not imply operator-authorized checks, process-tree quiescence,
independent evidence custody, authenticity, or human acceptance. New v0.1.1
receipts expose those facts as separate columns; older receipts display
`LEGACY_UNSPECIFIED` for axes they did not record.

## Proof it works

```bash
npm ci
npx playwright install chromium
npm test
```

The test command:

1. Builds server and browser artifacts.
2. Validates good, malformed, mismatched, incomplete, and tampered receipts.
3. Starts the emitted server from multiple working directories.
4. Verifies loopback/read-only/path-redaction behavior.
5. Launches real headless Chromium, renders the run table, opens receipt detail,
   and checks that receipt-controlled HTML remains inert text.

CI runs build/unit tests on Windows, macOS, and Linux with Node 20 and 22, plus
a Chromium smoke test against the emitted artifact.
