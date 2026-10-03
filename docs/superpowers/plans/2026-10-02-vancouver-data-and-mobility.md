# Vancouver Data and Mobility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Entregar Vancouver com fatos municipais verificáveis, veículos e pedestres em trajetos contínuos e mobilidade calibrada por observações disponíveis.

**Architecture:** Adaptadores produzem capturas datadas; o cliente escolhe cenário e fontes. Um motor transitório percorre uma rede de ruas e entrega posições aos renderizadores. Calibração econômica é uma ação explícita e determinística, separada das posições ao vivo.

**Tech Stack:** TypeScript, Canvas 2D, Vitest, Vite, importador GTFS existente e contratos de observação do projeto. Rotas e paradas vêm do GTFS estático; movimento dos ônibus é simulado e não exige dependência GTFS Realtime.

**Spec:** `docs/superpowers/specs/2026-10-02-vancouver-data-and-mobility-design.md`

## Global Constraints

- Vancouver significa o município identificado por Wikidata Q24639.
- Nenhum acesso de rede ou relógio externo deve entrar nesse núcleo.
- Posições transitórias não são gravadas por frame no histórico nem transmitidas como comandos.
- População, área e cada medida financeira têm proveniência própria.
- Orçamento anual não vira automaticamente dinheiro disponível do jogador.
- Nenhuma alegação de integração ao vivo testada sem observações reais recebidas.
- Regressão superior a 20% na mediana exige ajuste antes de concluir.
- Separar população censitária, estimativa populacional, orçamento aprovado, despesa realizada e plano plurianual.
- Não criar contas, contratar fornecedores ou supor chaves disponíveis. TransLink ao vivo indisponível não impede modo estimado.
- Manter figuras sem dados ausentes; preservar última captura válida com sua idade e território.

## Review Focus

1. Resposta de Vancouver chega depois de o usuário viajar: não substituir fatos da cidade nova (Tarefa 1).
2. Tiles duplicados, níveis distintos e mudança de zoom: evitar ruas e agentes duplicados, conexões falsas e reinícios do movimento (Tarefas 4 e 5).
3. Variantes e direções de uma linha: não misturar shapes nem paradas de percursos distintos (Tarefa 7).
4. Repetição de tiles ou importação do mesmo feed: não multiplicar ônibus nem desenhar rotas duplicadas (Tarefas 7 e 9).
5. Captura econômica alterada ou save antigo sem captura: não aplicar política silenciosa ou depender de rede no replay (Tarefa 3).

## Organização e dependências

Três blocos entregam software testável: **A, fatos e economia (1–3); B, rede e movimento (4–6); C, ônibus e observações (7–10)**. Executar sequencialmente; interfaces e validação visual dependem das etapas anteriores. O checkpoint final integra os três. A autorização anterior de execução inline descrita no plano de vida urbana é específica daquele trabalho; escolher execução deste plano na revisão.

Criar ou reutilizar worktree isolado na execução, conforme `using-git-worktrees`. Registrar commit-base, checks e cenas de desempenho antes de alterar produto. Não editar o checkpoint gráfico aprovado.

### Fontes e disponibilidade conhecida

- Prefeitura: orçamento final 2026 em `https://vancouver.ca/files/cov/2026-budget.pdf`. Captura normalizada conferida por página/tabela; nenhum valor financeiro foi extraído na fase de planejamento.
- Wikidata: Q24639; referência de censo municipal publicada em `https://vancouver.ca/news-calendar/our-city.aspx`.
- TransLink estático: página oficial `https://www.translink.ca/about-us/doing-business-with-translink/app-developer-resources/gtfs/gtfs-data` oferece link público de download e informa atualização semanal. Resolver o link da página, registrar data de publicação e período efetivo do feed. Não fixar URL de arquivo deduzida.
- Ônibus não exigem sincronização real: usar GTFS estático para trajetos e paradas, simular circulação pelo relógio do jogo. GTFS Realtime e chave de API estão fora desta entrega.
- Contagens: `https://opendata.vancouver.ca/explore/assets/intersection-traffic-movement-counts/view/` e VanMap indicado em `https://vancouver.ca/streets-transportation/traffic-count-data.aspx`. O catálogo existe, mas o formato de exportação automática não foi confirmado. Tarefa 8 verifica o recurso real antes de implementar parser; se não houver download acessível, aceitar importação de arquivo oficial e declarar cobertura indisponível até existir captura válida.
- Preservar termos declarados. Para dados TransLink, mostrar a atribuição exigida na página oficial e não reutilizar marca/logo como asset de ônibus. Termos não são convertidos em licença aberta genérica.

## Tipos compartilhados propostos

Definir em arquivos da tarefa responsável e exportar para consumidores; não repetir tipos entre adaptadores e cliente.

`src/adapters/reality/city.ts`: `MeasureSource = {dataset:string;url:string;license?:string;territoryId:string;retrievedAt:string;observedYear?:number;method:'reported'|'derived'|'simulated';reference?:string}`; `NumericMeasure = {value:number;unit:'people'|'km2'|'CAD';source:MeasureSource}`; `MunicipalFinance = {territoryId:string;fiscalYear:number;operating:NumericMeasure;capital?:NumericMeasure;status:'approved-budget'}`. Estender `CityFacts` preservando campos existentes e acrescentando `measures` e `finance` opcionais. Expor esses tipos via reexport em `src/client/facts.ts`.

