# Resource Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** eliminar trabalho desnecessário de dados, rede e raster e manter carregamento/navegação responsivos.

**Architecture:** manter os workers e o renderer existentes; especializar dados por consumidor, limitar preparação antes de expandir, reutilizar um contexto de raster e sinalizar primeira cena/atualizações. Reduzir reenvio e invalidação de dados imutáveis e tirar carregamento regional do coordenador principal.

**Tech Stack:** TypeScript, Canvas2D/OffscreenCanvas, ImageBitmap, workers, Vite e Vitest; sem dependência nova.

**Spec:** `docs/superpowers/specs/2026-10-04-resource-architecture-design.md`, aprovada pelo usuário em 4/10. Execução autônoma, incluindo produção e testes em produção, expressamente autorizada.

## Global Constraints

- Preservar saves, economia, fontes, geografia, profundidade/oclusão e funcionalidades.
- Não bloquear controles durante preparação; não inventar percentuais.
- Medir mesmas coordenadas, viewport, câmera e velocidade antes/depois.
- Limites de trabalho antes de alocar; liberar recursos de um único dono exatamente uma vez.
- Publicar somente build/testes verdes, revisão concluída e árvore commitada.

## Review Focus

- Worker indisponível: fallback continua útil, com preparação menor e cancelável.
- Tiles densos ou com interseções patológicas: orçamento respeitado antes de explosão de memória.
- Mudança rápida de cidade: resultado antigo nunca substitui cena atual.
- Primeira imagem e erro de mapa: loading não fica eterno nem oculta retry.
- Night/resize/eviction: imagem de prédio preservada, bitmap fechado, contexto temporário liberado.

---

### Task 1: Decode only the geometry mobility consumes

**Files:** `src/adapters/osm/decode.ts`, `src/browser/visual-tile-decoder.ts`, `src/browser/mobility-worker.ts`, `src/browser/mobility-worker-client.ts`, `tests/visual-tile-decoder.test.ts`.

**Interfaces:** `decodeVisualTile(bytes,z,x,y,layers?:ReadonlySet<string>)`; `createVisualTileDecoder(limitBytes=32MiB,layers?)`; `MOBILITY_LAYERS` selects streets only.

- [x] Write regression with real encoded multi-layer PBF: road geometry/attributes equal full decode, no building geometry retained; decoded revision reused.
- [x] Run `npx vitest run tests/visual-tile-decoder.test.ts tests/geographic-map.test.ts tests/mobility-worker-client.test.ts --maxWorkers 2`; Expected: new regression FAIL before implementation.
- [x] Add layer selection before geometry load; use streets-only cache in mobility worker and fallback; preserve visual default.
- [x] Run same command; Expected: PASS. Re-run real-tile probe and record.
- [x] Commit `perf: decode only road geometry for mobility`.

### Task 2: Bound topology before expanding it

**Files:** `src/presentation/mobility-network.ts`, `src/presentation/mobility-network-job.ts`, `src/browser/mobility-stream.ts`, `tests/mobility-network-job.test.ts`, `tests/mobility-network.test.ts`.

**Interfaces:** network builder accepts optional construction budget with segment/edge/comparison ceilings; budget exception handled by job, not leaked to UI. Results preserve complete accepted tiles and existing shape. Stream retains latest-only job queue.

- [x] Add regressions for dense tile input and intersection expansion hitting construction budget; unconstrained topology remains identical; empty/zero limits return empty network without construction.
- [x] Run `npx vitest run tests/mobility-network-job.test.ts tests/mobility-network.test.ts tests/mobility-stream.test.ts tests/mobility-worker-client.test.ts --maxWorkers 2`; Expected: regression FAIL.
- [x] Preselect road segment budget; enforce ceilings inside generator before segment/cut/edge accumulation. On overflow discard farthest complete region, rebuild bounded accepted set; async fallback preserves yields/cancellation. Reduce mobility demand margin from nine viewports to viewport plus 25% on each side, with current minimum simulation scale retained.
- [x] Run same tests and real four-tile network benchmark; Expected: PASS, same graph when original fits, smaller-budget preparation cheaper than baseline repeated full graph.
- [x] Commit `perf: bound road topology before construction`.

