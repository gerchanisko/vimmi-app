<p align="center">
  <img src="resources/icon.png" width="88" height="88" alt="Vimmi">
</p>

<h1 align="center">Vimmi</h1>

<p align="center"><strong>Všechno důležité. Na jednom místě.</strong><br>
Poznámky, úkoly a projekty v jednom klidném prostoru – s AI asistentem.</p>

<p align="center"><a href="https://gerchanisko.github.io/vimmi/">Web</a> · <a href="#instalace">Instalace</a> · <a href="#funkce">Funkce</a> · <a href="#ai-poskytovatelé">AI</a></p>

Poznámky jsou obyčejné soubory Markdown ve složce (trezoru), takže jsou vždycky tvoje a funguje to i s trezorem z Obsidianu. AI asistent (Claude, OpenRouter, OpenAI, Gemini nebo lokální Ollama) umí v poznámkách hledat, shrnovat, plánovat a rovnou je upravovat.

![Vimmi – AI asistent](docs/screenshots/ai-chat.png)

## Instalace

### Linux (Ubuntu, Debian, Mint, Arch, Manjaro, Fedora, openSUSE…)

Stačí jeden příkaz v terminálu:

```bash
curl -fsSL https://raw.githubusercontent.com/gerchanisko/vimmi-app/main/install.sh | bash
```

Skript si sám:
- doinstaluje chybějící nástroje (`git`, `curl`…) přes správce balíčků tvé distribuce (apt, pacman, dnf, zypper),
- použije systémový Node.js 22+, nebo stáhne oficiální Node.js jen pro Vimmi (do systému nezasahuje),
- stáhne zdrojáky, sestaví aplikaci a přidá **Vimmi do nabídky aplikací** – odtud si ji připneš na panel,
- na Ubuntu 24.04+ přidá AppArmor profil, který Electron aplikace potřebují.

Vše se instaluje do domovské složky (`~/.local/opt/vimmi`); `sudo` se použije jen pro systémové balíčky a AppArmor.

- **Aktualizace:** spusť stejný příkaz znovu.
- **Odinstalace:** `curl -fsSL https://raw.githubusercontent.com/gerchanisko/vimmi-app/main/install.sh | bash -s -- --uninstall` (poznámky a nastavení zůstanou).
- **Ze stažených zdrojáků:** `git clone https://github.com/gerchanisko/vimmi-app && cd vimmi-app && ./install.sh`

### macOS a Windows

Připravujeme. Verze pro macOS a Windows přijdou později.

## Snímky

| Dnes | Graf souvislostí | Tmavý vzhled |
| --- | --- | --- |
| ![Dnes](docs/screenshots/dnes.png) | ![Graf](docs/screenshots/graf.png) | ![Tmavý vzhled](docs/screenshots/tmavy.png) |

## Funkce

**Poznámky**
- Editor Markdownu s živým náhledem (značky se schovají mimo řádek, na kterém píšeš), zvýrazněním kódu, hledáním v poznámce a volitelným Vim režimem
- Odkazy `[[Poznámka]]`, `[[Poznámka|text]]`, `[[Poznámka#Nadpis]]` s doplňováním; klik na neexistující odkaz poznámku vytvoří
- Tagy `#tag` i vnořené `#projekt/web`, tagy ve frontmatter
- Zpětné odkazy, nepropojené zmínky, související poznámky, osnova, vlastnosti
- Režim čtení s klikacími úkoly, export do PDF
- Vkládání obrázků ze schránky nebo přetažením (ukládají se do složky příloh), `![[obrázek.png]]`
- Přejmenování a přesun (i přetažením ve stromu) automaticky opraví odkazy ve všech poznámkách
- Koš (`.trash` v trezoru), záložky, karty, šablony (`{{date}}`, `{{time}}`, `{{title}}`, `{{weekday}}`), denní poznámky
- Změny souborů z jiných programů se projeví okamžitě

**Úkoly a projekty**
- Úkol je řádek `- [ ] text` v jakékoliv poznámce, termín `@2026-10-14`, priorita `!1`–`!3` (kompatibilní i s emoji formátem Obsidian Tasks)
- Přehled **Dnes**: po termínu, dnes, důležité, příštích 7 dní, naposledy upravené
- Přehled **Úkoly** s filtry a seskupením podle poznámky, termínu nebo priority; rychlé přidání úkolu („zítra !1“)
- **Projekty**: poznámka s `type: project`, poznámky k projektu přes `project: Název`; postup, další úkoly, propojené poznámky

**Hledání a navigace**
- Ctrl+K: hledání v názvech i obsahu bez ohledu na diakritiku, filtry Vše / Poznámky / Úkoly / Projekty, vytvoření poznámky
- Ctrl+P: paleta všech příkazů (fuzzy hledání)
- Fulltextové hledání s filtry `#tag` a `path:složka`
- Graf souvislostí (celý trezor nebo okolí poznámky, tagy, neexistující odkazy, přiblížení a tažení)