`src/presentation/mobility-model.ts`: `MobilityKind='car'|'bus'|'truck'|'pedestrian'|'police'|'school-bus'`; `MobilityNode={id:string;point:Point;level:number}`; `MobilityEdge={id:string;from:string;to:string;path:readonly Point[];lengthM:number;roadClass:string;allowed:readonly MobilityKind[];method:'reported'|'derived'}`; `MobilityNetwork={revision:string;nodes:ReadonlyMap<string,MobilityNode>;edges:ReadonlyMap<string,MobilityEdge>;outgoing:ReadonlyMap<string,readonly string[]>}`; `MobilityAgent={id:string;kind:MobilityKind;route:readonly string[];edgeIndex:number;distanceM:number;speedMps:number;seed:number;tripId?:string}`; `MobilityFrameAgent={id:string;kind:MobilityKind;point:Point;heading:Point;seed:number;method:'simulated'|'observed';tripId?:string}`; `MobilityDemand={carsPerHour:number;trucksPerHour:number;walkersPerHour:number;method:'simulated'|'derived';sourcePeriod?:string}`. `Point` é o tipo existente de `src/presentation/camera.ts`; distâncias métricas são calculadas na latitude local, não em pixels.

## Tarefa 1: Fatos com proveniência por medida

**Files:** Modify `src/adapters/reality/city.ts`, `wikidata.ts`, `src/client/facts.ts`, `src/browser/main.ts`, `src/client/city-client.ts`; Create `src/client/facts-controller.ts`; Test `tests/wikidata.test.ts`, `tests/facts-controller.test.ts`.

**Interfaces:** Produz os tipos municipais acima e `createFactsController(port:FactsPort,onFacts:(facts:CityFacts|null)=>void):{named(name:string):Promise<void>;near(lat:number,lon:number):Promise<void>}`. Consulta guarda um identificador monotônico para descartar respostas antigas; cache é separado por consulta/território.

- [ ] Escrever testes `newest_non_deprecated_population`, `vancouver_country_identity`, `finance_does_not_replace_census_credit`, `late_vancouver_does_not_replace_lisbon`; neste último, resolver Lisboa antes da consulta pendente de Vancouver e afirmar que o callback final continua Lisboa.
- [ ] Executar `npx vitest run tests/wikidata.test.ts tests/facts-controller.test.ts`; confirmar falhas relacionadas ao contrato/comportamento novo.
- [ ] Centralizar tipos, filtrar ranking Wikidata depreciado e produzir medidas com ano/método. Preservar consumidores antigos enquanto a UI migra; cadastro Q24639 não deve virar uma população atual fixa.
- [ ] Executar testes alvo e `npm run typecheck`; confirmar PASS e ausência de erros de tipos.
- [ ] Commit: `feat: preserve municipal facts provenance`.

## Tarefa 2: Captura oficial do orçamento Vancouver

**Files:** Create `tools/vancouver-data.ts`, `src/adapters/reality/vancouver.ts`, `src/adapters/reality/data/vancouver-finance-2026.json`, `tests/vancouver-data.test.ts`, `docs/quality/2026-10-02/vancouver-data/source-audit.md`; Modify `src/browser/main.ts`.

**Interfaces:** `readVancouverFinance(value:unknown):MunicipalFinance` valida captura; `enrichVancouverFacts(facts:CityFacts,finance:MunicipalFinance):CityFacts` só associa mesmo território. Ferramenta atualiza captura a partir de valores conferidos, não usa extração heurística para publicar números sem revisão.

- [ ] Baixar PDF oficial, extrair tabelas com ferramenta local disponível e conferir visualmente página/tabela de operação e capital. Registrar valor original, unidade, normalização e URL no audit; conferir termos antes de incluir captura. Se a extração falhar, não preencher valores por aproximação.
- [ ] Escrever `reject_wrong_territory`, `reject_multiyear_as_annual`, `normalize_thousands_to_CAD`, `official_capture_matches_audit`; a fixture oficial usa os valores exatos conferidos no passo anterior.
- [ ] Executar `npx vitest run tests/vancouver-data.test.ts`; observar RED antes do adaptador.
- [ ] Implementar validação de valores finitos/não negativos, CAD, ano 2026, status e proveniência. Anexar orçamento apenas a Q24639; não misturar planilha de Metro Vancouver.
- [ ] Executar testes e typecheck; revisar JSON contra audit. Commit: `feat: add verified Vancouver municipal budget`.

## Tarefa 3: Calibração econômica explícita e replay

**Files:** Create `src/core/municipal-calibration.ts`, `tests/municipal-calibration.test.ts`; Modify `src/core/model.ts`, `commands.ts`, `simulation.ts`, `snapshot.ts`, `src/world/city-profile.ts`, `src/profiles/explorer/model.ts`, `tests/snapshot.test.ts`, `tests/economy.test.ts` e consumidores de versão encontrados por `rg 'RULES_VERSION|rulesVersion' src tests`.

