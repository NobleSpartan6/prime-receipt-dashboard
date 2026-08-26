/**
 * Shared types + RUNTIME VALIDATION for hermes-prime-rlm receipts
 * (receipt.json schema v1). Mirrors the Python models in receipt.py.
 *
 * The validator below is the trust boundary: receipts are UNTRUSTED local
 * data (any process could have written them). Everything the browser sees
 * passes through validateReceiptEnvelope(), which checks structure, enums,
 * and — critically — recomputes the self-hash over the canonical payload.
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
  stdout_sha256: string;
  stderr_sha256: string;
}

export interface Receipt {
  automatic_retry_allowed: boolean;
  base_commit: string;
  candidate_may_have_partial_changes: boolean;
  candidate_stability: "known" | "unknown";
  candidate_path: string;
  candidate_head: string;
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
  platform: { os_name: string; sys_platform: string; python_version: string };
  plugin_version: string;
  prime_json_schema_version: 3;
  prime: {
    event_count: number;
    exit_code: number | null;
    final_text: string;
    saw_agent_end: boolean;
    saw_agent_start: boolean;
    session_id: string | null;
  };
  prime_agent_version: string | null;
  prime_events_sha256: string;
  prime_stderr_sha256: string;
  tracked_patch_sha256: string;
  repository_root: string;
  request_sha256: string;
  run_id: string;
  schema_version: number;
  started_at: string;
  status: RunStatus;
  /** Optional v0.1.1 additions; older receipts omit them. */
  prime_argv?: string[];
  proposal_tree_sha256?: string;
  source_checkout_unchanged?: boolean;
  execution_status?: "COMPLETED" | "FAILED" | "UNCERTAIN";
  candidate_status?: "UNQUIESCED";
  verification_status?: "PASSED" | "FAILED" | "NOT_RUN";
  verification_authority?: "MODEL_PROPOSED" | "OPERATOR_POLICY" | "NONE";
  integrity_status?: "RECORDED_NOT_REVALIDATED";
  authenticity_status?: "UNSIGNED";
  acceptance_status?: "PENDING" | "ACCEPTED" | "REJECTED";
  prime_command_identity?: {
    argv_sha256: string;
    executable_name: string;
    executable_sha256: string;
    script_name: string;
    script_sha256: string;
  };
}

/** One run directory = one receipt + one tracked patch. */
export interface RunSummary {
  runId: string;
  shortId: string;
  status: DisplayStatus;
  integrity: "SELF_HASH_VALID" | "HASH_MISMATCH" | "MALFORMED";
  authenticity: "UNSIGNED";
  executionStatus: "COMPLETED" | "FAILED" | "UNCERTAIN" | "LEGACY_UNSPECIFIED";
  candidateStatus: "UNQUIESCED" | "LEGACY_UNSPECIFIED";
  verificationStatus: "PASSED" | "FAILED" | "NOT_RUN" | "LEGACY_UNSPECIFIED";
  verificationAuthority: "MODEL_PROPOSED" | "OPERATOR_POLICY" | "NONE" | "LEGACY_UNSPECIFIED";
  acceptanceStatus: "PENDING" | "ACCEPTED" | "REJECTED" | "LEGACY_UNSPECIFIED";
  evidenceIntegrityStatus: "RECORDED_NOT_REVALIDATED" | "LEGACY_UNSPECIFIED";
  repositoryLabel: string; // last two path segments only — never full paths
  baseCommitShort: string;
  startedAt: string;
  durationMs: number;
  checksPassed: number;
  checksTotal: number;
  changedPathCount: number; // ALL buckets, not just modified
  eventCount: number;
  retryAllowed: boolean;
}

export type DisplayStatus = RunStatus | "INVALID_RECEIPT";

// ---------------------------------------------------------------------------
// Runtime validation (the server is the validation boundary)
// ---------------------------------------------------------------------------

const HEX64 = /^[0-9a-f]{64}$/;
export const RUN_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const RUN_STATUSES: ReadonlySet<string> = new Set([
  "VERIFIED",
  "COMPLETED_UNVERIFIED",
  "FAILED_VERIFICATION",
  "FAILED",
  "UNCERTAIN",
]);

const CHECK_STATUSES = new Set(["passed", "failed", "timed_out", "launch_error"]);

