import type {CellCoord} from '../../core/model';
import {BORROW_MAX,SERVICES_MAX,SERVICES_MIN,TAX_MAX,TAX_MIN} from '../../core/model';
import type {Intent} from '../../client/intents';
import {beginStroke,extendStroke} from '../../presentation/strokes';
import {strokeShapeOf} from '../../presentation/tools';
import type {SelectedTool} from '../../presentation/tools';

// The text surface's input: one typed line becomes intentions (spec 2026-10-01 §6). The language is only a short way
// of writing intentions — `json {...}` writes any of them in full — so nothing a player can type is a rule of its own.
export type Parsed =
 | {intents: Intent[]; wait?: number; show?: 'help' | 'map' | 'legend' | 'facts' | 'prefeitura' | 'versions' | 'scenarios'; center?: CellCoord; exportFile?: string; importFile?: string; quit?: boolean}
 | {error: string};

// Accents are optional: a terminal keyboard should not decide whether "comércio" was understood.
const plain = (text: string) => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

const TOOL_WORDS: Record<string, SelectedTool> = {
 explorar: 'explore', rua: 'road', avenida: 'avenue', estrada: 'highway',
 casa: 'residential', moradia: 'residential', residencial: 'residential',
 comercio: 'commercial', loja: 'commercial', industria: 'industrial', fabrica: 'industrial',
 parque: 'park', usina: 'power', energia: 'power', demolir: 'demolish',
};

export const HELP = [
 'Comandos (coordenadas x,y relativas à origem do mapa):',
 '  rua|avenida|estrada|usina|demolir A [B]   constrói em linha de A até B',
 '  casa|comercio|industria|parque A [B]      constrói o retângulo de A até B',
 '  previa <ferramenta> A [B]                 mostra o custo sem construir; depois "confirmar" ou "cancelar"',
 '  ferramenta <nome>   ver x,y   fechar      escolher ferramenta, abrir e fechar o card de uma célula',
 '  vel 0|1|2|3   pausar   espera 10s|500ms|2m velocidade e passagem do tempo',
 '  imposto N   servicos N   emprestar         a prefeitura',
 '  prefeitura                                 as contas: imposto, serviços, receita, despesa, dívida, demanda, crise',
 '  ir <lugar>|ir lat,lon   mover dx,dy        viajar para um lugar, uma coordenada, ou empurrar a câmera em células',
 '  zoom +|-   norte   visao geral             aproximar/afastar, apontar ao norte, ver a cidade inteira',
 '  cidade   tentar de novo                    ver a cidade real sob a câmera; recarregar o mapa após falha',
 '  versoes   versao "nome"   ramo <nome>       ver o histórico, criar uma versão, trocar de ramo',
 '  comparar <hash>   exportar <arq>   importar <arq>   comparar versões, salvar/abrir um pacote',
 '  futuros                                    comparar dois futuros (parque × indústria) do lugar sob a câmera',
 '  sessao abrir|convite|entrar <texto>|sair|pausar|transferir <ator>   jogar junto numa versão compartilhada',
 '  salvar   sobrescrever   mapa [x,y]   legenda   json {...}   sair',
];

export function parseCell(text: string, origin: CellCoord): CellCoord | null {
 const match = /^(-?\d+)\s*,\s*(-?\d+)$/.exec(text.trim());
 if (!match) return null;
 return {x: origin.x + Number(match[1]), y: origin.y + Number(match[2])};
}

// The same geometry a canvas drag uses: a line for a street, a rectangle for a zone.
export function cellsBetween(tool: SelectedTool, from: CellCoord, to: CellCoord): CellCoord[] {
 const shape = strokeShapeOf(tool);
 return extendStroke(beginStroke(from, shape), to, shape).cells;
}

function duration(text: string): number | null {
 const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|min)?$/.exec(text.trim());
 if (!match) return null;
 const value = Number(match[1]), unit = match[2] ?? 's';
 return Math.round(unit === 'ms' ? value : unit === 's' ? value * 1000 : value * 60_000);
}

function strokeOf(tool: SelectedTool, args: readonly string[], origin: CellCoord): CellCoord[] | string {
 const from = args[0] ? parseCell(args[0], origin) : null;
 if (!from) return 'Diga onde: por exemplo "rua 2,3 8,3"';
 const to = args[1] ? parseCell(args[1], origin) : from;
 if (!to) return `Coordenada inválida: ${args[1]}`;
 return cellsBetween(tool, from, to);
}

