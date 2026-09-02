/* Quick smoke test of the core pipeline (dev only). */
import { runPipeline } from "../src/core/pipeline.js";
import { getSample } from "../src/core/samples.js";
import { exportPackage, buildZip } from "../src/core/export/exporters.js";
import { writeFileSync } from "node:fs";

const sample = getSample("meridian-payments-api");
const input = { type: "sample" as const, name: sample.meta.title, content: sample.content };

for await (const ev of runPipeline(input, { provider: "mock" })) {
  if (ev.type === "stage") {
    console.log(`[stage] ${ev.stage} ${ev.status} ${ev.ms ?? ""} ${ev.detail ?? ""}`);
  } else if (ev.type === "error") {
    console.log(`[error] ${ev.stage}: ${ev.code}: ${ev.message}`);
    process.exit(1);
  } else if (ev.type === "result" && ev.skill && ev.validation) {
    console.log(`\n== result: ${ev.skill.id}, ${ev.skill.files.length} files`);
    console.log(`   gaps: ${JSON.stringify(ev.skill.meta.gaps)}`);
    console.log(`   validation passed=${ev.validation.passed} errors=${ev.validation.errorCount} warnings=${ev.validation.warningCount}`);
    for (const c of ev.validation.checks) {
      if (c.status !== "pass") console.log(`   - ${c.status} [${c.id}] ${c.filePath ?? ""}: ${c.message}`);
    }
    for (const f of ev.skill.files) console.log(`   file: ${f.path} (${f.content.length} chars)`);
    console.log("\n--- SKILL.md ---");
    console.log(ev.skill.files[0]!.content);

    for (const target of ["claude-code", "generic"] as const) {
      const exported = exportPackage(ev.skill, target);
      const zip = await buildZip(exported);
      writeFileSync(`/tmp/skillforge-${target}.zip`, zip.buffer);
      console.log(`\nzip ${target}: ${zip.fileName} ${zip.buffer.length} bytes, ${zip.entries.length} entries`);
      console.log(zip.entries.join("\n"));
    }
  }
}
