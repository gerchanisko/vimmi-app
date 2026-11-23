# Bezpečnost

## Nahlášení chyby

Našel jsi bezpečnostní chybu? **Nepiš ji do veřejného issue.** Nahlas ji soukromě přes
[GitHub → Security → Report a vulnerability](https://github.com/gerchanisko/vimmi-app/security/advisories/new).
Ozvu se co nejdřív a po opravě tě rád uvedu jako autora nálezu.

Podporovaná je vždy jen nejnovější verze (aktualizace se instalují samy).

## Jak Vimmi chrání tvoje data

- **Poznámky** jsou obyčejné soubory u tebe. Vimmi nemá žádný vlastní server a nic neposílá autorovi.
- **API klíče a token pro synchronizaci** jsou v počítači zašifrované systémovou klíčenkou (Správce pověření ve Windows, na Linuxu Secret Service / KWallet). Když systém klíčenku nemá, uloží se do souboru čitelného jen pro tebe a Vimmi to v nastavení napíše. Klíč se posílá jen poskytovateli AI, kterého vybereš, a token jen na GitHub. Ve webové aplikaci zůstávají v úložišti prohlížeče na tvém zařízení.
- **Poznámky se nespouštějí jako kód:** HTML v Markdownu se nevykresluje, aplikace má přísné Content Security Policy a okno smí volat jen vyjmenované příkazy aplikace. Každou cestu k souboru kontroluje Rust a nic mimo složku trezoru nepřečte ani nezapíše.
- **AI** pracuje jen s tvým trezorem a nemůže sahat mimo něj. Smazané poznámky jdou do koše. Obrázky z internetu v odpovědích AI se nenačítají samy (ochrana proti vynášení dat skrytými pokyny v poznámkách). Hledání na webu je ve výchozím stavu vypnuté.
- **Aktualizace** se stahují jen z vydání na GitHubu, která prošla testy na Windows a Linuxu, a jsou podepsané: aplikace nainstaluje jen soubor s platným podpisem klíčem Vimmi, upravený nebo podvržený soubor odmítne. Linuxový instalační skript ověřuje kontrolní součet SHA-256. Webová aplikace se nasazuje spolu s nimi.
- **Aplikace pro počítač** je od verze 0.8 napsaná v Rustu (Tauri) a nemá Node.js ani režimy Electronu, přes které by ji mohl zneužít jiný program. Testovací přepínače aktualizací fungují jen ve vývojovém sestavení.
