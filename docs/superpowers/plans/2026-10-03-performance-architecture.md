# Performance Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** reduzir o custo de renderização e os travamentos sem perder dados, profundidade, relevo ou movimento.

**Architecture:** cena preparada persistente com versões explícitas, consulta espacial e composição por regiões sujas. Rede preparada em worker, trabalho coalescido e memória limitada; câmera e HUD separados da frequência da animação.

**Tech Stack:** TypeScript, Canvas2D/OffscreenCanvas, Web Worker, Vite, Vitest e navegador nativo. Sem dependência nova.

**Spec:** `docs/superpowers/specs/2026-10-03-performance-architecture-design.md` (aprovada).

## Global Constraints

- Preservar saves, economia, fontes reais, rotas verificadas e relógio civil independente da velocidade econômica.
- Orçamento agregado de preparação/raster de cena: 128 MiB, incluindo cache de prédios; superfícies alocadas contabilizam width × height × 4.
- Rede instalada com no máximo 140.000 arestas; não cortar silenciosamente rotas aceitas.
- Uma preparação em voo e uma seleção pendente mais recente. Resultados obsoletos não publicam.
- Até 480 atores terrestres, 24 embarcações, 8 aeronaves e 40.000 triângulos, com culling; limites não substituem preparação persistente.
- HUD semântico até 5 Hz durante navegação; controles e ações respondem imediatamente.
- Fallback sem Worker/OffscreenCanvas é limitado e observável; descarte encerra timers, workers e caches.
- Execução nativa preservada. Uma revisão fresca do conjunto ao final; não refazer tarefas concluídas.

## Review Focus

- Prédios transparentes, sombras, veículos atrás de volumes e encostas: composição parcial deve produzir a mesma ordem de desenho e não apagar vizinhos (Task 4).
- Mesma geometria com objeto de câmera novo, noite, resize e pixel ratio: cache não pode depender apenas de identidade nem aceitar raster incompatível (Tasks 2–4).
- Viagem rápida com resultados do worker fora de ordem ou falha: rede da cidade anterior não pode voltar e fila não cresce (Task 6).
- Edição em chunk não visível, lote parcialmente removido e tick que altera energia: invalidar conteúdo realmente afetado sem varredura global por animação (Tasks 2–4).
- Navegador sem OffscreenCanvas/Worker e aba oculta que retorna após minutos: fallback preserva a cena e não cria catch-up ou recursos abandonados (Tasks 4, 6, 7).

---

### Task 1: métricas e baseline reproduzível

**Files:** Create `src/presentation/performance-samples.ts`, `tools/performance-scenario-controls.js`; modify `src/browser/main.ts`, `src/presentation/frame-scheduler.ts`; test `tests/performance-samples.test.ts`, `tests/frame-scheduler.test.ts`; evidence `docs/quality/2026-10-03/performance/`.

**Interfaces:** `createPerformanceSamples(capacity=1800)` returns `{record(sample:FrameSample):void; snapshot():readonly FrameSample[]; clear():void}`; `FrameSample={at:number;intervalMs:number;workMs:number;phases:Readonly<Record<string,number>>;presented:boolean}`. Debug DOM exposes recorded samples and cache/network stats; normal product has no QA controls.

- [ ] Write tests: ring buffer capacity 3 keeps last 3 samples in order; copying snapshot cannot mutate storage; unpresented scheduler invocation does not count as visual FPS; stop/hidden resets interval origin.
- [ ] Run `npx vitest run tests/performance-samples.test.ts tests/frame-scheduler.test.ts`; expected new tests FAIL before implementation.
- [ ] Implement sampling with injected clock; add phase durations for streams, sim, snapshots, preparation, composition and HUD. Expensive diagnostic geometry must not run merely to collect metrics.
- [ ] Run same command; expected PASS. `npm run build` expected PASS.
- [ ] Measure immutable production baseline at `28c9d09`: nine scenes plus current 49.276/-123.124/100m, same native browser 1280×720, one active simulation, 15 s warm-up and 3 × 30 s. Publish manifest and raw JSON; verify actual coordinate and nonzero presented count for every run. Preserve source bundle hash. Commit `perf: add application frame measurements and reproducible baseline`.

### Task 2: cache com versões explícitas e índice espacial

