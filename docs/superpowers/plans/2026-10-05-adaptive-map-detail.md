# Adaptive Map Detail Implementation Plan

Goal: adapt geographic demand to measured render and load capacity.
Architecture: pure controller + bounded geographic stream + measured worker feedback, wired in main. Preserve camera zoom independently.
Spec: ../specs/2026-10-05-adaptive-map-detail-design.md

- [x] Write failing controller tests: expensive render, estimated bytes, recovery hysteresis, independent scale bands and load latency.
- [x] Implement controller and verify.
- [x] Write failing stream tests for adaptive demand refresh without camera motion, concurrency/byte budget and obsolete completions.
- [x] Integrate geographicTiles optional limits, stream budget, worker measurements and main controller without adding browser dependencies.
- [x] Run targeted/full checks and build; review actual diff; publish only after verification.
- [ ] Validate native production at regional/planet/near scales once computer access resumes; disclose pending acceptance if blocked.

## Evidence (2026-10-05)

Executed in the `codex/webgl-resource-budget` worktree on this machine.

- Targeted: `npx vitest run tests/adaptive-detail.test.ts tests/geographic-stream.test.ts tests/scene-geography.test.ts tests/scene-surface.test.ts` → 16 passed.
- Full gate: `npm run check` → typecheck clean, biome lint (10 pre-existing warnings in tests), 150 files / 1038 passed / 5 skipped. `npm run build` → clean, worker chunks emitted.
- Live Chromium (vite dev, `?debug=1`, real input): `detail.cacheBytes` reports the device raster budget (128 MB) while `ownedBytes` sits at 38–63 MB, so no byte-pressure coarsening; a 1566 ms load dropped `concurrency` to 1 and it recovered to 4; recovery hysteresis observed live (bias 1→0, maxTiles 20→40); geographic demand grew 2→12 tiles with real wheel input; screenshot shows streets, parks and water drawn at city scale.

## Defects found and fixed during review

1. **Byte budget scale.** The controller compared `ownedBytes` — which includes the worker's raster cache — against a hardcoded 16/32/48 MB. In the live app that cache alone is ~31 MB and the observer reports ~60 MB, so every view coarsened to the floor (`zoomBias=3`, `maxTiles=5`) and could never recover, since recovery requires `ownedBytes < 0.6 × budget`. The budget now comes from `renderPolicy(...).totalRasterBytes`, the same figure that bounds the worker's raster cache and the surfaces it reserves (`src/presentation/adaptive-detail.ts`). Regression: `tests/adaptive-detail.test.ts` pins that 60 MB does not coarsen on an unknown-memory device and that exceeding the budget does.
2. **Per-frame stream work.** The wiring had moved `geography.update(camera, viewport)` out of the camera-change gate, so `geographicTiles` was rebuilt and sorted every frame. The controller now exposes a `revision` bumped whenever the demand changes, and `main` refreshes the stream when the camera moved **or** the revision changed (`src/browser/main.ts`). Regression: `tests/adaptive-detail.test.ts` pins that the revision stays put on cheap work and moves on a demand change.

## Pending acceptance

- Production (gh-pages) validation at regional/planet/near scales was not run: publishing is not authorized in this session. The live checks above ran against the dev server bundle.
- The original Chrome 151 renderer crash is unchanged in status; this controller does not guarantee nonblocking fallback rendering.
