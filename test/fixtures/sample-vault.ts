// Richer vault with projects, tasks and templates, used by the smoke test.
import { addDays } from "../../shared/markdown";

export function sampleNotes(today: string): Record<string, string> {
  const tomorrow = addDays(today, 1);
  const nextWeek = addDays(today, 5);
  return {
    "Vítej ve Vimmi.md": `# Vítej ve Vimmi

Vimmi je klidné místo pro poznámky, úkoly a projekty. Všechno jsou obyčejné soubory Markdown ve složce, kterou máš pod kontrolou.

## Jak to funguje
- **Odkazy:** napiš \`[[\` a vyber poznámku, třeba [[Nápady]]. Ctrl+klik odkaz otevře.
- **Tagy:** #začínáme – kliknutím na tag v levém panelu vyfiltruješ poznámky.
- **Úkoly:** \`- [ ] text @${tomorrow} !1\` je úkol s termínem a vysokou prioritou. Všechny úkoly najdeš v přehledu **Dnes**.
- **Projekty:** poznámka s \`type: project\` ve frontmatter. Podívej se na [[Web Vimmi]].
- **Deník:** Ctrl+D otevře dnešní denní poznámku.

## Klávesové zkratky
| Zkratka | Akce |
| --- | --- |
| Ctrl+K | Hledat a otevřít cokoliv |
| Ctrl+P | Paleta příkazů |
| Ctrl+N | Nová poznámka |
| Ctrl+J | AI asistent |
| Ctrl+E | Přepnout náhled a úpravy |
| Ctrl+Shift+F | Hledat v obsahu |
| Ctrl+G | Graf souvislostí |
| Ctrl+D | Dnešní poznámka |

## AI asistent
V **Nastavení → AI** vlož svůj Claude API klíč. Pak se můžeš Clauda zeptat na cokoliv o svých poznámkách, nechat si shrnout dlouhý text nebo vytáhnout úkoly ze zápisu ze schůzky. Každou změnu ti nejdřív ukáže a ty ji schválíš.

- [ ] Projít si tuhle poznámku #začínáme
- [ ] Vložit Claude API klíč v Nastavení @${today} !2
`,
    "Nápady.md": `---
tags: [nápady]
---
# Nápady

- Aplikace na sledování čtení knih
- Víkendový výlet do Krkonoš – viz [[Cesty]]
- Naučit se lépe vařit indická jídla

> Nejlepší nápady přicházejí, když na ně nemyslíš.
`,
    "Cesty.md": `# Cesty

Seznam míst, kam se chci podívat. Souvisí s [[Nápady]].

- Krkonoše – Sněžka, Luční bouda
- Lisabon
- Norské fjordy

- [ ] Zjistit ceny ubytování v Krkonoších @${nextWeek} #cestování
`,
    "Projekty/Web Vimmi.md": `---
type: project
status: aktivní
tags: [projekt, web]
---
# Web Vimmi

Prezentační web pro aplikaci Vimmi.

## Cíle
- Jasně vysvětlit, co Vimmi umí
- Rychlé načítání, žádné zbytečné skripty

## Úkoly
- [x] Navrhnout úvodní stránku
- [ ] Napsat sekci Časté otázky !2
- [ ] Připravit snímky obrazovky aplikace @${tomorrow} !1
- [ ] Zkontrolovat přístupnost !3

Související: [[Schůzka – web]]
`,
    "Projekty/Schůzka – web.md": `---
project: Web Vimmi
tags: [schůzka]
---
# Schůzka – web

Zápis ze schůzky k webu.

- Hlavní sdělení: méně chaosu, více prostoru pro to důležité
- Přidat ukázku propojení poznámek
- Do konce týdne poslat první verzi textů

Tip: označ tenhle text a zkus AI akci **Vytáhnout úkoly**.
`,
    "Šablony/Denní poznámka.md": `# {{weekday}} {{date}}

## Dnes
- [ ]

## Poznámky

## Vděčnost
-
`,
    "Šablony/Schůzka.md": `---
tags: [schůzka]
---
# {{title}}

**Datum:** {{date}}
**Účastníci:**

## Body
-

## Úkoly
- [ ]
`,
  };
}