**Files:** Create `src/presentation/spatial-index.ts`, `src/surfaces/canvas/scene-cache.ts`; modify `src/presentation/city-art.ts`; tests `tests/spatial-index.test.ts`, `tests/scene-cache.test.ts`.

**Interfaces:** `createSpatialIndex<T>(entries:readonly {bounds:Bounds;value:T}[],bucketSize:number):{query(bounds:Bounds):readonly T[]}`; Bounds=minX/minY/maxX/maxY. `createSceneCache<T>(limitBytes:number)` returns `{get(key:string):T|undefined;set(key:string,value:T,bytes:number):boolean;delete(key:string):void;clear():void;stats():{bytes:number;entries:number;hits:number;misses:number;evictions:number}}`. Eviction closes owned surfaces through optional constructor disposal callback. Oversized entry rejected.

- [ ] Tests: overlapping bucket results deduplicated; wide features included without allocating unbounded buckets; empty/negative/wrapped shifted queries work; LRU touch preserves recent entries; oversized allocation rejected; replacement/disposal exactly once and total bytes never exceed limit.
- [ ] Run `npx vitest run tests/spatial-index.test.ts tests/scene-cache.test.ts`; expected FAIL.
- [ ] Implement bounded index (wide objects separately) and byte-aware LRU. Keep world-wrap shift explicit at caller; never project geographic longitude as world-cell x. One shared 128 MiB owner used by later caches.
- [ ] Run targeted tests; expected PASS. Commit `perf: add bounded scene caches and spatial queries`.

### Task 3: preparação persistente da cidade

**Files:** Create `src/surfaces/canvas/prepared-scene.ts`; modify `geographic-renderer.ts`, `architecture-renderer.ts`, `terrain-renderer.ts` in same folder; tests `tests/prepared-scene.test.ts`, existing geographic/terrain render tests.

**Interfaces:** `createScenePreparer()` returns `{prepare(view:WorldView):PreparedScene;clear():void;stats():{geometryBuilds:number;projectionBuilds:number;foundationReads:number}}`; `PreparedScene` exposes visible features, edits, roads, labels and buildings with precomputed foundation, depth and immutable source identity. Key includes explicit camera scalars, viewport, pixelRatio, light, terrain revision/tiles, geographic revision/tiles and relevant chunk contents, not global tick alone.

- [ ] Tests: two frames with different motion and equivalent cloned camera return same prepared scene without additional foundation/feature/sort work; imported growth retains real footprint; player edit invalidates affected footprint; energy change updates warning/style; terrain, rotation, zoom, light, resize and ratio invalidate required preparation.
- [ ] Run `npx vitest run tests/prepared-scene.test.ts tests/geographic-render.test.ts tests/terrain-render.test.ts`; expected new tests FAIL.
- [ ] Extract preparation from renderer using Task 2 index. Cache geometry separately from projection; pass prepared foundation to drawBuilding. Offscreen footprints stay culled including rising volume/shadow bounds. Eliminate per-motion JSON.stringify(edits) and edits.map for each building; preserve clipping after editing.
- [ ] Run targeted tests and `npx vitest run tests/renderer-equivalence.test.ts tests/bearing-render.test.ts`; expected PASS. Commit `perf: retain prepared city geometry across animation frames`.

### Task 4: composição estática com regiões sujas

**Files:** Create `src/surfaces/canvas/scene-compositor.ts`; modify geographic renderer, architecture renderer and mobility/vessel/aircraft draw command modules; tests `tests/scene-compositor.test.ts`, `tests/geographic-render.test.ts`.

**Interfaces:** `ScreenBounds={x:number;y:number;width:number;height:number}`. Draw commands expose `{depth:number;bounds:ScreenBounds;draw:()=>void}` with conservative shadow/wake bounds. `createSceneCompositor(surfaceFactory,budget)` returns `{compose(ctx,prepared,dynamic,overlays):void;clear():void;stats():{staticBuilds:number;dirtyRegions:number;bytes:number}}`; fallback replay uses same sorted command sequence.

