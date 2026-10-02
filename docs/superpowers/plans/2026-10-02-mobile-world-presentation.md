# Mobile World Presentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking. Execution: native implementation in this session, approved by the user.

**Goal:** Make OpenSimCity navigation coherent, progressive and locally reusable while keeping the browser and terminal on the same simulation.

**Architecture:** Preserve core/world/profile rules and existing adapters. Centralize viewpoint and map demand ownership; retain good geography during enrichment. Extract controllers from the browser composition root and reuse application contracts for a terminal city client.

**Tech Stack:** TypeScript, Canvas 2D, IndexedDB, module workers, Vite, Vitest, Node/tsx; no replacement engine dependency.

**Spec:** `docs/superpowers/specs/2026-10-02-mobile-world-presentation-design.md` (approved).

## Global Constraints

- Preserve unknown protocol fields, durable history, existing saves and OpenSim 0.1 semantics.
- Overview geography cannot become authoritative simulation input.
- Prepare only provider-supported z11 overview and z14 detail; screen zoom does not require a new source resolution.
- View changes must not wait for network or persistence; failed upgrades retain available terrain.
- Keep core/world/profile independent of DOM and browser adapters.
- Do not rewrite multiplayer transports or introduce a new game genre.
- Prefer shared contract tests and meaningful invariants; remove superseded production code.

## Review Focus

- A legacy save opened on a differently sized phone must locate its managed geography safely (Task 1).
- Releasing one pinch finger, adding a third, or cancelling input must not jump or build (Task 2).
- A stale background response or rejected upgrade must not erase newer visible data (Task 3).
- Storage failure must not report offline readiness or prevent in-memory play (Task 4).
- Offline boot and malformed terminal requests must produce usable, honest results (Tasks 4 and 6).

## File ownership

- `presentation/camera.ts`: projection/inverse and ground bearing, retaining compatible exports during migration.
- New `presentation/viewpoint.ts`: portable centre, persistence conversion and viewport adaptation.
- `presentation/input.ts`: input state transitions and gesture anchors.
- `presentation/canvas-renderer.ts`: fixed inclination, upright elevation and depth ordering.
- `session/local-session.ts`, `session/ports.ts`: available base versus pending map requests.
- New `session/map-streaming.ts`: platform-independent prioritized map demand.
- `adapters/osm/provider.ts`: deduplicated source tile retrieval and supported-level metadata.
- New `adapters/osm/region-cache.ts`: bounded persistent region preparation and coverage.
- New `browser/map-controller.ts`, `browser/city-controller.ts`: browser lifecycle wiring and city facts.
- `browser/main.ts`: composition root; `presentation/hud.ts`, `browser/style.css`, `index.html`: consistent shell.
- New `session/city-agent.ts`, `tools/city.ts`: common machine-readable city operations and Node I/O.
- New `public/sw.js` and browser offline registration: same-origin application asset caching.

### Task 1: Portable viewpoint and upright bearing

**Files:** camera, renderer, core/model, core/snapshot, browser/main; new viewpoint module; tests/coordinates.test.ts, tests/snapshot.test.ts, new tests/viewpoint.test.ts.
**Interfaces:** `Viewpoint={center:Point;zoom:number;rotation:number}`; `cameraFor(view:Viewpoint,viewport:Viewport):Camera`; `viewpointOf(camera:Camera,viewport:Viewport):Viewpoint`. Persist optional `center:{x:number;y:number}` in ViewState while retaining legacy x/y.

- [x] Add parameterized projection/inverse checks at rotation 0, ±π/2 and π, zoom .05/1/3 and portrait/landscape viewports. Assert inverse precision and stationary centre through zoom/resize.
- [x] Add legacy-save and unknown-field preservation cases; assert a new saved centre survives viewport changes and legacy recovery lands in managed geography.
- [x] Run targeted checks and record failures before implementation.
- [x] Rotate world ground coordinates before isometric projection; update inverse and anchors through shared helpers. Draw elevation vertically; order cells by transformed depth and update coarse polygons/culling consistently.
- [x] Implement viewpoint conversion and save validation; wire restoration/resize without integer rounding or pixel-size dependence.
- [x] Run targeted tests, typecheck and inspect a rotated render with upright buildings; commit the independently working change.

### Task 2: Gesture lifecycle

**Files:** presentation/input.ts, browser/main.ts; tests/input.test.ts.
**Interfaces:** preserve InputCallbacks and InputContext; use continuous projection/inverse from Task 1. Add `onViewportChange()` only if required by explicit input lifecycle ownership.

- [x] Add gesture assertions: the world point under the midpoint remains there throughout pinch; two-to-one pointer transition rebases pan; third pointer does not corrupt anchor; cancellation commits zero cells; resize during a gesture does not jump.
- [x] Run input tests and record expected failures.
- [x] Replace overlapping gesture bookkeeping with explicit idle/pan/stroke/two-pointer states. Separate cancellation from release, rebase when pointer membership or buffer dimensions change, and keep gesture zoom unsnapped.
- [x] Run input/coordinate tests and verify immediate camera updates do not invoke network synchronously; commit.

### Task 3: Progressive map coordination

**Files:** session/ports.ts, session/local-session.ts, new session/map-streaming.ts, browser/main.ts, new browser/map-controller.ts, presentation/canvas-renderer.ts; tests/session.test.ts, tests/map-provider.test.ts, new tests/map-streaming.test.ts.
**Interfaces:** ready ChunkStatus retains `base`/`level` and can report `upgrading?:MapLevel` and `upgradeError?:string`. `createMapStreaming(config)` exposes `updateDemand({visible,nearby,detail}):void`, `subscribe(listener):()=>void`, `idle():Promise<void>`, `destroy():void`; platform scheduling is injected through config.

