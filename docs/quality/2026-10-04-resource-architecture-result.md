# Resource architecture: implemented and measured

Baseline source `00df96b`; refactor branch `codex/webgl-resource-budget`. The user authorized code changes, production publication and production tests. Measurements made on this Mac, Chrome154.0.8037.93, Node26.8.1. No new dependency, save migration or geometry/depth simplification.

## Changes

- Mobility decodes streets before materializing geometry; its decoded cache is8MiB instead of32MiB of all layers. Four FalseCreek z14 tiles have25,882 road vertices versus138,338 total. Paired eight-run decoding medians2.8–5.2ms versus5.6–11.2ms, with equal road geometry.
- Road preparation admits complete nearby tiles before expanding topology, with segment, edge, intersection-comparison, cut, bucket-entry and endpoint ceilings; asynchronous construction yields during indexing as well as intersections. A30-disjoint-long-road regression bypassed the original comparison budget and allocated122,880 bucket entries; the60-edge policy now stops at480. Normal4-tile graph remains26,706nodes/62,792edges. View demand is one viewport plus25% on each side rather than nine viewports.
- Buildings retain immutable ImageBitmaps produced by one reusable raster context. LRU byte budget still applies; at most2,048 image handles, or256 individually owned canvases on hosts without snapshots. Rejected/evicted images close exactly once. Terrain/display surfaces are separate; “one context” refers to building raster preparation, not the entire browser.
- Worker scene updates send changed tile bytes and selected keys. Unchanged geometry keeps decoded identity and static preparation across loading metadata updates.
- Initial HTML presents opening/loading/preparing feedback until a usable scene is actually displayed, then a compact update/retry indicator. Controls remain available. Regional transit/signals/schools and boats/planes activate after first picture and only in their coverage. Errors and initialization failures have explicit retry.
- Worker presentation no longer restarts the full ambient wait; the scheduler preserves the next deadline and sleeps when paused.
- Pages validation uses the same bounded two-worker test invocation used throughout this investigation, including20s for baseline subprocess build tests. It still performs typecheck, lint, all tests, production build and clean-tree checks.

## Browser evidence

Native Chrome, production builds served locally, Vancouver49.283,-123.121, neighborhood scale50m, north/day, viewport886×784, DPR2, speed1,15one-second samples, one visible app tab. Public sources and cache arrival differ between runs; these are paired scene observations, not a statistically controlled native-memory experiment.

| Metric | Original | Final |
|---|---:|---:|
| Initial JS raw / gzip |781.04 /240.12KB|679.57 /229.24KB|
| Steady presented FPS, median excluding first startup sample |15|18.5|
| Maximum sampled main-frame p95 |3.1ms|3.5ms|
| Maximum sampled worker work |16ms|10.7ms|
| Building cache entries in fixed scene |493 mutable canvases|445 immutable images|
| Building raster contexts |one per cached building|1|
| Maximum sampled raster cache bytes |78,639,060|56,742,220|
| Main-thread JS heap maximum |81,179,131|101,232,470|

The final sample FPS was[5,20,17,18,15,21,19,18,20,18,19,21,17,20,16]. This improves cadence but does not establish30FPS. Main-thread work stays below the33ms work target in this sample; JS heap is neither total browser memory nor proof of lower total memory.

Cold new preview origin after loading UI change: first usable scene568.2ms, map843.1ms. Warm reload567.8ms; final reload731.4ms. Deferred regional chunks requested after first scene (example671ms). Loading visibly changed Preparing→hidden. Native screenshot inspection confirmed dense city, depth, controls, night and rotation.

Seven5-second samples across Vancouver→Victoria→Vancouver→Lisboa→Vancouver→Victoria→Vancouver: cache <=78,585,256bytes, <=2,048entries and1 raster context; zero recorded JS errors. Sampled JS heaps[116,171,86,84,89,78,176]MiB show GC variability, not established native-memory stability. Warm reload restored camera and saved state. Twenty alternating zoom changes with rotation were queued in the final build; macOS locked before the completion output could be read. Pause/surface recovery regressions pass, and the previous containment-stage native test verified forced GPU fallback. A fresh final-build forced-loss test could not execute once locked.

Paired final road benchmark (`resource-audit/network-final.jsonl`) at20k edges accepted the same1tile/17,397edge graph: original599–788ms, refactor135–166ms. At140k original276–367ms/refactor292–432ms, same4tile graph; there is some guard overhead at the full budget. Timings are Node construction/runtime preparation, not browser FPS or message transport.

## Review rulings and limits

Fresh independent reviewer examined00df96b..8b152fa, then39abfc3 andabd5b80. Two important findings—unbounded spatial bucket work and invisible regional failures—were fixed with failing-before/passing-after regressions. Follow-up found no outstanding critical/important code findings. Historical256-canvas evidence is labeled separately.

- Compact mobility graph transport was considered and deferred: the bounded selected graph still uses the existing full structured-clone contract. Scene tile transport is incremental. A separate network representation change needs browser serialization/install profiling; Node clone271ms from one run is insufficient to select that design. Cost: graph duplication remains bounded but still exists.
- Browser performance/visual acceptance was left to executor: the observations above establish lower context count and bounded main-frame work, with cadence improvement, but do not prove30FPS or native-memory stability over arbitrarily long play.
- Original native Chrome crash causation remains unproven: the Chrome151 renderer EXC_BAD_ACCESS dump lacks symbols; Chrome is now154 and the original crash did not reproduce. Resource waste is fixed; do not claim a proven cure of that native crash.
- Production readiness is conditional on the full final gate and actual live verification below. Prior blank fullscreen DevTools window is retained as an investigation limitation; clean native Chrome window rendered and reloaded successfully.

## Publication

Published source54138a18e003a1159c7456cd0c6e94a75036739e as Pages commit76b977b3973b482656900fb004b4d010401075af via the existing script. Final gate:149test files/1,024passed/5skipped; typecheck and build passed; lint had zero errors and10 existing warnings.

At2026-10-05T04:25:26Z, live HTML plus all9 built assets returned200 and matched local build byte-for-byte/SHA256. Evidence: [production-check.json](2026-10-04-resource-audit/production-check.json). Live app: https://wsmontes.github.io/open-sim/. Previous Pages commit9363995916cb1303f0ae922223661f1fbc22cedc is preserved remotely as tag `codex/pages-before-resource-2026-10-04` for recovery.

Native production visual verification is pending: the CUA tool reported that macOS was locked and automatic unlock failed, twice. The human was asked to unlock while publication/HTTP checks continued. The tested local production build has exactly the same deployed bytes, but HTTP equality does not establish a native production browser smoke test. Do not mark this final visual check complete until the Mac is unlocked and it is actually performed.