- [ ] Tests: previous and new actor bounds both restored; overlapping dirty regions merged; threshold 32 regions or 40% screen area falls back to full visible composition; alpha/shadows drawn exactly once; vehicle behind a building and grounded/airborne airplane retain depth ordering; night/resize/edit invalidate static surface; fallback without raster factory produces original command ordering.
- [ ] Run `npx vitest run tests/scene-compositor.test.ts tests/geographic-render.test.ts`; expected FAIL.
- [ ] Implement cached static full-scene image and bounded region replay: restore ground within dirty clips, replay intersecting static volumes plus dynamic commands in depth order. Precompute static bounds and projection/occlusion; water effects have independent bounded regions/frequency. Query spatial index rather than all buildings. Compare mask composition only if dirty replay cannot meet target; ledger measured decision. Shared 128 MiB budget includes existing building cache, temporary surfaces and scene image; never cache invisible failed bitmap candidates repeatedly.
- [ ] Run tests; expected PASS. Native proofs of curves/occlusion/alpha/encosta, day/night and view resize. Record before/after sample for reproduction to verify hypothesis; no success assertion based on unit tests alone. Commit `perf: compose moving actors over a persistent static scene`.

### Task 5: seleção e câmera sem trabalho global por frame

**Files:** Modify `src/browser/geographic-stream.ts`, `terrain-stream.ts`, `mobility-stream.ts`, `main.ts`; create `src/presentation/camera-update-gate.ts`; tests `tests/camera-update-gate.test.ts`, stream/input suites.

**Interfaces:** `createCameraUpdateGate()` returns `{changed(camera:Camera,viewport:Viewport):boolean;reset():void}` compares scalar values and retains no mutable host objects. Updates still publish tile arrival independently of camera changes.

- [ ] Tests: equivalent new camera object does not trigger selection; rotation/zoom/size change does; tile completion publishes at rest; rapid camera changes retain only latest requested preparation; returning with warm cache republish restores network.
- [ ] Run gate and stream tests; expected FAIL on new behavior.
- [ ] Gate stream selection/demand by actual camera/viewport changes. During glide, install bounded detail from prepared scene and finish high detail at rest; input never waits for obsolete preparation. Do not skip invalidation from arrivals, terrain or edits.
- [ ] Run `npx vitest run tests/camera-update-gate.test.ts tests/geographic-stream.test.ts tests/mobility-stream.test.ts tests/geographic-input.test.ts`; expected PASS. Native pan/zoom/rotation/globe proof. Commit `perf: separate camera selection from animation updates`.

### Task 6: rede versionada no worker e complexidade limitada

**Files:** Create `src/browser/mobility-worker.ts`, `mobility-worker-client.ts`, `src/presentation/mobility-network-job.ts`; modify mobility stream/controller/network; tests `tests/mobility-network-job.test.ts`, `tests/mobility-worker-client.test.ts`, existing route/network suites.

**Interfaces:** `NetworkRequest={ticket:number;revision:string;tiles:readonly GeographicTile[];maxEdges:number}`; `NetworkResult={ticket:number;network:MobilityNetwork;limited:boolean;acceptedTileKeys:readonly string[]}`. `createNetworkJobQueue(build,publish)` returns `{submit(request):void;dispose():void;stats():{active:number;pending:number}}`. Structured clone supports Map; transfer typed buffers only when owned exclusively. Controller installs matching result via existing `setNetwork`.

- [ ] Tests: fake deferred builder proves one active/one latest pending; stale result rejected; dispose ignores late result; worker failure produces bounded synchronous fallback; budget result <=140000; accepted geographic pieces retain complete edge pairs/levels; verified route either connected/valid or explicitly unavailable, never truncated bus route.
- [ ] Run job/client tests; expected FAIL.
- [ ] Implement worker build, revision tickets, coalescing and budget by complete prioritized tile regions; stop installing oversized topology. Signal/intersection metadata expensive to prepare moves with network job where necessary. Preserve prior consistent network while new compatible selection loads; city exit clears immediately. Report limits in debug DOM.
- [ ] Run `npx vitest run tests/mobility-network-job.test.ts tests/mobility-worker-client.test.ts tests/mobility-stream.test.ts tests/mobility-network.test.ts tests/transit-routes.test.ts tests/transit-motion.test.ts tests/school-transport.test.ts`; expected PASS. Native rapid Vancouver/Lisboa/return and worker-failure proof. Commit `perf: build bounded mobility networks outside the frame loop`.