export function parseCommand(line: string, origin: CellCoord): Parsed {
 const trimmed = line.trim();
 if (!trimmed || trimmed.startsWith('#')) return {intents: []};
 if (/^json\s/i.test(trimmed)) {
  try { return {intents: [JSON.parse(trimmed.slice(4)) as Intent]}; } catch { return {error: 'O texto depois de "json" não é JSON'}; }
 }
 // Coordinates may be written "2,3" or "2, 3": glue the pair back before splitting on spaces.
 const words = trimmed.replace(/(-?\d+)\s*,\s*(-?\d+)/g, '$1,$2').split(/\s+/);
 const head = plain(words[0]!), args = words.slice(1);
 const tool = TOOL_WORDS[head];
 if (tool && tool !== 'explore') {
  const cells = strokeOf(tool, args, origin);
  if (typeof cells === 'string') return {error: cells};
  return {intents: [{do: 'tool', tool}, {do: 'commit', cells}]};
 }
 switch (head) {
  case 'ajuda': case '?': return {intents: [], show: 'help'};
  case 'legenda': return {intents: [], show: 'legend'};
  case 'sair': return {intents: [], quit: true};
  case 'mapa': {
   if (!args[0]) return {intents: [], show: 'map'};
   const center = parseCell(args[0], origin);
   return center ? {intents: [], show: 'map', center} : {error: `Coordenada inválida: ${args[0]}`};
  }
  case 'ferramenta': {
   const chosen = args[0] ? TOOL_WORDS[plain(args[0])] : undefined;
   if (!chosen) return {error: `Ferramentas: ${Object.keys(TOOL_WORDS).join(', ')}`};
   return {intents: [{do: 'tool', tool: chosen}]};
  }
  case 'explorar': return {intents: [{do: 'tool', tool: 'explore'}]};
  case 'previa': {
   const chosen = args[0] ? TOOL_WORDS[plain(args[0])] : undefined;
   if (!chosen || chosen === 'explore') return {error: 'Diga a ferramenta: "previa rua 2,3 8,3"'};
   const cells = strokeOf(chosen, args.slice(1), origin);
   if (typeof cells === 'string') return {error: cells};
   return {intents: [{do: 'tool', tool: chosen}, {do: 'stroke', cells}]};
  }
  case 'confirmar': case 'construir': return {intents: [{do: 'commit'}]};
  case 'cancelar': return {intents: [{do: 'cancel'}]};
  case 'ver': {
   const cell = args[0] ? parseCell(args[0], origin) : null;
   return cell ? {intents: [{do: 'inspect', cell}]} : {error: 'Diga a célula: "ver 3,4"'};
  }
  case 'fechar': return {intents: [{do: 'inspect', cell: null}]};
  case 'pausar': case 'pausa': return {intents: [{do: 'speed', speed: 0}]};
  case 'vel': case 'velocidade': {
   const speed = Number(args[0]);
   return speed === 0 || speed === 1 || speed === 2 || speed === 3 ? {intents: [{do: 'speed', speed}]} : {error: 'Velocidade é 0, 1, 2 ou 3'};
  }
  case 'espera': case 'esperar': {
   const ms = args[0] ? duration(args[0]) : null;
   return ms === null ? {error: 'Diga quanto: "espera 10s", "espera 500ms", "espera 2m"'} : {intents: [], wait: ms};
  }
  case 'imposto': case 'servicos': {
   const value = Number(args[0]);
   // The bounds the world enforces, told here so the player learns the range from the hint instead of from a bare
   // "fora do intervalo" after the fact. The authoritative check stays in core; this only guides the typing.
   const [min, max, lever] = head === 'imposto' ? [TAX_MIN, TAX_MAX, 'imposto'] : [SERVICES_MIN, SERVICES_MAX, 'serviços'];
   if (!Number.isFinite(value)) return {error: `Diga o valor: "${head} ${head === 'imposto' ? 12 : 100}" (${lever} de ${min} a ${max})`};
   if (value < min || value > max) return {error: `${head === 'imposto' ? 'Imposto' : 'Serviços'} de ${min} a ${max}: ${value} está fora.`};
   return {intents: [head === 'imposto' ? {do: 'policy', tax: value} : {do: 'policy', services: value}]};
  }
  case 'emprestar': {
   const value = args[0] ? Number(args[0]) : 10_000;
   if (!Number.isSafeInteger(value) || value < 0) return {error: `Diga quanto pedir, inteiro de 0 a ${BORROW_MAX}: "emprestar 10000"`};
   if (value > BORROW_MAX) return {error: `Empréstimo até ${BORROW_MAX}: ${value} é demais.`};
   return {intents: [{do: 'policy', borrow: value}]};
  }
  case 'salvar': return {intents: [{do: 'save'}]};
  case 'sobrescrever': return {intents: [{do: 'overwriteSave'}]};
  case 'ir': {
   // "ir -23.55,-46.63" is a coordinate; anything else is a place name, which may have spaces ("ir São Paulo").
   const joined = args.join(' ').trim();
   if (!joined) return {error: 'Diga para onde: "ir Lisboa" ou "ir -23.55,-46.63"'};
   const coord = /^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/.exec(joined.replace(/\s+/g, ''));
   if (coord) return {intents: [{do: 'goTo', lat: Number(coord[1]), lon: Number(coord[2])}]};
   return {intents: [{do: 'place', name: joined}]};
  }
  case 'mover': {
   const match = args[0] ? /^(-?\d+)\s*,\s*(-?\d+)$/.exec(args[0].trim()) : null;
   if (!match) return {error: 'Diga quanto mover em células: "mover 4,0" ou "mover -2,3"'};
   return {intents: [{do: 'pan', dx: Number(match[1]), dy: Number(match[2])}]};
  }
  case 'zoom': {
   const sign = args[0];
   if (sign === '+' || plain(sign ?? '') === 'mais') return {intents: [{do: 'zoom', direction: 1}]};
   if (sign === '-' || plain(sign ?? '') === 'menos') return {intents: [{do: 'zoom', direction: -1}]};
   return {error: 'Diga a direção: "zoom +" ou "zoom -"'};
  }
  case 'norte': return {intents: [{do: 'north'}]};
  case 'visao': case 'visão': {
   if (plain(args[0] ?? '') === 'geral') return {intents: [{do: 'overview'}]};
   return {error: 'Para ver a cidade inteira: "visao geral"'};
  }
  case 'tentar': {
   // "tentar de novo": reload the map after a failure.
   if (plain(args.join(' ')) === 'de novo' || !args.length) return {intents: [{do: 'retryMap'}]};
   return {error: 'Para recarregar o mapa: "tentar de novo"'};
  }
  case 'cidade': return {intents: [], show: 'facts'};
  case 'prefeitura': case 'economia': return {intents: [], show: 'prefeitura'};
  // --- versions, history, comparison (stage C) and two futures (stage D) ---------------------------------------
  case 'versoes': case 'versões': return {intents: [{do: 'openWorld'}], show: 'versions'};
  case 'versao': case 'versão': {
   // The name may be quoted ("praça central") or a single word; a version always needs a name.
   const name = /^"(.*)"$/.exec(args.join(' ').trim())?.[1] ?? args.join(' ').trim();
   if (!name) return {error: 'Diga o nome da versão: versao "praça central"'};
   return {intents: [{do: 'createVersion', name}], show: 'versions'};
  }
  case 'ramo': {
   const branchId = args.join(' ').trim();
   if (!branchId) return {error: 'Diga o ramo: ramo experimento'};
   return {intents: [{do: 'selectBranch', branchId}], show: 'versions'};
  }
  case 'comparar': {
   const prefix = args[0]?.trim();
   if (!prefix) return {error: 'Diga o prefixo do hash ou "anterior": comparar 1a2b3c'};
   return {intents: [{do: 'compare', prefix: plain(prefix) === 'anterior' ? 'anterior' : prefix}], show: 'versions'};
  }
  case 'exportar': {
   const file = args.join(' ').trim();
   if (!file) return {error: 'Diga o arquivo: exportar cidade.json'};
   return {intents: [], exportFile: file};
  }
  case 'importar': {
   const file = args.join(' ').trim();
   if (!file) return {error: 'Diga o arquivo: importar cidade.json'};
   return {intents: [], importFile: file};
  }
  case 'futuros': return {intents: [{do: 'compareFutures'}], show: 'scenarios'};
  // --- cooperative session (stage E) ---------------------------------------------------------------------------
  case 'sessao': case 'sessão': {
   const sub = plain(args[0] ?? '');
   const rest = args.slice(1).join(' ').trim();
   if (sub === 'abrir') return {intents: [{do: 'openSession'}]};
   if (sub === 'convite') return {intents: [{do: 'invite'}]};
   if (sub === 'entrar') {
    if (!rest) return {error: 'Cole o convite: sessao entrar <texto>'};
    return {intents: [{do: 'join', text: rest}]};
   }
   if (sub === 'sair') return {intents: [{do: 'leaveSession'}]};
   if (sub === 'pausar' || sub === 'pausa') return {intents: [{do: 'pauseSession'}]};
   if (sub === 'transferir') {
    if (!rest) return {error: 'Diga o sucessor: sessao transferir nostr:npub1… ou local:<chave>'};
    return {intents: [{do: 'transfer', actor: rest}]};
   }
   return {error: 'Sessão: sessao abrir | convite | entrar <texto> | sair | pausar | transferir <ator>'};
  }
 }
 return {error: `Não entendi "${words[0]}". Digite "ajuda".`};
}
