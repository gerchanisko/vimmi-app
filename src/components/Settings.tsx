import { useEffect, useState } from "react";
import { PROVIDER_MAP, PROVIDERS, providerBaseUrl, providerModel, type ProviderId } from "../../shared/providers";
import type { Effort, Settings as S } from "../../shared/types";
import { switchVault } from "../lib/actions";
import { COMMANDS } from "../lib/commands";
import { errorText, setState, toast, useApp } from "../lib/store";
import { Icon, Logo } from "./Icon";
import { SyncSettingsPanel } from "./Sync";
import { UpdateSettings } from "./Update";

const TABS = [
  { id: "general", label: "Obecné", icon: "settings" },
  { id: "editor", label: "Editor", icon: "pen" },
  { id: "ai", label: "AI", icon: "sparkle" },
  { id: "sync", label: "Synchronizace", icon: "cloud" },
  { id: "keys", label: "Zkratky", icon: "command" },
  { id: "about", label: "O aplikaci", icon: "info" },
];

const EFFORTS: { id: Effort; label: string }[] = [
  { id: "low", label: "Nízké – rychlé odpovědi" },
  { id: "medium", label: "Střední – doporučeno" },
  { id: "high", label: "Vysoké – důkladnější" },
  { id: "xhigh", label: "Velmi vysoké" },
  { id: "max", label: "Maximální – nejpomalejší" },
];

