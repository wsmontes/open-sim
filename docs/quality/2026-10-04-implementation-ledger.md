# Execução — plano: docs/superpowers/plans/2026-10-04-ui-offline-reliability.md

Autorização: usuário pediu spec/plano/implementação autônomos, incluindo decisões e sem novas confirmações.
Workspace: worktree ui-offline-reliability, base c86acc1eec13446022bba9d5b080aa3740b787ec.
Baseline: revisão executou 718 testes aprovados, 5 ignorados, build aprovado.
Pre-flight: Task 1 e Task 3 compartilham provider; Task 1 possui bytes/prepareRegion, Task 3 somente loadVisualTile. Task 2 não edita main; coordenador integra reflow/gesture no Task 6.
Ruling: entrega incremental com extrações funcionais; sem reformatação global ou mudança de regras — reduz risco de regressão.

## Resultado entregue

Os 12 defeitos priorizados na revisão receberam correções e regressões. A revisão é um snapshot anterior à implementação; este documento registra o estado entregue na branch `codex/ui-offline-reliability`. Sem dependências novas, alteração de protocolo, merge ou publicação.

| Achado da revisão | Implementação | Evidência |
|---|---|---|
| 1. Abertura de cache prende carregamento | Abertura comum com deadline; provider limita espera pelo cache a 1s e segue com rede | bounded-db, osm-cache, map-provider |
| 2. Readiness RTC reaproveitada | Deferred por link, remoção por identidade e rechecagem depois de ICE assíncrono | webrtc-adapter: sucesso, falha e convites simultâneos |
| 3. versionchange deixa handle fechado | Fecha banco e invalida conexão para reabertura | bounded-db e osm-cache |
| 4. Parent some antes do detalhe completo | Recorta geometrias do parent somente no filho sem detalhe | geographic-map e geographic-stream |
| 5. Atalhos roubam comandos globais | Respeita modificadores, composição, consumo prévio e controles DOM | input |
| 6. Tap depende do DPR | Distância medida em pixels CSS, inclusive release sem move | input |
| 7. Shell acumula versões | Manifest completo por hash do build, instalação consistente e retenção de builds de abas vivas | shell-install e service-worker; Chrome off-line |
| 8. Cache mistura fontes | Identidade da fonte em bytes, região, normalizados e cache do decoder | osm-cache, map-provider e map-decoder |
| 9. Parser altera protótipo | Recusa chaves reservadas antes de atribuição, inclusive aninhadas | world-bundle |
| 10. stop mantém trabalhos | Cancela debounces/stream/fetch/worker; ignora receipts e refresh tardios; host remove listeners e observers | client-lifecycle, map-provider, geographic-stream e browser-shell |
| 11. Painéis ficam fora do viewport | Reflow independente de categoria aplica clamp ao redimensionar | hud |
| 12. Space persiste após blur | Cancela gesto/tecla e não arma pan em controles | input |

## Responsividade, arquitetura e interfaces

- O worker agora decodifica tiles visuais e chunks pelo mesmo port. Falhas de leitura não refazem fetch; fallback reaproveita bytes.
- Dois futuros mantêm resultado determinístico com lotes de cinco ticks, yield injetado pelo browser, progresso e descarte de resultado cancelado/superado. Terminal mantém execução síncrona. Testes comparam resultados e cancelamento.
- Hover/stroke atualizam custo e informações do mapa; mudanças relevantes atualizam HUD/painéis. Gesto ativo evita reconstrução completa por câmera e atualiza ao terminar. Teste conta chamadas reais da HUD.
- Scheduler recebe plataforma do host e distingue execução do callback de render efetivo. Movimento reduzido desativa animação decorativa e encerra glide, sem alterar ticks.
- Recursos opcionais detectam quota/persistência, memória, processadores e economia de dados, com fallback desconhecido. Memória baixa/economia usam cache de 48MiB e DPR máximo 1; demais usam 128MiB e DPR máximo 2. Sinais não alteram regras.
- Canvas focável oferece setas por células, Enter para aplicar/inspecionar, I para inspecionar e status textual. Mouse/touch conservam pinch, pan, cancelamento e tolerância CSS. Painéis fazem reflow.
- Terminal valida JSON cru; client aplica limite de 10.000 ticks e 1.024 células por intent. JSON quote/act anunciam as mesmas ações suportadas.
- Memo derivado tem LRU de 1.024 entradas; strokes usam Set. Bindings mortos foram removidos; parâmetros de contratos conservados. noUnusedLocals/noUnusedParameters agora fazem parte do check.
- Extrações pequenas: abertura de bancos, recursos locais e instalação do shell. DIP é reforçado pelo yield e scheduler injetados; responsabilidade de cache, input e UI continua separada. SOLID não exigiu introduzir classes.

