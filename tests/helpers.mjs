import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJsonBytes, sha256Hex } from "../dist/types.js";

export const VALID_RUN_ID = "11111111-2222-4333-8444-555555555555";
export const OTHER_RUN_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
export const HEX64 = "a".repeat(64);

export function receipt(overrides = {}) {
  const base = {
    schema_version: 1,
    run_id: VALID_RUN_ID,
    status: "VERIFIED",
    execution_status: "COMPLETED",
    candidate_status: "UNQUIESCED",
    verification_status: "PASSED",
    verification_authority: "MODEL_PROPOSED",
    integrity_status: "RECORDED_NOT_REVALIDATED",
    authenticity_status: "UNSIGNED",
    acceptance_status: "PENDING",
    request_sha256: HEX64,
    plugin_version: "0.1.1",
    prime_agent_version: "0.8.0",
    prime_json_schema_version: 3,
    platform: {
      os_name: "win32",
      sys_platform: "Windows",
      python_version: "3.11.15",
    },
    repository_root: "C:/Users/private/work/<img id=pwn src=x onerror=window.pwned=1>",
    base_commit: "b".repeat(40),
    candidate_path: "C:/Users/private/plugin-data/runs/candidate",
    candidate_head: "b".repeat(40),
    candidate_tree_sha256: HEX64,
    tracked_patch_sha256: HEX64,
    prime_events_sha256: HEX64,
    prime_stderr_sha256: HEX64,
    prime_command_identity: {
      argv_sha256: HEX64,
      executable_name: "python.exe",
      executable_sha256: HEX64,
      script_name: "fake_prime.py",
      script_sha256: HEX64,
    },
    changed_paths: {
      modified: ["src/app.py"],
      deleted: ["old.py"],
      renamed: [],
      untracked: ["new.py"],
    },
    prime: {
      exit_code: 0,
      session_id: "session-1",
      saw_agent_start: true,
      saw_agent_end: true,
      event_count: 42,
      final_text: "<script>window.pwned=1</script>C:/Users/private/secret",
    },
    checks: [
      {
        name: "tests",
        status: "passed",
        exit_code: 0,
        duration_ms: 12,
        stdout_sha256: HEX64,
        stderr_sha256: HEX64,
      },
    ],
    started_at: "2026-08-25T12:00:00.000Z",
    finished_at: "2026-08-25T12:00:01.000Z",
    candidate_may_have_partial_changes: false,
    candidate_stability: "known",
    automatic_retry_allowed: false,
    limitations: [
      "not_a_security_sandbox",
      "verification_is_limited_to_recorded_checks",
      "candidate_not_applied",
      "no_automatic_retry",
    ],
  };
  return deepMerge(base, overrides);
}

function deepMerge(base, overrides) {
  const out = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof base[key] === "object" &&
      base[key] !== null &&
      !Array.isArray(base[key])
    ) {
      out[key] = deepMerge(base[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export async function writeRun(root, opts = {}) {
  const dirId = opts.dirId ?? VALID_RUN_ID;
  const payload = receipt(opts.receiptOverrides ?? {});
  const runDir = join(root, dirId);
  await mkdir(runDir, { recursive: true });
  const digest = await sha256Hex(canonicalJsonBytes(payload));
  const envelope = {
    receipt: payload,
    receipt_sha256: opts.declaredHash ?? digest,
  };
  const body = opts.rawReceipt ?? JSON.stringify(envelope);
  await writeFile(join(runDir, "receipt.json"), body, "utf8");
  if (opts.finalized !== false) {
    await writeFile(join(runDir, "status.txt"), `${payload.status}\n`, "utf8");
  }
  return { runDir, payload, envelope };
}
