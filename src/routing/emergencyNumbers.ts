/**
 * "Quais números de emergência eu preciso saber na Tailândia?" (Sextant trv-001-pt, gate a11d730): the library
 * had nothing on Thailand, and the no-source health answer gave Brazil's, Europe's and the US numbers. A small
 * fixed table of national emergency numbers answers exactly, for the countries it lists (from each country's
 * official numbers as listed by Wikipedia's "List of emergency telephone numbers"; checked 2026-09). Pure.
 */

interface CountryNumbers {
  names: RegExp;
  en: string;
  pt: string;
}

const COUNTRIES: CountryNumbers[] = [
  { names: /\b(thailand|tail[âa]ndia|bangkok)\b/i, en: "Thailand: police 191, ambulance 1669, fire 199, tourist police 1155 (English-speaking).", pt: "Tailândia: polícia 191, ambulância 1669, bombeiros 199, polícia turística 1155 (atende em inglês)." },
  { names: /\b(brazil|brasil)\b/i, en: "Brazil: police 190, ambulance (SAMU) 192, fire 193.", pt: "Brasil: polícia 190, ambulância (SAMU) 192, bombeiros 193." },
  { names: /\b(portugal)\b/i, en: "Portugal: 112 (police, ambulance and fire).", pt: "Portugal: 112 (polícia, ambulância e bombeiros)." },
  { names: /\b(spain|espanha)\b/i, en: "Spain: 112 (all emergencies).", pt: "Espanha: 112 (todas as emergências)." },
  { names: /\b(france|fran[çc]a)\b/i, en: "France: 112, or ambulance (SAMU) 15, police 17, fire 18.", pt: "França: 112, ou ambulância (SAMU) 15, polícia 17, bombeiros 18." },
  { names: /\b(germany|alemanha)\b/i, en: "Germany: ambulance and fire 112, police 110.", pt: "Alemanha: ambulância e bombeiros 112, polícia 110." },
  { names: /\b(italy|it[áa]lia)\b/i, en: "Italy: 112 (all emergencies).", pt: "Itália: 112 (todas as emergências)." },
  { names: /\b(united kingdom|uk|england|scotland|reino unido|inglaterra|esc[óo]cia)\b|(?<!new south )\bwales\b/i, en: "United Kingdom: 999 or 112.", pt: "Reino Unido: 999 ou 112." },
  { names: /\b(united states|usa|estados unidos|eua)\b|\bu\.s\.(?:a\.?)?(?![a-z])/i, en: "United States: 911.", pt: "Estados Unidos: 911." },
  { names: /\b(canada|canad[áa])\b/i, en: "Canada: 911.", pt: "Canadá: 911." },
  { names: /\b(mexico|m[ée]xico)\b/i, en: "Mexico: 911.", pt: "México: 911." },
  { names: /\b(argentina)\b/i, en: "Argentina: 911 (police), ambulance 107, fire 100.", pt: "Argentina: 911 (polícia), ambulância 107, bombeiros 100." },
  { names: /\b(japan|jap[ãa]o)\b/i, en: "Japan: police 110, fire and ambulance 119.", pt: "Japão: polícia 110, bombeiros e ambulância 119." },
  { names: /\b(china)\b/i, en: "China: police 110, ambulance 120, fire 119.", pt: "China: polícia 110, ambulância 120, bombeiros 119." },
  // Not North Korea ("North Korea", "Coreia do Norte"): South Korea's numbers would be wrong there.
  { names: /\b(south korea|coreia do sul)\b|(?<!north\s)\bkorea\b|\bcoreia\b(?!\s+do\s+norte)/i, en: "South Korea: police 112, fire and ambulance 119.", pt: "Coreia do Sul: polícia 112, bombeiros e ambulância 119." },
  { names: /(?<![a-zà-ÿ])[íi]ndia\b/i, en: "India: 112 (all emergencies).", pt: "Índia: 112 (todas as emergências)." },
  { names: /\b(australia|austr[áa]lia|new south wales)\b/i, en: "Australia: 000 (112 also works from mobile phones).", pt: "Austrália: 000 (112 também funciona em celulares)." },
  { names: /\b(new zealand|nova zel[âa]ndia)\b/i, en: "New Zealand: 111.", pt: "Nova Zelândia: 111." },
  { names: /\b(vietnam|vietn[ãa])\b/i, en: "Vietnam: police 113, fire 114, ambulance 115.", pt: "Vietnã: polícia 113, bombeiros 114, ambulância 115." },
  { names: /\b(philippines|filipinas)\b/i, en: "Philippines: 911.", pt: "Filipinas: 911." },
  { names: /\b(turkey|t[üu]rkiye|turquia)\b/i, en: "Turkey: 112 (all emergencies).", pt: "Turquia: 112 (todas as emergências)." },
];

const ASKS_NUMBERS =
  /\b(emergency (phone |telephone )?numbers?|numbers? (to call|for emergenc\w*)|who (do|should) i call)\b|n[úu]meros? de emerg[êe]ncia|telefones? de emerg[êe]ncia|para quem (eu )?ligo/i;

/** The emergency numbers of the countries the question names, or null (no such question, or no listed country). */
export function emergencyNumbersAnswer(query: string, pt: boolean): string | null {
  if (!ASKS_NUMBERS.test(query)) return null;
  const hits = COUNTRIES.filter((c) => c.names.test(query));
  if (!hits.length) return null;
  const lines = hits.map((c) => (pt ? c.pt : c.en));
  return pt
    ? `Números de emergência (tabela offline do app): ${lines.join(" ")} Em caso de risco à vida, ligue imediatamente.`
    : `Emergency numbers (the app's offline table): ${lines.join(" ")} If a life is at risk, call right away.`;
}

/** The emergency numbers line of the first listed country the text names, or null. */
export function emergencyNumbersLine(text: string, pt: boolean): string | null {
  const hit = COUNTRIES.find((c) => c.names.test(text));
  return hit ? (pt ? `Emergência — ${hit.pt}` : `Emergency — ${hit.en}`) : null;
}
