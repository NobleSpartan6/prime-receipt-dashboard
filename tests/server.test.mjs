import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { afterEach, before, describe, it } from "node:test";

import {
  OTHER_RUN_ID,
  VALID_RUN_ID,
  writeRun,
} from "./helpers.mjs";
import {
  canonicalJsonBytes,
  sha256Hex,
  validateReceiptEnvelope,
  validateReceiptObject,
} from "../dist/types.js";

const roots = [];
const servers = [];

before(async () => {
  // The tests exercise the emitted artifact, not tsx/source execution.
  const { access } = await import("node:fs/promises");
  await access(resolve("dist/server.js"));
  await access(resolve("public/app.js"));
});

afterEach(async () => {
  for (const child of servers.splice(0)) child.kill();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function tempRuns() {
  const root = await mkdtemp(join(tmpdir(), "prime-dashboard-test-"));
  roots.push(root);
  return root;
}

async function freePort() {
  return await new Promise((resolvePort, reject) => {
    const socket = createNetServer();
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", () => {
      const address = socket.address();
      if (!address || typeof address === "string") {
        reject(new Error("could not allocate test port"));
        return;
      }
      const port = address.port;
      socket.close(() => resolvePort(port));
    });
  });
}

async function startServer(runsDir, options = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, [resolve("dist/server.js")], {
    cwd: options.cwd ?? resolve("."),
    env: { ...process.env, PORT: String(port), PRIME_RLM_RUNS: runsDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  servers.push(child);
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i += 1) {
    if (child.exitCode !== null) throw new Error(`server exited early: ${stderr}`);
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) return { base, child };
    } catch {
      // Retry while the process binds the port.
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`server did not become ready: ${stderr}`);
}

describe("receipt validation boundary", () => {
  it("accepts a structurally valid, self-hashed receipt bound to its directory", async () => {
    const root = await tempRuns();
    const { envelope } = await writeRun(root);
    const check = await validateReceiptEnvelope(envelope, VALID_RUN_ID);
    assert.equal(check.result.ok, true);
    assert.equal(check.hashValid, true);
    assert.equal(check.runIdMatchesDir, true);
  });

  it("rejects a modified receipt even when the JSON remains valid", async () => {
    const root = await tempRuns();
    const { envelope } = await writeRun(root);
    envelope.receipt.prime.final_text = "tampered after finalization";
    const check = await validateReceiptEnvelope(envelope, VALID_RUN_ID);
    assert.equal(check.result.ok, false);
    assert.equal(check.hashValid, false);
  });

  it("rejects missing required status and dishonest stability enums", async () => {
    const root = await tempRuns();
    const { payload } = await writeRun(root);
    delete payload.status;
    assert.equal(validateReceiptObject(payload).ok, false);
    payload.status = "VERIFIED";
    payload.candidate_stability = "verified";
    assert.equal(validateReceiptObject(payload).ok, false);
  });

  it("rejects receipts missing required schema-v1 identity fields", async () => {
    const root = await tempRuns();
    const { payload } = await writeRun(root);
    for (const field of [
      "candidate_head",
      "tracked_patch_sha256",
      "plugin_version",
      "prime_json_schema_version",
      "candidate_may_have_partial_changes",
    ]) {
      const copy = structuredClone(payload);
      delete copy[field];
      assert.equal(validateReceiptObject(copy).ok, false, `${field} must be required`);
    }
  });

  it("accepts and validates explicit v0.1.1 trust-axis and command identity fields", async () => {
    const root = await tempRuns();
    const { payload } = await writeRun(root);
    Object.assign(payload, {
      execution_status: "COMPLETED",
      candidate_status: "UNQUIESCED",
      verification_status: "PASSED",
      verification_authority: "MODEL_PROPOSED",
      integrity_status: "RECORDED_NOT_REVALIDATED",
      authenticity_status: "UNSIGNED",
      acceptance_status: "PENDING",
      prime_command_identity: {
        argv_sha256: "b".repeat(64),
        executable_name: "python.exe",
        executable_sha256: "c".repeat(64),
        script_name: "fake_prime.py",
        script_sha256: "d".repeat(64),
      },
    });
    assert.equal(validateReceiptObject(payload).ok, true);

    const badAuthority = structuredClone(payload);
    badAuthority.verification_authority = "TRUST_ME";
    assert.equal(validateReceiptObject(badAuthority).ok, false);

    const badIdentity = structuredClone(payload);
    badIdentity.prime_command_identity.argv_sha256 = "not-a-hash";
    assert.equal(validateReceiptObject(badIdentity).ok, false);
  });

  it("rejects malformed nested platform, check digest, and optional v0.1.1 fields", async () => {
    const root = await tempRuns();
    const { payload } = await writeRun(root);

    const badPlatform = structuredClone(payload);
    delete badPlatform.platform.python_version;
    assert.equal(validateReceiptObject(badPlatform).ok, false);

    const badCheck = structuredClone(payload);
    delete badCheck.checks[0].stdout_sha256;
    assert.equal(validateReceiptObject(badCheck).ok, false);

    const badArgv = structuredClone(payload);
    badArgv.prime_argv = ["prime-agent", 42];
    assert.equal(validateReceiptObject(badArgv).ok, false);

    const badProposalDigest = structuredClone(payload);
    badProposalDigest.proposal_tree_sha256 = "not-a-digest";
    assert.equal(validateReceiptObject(badProposalDigest).ok, false);
  });

  it("rejects missing version identity, unsafe counts, and unknown deep fields", async () => {
    const root = await tempRuns();
    const { payload } = await writeRun(root);

    const missingVersion = structuredClone(payload);
    delete missingVersion.prime_agent_version;
    assert.equal(validateReceiptObject(missingVersion).ok, false);

    for (const badCount of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const badEventCount = structuredClone(payload);
      badEventCount.prime.event_count = badCount;
      assert.equal(validateReceiptObject(badEventCount).ok, false);
    }

    const unknown = structuredClone(payload);
    let cursor = unknown;
    for (let i = 0; i < 10_000; i += 1) cursor = cursor.unknown = {};
    assert.equal(validateReceiptObject(unknown).ok, false);
  });

  it("rejects non-RFC run ids and path-bearing receipt fields", async () => {
    const root = await tempRuns();
    const { payload } = await writeRun(root);

    const badId = structuredClone(payload);
    badId.run_id = "11111111-2222-0333-7444-555555555555";
    assert.equal(validateReceiptObject(badId).ok, false);

    for (const path of [
      "C:/Users/private/secret.py",
      "C:private/secret.py",
      "/etc/passwd",
      "../escape.py",
    ]) {
      const badPath = structuredClone(payload);
      badPath.changed_paths.modified = [path];
      assert.equal(validateReceiptObject(badPath).ok, false, path);
    }

    const badCommandName = structuredClone(payload);
    badCommandName.prime_command_identity.script_name = "C:/Users/private/fake_prime.py";
    assert.equal(validateReceiptObject(badCommandName).ok, false);
    badCommandName.prime_command_identity.script_name = "C:fake_prime.py";
    assert.equal(validateReceiptObject(badCommandName).ok, false);
  });

  it("matches Python key ordering for BMP and astral Unicode keys", () => {
    const payload = { "𐀀": 1, "": 2 };
    assert.equal(
      Buffer.from(canonicalJsonBytes(payload)).toString("utf8"),
      '{"":2,"𐀀":1}',
    );
  });

  it("matches Python canonical JSON for unicode and nested key order", async () => {
    const payload = { z: "የክፍያ", a: { y: 2, x: [true, null, "é"] } };
    assert.equal(
      Buffer.from(canonicalJsonBytes(payload)).toString("utf8"),
      '{"a":{"x":[true,null,"é"],"y":2},"z":"የክፍያ"}',
    );
    assert.equal((await sha256Hex(canonicalJsonBytes(payload))).length, 64);
  });
});

