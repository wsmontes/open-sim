import {demographicLines} from '../../presentation/demographics';
import type {Cell,CellCoord} from '../../core/model';
import {roadClassOf} from '../../core/model';
import {chunkId} from '../../core/coordinates';
import type {ClientView} from '../../client/city-client';
import {cardText} from '../../presentation/card-text';
import {TOOL_LABELS} from '../../presentation/tools';
import {saveText,statsLine} from '../../presentation/words';
import {economyPanel} from '../../presentation/words';

// The text surface draws the client's view as lines (spec 2026-10-01 §6). It is pure — a view in, strings out — so the
// terminal, a test and a log all see exactly the same city. Coordinates are relative to an origin the host chooses,
// because absolute cells of a planet-wide grid are seven-digit numbers nobody wants to type.
//
// The window follows the client camera: unless the host pins a centre (the "mapa x,y" command), it is the cell under
// the viewport centre the client reports, so moving the camera moves what the terminal prints.
export type TextFrame = {origin: CellCoord; center?: CellCoord; width: number; height: number};

const BUILDING_GLYPH: Record<string, string> = {residential: 'r', commercial: 'c', industrial: 'i', park: 'p', power: 'e'};
const ROAD_GLYPH: Record<string, string> = {street: '-', avenue: '=', highway: '#'};

// One character per cell. A built lot is a capital letter and an empty lot is the same letter in lower case: the
// difference between "zoned" and "somebody lives here" is the first thing a player wants to read off the map.
export function glyphOf(cell: Cell | null, failed = false): string {
 if (!cell) return failed ? '!' : '?';
 if (cell.building) {
  const glyph = BUILDING_GLYPH[cell.building] ?? '*';
  return cell.building === 'park' || (cell.stage ?? 0) > 0 ? glyph.toUpperCase() : glyph;
 }
 if (cell.road) return ROAD_GLYPH[roadClassOf(cell)] ?? '-';
 if (cell.terrain === 'water') return '~';
 if (cell.terrain === 'green') return '"';
 return '.';
}

export const LEGEND = '. terra  ~ água  " verde  - rua  = avenida  # estrada  R/r moradia  C/c comércio  I/i indústria  P parque  E/e usina  (minúscula = lote vazio)  + prévia  x bloqueado  ? sem mapa';

export function headerLines(view: ClientView): string[] {
 const stats = statsLine(view.stats,view.facts).map(([label, value]) => `${label} ${value}`).join(' · ');
 const tool = view.tool === 'explore' ? 'explorar' : view.tool === 'demolish' ? 'demolir' : TOOL_LABELS[view.tool].toLowerCase();
 const lines = [
  `${view.place || 'Sem lugar'} · ${stats} · Tick ${view.state?.tick ?? 0} · ${view.speed === 0 ? 'pausado' : `${view.speed}×`}`,
  `Ferramenta: ${tool}${view.preview.message ? ` · ${view.preview.message}` : ''}`,
 ];
 if (view.notice) lines.push(`Aviso: ${view.notice}`);
 if (view.map.message) lines.push(view.map.message);
 const save = saveText(view.save);
 if (save) lines.push(save);
 return lines;
}

export function mapLines(view: ClientView, frame: TextFrame): string[] {
 const marked = new Set(view.preview.cells.map(cell => `${cell.x}:${cell.y}`));
 const mark = view.preview.affordable ? '+' : 'x';
 const center = frame.center ?? view.center;
 const left = center.x - Math.floor(frame.width / 2), top = center.y - Math.floor(frame.height / 2);
 const lines: string[] = [];
 // Two ruler rows, tens over units, relative to the origin: any column can be read straight off the map and typed.
 let tens = '     ', units = '     ';
 for (let column = 0; column < frame.width; column += 1) {
  const x = left + column - frame.origin.x, digit = ((x % 10) + 10) % 10;
  tens += digit === 0 ? String(Math.floor(Math.abs(x) / 10) % 10) : ' ';
  units += String(digit);
 }
 lines.push(tens.trimEnd(), units);
 for (let row = 0; row < frame.height; row += 1) {
  const y = top + row;
  let text = '';
  for (let column = 0; column < frame.width; column += 1) {
   const x = left + column;
   if (y < 0) { text += ' '; continue; }
   const cell = {x, y};
   text += marked.has(`${x}:${y}`) ? mark : glyphOf(view.cellAt(cell), view.chunk(chunkId(cell))?.status === 'error');
  }
  lines.push(`${String(y - frame.origin.y).padStart(4, ' ')} ${text}`);
 }
 return lines;
}

export function cardLines(view: ClientView, origin: CellCoord): string[] {
 if (!view.card) return [];
 const text = cardText({x: view.card.cell.x - origin.x, y: view.card.cell.y - origin.y}, view.card.reading);
 return [`[${text.title}]`, ...text.rows.map(([label, value]) => `  ${label}: ${value}`), `  ${text.source}`];
}

