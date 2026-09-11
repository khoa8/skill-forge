/**
 * Bundled sample registry. Samples are deterministic, offline, and labeled as
 * demos — they let a first-time user complete Source → Generate → Validate →
 * Preview → Export without any API key.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { z } from "zod";

const SAMPLES_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "samples");

const SampleMeta = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  title: z.string(),
  description: z.string(),
  fileName: z.string(),
});
export type SampleMeta = z.infer<typeof SampleMeta>;

const SAMPLE_LIST: SampleMeta[] = [
  {
    id: "meridian-payments-api",
    title: "Meridian Payments API",
    description: "Documentation for a payments REST API: auth, payments, refunds, errors, rate limits, webhooks, troubleshooting.",
    fileName: "meridian-payments-api.md",
  },
  {
    id: "scaffoldcraft-cli",
    title: "ScaffoldCraft CLI",
    description: "Guide for a TypeScript project toolchain CLI: scaffold, configure, build, test, deploy, troubleshoot.",
    fileName: "scaffoldcraft-cli.md",
  },
];

export function listSamples(): (SampleMeta & { sizeBytes: number })[] {
  return SAMPLE_LIST.map((s) => ({
    ...s,
    sizeBytes: readFileSync(join(SAMPLES_DIR, s.fileName)).byteLength,
  }));
}

export function getSample(id: string): { meta: SampleMeta; content: string } {
  const meta = SAMPLE_LIST.find((s) => s.id === id);
  if (!meta) {
    throw new Error(
      `Unknown sample "${id}". Available samples: ${SAMPLE_LIST.map((s) => s.id).join(", ")}.`,
    );
  }
  return { meta, content: readFileSync(join(SAMPLES_DIR, meta.fileName), "utf8") };
}