describe("built read-only server", () => {
  it("serves emitted app.js, restrictive headers, and rejects mutation methods", async () => {
    const root = await tempRuns();
    await writeRun(root);
    const { base } = await startServer(root);

    const app = await fetch(`${base}/app.js`);
    assert.equal(app.status, 200);
    assert.match(await app.text(), /textContent/);

    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'none'/);
    assert.equal(page.headers.get("x-content-type-options"), "nosniff");

    const post = await fetch(`${base}/api/runs`, { method: "POST" });
    assert.equal(post.status, 405);
  });

  it("does not serve a public-directory symlink that resolves outside public", async (t) => {
    const root = await tempRuns();
    await writeRun(root);
    const secret = join(await tempRuns(), "secret.txt");
    await writeFile(secret, "must not be served", "utf8");
    const link = resolve("public", "escape-test.txt");
    try {
      await symlink(secret, link, "file");
    } catch (err) {
      if (err && (err.code === "EPERM" || err.code === "EACCES")) {
        t.skip("symlink creation unavailable on this host");
        return;
      }
      throw err;
    }
    try {
      const { base } = await startServer(root);
      assert.equal((await fetch(`${base}/escape-test.txt`)).status, 404);
    } finally {
      await unlink(link).catch(() => undefined);
    }
  });

  it("isolates malformed and hash-mismatched receipts without failing the list", async () => {
    const root = await tempRuns();
    await writeRun(root);
    await writeRun(root, {
      dirId: OTHER_RUN_ID,
      receiptOverrides: { run_id: OTHER_RUN_ID },
      declaredHash: "f".repeat(64),
    });
    const malformedId = "12345678-1234-4567-8123-123456789012";
    const malformedDir = join(root, malformedId);
    await mkdir(malformedDir, { recursive: true });
    await writeFile(join(malformedDir, "receipt.json"), "{not json", "utf8");
    await writeFile(join(malformedDir, "status.txt"), "FAILED\n", "utf8");

    const { base } = await startServer(root);
    const response = await fetch(`${base}/api/runs`);
    assert.equal(response.status, 200);
    const runs = await response.json();
    assert.equal(runs.length, 3);
    assert.equal(runs.filter((r) => r.integrity === "SELF_HASH_VALID").length, 1);
    assert.equal(runs.filter((r) => r.integrity === "HASH_MISMATCH").length, 1);
    assert.equal(runs.filter((r) => r.integrity === "MALFORMED").length, 1);
    assert.equal(runs.filter((r) => r.authenticity === "UNSIGNED").length, 3);
  });

  it("serves only atomically finalized runs", async () => {
    const root = await tempRuns();
    await writeRun(root, { finalized: false });
    const { base } = await startServer(root);
    const runs = await (await fetch(`${base}/api/runs`)).json();
    assert.deepEqual(runs, []);
  });

  it("does not follow a run-directory symlink outside the configured runs root", async () => {
    const root = await tempRuns();
    const outside = await tempRuns();
    await writeRun(outside);
    await symlink(
      join(outside, VALID_RUN_ID),
      join(root, VALID_RUN_ID),
      process.platform === "win32" ? "junction" : "dir",
    );
    const { base } = await startServer(root);
    const runs = await (await fetch(`${base}/api/runs`)).json();
    assert.deepEqual(runs, []);
  });

  it("rejects a completion marker that disagrees with receipt status", async () => {
    const root = await tempRuns();
    const { runDir } = await writeRun(root);
    await writeFile(join(runDir, "status.txt"), "FAILED\n", "utf8");
    const { base } = await startServer(root);
    const runs = await (await fetch(`${base}/api/runs`)).json();
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, "INVALID_RECEIPT");
    assert.equal(runs[0].integrity, "MALFORMED");
  });

  it("serves the built UI when started outside the repository directory", async () => {
    const root = await tempRuns();
    await writeRun(root);
    const foreignCwd = await tempRuns();
    const { base } = await startServer(root, { cwd: foreignCwd });
    assert.equal((await fetch(`${base}/`)).status, 200);
    assert.equal((await fetch(`${base}/app.js`)).status, 200);
  });

  it("projects explicit trust axes into the run summary", async () => {
    const root = await tempRuns();
    await writeRun(root, {
      receiptOverrides: {
        execution_status: "COMPLETED",
        candidate_status: "UNQUIESCED",
        verification_status: "PASSED",
        verification_authority: "MODEL_PROPOSED",
        acceptance_status: "PENDING",
      },
    });
    const { base } = await startServer(root);
    const [run] = await (await fetch(`${base}/api/runs`)).json();
    assert.equal(run.executionStatus, "COMPLETED");
    assert.equal(run.candidateStatus, "UNQUIESCED");
    assert.equal(run.verificationStatus, "PASSED");
    assert.equal(run.verificationAuthority, "MODEL_PROPOSED");
    assert.equal(run.acceptanceStatus, "PENDING");
    assert.equal(run.evidenceIntegrityStatus, "RECORDED_NOT_REVALIDATED");
  });

  it("rejects receipts over the byte limit before serving them", async () => {
    const root = await tempRuns();
    await writeRun(root, {
      receiptOverrides: { prime: { final_text: "😀".repeat(1_100_000) } },
    });
    const { base } = await startServer(root);
    assert.deepEqual(await (await fetch(`${base}/api/runs`)).json(), []);
  });

  it("rejects an oversized completion marker instead of allocating or listing it", async () => {
    const root = await tempRuns();
    const { runDir } = await writeRun(root);
    await writeFile(join(runDir, "status.txt"), "V".repeat(1024 * 1024), "utf8");
    const { base } = await startServer(root);
    assert.deepEqual(await (await fetch(`${base}/api/runs`)).json(), []);
  });

  it("returns path-minimized summaries and a redacted receipt detail DTO", async () => {
    const root = await tempRuns();
    await writeRun(root);
    const { base } = await startServer(root);

    const listText = await (await fetch(`${base}/api/runs`)).text();
    assert.equal(listText.includes("C:/Users/private"), false);
    const runs = JSON.parse(listText);
    assert.equal(runs[0].changedPathCount, 3);
    assert.equal(runs[0].checksPassed, 1);
    assert.equal(runs[0].integrity, "SELF_HASH_VALID");
    assert.equal(runs[0].authenticity, "UNSIGNED");

    const detailText = await (
      await fetch(`${base}/api/receipt/${VALID_RUN_ID}`)
    ).text();
    assert.equal(detailText.includes("C:/Users/private"), false);
    assert.equal(detailText.includes("window.pwned"), false);
    const detail = JSON.parse(detailText);
    assert.equal(detail.paths_redacted, true);
    assert.equal("repository_root" in detail.receipt, false);
    assert.equal("candidate_path" in detail.receipt, false);
    assert.equal("final_text" in detail.receipt.prime, false);
  });
});
