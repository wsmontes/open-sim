# Shared Resource Budget Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement task-by-task, then independent review.

**Goal:** Bound managed map resources together and preserve full coverage under pressure.
**Architecture:** One device resource policy partitions estimated live resources and reserves network peaks. Streams enforce admission and selection lifetime; workers enforce decode/construction quotas. A disjoint geographic tile mosaic trades detail for coverage.
**Tech Stack:** TypeScript, browser workers/streams, Vitest/Vite.
**Spec:** docs/superpowers/specs/2026-10-05-shared-resource-budget-design.md

## Global Constraints

- Managed estimates are not total browser memory measurements.
- Preserve player history; no dependency additions.
- Disposed/obsolete asynchronous results must not restore resources.
- Geographic coverage must remain complete at degraded detail.

## Review Focus

- Very large HTTP content must stop before concatenation.
- Far navigation during in-flight mobility work must release demand.
- Aborted terrain queues and same-region selection must not retain departed tiles.
- Near source floor plus low count must not create holes/overlap.
- Workerless hosts must bound decoding before point allocation.

### Task1: Device policy and bounded bodies
Files: presentation/resource-policy.ts, presentation/render-policy.ts, presentation/adaptive-detail.ts, adapters/osm/provider.ts, adapters/http/bounded-body.ts, browser/main.ts; tests resource-policy/bounded-body/map-provider.
- [x] Write failing partition-sum and oversized/cancelled-stream tests; run RED.
- [x] Implement resourcePolicy(memoryGb), boundedResponseBytes(response,maxBytes,signal), wire provider limits and pressure channel.
- [x] Run targeted GREEN; integrate in the coordinated refactor commit.

### Task2: Geographic coverage mosaic
Files: presentation/geographic-map.ts, tests/geographic-map/geographic-stream.
- [x] Reproduce low-budget near holes and require full non-overlapping coverage.
- [x] Implement count-bounded coarse selection, nearest-child refinement and explicit quality limitation.
- [x] Run targeted GREEN; integrate in the coordinated refactor commit.

### Task3: Terrain lifecycle
Files: adapters/map/terrain-source.ts, browser/terrain-stream.ts, browser/main.ts; tests terrain-source/terrain-stream.
- [x] Pin strict source limit/disposal, bounded selection/concurrency, same-region departure and stale completion.
- [x] Implement policy-driven byte admission and generation-cancelled bounded publication.
- [x] Run targeted GREEN; integrate in the coordinated refactor commit.

### Task4: Mobility lifetime/decode/construction
Files: browser/mobility-stream.ts, browser/mobility-worker.ts, browser/mobility-worker-client.ts, presentation/mobility-network-job.ts; tests mobility-stream/mobility-worker-client/network-job.
- [x] Pin byte rejection, obsolete response drop and bounded decoder fallback.
- [x] Enforce selection bytes, policy construction/geometry limits, remove inactive decoder cache and reset stale publication ownership.
- [x] Run targeted GREEN; integrate in the coordinated refactor commit.

### Task5: Integration/review/native/deploy
- [x] Full check/build, policy diagnostics and independent review.
- [x] Foreground Chrome zoom/rotation/simulation/navigation when available; save honest evidence.
- [ ] Commit/push/deploy via repository gate and verify canonical assets; report material remaining estimates/limitations.

Ruling: include normalized map decoding before final validation. Exploration found another count-only32-tile cache and a worker-failure fallback that decodes/buckets complete tiles synchronously. These are directly inside the managed map allocation path; leaving them outside the policy would undermine the shared budget. Reserve a normalization partition, retain bounded feature arrays instead of all-chunk buckets, reject incomplete normalization, and cap/yield the workerless path. Costs: oversized normalization can remain unavailable rather than creating partial imported world data.

Review ruling: complete paths nearest the camera remain available when an entire dense mobility tile exceeds the edge budget. Same-tile panning refreshes the selected paths. Healthy active frames restore source quality, with immediate rollback of an expensive trial. Normalization reserves input, retained features and decode workspace; jobs serialize, worker deadlines fall back to bounded yielded normalization. Independent review found no remaining critical or important issues. The coupled policy changes are committed together.