**Interfaces:** `MunicipalCalibration={version:1;territoryId:string;fiscalYear:number;annualOperatingCad:number;population:number;gameUnitsPerCad:number;source:MeasureSource}`; `calibratedMonthlyExpense(population:number,calibration:MunicipalCalibration):number`; ação `Action` nova `{type:'municipal-calibration';calibration:MunicipalCalibration|null}`. Guardar em `city.economy.calibration`. Referência = `annualOperatingCad / population / 12`; fator inicial explícito `gameUnitsPerCad:0.01`, exibido na UI; arredondar resultado final. Essa referência substitui a base de despesas mensais por habitante quando ativa; fatores de serviços e juros atuais continuam separados. Receita mantém fórmula atual. Não aplicar capital anual ao saldo.

- [ ] Escrever `no_calibration_matches_rules4_ledger`, `explicit_action_keeps_cash_debt_tax`, `monthly_reference_uses_annual_per_capita`, `invalid_capture_rejected`, `offline_replay_matches`, `old_save_has_no_automatic_calibration`. Assert exemplo sintético: orçamento 1.200.000 CAD, população real 1.000, população simulada 100, fator 0.01 => referência mensal 100 unidades antes dos fatores de serviço.
- [ ] Executar `npx vitest run tests/municipal-calibration.test.ts tests/economy.test.ts tests/snapshot.test.ts`; confirmar RED dos novos comportamentos.
- [ ] Introduzir regras 5 para novas gravações; aceitar 1/3/4/5 e migrar preservando comportamento sem calibração. Preservar fixture e ledger conhecidos de regras 4. Rejeitar versões desconhecidas; registrar ação pelos mesmos comandos de política. Ajustar quote/replay e perfil para não descartar ação nova.
- [ ] Executar testes alvo, testes de comandos/perfis afetados e typecheck. Commit: `feat: add explicit municipal economy calibration`.

## Tarefa 4: Rede de mobilidade sobre geometria real

**Files:** Create `src/presentation/mobility-model.ts`, `mobility-network.ts`, `tests/mobility-network.test.ts`; Modify `src/presentation/geographic-map.ts` e parser geográfico localizado em `src/browser/geographic-stream.ts`/seu loader para reter atributos existentes de sentido, nível e identidade.

**Interfaces:** `buildGeographicNetwork(features:readonly GeographicFeature[],revision:string):MobilityNetwork`; `buildCellNetwork(cells:readonly {coord:CellCoord;cell:Cell}[],revision:string):MobilityNetwork`; `findMobilityRoute(network:MobilityNetwork,from:string,to:string,kind:MobilityKind):readonly string[]|null`.

- [ ] Escrever `connected_L_route`, `oneway_reverse_refused`, `bridge_not_surface_intersection`, `duplicate_tile_edge_once`, `cell_highway_excludes_walkers`, `disconnected_destination_returns_null`. Caminho A→B→C deve conter duas arestas conectadas; segmentos geométricos cruzados em níveis distintos não criam nó comum.
- [ ] Executar `npx vitest run tests/mobility-network.test.ts`; confirmar RED.
- [ ] Construir nós/arestas em espaço de mundo, deduplicar tiles por identidade/geometria e nível e usar índice espacial para conexões. Para nivel/sentido ausente, marcar derivação; não conectar pontes a ruas superficiais por mera proximidade. Não baixar dados por frame.
- [ ] Executar testes e geografia existente; typecheck. Commit: `feat: build connected mobility networks`.

## Tarefa 5: Movimento contínuo, filas e cruzamentos

**Files:** Create `src/presentation/mobility-engine.ts`, `tests/mobility-engine.test.ts`; Modify `src/presentation/clock.ts`, `src/client/city-client.ts` somente para ligar relógio/revisão.

**Interfaces:** `createMobilityEngine(network:MobilityNetwork,seed:number):MobilityEngine`; `MobilityEngine={setNetwork(network:MobilityNetwork):void;setDemand(demand:MobilityDemand):void;setAgents(agents:readonly MobilityAgent[]):void;advance(seconds:number):void;frame():readonly MobilityFrameAgent[]}`. `setAgents` reconcilia identidades, sem reiniciar agentes persistentes. Integração fixa 1/30 s, limite de catch-up 0.25 s por frame; distância mínima = metade de cada comprimento de veículo + 2 m. Comprimentos: carro 4.5 m, ônibus 12 m, caminhão 10 m; pedestre 0.5 m. Ciclo inferido de cruzamento: duas fases com verde de 20 s, amarelo de 3 s e limpeza de 2 s, identificado como simulado. Amarelo bloqueia novas entradas; agentes já dentro terminam a travessia. A Tarefa 13 liga esse estado ao desenho visível.

- [ ] Escrever `cross_edge_without_teleport`, `queue_respects_lengths`, `intersection_conflicting_agents_wait`, `pause_zero_seconds`, `resume_bounded_catchup`, `removed_edge_replans_or_exits`, `same_revision_does_not_restart`, `truck_and_walker_permissions`; afirmar separação mínima e continuidade no trajeto L da Tarefa 4.
- [ ] Executar `npx vitest run tests/mobility-engine.test.ts`; confirmar RED.
- [ ] Implementar movimento métrico e controle por faixa/interseção, manter geração limitada e semente estável. Movimento derivado do relógio atual da partida; câmera/zoom não altera identidade. Destinos sem rota não geram agente. Ativar caminhões em classe rápida/industrial e demanda estimada por hora de cenário.
- [ ] Executar testes alvo e regressões de pausa/relógio. Commit: `feat: simulate continuous street movement`.

