/**
 * Server entrypoint. Reads provider configuration from the environment
 * (see .env.example); without configuration it runs the fully offline demo
 * provider so no API key is ever required for the bundled workflow.
 */
import { createApp, type AppConfig } from "./app.js";

const provider = (process.env.SKILLFORGE_PROVIDER ?? "mock").trim().toLowerCase();
const apiKey = process.env.SKILLFORGE_API_KEY?.trim() || undefined;

const config: AppConfig = {
  provider,
  hasApiKey: apiKey !== undefined && apiKey.length > 0,
  baseUrl: process.env.SKILLFORGE_BASE_URL?.trim() || undefined,
  model: process.env.SKILLFORGE_MODEL?.trim() || undefined,
};

const app = createApp(config);
const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "127.0.0.1";

app.listen(port, host, () => {
  console.log(`SkillForge v0.1.0 listening on http://${host}:${port}`);
  console.log(`  provider: ${config.provider}${config.provider === "mock" ? " (offline demo — no API key needed)" : ""}`);
  console.log(`  UI:       http://${host}:${port}/`);
});
