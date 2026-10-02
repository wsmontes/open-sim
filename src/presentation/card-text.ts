import type {CellCoord} from '../core/model';
import type {CellReading} from '../core/simulation';

// What the card about one cell says, in words, with no idea of where it will be shown. The canvas card and the text
// card print exactly this, so the two surfaces cannot describe the same house differently.
export type CardText = {title: string; rows: readonly (readonly [string, string])[]; source: string};

const KIND: Record<string, string> = {residential: 'Moradia', commercial: 'Comércio', industrial: 'Indústria', park: 'Parque', power: 'Usina'};
const ROAD: Record<string, string> = {street: 'rua', avenue: 'avenida', highway: 'estrada'};
const TERRAIN: Record<string, string> = {water: 'Água', green: 'Vegetação', land: 'Terreno'};

export function cardTitle(reading: CellReading): string {
 if (reading.building && KIND[reading.building]) {
  if (reading.stage === 0) return `${KIND[reading.building]} · lote vazio`;
  const floors = reading.stage ? ` · ${reading.stage} ${reading.stage === 1 ? 'andar' : 'andares'}` : '';
  return `${KIND[reading.building]}${floors}`;
 }
 if (reading.road) return `Rua · ${ROAD[reading.road] ?? reading.road}`;
 return TERRAIN[reading.terrain] ?? 'Terreno';
}

export function cardText(cell: CellCoord, reading: CellReading): CardText {
 // Only what is true of this cell: a house has no jobs and a shop has no residents, and a row saying "0 moradores"
 // in a factory is a row about nothing.
 const rows: (readonly [string, string])[] = [];
 if (reading.residents) rows.push(['Moradores', reading.residents.toLocaleString('pt-BR')]);
 if (reading.jobs) rows.push(['Empregos', reading.jobs.toLocaleString('pt-BR')]);
 rows.push(['Valor da terra', reading.landValue.toLocaleString('pt-BR')]);
 rows.push(['Quadra', `${cell.x}, ${cell.y}`]);
 const source = reading.origin === 'imported'
  ? 'Terreno e construção vieram do mapa (OpenStreetMap)'
  : reading.origin === 'player'
   ? 'Construído por você nesta partida'
   : 'Nada construído aqui ainda';
 return {title: cardTitle(reading), rows, source};
}