## Tarefa 6: Desenho reconhecível nos dois mapas

**Files:** Create `src/surfaces/canvas/mobility-draw.ts`, `tests/mobility-draw.test.ts`; Modify `src/surfaces/canvas/street-renderer.ts`, `geographic-renderer.ts`, `canvas-renderer.ts`, `src/presentation/street-detail.ts`, `src/client/city-client.ts`.

**Interfaces:** `drawMobilityAgent(ctx:CanvasRenderingContext2D,agent:MobilityFrameAgent,projectPoint:(point:Point)=>Point,pixelsPerMetre:number,motion:number):void`; acrescentar frame de mobilidade opcional ao `WorldView` existente. Desenho usa heading projetado pela câmera, não diagonal fixa.

- [ ] Escrever `bus_longer_than_car`, `truck_distinct_cab_and_cargo`, `walker_legs_follow_motion`, `rotated_camera_preserves_heading`, `outside_view_culled`; validar operações Canvas significativas, não snapshot de cada chamada.
- [ ] Executar `npx vitest run tests/mobility-draw.test.ts tests/geographic-render.test.ts`; confirmar RED novo.
- [ ] Substituir agentes antigos na passagem ativa; conservar helpers de árvores/cruzamentos. Desenhar ônibus com janelas, caminhão com cabine/carga e pessoas com passos; projetar offsets de faixas/calçadas. Reusar buffers; limite inicial 480 agentes visíveis, reduzido para 120 no zoom distante, margem de rede de uma tela.
- [ ] Inspecionar Downtown com curva, travessia, pausa, câmera girada e zoom; salvar checkpoint. Executar regressões geográficas e typecheck. Commit: `feat: render visible urban mobility`.

## Tarefa 7: Ônibus circulando nas rotas reais TransLink

**Files:** Modify `src/adapters/reality/gtfs.ts`; Create `tools/vancouver-transit.ts`, `src/presentation/transit-routes.ts`, `src/adapters/reality/data/vancouver-transit.json`, `tests/transit-routes.test.ts`; Modify `tests/gtfs-source.test.ts`.

**Interfaces:** Estender `TransitTrip` com `shapeId?:string` e `directionId?:string`; `TransitContent` com `shapes:readonly {id:string;points:readonly {lat:number;lon:number;sequence:number;distance?:number}[]}[]`. `TransitRoutePattern={id:string;routeId:string;shapeId?:string;directionId?:string;edges:readonly string[];stopDistancesM:readonly number[];method:'reported'|'derived'}`; `buildTransitPatterns(dataset:TransitContent,network:MobilityNetwork):readonly TransitRoutePattern[]` agrupa variantes e preserva sequência de paradas. Shapes restringem matching à rede; sem match completo, emitir relatório e não desenhar conexão inventada.

- [ ] Resolver download oficial na página GTFS; conferir arquivo, limites atuais, cobertura/validade e termos. Produzir captura Vancouver com proveniência; não elevar limites ZIP sem medir bytes expandidos e justificar. Manter importação local se navegador não puder buscar por CORS.
- [ ] Escrever `shape_sequence_sorted`, `trip_shape_reference`, `opposite_directions_preserved`, `variants_do_not_mix_stops`, `duplicate_stop_same_position_safe`, `missing_shape_connected_fallback`, `no_connection_no_bus`, `same_pattern_imported_once`.
- [ ] Executar `npx vitest run tests/gtfs-source.test.ts tests/transit-routes.test.ts`; confirmar RED.
- [ ] Ampliar importador existente e mapear cada percurso conectado e suas paradas. Preservar calendários/horários sem usá-los para sincronizar a animação. Manter capabilities do importador; cálculo de percursos é consumidor separado.
- [ ] Executar testes e inspecionar geometria de uma linha em ambas as direções; conferir sequência de paradas contra o feed. Commit: `feat: load real Vancouver bus routes`.

## Tarefa 8: Calibração por contagens municipais

**Files:** Create `tools/vancouver-counts.ts`, `src/adapters/reality/vancouver-counts.ts`, `src/presentation/mobility-demand.ts`, `tests/vancouver-counts.test.ts`, `tests/mobility-demand.test.ts`; usar `src/adapters/reality/observation-file.ts` e `src/world/observations.ts` para capturas registradas.

**Interfaces:** `TrafficCount={id:string;lat:number;lon:number;from:string;to:string;direction?:number;vehicleClass:'car'|'truck'|'pedestrian'|'all-vehicles';count:number;source:MeasureSource}`; `parseVancouverCounts(value:unknown):readonly TrafficCount[]`; `calibrateDemand(network:MobilityNetwork,counts:readonly TrafficCount[],instant:string):ReadonlyMap<string,MobilityDemand>`.

