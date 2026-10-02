# OpenSim: coherent mobile presentation and local map streaming

Status: proposed for user review; no implementation changes yet.
Baseline: d262e80, inspected 2026-10-02.

## Intended outcome

OpenSimCity should feel like a polished classic city builder on phones and desktops. Navigation must respond immediately, preserve the place being observed, and progressively improve locally available geography. The browser and an AI terminal client must operate the same simulation rules. The reusable product is a toolkit for games based on real observations, following the attached OpenSim 0.1 protocol, rather than a browser-specific city simulation.

Success means stable pinch and resize, upright buildings during bearing changes, uninterrupted map coverage during upgrades, useful background downloads, understandable offline coverage, and fewer duplicated responsibilities. A lower line count is an outcome of removing duplication, not permission to remove interoperability or durable world history.

## Findings in the current implementation

- `src/presentation/camera.ts` rotates already projected screen coordinates. `canvas-renderer.ts` applies a rotation to the entire drawing context. Building elevations therefore rotate too: this is screen roll rather than an orbit with fixed inclination.
- `src/session/local-session.ts` replaces a ready overview chunk with `{status:'loading'}` during a detail request. `canvas-renderer.ts` only renders a base when status is ready. Available terrain disappears during enrichment.
- `src/browser/main.ts` restores camera x/y pixel offsets without the previous viewport dimensions. A saved camera is not a portable geographical viewpoint. Resize also rounds the world centre through `pick()`.
- Pinch retains an independent camera reference, while resize can change the buffer coordinate system. Pointer cancellation uses the pointer-up handler, and the transition from two fingers to one does not rebase the remaining drag. These paths need direct regression coverage before assigning exact blame for the reported gesture drift.
- Map persistence already exists at raw vector tile and normalized chunk levels. Decoder reuse and a worker already exist. Replace coordination, not these useful mechanisms.
- Detail enrichment only runs when the visible chunk count is at most 12. Loading budgets operate on normalized chunks; network units are shared vector tiles. This prevents the expected region-wide preparation at wide zooms.
- The browser entry point owns navigation, loading decisions, UI orchestration, city lookup, persistence coordination, composition and networking. Extract responsibilities through actual dependency boundaries rather than splitting it into arbitrary files.
- Source TypeScript is approximately 19,298 lines; tests approximately 13,041. Pure core, ports, adapters and profiles already exist. The terminal explorer proves a second profile but is not by itself a complete interactive city-balancing client.

## Options and recommendation

1. Patch current handlers: smallest change, but preserves distributed navigation/loading ownership and repeated failures.
2. Replace the engine/rendering stack: potentially capable, but adds dependencies and migration risk without fixing data ownership.
3. Recommended: retain the pure simulation, world semantics and existing adapters; replace presentation coordination with explicit viewpoint, streaming and shell boundaries. Remove superseded code as each replacement is verified.

## Boundaries and contracts

### Viewpoint and input

A viewpoint is a continuous world centre, zoom and bearing. Pixels and viewport dimensions are transient renderer inputs. One projection and its inverse serve rendering, picking, culling and gestures. Bearing rotates the ground plane before fixed isometric projection; elevation remains screen-vertical. Painter ordering follows rotated ground depth. The renderer must not rotate the complete canvas.

Persist geographic/world centre rather than screen translation. Preserve old saves by deriving a safe centre from available legacy information and managed geography; never silently overwrite a world because its viewpoint is old. Unknown protocol fields remain preserved.

Input is a small explicit state machine: idle, pan, stroke and two-pointer navigation. Gestures keep a continuous world point under their anchor. Pointer count changes and buffer resize rebase input. Cancellation clears previews and never commits a stroke. Viewpoint changes update rendering immediately without waiting for persistence or network.

### Map streaming

Separate available representation from pending enrichment and errors. A failed or pending upgrade keeps the last good base visible. Building and command quotes still require detail; an overview must never become authoritative simulation input.

