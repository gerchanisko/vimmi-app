## Vimmi

Poznámky, úkoly a kalendář na jednom klidném místě – s AI asistentem.

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