- [ ] Verificar exportação real no catálogo/VanMap; registrar schema, unidades, período e acesso no source audit. Baixar amostra oficial antes de definir mapping do parser. Captura ausente não vira arquivo fictício; usar importação local e status indisponível se necessário.
- [ ] Escrever `hourly_count_not_speed`, `direction_match`, `outside_25m_unmatched`, `wrong_period_unused`, `all_vehicles_not_trucks`, `counts_to_hourly_rate`; exemplo sintético de 120 veículos em 15 min => 480/h, sem inferir velocidade ou divisão de caminhões.
- [ ] Executar testes alvo e observar RED. Implementar conversão de intervalo, matching máximo 25 m com sentido até 30° quando declarado; incompatibilidade não afeta via. Fonte agregada ajusta volume total sem inventar classe. Fora de cobertura, demanda continua estimada.
- [ ] Executar testes; guardar relatório de correspondências/rejeições e distinguir escala amostral de contagem oficial. Commit: `feat: calibrate mobility with traffic observations`.

## Tarefa 9: Movimento simulado dos ônibus nas rotas reais

**Files:** Create `src/presentation/transit-motion.ts`, `tests/transit-motion.test.ts`; Modify `src/presentation/mobility-engine.ts`, `mobility-model.ts`.

**Interfaces:** `routeBuses(patterns:readonly TransitRoutePattern[],seed:number):readonly MobilityAgent[]` gera identidades estáveis por percurso e slot. Estender `MobilityAgent` com `patternId?:string` e `stopsM?:readonly number[]`; motor preserva estado de parada. Usar até dois ônibus por percurso visível, com fase inicial espaçada; tempo de parada simulado 15 s. Ao terminar o percurso, sair no limite e regenerar no início, sem atravessar o mapa como se o destino fosse conectado à origem.

- [ ] Escrever `bus_follows_real_pattern`, `bus_stops_at_declared_stop`, `bus_dwell_15_simulated_seconds`, `pause_freezes_bus`, `game_acceleration_applies_to_bus`, `duplicate_pattern_does_not_multiply_fleet`, `route_end_does_not_teleport_across_city`, `changed_network_invalidates_pattern`.
- [ ] Executar `npx vitest run tests/transit-motion.test.ts tests/mobility-engine.test.ts`; observar RED.
- [ ] Integrar percursos e paradas ao motor da Tarefa 5, compartilhando filas e cruzamentos com carros. Frequência/posição são simuladas, sem consultar API de posições ou relógio real de serviço. Reconciliar IDs em vez de reiniciar frota a cada frame.
- [ ] Executar testes e visualizar ônibus percorrendo uma curva e fazendo parada; registrar evidência de pausa e aceleração. Commit: `feat: simulate buses along real TransLink routes`.

## Tarefa 10: Painel, integração, desempenho e revisão final

**Files:** Modify `src/browser/main.ts`, `index.html`, `src/browser/style.css`, `src/client/city-client.ts`, `src/surfaces/text/render.ts`; Create `src/client/mobility-controller.ts`, `tests/mobility-controller.test.ts`, `docs/quality/2026-10-02/vancouver-data/README.md`; Extend `tools/browser-perf.mjs` somente para registrar métricas necessárias.

**Interfaces:** `MobilityMode='estimated'|'calibrated'`; `MobilityStatus={mode:MobilityMode;available:boolean;sourcePeriod?:string;observedAt?:string;scenarioInstant:string}`; `createMobilityController(options:{seed:number;now:()=>string;onChange:()=>void}):{setCity(territoryId:string|null):void;setNetwork(network:MobilityNetwork):void;setTransit(dataset:TransitContent|null):void;setCounts(counts:readonly TrafficCount[]):void;setMode(mode:MobilityMode):void;setScenario(instant:string):void;advance(seconds:number):void;frame():readonly MobilityFrameAgent[];status():MobilityStatus;dispose():void}` conecta rede, movimento, percursos TransLink e contagens das tarefas anteriores. Cliente fornece frame ao renderizador; UI não calcula economia nem cria rotas.

- [ ] Escrever `city_change_clears_old_finance_and_agents`, `missing_counts_keeps_estimated_usable`, `paused_theme_still_renders`, `explicit_calibration_confirmation_contains_ratio`, `text_surface_preserves_fact_source`; verificar fonte/ano/CAD e razão 0.01 antes da ação, não solicitar aprovação extra ao desenvolvedor para essa UI de produto.
- [ ] Executar testes alvo; observar RED dos fluxos novos. Ligar painel compacto, movimento on/off, relógio de cenário e modos estimado/calibrado com disponibilidade real; fontes/atribuição clicáveis. Ônibus mostram “Rotas TransLink · movimento simulado” e data do feed; não oferecer sincronização ao vivo nesta entrega. Aplicar calibração somente pelo controle explícito do cenário, nunca na chegada de facts.
- [ ] Executar `npm run check` e `npm run build`; registrar PASS e warnings preexistentes. Reexecutar somente após mudanças/correções que justifiquem.
- [ ] Comparar versão-base e nova no bundle de produção, mesmo navegador/viewport/cenas, três medições de 30 s após aquecimento; reportar mediana do tempo de frame e agentes. Cenas: Downtown, corredor TransLink, industrial e via rápida regional. Não alegar rodovia municipal se cena está fora do limite de Vancouver.
- [ ] Capturar desktop e 390×844, curvas, fila, pedestres, ônibus parando, caminhões, pausa/retomada, zoom/câmera, globo e edição de via. Registrar dados indisponíveis e cobertura efetiva; confirmar população/orçamento contra audit.
- [ ] Se mediana piorar acima de 20%, ajustar limite/culling/cache e repetir medição afetada. Confirmar save existente/replay e que uma edição não teleporta agentes por água.
- [ ] Fazer revisão fresca do conjunto conforme método aprovado, corrigir achados com regressões pertinentes e repetir checks afetados. Commit final: `feat: complete Vancouver data and mobility experience`.
- [ ] Entregar branch, evidências e limitações verificadas. Publicar somente se houver autorização aplicável a esta entrega; a aprovação deste plano autoriza implementação, não presume contratação ou credenciais externas.

