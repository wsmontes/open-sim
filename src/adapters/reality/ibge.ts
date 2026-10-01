// Real municipal figures for Brazil, from the institute that publishes the census. Wikidata answers "how many people
// live in this city, according to this year"; IBGE answers the same question for the country it is the authority on,
// and adds the two numbers a game about a city's books wants and Wikidata does not carry: how densely people live and
// what the municipality produces. The rules are the ones this project applies to every source (docs/world-protocol.md):
// a value nobody stated stays absent — never a zero — the year travels with the number, and a source that fails leaves
// the game without the figure instead of with an invented one.
//
// Two details were measured against the live API rather than assumed: the aggregate 4714 answers population (93), area
// (6318) and density (614) in one call, and the endpoint that would turn a coordinate into a municipality does not
// exist (404), which is why the join runs through the municipal code Wikidata carries (property P1585) instead of
// through a name two cities can share.
export type MunicipalFacts = {
 id: string;
 population?: number;
 populationYear?: number;
 areaKm2?: number;
 densityPerKm2?: number;
 gdpThousandsBrl?: number;
 gdpYear?: number;
 source: {dataset: string; url: string; license: string};
};
export type IbgeOptions = {
 fetcher?: typeof fetch;
 endpoint?: string;
 timeoutMs?: number;
 userAgent?: string;
};
const ENDPOINT = 'https://servicodados.ibge.gov.br/api/v3/agregados';
const DATASET = 'IBGE';
const LICENSE = 'dados abertos IBGE (Citação: IBGE, Censo Demográfico 2022)';
const USER_AGENT = 'open-sim/0.1 (+https://github.com/wsmontes/open-sim)';
// One request at a time with a gap: a session asks once, and being a polite caller is cheaper than being throttled.
const MIN_GAP_MS = 120;
const POPULATION_YEAR = 2022;
const GDP_YEAR = 2021;
// The variables this adapter reads, by the names IBGE gives them.
const POPULATION = '93';
const AREA = '6318';
const DENSITY = '614';
const GDP = '37';

type Series = Record<string, string>;
type AggregateVariable = {id: string; resultados?: {series?: {serie?: Series}[]}[]};

const number = (value: string | undefined): number | null => {
 if (value === undefined || value === '' || value === '...' || value === '-' || value === '..') return null;
 const parsed = Number(value);
 return Number.isFinite(parsed) ? parsed : null;
};
// The newest year a variable reports, with the year it belongs to: a figure without its date is a figure that will be
// compared to next year's by mistake.
const newest = (variable: AggregateVariable | undefined): {value: number; year: number} | null => {
 const series = variable?.resultados?.[0]?.series?.[0]?.serie;
 if (!series) return null;
 let best: {value: number; year: number} | null = null;
 for (const [year, raw] of Object.entries(series)) {
  const parsed = number(raw);
  if (parsed === null) continue;
  const when = Number(year.slice(0, 4));
  if (!Number.isInteger(when)) continue;
  if (!best || when > best.year) best = {value: parsed, year: when};
 }
 return best;
};

export interface MunicipalDirectory {
 byMunicipalCode(code: string): Promise<MunicipalFacts | null>;
}

export function createIbgeDirectory(options: IbgeOptions = {}): MunicipalDirectory {
 const fetcher = options.fetcher ?? fetch;
 const endpoint = options.endpoint ?? ENDPOINT;
 const timeoutMs = options.timeoutMs ?? 20000;
 const userAgent = options.userAgent ?? USER_AGENT;
 const answers = new Map<string, MunicipalFacts | null>();
 let chain: Promise<unknown> = Promise.resolve();
 let lastCall = 0;
 const get = async (url: string): Promise<unknown | null> => {
  const run = async () => {
   const wait = Math.max(0, MIN_GAP_MS - (Date.now() - lastCall));
   if (wait) await new Promise(resolve => setTimeout(resolve, wait));
   lastCall = Date.now();
   const abort = new AbortController();
   const timer = setTimeout(() => abort.abort(), timeoutMs);
   try {
    const response = await fetcher(url, {headers: {accept: 'application/json', 'user-agent': userAgent}, signal: abort.signal});
    if (!response.ok) return null;
    return await response.json();
   } catch {
    // A source that fails, times out or answers garbage leaves the game without the number.
    return null;
   } finally {
    clearTimeout(timer);
   }
  };
  const queued = chain.then(run, run);
  chain = queued.then(() => undefined, () => undefined);
  return queued;
 };
 const variables = (payload: unknown, id: string): AggregateVariable | undefined =>
  Array.isArray(payload) ? (payload as AggregateVariable[]).find(entry => entry?.id === id) : undefined;
 return {
  async byMunicipalCode(code: string): Promise<MunicipalFacts | null> {
   if (!/^\d{7}$/.test(code)) return null;
   const cached = answers.get(code);
   if (cached !== undefined) return cached;
   const place = `N6[${code}]`;
   const census = await get(`${endpoint}/4714/periodos/${POPULATION_YEAR}/variaveis/${POPULATION}|${AREA}|${DENSITY}?localidades=${place}`);
   const population = newest(variables(census, POPULATION));
   const area = newest(variables(census, AREA));
   const density = newest(variables(census, DENSITY));
   // The census is the reason this adapter exists: without a population there is nothing to add to what Wikidata said.
   if (!population) {
    answers.set(code, null);
    return null;
   }
   // The municipal product is a second question, and a failure there is not a failure of the first: the books of the
   // game lean on it, so it is worth asking, and the facts are honest without it.
   const product = await get(`${endpoint}/5938/periodos/${GDP_YEAR}/variaveis/${GDP}?localidades=${place}`);
   const gdp = newest(variables(product, GDP));
   const facts: MunicipalFacts = {
    id: code,
    population: population.value,
    populationYear: population.year,
    ...(area ? {areaKm2: area.value} : {}),
    ...(density ? {densityPerKm2: density.value} : {}),
    ...(gdp ? {gdpThousandsBrl: gdp.value, gdpYear: gdp.year} : {}),
    source: {dataset: DATASET, url: `https://servicodados.ibge.gov.br/api/v3/agregados/4714/localidades/${code}`, license: LICENSE},
   };
   answers.set(code, facts);
   return facts;
  },
 };
}
