# Vancouver Data, Terrain and Mobility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Entregar Vancouver com demografia e finanças verificáveis, relevo real visível, ruas com veículos/pedestres, transporte em rotas reais, navegação marítima e aviões; usar fontes reutilizáveis por cidade sem backend próprio em runtime.

**Architecture:** Capturas versionadas alimentam contratos puros de fatos, terreno e transporte; adaptadores consultam fornecedores e o cliente escolhe fontes pela cobertura. Terreno elevado fornece projeção/apoio comum aos renderizadores e às redes de movimento; motores terrestre, marítimo e aéreo mantêm posições transitórias. BC Ferries possui relógio civil e programação oficial, separado do relógio da economia; calibração econômica continua uma ação explícita e reproduzível.

**Tech Stack:** TypeScript, Canvas 2D, Vitest, Vite, GTFS existente; ferramentas locais de captura e conversão raster. Preferir GDAL disponível na máquina para GeoTIFF/reprojeção, registrando versão; instalação de ferramenta de desenvolvimento só se necessária. Nenhuma dependência geoespacial pesada no bundle do navegador.

**Spec:** `docs/superpowers/specs/2026-10-02-vancouver-data-and-mobility-design.md`. Fontes e fundamentos: `docs/quality/2026-10-02/vancouver-data/source-coverage.md`, `terrain-sources.md`, `browser-source-feasibility.md`.

## Global Constraints

- Vancouver significa o município identificado por Wikidata Q24639; cenas regionais não mudam sua demografia.
- Nenhum acesso de rede ou relógio externo deve entrar nesse núcleo.
- Posições transitórias não são gravadas por frame no histórico nem transmitidas como comandos.
- População, área e cada medida financeira têm proveniência própria.
- Orçamento anual não vira automaticamente dinheiro disponível do jogador.
- Nenhuma alegação de integração ao vivo testada sem observações reais recebidas.
- Regressão superior a 20% na mediana exige ajuste antes de concluir.
- Separar população censitária, estimativa populacional, orçamento aprovado, despesa realizada e plano plurianual.
- Não criar contas, contratar fornecedores ou supor chaves disponíveis. TransLink ao vivo indisponível não impede modo estimado.
- Manter figuras sem dados ausentes; preservar última captura válida com sua idade e território.
- Altitude física em metros, escala vertical 1:1; solo (DTM) não é telhado/copa (DSM). Preservar datum e no-data.
- Ruas, edifícios, picking e agentes usam o mesmo terreno; pontes/túneis têm nível próprio. DEM terrestre não fornece profundidade navegável.
- BC Ferries respeita programação oficial da data/direção e fuso da rota; posição calculada do horário é estimada, não AIS.
- Respeitar `tests/architecture.test.ts`: tipos consumidos por core/world/presentation/client não podem ser importados de adapters. Presentation não importa client. Adaptadores implementam contratos puros, browser faz a ligação.
- Nenhuma conta ou aprovação adicional é necessária para capturar fonte pública disponível; indisponibilidade de dados exige alternativa documentada, nunca número ou trajeto inventado apresentado como oficial.

## Review Focus

1. Homônimos, geografia regional, períodos diferentes e respostas atrasadas: município/censo correto permanece na tela (2–4).
2. No-data, DSM, datum e limites de tiles: terreno sem picos falsos, emendas ou edifícios elevados duas vezes (7–9).
3. Tiles duplicados, zoom, pontes e alterações da rede: nenhuma duplicação de agente/conexão falsa/teleporte (10–14).
4. Programação vencida, exceções, mudança de offset, pausa e meia-noite: BC Ferries não cria partidas erradas (19).
5. Save antigo, captura alterada e erro de fonte: replay sem rede preserva política e modo sem dados continua utilizável (6/22).

## Estado e execução

Plano consolidado em 2026-10-02. A correção de população real e o indicador secundário “Moradores do bairro simulado” já estão implementados nos commits dd4c3b1/da55deb; não refazer nem marcar as demais tarefas como concluídas. Os 697 testes passaram na verificação anterior com cinco skips; isso é baseline histórico, não prova destas funcionalidades futuras.

Executar na ordem numérica abaixo. Blocos entregáveis: **A dados (1–6), B relevo (7–9), C ruas (10–16), D navegação (17–19), E aviação (20–21), F integração (22)**. Cada bloco termina em software testável; não esperar todos para inspecionar o resultado. Recomendação de execução: nativa, com revisão independente final, pois projeção, geometria e relógios compartilham contratos. Criar/reutilizar worktree conforme using-git-worktrees ao começar implementação, preservando estado atual.

## Fontes e alternativas já decididas

| Capacidade | Fonte prioritária | Alternativa/limite de entrega |
|---|---|---|
| Identidade mundial | Wikidata + OSM | Sem campo: indisponível; não copiar dado de cidade homônima |
| Demografia Canadá | StatCan Census Profile, código CSD/DGUID | Captura oficial distribuída no site; Wikidata datado como fallback identificado |
| Estimativa BC | BC Stats, arquivo municipal | Censo e estimativa ficam separados; sem registro correspondente, conservar censo |
| Finanças | Orçamento final municipal; BC LGDE para realizado histórico | Sem valor conferido, mostrar indisponível; nunca converter realizado em aprovado |
| Terreno BC/Canadá | DTM LidarBC/HRDEM por cobertura; MRDEM nacional | Global Copernicus DSM como paisagem limitada; sem dado urbano de solo, sinalizar limitação e não declarar cota de fundação oficial |
| Terreno mundial | Copernicus GLO-30/GLO-90 | Preparar recorte estático; não prometer toda cidade previamente empacotada |
| Ônibus | GTFS do operador coberto; TransLink para Vancouver | Captura local quando CORS falha; sem percurso conectado não gerar ônibus da linha |
| Trânsito | Contagens municipais verificadas; obras Vancouver/DriveBC pertinentes | Sem contagens legíveis, movimento estimado; contagem não é velocidade ao vivo |
| SeaBus/Aquabus | Terminais/conexões publicados por cada operador | Traçado só após verificar corredor; movimento simulado identificado |
| BC Ferries | Programação oficial vigente por data e rota | Captura oficial local conferida; sem captura válida recurso de horários fica indisponível, não usar frequência sintética |
| Cruzeiros/carga | Porto/calendário vigente/terminais | Operações simuladas; calendário 2025 não vale para 2026; AIS não é requisito sem fornecedor validado |
| Aviões | OurAirports, conferência YVR e operadores oficiais | Operações simuladas; OpenSky/ADSB sem CORS validado não viram feed direto |

Fontes em modo direto só são ativadas após teste de CORS/termos na origem do site. Capturas grandes são recortadas antes do build. Nenhum fallback crítico depende de serviço pago/chave. Para fontes ainda não baixadas, a tarefa de captura tem saída binária: arquivo conferido ou capacidade indisponível com motivo auditado; não bloqueia capacidades independentes, nem autoriza declarar o recurso entregue.

## Contratos compartilhados

`src/core/municipal-facts.ts` é a definição única de `CityFacts`, `MeasureSource`, `NumericMeasure`, `MunicipalFinance`, `CityIdentity` e `DemographicObservation`; adapters/reality/city.ts e client/facts.ts reexportam esses contratos. `MeasureSource={dataset:string;url:string;license?:string;territoryId:string;retrievedAt:string;observedYear?:number;method:'reported'|'derived'|'simulated';reference?:string}`; `NumericMeasure={value:number;unit:'people'|'km2'|'CAD';source:MeasureSource}`; `MunicipalFinance={territoryId:string;fiscalYear:number;operating:NumericMeasure;capital?:NumericMeasure;status:'approved-budget'}`. Estender `CityFacts` sem remover os campos atuais, com `measures`, `finance` e `demographics` opcionais. A fonte antiga não substitui a fonte individual da medida nova.

`src/core/transit-data.ts` guarda os tipos de conteúdo GTFS hoje no adaptador, reexportados sem duplicação por `adapters/reality/gtfs.ts`; presentation pode consumir os tipos puros. `src/presentation/mobility-model.ts` guarda os contratos de movimento terrestre das tarefas 10–16: `MobilityKind='car'|'bus'|'truck'|'pedestrian'|'police'|'school-bus'`; nodes/edges com identidade, Point, level, sequência geométrica, comprimento em metros, permissões e método. `MobilityAgent` preserva id, route, edgeIndex, distanceM, speedMps, seed e tripId opcional; `MobilityFrameAgent` acrescenta altura absoluta `elevationM:number|null`, heading, método e seed. `MobilityDemand={carsPerHour:number;trucksPerHour:number;walkersPerHour:number;method:'simulated'|'derived';sourcePeriod?:string}`. Tipos completos são definidos pela tarefa 10 antes dos consumidores.

