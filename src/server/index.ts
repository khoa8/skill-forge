/**
 * Server entrypoint. Loads the documented `.env` file (process environment
 * keeps precedence), validates provider configuration BEFORE serving traffic
 * and exits with an actionable message on misconfiguration; without any
 * configuration it runs the fully offline demo provider so no API key is ever
 * required for the bundled workflow.
 */
import { loadDotEnv, resolveRuntimeConfig, resolveServerBind, ConfigError } from "../config/env.js";
import { createApp, isLoopbackHost, type AppConfig } from "./app.js";

loadDotEnv();

let runtime: ReturnType<typeof resolveRuntimeConfig>;
let bind: ReturnType<typeof resolveServerBind>;
try {
  runtime = resolveRuntimeConfig();
  bind = resolveServerBind();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(`SkillForge configuration error: ${err.message}`);
    process.exit(1);
  }
  throw err;
}

const config: AppConfig = {
  provider: runtime.provider,
  hasApiKey: runtime.apiKey !== undefined,
  baseUrl: runtime.baseUrl,
  model: runtime.model,
};

const app = createApp(config);

const server = app.listen(bind.port, bind.host, () => {
  console.log(`SkillForge v0.1.0 listening on http://${bind.host}:${bind.port}`);
  console.log(`  provider: ${config.provider}${config.provider === "mock" ? " (offline demo — no API key needed)" : ""}`);
  console.log(`  UI:       http://${bind.host}:${bind.port}/`);
  if (!isLoopbackHost(bind.host) && process.env.SKILLFORGE_ACKNOWLEDGE_EXPOSURE !== "1") {
    console.warn(
      `\n  WARNING: bound to non-loopback address "${bind.host}".\n` +
        `  SkillForge has no built-in authentication or tenant isolation; any device that\n` +
        `  can reach this address can generate skills, read stored skills and sources, and\n` +
        `  edit/export them. The supported model is local / trusted self-hosted use. If this\n` +
        `  exposure is deliberate, set SKILLFORGE_ACKNOWLEDGE_EXPOSURE=1 to silence this warning.\n`,
    );
  }
});
// A failed bind (port already in use, unreachable host) must be an honest,
// actionable startup failure — not an unhandled 'error' event stack trace.
server.on("error", (err) => {
  console.error(`SkillForge cannot start: ${(err as Error).message}`);
  process.exit(1);
});