function isStr(v: unknown): v is string {
  return typeof v === "string";
}
function isSafeInt(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v);
}
function isNonNegativeSafeInt(v: unknown): v is number {
  return isSafeInt(v) && v >= 0;
}
function isBool(v: unknown): v is boolean {
  return typeof v === "boolean";
}
function hasControl(value: string): boolean {
  return [...value].some((ch) => ch.codePointAt(0)! < 32 || ch.codePointAt(0) === 127);
}
function isBasename(value: string): boolean {
  return value === "" || (
    !hasControl(value) &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !value.includes(":") &&
    value !== "." &&
    value !== ".."
  );
}
function isRepositoryRelativePath(value: string): boolean {
  if (
    value.length === 0 ||
    hasControl(value) ||
    value.startsWith("/") ||
    value.startsWith("\\") ||
    /^[A-Za-z]:/.test(value)
  ) return false;
  return value.replaceAll("\\", "/").split("/").every(
    (part) => part.length > 0 && part !== "." && part !== "..",
  );
}
function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

const RECEIPT_KEYS = new Set([
  "schema_version", "run_id", "status", "request_sha256", "plugin_version",
  "prime_agent_version", "prime_json_schema_version", "platform",
  "repository_root", "base_commit", "candidate_path", "candidate_head",
  "candidate_tree_sha256", "tracked_patch_sha256", "prime_events_sha256",
  "prime_stderr_sha256", "changed_paths", "prime", "checks", "started_at",
  "finished_at", "candidate_may_have_partial_changes", "candidate_stability",
  "automatic_retry_allowed", "limitations", "prime_argv",
  "proposal_tree_sha256", "source_checkout_unchanged",
  "execution_status", "candidate_status", "verification_status",
  "verification_authority", "integrity_status", "authenticity_status",
  "acceptance_status", "prime_command_identity",
]);
const PLATFORM_KEYS = new Set(["os_name", "sys_platform", "python_version"]);
const CHANGED_PATH_KEYS = new Set(["modified", "deleted", "renamed", "untracked"]);
const CHECK_KEYS = new Set([
  "name", "status", "exit_code", "duration_ms", "stdout_sha256", "stderr_sha256",
]);
const PRIME_KEYS = new Set([
  "exit_code", "session_id", "saw_agent_start", "saw_agent_end", "event_count",
  "final_text",
]);
const COMMAND_IDENTITY_KEYS = new Set([
  "argv_sha256", "executable_name", "executable_sha256", "script_name", "script_sha256",
]);

/** Python compares Unicode strings by code point; JavaScript's default sort
 * compares UTF-16 code units and disagrees for astral characters. */
function compareUnicodeCodePoints(a: string, b: string): number {
  const aa = Array.from(a, (ch) => ch.codePointAt(0)!);
  const bb = Array.from(b, (ch) => ch.codePointAt(0)!);
  const length = Math.min(aa.length, bb.length);
  for (let i = 0; i < length; i += 1) {
    if (aa[i] !== bb[i]) return aa[i]! - bb[i]!;
  }
  return aa.length - bb.length;
}

/** Deterministic JSON encoding matching Python's canonical_payload_bytes for
 * the receipt schema: sorted Unicode-code-point keys, compact separators,
 * UTF-8, booleans/null/strings, and safe integers only. */
export function canonicalJsonBytes(value: unknown): Uint8Array {
  const canon = (v: unknown, depth: number): unknown => {
    if (depth > 64) throw new RangeError("canonical JSON nesting exceeds 64 levels");
    if (v === null || typeof v === "string" || typeof v === "boolean") return v;
    if (typeof v === "number") {
      if (!Number.isSafeInteger(v))
        throw new TypeError("canonical receipt JSON accepts safe integers only");
      return v;
    }
    if (Array.isArray(v)) return v.map((item) => canon(item, depth + 1));
    if (typeof v !== "object") throw new TypeError("unsupported canonical JSON value");
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort(compareUnicodeCodePoints)) {
      out[k] = canon((v as Record<string, unknown>)[k], depth + 1);
    }
    return out;
  };
  return new TextEncoder().encode(JSON.stringify(canon(value, 0)));
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data as BufferSource);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export interface ValidationResult {
  ok: boolean;
  reason?: string;
  receipt?: Receipt;
}

