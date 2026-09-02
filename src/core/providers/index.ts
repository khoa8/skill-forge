/**
 * Provider resolution. The demo path (mock) is always available; remote
 * providers are used only when explicitly configured via environment
 * variables. See .env.example.
 */
import { MockProvider } from "./mock.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";
import { ProviderError, type GenerationProvider } from "./types.js";

export const PROVIDER_IDS = ["mock", "glm", "openai"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export interface ProviderConfig {
  provider: ProviderId;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

const DEFAULT_BASE_URLS: Record<string, string> = {
  glm: "https://open.bigmodel.cn/api/paas/v4",
  openai: "https://api.openai.com/v1",
};

const DEFAULT_MODELS: Record<string, string> = {
  glm: "glm-4-flash",
  openai: "gpt-4o-mini",
};

export function resolveProvider(
  config: ProviderConfig,
  fetchImpl?: typeof fetch,
): GenerationProvider {
  if (config.provider === "mock") {
    return new MockProvider();
  }
  if (!config.apiKey || config.apiKey.trim().length === 0) {
    throw new ProviderError(
      `Provider "${config.provider}" requires an API key. Set SKILLFORGE_API_KEY, or run without a key using the bundled demo provider ("mock").`,
      "provider_key_missing",
    );
  }
  const baseUrl = config.baseUrl?.trim() || DEFAULT_BASE_URLS[config.provider];
  const model = config.model?.trim() || DEFAULT_MODELS[config.provider];
  if (!baseUrl) {
    throw new ProviderError(
      `No default base URL for provider "${config.provider}". Set SKILLFORGE_BASE_URL.`,
      "provider_base_url_missing",
    );
  }
  return new OpenAICompatibleProvider({
    id: config.provider,
    apiKey: config.apiKey,
    baseUrl,
    model: model ?? "gpt-4o-mini",
    fetchImpl,
  });
}

export { MockProvider, OpenAICompatibleProvider };
export type { GenerationProvider } from "./types.js";
export { ProviderError } from "./types.js";
