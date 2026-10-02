# Mobile presentation verification

Branch: `refactor/mobile-world-presentation`. Baseline: `d262e80`.

## Changes and evidence

- Fixed ground-plane bearing, portable fractional viewpoint, pointer cancellation and pinch/pan rebasing. Projection/inverse, saved-centre, cancellation, release and resize regressions were observed failing and then passing.
- Replaced screen-roll rendering with projected ground footprints and upright building extrusions. Renderer shrank from 550 to about 190 lines; some old decorative drawing was replaced. Source TypeScript total decreased from 19,298 to approximately 19,150 lines despite new streaming/offline/terminal modules. This is an architectural simplification, not a claim that all remaining code is redundant or fully minimized.
- Ready terrain survives pending/failed detail enrichment. Streaming priorities and demand deduplication are tested independently from source retrieval.
- Persistent region preparation uses supported provider zooms, verifies actual storage, enforces its write budget, resumes missing tiles and reports retained coverage after eviction.
- Terminal operations exercise LocalSession/core rules and preserve portable metadata. CLI smoke run opened a fixture offline, inspected it, advanced three ticks, and wrote a valid save with tick/revision 3.
- Preserved existing replay, protocol, merge and multiplayer checks. Baseline compilation had a missing Action import and RoadClass-to-Tool typing failures, plus a project insufficient-budget message regression; these were repaired using existing checks.

## Browser evidence

Production build exercised in headless Chromium using a 390 × 844 touch viewport and 844 × 390 landscape viewport, with two-finger input via CDP. Synthetic city save was inspected visually at a rotated bearing; no JavaScript errors. A first-frame error before session initialization was found in the browser and removed. Active multiplayer state is now used by the renderer.

Real external map access was unavailable in this environment. A valid synthetic MVT fixture was substituted for controlled cache testing, not represented as real geography. Preparing the declared region stored 76/76 synthetic tiles; subsequent offline application reload, pinch/resize and map reopening succeeded. Offline debug reported two visible/two ready chunks and zero worker byte transfers. Initial synthetic frame p95 was approximately 7.3 ms; offline p95 approximately 2.2 ms. These are harness observations, not phone performance or real-city download benchmarks. External Wikidata calls were deliberately blocked in the offline fixture.

Service worker debugging additionally found a Vary: Origin mismatch between shell prefetches and module/CSS requests. Same-origin cache lookup now tolerates that difference; offline reload then succeeded. Cached application assets included HTML, JS, CSS and the map worker.

## Independent review and decisions

A read-only independent review found four important issues: resize replayed existing pan movement; terminal save dropped unknown fields/viewpoint; provider persistence preceded the region budget check; service-worker quota failure discarded successful online responses. Each received a RED→GREEN regression and fix. Coverage byte accounting and configurable overview resolution were elevated from minor to important because offline status must be honest; both received integration regressions and fixes.

Decisions made during execution:

1. Replace renderer art with shared footprints/extrusions rather than patching canvas roll. Cost: decorative art changed; reviewed visually.
2. Legacy saves without portable centres reopen in managed geography. Cost: an old unsaved exploration position cannot be recovered exactly without its original viewport.
3. Update rotation tests to preserve ground distance rather than screen radius. Cost: screen silhouettes change with genuine ground bearing, as intended.
4. Repair baseline typing and project-price message regressions. Cost: small additional changes outside presentation, verified by existing tests.
5. Guard pre-initialization frames and render the active session. Cost: loading initially shows the background until state exists.
6. Elevate coverage accounting and configured zoom consistency to important. Cost: one final cache scan per region preparation and additional validation.

Deferred minor: pressing retry immediately after moving can briefly start old queued map demand before current demand replaces it; concurrency is bounded and durable state is unaffected.

## Delivery status

The source, tests, design and plan are committed locally. No merge or website deployment was performed. Automatic approval review rejected a GitHub branch push as external publication without explicit authorization; no alternative publishing path was attempted.

Final verification: `npm run typecheck`, `npm run typecheck:core`, and `npm run build` passed. `npm test`: 61 files passed, 532 tests passed, 5 skipped. `git diff --check` passed.
