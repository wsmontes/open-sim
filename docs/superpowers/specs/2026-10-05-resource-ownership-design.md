# Resource ownership and admission

Continue from bfba043. Published adaptive detail is useful feedback, not a complete memory architecture. Review found a non-enforced geographic budget and duplicate geometry accounting. User explicitly authorizes autonomous investigation, refactoring, testing and publishing; do not seek repeat authorization.

## Baseline ownership inventory, verified in code

| Resource | Current owner(s) | Retention/release | Finding |
|---|---|---|---|
| Raw visual tiles, main | OSM encodedTiles promises + geographic stream + mobility stream + displayed view | 64 entries per owner; stream has soft bytes; provider destroy clears map | Shared references are not independent allocations, but any owner prevents collection; count limits cannot bound bytes |
| Decoded scene geometry, worker | Visual decoder cache + scene-geography selection + prepared scene | Decoder 32MiB; selected geometry remains after eviction; prepared scene switches selection | Same object counted twice; inactive decoded cache unnecessary because delta scene already retains selected geometry |
| ImageBitmaps | scene worker, incoming, displayed, raster cache | Explicit close on replacement/dispose; stale worker results close | Displayed view retains complete input state unnecessarily; failed worker drops usable picture |
| GPU scene | presenter | Explicit texture/buffer/program deletion, context-loss callback | Owned texture estimate omits driver allocation; no promise of total GPU memory measurement |
| Building pixels | raster cache/buildingRaster | Byte LRU + handle cap + close/reset | Explicit release verified; raster cache budget must include reserved presentation surfaces |
| Terrain | terrain source + controller + worker + prepared scene | Source 32MiB; controller selection; abort generation | Source can retain one oversized tile; aggregate multi-owner pressure not yet unified |
| Mobility | stream + worker decoder + network + controller | 64 raw tiles, maxEdges140000, worker/fleet queues | Stream needs byte cap and obsolete-response filtering; decoded/network accounting not complete |
| Map decoding/provider requests | source queues + map worker | Fixed concurrency4 and deadline; source destroy doesn't abort network | Request lifecycle cancellation and transient peak budgeting need separate verification |
| Persistent map/game cache | IndexedDB/world retention | Tile disk quota256MiB; game history policies | Disk cache is not heap; do not evict player state as a rendering mitigation |

## Selected architectural changes

1. Enforce geographic admission before retention, including demanded/oversized tiles. Reject through a distinct pressure channel; coarsen demand without marking network error or creating reload loops. Reconcile budgets even for the same camera/selection. Drop stale failures and snapshots.
2. Scene geography is the sole decoded owner for rendering. Scene decoder does not retain inactive decoded tiles; count selected geometry once and drop departed tiles before decoding additions.
3. Displayed frames retain only pixels, camera and readiness. Failures release obsolete scene input; preserve the last usable picture and never invoke unbounded geographic decoding/drawing on the interface thread.
4. Bound provider fulfilled encoded retention by bytes, keep in-flight deduplication separate, and ensure destroy stops repopulation. Shared tile bytes are referenced rather than copied for each cache.

Tests prove admission/reconciliation, no retry loop, exact selected geometry accounting, minimal display snapshot and failure reprojection. Complete regression/build plus independent review before publish. Record remaining global-budget/cancellation/terrain/mobility gaps; no claim that all app allocation or worst-case interaction is solved. Follow-on budget integration must reserve concurrent decode/network peaks rather than treating each independent cache as the whole device allowance.

## Implemented ownership boundaries

The provider now separates pending requests from a strict 8MiB fulfilled encoded LRU (configurable), aborts active fetches on destroy and prevents delayed results from repopulating disposed state. Geographic stream admission enforces its byte ceiling, treats rejection as pressure, and reconciles a shrinking budget without waiting for camera movement. These caches share references; their estimates must not be summed as if every reference were a copy.

The render decoder has no independent retained tile cache. Scene selection owns decoded geometry, releases departed tiles before replacement and counts that allocation once. A public-Pbf geometry command reader limits retained points/features before creating geometry point arrays; it simplifies with screen-related tolerance and rejects whole over-budget features rather than drawing broken polygon prefixes. Geometry command metadata and encoded/transient buffers still have separate allocation costs. Zero-tolerance regression cases cover holes and multipart lines.

Prepared-scene clear releases its tile/foundation references; entering planet view releases regional geometry. Incoming/displayed frames retain camera, readiness and pixels rather than entire world input. A geographic worker failure preserves the last usable picture, permits camera reprojection and avoids synchronous full geographic decoding on the UI thread. Recovery is bounded to two automatic attempts, with an explicit manual retry. A pressure-empty frame cannot replace the last good picture. Encoded loading is selected even when Worker/OffscreenCanvas capabilities are absent.

Cold-render adaptation initially dropped the near-view source below building-bearing tiles. Native visual testing caught this; near views now retain minimum source zoom14 while bounding the number of admitted tiles. Coarser distant sources remain adaptive. This protects near detail without requiring unbounded near tile counts.

## Verification on 2026-10-05

- Full check: 152 test files passed, 1059 tests passed, 5 skipped; typecheck passed. Lint retains ten existing warnings. Production build passed; existing large-bundle warning remains.
- Independent review identified capability-dependent synchronous loading and false picture readiness; both have regression tests and corrections.
- Native foreground Chrome: 50m neighborhood, 20km regional, rotated/night 200km continent, planet, then return to 50m/day/north. No console warning/error was captured in this session. Buildings remained visible after return.
- Settled continent geometry estimate: 1,634,240 bytes; planet: 0 bytes; returned neighborhood: 5,114,144 bytes. These are owned-resource estimates, not whole-process heap or driver measurements.
- Settled returned neighborhood worker work: 7.1ms; UI frame p95: 2.6ms. These observations are not a controlled FPS benchmark or a proof that every device remains responsive.

## Remaining global architecture limits

Terrain and mobility ownership, normalization/network buffers and aggregate concurrent peak allocation are not yet covered by one shared device budget. Browser memory and connection hints are coarse; the controller uses measured render/load costs and pressure, not exact available RAM. The geographic stream ceiling currently comes from the raster policy rather than a globally reserved memory pool. This change enforces specific ownership/admission boundaries; it does not establish a process-wide memory ceiling or guarantee that context loss can never recur.

Independent final review also caught source-floor tile-count truncation reporting completion without a limited flag. Geographic selection now explicitly reports truncated coverage, propagated into the scene and reduced-detail overlay, including same-selection transitions. Regression verifies pressure-limited four-tile coverage and restoration when the budget grows. Under very low near-view budgets, central detail can still take priority over peripheral coverage; a non-overlapping coarse peripheral representation remains future UX work.
