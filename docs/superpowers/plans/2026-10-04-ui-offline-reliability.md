# UI e off-line — plano de implementação

> **For agentic workers:** Use superpowers:executing-plans e test-driven-development. Domínios independentes podem executar em paralelo com dispatching-parallel-agents; revisão final independente.

**Goal:** corrigir os defeitos da revisão e tornar a UI responsiva e o armazenamento recuperável.
**Architecture:** ports e módulos existentes, extrações pequenas para lifecycle/capacidades/shell; nenhuma mudança de formato ou regra.
**Tech Stack:** TypeScript, Canvas/DOM, IndexedDB, WebRTC, Vite, Vitest.
**Spec:** ../specs/2026-10-04-ui-offline-reliability-design.md

## Global Constraints

Sem dependências novas, sem publicação, regras determinísticas preservadas. 8s default para banco; 6px CSS tap; 10.000 ticks por intent; 1.024 células por stroke. Regressões de implementação usam RED/GREEN; quatro testes adicionais de confirmação do lifecycle foram escritos depois das correções, conforme registrado no ledger.

## Review Focus

- Abas com builds diferentes e cache incompleto: manter shell consistente.
- Callback tardio depois de stop/reconnect: não atingir instância nova.
- Quota e ausência de APIs: jogar com fallback e preservar save.
- Geometria parent/child rotacionada: conservar cobertura sem duplicar features.
- Inputs malformados no terminal e teclado em controles: recusar sem mutação.

## Task 1: Storage e preparação off-line

Files: bounded-db, tile-cache, chunk-cache, provider, region-cache, offline-controller e testes correspondentes.
Interfaces: boundedDb aceita upgrade específico e deadline; caches retornam miss em falha; RegionCoverage expõe razão de interrupção; provider mantém API compatível e chave por fonte.

- [x] Adicionar regressões para versionchange/retry, opens pendentes, fonte distinta, orçamento e pausa.
- [x] Rodar testes e confirmar falhas esperadas.
- [x] Consolidar abertura; delimitar waits; propagar cancelamento e corrigir mensagens de orçamento.
- [x] Rodar testes de storage/cache/provider/região.

## Task 2: Input, acessibilidade e cobertura geográfica

Files: canvas/input, canvas/hud, geographic-stream, geographic-renderer, geographic-map, index.html, browser/style.css e testes.
Interfaces: input oferece cursor e gesture state; HUD expõe reflow independente de setMode; GeographicScene mantém parent recortado por subárea.

- [x] Testar atalhos modificados, blur/Space, slop 1/2, construção/inspeção por teclado, resize e parent parcial.
- [x] Confirmar RED, implementar equivalentes e recorte, confirmar GREEN.
- [x] Conservar gesto/pointer e ordem commit→inspect; testar antimeridiano e rotação existentes.

## Task 3: Worker e custo visual

Files: map-decoder, map-worker, decode, provider (somente loadVisualTile coordenado com Task 1), testes/map-decoder.
Interfaces: MapDecoder expõe decodeVisual com bytes callback e métricas; worker responde kind visual/chunk.

- [x] Testar equivalência, erro/fallback, dedupe e transferência de visual.
- [x] Confirmar RED, estender worker port, confirmar GREEN.

## Task 4: Parser, reconexão e client lifecycle

Files: codec, webrtc, client/time, city-client, text/parse, json/city-json e testes.
Interfaces: debounce callable cancelável; client stopped não agenda trabalho; limites aplicados na fronteira portable.

- [x] Regredir chaves reservadas, duas gerações RTC, timers após stop e intents inválidos.
- [x] Confirmar RED, corrigir, rodar testes correspondentes.

## Task 5: Shell consistente por build

Files: vite.config, public/sw.js, browser/shell.ts (novo), main.ts, tests/service-worker.
Interfaces: instalação precache gerada pelo build; registro informa versão em uso; SW conserva versões de abas abertas.

- [x] Executar SW em harness com caches reais em memória: instalação completa, falha parcial, off-line e limpeza.
- [x] Confirmar RED, gerar manifest/version e extrair registro; confirmar GREEN e build.

## Task 6: Capacidades e atualização da UI

Files: browser/resources.ts (novo), main.ts, frame-scheduler e testes.
Interfaces: recursos retorna quota/persistência/preferências com unknown fallback; scheduler exige ports injetados pelo host; HUD por dirtiness.

- [x] Testar ausência/falha de APIs e movimento reduzido sem alterar ticks.
- [x] Confirmar RED, integrar capacidades, recursos e refresh coalescido.
- [x] Medir cold/warm start e frames quando navegador disponível.

## Task 7: Simplificação e recursos portáveis

Files: simulation, strokes, tsconfig, bindings sem uso, testes.
- [x] Testar equivalência e eviction do memo; confirmar RED para limite.
- [x] Limitar memo e usar Set nos strokes; remover bindings mortos sem apagar contratos.
- [x] Verificar noUnused, arquitetura, check e build.

## Task 8: Integração e revisão

- [x] Revisar diff completo com reviewer independente; corrigir achados funcionais.
- [x] Executar npm run check e npm run build, registrar resultados e limitações.
- [x] Atualizar ledger/resultados com cobertura de cada requisito e decisões.
- [x] Deixar alterações revisáveis no worktree, sem merge/deploy automático.