### Task 3: Retain pixels instead of one context per building

**Files:** `src/surfaces/canvas/scene-cache.ts`, `src/surfaces/canvas/architecture-renderer.ts`, new `src/surfaces/canvas/building-raster.ts`, `tests/building-cache.test.ts`, `tests/scene-cache.test.ts`, `tests/building-raster.test.ts`.

**Interfaces:** raster helper owns one reusable OffscreenCanvas and returns immutable ImageBitmap when supported; fallback returns owned OffscreenCanvas. Dispose handles bitmap.close or zero canvas dimensions. Helper clear tied to cache teardown.

- [x] Write tests: many snapshots use one context, transforms reset on reuse, rejected/evicted bitmap closes once, fallback still renders. Run `npx vitest run tests/building-raster.test.ts tests/building-cache.test.ts tests/scene-cache.test.ts --maxWorkers 2`; Expected: FAIL.
- [x] Implement helper and cache ownership; preserve per-building image dimensions and camera/light keys; no depth-order change.
- [x] Run same tests plus renderer equivalence/terrain suites; Expected: PASS. Compare actual Chrome scene, rendering time and retained resources; keep only if useful.
- [x] Commit `perf: reuse building raster context and cache immutable pixels`.

### Task 4: Keep scene updates small and loading visible

**Files:** `src/browser/scene-worker-client.ts`, `src/browser/scene-worker-protocol.ts`, `src/browser/scene-worker.ts`, `src/browser/main.ts`, new `src/browser/scene-loading.ts`, `index.html`, `src/browser/style.css`, `tests/scene-worker-client.test.ts`, `tests/scene-loading.test.ts`, `tests/browser-shell.test.ts`.

**Interfaces:** geographic patches carry changed immutable tiles and selected tile keys; worker retains/reuses unchanged selection identity. `createSceneLoading(element)` exposes update with initial/usable/updating/error states. Surface status exposes whether first usable frame was presented.

- [x] Regressions: unchanged tile bytes not resent on revision, stale bitmap closed, first loading clears only on presented usable scene, retry/error and controls remain usable.
- [x] Run `npx vitest run tests/scene-worker-client.test.ts tests/scene-loading.test.ts tests/scene-surface.test.ts tests/browser-shell.test.ts --maxWorkers 2 --testTimeout 20000`; Expected: FAIL for new cases.
- [x] Implement incremental geographic patches and matching decode reuse; lightweight loading status initially in HTML, nonblocking compact update after first picture; real first-scene mark distinct from initial frame.
- [x] Run same tests; Expected: PASS. Inspect warm/cold reload and navigation in real Chrome.
- [x] Commit `perf: reuse scene tiles and show loading without blocking play`.

### Task 5: Separate regional work, validate and publish

**Files:** new `src/browser/regional-mobility.ts`, `src/browser/main.ts`, regional data/clock imports as necessary, `docs/quality/2026-10-04-resource-audit/`, plan ledger.

**Interfaces:** regional source activation owns cached asynchronous dataset loading and stale-region rejection; coordinator receives ready immutable captures. Existing panels, session and clock APIs preserved.

- [x] Add regression for leaving region before data finishes; run targeted regional/browser tests. Expected: FAIL before new helper.
- [x] Move regional capture loading/activation from main; defer captures until matching area, keep teardown and fail/retry behavior. Do not perform unrelated file splitting.
- [x] Run full `npm run typecheck`, `npm run lint`, `npx vitest run --maxWorkers 2 --testTimeout 20000`, `npm run build`; Expected: all PASS (existing bundle warning documented if remains).
- [x] Compare cold/warm first scene, dense navigation, static animation, pause, repeated journeys and forced GPU fallback. Record limitations honestly.
- [x] Commit, independent whole-branch review; fix substantive findings with regressions; full checks green.
- [x] Publish via existing Pages flow, preserving recovery reference; verify live bundle byte-for-byte. Source54138a1/Pages76b977b, all assets200 and equal.
- [ ] Verify the deployed app visually in real Chrome; blocked by macOS lock requiring manual unlock. Local production build tested, production HTTP verified.
