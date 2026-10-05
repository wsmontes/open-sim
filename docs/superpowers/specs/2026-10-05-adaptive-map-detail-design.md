# Adaptive map detail

User requires detail at broad zoom to respect the current device and network dynamically. Camera navigation must remain available; reduce geographic detail rather than restrict the camera. Existing static deviceMemory policies are only initial hints.

Use an in-session controller with separate render and loading pressure. Coarsen geographic tile zoom and bound tile count after expensive worker work or estimated retained geometry/raster pressure. Recover detail only after sustained inexpensive completions, using hysteresis and independent zoom bands so expensive regional views do not permanently penalize nearby views. Start regional unknown views conservatively. Network timings include provider/cache latency and must be labelled as load latency, not claimed bandwidth; reduce concurrent loads quickly under slow/error responses and recover gradually. Cached data stays available when loading is slow. Cap retained stream bytes as well as tile count; do not retain obsolete response tiles.

Memory measurements are estimates of owned assets, not total Chrome/GPU memory. Unsupported browser capability hints use conservative defaults. Diagnostics expose effective detail, budget, observed render work and load latency. No external telemetry or dependencies.

Validation: deterministic fake-time regressions for overload, hysteresis, zoom-band isolation, latency/concurrency, stale responses and cache bounds, then full suite/build. Native foreground extreme-zoom/failure testing remains required and currently blocked by locked Mac/browser availability. This controller alone cannot guarantee nonblocking fallback rendering; do not claim it does.