Tipos puros de terreno ficam em presentation/terrain-model.ts; contratos geográficos capturados de navegação em core/maritime-data.ts. Códigos oficiais e coordenadas não podem ser confundidos com Point do mapa; conversão fica em presentation. Alturas de solo, deck, nível de água e aeronave são metros no mesmo datum validado para cada cena.

## Tarefa 1: Baseline e checkpoint reproduzível

**Files:** Create `docs/quality/2026-10-02/vancouver-data/baseline.md`; usar `tools/browser-perf.mjs` existente sem automação alternativa de browser.

**Interfaces:** Baseline registra commit-base, viewport, câmera, cena, build, contagens, tempo de frame e evidência visual; nenhuma mudança de produto.

- [ ] Inspecionar git/worktrees e criar/reutilizar checkout isolado; registrar commit-base e preservação dos commits demográficos já feitos.
- [ ] Executar `npm run check` e `npm run build`. Se o teste de armazenamento reproduzir rejeição não tratada, registrar nome/causa e rodar suíte com `--maxWorkers=2`; não ocultar falha nem chamar default check verde.
- [ ] Registrar três medições de 30 s após aquecimento por cena no bundle de produção: Downtown, corredor ônibus, industrial, via rápida regional, False Creek, Canada Place, North Shore e YVR. Mesmo viewport nas comparações; desktop 1440×900 e validação funcional 390×844.
- [ ] Salvar screenshots com navegador nativo e parâmetros reproduzíveis; distinguir qualquer asset/gráfico ainda plano da futura entrega.
- [ ] Commit: `docs: record data terrain mobility baseline`.


## Tarefa 2: Seleção de fontes por cobertura e identidade

**Files:** Create `src/core/municipal-facts.ts` (CityIdentity), `src/core/source-capabilities.ts`, `src/client/source-selection.ts`, `tests/source-selection.test.ts`; Modify `src/browser/main.ts`.

**Interfaces:** `CityIdentity={qid:string;name:string;countryCode:string;provinceCode?:string;officialCode?:string;dguid?:string;geography:'municipality'|'metro'|'province';boundaryVersion?:string}` em core/municipal-facts.ts. `SourceCapability={id:string;scope:'global'|'country'|'province'|'operator';countries?:readonly string[];provinces?:readonly string[];territoryIds?:readonly string[];datasets:readonly string[];access:'bundled'|'direct'|'unverified'|'requires-backend'}`; `selectSources(city:CityIdentity,catalog:readonly SourceCapability[]):readonly SourceCapability[]`. Provider de operador requer whitelist de território/serviço verificada, não aproximação por país.

- [ ] Escrever testes `vancouver_layers`, `victoria_excludes_translink_aquabus`, `toronto_excludes_bc`, `lisbon_excludes_statcan`, `same_name_wrong_country_rejected`, `unverified_not_enabled_direct`. Assertion de referência (fixture sintética, salvo indicação de captura oficial):

```ts
expect(selectSources(victoria, catalog).map(s=>s.id)).not.toContain('translink');
```

- [ ] Executar `npx vitest run tests/source-selection.test.ts`; confirmar RED por comportamento/contrato ausente.
- [ ] Implementar catálogo declarativo a partir de source-coverage.md; incluir OSM/Wikidata/elevação global, StatCan para CA, BC Stats/LGDE/DriveBC para CA-BC, providers locais apenas por cobertura publicada. Browser injeta URLs/adaptadores, client seleciona capacidades. Limites CSD servem a seleção geográfica quando capturados; até lá posição solicitada preserva âncora e qualidade aproximada, sem alegar polígono oficial.
- [ ] Executar `npx vitest run tests/source-selection.test.ts` e `npm run typecheck`; confirmar PASS. Conferir seleção para Vancouver, Victoria, Toronto e Lisboa sem chamadas de rede nos testes.
- [ ] Commit: `feat: select data providers by city coverage`.


## Tarefa 3: Fatos com proveniência por medida

**Files:** Modify `src/core/municipal-facts.ts`, `src/adapters/reality/city.ts`, `wikidata.ts`, `src/client/facts.ts`, `src/browser/main.ts`, `src/client/city-client.ts`; Create `src/client/facts-controller.ts`; Test `tests/wikidata.test.ts`, `tests/facts-controller.test.ts`.

**Interfaces:** Produz os tipos municipais acima e `createFactsController(port:FactsPort,onFacts:(facts:CityFacts|null)=>void):{named(name:string):Promise<void>;near(lat:number,lon:number):Promise<void>}`. Consulta guarda um identificador monotônico para descartar respostas antigas; cache é separado por consulta/território.

- [ ] Escrever testes `newest_non_deprecated_population`, `vancouver_country_identity`, `finance_does_not_replace_census_credit`, `late_vancouver_does_not_replace_lisbon`; neste último, resolver Lisboa antes da consulta pendente de Vancouver e afirmar que o callback final continua Lisboa.
- [ ] Executar `npx vitest run tests/wikidata.test.ts tests/facts-controller.test.ts`; confirmar falhas relacionadas ao contrato/comportamento novo.
- [ ] Centralizar tipos puros em core/municipal-facts.ts, reexportar para manter compatibilidade, filtrar ranking Wikidata depreciado e produzir medidas com ano/método. Preservar consumidores antigos enquanto a UI migra; cadastro Q24639 não deve virar uma população atual fixa.
- [ ] Executar testes alvo e `npm run typecheck`; confirmar PASS e ausência de erros de tipos.
- [ ] Commit: `feat: preserve municipal facts provenance`.

## Tarefa 4: Demografia oficial canadense e estimativas BC

**Files:** Create `src/adapters/reality/statcan.ts`, `bc-stats.ts`, `tools/canada-demography.ts`, `src/adapters/reality/data/vancouver-demography.json`, `tests/canada-demography.test.ts`, `docs/quality/2026-10-02/vancouver-data/source-audit.md`; Modify `src/client/facts-controller.ts`, `src/browser/main.ts`, `index.html`, `src/surfaces/text/render.ts`.

**Interfaces:** `DemographicObservation={key:'population'|'age-share'|'households'|'household-size'|'median-income'|'employment-rate'|'commute-share';category?:string;value:number;unit:'people'|'households'|'persons-per-household'|'CAD'|'percent';period:string;geographyId:string;kind:'census'|'estimate'|'projection';quality:readonly string[];source:MeasureSource}`. `readStatCanCapture(value:unknown,city:CityIdentity):readonly DemographicObservation[]`; `readBcStatsCapture(value:unknown,city:CityIdentity):readonly DemographicObservation[]`; `mergeDemographics(facts:CityFacts,observations:readonly DemographicObservation[]):CityFacts` conserva censo e estimativa separados; medida principal é censo oficial confirmado, estimativa em linha própria, nunca projeção automática.

- [ ] Escrever testes `vancouver_csd_5915022`, `census_662248_2021`, `metro_total_not_city`, `income_reference_year_preserved`, `suppressed_is_missing`, `estimate_does_not_relabel_census`, `age_categories_not_double_counted`, `percent_denominator_preserved`, `missing_bc_keeps_statcan`. Assertion de referência (fixture sintética, salvo indicação de captura oficial):

```ts
expect(readStatCanCapture(officialVancouverCapture,vancouver).find(o=>o.key==='population')).toMatchObject({value:662248,period:'2021',geographyId:'2021A00055915022',kind:'census'});
```

- [ ] Executar `npx vitest run tests/canada-demography.test.ts tests/demography.test.ts tests/facts-controller.test.ts`; confirmar RED por comportamento/contrato ausente.
- [ ] Capturar Census Profile para DGUID 2021A00055915022 e CSV municipal BC Stats usando links oficiais do catálogo. Auditar população, idade, domicílios, renda, emprego e deslocamentos com seus próprios períodos/denominadores/notas. Captura ausente por variável permanece ausente. Juntar por CSD/DGUID/QID verificados. Preservar população principal, fonte por medida e leitura offline; expor dados adicionais no painel Lugares com ano/tipo, sem encher o HUD. Moradores do bairro permanece apenas indicador de gestão. Commute calibra perfil agregado opcional, nunca posição/trânsito atual.
- [ ] Executar `npx vitest run tests/canada-demography.test.ts tests/demography.test.ts tests/facts-controller.test.ts` e `npm run typecheck`; confirmar PASS. Conferir captura municipal e metadados originais em source-audit.md; sem captura oficial validada não publicar valores sintéticos.
- [ ] Commit: `feat: add official Canadian municipal demographics`.


## Tarefa 5: Captura oficial do orçamento Vancouver