**AI asistent (Claude)**
- Chat, který vidí otevřenou poznámku a výběr a pomocí nástrojů umí v trezoru hledat, číst poznámky, procházet úkoly, projekty, tagy, souvislosti a deník
- Umí vytvářet a upravovat poznámky, přidávat a odškrtávat úkoly, přejmenovávat a mazat. Ve výchozím stavu zapisuje rovnou; v Nastavení → AI lze zapnout „Ptát se“, pak každou změnu nejdřív ukáže jako rozdíl a čeká na schválení
- Rychlé akce nad výběrem nebo celou poznámkou: shrnout, vylepšit, opravit pravopis, zkrátit, rozvést, pokračovat v psaní, vytáhnout úkoly, osnova, vysvětlit, přeložit, navrhnout název a tagy, vlastní pokyn
- Volitelné hledání na webu, zobrazení přemýšlení, vlastní pokyny, historie chatů (ukládá se v `.vimmi/chats` v trezoru), odhad ceny
- Výběr poskytovatele AI (viz níže), rychlé přepnutí přímo v chatu, načtení aktuálního seznamu modelů

## AI: poskytovatelé

| Poskytovatel | API | Poznámka |
| --- | --- | --- |
| **Claude (Anthropic)** – doporučeno | Anthropic SDK, Messages API | Výchozí, Claude Sonnet 5.5. Přemýšlení, hledání na webu, prompt caching, záložní model při odmítnutí (`fallbacks: "default"`). |
| **OpenAI** | OpenAI SDK, Responses API | GPT-6.x. Nástroje, přemýšlení, hledání na webu; bezstavově (`store: false`). |
| **Google Gemini** | OpenAI-kompatibilní endpoint | Flash modely mají bezplatnou úroveň. Klíč z Google AI Studia. |
| **OpenRouter** – doporučeno | OpenAI-kompatibilní | Stovky modelů jedním klíčem, modely `:free` zdarma (s limity). |
| **Ollama** | OpenAI-kompatibilní, lokálně | Zdarma, poznámky neopustí počítač. Model musí podporovat nástroje (tools). |
| **Vlastní** | OpenAI Chat Completions | LM Studio, vLLM, Groq, Mistral, DeepSeek… s vlastní adresou serveru. |

- Klíče se zadávají v **Nastavení → AI**, každý poskytovatel má vlastní. Ukládají se zašifrovaně přes systémovou klíčenku (Electron `safeStorage`) a nikdy se nedostanou do okna aplikace; všechna volání API probíhají v hlavním procesu.
- Pro vývoj fungují proměnné `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY` a `VIMMI_<POSKYTOVATEL>_BASE_URL` pro jiný server.
- Názvy modelů se často mění, proto tlačítko **Načíst modely** stáhne aktuální seznam přímo od poskytovatele.
- Nástroje AI jsou v [`electron/ai/tools.ts`](electron/ai/tools.ts) a sdílí je všichni poskytovatelé. Nový nástroj přidáš jedním záznamem `def({...})` se schématem v Zodu; u zapisujících nastavíš `write: true` a `preview`, aby šly schválit.
- Smyčky: Claude v [`electron/ai/agent.ts`](electron/ai/agent.ts), ostatní v [`electron/ai/openai-loops.ts`](electron/ai/openai-loops.ts). Když v rozběhnutém chatu změníš poskytovatele, konverzace se převezme jako text.

## Vývoj

Potřebuješ Node.js 22+.

```bash
npm install
npm run dev        # vývojový režim s automatickým načítáním
npm start          # sestaví a spustí aplikaci
npm test           # unit testy (parser, trezor, AI nástroje)
npm run smoke      # end-to-end test: spustí aplikaci, proklikne funkce, AI (Claude, OpenAI, kompatibilní) proti mock serverům
npm run install-desktop   # sestaví a nainstaluje do nabídky aplikací (po změnách v kódu)
npm run dist       # AppImage pro Linux do release/ (vyžaduje FUSE)
```

### Struktura

```
install.sh              instalační skript pro Linux
electron/main.ts        hlavní proces: okno, IPC, otevírání trezoru, deník, šablony, PDF
electron/preload.ts     bezpečné API pro okno (window.vimmi)
electron/vault.ts       trezor v paměti + sledování disku, hledání, přejmenování s opravou odkazů
electron/settings.ts    nastavení a zašifrovaný API klíč
electron/ai/agent.ts    AI chat s nástroji, schvalování změn, rychlé akce, historie; smyčka pro Claude
electron/ai/openai-loops.ts  smyčky pro OpenAI (Responses) a OpenAI-kompatibilní servery
shared/providers.ts     seznam poskytovatelů, výchozí modely, adresy
electron/ai/tools.ts    nástroje pro práci s trezorem
shared/                 parser Markdownu (odkazy, tagy, úkoly) a sdílené typy
src/                    rozhraní v Reactu (CodeMirror 6, markdown-it, d3-force)
test/                   unit testy (Vitest) a smoke test (Playwright + Electron)
```

## Licence

Licence aplikace zatím nebyla zvolena. Písmo Inter je pod licencí SIL Open Font License 1.1 (viz `src/assets/Inter-LICENSE.txt`).
