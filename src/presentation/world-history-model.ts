// The player-facing model of the local history (which version is open, whether it is saved here, the checkpoints
// behind it and a read-only comparison), without a surface. The DOM panel lives in world-history.ts; this module
// compiles without DOM, so the portable client may build the model the surfaces draw.
export type HistoryEntry = {generation:number;hash:string;label:string;current:boolean};
export type CompareOption = {hash:string;label:string};
export type CompareInfo = {summary:string;regions:readonly {id:string;label:string}[]};
export type HistoryInfo = {worldId:string;branchId:string;status:string;entries:readonly HistoryEntry[];message:string;compareOptions:readonly CompareOption[];compare:CompareInfo|null};
// The branches a device holds and which one is on screen, kept beside the info the panel renders.
export type HistoryBranches = {ids:readonly string[];selected:string};