// The real city under the camera, shown by the "cidade" command: what the place is, next to what the player built.
export function factsLines(view: ClientView): string[] {
 const facts = view.facts;
 if (!facts) return ['Cidade real: nenhuma fonte identificou o lugar sob a câmera.'];
 const lines = [`[${facts.label}${facts.country ? ` · ${facts.country}` : ''}]`];
 if (facts.population !== undefined) lines.push(`  População: ${facts.population.toLocaleString('pt-BR')}${facts.populationYear ? ` · ${facts.populationYear}` : ''}`);
 if (facts.areaKm2 !== undefined) lines.push(`  Área: ${facts.areaKm2.toLocaleString('pt-BR')} km²`);
 if (facts.densityPerKm2 !== undefined) lines.push(`  Densidade: ${Math.round(facts.densityPerKm2).toLocaleString('pt-BR')} hab/km²`);
 lines.push(...demographicLines(facts).map(line=>`  ${line}`));
 lines.push(`  Fonte: ${facts.source.dataset} · ${facts.source.license} · ${facts.source.url}`);
 if (view.scale) lines.push(`  ${view.scale}`);
 return lines;
}

// The economy panel, shown by "prefeitura": the same numbers the canvas HUD shows, in the same words
// (src/presentation/words.ts), so a terminal player can see tax, services, the monthly books, debt, rating, demand and
// — the reason a city stalls with the balance stuck at zero — the crisis line. Without this the terminal had no way to
// read why growth stopped; the header shows money, real population, happiness and energy.
export function prefeituraLines(view: ClientView): string[] {
 const economy = view.stats.economy;
 const lines = [`[Prefeitura de ${view.place || 'sua cidade'}]`, `  Caixa: ${view.stats.money.toLocaleString('pt-BR')}`];
 lines.push(`  Moradores do bairro simulado: ${view.stats.population.toLocaleString('pt-BR')}`);
 for (const [label, value] of economyPanel(economy)) lines.push(`  ${label}: ${value}`);
 if (economy.crisis) lines.push(`  ⚠ ${economy.crisis}`);
 return lines;
}


// comparison, if the player asked for one.
export function versionsLines(view: ClientView): string[] {
 const history = view.history;
 if (!history) return ['Versões: este host não guarda versões.'];
 const lines = [`[${history.worldId}/${history.branchId} · ${history.status}]`];
 if (view.branches && view.branches.ids.length) lines.push(`  Ramos: ${view.branches.ids.map(id => id === view.branches!.selected ? `*${id}` : id).join(', ')}`);
 for (const entry of history.entries) lines.push(`  ${entry.current ? '→' : ' '} #${entry.generation} ${entry.hash.slice(0, 7)} ${entry.label}`);
 if (history.compare) {
  lines.push(`  Comparação: ${history.compare.summary}`);
  for (const region of history.compare.regions) lines.push(`    ${region.label}`);
 }
 if (history.message) lines.push(`  ${history.message}`);
 return lines;
}

// Two futures of the place under the camera, shown by "futuros": each side's decisions and the indicators that moved.
export function scenariosLines(view: ClientView): string[] {
 const scenarios = view.scenarios;
 if (!scenarios) return ['Futuros: este host não guarda versões.'];
 if (!scenarios.a || !scenarios.b || !scenarios.comparison) return [scenarios.message || 'Sem futuros para comparar.'];
 const lines = [`[${scenarios.a.id} × ${scenarios.b.id}] ${scenarios.a.interval}`];
 lines.push(`  ${scenarios.comparison.summary}`);
 for (const row of scenarios.comparison.rows) lines.push(`  ${row.label}: ${row.a} → ${row.b} (${row.delta})`);
 for (const premise of scenarios.comparison.declared) lines.push(`  Premissa — ${premise}`);
 return lines;
}

export function renderText(view: ClientView, frame: TextFrame): string[] {
 if (!view.ready) return ['Abrindo a cidade…'];
 return [...headerLines(view), ...mapLines(view, frame), ...cardLines(view, frame.origin)];
}

// The stable reading of a view, for comparing two runs of the same playthrough: every number the player can see and
// nothing that depends on how the surface drew it.
export function transcript(view: ClientView): string {
 const stats = view.stats;
 return JSON.stringify({
  tick: view.state?.tick ?? 0,
  revision: view.state?.revision ?? 0,
  money: stats.money,
  population: stats.population,
  jobs: stats.jobs,
  happiness: stats.happiness,
  energy: [stats.energyUsed, stats.energySupply],
  tool: view.tool,
  speed: view.speed,
  place: view.place,
  facts: view.facts?.label ?? null,
  preview: {cells: view.preview.cells.length, cost: view.preview.cost, affordable: view.preview.affordable},
  notice: view.notice,
  map: view.map.message,
  card: view.card ? cardText(view.card.cell, view.card.reading).title : null,
  // The version machine's shape, deterministic because versions are content-addressed: the branch on screen, how
  // many checkpoints it has, the comparison summary and whether two futures were run.
  branch: view.history ? view.history.branchId : null,
  versions: view.history ? view.history.entries.length : null,
  compare: view.history?.compare?.summary ?? null,
  futures: view.scenarios?.comparison?.summary ?? null,
 });
}
