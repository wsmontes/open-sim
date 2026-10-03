import type {MunicipalCalibration} from '../core/municipal-calibration';
import type {CellCoord} from '../core/model';
import type {Speed} from '../presentation/clock';
import type {Camera} from '../presentation/camera';
import type {SelectedTool} from '../presentation/tools';

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
 | {do:'municipal-calibration';calibration:MunicipalCalibration|null}
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
