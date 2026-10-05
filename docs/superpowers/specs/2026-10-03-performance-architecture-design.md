# Arquitetura de desempenho: cena persistente e trabalho limitado

## Objetivo e autorização

Pedido de 3/10/2026: tornar o Open Sim muito mais rápido, leve e estável, como trabalho de arquitetura. Preservar cidades, relevo, profundidade, dados reais e movimento existente. Execução nativa e sem servidor próprio continuam requisitos. Esta especificação apresenta a solução concreta para revisão antes da implementação.

## Diagnóstico reproduzido

Base: branch `codex/vancouver-data-mobility`, commit `28c9d09`. Navegador nativo, viewport 1280×720, Vite em 4174, False Creek/corredor TransLink, 49.276 N / -123.124, escala 100 m. Sessão inicialmente pausada; ativado 1× na aba de diagnóstico, encerrada após coleta. As métricas são do scheduler do aplicativo, não de um requestAnimationFrame independente que pode continuar disparando enquanto a cidade fica parada.

Amostra observada: 4 quadros/s; renderização 197,6 ms; simulação de mobilidade 3,1 ms; scheduler p50 204,2 ms e p95 591,9 ms. Snapshot posterior preservado em `docs/quality/2026-10-03/performance/reproduction.json`; screenshot em `reproduction.png`. É uma reprodução diagnóstica, não uma comparação controlada de 27 execuções. Não assumir que Vite e produção têm desempenho idêntico. O relatório anterior que dizia 60 Hz não explica esta experiência nem fornece amostras comparáveis preservadas.

Evidência no código:

- `geographic-renderer.ts`: a cada desenho percorre features, prepara prédios, resolve fundações, calcula profundidades e cria closures, mesmo quando o bitmap de chão é reutilizado. Prédios continuam desenhados individualmente em todos os quadros animados.
- `architecture-renderer.ts`: preparação de fundações e clip de terreno ocorre por volume; sprites de prédios não eliminam esse trabalho.
- `main.ts`: carregamento/seleção de mapas, terreno e demanda são consultados no caminho de cada quadro; painel também é atualizado durante deslocamento da câmera.
- A captura diagnóstica mostra 106.000 nós e 255.826 arestas. Existe limite de tiles, mas não um orçamento real de complexidade de rede. Mudanças de seleção reconstroem a rede e suas estruturas no thread principal.
- `sameFrame` mantém o custo de renderização quando há tráfego visível; caches por quadro evitam duplicação de comandos móveis, mas não a preparação estática.

Conclusão: o gargalo dominante observado é renderização. Reconstrução da rede e trabalho da câmera são riscos secundários que precisam de medição por fase.

## Abordagens consideradas

1. **Cena persistente sobre Canvas2D (recomendada):** reutilizar geometria preparada, projeções, máscaras e composição estática, com invalidação explícita, índice espacial e trabalho pesado fora do quadro. Preserva o desenho atual e permite regressões incrementais.
2. **Migrar integralmente para WebGL:** melhora potencial de batching e depth buffer, mas exige refazer materiais, texto, picking e oclusão. Fica fora desta correção; só reconsiderar se os critérios não forem alcançados com evidência de custo irredutível no Canvas.
3. **Somente diminuir agentes/resolução:** intervenção pequena, mas não resolve o custo observado de prédios e preparação. Pode haver LOD definido, sem servir como substituto para a arquitetura.

## Componentes e fluxo

### 1. Diagnóstico por fase e benchmark

Adicionar instrumentação opt-in para seleção, preparação estática, projeção/oclusão, simulação, comandos dinâmicos, composição, HUD e instalação da rede. Medir custo de trabalho e intervalo entre quadros efetivamente apresentados pelo aplicativo. Registrar tarefas longas quando a API existir. Não depender de APIs privadas do navegador.

