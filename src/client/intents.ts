import type {CellCoord} from '../core/model';
import type {Speed} from '../presentation/clock';
import type {Camera} from '../presentation/camera';
import type {SelectedTool} from '../presentation/tools';
import {SELECTED_TOOLS} from '../presentation/tools';
import {isPlainObject} from '../core/guards';

// Everything a player can ask of the city, as data (spec 2026-10-01 §5.2). A surface turns a drag, a key or a typed
// line into one of these; a recorded playthrough is a list of them. Stage A is the city itself; stage B adds place and
// camera. Versions, futures and the cooperative session join the union in the later stages.
export type Intent =
 | {do: 'tool'; tool: SelectedTool}
 // Where the pointer is. Only the preview depends on it; nothing durable does.
 | {do: 'hover'; cell: CellCoord | null}
 // The cells a gesture covers so far, as the surface measured them with `src/presentation/strokes.ts`.
 | {do: 'stroke'; cells: readonly CellCoord[]}
 // Build or demolish with the tool in hand: these cells, or the current stroke when none are given.
 | {do: 'commit'; cells?: readonly CellCoord[]}
 | {do: 'cancel'}
 | {do: 'speed'; speed: Speed}
 | {do: 'policy'; tax?: number; services?: number; borrow?: number}
 // Open the card of one cell, or close it.
 | {do: 'inspect'; cell: CellCoord | null}
 // --- place and camera (stage B) --------------------------------------------------------------------------------
 // How much room the surface has to draw, in buffer pixels. The camera math and visible-region loading need it; a
 // surface reports it at start and whenever it changes. A quiet report (boot, resize) does not schedule a save.
 | {do: 'viewport'; width: number; height: number; quiet?: boolean}
 // Pan by a whole number of cells (dx, dy), the terminal's way of nudging the view.
 | {do: 'pan'; dx: number; dy: number}
 // Zoom in or out one step of the crisp ladder, keeping the world point under the centre.
 | {do: 'zoom'; direction: 1 | -1}
 | {do: 'rotate'; radians: number}
 | {do: 'north'}
 | {do: 'overview'}
 // Go to a bundled place by name; the facts panel follows.
 | {do: 'place'; name: string}
 // Go to a coordinate on the map; the client validates it and refuses off-map pairs with a message.
 | {do: 'goTo'; lat: number; lon: number}
 // Centre the camera on a given cell (what a surface sends when the player taps a region in a list).
 | {do: 'center'; cell: CellCoord; place?: string}
 // Set the camera outright. A surface that animates (the canvas) uses this with the position it reached each frame;
 // a surface that does not animate lands at the target at once. `settle` lands immediately even on an animating
 // surface — direct pointer manipulation wins over any glide. A quiet report does not schedule a save.
 | {do: 'camera'; camera: Camera; place?: string; quiet?: boolean; settle?: boolean}
 // Try the map again after a load failed.
 | {do: 'retryMap'}
 // Refresh the real-city facts for where the camera is now.
 | {do: 'facts'}
 // --- versions, history, comparison (stage C) -------------------------------------------------------------------
 // Materialize the version history for this device (generation 1 of a legacy save, or the existing head).
 | {do: 'openWorld'}
 // Save a resting point of the world under a name; the new branch does not replace the one being played.
 | {do: 'createVersion'; name: string}
 // Show a branch the device holds in the history panel.
 | {do: 'selectBranch'; branchId: string}
 // Compare the open version with another checkpoint of this branch, by a commit-hash prefix.
 | {do: 'compare'; prefix: string}
 // Produce the bytes of the open version; the client puts them in the view and the host writes the file.
 | {do: 'export'}
 // Adopt a world package a host read; a branch that already exists is refused as CONFLICT without changing anything.
 | {do: 'import'; bytes: Uint8Array}
 // Centre the camera on the region a comparison or a scenario pointed at.
 | {do: 'region'; chunkId: string}
 // --- two futures of the same place (stage D) -------------------------------------------------------------------
 | {do: 'compareFutures'}
 // --- cooperative session (stage E) -----------------------------------------------------------------------------
 // Open a session on a branch forked from the version on screen; this device becomes the host and only it ticks.
 | {do: 'openSession'}
 // Copy the invite text of the open session into the view, for the player to pass to a friend.
 | {do: 'invite'}
 // Join a session named by a pasted invite (its URI or the §23 document); this device becomes a verifying replica.
 | {do: 'join'; text: string}
 // Hand the branch to a successor the player named (an actor URI with a scheme); the host publishes the next epoch.
 | {do: 'transfer'; actor: string}
 // Pause the epoch this device orders (host only); nothing new is confirmed until a new epoch or recovery.
 | {do: 'pauseSession'}
 // Leave the session: the link drops, the clock returns to this device, and the shared work stays on its branch.
 | {do: 'leaveSession'}
 | {do: 'save'}
 | {do: 'overwriteSave'}
 // Advance logical time by whole ticks, as the clock would at speed 1 (1000 ms each). A surface with no wall clock of
 // its own — the terminal, the JSON agent — asks for ticks directly; the client runs them through the same router as
 // the clock, so no host loops `session.dispatch`. Bounded by the caller; 0 is a no-op.
 | {do: 'tick'; count: number};

