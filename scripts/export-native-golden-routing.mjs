// Golden outputs of the pure routing leaves (src/routing/emergencyNumbers, smallTalk, ptQuery, classify, calculators)
// for the native port's parity tests. Inputs: every string literal of the routing vitest files, the eval questions
// and edge cases, for both languages. The Kotlin port (team.sopa.boar.engine.routing) must reproduce them exactly.
//   node scripts/export-native-golden-routing.mjs          # write
//   node scripts/export-native-golden-routing.mjs --check  # exit 1 if out of date
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerHooks } from "node:module";
import ts from "typescript";

// smallTalk formats the time and the date in the local time zone: fix it (the Kotlin test passes the same zone).
const TZ = "America/Sao_Paulo";
process.env.TZ = TZ;

registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (e) {
      if (specifier.startsWith(".") && !/\.[cm]?[jt]sx?$|\.json$/.test(specifier)) return next(`${specifier}.ts`, context);
      throw e;
    }
  },
  // Compile .ts with TypeScript (type-only imports, TS-only syntax).
  load(url, context, next) {
    if (!url.startsWith("file:") || !url.endsWith(".ts")) return next(url, context);
    const source = readFileSync(fileURLToPath(url), "utf8");
    const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
    return { format: "module", source: js, shortCircuit: true };
  },
});

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outFile = join(root, "android-native/engine/src/test/resources/golden/routing-leaves.json");
const em = await import(join(root, "src/routing/emergencyNumbers.ts"));
const st = await import(join(root, "src/routing/smallTalk.ts"));
const pq = await import(join(root, "src/routing/ptQuery.ts"));
const cl = await import(join(root, "src/routing/classify.ts"));
const ca = await import(join(root, "src/routing/calculators.ts"));
const evalSet = await import(join(root, "src/eval/evalSet.ts"));

// Every string literal of the routing tests (queries, expected texts: all fair inputs).
function literals(file) {
  const src = readFileSync(join(root, file), "utf8");
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.ES2022, true);
  const out = [];
  const visit = (n) => {
    if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && !ts.isImportDeclaration(n.parent)) out.push(n.text);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}
const testFiles = ["emergencyNumbers", "smallTalk", "ptQuery", "classify", "calculators", "context", "router"].map((m) => `src/routing/${m}.test.ts`);