/** Structural validation of a receipt payload object (not its envelope). */
export function validateReceiptObject(raw: unknown): ValidationResult {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "receipt is not an object" };
  }
  const r = raw as Record<string, unknown>;
  if (!hasOnlyKeys(r, RECEIPT_KEYS))
    return { ok: false, reason: "receipt contains unknown fields" };

  for (const key of [
    "run_id",
    "base_commit",
    "candidate_path",
    "candidate_head",
    "repository_root",
    "plugin_version",
    "started_at",
    "finished_at",
  ]) {
    if (!isStr(r[key]) || (r[key] as string).length === 0)
      return { ok: false, reason: `missing string field: ${key}` };
  }
  if (!RUN_ID_RE.test(r.run_id as string)) return { ok: false, reason: "run_id not an RFC UUID" };
  if (!(r.prime_agent_version === null || isStr(r.prime_agent_version)))
    return { ok: false, reason: "prime_agent_version missing/malformed" };
  if (!isStr(r.request_sha256) || !HEX64.test(r.request_sha256))
    return { ok: false, reason: "request_sha256 missing/malformed" };
  for (const key of [
    "candidate_tree_sha256",
    "tracked_patch_sha256",
    "prime_events_sha256",
    "prime_stderr_sha256",
  ]) {
    // Empty digests are legal on degraded evidence paths; malformed ones are not.
    const v = r[key];
    if (!isStr(v) || (v !== "" && !HEX64.test(v)))
      return { ok: false, reason: `${key} malformed` };
  }
  if (!isSafeInt(r.schema_version) || r.schema_version !== 1)
    return { ok: false, reason: `unsupported schema_version: ${String(r.schema_version)}` };
  if (!isSafeInt(r.prime_json_schema_version) || r.prime_json_schema_version !== 3)
    return {
      ok: false,
      reason: `unsupported prime_json_schema_version: ${String(r.prime_json_schema_version)}`,
    };
  if (!isBool(r.candidate_may_have_partial_changes))
    return { ok: false, reason: "candidate_may_have_partial_changes not boolean" };

  if (!isStr(r.status) || !RUN_STATUSES.has(r.status))
    return { ok: false, reason: "status enum invalid" };
  if (r.candidate_stability !== "known" && r.candidate_stability !== "unknown")
    return { ok: false, reason: "candidate_stability enum invalid" };

  const platform = r.platform;
  if (
    platform === null ||
    typeof platform !== "object" ||
    Array.isArray(platform) ||
    !hasOnlyKeys(platform as Record<string, unknown>, PLATFORM_KEYS)
  )
    return { ok: false, reason: "platform block missing/malformed" };
  for (const key of ["os_name", "sys_platform", "python_version"]) {
    if (!isStr((platform as Record<string, unknown>)[key]))
      return { ok: false, reason: `platform.${key} missing/malformed` };
  }

  // changed_paths shape
  const cp = r.changed_paths;
  if (
    cp === null ||
    typeof cp !== "object" ||
    Array.isArray(cp) ||
    !hasOnlyKeys(cp as Record<string, unknown>, CHANGED_PATH_KEYS) ||
    !["modified", "deleted", "renamed", "untracked"].every(
      (k) => Array.isArray((cp as Record<string, unknown>)[k]) &&
        ((cp as Record<string, unknown>)[k] as unknown[]).every(
          (path) => isStr(path) && isRepositoryRelativePath(path),
        ),
    )
  ) {
    return { ok: false, reason: "changed_paths malformed" };
  }

  // checks shape
  if (!Array.isArray(r.checks)) return { ok: false, reason: "checks not an array" };
  for (const c of r.checks as unknown[]) {
    const ck = c as Record<string, unknown>;
    if (
      ck === null ||
      typeof ck !== "object" ||
      Array.isArray(ck) ||
      !hasOnlyKeys(ck, CHECK_KEYS) ||
      !isStr(ck.name) ||
      !isStr(ck.status) ||
      !CHECK_STATUSES.has(ck.status) ||
      !(ck.exit_code === null || isSafeInt(ck.exit_code)) ||
      !isNonNegativeSafeInt(ck.duration_ms) ||
      !isStr(ck.stdout_sha256) ||
      !HEX64.test(ck.stdout_sha256) ||
      !isStr(ck.stderr_sha256) ||
      !HEX64.test(ck.stderr_sha256)
    ) {
      return { ok: false, reason: "check record malformed" };
    }
  }

  // prime block shape
  const p = r.prime;
  if (p === null || typeof p !== "object" || Array.isArray(p))
    return { ok: false, reason: "prime block missing" };
  const pr = p as Record<string, unknown>;
  if (!hasOnlyKeys(pr, PRIME_KEYS))
    return { ok: false, reason: "prime block contains unknown fields" };
  if (
    !isBool(pr.saw_agent_start) ||
    !isBool(pr.saw_agent_end) ||
    !isNonNegativeSafeInt(pr.event_count) ||
    !isStr(pr.final_text) ||
    !(pr.exit_code === null || isSafeInt(pr.exit_code)) ||
    !(pr.session_id === null || isStr(pr.session_id))
  ) {
    return { ok: false, reason: "prime block malformed" };
  }

  // Timestamps parse and order correctly.
  const startMs = Date.parse(r.started_at as string);
  const endMs = Date.parse(r.finished_at as string);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs))
    return { ok: false, reason: "timestamps unparseable" };
  if (endMs < startMs) return { ok: false, reason: "finished_at precedes started_at" };

  if (!isBool(r.automatic_retry_allowed))
    return { ok: false, reason: "automatic_retry_allowed not boolean" };
  if (!Array.isArray(r.limitations) || !(r.limitations as unknown[]).every(isStr))
    return { ok: false, reason: "limitations malformed" };

  if (
    r.prime_argv !== undefined &&
    (!Array.isArray(r.prime_argv) || !(r.prime_argv as unknown[]).every(isStr))
  ) {
    return { ok: false, reason: "prime_argv malformed" };
  }
  if (
    r.proposal_tree_sha256 !== undefined &&
    (!isStr(r.proposal_tree_sha256) || !HEX64.test(r.proposal_tree_sha256))
  ) {
    return { ok: false, reason: "proposal_tree_sha256 malformed" };
  }
  if (r.source_checkout_unchanged !== undefined && !isBool(r.source_checkout_unchanged))
    return { ok: false, reason: "source_checkout_unchanged not boolean" };

  const optionalEnums: ReadonlyArray<readonly [string, ReadonlySet<string>]> = [
    ["execution_status", new Set(["COMPLETED", "FAILED", "UNCERTAIN"])],
    ["candidate_status", new Set(["UNQUIESCED"])],
    ["verification_status", new Set(["PASSED", "FAILED", "NOT_RUN"])],
    ["verification_authority", new Set(["MODEL_PROPOSED", "OPERATOR_POLICY", "NONE"])],
    ["integrity_status", new Set(["RECORDED_NOT_REVALIDATED"])],
    ["authenticity_status", new Set(["UNSIGNED"])],
    ["acceptance_status", new Set(["PENDING", "ACCEPTED", "REJECTED"])],
  ];
  for (const [field, allowed] of optionalEnums) {
    const value = r[field];
    if (value !== undefined && (!isStr(value) || !allowed.has(value)))
      return { ok: false, reason: `${field} enum invalid` };
  }

  if (r.prime_command_identity !== undefined) {
    const identity = r.prime_command_identity;
    if (
      identity === null ||
      typeof identity !== "object" ||
      Array.isArray(identity) ||
      !hasOnlyKeys(identity as Record<string, unknown>, COMMAND_IDENTITY_KEYS)
    ) return { ok: false, reason: "prime_command_identity malformed" };
    const command = identity as Record<string, unknown>;
    if (
      !isStr(command.argv_sha256) || !HEX64.test(command.argv_sha256) ||
      !isStr(command.executable_name) ||
      !isBasename(command.executable_name) ||
      !isStr(command.executable_sha256) ||
      (command.executable_sha256 !== "" && !HEX64.test(command.executable_sha256)) ||
      !isStr(command.script_name) ||
      !isBasename(command.script_name) ||
      !isStr(command.script_sha256) ||
      (command.script_sha256 !== "" && !HEX64.test(command.script_sha256))
    ) return { ok: false, reason: "prime_command_identity malformed" };
  }

  return { ok: true, receipt: r as unknown as Receipt };
}