## Extensão solicitada: aviação (tarefas 11–12)

Executar depois da mobilidade terrestre e antes das verificações finais da Tarefa 10. A Tarefa 10 também cobre YVR, uma decolagem e um pouso completos, dia/noite e teto combinado de agentes. Não usar `MobilityKind` de ruas para aeronaves: precisam de altitude e ocupação de pistas, sem roteamento pelas ruas.

### Tarefa 11: Captura verificável de aeroporto, pistas e companhias

**Files:** Create `src/adapters/reality/airports.ts`, `src/adapters/reality/data/cyvr.json`, `tools/vancouver-airport.ts`, `tests/airports.test.ts`; adicionar fontes ao audit da Tarefa 2.

**Interfaces:** `AirportPoint={lat:number;lon:number}`; `AirportRunway={id:string;airportId:string;ends:readonly [AirportPoint,AirportPoint];endNames:readonly [string,string];lengthM:number;closed:boolean}`; `AirportAirline={code:string;name:string;colours:readonly string[];sourceUrl:string;representation:'stylized'}`; `AirportCapture={id:string;iata:string;name:string;position:AirportPoint;runways:readonly AirportRunway[];airlines:readonly AirportAirline[];sources:readonly {dataset:string;url:string;retrievedAt:string;license?:string}[]}`; `readAirportCapture(value:unknown):AirportCapture`.

- [ ] Baixar arquivos oficiais do projeto OurAirports a partir de `https://ourairports.com/data/`, selecionar CYVR e suas pistas, preservar unidades originais e converter pés para metros quando necessário. Conferir extremos/orientação/identificação contra material publicado pelo YVR. Registrar divergências em vez de escolher silenciosamente.
- [ ] Conferir companhias em `https://www.yvr.ca/en/passengers/flights/airlines-and-destinations`; criar catálogo inicial de jatos Air Canada/WestJet e operadores adicionais somente após validação. Não inferir modelo ou frequência real da companhia listada.
- [ ] Escrever `CYVR_runways_not_other_airport`, `feet_to_metres`, `invalid_endpoints_rejected`, `closed_runway_not_active`, `physical_runway_keeps_both_end_names`, `airline_source_preserved`; executar `npx vitest run tests/airports.test.ts` e observar RED.
- [ ] Implementar parser/captura com coordenadas, identificadores e proveniência; registrar fonte comunitária OurAirports e lista oficial YVR separadamente. Pinturas estilizadas são Canvas/code-native, sem baixar logos.
- [ ] Executar testes, typecheck e comparar captura com fontes/audit. Commit: `feat: add verified YVR airport and runway data`.

### Tarefa 12: Decolagens, pousos e desenho de aeronaves

**Files:** Create `src/presentation/aviation.ts`, `src/surfaces/canvas/aircraft-draw.ts`, `tests/aviation.test.ts`, `tests/aircraft-draw.test.ts`; Modify `src/client/city-client.ts`, `src/surfaces/canvas/canvas-renderer.ts`, `geographic-renderer.ts`, `src/browser/main.ts`.

**Interfaces:** `AircraftPhase='approach'|'landing-roll'|'waiting'|'takeoff-roll'|'climb'`; `AircraftFrame={id:string;airportId:string;airlineCode:string;phase:AircraftPhase;position:AirportPoint;headingDegrees:number;altitudeM:number;progress:number;colours:readonly string[]}`; `createAviationEngine(capture:AirportCapture,seed:number):{advance(seconds:number):void;frame():readonly AircraftFrame[];dispose():void}`; `drawAircraft(ctx:CanvasRenderingContext2D,aircraft:AircraftFrame,projectGround:(point:AirportPoint)=>Point,pixelsPerMetre:number):void`.