**Files:** Create `tools/vancouver-data.ts`, `src/adapters/reality/vancouver.ts`, `src/adapters/reality/data/vancouver-finance-2026.json`, `tests/vancouver-data.test.ts`; Modify `docs/quality/2026-10-02/vancouver-data/source-audit.md`, `src/browser/main.ts`; Create `src/adapters/reality/bc-finance.ts`, `tests/bc-finance.test.ts` para relatório histórico LGDE.

**Interfaces:** `readBcMunicipalActuals(value:unknown,city:CityIdentity):readonly {year:number;revenueCad?:number;expenseCad?:number;status:'actual';source:MeasureSource}[]` mantém histórico realizado distinto de `MunicipalFinance`. `readVancouverFinance(value:unknown):MunicipalFinance` valida captura; `enrichVancouverFacts(facts:CityFacts,finance:MunicipalFinance):CityFacts` só associa mesmo território. Ferramenta atualiza captura a partir de valores conferidos, não usa extração heurística para publicar números sem revisão.

- [ ] Capturar relatório financeiro municipal BC LGDE disponível e rejeitar como orçamento aprovado; preservar ano, unidade e município em testes `bc_actual_not_approved_budget` e `bc_wrong_municipality`. Baixar PDF oficial, extrair tabelas com ferramenta local disponível e conferir visualmente página/tabela de operação e capital. Registrar valor original, unidade, normalização e URL no audit; conferir termos antes de incluir captura. Se a extração falhar, não preencher valores por aproximação.
- [ ] Escrever `reject_wrong_territory`, `reject_multiyear_as_annual`, `normalize_thousands_to_CAD`, `official_capture_matches_audit`; a fixture oficial usa os valores exatos conferidos no passo anterior.
- [ ] Executar `npx vitest run tests/vancouver-data.test.ts`; observar RED antes do adaptador.
- [ ] Implementar validação de valores finitos/não negativos, CAD, ano 2026, status e proveniência. Anexar orçamento apenas a Q24639; não misturar planilha de Metro Vancouver.
- [ ] Executar testes e typecheck; revisar JSON contra audit. Commit: `feat: add verified Vancouver municipal budget`.

## Tarefa 6: Calibração econômica explícita e replay

**Files:** Create `src/core/municipal-calibration.ts`, `tests/municipal-calibration.test.ts`; Modify `src/core/model.ts`, `commands.ts`, `simulation.ts`, `snapshot.ts`, `src/world/city-profile.ts`, `src/profiles/explorer/model.ts`, `tests/snapshot.test.ts`, `tests/economy.test.ts` e consumidores de versão encontrados por `rg 'RULES_VERSION|rulesVersion' src tests`.

**Interfaces:** `MunicipalCalibration={version:1;territoryId:string;fiscalYear:number;annualOperatingCad:number;population:number;gameUnitsPerCad:number;source:MeasureSource}`; `calibratedMonthlyExpense(population:number,calibration:MunicipalCalibration):number`; ação `Action` nova `{type:'municipal-calibration';calibration:MunicipalCalibration|null}`. Guardar em `city.economy.calibration`. Referência = `annualOperatingCad / population / 12`; fator inicial explícito `gameUnitsPerCad:0.01`, exibido na UI; arredondar resultado final. Essa referência substitui a base de despesas mensais por habitante quando ativa; fatores de serviços e juros atuais continuam separados. Receita mantém fórmula atual. Não aplicar capital anual ao saldo.

- [ ] Escrever `no_calibration_matches_rules4_ledger`, `explicit_action_keeps_cash_debt_tax`, `monthly_reference_uses_annual_per_capita`, `invalid_capture_rejected`, `offline_replay_matches`, `old_save_has_no_automatic_calibration`. Assert exemplo sintético: orçamento 1.200.000 CAD, população real 1.000, população simulada 100, fator 0.01 => referência mensal 100 unidades antes dos fatores de serviço.
- [ ] Executar `npx vitest run tests/municipal-calibration.test.ts tests/economy.test.ts tests/snapshot.test.ts`; confirmar RED dos novos comportamentos.
- [ ] Conferir RULES_VERSION do commit-base: se permanece 4, introduzir regras 5 e aceitar 1/3/4/5; se mudou, escolher próxima versão sem colisão e registrar migração equivalente. Migrar preservando comportamento sem calibração. Preservar fixture e ledger conhecidos de regras 4. Rejeitar versões desconhecidas; registrar ação pelos mesmos comandos de política. Ajustar quote/replay e perfil para não descartar ação nova.
- [ ] Executar testes alvo, testes de comandos/perfis afetados e typecheck. Commit: `feat: add explicit municipal economy calibration`.

## Tarefa 7: Captura e normalização de elevação real

**Files:** Create `tools/terrain-capture.ts`, `src/presentation/terrain-model.ts`, `src/adapters/map/terrain-source.ts`, `src/adapters/map/data/vancouver-terrain/manifest.json`, `tests/terrain-source.test.ts`, `docs/quality/2026-10-02/vancouver-data/terrain-audit.md`.

**Interfaces:** `TerrainTile={id:string;bounds:{west:number;south:number;east:number;north:number};size:number;spacingM:number;heightsM:Float32Array;valid:Uint8Array;kind:'dtm'|'dsm';verticalDatum:string;sourceId:string}`; `TerrainManifest={version:1;tiles:readonly {id:string;url:string;bytes:number;bounds:{west:number;south:number;east:number;north:number};spacingM:number}[];sources:readonly {id:string;url:string;retrievedAt:string;license:string;kind:'dtm'|'dsm';horizontalCrs:string;verticalDatum:string;resolutionM:number}[]}`. `decodeTerrainTile(bytes:Uint8Array,manifest:TerrainManifest):TerrainTile`; `createTerrainSource(fetchBytes:(url:string,signal:AbortSignal)=>Promise<Uint8Array>,manifest:TerrainManifest):{load(id:string,signal:AbortSignal):Promise<TerrainTile>}`. Captura exporta grid 65×65 com borda compartilhada, Float32 little-endian + valid mask, compressão HTTP do host, CRS horizontal WGS84 e datum vertical único escolhido no audit após verificar transformação disponível.

- [ ] Escrever testes `nodata_not_zero`, `dsm_keeps_quality_flag`, `wrong_vertical_datum_rejected`, `tile_shared_border_equal`, `corrupt_length_rejected`, `unavailable_high_resolution_falls_back`, `no_capture_no_real_terrain_claim`. Assertion de referência (fixture sintética, salvo indicação de captura oficial):

```ts
expect(decodeTerrainTile(tileWithMissingSample,manifest).valid[missingIndex]).toBe(0);
```

- [ ] Executar `npx vitest run tests/terrain-source.test.ts`; confirmar RED por comportamento/contrato ausente.
- [ ] Consultar footprints LidarBC/HRDEM para Vancouver e North Shore antes de escolher DTM; usar MRDEM onde validado, Copernicus apenas com flag DSM. Capturar recorte urbano/regionais necessários, nunca raster mundial inteiro. Registrar ferramenta/GDAL, transformação de datum, versão, resampling, licença/avisos, nodata e fontes. Se não houver transformação confiável, não misturar produtos na mesma superfície. Tile bruto ≤32 KiB; cache decodificado ≤32 MiB e máximo 8 fetches simultâneos. Recursos DSM urbanos não se tornam chão oficial; cobertura de solo urbana insuficiente permanece lacuna de aceitação.
- [ ] Executar `npx vitest run tests/terrain-source.test.ts` e `npm run typecheck`; confirmar PASS. Comparar dez pontos válidos e três perfis com raster original, tolerância de amostragem 0.1 m para pontos coincidentes; tolerância de precisão do fornecedor é relatada separadamente. Registrar bytes totais, não fabricar detalhe além da resolução.
- [ ] Commit: `feat: capture verified Vancouver terrain elevation`.


## Tarefa 8: Superfície, projeção elevada e seleção por relevo

**Files:** Create `src/presentation/terrain-surface.ts`, `terrain-projection.ts`, `tests/terrain-surface.test.ts`, `tests/terrain-projection.test.ts`; Modify `src/presentation/camera.ts` por helpers compatíveis, sem mudar project plano global silenciosamente.

**Interfaces:** `TerrainReading={elevationM:number;kind:'dtm'|'dsm';sourceId:string;verticalDatum:string}`; `createTerrainSurface(tiles:readonly TerrainTile[]):{sample(geo:{lat:number;lon:number}):TerrainReading|null}` usa interpolação somente de amostras válidas. `projectElevated(point:Point,elevationM:number,camera:Camera,metresPerCell:number):Point`; `pickTerrain(screen:Point,triangles:readonly TerrainTriangle[],camera:Camera,metresPerCell:number):{point:Point;elevationM:number}|null`; `TerrainTriangle={points:readonly [Point,Point,Point];heightsM:readonly [number,number,number]}`. Projeção vertical usa a mesma escala física de volume/solo, latitude local, fator 1. Pontos são contínuos, não índice de cell; seleção escolhe triângulo visível mais próximo na mesma ordenação do desenho.