export interface EnvelopeCheck {
  result: ValidationResult;
  hashValid: boolean | null; // null when envelope/hash fields absent
  runIdMatchesDir: boolean | null; // null when caller did not supply dir id
}

/** Full-envelope validation: structure + self-hash recompute + id binding. */
export async function validateReceiptEnvelope(
  parsedEnvelope: unknown,
  dirRunId?: string,
): Promise<EnvelopeCheck> {
  const env = parsedEnvelope as Record<string, unknown>;
  if (env === null || typeof env !== "object" || Array.isArray(env)) {
    return { result: { ok: false, reason: "envelope is not an object" }, hashValid: null, runIdMatchesDir: null };
  }
  const declaredHash = env.receipt_sha256;
  if (!isStr(declaredHash) || !HEX64.test(declaredHash)) {
    return { result: { ok: false, reason: "receipt_sha256 absent or malformed" }, hashValid: null, runIdMatchesDir: null };
  }
  const structural = validateReceiptObject(env.receipt);
  if (!structural.ok) {
    return { result: structural, hashValid: null, runIdMatchesDir: null };
  }
  const recomputed = await sha256Hex(canonicalJsonBytes(env.receipt));
  const hashValid = recomputed === declaredHash;
  let runIdMatchesDir: boolean | null = null;
  if (dirRunId !== undefined) {
    runIdMatchesDir = (env.receipt as Receipt).run_id === dirRunId;
  }
  if (!hashValid) {
    return {
      result: { ok: false, reason: "self-hash mismatch (receipt was modified after write)" },
      hashValid,
      runIdMatchesDir,
    };
  }
  if (runIdMatchesDir === false) {
    return { result: { ok: false, reason: "receipt run_id does not match its directory" }, hashValid, runIdMatchesDir };
  }
  return { result: structural, hashValid, runIdMatchesDir };
}
