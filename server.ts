/**
 * Local server: scans a hermes-prime-rlm runs directory, parses every
 * receipt.json, and serves a read-only dashboard of verification evidence.
 *
 * Read-only by construction: only GET endpoints exist. The runs path comes
 * from --runs or the PRIME_RLM_RUNS env var — never from the request.
 */
import { createServer } from "node:http";
import { readFile, readdir, stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import type { Receipt, RunSummary } from "./types.ts";

const args = process.argv.slice(2);
const runsFlag = args.indexOf("--runs");
const RUNS_DIR = resolve(
  runsFlag >= 0 && args[runsFlag + 1]
    ? args[runsFlag + 1]!
    : process.env.PRIME_RLM_RUNS ?? "runs"
);
const PORT = Number(process.env.PORT ?? 8787);

const STATUS_ORDER: Record<string, number> = {
  VERIFIED: 0,
  FAILED_VERIFICATION: 1,
  FAILED: 2,
  COMPLETED_UNVERIFIED: 3,
  UNCERTAIN: 4,
};

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

async function listRuns(): Promise<RunSummary[]> {
  let dirs: string[];
  try {
    dirs = await readdir(RUNS_DIR);
  } catch {
    return [];
  }
  const summaries: RunSummary[] = [];
  for (const dir of dirs) {
    const receiptPath = join(RUNS_DIR, dir, "receipt.json");
    let raw: string;
    try {
      raw = await readFile(receiptPath, "utf-8");
    } catch {
      continue; // run directory without a receipt yet — skip, don't guess
    }
    const r = JSON.parse(raw).receipt as Receipt;
    summaries.push({
      runId: r.run_id,
      shortId: r.run_id.slice(0, 8),
      // Absent status stays UNKNOWN — do not conflate "receipt predates the
      // status field" with "run was ambiguous".
      status: r.status ?? "UNKNOWN",
      repositoryRoot: r.repository_root,
      baseCommitShort: r.base_commit.slice(0, 7),
      startedAt: r.started_at,
      durationMs:
        new Date(r.finished_at).getTime() - new Date(r.started_at).getTime(),
      checksPassed: r.checks.filter((c) => c.exit_code === 0).length,
      checksTotal: r.checks.length,
      filesModified: r.changed_paths.modified.length,
      eventCount: r.prime.event_count,
      retryAllowed: r.automatic_retry_allowed,
    });
  }
  return summaries.sort(
    (a, b) =>
      (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) ||
      b.startedAt.localeCompare(a.startedAt)
  );
}

async function serveJson(res: import("node:http").ServerResponse, data: unknown) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(data, null, 2));
}

async function serveStatic(
  urlPath: string,
  res: import("node:http").ServerResponse
): Promise<boolean> {
  if (urlPath === "/" || !urlPath.includes(".")) return false;
  const file = resolve("public", "." + urlPath);
  if (!file.startsWith(resolve("public"))) return false; // traversal guard
  try {
    const body = await readFile(file);
    await stat(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  try {
    if (await serveStatic(url.pathname, res)) return;
    if (url.pathname === "/") {
      const index = resolve("public", "index.html");
      try {
        const body = await readFile(index);
        res.writeHead(200, { "content-type": MIME[".html"]! });
        res.end(body);
        return;
      } catch { /* fall through to API routes */ }
    }
    if (url.pathname === "/api/runs") return void (await serveJson(res, await listRuns()));
    if (url.pathname.startsWith("/api/receipt/")) {
      const id = url.pathname.split("/")[2] ?? "";
      // strict id format — no traversal through the run id
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
        res.writeHead(400).end("bad run id");
        return;
      }
      const raw = await readFile(join(RUNS_DIR, id, "receipt.json"), "utf-8");
      return void (await serveJson(res, JSON.parse(raw)));
    }
    if (url.pathname === "/api/health") {
      return void (await serveJson(res, { ok: true, runsDir: RUNS_DIR }));
    }
    res.writeHead(404).end("not found");
  } catch (err) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: String(err) }));
  }
});

server.listen(PORT, () =>
  console.log(`prime-receipt-dashboard → http://localhost:${PORT}  (runs: ${RUNS_DIR})`)
);
