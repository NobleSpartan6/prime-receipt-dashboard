import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, it } from "node:test";

import { readUtf8Bounded } from "../dist/bounded-io.js";

const roots = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it("reads through one handle and refuses more than maxBytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "prime-dashboard-bounded-"));
  roots.push(root);
  const path = join(root, "input.txt");
  await writeFile(path, "😀".repeat(100), "utf8");
  await assert.rejects(readUtf8Bounded(path, 100), /exceeds 100 bytes/);
  assert.equal(await readUtf8Bounded(path, 400), "😀".repeat(100));
});