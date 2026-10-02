export type CellCoord = { x: number; y: number };
export type Building = 'residential' | 'commercial' | 'industrial' | 'park' | 'power';
// Roads are not one thing. A street is where the city lives, an avenue is where it is taller and busier, and a
// highway carries the traffic a street cannot — for a price in money, in upkeep and in the quiet of the streets it
// runs through. The class is also what a real map already knows: OSM calls them motorway, primary, residential.
export type RoadClass = 'street' | 'avenue' | 'highway';
export type Tool = Building | 'road' | 'avenue' | 'highway';
export const ROAD_CLASS: Record<RoadClass,{cost:number;upkeep:number;height:number}> = {
 // `height` is how tall a building may grow facing this road: nothing along a highway, three floors along an avenue.
 street:{cost:10,upkeep:1,height:2},
 avenue:{cost:25,upkeep:2,height:3},
 highway:{cost:60,upkeep:4,height:1},
};
// `roadClass` is absent for a street, and that is on purpose: every map imported and every save written before the
// classes existed is a map of streets, so it still loads, still hashes the same and still plays.
export type Cell = { terrain: 'land' | 'water' | 'green'; road?: boolean; roadClass?: RoadClass; building?: Building; stage?: number; origin?: 'imported' | 'player' };
export const roadClassOf = (cell: Cell): RoadClass => cell.roadClass ?? 'street';
export const isRoadTool = (tool: Tool): tool is 'road' | 'avenue' | 'highway' => tool === 'road' || tool === 'avenue' || tool === 'highway';
// The tool is called `road` because that is the word the player's button has always used; the class it builds is a
// street. Keeping the two names apart here is what lets the older name stay valid everywhere else.
export const roadToolClass = (tool: 'road' | 'avenue' | 'highway'): RoadClass => tool === 'road' ? 'street' : tool;
export type BaseChunk = { id: string; source: string; normalizerVersion: 1; cells: Cell[] };
export type ManagedChunk = { base: BaseChunk; edits: Record<string, Cell>; baseEnergy: number; balanceAdjustment: number };
// Namespaced components: the city profile writes its own state directly, and other profiles (a life simulator, a
// driving game) attach theirs under a namespace this client does not have to understand. See docs/world-protocol.md.
export type Components = Record<string, Record<string, unknown>>;
// The two versions every saved world carries. `formatVersion` is how the state is written down; `rulesVersion` is what
// the simulation means by it, and it changes whenever a world saved before would behave differently today: the economy
// earns and spends, and growth follows demand, since version 2.
export const FORMAT_VERSION = 1;
export const RULES_VERSION = 3;
export type VersionedState = { formatVersion: number; rulesVersion: number };
export type GameState = { formatVersion: 1; rulesVersion: 3; worldId: string; seed: number; revision: number; tick: number; money: number; chunks: Record<string, ManagedChunk>; actors: Record<string, number>; components: Components };
export type Action =
 | { type: 'build'; tool: Tool; cells: CellCoord[] }
 | { type: 'demolish'; cells: CellCoord[] }
 | { type: 'tick' }
 | { type: 'component'; key: string; entity: string; value: unknown }
 // The city's own levers. They cost nothing to move and they are the only way a player touches the books without
 // knowing the shape of the state: a loan is money *and* debt, and the range is checked here rather than clamped
 // quietly later. Like any other decision it travels as a command, with a revision and an author behind it.
 | { type: 'policy'; tax?: number; services?: number; borrow?: number };
export type Command = { version: 1; worldId: string; actorId: string; sequence: number; expectedRevision: number; action: Action };
export type CommandResult = { state: GameState; status: 'applied' | 'duplicate' | 'rejected'; reason?: string };
// The three demands the player moves, in the genre's own vocabulary: what the city is short of, not what it has.
export type Demand = {residential: number; commercial: number; industrial: number};
// One month of the city's books, in the same shape a municipal balance shows them: what came in, what went out, what
// is left. `net` is what the treasury feels.
export type MonthlyLedger = {revenue: number; expense: number; net: number};
// What the screen needs to explain the economy without the player reading a manual. Every number here is a
// consequence of something the player did — the rule the whole model is written under.
export type CityEconomy = {
 taxPercent: number;
 // What the slider says (the budget, 50–150% of the standard) and what it buys (the level the model uses, ~0.25–2.25).
 servicesPercent: number;
 serviceLevel: number;
 demand: Demand;
 landValueAverage: number;
 monthly: MonthlyLedger;
 debt: number;
 interestRate: number;
 rating: 'A' | 'B' | 'C' | 'D';
 crisis: string | null;
};
export const EMPTY_ECONOMY: CityEconomy = {
 taxPercent: 9,
 servicesPercent: 100,
 serviceLevel: 1,
 demand: {residential: 0, commercial: 0, industrial: 0},
 landValueAverage: 0,
 monthly: {revenue: 0, expense: 0, net: 0},
 debt: 0,
 interestRate: 3.5,
 rating: 'A',
 crisis: null,
};
export type CityStats = { money: number; population: number; jobs: number; energySupply: number; energyUsed: number; happiness: number; income: number; managed: number; economy: CityEconomy };
export type ViewState = { x: number; y: number; zoom: number; speed: 0 | 1 | 2; place: string; rotation?: number; center?: {x:number;y:number} };
export type SavedGame = { version: 1; state: GameState; view: ViewState };
// Zoom limits of a saved view. They live in the core because the snapshot format validates them; the isometric
// camera is presentation and only reuses these numbers.
export const VIEW_ZOOM_MIN = .05, VIEW_ZOOM_MAX = 3;
// What the player's levers accept. They are checked when a command is applied and they are the bounds the screen
// offers, so a slider can never propose a value the world would refuse.
export const TAX_MIN = 0, TAX_MAX = 20, TAX_DEFAULT = 9;
export const SERVICES_MIN = 50, SERVICES_MAX = 150, SERVICES_DEFAULT = 100;
export const BORROW_STEP = 10_000, BORROW_MAX = 100_000;
// One price list, so the button, the preview and the command can never disagree: the road prices come from the class
// table above and the rest are the buildings' own.
export const COST: Record<Tool | 'demolish', number> = {
 road:ROAD_CLASS.street.cost,avenue:ROAD_CLASS.avenue.cost,highway:ROAD_CLASS.highway.cost,
 residential:40,commercial:60,industrial:80,park:30,power:500,demolish:5,
};
