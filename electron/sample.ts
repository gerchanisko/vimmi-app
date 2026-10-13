// The single note a new vault starts with.

export function sampleNotes(today: string): Record<string, string> {
  return {
    "Vítej ve Vimmi.md": `# Vítej ve Vimmi

Vimmi je klidné místo pro poznámky, úkoly a projekty. Všechno jsou obyčejné soubory Markdown ve složce, kterou máš pod kontrolou.

## Jak to funguje
- **Odkazy:** napiš \`[[\` a vyber nebo pojmenuj poznámku. Kliknutím odkaz otevřeš, a když poznámka ještě neexistuje, vytvoří se.
- **Tagy:** #začínáme – kliknutím na tag v levém panelu vyfiltruješ poznámky.
- **Úkoly:** \`- [ ] text @${today} !1\` je úkol s termínem a vysokou prioritou. Všechny úkoly najdeš v přehledu **Dnes** a **Úkoly**.
- **Projekty:** přidej do poznámky \`type: project\` ve frontmatter, nebo v přehledu **Projekty** klikni na „Nový projekt“.
- **Deník:** Ctrl+D otevře dnešní denní poznámku.

## Klávesové zkratky
| Zkratka | Akce |
| --- | --- |
| Ctrl+K | Hledat a otevřít cokoliv |
| Ctrl+P | Paleta příkazů |
| Ctrl+N | Nová poznámka |
| Ctrl+J | AI asistent |
| Ctrl+E | Přepnout náhled a úpravy |
| Ctrl+G | Graf souvislostí |
| Ctrl+D | Dnešní poznámka |

## AI asistent
V **Nastavení → AI** si vyber poskytovatele (doporučený je Claude nebo OpenRouter) a vlož API klíč. Pak se můžeš zeptat na cokoliv o svých poznámkách, nechat si shrnout text nebo vytáhnout úkoly ze zápisu.

- [ ] Projít si tuhle poznámku #začínáme
- [ ] Nastavit AI v Nastavení @${today}
`,
  };
}
