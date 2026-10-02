# Visual World Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement inline. User waived approval gates; execute through verification without further design approvals.

**Goal:** Make real cities visually coherent and navigate from buildings to the planet.
**Architecture:** A visual vector tile stream runs beside the unchanged simulation grid. One geographic coordinate system connects footprint rendering, regional maps, player edits and the globe.
**Tech Stack:** TypeScript, Canvas 2D, existing PBF/vector-tile libraries, Vite, Vitest; public-domain Natural Earth GeoJSON.
**Spec:** docs/superpowers/specs/2026-10-02-visual-world-design.md

## Global constraints
- Preserve saves, economics and multiplayer model.
- Tile zooms 0–14, bounded tile requests and cache.
- No copied SimCity art; source footprints are real, unsupported building heights are illustrative.
- No simulation-chunk enumeration at world zoom.

## Review focus
- Dateline wrapping and high-latitude limits.
- Stale network responses after fast navigation and failed requests.
- Player edits versus imported geometry, including demolition.
- Courtyards/holes and buildings crossing tile seams.
- Mouse, touchpad, touch and narrow windows.

## Tasks
- [x] 1. Tests first: retain vector polygons, bounded geographic tile selection, globe projection and logarithmic zoom; run red. Implement geographic feature decoding and tile source. Verify targeted tests and suite.
- [x] 2. Tests first: real road paths, one footprint per building, player edit precedence and mid-zoom volumes. Implement geographic renderer, building art and globe. Verify drawing behaviour and visual quality.
- [x] 3. Integrate tile streaming into browser; prevent huge simulation demand at distant scales. Expose scale/coordinates, City/World controls, visible zoom, usable tools and coherent panel layout. Exercise browser shell and navigation tests.
- [x] 4. Run full checks and production build. Compare three cities visually, test near/far/planet and construction at desktop/phone sizes. Obtain whole-change review, resolve findings, save screenshots and commit verified changes.

## Execution record
Baseline: 623 tests passed, 5 skipped; browser-shell could not import fake-indexeddb because local dependencies predated the origin reset. Reinstall locked dependencies before assessing baseline.


Completed: visual geometry, regional streaming, real footprint massing, connected streets, hemisphere-clipped globe, camera scale/coordinates and responsive tools. Height/facade inference is disclosed in Sources. Natural Earth and OSM retain visible credits.

Verification: RED→GREEN for geographic zoom/bounds, mid-scale volumes, source footprint holes, streamed failures, imported simulation growth, seam assembly, retina viewport coverage, parent/child overlap and cell-limited demolition. Full check: 78 files, 661 tests passed, 5 skipped; typecheck/lint passed with 9 existing test warnings. Production build passed (444 kB JS, 157 kB gzip).

Visual QA: inspected published before-state and SimCity 2000/reference OSM imagery; tested Vancouver, São Paulo and Lisboa, rotation and neighbourhood/city/planet scales; phone viewport 390×844 with horizontally scrollable tools, globe drag and return. Compiled preview construction charged $30 and displayed the player park/inspector; demolition charged $5 and cleared that cell. Temporary preview at a nonexistent subdirectory initially missed relative assets; root preview succeeded, deployed project keeps its established relative assets.

Final fresh review: imported growth must not replace source footprints (fixed); lower tile level to cover retina bounds (fixed); union buffered building fragments at seams without joining merely touching buildings (fixed); exclude overlapping parent placeholders after partial failure (fixed). A further regression proves that snapping any geographic camera move preserves its requested centre (fixed in the portable client). All reproductions have passing regression tests; no deferred minors.

Ruling: Use the source footprints with illustrative heights/facades and keep the simulation model unchanged — source tiles do not provide building identity or reliable height — cost: the silhouette cannot reproduce every real tower exactly.
Ruling: Retain the work on codex/visual-world and publish through the existing Pages script under the user's authorization for the whole update — cost: the live version advances before a main-branch merge.
