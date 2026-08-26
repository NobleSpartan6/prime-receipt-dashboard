/**
 * Dashboard client: renders run summaries + receipt drill-down.
 *
 * XSS contract: every receipt-derived string enters the DOM through
 * `textContent` (or trusted constants through `className`). No innerHTML,
 * no insertAdjacentHTML, anywhere. The server has already validated the
 * data, but the client never trusts that alone.
 */

interface RunSummary {
  runId: string;
  shortId: string;
  status: string;
  integrity: "SELF_HASH_VALID" | "HASH_MISMATCH" | "MALFORMED";
  authenticity: "UNSIGNED";
  executionStatus: string;
  candidateStatus: string;
  verificationStatus: string;
  verificationAuthority: string;
  acceptanceStatus: string;
  evidenceIntegrityStatus: string;
  repositoryLabel: string;
  baseCommitShort: string;
  startedAt: string;
  durationMs: number;
  checksPassed: number;
  checksTotal: number;
  changedPathCount: number;
  eventCount: number;
  retryAllowed: boolean;
}

interface HealthInfo {
  ok: boolean;
  service: string;
}

const tbody = document.querySelector<HTMLTableSectionElement>("#runs tbody")!;
const statsEl = document.querySelector<HTMLDivElement>("#stats")!;
const dirEl = document.querySelector<HTMLParagraphElement>("#runs-dir")!;
const detail = document.querySelector<HTMLElement>("#detail")!;

/** Build an element with text content — the only untrusted-text path. */
function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Status names are server-validated enum values; class list stays closed.
function badgeClass(status: string): string {
  const known = new Set([
    "VERIFIED",
    "COMPLETED_UNVERIFIED",
    "FAILED_VERIFICATION",
    "FAILED",
    "UNCERTAIN",
    "INVALID_RECEIPT",
  ]);
  return known.has(status) ? `badge ${status}` : "badge UNKNOWN";
}

function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function renderStats(runs: RunSummary[]): void {
  statsEl.replaceChildren();
  const by = (s: string) => runs.filter((r) => r.status === s).length;

  const stat = (value: number, label: string, color?: string) => {
    const box = el("div", "stat");
    const b = el("b", undefined, String(value));
    if (color === "ok" || color === "bad") b.style.color = `var(--${color})`;
    box.append(b, el("span", "dim", label));
    return box;
  };

  statsEl.append(
    stat(runs.length, "total runs"),
    stat(by("VERIFIED"), "verified", "ok"),
    stat(
      by("FAILED_VERIFICATION") + by("FAILED") + by("INVALID_RECEIPT"),
      "failed/invalid",
      "bad",
    ),
    stat(by("UNCERTAIN"), "uncertain"),
  );
}

function renderRow(r: RunSummary): HTMLTableRowElement {
  const tr = document.createElement("tr");
  tr.dataset.id = r.runId; // UUID — validated server-side before it got here

  const statusCell = el("td");
  // Badge text is a validated enum value, still routed via textContent.
  statusCell.append(el("span", badgeClass(r.status), r.status));
  tr.append(statusCell);
  tr.append(el("td", "mono dim", r.integrity));
  tr.append(el("td", "mono dim", r.authenticity));
  tr.append(el("td", "mono dim", r.executionStatus));
  tr.append(el("td", "mono dim", r.evidenceIntegrityStatus));
  tr.append(el("td", "mono dim", r.verificationStatus));
  tr.append(el("td", "mono dim", r.verificationAuthority));
  tr.append(el("td", "mono dim", r.candidateStatus));
  tr.append(el("td", "mono dim", r.acceptanceStatus));

  tr.append(el("td", "mono", r.shortId));
  // Repository shown as last-two-segments label — no absolute paths in UI.
  tr.append(el("td", "mono dim", r.repositoryLabel));
  tr.append(el("td", "mono dim", r.baseCommitShort));
  tr.append(el("td", undefined, fmtDuration(r.durationMs)));
  tr.append(el("td", undefined, `${r.checksPassed}/${r.checksTotal}`));
  tr.append(el("td", undefined, String(r.changedPathCount)));
  tr.append(el("td", "dim", r.eventCount.toLocaleString()));
  tr.append(el("td", "dim", r.retryAllowed ? "yes" : "never"));
  return tr;
}

async function loadRuns(): Promise<void> {
  const resp = await fetch("/api/runs");
  const runs = (await resp.json()) as RunSummary[];
  renderStats(runs);
  tbody.replaceChildren(...runs.map(renderRow));
  for (const tr of tbody.querySelectorAll("tr")) {
    tr.addEventListener("click", () => void showReceipt(tr.dataset.id ?? ""));
  }
}

async function showReceipt(runId: string): Promise<void> {
  const resp = await fetch(`/api/receipt/${encodeURIComponent(runId)}`);
  if (!resp.ok) {
    detail.hidden = true;
    return;
  }
  const body = (await resp.json()) as { receipt: unknown };
  document.querySelector<HTMLElement>("#detail-id")!.textContent = runId.slice(0, 8);
  // Receipt JSON renders as TEXT ONLY — a forged receipt can style nothing,
  // inject nothing, and execute nothing.
  document.querySelector<HTMLPreElement>("#receipt-json")!.textContent =
    JSON.stringify(body.receipt, null, 2);
  detail.hidden = false;
  detail.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

document.querySelector("#close-detail")!.addEventListener("click", () => {
  detail.hidden = true;
});

void (async () => {
  const health = (await (await fetch("/api/health")).json()) as HealthInfo;
  // Health no longer exposes filesystem paths.
  dirEl.textContent = health.ok
    ? "reading local receipts (loopback-only read-only service)"
    : "service unhealthy";
  await loadRuns();
})();
