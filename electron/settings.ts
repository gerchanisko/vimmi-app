// App settings (JSON in the user data folder) and encrypted API keys, one per provider.
import fs from "node:fs";
import path from "node:path";
import { app, safeStorage } from "electron";
import { PROVIDER_MAP, PROVIDERS, type ProviderId } from "../shared/providers";
import { DEFAULT_SETTINGS, type Settings } from "../shared/types";

const settingsFile = () => path.join(app.getPath("userData"), "settings.json");
const keysFile = () => path.join(app.getPath("userData"), "api-keys.json");
/** Single Claude key used by version 0.1. */
const legacyKeyFile = () => path.join(app.getPath("userData"), "api-key.bin");

let cache: Settings | undefined;

type StoredKeys = Partial<Record<ProviderId, string>>;

function readKeys(): StoredKeys {
  let keys: StoredKeys = {};
  try {
    keys = JSON.parse(fs.readFileSync(keysFile(), "utf8"));
  } catch {
    keys = {};
  }
  if (!keys.anthropic && fs.existsSync(legacyKeyFile())) {
    keys.anthropic = fs.readFileSync(legacyKeyFile()).toString("base64");
  }
  return keys;
}

function decode(stored: string): string | undefined {
  try {
    const raw = Buffer.from(stored, "base64");
    if (raw.subarray(0, 6).toString() === "plain:") return raw.subarray(6).toString("utf8");
    return safeStorage.decryptString(raw);
  } catch {
    return undefined;
  }
}

/** Keys from environment variables win, so developers can use e.g. OPENAI_API_KEY. */
export function getApiKey(provider: ProviderId): string | undefined {
  const env = PROVIDER_MAP[provider].keyEnv;
  if (env && process.env[env]) return process.env[env];
  const stored = readKeys()[provider];
  return stored ? decode(stored) : undefined;
}

function derived(s: Omit<Settings, "hasApiKey" | "keys">): Pick<Settings, "hasApiKey" | "keys"> {
  const keys: Partial<Record<ProviderId, boolean>> = {};
  for (const p of PROVIDERS) keys[p.id] = Boolean(getApiKey(p.id));
  const info = PROVIDER_MAP[s.provider] ?? PROVIDER_MAP.anthropic;
  return { keys, hasApiKey: Boolean(keys[info.id]) || !info.needsKey };
}

export function loadSettings(): Settings {
  if (cache) return cache;
  let stored: Partial<Settings> & { model?: string } = {};
  try {
    stored = JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
  } catch {
    stored = {};
  }
  // Migrate the single Claude model setting from 0.1.
  const { model: legacyModel, ...rest } = stored;
  const merged = { ...DEFAULT_SETTINGS, ...rest };
  if (legacyModel && !merged.models.anthropic) merged.models = { ...merged.models, anthropic: legacyModel };
  if (!PROVIDER_MAP[merged.provider]) merged.provider = "anthropic";
  cache = { ...merged, ...derived(merged) };
  return cache;
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const base = { ...loadSettings(), ...patch };
  const next = { ...base, ...derived(base) };
  cache = next;
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  const { hasApiKey: _h, keys: _k, ...persist } = next;
  fs.writeFileSync(settingsFile(), JSON.stringify(persist, null, 2));
  return next;
}

export function keyStorageIsEncrypted(): boolean {
  return safeStorage.isEncryptionAvailable() && safeStorage.getSelectedStorageBackend?.() !== "basic_text";
}

export function setApiKey(provider: ProviderId, key: string | null): Settings {
  const keys = readKeys();
  if (!key) {
    delete keys[provider];
    if (provider === "anthropic") fs.rmSync(legacyKeyFile(), { force: true });
  } else {
    const value = key.trim();
    // Without an OS keyring, fall back to a file only the current user can read.
    const raw = safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(value)
      : Buffer.concat([Buffer.from("plain:"), Buffer.from(value)]);
    keys[provider] = raw.toString("base64");
  }
  fs.mkdirSync(path.dirname(keysFile()), { recursive: true });
  fs.writeFileSync(keysFile(), JSON.stringify(keys), { mode: 0o600 });
  return saveSettings({});
}
