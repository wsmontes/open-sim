# Native raster resource budget — historical containment probe

This records the intermediate 256-canvas mitigation, not the final deployed architecture. The final implementation retains up to 2,048 immutable images under a byte budget, produced by one reusable context; hosts without snapshot support retain at most 256 canvases. See [final evidence](2026-10-04-resource-architecture-result.md).

Production baseline: `00df96b` (bundle filenames verified against the published application). Change is isolated on `codex/webgl-resource-budget`.

## Evidence and change

The published scene cache retained 1,350–1,474 individual raster surfaces during navigation. Its pixel-byte limit did not bound the number of native Canvas2D contexts. A regression test demonstrated that 100 one-byte entries could remain retained despite a proposed three-surface budget.

The cache now accepts an independent entry-count limit. Production raster caching is capped at 256 surfaces, in addition to its existing adaptive byte limit. Least-recently-used resources are disposed exactly once when either budget is exceeded. This bounds retained native contexts; it does not measure all native memory or limit transient allocations awaiting browser cleanup. The 256 cap is a conservative initial budget, not a measured browser limit.

## Verification

- Regression was observed failing before implementation (100 entries versus expected 3), then passing.
- Production-cache regression inserts 300 surfaces, confirms 256 retained and 44 released, then confirms all released on clear.
- Targeted cache, building, GPU presenter and scene surface tests: 11 passed.
- Full suite: `npx vitest run --maxWorkers 2 --testTimeout 20000`: 144 files passed, 1,005 tests passed, 5 skipped. The higher timeout avoids previously observed baseline subprocess compilation timeouts during browser testing; no production timeout changed.
- `npm run build` passed; existing large-chunk warning remains.
- Real Chrome 154.0.8037.93, local development build, Victoria: 20 alternating zoom changes, rotation every third change. 256 retained surfaces, zero unexpected context losses, zero JavaScript errors; sampled main-thread heap peaked at 348,151,658 bytes. This is not a controlled total-memory comparison against production.
- After navigation settled with simulation at 3×: worker rendering approximately 7–8 ms, static composition ready, no active/pending jobs at the sampled instants.
- Forced `WEBGL_lose_context` switched presentation to `worker-canvas2d`; one canvas remained, zero JavaScript errors, map visibly rendered. Existing fallback behavior is preserved, not newly implemented.

## Remaining uncertainty

The original minidump is a native renderer EXC_BAD_ACCESS from Chrome 151.0.7922.174 on the published origin. Chrome on this computer is now version 154. The original crash did not reproduce in either baseline or modified navigation runs. No symbolized native stack is available. Resource pressure is demonstrated, but causation of that native crash remains unproven. This change is a resource-pressure mitigation, not proof that the original native crash is fixed.

No production deployment was performed.