### Task 7: snapshots, HUD e suspensão

**Files:** Modify mobility engine/controller, main, frame scheduler; create `src/presentation/semantic-update-gate.ts`; tests `tests/mobility-engine.test.ts`, `tests/semantic-update-gate.test.ts`, scheduler/browser-shell tests.

**Interfaces:** `createSemanticUpdateGate(intervalMs=200)` returns `{shouldUpdate(key:string,now:number,immediate=false):boolean;reset():void}`. Engine frame/signal snapshots retain identity when simulation/network/surface/phase did not change; presentation consumers receive same immutable snapshot within update.

- [ ] Tests: one frame computation for repeated reads; moving simulation invalidates, pause does not; changed signal phase invalidates; HUD repeated semantic key does no work; navigation updates capped to5Hz and immediate intent bypasses delay; hiding and resuming after minutes causes no catch-up; disposal releases all resources.
- [ ] Run tests; expected new assertions FAIL.
- [ ] Implement versioned snapshots, visible signal candidate indexing and semantic HUD updates. Timer/hide events invalidate only relevant state. Stop diagnostics computing its own repeated frames/terrain projections. Preserve paused camera/theme rendering and explicit scenario controls.
- [ ] Run `npx vitest run tests/mobility-engine.test.ts tests/semantic-update-gate.test.ts tests/frame-scheduler.test.ts tests/browser-shell.test.ts tests/mobility-status.test.ts`; expected PASS. Commit `perf: decouple interface and snapshots from animation frequency`.

### Task 8: aceitação, estabilidade e revisão final

**Files:** evidence/audit under `docs/quality/2026-10-03/performance/`, plan checkboxes, spec only through ledgered rulings.

**Interfaces:** comparison manifest uses Task1 raw samples. Review package includes branch base `28c9d09`, approved spec, plan, all ruling lines and measured limits.

- [ ] Run `npm run check` and `npm run build`; expected PASS. Record actual warnings; do not label new warnings preexisting without comparison.
- [ ] Repeat Task1 production measurements with identical scenes/data/viewport and3×30s warm runs. Publish raw samples and comparison: cost p50/p95, actual presented interval, actor counts and cache bytes. Reproduction draw p50 reduction >=80%; target total work p50<=16.7ms/p95<=33.3ms on Downtown/FalseCreek/TransLink. Navigation warmed presented interval p95<=50ms, no own task>100ms. If target fails, profile remaining phase and correct before completion.
- [ ] Measure20 scene journeys; caches <=128MiB and network<=140000; no monotonically retained resources. Pause and background produce no unchanged redraw or catch-up. Native desktop/390×844 visual proofs cover Task4/5/6 review focus, maritime/air operations, edit/demolish, north slope and day/night.
- [ ] Verify old save/replay and city facts; full checks again only if code changed. Dispatch one fresh reviewer per executing-plans skill, fix Important/Critical once with reproducing RED→GREEN tests and full passing suite; defer minors explicitly.
- [ ] Preserve raw measurements, review report, ruled decisions and proof links in tracked audit. Commit `perf: verify persistent scene architecture and stability`. Report only measured outcomes and unresolved limits; no push/deploy/merge presumed.

## Estado final — 3/10/2026

Implementações das tarefas1–7 concluídas, seguidas da extensão solicitada de composição/decodificação/frotas por worker e apresentação opcional WebGL2.977testes passaram,5ignorados,140arquivos; typecheck, lint e build aprovados. Revisão original e revisão da extensão concluídas,10achados importantes corrigidos. Evidência e decisões em `docs/quality/2026-10-03/performance/README.md`.

A aceitação quantitativa extensa da tarefa8 permanece não verificada: a rodada final30execuções/20viagens e todas as provas móveis não foram realizadas nesta entrega. A observação nativa curta verifica execução, câmera pausada, filas ociosas e superfície acelerada, sem generalizar metas. Esta revisão de escopo segue a orientação do usuário de priorizar desenvolvimento.

Publicação posteriormente autorizada pelo usuário: código051f550 enviado ao origin/codex/vancouver-data-mobility; build840c15f enviado ao origin/gh-pages por avanço normal, preservando histórico.