Harness de QA explícito, isolado da UI normal, inicia cenários por controles nativos e publica JSON no DOM. Preservar amostras brutas e manifestos com commit, bundle, viewport, pixel ratio, velocidade, agentes, fontes carregadas e timestamp. Uma única simulação ativa por comparação.

### 2. Preparação persistente da cena

Separar `prepareScene` de `composeFrame`. Scene revision deriva das referências/versionamentos de geografia, terreno e conteúdo dos chunks editados; o tick econômico global não invalida dados geográficos imutáveis.

Preparação independente da câmera: índice de features/footprints, fundações, alturas, topologia, estilo e edições que removem edifícios. Preparação dependente da câmera: conjunto visível, projeção, profundidade, máscaras de oclusão e ordenação estática. Cache por chaves explícitas de câmera, viewport, pixel ratio, luz e revisão, nunca apenas pela identidade de um objeto recém-criado.

Com câmera parada e apenas movimento, não repetir fundações, clipping de lotes, varredura global de features ou ordenação dos prédios. Edição invalida regiões afetadas; mudanças de terreno, estilo, tamanho ou câmera invalidam seus produtos dependentes. Objetos e buffers publicados são imutáveis para evitar quadros parcialmente preparados.

### 3. Composição estática e profundidade dinâmica

Chão e volumes estáticos são preparados em superfícies limitadas. Não pintar todos os prédios numa imagem e depois todos os carros: isso quebraria a oclusão.

A estratégia inicial mantém uma lista estática ordenada e máscaras pré-calculadas para intercalar comandos dinâmicos sem reordenar/preparar todos os prédios. Na implementação, comparar composição por regiões sujas e superfícies estáticas com máscara de profundidade; escolher a variante com menor custo medido e registrar a decisão. Regiões sujas incluem posição antiga/nova, sombras, wakes e efeitos; ao excesso de regiões, recompor a superfície visível inteira. Efeitos de água têm camada e frequência próprias, sem invalidar geometria urbana.

Caches limitados por bytes (128 MiB para a preparação/raster da cena, incluindo o cache de prédios existente) e entradas; LRU, liberação no descarte e fallback Canvas HTML onde OffscreenCanvas não existir. Não alocar uma superfície gigante por prédio nem por faixa de profundidade. Mudar viewport invalida superfícies incompatíveis.

### 4. Trabalho da câmera e streaming

Seleção de tiles e demanda só muda quando câmera/viewport atravessa limiar ou seleção efetivamente muda. Índice espacial retorna candidatos visíveis; bounding boxes são preparados por feature. Durante gesto, priorizar resposta à câmera com detalhe reduzido temporariamente; completar detalhe ao estabilizar. Reutilização por translação só é válida se zoom, rotação e luz não mudaram e deve conservar margens de cobertura.

Cancelar/coalescer preparações superadas. Um resultado antigo não pode instalar tiles ou rede de outra cidade. Limitar carregamentos, bytes em cache e instalação por orçamento; dados ausentes usam a última cena consistente e status claro, sem bloquear interação.

### 5. Rede e simulação fora da preparação visual

Rede calculada por worker com mensagens versionadas e dados serializáveis; testes continuam capazes de injetar execução síncrona. Uma tarefa em voo e a seleção pendente mais recente; descartar resultados obsoletos e recuperar falha do worker sem fila ilimitada.

Construção incremental por regiões ou seleção espacial reduz a rede efetiva. Orçamento de 140.000 arestas é aplicado antes de instalar a rede. Não truncar arbitrariamente uma rota aceita: preservar conectividade dos percursos verificados ou declarar aquele percurso temporariamente indisponível. Valores limite e motivo devem aparecer no diagnóstico.

Simulação mantém passo fixo, catch-up limitado, estabilidade das identidades e reservas; frame de apresentação produzido uma vez por atualização e reutilizado por consumidores. Listas de sinais são filtradas espacialmente antes da projeção. O relógio civil e o econômico continuam separados.

