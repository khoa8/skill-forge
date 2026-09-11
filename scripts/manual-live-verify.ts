/**
 * Manual live verification for GitHub codebase mode (NOT part of CI —
 * requires network + public GitHub API availability). Run:
 *   npx tsx scripts/manual-live-verify.ts <repo-url> [<repo-url> ...]
 * Prints the reconnaissance/analysis summary for each repository. Temporary
 * helper for feature verification; safe to delete afterwards.
 */
import { fetchGithubCodebaseSource } from "../src/core/sources/github-codebase.js";
import { runPipeline } from "../src/core/pipeline.js";

async function codebase(url: string): Promise<void> {
  const t0 = Date.now();
  const r = await fetchGithubCodebaseSource(url);
  const a = r.analysis;
  console.log(`\n=== ${url} (${Date.now() - t0} ms) ===`);
  console.log(`ref=${a.repository.ref} blobs=${a.selection.treeBlobCount} candidates=${a.selection.candidateCount} selected=${a.selection.selectedCount}`);
  console.log(`languages: ${a.languages.slice(0, 3).map((l) => `${l.name} (${l.evidence[0]})`).join(", ")}`);
  console.log(`ecosystems: ${a.ecosystems.join(", ")}`);
  console.log(`commands: ${a.commands.slice(0, 6).map((c) => `[${c.purpose}] ${c.command}`).join(" | ")}`);
  console.log(`entrypoints: ${a.entrypoints.slice(0, 4).map((e) => e.path).join(", ")}`);
  console.log(`conventions: ${a.conventions.length}${a.conventions[0] ? ` (e.g. "${a.conventions[0]!.statement.slice(0, 70)}" @ ${a.conventions[0]!.evidence[0]})` : ""}`);
  console.log(`testing: ${a.testing.frameworks.join(", ")} — ${a.testing.relevantFiles.slice(0, 2).join(", ")}`);
  console.log(`uncertainty: ${a.uncertainty.slice(0, 2).join(" | ")}`);
  console.log(`inspected (first 8): ${a.inspectedFiles.slice(0, 8).join(", ")}`);

  // Full offline pipeline over the fetched codebase source (mock provider).
  for await (const ev of runPipeline(r.input, { provider: "mock" })) {
    if (ev.type === "error") throw new Error(`${ev.message} [${ev.code}] @${ev.stage}`);
    if (ev.type === "result") {
      const skillMd = ev.skill.files.find((f) => f.path === "SKILL.md");
      console.log(`\npipeline: ${ev.skill.files.length} files, validation ${ev.validation.passed ? "PASSED" : "FAILED"} (${ev.validation.errorCount} errors / ${ev.validation.warningCount} warnings)`);
      console.log(`skill name: ${ev.skill.meta.name}`);
      console.log(`SKILL.md excerpt:\n${(skillMd?.content ?? "").split("\n").slice(0, 26).join("\n")}`);
      const failures = ev.validation.checks.filter((c) => c.status === "fail");
      for (const f of failures) console.error(`  ✗ [${f.id}] ${f.message}`);
    }
  }
}

const urls = process.argv.slice(2);
if (urls.length === 0) {
  console.error("usage: npx tsx scripts/manual-live-verify.ts <github-repo-url> ...");
  process.exit(2);
}
for (const url of urls) {
  try {
    await codebase(url);
  } catch (err) {
    console.error(`FAILED for ${url}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
