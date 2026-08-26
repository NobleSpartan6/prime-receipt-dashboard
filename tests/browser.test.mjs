import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { after, before, it } from "node:test";
import { chromium } from "playwright";

import { VALID_RUN_ID, writeRun } from "./helpers.mjs";

let root;
let child;
let browser;
let base;

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
      socket.close(() => resolvePort(address.port));
    });
  });
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), "prime-dashboard-browser-"));
  await writeRun(root);
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [resolve("dist/server.js")], {
    cwd: resolve("."),
    env: { ...process.env, PORT: String(port), PRIME_RLM_RUNS: root },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  for (let i = 0; i < 100; i += 1) {
    if (child.exitCode !== null) throw new Error(`server exited early: ${stderr}`);
    try {
      if ((await fetch(`${base}/api/health`)).ok) break;
    } catch {
      // wait for bind
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
  child?.kill();
  if (root) await rm(root, { recursive: true, force: true });
});

it("renders the emitted client, treats receipt HTML as text, and opens redacted detail", async () => {
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(String(err)));

  const response = await page.goto(base, { waitUntil: "networkidle" });
  assert.equal(response?.status(), 200);
  await page.locator("#runs tbody tr").waitFor();
  assert.equal(await page.locator("#runs tbody tr").count(), 1);
  const rowText = await page.locator("#runs tbody tr").innerText();
  assert.match(rowText, /VERIFIED/);
  assert.match(rowText, /SELF_HASH_VALID/);
  assert.match(rowText, /UNSIGNED/);
  assert.match(rowText, /PASSED/);
  assert.match(rowText, /MODEL_PROPOSED/);
  assert.match(rowText, /UNQUIESCED/);
  assert.match(rowText, /PENDING/);
  assert.match(rowText, /COMPLETED/);
  assert.match(rowText, /RECORDED_NOT_REVALIDATED/);

  // The malicious repository folder name is displayed literally, never parsed.
  assert.equal(await page.locator("#pwn").count(), 0);
  assert.equal(await page.evaluate(() => window.pwned), undefined);

  await page.locator("#runs tbody tr").click();
  await page.locator("#detail:not([hidden])").waitFor();
  assert.equal(await page.locator("#detail-id").innerText(), VALID_RUN_ID.slice(0, 8));
  const detail = await page.locator("#receipt-json").innerText();
  assert.equal(detail.includes("C:/Users/private"), false);
  assert.equal(detail.includes("window.pwned"), false);
  assert.equal(consoleErrors.length, 0, consoleErrors.join("\n"));

  await page.close();
});