## Revisão independente e decisões

A revisão independente encontrou e ajudou a corrigir assets antigos retidos porém não interceptados off-line, stream/provider continuando após destroy, receipts tardios, convites RTC simultâneos e startup reinstalando listeners após dispose. Último teste reproduziu a falha antes da guarda e passou depois.

As regressões principais tiveram RED/GREEN observado. Quatro testes adicionais de confirmação de receipts/refresh após stop foram escritos depois da correção; não são apresentados como RED/GREEN. O teste de lifecycle em startup e de hover também tiveram falha reproduzida.

Correção do relatório: `HistoryInfo.compare` contém dados, não callbacks. Removida essa conclusão incorreta. Manter modelos como dados já era uma qualidade do projeto.

## Validação final executada

- `npm run check`: 90 arquivos de teste; 775 aprovados, 5 ignorados; lint sem avisos e tipos aprovados.
- `npm run typecheck:core`: aprovado sem DOM.
- `npm run build`: aprovado; 220 módulos.
- `git diff --check`: aprovado.
- JS principal: 484,48kB / 171,02kB gzip. Baseline: 471,79kB / 166,50kB gzip. Houve aumento de bundle; esta entrega não afirma redução de tamanho.
- Benchmark do projeto no Chrome headless desta máquina: execução inicial cold 1.317,3ms/warm 13,2ms; repetição no build final cold 223,3ms/warm 15,7ms, session-ready warm 14,7ms e mapa warm 652,5ms. Orçamentos existentes de warm frame 1.200ms e sessão 800ms passaram. A variação cold inclui rede remota; não há ganho percentual ou garantia em celulares. [Resultados do build final](2026-10-04-browser-validation.json).
- Smoke real de produção: cache contém HTML, JS, CSS e map-worker; rede emulada off-line, reload ignorando cache HTTP; página controlada pelo SW, primeiro frame 10,9ms no build final. Viewport 390×844/DPR 2, setas produzem feedback de cursor. Screenshot inspecionado. Tiles ainda não guardados mostram erro recuperável; shell off-line não promete mapa mundial disponível.

## Limitações e próximos alvos

A revisão percorreu as camadas e pontos de entrada, mas não prova ausência de bugs. Safari/Firefox, leitor de tela real, dispositivos com pouca memória e WebRTC entre máquinas não foram exercitados; RTC foi validado com transport simulado. Os cinco testes já ignorados permanecem ignorados.

Recomendações exploratórias permanecem identificadas no relatório: benchmark de import/export de 64MiB, instrumentação p50/p95 de interação, qualidade adaptada a tempo medido de frame, divisão maior de city-client/world-repository, análise mais profunda de exports mortos e guardrails do grafo de imports. São trabalhos próprios, com medição/desenho antes de ampliar escopo; não foram substituídos por reescrita estética.

Decisões do shell e recursos foram conferidas na documentação oficial: [Cache.addAll](https://developer.mozilla.org/en-US/docs/Web/API/Cache/addAll), [ciclo do service worker](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API/Using_Service_Workers), [quota aproximada](https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/estimate), [persistência](https://developer.mozilla.org/docs/Web/API/StorageManager/persist).