export type IntentResult = {ok: boolean; message: string};

export const MAX_INTENT_TICKS = 10_000;
const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value);
const cell=(value:unknown)=>isPlainObject(value)&&Number.isSafeInteger(value.x)&&Number.isSafeInteger(value.y);
const cells=(value:unknown)=>Array.isArray(value)&&value.length<=1024&&value.every(cell);
const text=(value:unknown)=>typeof value==='string'&&value.length<=65536;
const optional=(value:unknown,check:(value:unknown)=>boolean)=>value===undefined||check(value);

// Validate the portable input boundary before any surface can mutate the player's hand or the world.
export function isIntent(value:unknown):value is Intent {
 if(!isPlainObject(value)||typeof value.do!=='string')return false;
 const v=value;
 switch(v.do){
  case 'tool':return SELECTED_TOOLS.includes(v.tool as SelectedTool);
  case 'hover':case 'inspect':return v.cell===null||cell(v.cell);
  case 'stroke':return cells(v.cells);
  case 'commit':return optional(v.cells,cells);
  case 'speed':return v.speed===0||v.speed===1||v.speed===2||v.speed===3;
  case 'policy':return Object.keys(v).every(key=>['do','tax','services','borrow'].includes(key))&&['tax','services','borrow'].every(key=>optional(v[key],finite));
  case 'viewport':return finite(v.width)&&v.width>0&&finite(v.height)&&v.height>0&&optional(v.quiet,x=>typeof x==='boolean');
  case 'pan':return finite(v.dx)&&finite(v.dy);
  case 'zoom':return v.direction===1||v.direction===-1;
  case 'rotate':return finite(v.radians);
  case 'place':case 'createVersion':return text(v.name);
  case 'goTo':return finite(v.lat)&&finite(v.lon);
  case 'center':return cell(v.cell)&&optional(v.place,text);
  case 'camera':return isPlainObject(v.camera)&&['x','y','zoom','rotation'].every(key=>finite((v.camera as Record<string,unknown>)[key]))&&(v.camera.zoom as number)>0&&optional(v.place,text)&&optional(v.quiet,x=>typeof x==='boolean')&&optional(v.settle,x=>typeof x==='boolean');
  case 'selectBranch':return text(v.branchId);
  case 'compare':return text(v.prefix);
  case 'import':return v.bytes instanceof Uint8Array&&v.bytes.byteLength<=64*1024*1024;
  case 'region':return typeof v.chunkId==='string'&&/^\d+:\d+$/.test(v.chunkId);
  case 'join':return text(v.text);
  case 'transfer':return text(v.actor);
  case 'tick':return Number.isSafeInteger(v.count)&&(v.count as number)>=0&&(v.count as number)<=MAX_INTENT_TICKS;
  case 'cancel':case 'north':case 'overview':case 'retryMap':case 'facts':case 'openWorld':case 'export':case 'compareFutures':case 'openSession':case 'invite':case 'pauseSession':case 'leaveSession':case 'save':case 'overwriteSave':return true;
  default:return false;
 }
}