- [ ] Escrever testes `known_slope_interpolated`, `hole_not_interpolated`, `zero_height_matches_project`, `elevated_pick_roundtrip`, `occluded_triangle_not_picked`, `rotated_camera_same_ground`, `dateline_tile_selection`, `latitude_metric_scale`. Assertion de referência (fixture sintética, salvo indicação de captura oficial):

```ts
expect(projectElevated(p,0,camera,metresPerCell)).toEqual(project(p,camera));
```

- [ ] Executar `npx vitest run tests/terrain-surface.test.ts tests/terrain-projection.test.ts`; confirmar RED por comportamento/contrato ausente.
- [ ] Construir sampler e malha com triangulação consistente por tile, sem interpolar holes; resolver emendas por amostras compartilhadas. Invalidar seleção quando terreno muda, preservar fallback plano apenas com status indisponível. Não usar elevação do DSM como DTM. Helpers não consultam rede, DOM ou relógio.
- [ ] Executar `npx vitest run tests/terrain-surface.test.ts tests/terrain-projection.test.ts` e `npm run typecheck`; confirmar PASS. Confirmar round-trip dentro de 0.01 cell em fixture de encosta, solo plano idêntico à projeção existente e seleção coerente na rotação.
- [ ] Commit: `feat: project and pick elevated terrain`.


## Tarefa 9: Relevo visível e apoio de ruas/edifícios

**Files:** Create `src/surfaces/canvas/terrain-renderer.ts`, `src/client/terrain-controller.ts`, `tests/terrain-controller.test.ts`, `tests/terrain-render.test.ts`; Modify `src/surfaces/canvas/geographic-renderer.ts`, `canvas-renderer.ts`, `architecture-renderer.ts`, `src/client/city-client.ts`, `src/browser/main.ts`.

**Interfaces:** `TerrainController={setRegion(cityId:string|null):void;setTiles(tiles:readonly TerrainTile[]):void;sample(geo:{lat:number;lon:number}):TerrainReading|null;status():{available:boolean;loading:boolean;limitedSurface:boolean};dispose():void}`; browser loader fornece tiles por viewport e cancela requisições antigas. `WorldView.terrain?:{tiles:readonly TerrainTile[];sample:(geo:{lat:number;lon:number})=>TerrainReading|null}`. `drawTerrain(ctx:CanvasRenderingContext2D,view:WorldView):void` desenha malha e hillshade juntos; `surfaceElevation(point:Point,level:number):number|null` em presentation/terrain-surface.ts resolve solo e decks capturados separados; sem deck oficial, derivação explícita auditada.

- [ ] Escrever testes `terrain_changes_silhouette`, `road_follows_slope`, `foundation_not_double_building_height`, `bridge_deck_separate_from_ground`, `sea_level_not_hills`, `river_not_global_flat_ocean`, `preview_matches_pick`, `old_city_tile_ignored`, `no_spike_at_boundary`. Assertion de referência (fixture sintética, salvo indicação de captura oficial):

```ts
expect(surfaceElevation(bridgePoint,bridgeLevel)).toBeGreaterThan(surface.sample(bridgeGeo)!.elevationM);
```

- [ ] Executar `npx vitest run tests/terrain-render.test.ts tests/terrain-controller.test.ts tests/geographic-render.test.ts`; confirmar RED por comportamento/contrato ausente.
- [ ] Integrar triângulos, shading por normal e ordenação de profundidade com ruas, árvores e volumes. Subdividir linhas/polígonos para que acompanhem terreno, apoiar bases com fundações locais sem deformar toda cidade. Planos de água por corpo hídrico usam valores compatíveis com datum; mar não é hardcode zero em datum desconhecido. Preservar globo simplificado, reduzir triângulos por zoom a no máximo 40.000 visíveis, sem frestas. Atualizar picking/hover/stroke/previews com terreno. Nenhuma terraplanagem ou alteração econômica por declive nesta entrega.
- [ ] Executar `npx vitest run tests/terrain-render.test.ts tests/terrain-controller.test.ts tests/geographic-render.test.ts` e `npm run typecheck`; confirmar PASS. Inspecionar encostas de Vancouver, montanhas do North Shore, litoral e ponte com screenshots dia/noite, câmera girada e mobile; documentar limites urbanos DSM e datum. Se Canvas falhar desempenho, otimizar/culling antes de propor migração 3D separada.
- [ ] Commit: `feat: render real terrain under streets and buildings`.


## Tarefa 10: Rede de mobilidade sobre geometria real

**Files:** Create `src/presentation/mobility-model.ts`, `mobility-network.ts`, `tests/mobility-network.test.ts`; Modify `src/presentation/geographic-map.ts` e decoder `src/adapters/osm/decode.ts`, provider `src/adapters/osm/provider.ts` e stream `src/browser/geographic-stream.ts` para reter atributos existentes de sentido, nível e identidade.

**Interfaces:** Definir `MobilityNode={id:string;point:Point;level:number}`; `MobilityEdge={id:string;from:string;to:string;path:readonly Point[];lengthM:number;roadClass:string;allowed:readonly MobilityKind[];method:'reported'|'derived'}`; `MobilityNetwork={revision:string;nodes:ReadonlyMap<string,MobilityNode>;edges:ReadonlyMap<string,MobilityEdge>;outgoing:ReadonlyMap<string,readonly string[]>}`. `buildGeographicNetwork(features:readonly GeographicFeature[],revision:string):MobilityNetwork`; `buildCellNetwork(cells:readonly {coord:CellCoord;cell:Cell}[],revision:string):MobilityNetwork`; `findMobilityRoute(network:MobilityNetwork,from:string,to:string,kind:MobilityKind):readonly string[]|null`.

- [ ] Escrever `connected_L_route`, `oneway_reverse_refused`, `bridge_not_surface_intersection`, `duplicate_tile_edge_once`, `cell_highway_excludes_walkers`, `disconnected_destination_returns_null`. Caminho A→B→C deve conter duas arestas conectadas; segmentos geométricos cruzados em níveis distintos não criam nó comum.
- [ ] Executar `npx vitest run tests/mobility-network.test.ts`; confirmar RED.
- [ ] Construir nós/arestas em espaço de mundo, deduplicar tiles por identidade/geometria e nível e usar índice espacial para conexões. Para nivel/sentido ausente, marcar derivação; não conectar pontes a ruas superficiais por mera proximidade. Não baixar dados por frame. Retenção de dados de sentido/nível/ID modifica src/adapters/osm/decode.ts; stream apenas coordena tiles, sem acrescentar decoder em browser.
- [ ] Executar testes e geografia existente; typecheck. Commit: `feat: build connected mobility networks`.

## Tarefa 11: Movimento contínuo, filas e cruzamentos

**Files:** Create `src/presentation/mobility-engine.ts`, `tests/mobility-engine.test.ts`; Modify `src/presentation/clock.ts`, `src/client/city-client.ts` somente para ligar relógio/revisão.

**Interfaces:** `MobilityAgent={id:string;kind:MobilityKind;route:readonly string[];edgeIndex:number;distanceM:number;speedMps:number;seed:number;tripId?:string}`; `MobilityFrameAgent={id:string;kind:MobilityKind;point:Point;heading:Point;elevationM:number|null;seed:number;method:'simulated'|'observed';tripId?:string}`. `createMobilityEngine(network:MobilityNetwork,seed:number):MobilityEngine`; `MobilityEngine={setNetwork(network:MobilityNetwork):void;setDemand(demand:MobilityDemand):void;setAgents(agents:readonly MobilityAgent[]):void;advance(seconds:number):void;frame():readonly MobilityFrameAgent[]}`. `setAgents` reconcilia identidades, sem reiniciar agentes persistentes. Integração fixa 1/30 s, limite de catch-up 0.25 s por frame; distância mínima = metade de cada comprimento de veículo + 2 m. Comprimentos: carro 4.5 m, ônibus 12 m, caminhão 10 m; pedestre 0.5 m. Ciclo inferido de cruzamento: duas fases com verde de 20 s, amarelo de 3 s e limpeza de 2 s, identificado como simulado. Amarelo bloqueia novas entradas; agentes já dentro terminam a travessia. A Tarefa 16 liga esse estado ao desenho visível.

