/**
 * Lightweight documentation check (dependency-free).
 *
 * Verifies, across all tracked Markdown:
 *  1. relative links (and image sources) point at files that exist;
 *  2. no document references the removed transient status documents
 *     (PROJECT_STATUS.md, TASKS.md, FINAL_REPORT.md, GOAL.md, PRODUCT.md,
 *     docs/PRODUCTION_READINESS_STATUS.md) — Git history is their home now;
 *  3. image files referenced by surviving docs exist.
 *
 * Exits nonzero on any finding. Usage: npm run docs:check
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, dirname, resolve } from "node:path";

const ROOT = process.cwd();

/** Removed status documents that surviving docs must never reference. */
const FORBIDDEN = [
  "PROJECT_STATUS.md",
  "TASKS.md",
  "FINAL_REPORT.md",
  "GOAL.md",
  "PRODUCT.md",
  "docs/PRODUCTION_READINESS_STATUS.md",
];

function listMarkdown(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (full.includes("node_modules") || full.includes("dist") || full.startsWith(".git")) continue;
    if (statSync(full).isDirectory()) listMarkdown(full, out);
    else if (entry.endsWith(".md")) out.push(full);
  }
  return out;
}

const problems: string[] = [];
const markdownFiles = listMarkdown(ROOT);

for (const file of markdownFiles) {
  const rel = relative(ROOT, file);
  const text = readFileSync(file, "utf8");

  // 1. Relative markdown links + image sources must resolve.
  const linkRe = /\[[^\]]*\]\(([^)\s]+)\)/g;
  for (const match of text.matchAll(linkRe)) {
    const href = match[1]!;
    if (href.startsWith("#") || /^[a-z]+:\/\//i.test(href) || href.startsWith("mailto:")) continue;
    const target = href.split("#")[0]!;
    if (target.length === 0) continue;
    const resolved = resolve(dirname(file), target);
    if (!existsSync(resolved)) {
      problems.push(`${rel}: broken relative link "${href}"`);
    }
  }

  // 2. References to removed status documents.
  for (const forbidden of FORBIDDEN) {
    if (text.includes(forbidden)) {
      problems.push(`${rel}: references removed status document "${forbidden}" (history lives in Git)`);
    }
  }
}

// 3. Screenshots and other repo images referenced by surviving docs must exist.
for (const file of markdownFiles) {
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const src = match[1]!;
    if (/^[a-z]+:\/\//i.test(src)) continue;
    if (!existsSync(resolve(dirname(file), src))) {
      problems.push(`${relative(ROOT, file)}: missing image "${src}"`);
    }
  }
}

if (problems.length > 0) {
  console.error(`docs:check found ${problems.length} problem(s):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(`docs:check OK (${markdownFiles.length} markdown files, links + removed-doc references verified)`);