const edges = [
  "", " ", "   \n\t ", "?", "!!!", "...", ",", ";", "and", ",,, and ;", " oi ", "　hi　",
  "Oi!", "OLÁ", "olá, tudo bem?", "Bom dia!!", "boa noite", "good night", "Valeu, tchau", "hi and thanks", "ok, obrigado",
  "hi, what is a monsoon?", "e aí", "E AÍ BOAR?", "quem é você?", "Qual é o seu nome?", "what's your name please",
  "Que horas são?", "what time is it now", "what's the time?", "Que dia é hoje?", "what is the date today", "qual a data de hoje",
  "how's it going?", "How are you?", "thank you so much!", "thanks a lot", "see ya", "até logo", "falou",
  "Tell me a joke", "who built you?", "are you an AI?", "Are you ChatGPT?", "what day is it today",
  "Is it safe to drink tap water in Portugal?", "É seguro beber água da torneira?", "Há vagas?", "Existe cura?", "são duas?",
  "Por que o céu é azul?", "Porque chove?", "Como funciona um motor?", "Explique a fotossíntese", "Quais as causas da guerra?",
  "Qual a diferença entre vírus e bactéria?", "Compare cats vs. dogs", "qual é melhor, chá ou café?", "comparação de preços",
  "translate this to French", "Summarize the article", "tl;dr", "```js\nfoo()\n```", "regex for emails", "3 + 4", "12×3", "10 ÷ 2",
  "extract all names", "list all countries", "What caused WWI?", "effects of caffeine", "a b c d e f g h i j k l m n o p q r s t u v w x y z",
  "Quantos ossos tem o corpo humano?", "Onde fica Lisboa?", "quando foi a independência?",
  "Quais números de emergência eu preciso saber na Tailândia?", "What are the emergency numbers in Japan and China?",
  "Emergency number for the U.S.?", "emergency numbers for the u.s.a", "emergency numbers in North Korea", "números de emergência na Coreia do Norte",
  "números de emergência na Coreia", "emergency numbers in Korea", "emergency numbers in south korea", "Números de emergência na Índia", "emergency numbers in India",
  "telefones de emergência no Brasil e em Portugal", "para quem eu ligo na França?", "who should I call in Türkiye?", "Who do I call in Turkiye",
  "numbers to call in New Zealand", "numbers for emergencies in Vietnã", "emergency phone numbers UK", "emergency telephone number Australia",
  "Estou na Itália, números de emergência?", "emergency numbers Canadá México Argentina", "emergency numbers in Thailand", "emergency numbers Mars",
  "Sangramento no nariz, o que fazer?", "meu filho está com o nariz sangrando", "picada de cobra na trilha", "uma cobra me mordeu", "fui picado por uma serpente",
  "ferroada de vespa", "picada de escorpião", "parada cardíaca", "infarto", "AVC", "derrame cerebral", "RCP em criança", "reanimação cardiopulmonar",
  "derramou água fervente no braço", "água quente caiu na mão", "ele se queimou com óleo quente", "escaldadura", "tremendo de frio", "frio e calafrios",
  "como tornar a água potável", "água contaminada", "insolação", "golpe de calor", "reação alérgica", "choque anafilático", "hemorragia", "queimadura",
  "engasgou", "asfixia", "afogamento", "hipotermia", "desidratação", "desmaiou", "convulsão", "fratura exposta", "quebrou o braço", "torção no tornozelo",
  "envenenamento", "ferida aberta", "febre alta", "alergia", "bordas das placas", "placas tectônicas", "terremoto", "enchente", "furacão", "incêndio",
  "primeiros socorros para queimadura", "kit de PRIMEIROS SOCORROS", "evacuação", "prevenir", "tratar", "parar", "bebê", "SANGRAMENTO NASAL", "I got bitten by a rattlesnake", "snake bites", "spilled boiling water on my leg",
  "hot oil burned me", "scalds", "I'm shivering in the cold", "cold and shivering", "my nose is bleeding", "nosebleeds", "my arm is bleeding a lot",
  "he is choking", "bleeds", "she chokes",
  "7,5 L/100 km in mpg", "30 mpg em L/100 km", "6 litros por 100 km em milhas por galão imperial", "8 l per 100 km to mpg uk", "0 L/100 km to mpg",
  "40 miles per gallon to L/100 km", "Naismith: 10 km and 500 m", "naismith 12,5 km", "naismith 1.234,5 km e 2.000 m de subida", "Naismith 7 km 300 mi",
  "1 euro vale 6,2 reais; a conta deu 100 euros", "1 USD = 5,5 BRL, quanto é 200 BRL com 15% de gorjeta?", "1 dollar is worth 0.92 eur: 50 eur", "1 libra custa 7 reais. 30 reais?",
  "1 u.s. dollar equals 150 yen; dinner was 12.000 yen with 10% service", "1 € = 1,08 usd", "1 dólar = 0 reais, 10 reais",
  "10000 mAh 3.7 V on a plane?", "27.000 mAh 3,7 V no avião", "40000 mAh 3.7 V flight", "3000 mAh", "5 V", "1 mAh 1 V",
  "Somos 4 e vamos 3 dias, 2,5 litros por dia de água", "we are five, 3-day hike, 4 L of water per day", "2 adults, 10 days, 3 litres a day of water",
  "água: somos duas pessoas, 1 dia, 2 l/dia", "doze pessoas, onze dias, 1,5 litros por dia, água", "TRÊS pessoas, dois dias, 2 litros por dia de água",
  "100 °C em Fahrenheit", "-40 F to C", "32 °F in Celsius", "0 C to F", "212 degrees fahrenheit to celsius", "36,6 graus c para f", "35 °C, é perigoso correr?",
  "40 °C in F, safe to hike?", "33 C to F hiking", "-0.04 F to C", "-0 C to F", "1000 °F in C", "1234.5 F to C, dangerous?", "30 °C to °C", "99999999 C to F",
  "1e3 C to F", "2.5 C in f", "5ºC em F", "...7 C to F", "1.005 C to F", "2,675 C to F",
  // Ties: Math.round goes up (-2.5 -> -2), toLocaleString rounds half away from zero (0.125 -> 0.13).
  "0.25 C to F", "-0.25 C to F", "-0.05 C to F", "125 mAh 1 V", "1 mAh 2,5 V", "1 euro vale 8 reais; 1 real", "1 euro = 8 reais, 1 real",
];
const evalQs = [...evalSet.EVAL_SET.map((q) => q.query), ...evalSet.VITALIK_SET.map((q) => q.query)];
const inputs = [...new Set([...testFiles.flatMap(literals), ...evalQs, ...edges])].filter((s) => s.length <= 300);