### 6. HUD e ciclo de vida

HUD atualiza por alteração semântica, com no máximo 5 Hz para valores durante navegação; input e ações de produto continuam imediatos. Não refazer fatos/demografia/atribuição a cada pixel de câmera. Pausa permite câmera, edição e modo noturno; quadro oculto suspende simulação/animação e evita acúmulo de catch-up. Descarte encerra workers, timers, buffers e assinaturas.

## Compatibilidade e riscos

Sem migração de save ou mudança de economia. Não remover fontes reais nem apresentar menor cobertura como sincronização real. Preservar rotas e calendário civil; terra, água, ponte, aeronave e edifícios mantêm convenções atuais de altura.

Riscos principais: cache não invalidado após edição, carro desenhado sobre prédio, profundidade invertida em encosta, rede antiga instalada após viagem, tarefas grandes transferidas ao worker sem limitar cópias, memória crescente após navegação. Cada risco tem regressão e prova visual obrigatórias. Worker falho e ausência de OffscreenCanvas têm fallback limitado e observável.

## Critérios de aceitação

No mesmo navegador nativo e produção, três execuções de 30 s após 15 s de aquecimento, nove cenas anteriores e a reprodução atual. Baseline desta branch medida antes das alterações, com dados e densidade comparáveis. Publicar custo do aplicativo p50/p95, intervalo real de apresentação, agentes e memória de caches; nunca substituir esses números pelo ritmo de um RAF independente.

- Câmera parada/1×: reduzir o custo p50 de desenho em pelo menos 80% na reprodução atual; meta p50 <= 16,7 ms e p95 <= 33,3 ms para trabalho total em Downtown/False Creek/TransLink a 1280×720.
- Navegação aquecida: resposta ao input no quadro seguinte disponível; p95 de intervalo de apresentação <= 50 ms, sem tarefa própria >100 ms. Registrar outliers de rede/decodificação separadamente.
- Quadros só de movimento: zero reconstruções de rede, fundação, índice de features e ordenação estática quando não há mudança de versão.
- 20 viagens entre cenas: caches dentro do limite em bytes, fila de preparação limitada a uma atual e uma pendente, sem crescimento monotônico de entradas/assinaturas.
- Pausado e estabilizado: nenhum desenho periódico sem mudança visual; aba oculta não acumula trabalho; retomada não teleporta agentes por catch-up.
- Capturas desktop e documento 390×844, dia/noite, pausa/retomada, curvas, veículos atrás de prédios, encosta, barcos/aviões, construção/demolição, globo e viagem Vancouver–Lisboa–Vancouver.
- `npm run check` e `npm run build` passam. Comparações de imagens usam tolerância documentada; testes estruturais verificam invalidação, orçamento e obsolescência sem limites frágeis de tempo em CI.

Se uma meta falhar, documentar o cenário e o custo restante e continuar o diagnóstico antes de declarar resolvido. Nenhuma alegação de leveza se baseia apenas no tamanho do bundle ou em remover atores da cena.

## Direção adicional do usuário —3/10/2026

Priorizar desenvolvimento e separar superfícies de input do processamento. A cena será renderizada com OffscreenCanvas em worker quando disponível, com uma tarefa atual e uma pendente substituível. Imagens transferíveis preservam a composição atual de oclusão; o plano original de desenhar tudo no thread principal passa a ser fallback. A superfície de interação permanece no thread principal e uma apresentação WebGL2 opcional reprojeta a última textura durante navegação. Isso usa a GPU oferecida pelo navegador, sem prometer acesso direto a Metal. Perda de contexto e indisponibilidade retornam ao Canvas2D. Recursos e bitmaps possuem descarte explícito; orçamento ajustado pela memória anunciada pelo navegador. O estático precisa ser confirmado antes de avançar animação. A validação focará testes de fila, invalidação, descarte e uma verificação nativa curta; as rodadas extensas não são o caminho crítico.
