#!/usr/bin/env node
/**
 * Copy runtime assets into dist/ after `tsc`. TypeScript compiles code only;
 * the bundled sample Markdown is read from disk at runtime next to the
 * compiled module (src/core/samples.ts → dist/core/samples/), so the build
 * must place it there for the production server to serve the demo workflow.
 *
 * Dependency-free, runs with plain node (it is part of the build, which must
 * not require dev tooling beyond tsc itself).
 */
import { mkdirSync, readdirSync, copyFileSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const srcSamples = join(repoRoot, "src", "core", "samples");
const distSamples = join(repoRoot, "dist", "core", "samples");

mkdirSync(distSamples, { recursive: true });
for (const entry of readdirSync(srcSamples)) {
  if (statSync(join(srcSamples, entry)).isFile()) {
    copyFileSync(join(srcSamples, entry), join(distSamples, entry));
  }
}
console.log(`copied sample assets → ${distSamples}`);
