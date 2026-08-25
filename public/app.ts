/** Dashboard client: renders run summaries + receipt drill-down. */

interface RunSummary {
  runId: string; shortId: string; status: string;
  repositoryRoot: string; baseCommitShort: string;
  startedAt: string; durationMs: number;
  checksPassed: number; checksTotal: number;
  filesModified: number; eventCount: number; retryAllowed: boolean;
}

const tbody = document.querySelector<HTMLTableSectionElement>("#runs tbody")!;
const statsEl = document.querySelector<HTMLDivElement>("#stats")!;
const dirEl = document.querySelector<HTMLParagraphElement>("#runs-dir")!;
const detail = document.querySelector<HTMLElement>("#detail")!;

function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function renderStats(runs: RunSummary[]): void {
  const by = (s: string) => runs.filter((r) => r.status === s).length;
  statsEl.innerHTML = `
    <div class="stat"><b>${runs.length}</b><span class="dim">total runs</span></div>
    <div class="stat"><b style="color:var(--ok)">${by("VERIFIED")}</b><span class="dim">verified</span></div>
    <div class="stat"><b style="color:var(--bad)">${by("FAILED_VERIFICATION") + by("FAILED")}</b><span class="dim">failed</span></div>
    <div class="stat"><b style="color:var(--dim)">${by("UNCERTAIN")}</b><span class="dim">uncertain</span></div>
    <div class="stat"><b style="color:var(--dim)">${by("UNKNOWN")}</b><span class="dim">unreadable receipt</span></div>`;
}

async function loadRuns(): Promise<void> {
  const runs = await (await fetch("/api/runs")).json() as RunSummary[];
  renderStats(runs);
  tbody.innerHTML = runs
    .map((r) => `
      <tr data-id="${r.runId}">
        <td><span class="badge ${r.status}">${r.status}</span></td>
        <td class="mono">${r.shortId}</td>
        <td class="mono dim">${r.repositoryRoot.split(/[\\/]/).slice(-2).join("/")}</td>
        <td class="mono dim">${r.baseCommitShort}</td>
        <td>${fmtDuration(r.durationMs)}</td>
        <td>${r.checksPassed}/${r.checksTotal}</td>
        <td>${r.filesModified}</td>
        <td class="dim">${r.eventCount.toLocaleString()}</td>
        <td class="dim">${r.retryAllowed ? "yes" : "never"}</td>
      </tr>`)
    .join("");
  for (const tr of tbody.querySelectorAll("tr")) {
    tr.addEventListener("click", () => void showReceipt(tr.dataset.id ?? ""));
  }
}

async function showReceipt(runId: string): Promise<void> {
  const resp = await fetch(`/api/receipt/${runId}`);
  if (!resp.ok) { detail.hidden = true; return; }
  document.querySelector<HTMLElement>("#detail-id")!.textContent = runId.slice(0, 8);
  document.querySelector<HTMLPreElement>("#receipt-json")!.textContent =
    JSON.stringify((await resp.json()).receipt, null, 2);
  detail.hidden = false;
  detail.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

document.querySelector("#close-detail")!.addEventListener("click", () => {
  detail.hidden = true;
});

void (async () => {
  const health = await (await fetch("/api/health")).json();
  dirEl.textContent = `reading receipts from ${health.runsDir}`;
  await loadRuns();
})();