- [ ] Escrever `cross_edge_without_teleport`, `queue_respects_lengths`, `intersection_conflicting_agents_wait`, `pause_zero_seconds`, `resume_bounded_catchup`, `removed_edge_replans_or_exits`, `same_revision_does_not_restart`, `truck_and_walker_permissions`; afirmar separação mínima e continuidade no trajeto L da Tarefa 10.
- [ ] Executar `npx vitest run tests/mobility-engine.test.ts`; confirmar RED.
- [ ] Implementar movimento métrico e controle por faixa/interseção, manter geração limitada e semente estável. Altura é resolvida pela superfície/deck da Tarefa 9, não reinicia percurso. Movimento derivado do relógio atual da partida; câmera/zoom não altera identidade. Destinos sem rota não geram agente. Ativar caminhões em classe rápida/industrial e demanda estimada por hora de cenário.
- [ ] Executar testes alvo e regressões de pausa/relógio. Commit: `feat: simulate continuous street movement`.

## Tarefa 12: Desenho reconhecível nos dois mapas

**Files:** Create `src/surfaces/canvas/mobility-draw.ts`, `tests/mobility-draw.test.ts`; Modify `src/surfaces/canvas/street-renderer.ts`, `geographic-renderer.ts`, `canvas-renderer.ts`, `src/presentation/street-detail.ts`, `src/client/city-client.ts`.

**Interfaces:** `drawMobilityAgent(ctx:CanvasRenderingContext2D,agent:MobilityFrameAgent,projectPoint:(point:Point)=>Point,pixelsPerMetre:number,motion:number):void`; acrescentar frame de mobilidade opcional ao `WorldView` existente. Desenho usa heading projetado pela câmera, não diagonal fixa.

- [ ] Escrever `bus_longer_than_car`, `truck_distinct_cab_and_cargo`, `walker_legs_follow_motion`, `rotated_camera_preserves_heading`, `outside_view_culled`; validar operações Canvas significativas, não snapshot de cada chamada.
- [ ] Executar `npx vitest run tests/mobility-draw.test.ts tests/geographic-render.test.ts`; confirmar RED novo.
- [ ] Substituir agentes antigos na passagem ativa; conservar helpers de árvores/cruzamentos. Desenhar ônibus com janelas, caminhão com cabine/carga e pessoas com passos; projetar offsets de faixas/calçadas usando projectElevated e altura do frame; mesmo helper para sombras/apoio. Remover carros decorativos antigos nas passagens substituídas para não duplicar tráfego. Reusar buffers; limite inicial 480 agentes terrestres visíveis, reduzido para 120 no zoom distante, margem de rede de uma tela.
- [ ] Inspecionar Downtown com curva, travessia, pausa, câmera girada e zoom; salvar checkpoint. Executar regressões geográficas e typecheck. Commit: `feat: render visible urban mobility`.

## Tarefa 13: Ônibus circulando nas rotas reais TransLink

**Files:** Create `src/core/transit-data.ts` e mover tipos puros com reexport compatível; Modify `src/adapters/reality/gtfs.ts`; Create `tools/vancouver-transit.ts`, `src/presentation/transit-routes.ts`, `src/adapters/reality/data/vancouver-transit.json`, `tests/transit-routes.test.ts`; Modify `tests/gtfs-source.test.ts`.

**Interfaces:** Estender `TransitTrip` com `shapeId?:string` e `directionId?:string`; `TransitContent` com `shapes:readonly {id:string;points:readonly {lat:number;lon:number;sequence:number;distance?:number}[]}[]`. `TransitRoutePattern={id:string;routeId:string;shapeId?:string;directionId?:string;edges:readonly string[];stopDistancesM:readonly number[];method:'reported'|'derived'}`; `buildTransitPatterns(dataset:TransitContent,network:MobilityNetwork):readonly TransitRoutePattern[]` agrupa variantes e preserva sequência de paradas. Shapes restringem matching à rede; sem match completo, emitir relatório e não desenhar conexão inventada.

- [ ] Resolver download oficial na página GTFS; conferir arquivo, limites atuais, cobertura/validade e termos. Produzir captura Vancouver com proveniência; não elevar limites ZIP sem medir bytes expandidos e justificar. Manter importação local se navegador não puder buscar por CORS.
- [ ] Escrever `shape_sequence_sorted`, `trip_shape_reference`, `opposite_directions_preserved`, `variants_do_not_mix_stops`, `duplicate_stop_same_position_safe`, `missing_shape_connected_fallback`, `no_connection_no_bus`, `same_pattern_imported_once`.
- [ ] Executar `npx vitest run tests/gtfs-source.test.ts tests/transit-routes.test.ts`; confirmar RED.
- [ ] Ampliar importador existente e mapear cada percurso conectado e suas paradas. Preservar calendários/horários sem usá-los para sincronizar a animação. Manter capabilities do importador; cálculo de percursos é consumidor separado.
- [ ] Executar testes e inspecionar geometria de uma linha em ambas as direções; conferir sequência de paradas contra o feed. Commit: `feat: load real Vancouver bus routes`.

## Tarefa 14: Movimento simulado dos ônibus nas rotas reais

**Files:** Create `src/presentation/transit-motion.ts`, `tests/transit-motion.test.ts`; Modify `src/presentation/mobility-engine.ts`, `mobility-model.ts`.

**Interfaces:** `routeBuses(patterns:readonly TransitRoutePattern[],seed:number):readonly MobilityAgent[]` gera identidades estáveis por percurso e slot. Estender `MobilityAgent` com `patternId?:string` e `stopsM?:readonly number[]`; motor preserva estado de parada. Usar até dois ônibus por percurso visível, com fase inicial espaçada; tempo de parada simulado 15 s. Ao terminar o percurso, sair no limite e regenerar no início, sem atravessar o mapa como se o destino fosse conectado à origem.

- [ ] Escrever `bus_follows_real_pattern`, `bus_stops_at_declared_stop`, `bus_dwell_15_simulated_seconds`, `pause_freezes_bus`, `game_acceleration_applies_to_bus`, `duplicate_pattern_does_not_multiply_fleet`, `route_end_does_not_teleport_across_city`, `changed_network_invalidates_pattern`.
- [ ] Executar `npx vitest run tests/transit-motion.test.ts tests/mobility-engine.test.ts`; observar RED.
- [ ] Integrar percursos e paradas ao motor da Tarefa 11, compartilhando filas e cruzamentos com carros. Frequência/posição são simuladas, sem consultar API de posições ou relógio real de serviço. Reconciliar IDs em vez de reiniciar frota a cada frame.
- [ ] Executar testes e visualizar ônibus percorrendo uma curva e fazendo parada; registrar evidência de pausa e aceleração. Commit: `feat: simulate buses along real TransLink routes`.

## Tarefa 15: Calibração por contagens municipais

**Files:** Create `src/core/traffic-data.ts` (TrafficCount), `tools/vancouver-counts.ts`, `src/adapters/reality/vancouver-counts.ts`, `src/presentation/mobility-demand.ts`, `tests/vancouver-counts.test.ts`, `tests/mobility-demand.test.ts`; usar `src/adapters/reality/observation-file.ts` e `src/world/observations.ts` para capturas registradas.

**Interfaces:** `TrafficCount` definido em core/traffic-data.ts e reexportado pelo adaptador; estrutura `TrafficCount={id:string;lat:number;lon:number;from:string;to:string;direction?:number;vehicleClass:'car'|'truck'|'pedestrian'|'all-vehicles';count:number;source:MeasureSource}`; `parseVancouverCounts(value:unknown):readonly TrafficCount[]`; `calibrateDemand(network:MobilityNetwork,counts:readonly TrafficCount[],instant:string):ReadonlyMap<string,MobilityDemand>`.

- [ ] Verificar exportação real no catálogo/VanMap; registrar schema, unidades, período e acesso no source audit. Baixar amostra oficial antes de definir mapping do parser. Captura ausente não vira arquivo fictício; usar importação local e status indisponível se necessário.
- [ ] Escrever `hourly_count_not_speed`, `direction_match`, `outside_25m_unmatched`, `wrong_period_unused`, `all_vehicles_not_trucks`, `counts_to_hourly_rate`; exemplo sintético de 120 veículos em 15 min => 480/h, sem inferir velocidade ou divisão de caminhões.
- [ ] Executar testes alvo e observar RED. Implementar conversão de intervalo, matching máximo 25 m com sentido até 30° quando declarado; incompatibilidade não afeta via. Fonte agregada ajusta volume total sem inventar classe. Fora de cobertura, demanda continua estimada.
- [ ] Executar testes; guardar relatório de correspondências/rejeições e distinguir escala amostral de contagem oficial. Commit: `feat: calibrate mobility with traffic observations`.

## Tarefa 16: Viaturas, sinais visíveis e transporte escolar

Executar após Tarefas 10–12 e antes dos checks finais da Tarefa 22. Tarefa 22 inclui cenas com vermelho/fila, travessia e ônibus escolar chegando a escola, além de viatura em patrulha.