- [ ] Escrever `approach_aligned_with_runway`, `touchdown_continuous`, `takeoff_climbs_after_roll`, `runway_opposite_ends_share_reservation`, `crossing_runways_no_conflicting_occupancy`, `pause_freezes_aircraft`, `zoom_does_not_restart_flight`, `no_taxiways_no_terminal_crossing`, `airline_identity_stays_stable`; executar `npx vitest run tests/aviation.test.ts tests/aircraft-draw.test.ts` e observar RED.
- [ ] Implementar motor separado: limite de 8 aeronaves por aeroporto, passos de 1/30 s e catch-up máximo 0.25 s. Para referência visual simulada, aproximação final de 8 km e descida de 3°, corrida de decolagem em 60% da pista e subida de 5°; não rotular esses valores como procedimentos YVR. Reservar pista física e pistas geométricas conflitantes antes da aproximação final/corrida; no conflito, aguardar geração ou manter espera fora da pista. Não inventar taxiways: iniciar/finalizar operação na área da pista com transição suave fora da câmera quando não houver rede de solo.
- [ ] Desenhar silhueta de jato, cores por companhia, altitude com deslocamento vertical e sombra no solo; ordenar sombra junto ao chão e aeronave na passagem aérea. Usar projeção local em metros e adaptar detalhe ao zoom, mantendo custo limitado e pausa/velocidade coerentes com ônibus.
- [ ] Integrar ao `WorldView` com `aircraft?:readonly AircraftFrame[]`, fontes/inspeção e rótulo “Aeroporto e pistas reais · operações simuladas”. Em cenas sem cobertura do aeroporto, não preencher céu com aviões aleatórios.
- [ ] Executar testes/typecheck e inspeção YVR com pouso e decolagem completos, sombras, orientação de câmera, noite e zoom; repetir desempenho combinado e checks finais da Tarefa 10. Commit: `feat: animate airline takeoffs and landings at YVR`.

## Tarefa 13: Viaturas, sinais visíveis e transporte escolar

Executar após Tarefas 4–6 e antes dos checks finais da Tarefa 10. Tarefa 10 inclui cenas com vermelho/fila, travessia e ônibus escolar chegando a escola, além de viatura em patrulha.

**Files:** Create `src/presentation/traffic-signals.ts`, `src/presentation/school-transport.ts`, `src/adapters/reality/vancouver-schools.ts`, `tests/traffic-signals.test.ts`, `tests/school-transport.test.ts`; Modify `src/presentation/mobility-model.ts`, `mobility-engine.ts`, `src/surfaces/canvas/mobility-draw.ts`, `tests/mobility-draw.test.ts`, `src/client/mobility-controller.ts`; capturas de escolas/sinais em `src/adapters/reality/data/` somente após verificar fontes.

**Interfaces:** `TrafficSignalFrame={nodeId:string;point:Point;aspect:'red'|'amber'|'green';direction:Point;method:'reported'|'derived'}`; `MobilityEngine.signals():readonly TrafficSignalFrame[]` retorna o estado do mesmo controlador de interseção, sem animação independente. `SchoolSite={id:string;name:string;lat:number;lon:number;source:MeasureSource}`; `schoolBusAgents(schools:readonly SchoolSite[],network:MobilityNetwork,scenarioInstant:string,seed:number):readonly MobilityAgent[]`. Polícia usa tipo `police`, escolar usa `school-bus`; compartilhamento de permissões/comprimento com carro e ônibus respectivamente, sem permitir novos tipos em caminhos exclusivos de pedestres.

- [ ] Conferir escolas no diretório `https://vsb.bc.ca/school-directory-and-map` e sinais em `https://vancouver.opendatasoft.com/explore/dataset/traffic-signals/table/`. Capturar localização com fonte e data; se coordenada não for publicada, registrar geocodificação derivada e validar endereço antes de associar à rede. Não importar Vancouver, Washington nem residências de estudantes.
- [ ] Escrever `red_holds_queue`, `amber_blocks_new_entry`, `signal_frame_matches_permission`, `pedestrian_phase_no_vehicle_conflict`, `curve_has_no_signal`, `police_uses_connected_patrol_and_respects_red`, `school_bus_ends_at_verified_school`, `school_route_is_simulated`, `school_peak_windows`, `school_bus_stop_holds_following_traffic`, `police_and_school_bus_visually_distinct`.
- [ ] Executar `npx vitest run tests/traffic-signals.test.ts tests/school-transport.test.ts tests/mobility-engine.test.ts tests/mobility-draw.test.ts`; confirmar RED.
- [ ] Desenhar poste e três luzes orientados à via; controlador é fonte única da cor e passagem. Matching municipal até 25 m do nó compatível, sem ligar sinais a vias em níveis distintos. Demais sinais inferidos têm método derivado. Compartilhar tempo e pausa com agentes; travessia recebe fase exclusiva quando movimentos são conflitantes.
- [ ] Gerar viaturas com pintura estilizada e barra de luzes, limite de duas no envelope visível, patrulha conectada sem emergência permanente. Gerar ônibus escolares amarelos com identidade/portas/janelas próprias, 9 m de comprimento simulado, no máximo um por escola visível e seis no total. Janelas do cenário em dias úteis: 07:30–09:00 e 14:30–16:30, explicitamente simuladas; não afirmar calendário letivo real. Usar paradas sintéticas públicas no caminho à escola, dwell de 20 s e retenção de seguidores na faixa durante embarque; nenhum endereço de aluno.
- [ ] Ligar rótulos/inspeção de escola e fonte; preservar freio/fila em vez de sobrepor ônibus a veículos. Comparar visualmente viatura, ônibus urbano e escolar em zoom próximo, pausa e noite.
- [ ] Executar testes/typecheck, atualizar checkpoints e desempenho combinado da Tarefa 10. Commit: `feat: add police patrols traffic signals and school buses`.