export default function Settings({ initialTab }: { initialTab?: string }) {
  const settings = useApp((s) => s.settings)!;
  const snapshot = useApp((s) => s.snapshot);
  const [tab, setTab] = useState(initialTab ?? "general");
  const [version, setVersion] = useState("");
  const close = () => setState({ overlay: null });

  useEffect(() => {
    void window.vimmi.app.version().then(setVersion);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const update = async (patch: Partial<S>) => {
    try {
      const next = await window.vimmi.settings.set(patch);
      setState({ settings: { ...settings, ...next } });
    } catch (err) {
      toast(errorText(err), "error");
    }
  };

  return (
    <div className="overlay center" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="settings" role="dialog" aria-label="Nastavení">
        <nav className="settings-nav">
          <h2>Nastavení</h2>
          {TABS.map((t) => (
            <button key={t.id} className={`nav-item${tab === t.id ? " active" : ""}`} onClick={() => setTab(t.id)}>
              <Icon name={t.icon} /> {t.label}
            </button>
          ))}
        </nav>
        <div className="settings-body">
          <button className="icon-btn settings-close" onClick={close} aria-label="Zavřít">
            <Icon name="close" />
          </button>

          {tab === "general" && (
            <>
              <h3>Obecné</h3>
              <Row label="Vzhled">
                <div className="segmented">
                  {(
                    [
                      ["system", "Podle systému", "monitor"],
                      ["light", "Světlý", "sun"],
                      ["dark", "Tmavý", "moon"],
                    ] as const
                  ).map(([v, l, i]) => (
                    <button key={v} className={settings.theme === v ? "on" : ""} onClick={() => void update({ theme: v })}>
                      <Icon name={i} size={14} /> {l}
                    </button>
                  ))}
                </div>
              </Row>
              {window.vimmi.app.kind === "desktop" && <Row label="Trezor" hint={snapshot?.root}>
                <button className="btn" onClick={() => void switchVault().then(close)}>
                  <Icon name="folder-open" /> Otevřít jiný…
                </button>
              </Row>}
              <Row label="Složka deníku" hint="Kam se ukládají denní poznámky (Ctrl+D).">
                <TextSetting value={settings.dailyFolder} onSave={(v) => void update({ dailyFolder: v })} />
              </Row>
              <Row label="Složka šablon" hint="Šablony mohou obsahovat {{date}}, {{time}}, {{title}} a {{weekday}}.">
                <TextSetting value={settings.templatesFolder} onSave={(v) => void update({ templatesFolder: v })} />
              </Row>
              <Row label="Složka příloh" hint="Kam se ukládají vložené obrázky.">
                <TextSetting value={settings.attachmentsFolder} onSave={(v) => void update({ attachmentsFolder: v })} />
              </Row>
            </>
          )}

          {tab === "editor" && (
            <>
              <h3>Editor</h3>
              <Row label="Velikost písma">
                <input type="range" min={13} max={22} value={settings.fontSize} onChange={(e) => void update({ fontSize: Number(e.target.value) })} />
                <span className="muted">{settings.fontSize} px</span>
              </Row>
              <Toggle
                label="Živý náhled"
                hint="Skryje značky Markdownu (**, ##, [[ ]]) všude kromě řádku, na kterém píšeš."
                checked={settings.livePreview}
                onChange={(v) => void update({ livePreview: v })}
              />
              <Toggle label="Čitelná šířka řádku" hint="Omezí šířku textu, aby se lépe četl." checked={settings.readableWidth} onChange={(v) => void update({ readableWidth: v })} />
              <Toggle label="Kontrola pravopisu" checked={settings.spellcheck} onChange={(v) => void update({ spellcheck: v })} hint="Projeví se po znovuotevření poznámky." />
              <Toggle label="Vim režim" hint="Ovládání editoru klávesami jako ve Vimu." checked={settings.vimMode} onChange={(v) => void update({ vimMode: v })} />
              <div className="help-box">
                <strong>Syntaxe</strong>
                <ul>
                  <li>
                    <code>[[Poznámka]]</code> odkaz, <code>[[Poznámka|text]]</code> s vlastním textem, <code>![[obrázek.png]]</code> vložený obrázek
                  </li>
                  <li>
                    <code>#tag</code>, <code>#projekt/web</code> vnořený tag
                  </li>
                  <li>
                    <code>- [ ] úkol @2026-12-24 !1</code> úkol s termínem a prioritou (1–3)
                  </li>
                  <li>
                    Frontmatter <code>type: project</code> udělá z poznámky projekt, <code>project: Název</code> k němu poznámku připojí
                  </li>
                </ul>
              </div>
            </>
          )}

          {tab === "ai" && (
            <>
              <h3>AI asistent</h3>
              <p className="muted">
                Vyber, který model má Vimmi používat. Platíš poskytovateli přímo podle spotřeby, bezplatné možnosti jsou označené. Poznámky se posílají jen
                tehdy, když AI použiješ – s Ollamou nikdy neopustí tvůj počítač.
              </p>
              <div className="provider-grid">
                {PROVIDERS.map((p) => {
                  const ready = settings.keys[p.id] || !p.needsKey;
                  return (
                    <button
                      key={p.id}
                      className={`provider-card${settings.provider === p.id ? " on" : ""}`}
                      onClick={() => void update({ provider: p.id })}
                      aria-pressed={settings.provider === p.id}
                    >
                      <strong>{p.name}</strong>
                      <span className="provider-badges">
                        {p.recommended && <span className="pill accent">doporučeno</span>}
                        {p.free && <span className="pill">zdarma</span>}
                        {p.id === "ollama" && <span className="pill">lokálně</span>}
                        {settings.keys[p.id] && (
                          <span className="pill ok">
                            <Icon name="ok" size={12} /> klíč
                          </span>
                        )}
                        {!ready && <span className="pill">bez klíče</span>}
                      </span>
                    </button>
                  );
                })}
              </div>
              <ProviderSettings key={settings.provider} provider={settings.provider} settings={settings} update={update} />

              <h4 className="settings-sub">Chování</h4>
              <Row label="Úsilí v chatu" hint="Kolik model přemýšlí, než odpoví. Vyšší = kvalitnější, ale pomalejší a dražší. (Claude a OpenAI)">
                <select value={settings.effort} onChange={(e) => void update({ effort: e.target.value as Effort })}>
                  {EFFORTS.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.label}
                    </option>
                  ))}
                </select>
              </Row>
              <Row label="Úsilí u rychlých akcí" hint="Shrnutí, vylepšení textu, překlad…">
                <select value={settings.quickEffort} onChange={(e) => void update({ quickEffort: e.target.value as Effort })}>
                  {EFFORTS.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.label}
                    </option>
                  ))}
                </select>
              </Row>
              <Row label="Změny v poznámkách" hint="Automaticky: AI rovnou zapisuje, změny vidíš v chatu. Ptát se: každou změnu nejdřív schválíš.">
                <div className="segmented">
                  <button className={settings.approvalMode === "auto" ? "on" : ""} onClick={() => void update({ approvalMode: "auto" })}>
                    Automaticky
                  </button>
                  <button className={settings.approvalMode === "ask" ? "on" : ""} onClick={() => void update({ approvalMode: "ask" })}>
                    Ptát se
                  </button>
                </div>
              </Row>
              <Toggle
                label="Hledání na webu"
                hint="Jen Claude a OpenAI. Model může vyhledávat na webu (účtuje se zvlášť). Platí pro nové chaty."
                checked={settings.webSearch}
                onChange={(v) => void update({ webSearch: v })}
              />
              <Toggle label="Zobrazovat přemýšlení" hint="Ukáže shrnutí toho, jak model o odpovědi uvažoval (pokud ho poskytovatel posílá)." checked={settings.showThinking} onChange={(v) => void update({ showThinking: v })} />
              <Row label="Vlastní pokyny" hint="Co by měla AI o tobě vědět nebo jak má odpovídat.">
                <TextArea value={settings.customInstructions} onSave={(v) => void update({ customInstructions: v })} />
              </Row>
            </>
          )}

          {tab === "sync" && <SyncSettingsPanel settings={settings} />}

          {tab === "keys" && (
            <>
              <h3>Klávesové zkratky</h3>
              <table className="keys-table">
                <tbody>
                  {COMMANDS.filter((c) => c.shortcut).map((c) => (
                    <tr key={c.id}>
                      <td>{c.label}</td>
                      <td>
                        <kbd>{window.vimmi.app.platform === "darwin" ? c.shortcut!.replace("Ctrl", "⌘") : c.shortcut}</kbd>
                      </td>
                    </tr>
                  ))}
                  <tr>
                    <td>Otevřít odkaz pod kurzorem / splnit úkol</td>
                    <td>
                      <kbd>Ctrl+Enter</kbd>
                    </td>
                  </tr>
                  <tr>
                    <td>Udělat z řádku úkol</td>
                    <td>
                      <kbd>Ctrl+L</kbd>
                    </td>
                  </tr>
                  <tr>
                    <td>Tučně / kurzíva</td>
                    <td>
                      <kbd>Ctrl+B</kbd> <kbd>Ctrl+I</kbd>
                    </td>
                  </tr>
                  <tr>
                    <td>Hledat v poznámce</td>
                    <td>
                      <kbd>Ctrl+F</kbd>
                    </td>
                  </tr>
                </tbody>
              </table>
            </>
          )}

          {tab === "about" && (
            <div className="about">
              <Logo size={48} />
              <h3>Vimmi {version}</h3>
              <p>Méně chaosu. Více prostoru pro to důležité.</p>
              <p className="muted">Poznámky jsou obyčejné soubory Markdown ve tvém trezoru. Patří tobě.</p>
              <UpdateSettings autoUpdate={settings.autoUpdate} onToggle={(v) => void update({ autoUpdate: v })} />
              <div className="row-actions">
                <button className="btn" onClick={() => void window.vimmi.app.openExternal("https://gerchanisko.github.io/vimmi/")}>
                  Web <Icon name="external" size={13} />
                </button>
                <button className="btn" onClick={() => void window.vimmi.app.openExternal("https://github.com/gerchanisko/vimmi-app")}>
                  GitHub <Icon name="external" size={13} />
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ProviderSettings({
  provider,
  settings,
  update,
}: {
  provider: ProviderId;
  settings: S & { keyEncrypted?: boolean };
  update: (patch: Partial<S>) => Promise<void>;
}) {
  const info = PROVIDER_MAP[provider];
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [models, setModels] = useState<string[] | null>(null);
  const [onlyFree, setOnlyFree] = useState(provider === "openrouter");
  const [modelValue, setModelValue] = useState(providerModel(provider, settings.models));
  const [baseUrl, setBaseUrl] = useState(providerBaseUrl(provider, settings.baseUrls));
  const hasKey = settings.keys[provider];

  const test = async () => {
    setBusy(true);
    setResult(null);
    setResult(await window.vimmi.settings.testKey(provider));
    setBusy(false);
  };
  const saveKey = async () => {
    const k = key.trim();
    if (!k) return;
    if (provider === "anthropic" && !k.startsWith("sk-ant-")) {
      setResult({ ok: false, message: "Claude klíč by měl začínat „sk-ant-“. Zkontroluj, že jsi zkopíroval celý." });
      return;
    }
    const next = await window.vimmi.settings.setKey(provider, k);
    setState((s) => ({ settings: { ...s.settings!, ...next } }));
    setKey("");
    await test();
  };
  const removeKey = async () => {
    const next = await window.vimmi.settings.setKey(provider, null);
    setState((s) => ({ settings: { ...s.settings!, ...next } }));
    setResult(null);
  };
  const loadModels = async () => {
    setBusy(true);
    try {
      setModels(await window.vimmi.settings.models(provider));
      setResult(null);
    } catch (err) {
      setResult({ ok: false, message: errorText(err) });
    } finally {
      setBusy(false);
    }
  };
  const saveModel = (value: string) => {
    setModelValue(value);
    void update({ models: { ...settings.models, [provider]: value.trim() } });
  };

  const shown = (models ?? []).filter((m) => !onlyFree || m.endsWith(":free"));

  return (
    <div className="provider-settings">
      <p className="muted">{info.note}</p>
      {(info.needsKey || provider === "custom") && (
        <Row
          label="API klíč"
          hint={
            hasKey
              ? settings.keyEncrypted
                ? "Uložen zašifrovaně v systémové klíčence."
                : "Uložen v souboru čitelném jen pro tebe."
              : info.needsKey
                ? `Proměnná prostředí ${info.keyEnv} má přednost.`
                : "Volitelný – jen pokud ho server vyžaduje."
          }
        >
          {hasKey ? (
            <div className="row-actions">
              <span className="pill ok">
                <Icon name="ok" size={13} /> Klíč je uložen
              </span>
              <button className="btn ghost" onClick={() => void removeKey()}>
                Odebrat
              </button>
            </div>
          ) : (
            <form
              className="row-actions"
              onSubmit={(e) => {
                e.preventDefault();
                void saveKey();
              }}
            >
              <input type="password" className="key-input" placeholder={provider === "anthropic" ? "sk-ant-…" : "API klíč"} value={key} onChange={(e) => setKey(e.target.value)} />
              <button className="btn primary" type="submit" disabled={!key.trim()}>
                Uložit
              </button>
              {info.keyUrl && (
                <button type="button" className="btn ghost" onClick={() => void window.vimmi.app.openExternal(info.keyUrl!)}>
                  Získat klíč <Icon name="external" size={13} />
                </button>
              )}
            </form>
          )}
        </Row>
      )}
      {info.editableBaseUrl && (
        <Row label="Adresa serveru" hint={info.baseURL ? `Výchozí: ${info.baseURL}` : "Např. http://localhost:1234/v1 (LM Studio)"}>
          <input
            className="url-input"
            value={baseUrl}
            placeholder={info.baseURL || "https://…/v1"}
            onChange={(e) => setBaseUrl(e.target.value)}
            onBlur={() => void update({ baseUrls: { ...settings.baseUrls, [provider]: baseUrl.trim() } })}
          />
        </Row>
      )}
      <Row label="Model" hint={models ? `${shown.length} z ${models.length} modelů` : "Napiš název, vyber z nabídky, nebo načti aktuální seznam."}>
        <div className="model-picker">
          <input
            className="url-input"
            list={`models-${provider}`}
            value={modelValue}
            placeholder={info.defaultModel || "název modelu"}
            onChange={(e) => setModelValue(e.target.value)}
            onBlur={() => modelValue !== providerModel(provider, settings.models) && saveModel(modelValue)}
          />
          <datalist id={`models-${provider}`}>
            {info.suggested.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
            {shown.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          <div className="row-actions">
            <button className="btn" onClick={() => void loadModels()} disabled={busy}>
              {busy ? "Načítám…" : "Načíst modely"}
            </button>
            <button className="btn" onClick={() => void test()} disabled={busy}>
              Otestovat spojení
            </button>
          </div>
          {info.suggested.length > 0 && (
            <div className="model-suggestions">
              {info.suggested.map((m) => (
                <button key={m.id} className={`suggest-chip${modelValue === m.id ? " on" : ""}`} onClick={() => saveModel(m.id)} title={m.id}>
                  {m.label}
                </button>
              ))}
            </div>
          )}
          {models && (
            <>
              {provider === "openrouter" && (
                <label className="check">
                  <input type="checkbox" checked={onlyFree} onChange={(e) => setOnlyFree(e.target.checked)} /> Jen bezplatné
                </label>
              )}
              <div className="model-results">
                {shown.slice(0, 200).map((m) => (
                  <button key={m} className={`model-row${m === modelValue ? " on" : ""}`} onClick={() => saveModel(m)}>
                    {m}
                  </button>
                ))}
                {shown.length === 0 && <p className="muted small pad">Žádné modely.</p>}
              </div>
            </>
          )}
        </div>
      </Row>
      {result && <p className={result.ok ? "ok-text" : "error-text"}>{result.message}</p>}
    </div>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="setting-row">
      <div className="setting-label">
        <span>{label}</span>
        {hint && <span className="muted small">{hint}</span>}
      </div>
      <div className="setting-control">{children}</div>
    </div>
  );
}

function Toggle({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <Row label={label} hint={hint}>
      <button role="switch" aria-checked={checked} aria-label={label} className={`switch${checked ? " on" : ""}`} onClick={() => onChange(!checked)}>
        <span />
      </button>
    </Row>
  );
}

function TextSetting({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return <input value={v} onChange={(e) => setV(e.target.value)} onBlur={() => v.trim() && v !== value && onSave(v.trim())} />;
}

function TextArea({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <textarea
      rows={4}
      value={v}
      placeholder="Např.: Jsem student informatiky. Odpovídej stručně a česky."
      onChange={(e) => setV(e.target.value)}
      onBlur={() => v !== value && onSave(v)}
    />
  );
}
