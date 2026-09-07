/**
 * Lightweight documentation check (dependency-free).
 *
 * Verifies all *Git-tracked* Markdown (enumerated via `git ls-files`, so
 * untracked scratch files never affect results and no filesystem walk happens):
 *  1. relative links and image sources point at files that exist;
 *  2. no document references the removed transient status documents
 *     (PROJECT_STATUS.md, TASKS.md, FINAL_REPORT.md, GOAL.md, PRODUCT.md,
 *     docs/PRODUCTION_READINESS_STATUS.md) — Git history is their home now.
 *
 * Exits nonzero on any finding. Usage: npm run docs:check
 */
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve, sep } from "node:path";

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

/** Git is the inventory: tracked Markdown only, NUL-separated for safe names. */
function trackedMarkdownFiles(): string[] {
  try {
    const out = execFileSync("git", ["ls-files", "-z", "--", "*.md"], {
      cwd: ROOT,
      encoding: "buffer",
      maxBuffer: 16 * 1024 * 1024,
    }) as Buffer;
    return out
      .toString("utf8")
      .split("\0")
      .filter((p) => p.length > 0 && p.endsWith(".md"));
  } catch (err) {
    console.error(
      `docs:check could not enumerate tracked Markdown via git ls-files: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(2);
  }
}

/** True when a link target needs no filesystem check. */
function isExternalOrAnchor(target: string): boolean {
  return (
    target.length === 0 ||
    target.startsWith("#") ||
    /^[a-z]+:\/\//i.test(target) ||
    target.startsWith("mailto:")
  );
}

const problems: string[] = [];
const markdownFiles = trackedMarkdownFiles();

for (const rel of markdownFiles) {
  const file = resolve(ROOT, rel);
  const text = readFileSync(file, "utf8");

  // Links and image sources share one syntax and one resolution rule; both
  // are checked here (images are not double-reported by a separate pass).
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const href = match[1]!;
    if (isExternalOrAnchor(href)) continue;
    const target = href.split("#")[0]!;
    if (!existsSync(resolve(dirname(file), target))) {
      problems.push(`${rel}: broken relative link "${href}"`);
    }
  }

  for (const forbidden of FORBIDDEN) {
    if (text.includes(forbidden)) {
      problems.push(`${rel}: references removed status document "${forbidden}" (history lives in Git)`);
    }
  }
}

if (problems.length > 0) {
  console.error(`docs:check found ${problems.length} problem(s):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(
  `docs:check OK (${markdownFiles.length} tracked markdown files, links + removed-doc references verified)`,
);