**Files:** Modify `src/core/traffic-data.ts`; Create `src/presentation/traffic-signals.ts`, `src/presentation/school-transport.ts`, `src/adapters/reality/vancouver-schools.ts`, `tests/traffic-signals.test.ts`, `tests/school-transport.test.ts`; Modify `src/presentation/mobility-model.ts`, `mobility-engine.ts`, `src/surfaces/canvas/mobility-draw.ts`, `tests/mobility-draw.test.ts`, `src/client/city-client.ts`; capturas de escolas/sinais em `src/adapters/reality/data/` somente após verificar fontes.

**Interfaces:** `TrafficSignalFrame={nodeId:string;point:Point;aspect:'red'|'amber'|'green';direction:Point;method:'reported'|'derived'}`; `MobilityEngine.signals():readonly TrafficSignalFrame[]` retorna o estado do mesmo controlador de interseção, sem animação independente. `SchoolSite` em core/traffic-data.ts, reexportado pelo adaptador escolar; estrutura `SchoolSite={id:string;name:string;lat:number;lon:number;source:MeasureSource}`; `schoolBusAgents(schools:readonly SchoolSite[],network:MobilityNetwork,scenarioInstant:string,seed:number):readonly MobilityAgent[]`. Polícia usa tipo `police`, escolar usa `school-bus`; compartilhamento de permissões/comprimento com carro e ônibus respectivamente, sem permitir novos tipos em caminhos exclusivos de pedestres.

- [ ] Conferir escolas no diretório `https://vsb.bc.ca/school-directory-and-map` e sinais em `https://vancouver.opendatasoft.com/explore/dataset/traffic-signals/table/`. Capturar localização com fonte e data; se coordenada não for publicada, registrar geocodificação derivada e validar endereço antes de associar à rede. Não importar Vancouver, Washington nem residências de estudantes.
- [ ] Escrever `red_holds_queue`, `amber_blocks_new_entry`, `signal_frame_matches_permission`, `pedestrian_phase_no_vehicle_conflict`, `curve_has_no_signal`, `police_uses_connected_patrol_and_respects_red`, `school_bus_ends_at_verified_school`, `school_route_is_simulated`, `school_peak_windows`, `school_bus_stop_holds_following_traffic`, `police_and_school_bus_visually_distinct`.
- [ ] Executar `npx vitest run tests/traffic-signals.test.ts tests/school-transport.test.ts tests/mobility-engine.test.ts tests/mobility-draw.test.ts`; confirmar RED.
- [ ] Desenhar poste e três luzes orientados à via; controlador é fonte única da cor e passagem. Matching municipal até 25 m do nó compatível, sem ligar sinais a vias em níveis distintos. Demais sinais inferidos têm método derivado. Compartilhar tempo e pausa com agentes; travessia recebe fase exclusiva quando movimentos são conflitantes.
- [ ] Gerar viaturas com pintura estilizada e barra de luzes, limite de duas no envelope visível, patrulha conectada sem emergência permanente. Gerar ônibus escolares amarelos com identidade/portas/janelas próprias, 9 m de comprimento simulado, no máximo um por escola visível e seis no total. Janelas do cenário em dias úteis: 07:30–09:00 e 14:30–16:30, explicitamente simuladas; não afirmar calendário letivo real. Usar paradas sintéticas públicas no caminho à escola, dwell de 20 s e retenção de seguidores na faixa durante embarque; nenhum endereço de aluno.
- [ ] Ligar rótulos/inspeção de escola e fonte; preservar freio/fila em vez de sobrepor ônibus a veículos. Comparar visualmente viatura, ônibus urbano e escolar em zoom próximo, pausa e noite.
- [ ] Executar testes/typecheck, atualizar checkpoints e desempenho combinado da Tarefa 22. Commit: `feat: add police patrols traffic signals and school buses`.

## Tarefa 17: Capturas marítimas e rede aquática verificada

**Files:** Create `src/core/maritime-data.ts`, `src/adapters/reality/maritime.ts`, `tools/vancouver-maritime.ts`, `src/presentation/maritime-network.ts`, `tests/maritime-data.test.ts`, `tests/maritime-network.test.ts`; capturas verificadas em `src/adapters/reality/data/vancouver-maritime.json`.

**Interfaces:** `VesselKind='cargo'|'cruise'|'sailboat'|'seabus'|'aquabus'|'bc-ferry'`; `MarinePoint={lat:number;lon:number}`; `MarineTerminal={id:string;name:string;operator:string;position:MarinePoint;berths:readonly string[];source:MeasureSource}`; `MarineRoute={id:string;operator:string;terminalIds:readonly string[];path:readonly MarinePoint[];allowed:readonly VesselKind[];method:'reported'|'derived';source:MeasureSource;verified:boolean}`; `MaritimeCapture={terminals:readonly MarineTerminal[];routes:readonly MarineRoute[];cruiseCalls:readonly {id:string;vesselName:string;company:string;terminalId:string;berthId?:string;arrival:string;departure:string;source:MeasureSource}[]}`. `readMaritimeCapture(value:unknown):MaritimeCapture`; `buildMaritimeNetwork(capture:MaritimeCapture,land:readonly GeographicFeature[]):{routes:ReadonlyMap<string,MarineRoute>;rejected:readonly string[]}`.

- [ ] Escrever testes `seabus_waterfront_lonsdale`, `aquabus_operator_preserved`, `cargo_not_cruise_terminal`, `land_crossing_rejected`, `unverified_corridor_not_active`, `cruise_calendar_year_valid`, `duplicate_berth_identity`, `missing_depth_not_safe_for_large_ship`. Assertion de referência (fixture sintética, salvo indicação de captura oficial):

```ts
expect(buildMaritimeNetwork(captureWithLandCrossing,land).routes.has('invalid-route')).toBe(false);
```

- [ ] Executar `npx vitest run tests/maritime-data.test.ts tests/maritime-network.test.ts`; confirmar RED por comportamento/contrato ausente.
- [ ] Capturar SeaBus da TransLink (inspecionar route_type e shapes GTFS), docas/conexões Aquabus oficiais, Canada Place/berços/calendário vigente, terminais de carga e marinas verificadas. Conferir corredor aquático e passagens/ponte para porte; mapa esquemático não basta. Incluir BC Ferries no contrato mas programação na Tarefa 19. Cruzeiro sem berço publicado não inventa atribuição oficial: reserva de berço compatível simulada e identificada. Coleções sem geometria navegável confirmada não animam rota como real.
- [ ] Executar `npx vitest run tests/maritime-data.test.ts tests/maritime-network.test.ts` e `npm run typecheck`; confirmar PASS. Auditar trajetos e operador contra fonte, conservar intervalos/temporada; calendário encontrado de 2025 não vale como 2026.
- [ ] Commit: `feat: capture verified maritime routes and terminals`.


## Tarefa 18: Embarcações reconhecíveis, atracação e movimento

**Files:** Create `src/presentation/maritime-engine.ts`, `src/surfaces/canvas/vessel-draw.ts`, `tests/maritime-engine.test.ts`, `tests/vessel-draw.test.ts`; Modify `src/client/city-client.ts`, `src/surfaces/canvas/canvas-renderer.ts`, `geographic-renderer.ts`.

**Interfaces:** `VesselFrame={id:string;kind:VesselKind;operator:string;routeId:string;berthId?:string;position:MarinePoint;headingDegrees:number;phase:'sailing'|'approach'|'berthed'|'departing';waterElevationM:number;method:'simulated'|'schedule-estimate'|'observed'}`; `createMaritimeEngine(capture:MaritimeCapture,seed:number):{advance(seconds:number):void;frame():readonly VesselFrame[];dispose():void}`; `drawVessel(ctx:CanvasRenderingContext2D,vessel:VesselFrame,projectWater:(p:MarinePoint,h:number)=>Point,pixelsPerMetre:number):void`. WorldView recebe vessels opcional. BC Ferries entra por frames da Tarefa 19, não por geração livre deste motor.

- [ ] Escrever testes `connected_water_motion`, `reserved_berth_no_overlap`, `cargo_distinct_from_cruise`, `sail_has_mast_and_sail`, `seabus_aquabus_distinct`, `wake_only_moving`, `pause_freezes_simulated_vessels`, `zoom_keeps_identity`, `bc_ferry_not_unscheduled_spawn`. Assertion de referência (fixture sintética, salvo indicação de captura oficial):

```ts
expect(frames.filter(v=>v.phase==='berthed'&&v.berthId==='berth-1')).toHaveLength(1);
```

