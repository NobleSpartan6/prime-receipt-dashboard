#!/usr/bin/env node
/**
 * Post-build: move the browser artifact into public/, verify every required
 * build output exists, and fail the build loudly if not — a missing app.js
 * is exactly the bug this repo had at v0.1.0.
 */
import { access, mkdir, rename, rm } from "node:fs/promises";

const required = [
  "dist/server.js",
  "dist/types.js",
  "dist/bounded-io.js",
  "public/app.js",
  "public/index.html",
];

// Browser build lands in .build-browser/ (outDir can't be public/ itself:
// tsc excludes its own outDir from inputs). Move app.js up, drop the dir.
await rm("public/app.js", { force: true });
try {
  await rename(".build-browser/app.js", "public/app.js");
} catch (err) {
  console.error("✗ browser build did not emit .build-browser/app.js:", err);
  process.exit(1);
}
await rm(".build-browser", { recursive: true, force: true });

for (const file of required) {
  try {
    await access(file);
    console.log(`✓ ${file}`);
  } catch {
    console.error(`✗ MISSING build artifact: ${file}`);
    process.exit(1);
  }
}
console.log("build artifacts OK");
