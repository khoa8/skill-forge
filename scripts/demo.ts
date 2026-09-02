/**
 * SkillForge demo CLI — proves the full no-key workflow without the UI:
 * Source → Analyze → Generate → Validate → Export, then inspects the
 * exported ZIPs by reading them back.
 *
 * Usage:
 *   npm run demo                     # both bundled samples, both targets
 *   npm run demo -- --sample meridian-payments-api --target claude-code
 *   npm run demo -- --file path/to/doc.md
 */
import { runPipeline } from "../src/core/pipeline.js";
import { listSamples, getSample } from "../src/core/samples.js";
import { exportPackage, buildZip, EXPORT_TARGET_INFO } from "../src/core/export/exporters.js";
import type { CanonicalSkill, ValidationReport } from "../src/core/types.js";
import JSZip from "jszip";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

function parseArgs(argv: string[]): { sample?: string; file?: string; target?: string } {
  const args: Record<string, string> = {};
  for (let i = 2; i < argv.length; i++) {
    const key = argv[i]!.replace(/^--/, "");
    args[key] = argv[i + 1] ?? "";
    i++;
  }
  return { sample: args.sample, file: args.file, target: args.target };
}

async function main() {
  const args = parseArgs(process.argv);
  const outDir = join(process.cwd(), "output");
  mkdirSync(outDir, { recursive: true });

  const targets: ("claude-code" | "generic")[] = args.target
    ? [args.target as "claude-code" | "generic"]
    : ["claude-code", "generic"];
  for (const t of targets) {
    if (!EXPORT_TARGET_INFO.some((info) => info.target === t)) {
      console.error(`Unsupported target "${t}". Supported: ${EXPORT_TARGET_INFO.map((i) => i.target).join(", ")}`);
      process.exit(1);
    }
  }

  const jobs: { name: string; content: string }[] = [];
  if (args.file) {
    jobs.push({ name: args.file.split("/").pop()!.replace(/\.[^.]+$/, ""), content: readFileSync(args.file, "utf8") });
  } else {
    const sampleIds = args.sample ? [args.sample] : listSamples().map((s) => s.id);
    for (const id of sampleIds) {
      const sample = getSample(id);
      jobs.push({ name: sample.meta.title, content: sample.content });
    }
  }

  let failures = 0;
  for (const job of jobs) {
    console.log(`\n═══ ${job.name} ═══`);
    let skill: CanonicalSkill;
    let validation: ValidationReport;
    try {
      ({ skill, validation } = await finishPipeline(job));
    } catch (err) {
      failures++;
      console.error(`✗ pipeline failed: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const status = validation.passed
      ? `passed (${validation.checks.length} checks, ${validation.warningCount} warnings)`
      : `FAILED (${validation.errorCount} errors, ${validation.warningCount} warnings)`;
    console.log(`validation: ${status}`);
    if (!validation.passed) {
      for (const c of validation.checks.filter((c) => c.status === "fail")) {
        console.error(`  ✗ [${c.id}] ${c.filePath ?? ""} ${c.message}`);
      }
      failures++;
    }
    for (const gap of skill.meta.gaps) console.log(`gap marked: ${gap}`);

    for (const target of targets) {
      try {
        const exported = exportPackage(skill, target);
        const zip = await buildZip(exported);
        const zipPath = join(outDir, zip.fileName);
        writeFileSync(zipPath, zip.buffer);
        console.log(`export: ${zipPath} (${zip.entries.length} entries, ${(zip.buffer.length / 1024).toFixed(1)} KB)`);
        await inspectZip(zipPath, zip.entries.length, skill.id);
      } catch (err) {
        failures++;
        console.error(`✗ export ${target} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  console.log(failures === 0 ? "\n✓ demo complete: generate → validate → export all verified" : `\n${failures} failure(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

async function finishPipeline(job: { name: string; content: string }): Promise<{ skill: CanonicalSkill; validation: ValidationReport }> {
  let out: { skill: CanonicalSkill; validation: ValidationReport } | null = null;
  for await (const ev of runPipeline(
    { type: "text", name: job.name, content: job.content },
    { provider: "mock" },
  )) {
    if (ev.type === "error") throw new Error(`${ev.message} [${ev.code}] @${ev.stage}`);
    if (ev.type === "result") out = { skill: ev.skill, validation: ev.validation };
  }
  if (out === null) throw new Error("pipeline produced no result");
  return out;
}

/** Read the ZIP back and verify every entry is present and non-empty. */
async function inspectZip(zipPath: string, expectedCount: number, skillId: string) {
  const zip = await JSZip.loadAsync(readFileSync(zipPath));
  const entries = Object.values(zip.files).filter((f) => !f.dir);
  if (entries.length !== expectedCount) {
    throw new Error(`ZIP inspection: expected ${expectedCount} entries, found ${entries.length}`);
  }
  const skillMdEntry = entries.find((f) => f.name === `${skillId}/SKILL.md`);
  if (!skillMdEntry) throw new Error(`ZIP inspection: ${skillId}/SKILL.md missing from the package`);
  const content = await skillMdEntry.async("string");
  if (content.length < 100) throw new Error("ZIP inspection: SKILL.md suspiciously small");
  for (const entry of entries) {
    const c = await entry.async("string");
    if (c.trim().length === 0) {
      throw new Error(`ZIP inspection: empty entry ${entry.name}`);
    }
  }
  console.log(`zip inspection: ${entries.length} entries verified non-empty, SKILL.md = ${content.length} chars`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
