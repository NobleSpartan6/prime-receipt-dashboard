/**
 * Shared types for hermes-prime-rlm receipts (receipt.json schema v1).
 * Mirrors the Python models in hermes-prime-rlm/receipt.py.
 */

export type RunStatus =
  | "VERIFIED"
  | "COMPLETED_UNVERIFIED"
  | "FAILED_VERIFICATION"
  | "FAILED"
  | "UNCERTAIN";

export interface CheckRecord {
  name: string;
  status: string;
  exit_code: number | null;
  duration_ms: number;
}

export interface Receipt {
  automatic_retry_allowed: boolean;
  base_commit: string;
  candidate_may_have_partial_changes: boolean;
  candidate_stability: "verified" | "unknown";
  candidate_path: string;
  candidate_tree_sha256: string;
  changed_paths: {
    deleted: string[];
    modified: string[];
    renamed: string[];
    untracked: string[];
  };
  checks: CheckRecord[];
  finished_at: string;
  limitations: string[];
  platform: { os_name: string; python_version: string; sys_platform: string };
  plugin_version: string;
  prime: {
    event_count: number;
    exit_code: number | null;
    final_text: string;
    saw_agent_end: boolean;
    saw_agent_start: boolean;
    session_id: string | null;
  };
  prime_agent_version: string;
  prime_events_sha256: string;
  prime_stderr_sha256: string;
  repository_root: string;
  request_sha256: string;
  run_id: string;
  schema_version: number;
  started_at: string;
  /**
   * Written by newer plugin versions. Older receipts may omit it; absence is
   * surfaced as "UNKNOWN", never folded into UNCERTAIN — an unreadable
   * receipt is not the same fact as an ambiguous run.
   */
  status?: RunStatus;
}

export type DisplayStatus = RunStatus | "UNKNOWN";

/** One run directory = one receipt + one tracked patch. */
export interface RunSummary {
  runId: string;
  shortId: string;
  status: DisplayStatus;
  repositoryRoot: string;
  baseCommitShort: string;
  startedAt: string;
  durationMs: number;
  checksPassed: number;
  checksTotal: number;
  filesModified: number;
  eventCount: number;
  retryAllowed: boolean;
}