A single streaming coordinator accepts the current world footprint and produces prioritized demand: visible missing coverage, visible detail, nearby predicted coverage, and idle region preparation. Deduplicate network work by provider/version/zoom/tile. Bound concurrency and memory; foreground work gets priority over queued preparation. Coalesce demand changes and discard obsolete publication without discarding useful persisted bytes.

Keep raw tiles persistent, normalized chunks reusable, and decoded tiles bounded in memory. Prepare source resolutions actually supported by the current provider (z11 overview and z14 detail), not invented resolutions for every zoom step: most screen zooms reuse the same vectors. Track download bytes, successful persistent coverage and errors separately from in-memory rendering status.

Define region preparation by explicit bounds and a byte budget. Automatically prepare a nearby ring while idle; provide a city/region offline action with progress, pause/resume and cancellation. Do not claim an entire Vancouver download has completed merely because it was viewed for two minutes. Completion requires durable assets for the declared bounds and supported levels. Regions already prepared must reopen without map network access; application assets also need an offline boot strategy.

### Application and presentation shell

The browser entry point becomes a composition root wiring session, viewpoint, streaming and UI controllers. City facts, history/composition and multiplayer retain dedicated controllers. Shared contracts belong to their owning subsystem, never in the HTML shell. A new real-data adapter supplies observations/provenance through existing world ports; it does not know canvas or DOM.

Use classes only when lifecycle/state ownership makes them helpful. Stateless transformations remain functions. Avoid a universal plugin bus, class inheritance tree or generic abstractions without multiple real consumers.

### Interface

Keep the classic isometric city and restrained visual style. Establish shared colour, spacing, typography and interaction tokens. Show location, budget, population and time in a compact top bar; tools in a thumb-accessible dock; secondary functions in one consistent sheet pattern. Keep the map dominant. Show offline preparation and failures in a concise status surface. Phone portrait/landscape, safe areas, long labels, keyboard focus and touch targets are acceptance cases.

### AI and terminal

Use the same command validation, quotes, tick advancement, snapshots and observations in browser and Node. Audit the existing recent terminal work before adding a runner. Fill actual gaps with a machine-readable city interface: inspect state/cells, quote, act, advance ticks, save/load and report structured rejections. Rendering, DOM, city lookup and networking must not enter the simulation core. Reusable scripted scenarios measure solvency, population, blocked actions and reproducibility, giving agents evidence about gameplay rather than screenshot-only testing.

## Implementation sequence

1. Record baseline checks and reproduce viewpoint, rotation, upgrade and gesture failures with small meaningful tests.
2. Establish portable viewpoint and common projection/inverse; migrate saved views and render ground bearing with upright elevation.
3. Establish input state transitions and immediate camera updates using that projection.
4. Preserve available map data during upgrades, then introduce streaming priorities and persistent region preparation.
5. Extract browser controllers and delete superseded coordination; simplify UI around shared patterns.
6. Verify existing terminal coverage and expose missing city operations through the same application contracts.
7. Exercise mobile, offline reopening, navigation, replay and terminal gameplay; document concrete results and remaining limits.

No multiplayer transport rewrite or new game genre is included. Existing Nostr, Matrix, world composition and protocol compatibility remain exercised by their existing checks.

## Verification and review evidence

Use parameterized projection round-trip and anchored-navigation checks across bearings, viewport sizes and zooms. Test the input state machine at pointer transitions and cancellation, plus a browser gesture exercise. Test streaming with deferred fake providers: retained fallback, upgrade failure, deduplication, foreground priority and durable offline reads. Run existing type checks, build, replay and affected world/protocol checks. Use shared port contract tests where implementations truly have identical semantics; retain independent domain tests where invariants differ.

Measure before/after warm startup, map requests on revisits, frame cost while navigating, cache bytes and source footprint. Do not promise a frame-rate or city download time without device/network evidence. Inspect the actual rendered mobile UI before declaring the visual work done.

## Review decision

This document proposes an architectural replacement of presentation coordination while preserving the simulation and interoperable world foundation. Implementation is pending the user's review of this concrete design.
