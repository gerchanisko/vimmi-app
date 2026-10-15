// AI providers Vimmi can talk to. Shared by the main process and the settings UI.
// Model names change often, so every provider can also load its live model list.

export type ProviderId = "anthropic" | "openai" | "gemini" | "openrouter" | "nvidia" | "ollama" | "custom";

/** Which API shape the provider speaks. */
export type ProviderKind = "anthropic" | "responses" | "chat";

export interface ProviderInfo {
  id: ProviderId;
  name: string;
  kind: ProviderKind;
  baseURL?: string;
  /** The user can change the server address (local or self-hosted servers). */
  editableBaseUrl?: boolean;
  needsKey: boolean;
  keyUrl?: string;
  keyEnv?: string;
  defaultModel: string;
  suggested: { id: string; label: string }[];
  note: string;
  free?: boolean;
  /** Shown first, with a "doporučeno" badge. */
  recommended?: boolean;
  /** Not callable from the web app (the server does not allow browser requests): the reason to show. */
  desktopOnly?: string;
  /** Models in the live list that are not chat models (embeddings, filters…) and should be hidden. */
  hideModels?: RegExp;
  /** $ per million tokens [input, output, cache read] for the cost estimate. */
  prices?: Record<string, [number, number, number]>;
}

export const PROVIDERS: ProviderInfo[] = [
  {
    id: "anthropic",
    name: "Claude (Anthropic)",
    kind: "anthropic",
    needsKey: true,
    keyUrl: "https://platform.claude.com/settings/keys",
    keyEnv: "ANTHROPIC_API_KEY",
    defaultModel: "claude-sonnet-5-5",
    suggested: [
      { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5 – doporučeno, $2 / $10" },
      { id: "claude-opus-5-5", label: "Claude Opus 5.5 – nejschopnější, $4 / $20" },
      { id: "claude-haiku-5-5", label: "Claude Haiku 5.5 – nejrychlejší, $0.10 / $0.50" },
    ],
    note: "Nejlepší podpora: přemýšlení, hledání na webu, záložní model při odmítnutí.",
    recommended: true,
    prices: {
      "claude-sonnet-5-5": [2, 10, 0.2],
      "claude-opus-5-5": [4, 20, 0.2],
      "claude-haiku-5-5": [0.1, 0.5, 0.01],
    },
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    kind: "chat",
    baseURL: "https://openrouter.ai/api/v1",
    needsKey: true,
    keyUrl: "https://openrouter.ai/settings/keys",
    keyEnv: "OPENROUTER_API_KEY",
    defaultModel: "",
    suggested: [],
    note: "Stovky modelů jedním klíčem, včetně Claude, GPT a Gemini. Modely s „:free“ na konci jsou zdarma (s limity). Načti seznam modelů.",
    free: true,
    recommended: true,
  },
  {
    id: "nvidia",
    name: "NVIDIA",
    kind: "chat",
    baseURL: "https://integrate.api.nvidia.com/v1",
    needsKey: true,
    keyUrl: "https://build.nvidia.com/settings/api-keys",
    keyEnv: "NVIDIA_API_KEY",
    // Some accounts get "Function not found" for some models (often Kimi), so the most widely
    // available ones come first; "Otestovat spojení" switches to the first one that works.
    defaultModel: "z-ai/glm-5.3",
    suggested: [
      { id: "z-ai/glm-5.3", label: "GLM 5.3 – doporučeno, dobře používá nástroje" },
      { id: "deepseek-ai/deepseek-v4.1-flash", label: "DeepSeek V4.1 Flash – rychlý" },
      { id: "nvidia/nemotron-3-super-120b-a12b", label: "Nemotron 3 Super – model od NVIDIE" },
      { id: "moonshotai/kimi-k2.6", label: "Kimi K2.6 – na některých účtech nedostupný" },
    ],
    note: "Zdarma: klíč (začíná nvapi-) získáš po registraci na build.nvidia.com, omezení je kolem 40 dotazů za minutu. Podle podmínek NVIDIE je bezplatný přístup určený pro vývoj a vyzkoušení.",
    free: true,
    desktopOnly: "NVIDIA nepovoluje dotazy z prohlížeče, takže ve webové aplikaci (telefon) nefunguje. Na počítači ano.",
    hideModels: /embed|rerank|reward|safety|guard|parse|retriever|clip|-vl-|vision|ocr|tts|asr|whisper|riva|cosmos|flux|stable-diffusion|sdxl|nv-?grounding|deplot|kosmos|paligemma|fuyu|neva|vila|detector|calibration/i,
  },
  {
    id: "openai",
    name: "OpenAI (GPT)",
    kind: "responses",
    baseURL: "https://api.openai.com/v1",
    needsKey: true,
    keyUrl: "https://platform.openai.com/api-keys",
    keyEnv: "OPENAI_API_KEY",
    defaultModel: "gpt-6.1-sol",
    suggested: [
      { id: "gpt-6.1-sol", label: "GPT-6.1 Sol – vyvážený, $2 / $10" },
      { id: "gpt-6-astra", label: "GPT-6 Astra – nejschopnější" },
      { id: "gpt-6-luna", label: "GPT-6 Luna – levný a rychlý, $0.10 / $0.50" },
    ],
    note: "Přes Responses API, s nástroji, přemýšlením a hledáním na webu.",
    prices: {
      "gpt-6.1-sol": [2, 10, 0.1],
      "gpt-6-luna": [0.1, 0.5, 0.01],
    },
  },
  {
    id: "gemini",
    name: "Google Gemini",
    kind: "chat",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
    needsKey: true,
    keyUrl: "https://aistudio.google.com/apikey",
    keyEnv: "GEMINI_API_KEY",
    defaultModel: "gemini-3.8-flash",
    suggested: [
      { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash – rychlý, má bezplatnou úroveň" },
      { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite – nejlevnější, bezplatná úroveň" },
      { id: "gemini-3.1-pro", label: "Gemini 3.1 Pro – nejschopnější (placený)" },
    ],
    note: "Flash modely mají bezplatnou úroveň s denním limitem. Klíč zdarma v Google AI Studiu.",
    free: true,
  },
  {
    id: "ollama",
    name: "Ollama (lokálně)",
    kind: "chat",
    baseURL: "http://localhost:11434/v1",
    editableBaseUrl: true,
    needsKey: false,
    defaultModel: "",
    suggested: [],
    note: "Zdarma a soukromě na tvém počítači. Nainstaluj Ollamu, stáhni model (např. `ollama pull qwen3`) a načti seznam.",
    free: true,
  },
  {
    id: "custom",
    name: "Vlastní (OpenAI-kompatibilní)",
    kind: "chat",
    baseURL: "",
    editableBaseUrl: true,
    needsKey: false,
    defaultModel: "",
    suggested: [],
    note: "Jakýkoliv server s OpenAI Chat Completions API: LM Studio, vLLM, Groq, Mistral, DeepSeek, Together…",
  },
];

export const PROVIDER_MAP = Object.fromEntries(PROVIDERS.map((p) => [p.id, p])) as Record<ProviderId, ProviderInfo>;

export function providerModel(id: ProviderId, models: Partial<Record<ProviderId, string>>): string {
  return models[id] || PROVIDER_MAP[id].defaultModel;
}

export function providerBaseUrl(id: ProviderId, baseUrls: Partial<Record<ProviderId, string>>): string {
  const info = PROVIDER_MAP[id];
  return (info.editableBaseUrl && baseUrls[id]) || info.baseURL || "";
}
