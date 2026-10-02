import type {Action,CellCoord,SavedGame} from '../../core/model';
import {chunkId,validCell} from '../../core/coordinates';
import type {CityClient} from '../../client/city-client';

// A machine's view of the city: one JSON request in, one JSON response out, over the same portable client every other
// surface uses (spec 2026-10-01 §6). It is pure — a request and a client in, a response object out — so the terminal
// host (tools/city.ts), a test and a future service all drive the identical path through the client and the core
// rules. No DOM, no Node, no network, no `session.dispatch`: the surface only parses, calls `client.do`/`client.quote`
// and reads the view.
//
// The request/response contract is the one agents already speak (it was `src/session/city-agent.ts` before the
// portable client absorbed it): the ops are inspect, quote, act, advance, save and load; every response carries `ok`,
// the current `revision` and `tick`, and either a `result` or a structured `error`.

export type CityRequest =
 | {op: 'inspect'; cell?: CellCoord}
 | {op: 'quote' | 'act'; action: Action}
 | {op: 'advance'; ticks: number}
 | {op: 'save'}
 | {op: 'load'; save: SavedGame};
export type CityErrorCode = 'INVALID_REQUEST' | 'REJECTED';
export type CityResponse =
 | {ok: true; revision: number; tick: number; result: unknown}
 | {ok: false; revision: number; tick: number; error: {code: CityErrorCode; message: string}};

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const ACTION_TYPES = ['build', 'demolish', 'policy', 'component', 'tick'];
// A tick is bounded so one request cannot wedge the agent in an unbounded loop (same ceiling the facade had).
const MAX_ADVANCE = 10000;

// One request through the client. Reads the state figures from the view the client publishes, prices with the client's
// own quote (the version's managed regions plus the detailed regions it has asked for), and advances through the
// `tick` intent, which runs the router — never a dispatch loop here.
export async function executeCityRequest(client: CityClient, raw: unknown): Promise<CityResponse> {
 const view = () => client.view();
 const stamp = () => ({revision: view().state?.revision ?? 0, tick: view().state?.tick ?? 0});
 const failure = (message: string, code: CityErrorCode = 'INVALID_REQUEST'): CityResponse => ({ok: false, ...stamp(), error: {code, message}});
 const success = (result: unknown): CityResponse => ({ok: true, ...stamp(), result});
 try {
  if (!record(raw) || typeof raw.op !== 'string') return failure('Pedido inválido');
  switch (raw.op) {
   case 'inspect': {
    if (raw.cell !== undefined && (!record(raw.cell) || !validCell(raw.cell as CellCoord))) return failure('Célula inválida');
    const current = view();
    const cell = raw.cell as CellCoord | undefined;
    return success({stats: current.stats, worldId: current.state?.worldId, ...(cell ? {cell: current.cellAt(cell)} : {})});
   }
   case 'quote':
   case 'act': {
    if (!record(raw.action) || !ACTION_TYPES.includes(String((raw.action as {type?: unknown}).type))) return failure('Ação inválida');
    const action = raw.action as Action;
    const quote = client.quote(action);
    if (raw.op === 'quote') return success(quote);
    if (quote.status === 'blocked') return failure(quote.reason ?? 'Ação recusada', 'REJECTED');
    const answer = await applyAction(client, action);
    if (!answer.ok) return failure(answer.message || 'Ação recusada', 'REJECTED');
    return success({status: 'accepted', stats: view().stats});
   }
   case 'advance': {
    if (!Number.isSafeInteger(raw.ticks) || (raw.ticks as number) < 0 || (raw.ticks as number) > MAX_ADVANCE) return failure(`Ticks devem estar entre 0 e ${MAX_ADVANCE}`);
    await client.do({do: 'tick', count: raw.ticks as number});
    await client.idle();
    return success(view().stats);
   }
   case 'save':
    return success(client.snapshot());
   case 'load': {
    // `restore` validates through `decodeSave`; an unknown version or shape throws and is reported, never adopted.
    client.restore(raw.save);
    await client.idle();
    return success({status: 'loaded'});
   }
   default:
    return failure('Operação desconhecida');
  }
 } catch (error) {
  return failure(error instanceof Error ? error.message : String(error));
 }
}

// Build/demolish go through the stroke+commit path (the surface sets the tool, hands the cells and commits), so the
// agent exercises the very intents a human surface sends. Policy is a single intent. Both land on the same router and
// the same core rules; the client's quote above already refused anything the command would.
async function applyAction(client: CityClient, action: Action): Promise<{ok: boolean; message: string}> {
 if (action.type === 'build' || action.type === 'demolish') {
  const cells = (action.cells ?? []) as readonly CellCoord[];
  await client.do({do: 'tool', tool: action.type === 'demolish' ? 'demolish' : action.tool});
  const result = await client.do({do: 'commit', cells});
  await client.do({do: 'tool', tool: 'explore'}); // leave no tool selected: the agent holds no gesture between ops
  await client.idle();
  return result;
 }
 if (action.type === 'policy') {
  const {type: _type, ...policy} = action;
  const result = await client.do({do: 'policy', ...policy});
  await client.idle();
  return result;
 }
 if (action.type === 'component') {
  // A namespaced component write has no player intent of its own; the agent submits it straight to the router.
  return {ok: false, message: 'Componente não é uma ação do agente'};
 }
 return {ok: false, message: 'Ação não suportada'};
}

// For the chunk-id of a cell, reused by a host that wants to load a region before quoting a build on it.
export const chunkOf = (cell: CellCoord): string => chunkId(cell);
