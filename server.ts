/**
 * Local server: scans a hermes-prime-rlm runs directory, validates every
 * receipt.json (structure + self-hash + run_id/dir binding), and serves a
 * read-only dashboard of verification evidence.
 *
 * Trust model:
 * - Receipts are UNTRUSTED local data. The server is the validation
 *   boundary; the browser only ever sees validated, path-minimized DTOs.
 * - Corrupt/malicious receipts become INVALID_RECEIPT rows — they never
 *   crash the listing and never reach the browser unvalidated.
 * - Read-only by construction: only GET endpoints exist. Bound to the
 *   loopback interface only. The runs path comes from --runs or
 *   PRIME_RLM_RUNS env var — never from the request.
 */
import { createServer } from "node:http";
import { opendir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readUtf8Bounded } from "./bounded-io.ts";
import {
  RUN_ID_RE,
  validateReceiptEnvelope,
  type DisplayStatus,
  type Receipt,
  type RunSummary,
} from "./types.ts";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
// server.ts runs from the repo root under tsx; the emitted server.js runs from
// dist/. In both cases static assets are siblings under <app-root>/public.
const APP_ROOT = basename(MODULE_DIR) === "dist" ? resolve(MODULE_DIR, "..") : MODULE_DIR;
const PUBLIC_ROOT = join(APP_ROOT, "public");

const args = process.argv.slice(2);
const runsFlag = args.indexOf("--runs");
const RUNS_DIR = resolve(
  runsFlag >= 0 && args[runsFlag + 1]
    ? args[runsFlag + 1]!
    : process.env.PRIME_RLM_RUNS ?? "runs",
);
const HOST = "127.0.0.1"; // loopback ONLY — this service has no auth layer
const PORT = Number(process.env.PORT ?? 8787);

// Bounds: a hostile or corrupt runs directory must not exhaust the server.
const MAX_RUNS_SCANNED = 2000;
const MAX_RECEIPT_BYTES = 4 * 1024 * 1024;
const MAX_STATUS_BYTES = 128;
const MAX_LOAD_CONCURRENCY = 16;

const STATUS_ORDER: Record<string, number> = {
  VERIFIED: 0,
  FAILED_VERIFICATION: 1,
  FAILED: 2,
  COMPLETED_UNVERIFIED: 3,
  UNCERTAIN: 4,
  INVALID_RECEIPT: 5,
};

/** Path minimization: last two segments of a repo path, forward-slashed. */
function repoLabel(p: string): string {
  const parts = p.split(/[\\/]/).filter((s) => s.length > 0);
  return parts.slice(-2).join("/") || p;
}

function displayStatus(r: Receipt): DisplayStatus {
  return r.status;
}

interface LoadedReceipt {
  summary: RunSummary;
  receipt?: Receipt;
}

/**
 * Browser-safe receipt projection. Absolute paths, the effective argv (which
 * may contain absolute executable paths), and Prime's free-form final text do
 * not cross the HTTP boundary. The on-disk receipt remains untouched.
 */
function receiptDetailDto(r: Receipt): Record<string, unknown> {
  const {
    repository_root: _repositoryRoot,
    candidate_path: _candidatePath,
    prime_argv: _primeArgv,
    prime,
    ...safe
  } = r;
  const { final_text: _finalText, ...safePrime } = prime;
  return {
    ...safe,
    prime: safePrime,
  };
}

