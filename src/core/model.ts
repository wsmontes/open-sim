export type CellCoord = { x: number; y: number };
export type Building = 'residential' | 'commercial' | 'industrial' | 'park' | 'power';
export type Tool = Building | 'road';
export type Cell = { terrain: 'land' | 'water' | 'green'; road?: boolean; building?: Building; stage?: number; origin?: 'imported' | 'player' };
export type BaseChunk = { id: string; source: string; normalizerVersion: 1; cells: Cell[] };
export type ManagedChunk = { base: BaseChunk; edits: Record<string, Cell>; baseEnergy: number; balanceAdjustment: number };
export type GameState = { formatVersion: 1; rulesVersion: 1; worldId: string; seed: number; revision: number; tick: number; money: number; chunks: Record<string, ManagedChunk>; actors: Record<string, number> };
export type Action = { type: 'build'; tool: Tool; cells: CellCoord[] } | { type: 'demolish'; cells: CellCoord[] } | { type: 'tick' };
export type Command = { version: 1; worldId: string; actorId: string; sequence: number; expectedRevision: number; action: Action };
export type CommandResult = { state: GameState; status: 'applied' | 'duplicate' | 'rejected'; reason?: string };
export type CityStats = { money: number; population: number; jobs: number; energySupply: number; energyUsed: number; happiness: number; income: number; managed: number };
export type ViewState = { x: number; y: number; zoom: number; speed: 0 | 1 | 2; place: string };
export type SavedGame = { version: 1; state: GameState; view: ViewState };
// Zoom limits of a saved view. They live in the core because the snapshot format validates them; the isometric
// camera is presentation and only reuses these numbers.
export const VIEW_ZOOM_MIN = .05, VIEW_ZOOM_MAX = 3;
export const COST: Record<Tool | 'demolish', number> = {road:10,residential:40,commercial:60,industrial:80,park:30,power:500,demolish:5};