- [x] With deferred MapSource promises, assert overview remains readable during detail loading/failure, newer detail cannot be replaced by late overview, and duplicate demand produces one load.
- [x] Assert queued visible work outranks background work, obsolete demand cannot publish stale UI state, and eviction protects managed/visible chunks.
- [x] Run tests and record failures.
- [x] Keep good bases in local-session during enrichment; isolate request state and tickets. Implement coalesced demand and foreground-first queues with bounded concurrent jobs, reusing provider tile deduplication.
- [x] Move loadVisible, enrichment scheduling and loading-status ownership out of main into map-controller; remove old duplicate orchestration.
- [x] Run affected session/provider/renderer tests and check overview upgrades without blank terrain; commit.

### Task 4: Persistent region preparation and offline boot

**Files:** adapters/osm/provider.ts, tile-cache.ts, new region-cache.ts, browser/map-controller.ts, public/sw.js, browser/main.ts, vite.config.ts; tests/osm-cache.test.ts, new tests/region-cache.test.ts.
**Interfaces:** `RegionRequest={bounds:{west:number;south:number;east:number;north:number};levels:MapLevel[];maxBytes:number}`. `prepareRegion(request,onProgress,signal):Promise<RegionCoverage>`; coverage reports stored/required tiles, bytes, completion and failures. Resume derives missing assets from persistence, never an optimistic counter.

- [x] Assert tile enumeration handles negative longitude, wrapped bounds and supported levels without duplicate fetches.
- [x] Assert persistent coverage completes only after writes succeed, quotas/fetch failures remain incomplete, pause/cancel stop queued jobs, and resume fetches only missing tiles.
- [x] Run tests and record failures.
- [x] Implement bounded nearby preparation on idle and explicit region preparation with progress/cancellation, foreground priority and byte budget. Keep network units separate from normalized render chunks.
- [x] Cache versioned same-origin application assets for offline reopening, respecting Vite base paths; avoid caching remote failures as successful data.
- [x] Run cache tests and a browser experiment: prepare declared bounds, disconnect, reload app and navigate through the prepared area. Record actual coverage and limitations; commit.

### Task 5: Consistent shell and browser composition root

**Files:** browser/main.ts, new browser/city-controller.ts, presentation/hud.ts, browser/style.css, index.html; tests/hud.test.ts, tests/architecture.test.ts.
**Interfaces:** city controller exposes selected facts and lookup lifecycle through callbacks; map controller owns coverage/progress from Tasks 3–4. HUD remains a view with callbacks, not a network consumer.

- [x] Add shared HUD behaviour assertions for opening/closing sheets, focus return and offline progress; use the same cases across compact/wide layout modes.
- [x] Run relevant tests and record missing behaviour.
- [x] Extract city lookup/fact publication from main; standardize shared panel behaviour and remove superseded helpers. Keep history/composition/multiplayer semantics intact.
- [x] Apply common spacing/colour/type tokens, compact vitals and thumb-accessible tools. Expose region preparation through the existing location sheet and concise status surface.
- [x] Render and inspect portrait, landscape and desktop layouts, long labels and safe-area spacing; run HUD and architecture tests, then commit.

### Task 6: City operations accessible to agents

**Files:** new session/city-agent.ts, tools/city.ts, package.json, docs/implementation.md; new tests/city-agent.test.ts; existing replay and multiplayer tests.
**Interfaces:** `CityAgentRequest` is a tagged union for inspect, quote, act, advance, save and load; `executeCityRequest(session:LocalSession,request:CityAgentRequest):Promise<CityAgentResponse>`. Responses contain state revision, operation result and structured failures. Node file/stdin handling lives only in tools/city.ts.

- [x] Audit available replay/explorer operations; reuse rather than duplicate command validation and snapshot logic.
- [x] Add a reusable scenario that quotes/builds, changes policy, advances ticks, saves/reopens and compares durable state with direct core replay.
- [x] Add invalid/malformed request assertions: no mutation, bounded tick advancement and structured rejection; run tests to record failures.
- [x] Implement the application facade with existing LocalSession/core operations and a JSON-lines CLI. Document example requests and responses; keep importable application API independent of Node.
- [x] Run agent/replay/protocol and affected multiplayer checks; commit.

### Task 7: Integrated verification and cleanup evidence

**Files:** docs/implementation.md and this plan; production files only where measurements expose unresolved issues.

- [x] Record baseline and final production line count, request counts for warm revisit, cache bytes and startup/navigation measurements using the available browser harness.
- [x] Run `npm run typecheck`, `npm run typecheck:core`, `npm run build` and `npm test`; report any environment blocker separately from code failures.
- [x] Exercise mobile pinch/rotation/resize, no-blank enrichment, prepared-region offline reopening and terminal gameplay against the same state.
- [x] Inspect branch diff for duplicate/superseded code, protocol-field loss and unsupported completion claims. Remove dead paths and rerun only checks affected by those changes.
- [x] Record verified results, remaining limits and completed checkboxes. Deliver the branch and concrete preview/evidence; do not merge or publish automatically.

## Self-review

All approved design areas map to Tasks 1–7. Shared signatures above are consumed by subsequent tasks; existing camera and session APIs remain compatible until their consumers migrate. Review-focus conditions are assigned explicit regression cases. Offline readiness is scoped to declared bounds and successful persistence, not elapsed time or all possible source resolutions. Plan is ready for user review and execution-method selection.

## Execution evidence

Implemented and independently reviewed. See `2026-10-02-mobile-verification.md` for decisions, limits and browser evidence. Final checks: typecheck, typecheck:core and production build passed; 532 tests passed, 5 skipped. Branch push blocked by automatic approval review and requires explicit authorization; no merge or deployment performed.