async function loadRun(dir: string): Promise<LoadedReceipt | null> {
  const runDir = await realPathWithin(RUNS_DIR, join(RUNS_DIR, dir));
  if (!runDir) return null;
  const receiptPath = join(runDir, "receipt.json");
  const statusPath = join(runDir, "status.txt");
  let raw: string;
  let statusMarker: string;
  try {
    // status.txt is the atomic completion marker written only after the
    // receipt is finalized. Missing marker means in-flight or crash-abandoned.
    const [statusFile, receiptFile] = await Promise.all([
      realPathWithin(runDir, statusPath),
      realPathWithin(runDir, receiptPath),
    ]);
    if (!statusFile || !receiptFile) throw new Error("run files escape their directory");
    statusMarker = (await readUtf8Bounded(statusFile, MAX_STATUS_BYTES)).trim();
    raw = await readUtf8Bounded(receiptFile, MAX_RECEIPT_BYTES);
  } catch {
    return null; // no receipt yet / unreadable — skip, don't guess
  }

  let envelope: unknown;
  try {
    envelope = JSON.parse(raw);
  } catch {
    return {
      summary: {
        runId: dir,
        shortId: dir.slice(0, 8),
        status: "INVALID_RECEIPT",
        integrity: "MALFORMED",
        authenticity: "UNSIGNED",
        executionStatus: "LEGACY_UNSPECIFIED",
        candidateStatus: "LEGACY_UNSPECIFIED",
        verificationStatus: "LEGACY_UNSPECIFIED",
        verificationAuthority: "LEGACY_UNSPECIFIED",
        acceptanceStatus: "LEGACY_UNSPECIFIED",
        evidenceIntegrityStatus: "LEGACY_UNSPECIFIED",
        repositoryLabel: "",
        baseCommitShort: "",
        startedAt: "",
        durationMs: Number.NaN,
        checksPassed: 0,
        checksTotal: 0,
        changedPathCount: 0,
        eventCount: 0,
        retryAllowed: false,
      },
    };
  }

  const check = await validateReceiptEnvelope(envelope, dir);
  if (!check.result.ok || !check.result.receipt) {
    return {
      summary: invalidSummary(dir, check.hashValid === false ? "HASH_MISMATCH" : "MALFORMED"),
    };
  }
  const r = check.result.receipt;
  if (statusMarker !== r.status) {
    return { summary: invalidSummary(dir, "MALFORMED") };
  }
  const startMs = Date.parse(r.started_at);
  const endMs = Date.parse(r.finished_at);
  const summaries: RunSummary = {
    runId: r.run_id,
    shortId: r.run_id.slice(0, 8),
    status: displayStatus(r),
    integrity: "SELF_HASH_VALID",
    authenticity: "UNSIGNED",
    executionStatus: r.execution_status ?? "LEGACY_UNSPECIFIED",
    candidateStatus: r.candidate_status ?? "LEGACY_UNSPECIFIED",
    verificationStatus: r.verification_status ?? "LEGACY_UNSPECIFIED",
    verificationAuthority: r.verification_authority ?? "LEGACY_UNSPECIFIED",
    acceptanceStatus: r.acceptance_status ?? "LEGACY_UNSPECIFIED",
    evidenceIntegrityStatus: r.integrity_status ?? "LEGACY_UNSPECIFIED",
    repositoryLabel: repoLabel(r.repository_root),
    baseCommitShort: r.base_commit.slice(0, 7),
    startedAt: r.started_at,
    durationMs: endMs - startMs,
    checksPassed: r.checks.filter((c) => c.status === "passed").length,
    checksTotal: r.checks.length,
    changedPathCount:
      r.changed_paths.modified.length +
      r.changed_paths.deleted.length +
      r.changed_paths.renamed.length +
      r.changed_paths.untracked.length,
    eventCount: r.prime.event_count,
    retryAllowed: r.automatic_retry_allowed,
  };
  return { summary: summaries, receipt: r };
}

function invalidSummary(dir: string, integrity: "HASH_MISMATCH" | "MALFORMED"): RunSummary {
  return {
    runId: dir,
    shortId: dir.slice(0, 8),
    status: "INVALID_RECEIPT",
    integrity,
    authenticity: "UNSIGNED",
    executionStatus: "LEGACY_UNSPECIFIED",
    candidateStatus: "LEGACY_UNSPECIFIED",
    verificationStatus: "LEGACY_UNSPECIFIED",
    verificationAuthority: "LEGACY_UNSPECIFIED",
    acceptanceStatus: "LEGACY_UNSPECIFIED",
    evidenceIntegrityStatus: "LEGACY_UNSPECIFIED",
    repositoryLabel: "",
    baseCommitShort: "",
    startedAt: "",
    durationMs: Number.NaN,
    checksPassed: 0,
    checksTotal: 0,
    changedPathCount: 0,
    eventCount: 0,
    retryAllowed: false,
  };
}