## Autorrevisão do plano

Cobertura: fontes/proveniência 1–2; economia/saves 3; redes e continuidade 4–5; distinção visual/desempenho 6/10; GTFS/variantes/direções 7; contagens e cobertura 8; ônibus simulados/paradas/duplicação 9; painel e validação final 10. Cada tipo consumido tem produtor definido acima; Graph e posições usam espaço de mundo, unidades métricas aparecem separadas. As cinco falhas de Review Focus têm testes nas tarefas indicadas. Disponibilidade de download de contagens e extração de finanças são verificações explícitas que precedem capturas, não pressupostos de dados já disponíveis.

Exemplos de assertions que fixam decisões das tarefas 3 e 4 (fixtures sintéticas, não orçamento oficial):

```ts
expect(calibratedMonthlyExpense(100, {
  version: 1, territoryId: 'Q24639', fiscalYear: 2026,
  annualOperatingCad: 1_200_000, population: 1_000,
  gameUnitsPerCad: 0.01, source: syntheticSource,
})).toBe(100);
expect(findMobilityRoute(disconnectedNetwork, 'A', 'C', 'car')).toBeNull();
expect(findMobilityRoute(lNetwork, 'A', 'C', 'car')).toEqual(['AB', 'BC']);
```

## Revisão e execução

O usuário revisa este plano antes da implementação e escolhe execução nativa ou com subagentes. Recomendação: **nativa**, pois o trabalho depende fortemente dos mesmos contratos de rede, fatos e relógio; implementar em sequência facilita manter esses contratos coerentes. Revisão independente ao final conforme a habilidade de execução aplicável. Este arquivo acompanha o código e marca passos somente quando houver evidência.


## Extensão solicitada: navegação marítima

Executar depois do contrato compartilhado de movimento, antes da verificação final. Esta extensão está registrada; nenhuma tarefa abaixo foi concluída.

### Captura de fontes e rede aquática

- [ ] Capturar terminais SeaBus e docas/conexões Aquabus com fonte, data e operador. Inspecionar GTFS para ferries e shapes; complementar apenas com percurso verificado quando ausente.
- [ ] Capturar Canada Place, berços, calendário vigente de cruzeiros, terminais de carga e marinas. Não reutilizar calendário 2025 como atual. Preservar fronteiras municipais nos fatos.
- [ ] Definir contrato de embarcações e rede aquática independente de ruas, distinguindo cargueiro, cruzeiro, veleiro, SeaBus e Aquabus; incluir porte, corredor, doca e estado operacional.
- [ ] Validar trajetos contra terra, canais e restrições de pontes; corredores de navios grandes precisam de verificação específica. Falta de percurso seguro impede gerar o trajeto.

### Motor e desenho marítimo

- [ ] Cobrir continuidade, ausência de cruzamento terrestre, reserva de berço, parada nos terminais, resposta à pausa e estabilidade em mudança de zoom com testes de comportamento.
- [ ] Implementar aproximação, atracação, espera e partida; reservar berços e escalonar entrada de navios grandes. Veleiros usam passeios explicitamente simulados, passageiros usam conexões reais.
- [ ] Desenhar silhuetas distintas, velas, conveses, contêineres e cores dos operadores confirmados; adicionar esteira discreta enquanto se movem, orientação e detalhe por zoom.
- [ ] Aplicar teto de agentes e tempo compartilhado; preservar replays sem gravação de posições por frame.
- [ ] Exibir fontes/temporada e “Rotas e terminais reais · movimentos simulados”. Calendário previsto não equivale a posição AIS ao vivo.
- [ ] Verificar no navegador cenas de Canada Place, Burrard Inlet e False Creek; registrar captura e desempenho com trânsito terrestre e aviões ativos.


### Complemento marítimo: BC Ferries com programação oficial

- [ ] Capturar fontes oficiais por rota/direção/data de serviço, terminais, escalas, período de vigência, saídas/chegadas e corredor verificado. Registrar fuso/offset aplicável e procedência; não promover mapa esquemático a traçado exato.
- [ ] Validar disponibilidade dos arquivos e condições de acesso. Página de horários encontrou fila Queue-it na pesquisa; API pública/CORS não estão comprovados. Não usar proxies públicos nem contornar bloqueios.
- [ ] Implementar adaptador de programação com calendário, exceções, viagens noturnas e expiração. Não gerar partidas por intervalo inventado ou copiar temporada anterior fora de validade.
- [ ] Implementar relógio civil para BC Ferries independente do multiplicador econômico; pausa visual e retomada recalculam progresso previsto. Separar modo cenário e “posição estimada pelo horário oficial” de tracking real.
- [ ] Verificar atraso/cancelamento somente se fonte dinâmica puder ser lida e validada; sem isso conservar rótulo de horário previsto e última captura.
- [ ] Cobrir horário por data/direção, escalas, meia-noite, temporada expirada, offset, pausa/retomada e ausência de duplicação; comparar uma viagem animada com a tabela original no navegador.