- [ ] Executar `npx vitest run tests/maritime-engine.test.ts tests/vessel-draw.test.ts`; confirmar RED por comportamento/contrato ausente.
- [ ] Implementar corredor contínuo, aproximação/atracação/espera/partida, reserva de berço, passageiros parando nas docas e veleiros em passeios simulados ligados a marina. Usar passo 1/30 s e catch-up 0.25 s; até 24 embarcações totais visíveis incluindo BC Ferries, prioritizando serviços e berços frente a veleiros decorativos. Velocidades/esperas de simulação são parâmetros identificados, nunca informação oficial sem fonte. Desenhar convés/contêineres/velas/operadores e esteira discreta na superfície de água da Tarefa 9.
- [ ] Executar `npx vitest run tests/maritime-engine.test.ts tests/vessel-draw.test.ts` e `npm run typecheck`; confirmar PASS. Inspecionar False Creek, Canada Place e Burrard Inlet, pausa, noite e câmera girada; salvar operações completas e verificar escala dos navios frente aos terminais.
- [ ] Commit: `feat: animate port vessels and passenger ferries`.


## Tarefa 19: BC Ferries em rotas e horários oficiais

**Files:** Create `src/adapters/reality/bc-ferries.ts`, `tools/bc-ferries-capture.ts`, `src/presentation/ferry-schedule.ts`, `src/client/ferry-clock.ts`, `tests/bc-ferries.test.ts`, `tests/ferry-schedule.test.ts`, `tests/ferry-clock.test.ts`; Modify `src/core/maritime-data.ts`, `src/browser/main.ts`; captura válida em `src/adapters/reality/data/bc-ferries.json`.

**Interfaces:** `ScheduledSailing={id:string;routeId:string;serviceDate:string;timezone:string;calls:readonly {terminalId:string;arrivalInstant?:string;departureInstant?:string;localArrival?:string;localDeparture?:string}[];vesselName?:string;status:'scheduled'|'cancelled';source:MeasureSource}`; `FerryScheduleCapture={validFrom:string;validUntil:string;sailings:readonly ScheduledSailing[]}`; `readFerrySchedule(value:unknown,routes:readonly MarineRoute[]):FerryScheduleCapture`; `scheduledFerryFrames(schedule:FerryScheduleCapture,routes:readonly MarineRoute[],instant:string):readonly VesselFrame[]`; `createFerryClock(now:()=>string):{setPaused(paused:boolean):void;setScenario(instant:string|null):void;instant():string}`. Instantes ISO incluem offset resolvido na captura; preservar data/hora local e timezone para auditoria. Scenario null usa now civil injetado; pausa guarda instante visual, retomada lê now, multiplicador econômico não entra.

- [ ] Escrever testes `service_date_direction_matches`, `intermediate_calls_preserved`, `cross_midnight_arrival`, `season_expired_unavailable`, `cancelled_not_departed`, `published_offset_preserved`, `economic_speed_ignored`, `resume_no_duplicate_sailing`, `scheduled_position_not_live_claim`, `no_route_no_sailing`. Assertion de referência (fixture sintética, salvo indicação de captura oficial):

```ts
expect(scheduledFerryFrames(expiredSchedule,routes,'2027-01-01T12:00:00Z')).toEqual([]);
```

- [ ] Executar `npx vitest run tests/bc-ferries.test.ts tests/ferry-schedule.test.ts tests/ferry-clock.test.ts`; confirmar RED por comportamento/contrato ausente.
- [ ] Validar página/programação oficial por data/direção/temporada e termos; Queue-it encontrado impede presumir fetch automatizado. Captura local oficial conferida é alternativa inicial; sem horário válido a capacidade fica indisponível. Priorizar conexões regionais a partir de Horseshoe Bay/Tsawwassen após conferir lista vigente de rotas e corredores; nenhuma conexão deduzida por nome. Movimento usa partidas/chegadas/escalas oficiais e posição interpolada em corredor verificado com abordagem contínua ao terminal. Não atribuir navio por nome sem alocação publicada. Regras de fuso vêm de documentação do operador/tzdb vigente para data, não UTC-8/UTC-7 fixo. Mostrar programação/idade, modo horário real ou cenário e “posição estimada pelo horário oficial”. Atualização de atrasos/cancelamentos só se acesso dinâmico comprovado, conservando origem/timestamp; ausência não simula estado ao vivo.
- [ ] Executar `npx vitest run tests/bc-ferries.test.ts tests/ferry-schedule.test.ts tests/ferry-clock.test.ts` e `npm run typecheck`; confirmar PASS. Comparar pelo menos uma viagem completa em cada direção e uma exceção de calendário com original, incluindo noite e pausa. Fonte ainda indisponível não conta como entrega dos horários exigidos.
- [ ] Commit: `feat: schedule BC Ferries on verified routes`.


## Tarefa 20: Captura verificável de aeroporto, pistas e companhias

**Files:** Create `src/core/airport-data.ts` (AirportPoint, AirportRunway, AirportAirline, AirportCapture), `src/adapters/reality/airports.ts`, `src/adapters/reality/data/cyvr.json`, `tools/vancouver-airport.ts`, `tests/airports.test.ts`; adicionar fontes ao audit da Tarefa 5.

**Interfaces:** Tipos de captura definidos em core/airport-data.ts, reexportados no adaptador; `AirportPoint={lat:number;lon:number}`; `AirportRunway={id:string;airportId:string;ends:readonly [AirportPoint,AirportPoint];endNames:readonly [string,string];lengthM:number;closed:boolean;elevationM?:number;verticalDatum?:string}`; `AirportAirline={code:string;name:string;colours:readonly string[];sourceUrl:string;representation:'stylized'}`; `AirportCapture={id:string;iata:string;name:string;position:AirportPoint;runways:readonly AirportRunway[];airlines:readonly AirportAirline[];sources:readonly {dataset:string;url:string;retrievedAt:string;license?:string}[]}`; `readAirportCapture(value:unknown):AirportCapture`.

- [ ] Baixar arquivos oficiais do projeto OurAirports a partir de `https://ourairports.com/data/`, selecionar CYVR e suas pistas, preservar unidades originais e converter pés para metros quando necessário. Conferir extremos/orientação/identificação e elevação de pista contra material publicado pelo YVR; normalizar datum com a Tarefa 7 antes de comparar solo e aeronave. Registrar divergências em vez de escolher silenciosamente. Pista sem cota/datum compatível não habilita operações elevadas até validação.
- [ ] Conferir companhias em `https://www.yvr.ca/en/passengers/flights/airlines-and-destinations`; criar catálogo inicial de jatos Air Canada/WestJet e operadores adicionais somente após validação. Não inferir modelo ou frequência real da companhia listada.
- [ ] Escrever `CYVR_runways_not_other_airport`, `feet_to_metres`, `invalid_endpoints_rejected`, `closed_runway_not_active`, `physical_runway_keeps_both_end_names`, `airline_source_preserved`; executar `npx vitest run tests/airports.test.ts` e observar RED.
- [ ] Implementar parser/captura com coordenadas, identificadores e proveniência; registrar fonte comunitária OurAirports e lista oficial YVR separadamente. Pinturas estilizadas são Canvas/code-native, sem baixar logos.
- [ ] Executar testes, typecheck e comparar captura com fontes/audit. Commit: `feat: add verified YVR airport and runway data`.

## Tarefa 21: Decolagens, pousos e desenho de aeronaves

**Files:** Create `src/presentation/aviation.ts`, `src/surfaces/canvas/aircraft-draw.ts`, `tests/aviation.test.ts`, `tests/aircraft-draw.test.ts`; Modify `src/client/city-client.ts`, `src/surfaces/canvas/canvas-renderer.ts`, `geographic-renderer.ts`, `src/browser/main.ts`.

**Interfaces:** `AircraftPhase='approach'|'landing-roll'|'waiting'|'takeoff-roll'|'climb'`; `AircraftFrame={id:string;airportId:string;airlineCode:string;phase:AircraftPhase;position:AirportPoint;headingDegrees:number;altitudeM:number;verticalDatum:string;progress:number;colours:readonly string[]}`; `createAviationEngine(capture:AirportCapture,seed:number):{advance(seconds:number):void;frame():readonly AircraftFrame[];dispose():void}`; `drawAircraft(ctx:CanvasRenderingContext2D,aircraft:AircraftFrame,projectGround:(point:AirportPoint)=>Point,pixelsPerMetre:number):void`.