// Number strings for parseNumber: the tests', every number the NUM pattern finds in the inputs, and edge cases.
const NUM = /(\d{1,3}(?:[.\s]\d{3})+(?:,\d+)?|\d+(?:[.,]\d+)?)/g;
const raws = [...new Set([
  "7,5", "2.450", "1.200", "36,5", "7.5", "1,200", "18", "1,200.5", "1.200,5", "1 200", "1 200,75", "0", "00", "0,0", ".5", "5.", "", " ",
  "1.2.3", "1,2,3", "1.234.567", "1,234,567", "1,234.567", "12,3456", "12.3456", "1e3", "0x1F", "abc", "Infinity", "-5", "+5", "007", "1,000.000,5",
  ...inputs.flatMap((s) => [...s.matchAll(NUM)].map((m) => m[1])),
])];

const num = (n) => (Object.is(n, -0) ? "-0" : String(n));
// Instants across a year (every month and weekday, AM and PM) for the time and date replies.
const instants = [];
for (let m = 0; m < 12; m++) instants.push(Date.UTC(2026, m, 1 + ((m * 5) % 28), (m * 7) % 24, (m * 13) % 60));
instants.push(Date.UTC(2026, 9, 6, 3, 0), Date.UTC(2026, 9, 6, 15, 5), Date.UTC(2026, 9, 7, 2, 59), Date.UTC(2027, 0, 1, 2, 30), Date.UTC(2026, 11, 31, 14, 9));
const fixedNow = Date.UTC(2026, 9, 6, 13, 7);
const timeDateQs = ["what time is it", "Que horas são?", "what's the time now", "que hora e agora", "what day is it today?", "Que dia é hoje?", "qual é a data de hoje", "what is today's date"];

const both = (f) => inputs.flatMap((q) => [false, true].map((pt) => ({ q, pt, out: f(q, pt) })));
const golden = {
  tz: TZ,
  emergencyAnswer: both(em.emergencyNumbersAnswer),
  emergencyLine: both(em.emergencyNumbersLine),
  smallTalk: [
    ...inputs.flatMap((q) => [false, true].map((pt) => ({ q, pt, now: fixedNow, out: st.smallTalkReply(q, pt, new Date(fixedNow)) }))),
    ...timeDateQs.flatMap((q) => instants.flatMap((now) => [false, true].map((pt) => ({ q, pt, now, out: st.smallTalkReply(q, pt, new Date(now)) })))),
  ],
  englishSearchTerms: inputs.map((q) => ({ q, out: pq.englishSearchTerms(q) })),
  canonicalHealthTerms: inputs.map((q) => ({ q, out: pq.canonicalHealthTerms(q) })),
  classify: inputs.map((q) => {
    const type = cl.classifyTask(q);
    return { q, type, irrelevant: cl.isRetrievalIrrelevant(type) };
  }),
  parseNumber: raws.flatMap((raw) => [false, true].map((pt) => ({ raw, pt, out: num(ca.parseNumber(raw, pt)) }))),
  calculate: both(ca.calculate),
};

// One case per line: reviewable diffs without the size of a fully indented file.
const json =
  "{\n" +
  Object.entries(golden)
    .map(([k, v]) => `"${k}": ` + (Array.isArray(v) ? `[\n${v.map((c) => JSON.stringify(c)).join(",\n")}\n]` : JSON.stringify(v)))
    .join(",\n") +
  "\n}\n";
if (process.argv.includes("--check")) {
  const same = existsSync(outFile) && readFileSync(outFile, "utf8") === json;
  console.log(same ? "routing golden up to date" : "routing golden OUT OF DATE");
  process.exit(same ? 0 : 1);
}
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, json);
const nonNull = (a) => a.filter((c) => c.out !== null).length;
console.log(
  `wrote ${outFile}: ${inputs.length} inputs; emergency ${golden.emergencyAnswer.length}+${golden.emergencyLine.length} (${nonNull(golden.emergencyAnswer)}/${nonNull(golden.emergencyLine)} hits), ` +
    `smallTalk ${golden.smallTalk.length} (${nonNull(golden.smallTalk)} replies), ptQuery ${golden.englishSearchTerms.length}+${golden.canonicalHealthTerms.length} ` +
    `(${nonNull(golden.englishSearchTerms)}/${nonNull(golden.canonicalHealthTerms)} hits), classify ${golden.classify.length}, parseNumber ${golden.parseNumber.length}, ` +
    `calculate ${golden.calculate.length} (${nonNull(golden.calculate)} hits)`,
);