async function listRuns(): Promise<RunSummary[]> {
  const dirs: string[] = [];
  try {
    const directory = await opendir(RUNS_DIR);
    let entriesScanned = 0;
    for await (const entry of directory) {
      entriesScanned += 1;
      if (entry.isDirectory() && RUN_ID_RE.test(entry.name)) dirs.push(entry.name);
      if (entriesScanned >= MAX_RUNS_SCANNED) break;
    }
  } catch {
    return [];
  }
  const loaded = await mapWithConcurrency(dirs, MAX_LOAD_CONCURRENCY, loadRun);
  return loaded
    .filter((l): l is LoadedReceipt => l !== null)
    .map((l) => l.summary)
    .sort(
      (a, b) =>
        (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) ||
        b.startedAt.localeCompare(a.startedAt),
    );
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  operation: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (true) {
        const index = next;
        next += 1;
        if (index >= items.length) return;
        results[index] = await operation(items[index]!);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  // Script and style from self only; no inline handlers; no remote origins;
  // no framing; no form action anywhere else.
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
};

function sendJson(res: import("node:http").ServerResponse, code: number, data: unknown): void {
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    ...SECURITY_HEADERS,
  });
  res.end(JSON.stringify(data));
}

async function realPathWithin(root: string, target: string): Promise<string | null> {
  try {
    const [rootReal, targetReal] = await Promise.all([realpath(root), realpath(target)]);
    const rel = relative(rootReal, targetReal);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)) ? targetReal : null;
  } catch {
    return null;
  }
}

async function serveStatic(
  urlPath: string,
  res: import("node:http").ServerResponse,
): Promise<boolean> {
  if (urlPath === "/" || !urlPath.includes(".")) return false;
  const candidate = resolve(PUBLIC_ROOT, "." + urlPath);
  const file = await realPathWithin(PUBLIC_ROOT, candidate);
  if (!file) return false;
  try {
    const body = await readFile(file);
    await stat(file);
    const mime = MIME[extname(file)] ?? "application/octet-stream";
    res.writeHead(200, { "content-type": mime, ...SECURITY_HEADERS });
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

const server = createServer(async (req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    sendJson(res, 405, { error: "read-only service" });
    return;
  }
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  try {
    if (await serveStatic(url.pathname, res)) return;
    if (url.pathname === "/") {
      const index = join(PUBLIC_ROOT, "index.html");
      const body = await readFile(index);
      res.writeHead(200, { "content-type": MIME[".html"]!, ...SECURITY_HEADERS });
      res.end(body);
      return;
    }
    if (url.pathname === "/api/runs") {
      sendJson(res, 200, await listRuns());
      return;
    }
    if (url.pathname.startsWith("/api/receipt/")) {
      const id = url.pathname.split("/")[3] ?? "";
      if (!RUN_ID_RE.test(id)) {
        sendJson(res, 400, { error: "bad run id" });
        return;
      }
      const loaded = await loadRun(id);
      if (!loaded || !loaded.receipt) {
        sendJson(res, 404, { error: "no valid receipt for that run" });
        return;
      }
      // Path-minimized DTO: absolute local paths and untrusted free-form Prime
      // text never cross the HTTP boundary.
      sendJson(res, 200, {
        receipt: receiptDetailDto(loaded.receipt),
        paths_redacted: true,
      });
      return;
    }
    if (url.pathname === "/api/health") {
      // No filesystem paths in health output.
      sendJson(res, 200, { ok: true, service: "prime-receipt-dashboard" });
      return;
    }
    sendJson(res, 404, { error: "not found" });
  } catch (err) {
    sendJson(res, 500, { error: "internal error" });
    console.error("[dashboard] request failed:", err);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`prime-receipt-dashboard → http://${HOST}:${PORT} (loopback only)`);
});