- [ ] Escrever `approach_aligned_with_runway`, `touchdown_continuous`, `takeoff_climbs_after_roll`, `runway_opposite_ends_share_reservation`, `crossing_runways_no_conflicting_occupancy`, `pause_freezes_aircraft`, `zoom_does_not_restart_flight`, `no_taxiways_no_terminal_crossing`, `airline_identity_stays_stable`; executar `npx vitest run tests/aviation.test.ts tests/aircraft-draw.test.ts` e observar RED.
- [ ] Implementar motor separado: limite de 8 aeronaves por aeroporto, passos de 1/30 s e catch-up máximo 0.25 s. Para referência visual simulada, aproximação final de 8 km e descida de 3°, corrida de decolagem em 60% da pista e subida de 5°; não rotular esses valores como procedimentos YVR. Reservar pista física e pistas geométricas conflitantes antes da aproximação final/corrida; no conflito, aguardar geração ou manter espera fora da pista. Não inventar taxiways: iniciar/finalizar operação na área da pista com transição suave fora da câmera quando não houver rede de solo.
- [ ] Desenhar silhueta de jato, cores por companhia, altitude com deslocamento vertical e sombra no solo; ordenar sombra junto ao chão e aeronave na passagem aérea. Altura absoluta no datum da cena soma altura de pista e perfil relativo de voo; nunca tratar metros acima do solo como cota absoluta. Usar projeção elevada da Tarefa 8 e projeção local em metros e adaptar detalhe ao zoom, mantendo custo limitado e pausa/velocidade coerentes com ônibus.
- [ ] Integrar ao `WorldView` com `aircraft?:readonly AircraftFrame[]`, fontes/inspeção e rótulo “Aeroporto e pistas reais · operações simuladas”. Em cenas sem cobertura do aeroporto, não preencher céu com aviões aleatórios.
- [ ] Executar testes/typecheck e inspeção YVR com pouso e decolagem completos, sombras, orientação de câmera, noite e zoom; repetir desempenho combinado e checks finais da Tarefa 22. Commit: `feat: animate airline takeoffs and landings at YVR`.

## Tarefa 22: Painel, integração, desempenho e revisão final

**Files:** Modify `src/browser/main.ts`, `index.html`, `src/browser/style.css`, `src/client/city-client.ts`, `src/surfaces/text/render.ts`; Create `src/client/mobility-controller.ts`, `tests/mobility-controller.test.ts`, `docs/quality/2026-10-02/vancouver-data/README.md`; Extend `tools/browser-perf.mjs` somente para registrar métricas necessárias.

**Interfaces:** `MobilityMode='estimated'|'calibrated'`; `MobilityStatus={mode:MobilityMode;available:boolean;sourcePeriod?:string;observedAt?:string;scenarioInstant:string}`; `createMobilityController(options:{seed:number;now:()=>string;onChange:()=>void}):{setCity(territoryId:string|null):void;setNetwork(network:MobilityNetwork):void;setTransit(dataset:TransitContent|null):void;setCounts(counts:readonly TrafficCount[]):void;setMode(mode:MobilityMode):void;setScenario(instant:string):void;advance(seconds:number):void;frame():readonly MobilityFrameAgent[];status():MobilityStatus;dispose():void}` conecta rede, movimento, percursos TransLink e contagens das tarefas anteriores. Cliente fornece frame ao renderizador; UI não calcula economia nem cria rotas.

- [ ] Escrever `city_change_clears_old_finance_and_agents`, `missing_counts_keeps_estimated_usable`, `paused_theme_still_renders`, `explicit_calibration_confirmation_contains_ratio`, `text_surface_preserves_fact_source`; verificar fonte/ano/CAD e razão 0.01 antes da ação, não solicitar aprovação extra ao desenvolvedor para essa UI de produto.
- [ ] Executar testes alvo; observar RED dos fluxos novos. Ligar painel compacto, movimento on/off, relógio de cenário e modos estimado/calibrado com disponibilidade real; fontes/atribuição clicáveis. Conectar terreno, navegação e aviação por controladores próprios; incluir status/validade BC Ferries e camada municipal de demografia. Adapters só entram via browser, nunca por import em client/presentation. Ônibus mostram “Rotas TransLink · movimento simulado” e data do feed; não oferecer sincronização ao vivo nesta entrega. Aplicar calibração somente pelo controle explícito do cenário, nunca na chegada de facts.
- [ ] Executar `npm run check` e `npm run build`; registrar PASS e warnings preexistentes. Reexecutar somente após mudanças/correções que justifiquem.
- [ ] Comparar versão-base e nova no bundle de produção, mesmo navegador/viewport/cenas, três medições de 30 s após aquecimento; reportar mediana do tempo de frame e agentes. Cenas: Downtown, corredor TransLink, industrial, via rápida regional, encosta/North Shore, False Creek, Canada Place, BC Ferries em travessia e YVR. Não alegar rodovia municipal se cena está fora do limite de Vancouver.
- [ ] Capturar desktop e 390×844, curvas, fila, pedestres, ônibus parando, caminhões, pausa/retomada, zoom/câmera, globo e edição de via. Registrar dados indisponíveis e cobertura efetiva; confirmar população/orçamento contra audit; capturar relevo visível, SeaBus/Aquabus parando, cruzeiro atracado, carga no porto, veleiro, BC Ferries comparado ao horário e pouso/decolagem completos.
- [ ] Se mediana piorar acima de 20%, ajustar limite/culling/cache e repetir medição afetada. Confirmar save existente/replay e que uma edição não teleporta agentes por água.
- [ ] Usar orçamento combinado máximo 512 agentes (480 terrestres, 24 embarcações, 8 aeronaves) e 160 no zoom distante, culling por viewport, teto 40.000 triângulos de terreno. Se capacidade de fonte obrigatória falta, registrar entrega parcial concreta, sem marcar aceitação completa.
- [ ] Fazer revisão fresca do conjunto conforme método aprovado, corrigir achados com regressões pertinentes e repetir checks afetados. Commit final: `feat: complete Vancouver data and mobility experience`.
- [ ] Entregar branch, evidências e limitações verificadas. Publicar somente se houver autorização aplicável a esta entrega; a aprovação deste plano autoriza implementação, não presume contratação ou credenciais externas.

## Critérios de conclusão e matriz de cobertura

| Requisito | Tarefas | Evidência obrigatória |
|---|---|---|
| Fontes mundo/Canadá/BC/local | 2–5 | Seleção correta em Vancouver/Victoria/Toronto/Lisboa, source audit |
| Demografia consistente | 3–4 | CSD/DGUID, censo municipal, anos por medida e estimativa separada |
| Finanças e economia | 5–6 | Orçamento conferido, realizado separado, replay offline e sem alteração automática |
| Relevo real | 7–9 | Raster/procedência, perfil, geometria elevada, apoio/picking, água e pontes |
| Carros/caminhões/pedestres | 10–12 | Percurso conectado, fila, direção, pausa e desenho reconhecível |
| Ônibus em rotas reais | 13–14 | Shapes/direções/paradas conferidos, movimento simulado |
| Relação com dados de trânsito | 15 | Contagem calibrada onde disponível; ausência identificada |
| Viaturas/escolares/semáforos | 16 | Escolas reais, patrulha e rotas simuladas, sinal/filas/travessias coerentes |
| Cruzeiros/carga/veleiros/SeaBus/Aquabus | 17–18 | Corredores/terminais, atracação, identidades e fonte |
| BC Ferries | 17/19 | Rotas verificadas, programação vigente, relógio civil e posição estimada |
| Aviões | 20–21 | Pistas e operadores conferidos, voo/altura/ocupação coerentes |
| Integração | 22 | Checks, screenshots, desempenho, saves e revisão corrigida |

## Autorrevisão e pendências de fonte

Sequência consolidada: dados e regras antes de terreno; projeção e picking antes de redes/agentes; rede antes de shapes/paradas; capturas antes de motores marítimo/aéreo; integração final depois de todos os blocos. Nenhum consumidor exige adapter numa camada proibida. Fontes econômicas não entram no core; core recebe contratos puros. Campos CityFacts antigos permanecem compatíveis. O renderer atual é mantido; migração integral para 3D, terraplanagem, sincronização real de ônibus e feeds pagos de AIS/voos estão fora desta entrega.

A coleta de DTM específico, valores financeiros, CSVs canadenses, corredor BC Ferries e horários oficiais faz parte das tarefas, não está declarada concluída. A aceitação dos requisitos correspondentes depende dessas evidências: mecanismo funcionando com fixture sintética não prova dado real. Fonte indisponível é tratada conforme tabela de alternativas; impede declarar aquela capacidade entregue, mas não impede executar blocos independentes.

Os cinco pontos de Review Focus têm testes nas tarefas indicadas. Regressões de texto/HUD demográfico existentes são preservadas; novos testes verificam comportamento, não repetem cada operação de desenho. Todas as tarefas de produto incluem RED, implementação, GREEN/typecheck e commit; baseline e validação final são verificações, não pedem testes artificiais para documentação.

## Revisão e execução

Este é o plano completo consolidado, ainda sem execução dos novos sistemas. Recomenda-se execução **nativa**, sequencial, com revisão independente final. O usuário revisa o plano e escolhe nativa ou com subagentes antes de implementar, conforme writing-plans. Autorização de concluir este documento não publica o site nem contrata fontes. Após aprovação, marcar checkboxes somente mediante evidência da tarefa e manter source-audit/status das capacidades atualizados.
