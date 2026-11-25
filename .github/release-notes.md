## Vimmi

Poznámky, úkoly a kalendář na jednom klidném místě – s AI asistentem.

### Novinka ve verzi 0.10: Claude Code přímo ve Vimmi

V pravém panelu je nová karta **Claude Code** (ikona terminálu). Vimmi v ní spustí tvůj Claude Code ve složce s poznámkami. Rovnou s ním mluvíš na svém předplatném Claude Pro / Max a změny poznámek, úkolů a kalendáře hned vidíš vedle. Přihlašuješ se v něm sám, Vimmi do tvého účtu Claude nevidí. Potřebuje nainstalovaný Claude Code. Při prvním spuštění se zeptá, jestli složce důvěřuješ: vyber *Yes, I trust this folder*.

### Oprava ve verzi 0.9.1

Na Linuxu (instalace přes `install.sh`) se aktualizace z aplikace nepovedla: stahování spadlo a po restartu zůstala stará verze. Opraveno. Kdo má 0.8.x nebo 0.9.0 na Linuxu, aktualizuje se jednou ručně stejným příkazem jako při instalaci: `curl -fsSL https://raw.githubusercontent.com/gerchanisko/vimmi-app/main/install.sh | bash`. Další aktualizace už půjdou samy.

### Novinka ve verzi 0.9: Claude Pro / Max bez API klíče

Máš předplatné Claude? V **Nastavení → AI** jedním tlačítkem připojíš Vimmi do **Claude Code** nebo **Claude Desktop** (jako MCP server). Claude pak pracuje s tvými poznámkami, úkoly a kalendářem na tvém předplatném, bez API klíče. Každá změna se ukládá do historie poznámky. AI přímo ve Vimmi funguje dál jako dřív.

### Oprava ve verzi 0.8.1

Na Windows se verze 0.8.0 po spuštění zasekla a ukazovala jen prázdné okno. Opraveno. Okno teď během startu ukazuje, co se děje, a postup startu se zapisuje do `startup.log` ve složce nastavení (`%APPDATA%\io.github.gerchanisko.vimmi` na Windows, `~/.config/io.github.gerchanisko.vimmi` na Linuxu).

### Novinka ve verzi 0.8: Vimmi v Rustu

Aplikace pro počítač je nově postavená v Rustu (Tauri) místo Electronu. Je výrazně menší, rychleji startuje a bere méně paměti. Všechno ostatní zůstává: tvoje poznámky, nastavení, synchronizace i klíče k AI se převezmou samy, nic nemusíš zadávat znovu. Klíče jsou nově uložené v systémové klíčence.

Kdo má Vimmi 0.7, dostane novou verzi automatickou aktualizací.

### Instalace

- **Windows:** stáhni `Vimmi-Setup.exe` a spusť ho. Windows může zobrazit varování SmartScreen (instalátor zatím není podepsaný) – klikni na *Další informace → Přesto spustit*.
- **Linux:** `curl -fsSL https://raw.githubusercontent.com/gerchanisko/vimmi-app/main/install.sh | bash` (doporučeno – přidá Vimmi do nabídky aplikací), nebo stáhni `Vimmi.AppImage`.
- **iPhone, Android, Mac:** webová aplikace https://gerchanisko.github.io/vimmi-app/

Web: https://gerchanisko.github.io/vimmi/
