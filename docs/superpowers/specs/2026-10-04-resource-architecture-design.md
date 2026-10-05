# Open Sim: recursos proporcionais ao que o jogador vê

## Intenção

Pedido de 4/10: revisar a raiz do programa e refatorar o consumo de recursos. O jogo deve abrir com feedback, manter controles fluidos durante preparação e operar com folga. Preservar saves, profundidade/oclusão, geografia real, economia e funcionalidades existentes. Não trocar funcionalidades por uma redução indiscriminada de qualidade. Publicação não faz parte desta etapa.

## Diagnóstico confirmado

Base de produção `00df96b`, no worktree `webgl-crash-investigation/open-sim`. O checkout principal é uma versão diferente, anterior à arquitetura em workers.

- Fonte tem aproximadamente 35.195 linhas, incluindo milhares de linhas de dados JSON. `main.ts` tem 1.047 linhas e concentra composição, fontes regionais, sessão, painéis e coordenação dos quadros. São 201 arquivos TypeScript / 25.609 linhas e 13 arquivos JSON / 9.292 linhas. O bundle inicial medido tem 781 KB bruto / 240 KB gzip; um JSON de trânsito de 12 MB existe na fonte, mas não é o dataset compacto importado pelo jogo. Tamanho não é uma medida de custo, mas a composição inicial acopla responsabilidades opcionais ao caminho essencial.
- O tráfego usa `createVisualTileDecoder()` completo. Decodifica geometrias de prédios, água, vegetação e etiquetas, embora o construtor da rede consuma somente ruas.
- Medição Node 26, quatro tiles públicos z14 em False Creek (49.276, -123.124), 4/10: 12.847 features / 138.338 vértices completos; ruas: 6.338 features / 25.882 vértices. Cerca de 81% dos vértices decodificados são dispensáveis para o worker de tráfego. Decodificação completa por tile: 10,7–19,2 ms. Este benchmark não representa FPS nem memória total do Chrome. Em prova pareada de oito repetições por tile, decodificar apenas ruas teve medianas 2,8–5,2 ms versus 5,6–11,2 ms completas, preservando a geometria de ruas exatamente. Evidência e script reproduzível em `docs/quality/2026-10-04-resource-audit/`.
- Rede desses quatro tiles: 26.706 nós / 62.792 arestas, 386 ms para construir e preparar runtime com orçamento de 140.000. Pedir limite de 20.000 aumenta o custo para 919 ms, porque `buildNetworkJob` constrói a rede inteira e reconstrói sucessivamente descartando tiles. Logo, baixar o limite sozinho piora preparação. Heap observado ao fim não é memória retida isolada nem comparação controlada.
- Worker de mobilidade mantém a rede; envia cópia completa com runtime para o thread principal, que também a mantém. Em prova Node adicional, `structuredClone` dessa rede de quatro tiles levou 271 ms (uma execução; não é medição da entrega de mensagens no Chrome). Para poucas centenas de agentes, a área preparada e os índices derivados precisam de orçamento explícito antes de alocar.
- Cada chegada de tile incrementa revisão visual; mensagens de cena reenviam a seleção inteira. O worker reaproveita tiles decodificados, mas recria o array da seleção e os índices da geometria.
- Cache de prédios guarda um OffscreenCanvas/contexto por prédio. O limite de bytes ignora estruturas nativas e comandos retidos. Mais de mil superfícies foram observadas em produção. A contenção existente limita a 256; isso não resolve o modelo nem a criação/evicção repetida em cenas densas.
- Cena produz um ImageBitmap de viewport inteira a cada quadro publicado e repõe os pixels na superfície do worker. Há múltiplas cópias/superfícies de apresentação reservadas no orçamento. Medir bytes publicados e frequência real antes de ampliar a arquitetura.
- UI escreve 'Carregando mapa…', mas não distingue primeira imagem utilizável, preparação de cena e detalhes complementares. A marca 'first-frame' pode significar apenas estado aberto, antes da imagem do worker.

## Alternativas e decisão proposta

1. Refatorar os caminhos existentes com dados especializados e preparação limitada antes de alocar (recomendado). Manter Canvas2D, workers e apresentação existentes; eliminar desperdícios mensuráveis e preservar a imagem.
2. Reescrever o renderizador em WebGL/instancing. Potencial maior, mas exige refazer materiais, oclusão, seleção e fallback sem evidência de necessidade.
3. Reduzir globalmente resolução, agentes e detalhe. Pode ser mitigação temporária, mas conserva trabalho repetido e esconde problemas.

## Fluxo proposto

### Dados, cache e mobilidade

Decodificador recebe seleção explícita de camadas. Tráfego decodifica somente ruas desde o PBF; não decodificar tudo para filtrar depois. Cache separa finalidade e versão, contabiliza geometrias retidas e publica métricas. Tiles imutáveis já disponíveis permanecem reutilizáveis. Evitar reenviar seleções completas quando apenas um tile muda; medir separadamente serialização, recepção e instalação da rede. Uma rede deve ter um dono da preparação, e a entrega precisa ser compacta e incremental; não criar uma segunda cópia de objetos/índices completa a cada movimento da câmera. Qualquer mudança de representação mantém as APIs de rota e as invariantes de topologia.

Construção de rede recebe orçamento de entrada e de trabalho antes da expansão. Escolha determinística por proximidade do foco; topologia completa das regiões aceitas, sem arestas penduradas. Interseções e duplicações não tornam uma estimativa por vértices um limite exato: reservar margem, impor um limite durante geração e interromper preparação excessiva antes de acumular toda a rede. Preservar sentido único, pontes, túneis, rotas e conectividade dos tiles aceitos. Continuar com rede anterior compatível enquanto uma nova é preparada; resultados obsoletos nunca são instalados.

Selecionar área de tráfego pela área necessária ao movimento visível e uma margem pequena, com histerese para evitar reconstruir ao cruzar bordas. Não preparar nove viewports sem necessidade. Medir antes de escolher novos tetos de arestas.

### Raster e composição

Separar imagem reutilizável de contexto mutável. Cache de prédio retém ImageBitmap com `close()` na liberação, produzido por uma superfície temporária reutilizada, em vez de manter um contexto de desenho por edifício. Fallback mantém comportamento nos ambientes sem transferência de bitmap. Superfície temporária tem dono, orçamento e descarte explícitos. Testar se esta abordagem reduz recursos nativos e custo; só adotá-la se passar comparação visual e desempenho.

Preservar ordenação e oclusão. Não colar carros em cima de uma imagem única de prédios. Preparação estática e quadro dinâmico continuam distintos. Revisões de carregamento sem mudança de geometria não invalidam produtos estáticos. Coalescer atualizações sem atrasar arbitrariamente o primeiro tile útil.

### Experiência durante preparação

Estado explícito: abrindo sessão → carregando primeiro mapa → preparando primeira cena → utilizável → atualizando detalhes / erro recuperável.

Antes da primeira imagem utilizável, indicador central de 'Carregando cidade…', presente já no HTML, com status acessível e sem barra de progresso inventada. Após primeira imagem, indicador discreto 'Atualizando mapa…' quando necessário. Preservar câmera, imagem anterior e controles durante preparação; não cobrir nem bloquear o jogo em cada tile. Erro mostra caminho de tentar novamente. Animação/simulação visual complementar só entra depois de uma cena utilizável; os dados duráveis não dependem da taxa de desenho.

### Composição inicial e módulos opcionais

Separar coordenação de cena/streams, carregamento regional e ativação dos painéis da raiz de `main.ts`. Carregar código/dados opcionais quando a área ou painel exigir; não retirar recursos de mundo persistente e colaboração previstos na arquitetura. Evitar uma extração meramente cosmética: confirmar redução no bundle inicial e no trabalho de início.

## Sequência de implementação

1. Congelar benchmark e instrumentar custo de decode, rede, mensagens, preparação, raster e apresentação, com baseline comparável.
2. Decodificação especializada para mobilidade e orçamento de construção antes de expansão; regressões de topologia/cancelamento.
3. Cache de imagens com contexto reutilizado; comparação da mesma cena/câmera, quadro visual equivalente, memória e tempo.
4. Estado de carregamento e primeira apresentação real; controles não bloqueantes e erros recuperáveis.
5. Dividir a raiz e adiar módulos regionais/painéis opcionais com comparação de bundle e início.

## Critérios de aceitação

- Na mesma seleção de quatro tiles, worker de tráfego não materializa geometrias fora de ruas e rede mantém topologia equivalente quando cabe no orçamento.
- Entradas densas/pathológicas respeitam teto de construção durante o trabalho; não formar redes ilimitadas para só depois descartar.
- Número de contextos Canvas2D de cache não cresce por edifício nos navegadores com ImageBitmap. Bitmap evictado/descartado é fechado uma única vez.
- Câmera e controles continuam respondendo enquanto cena é preparada; a primeira imagem utilizável encerra o indicador principal.
- Pausa não continua produzindo quadros idênticos; câmera parada com movimento não redecodifica geometria nem reconstrói rede.
- Comparações de início frio/quente, navegação densa e viagens repetidas com a mesma viewport, escala, fontes, velocidade e uma aba ativa. Registrar heaps quando disponíveis sem apresentá-los como memória total.
- Alvo inicial: trabalho por quadro estável p95 até 33 ms, controles sem tarefas longas recorrentes acima de 50 ms no thread principal, estabilidade de memória após viagens/GC. Se não alcançar, medir e revisar antes de declarar sucesso.
- Testes de regressão, build, lint dos arquivos alterados e inspeção visual no Chrome real. Não inferir que o crash nativo original foi corrigido somente porque não reapareceu.

## Escopo e riscos

Não migrar protocolo/saves, adicionar servidor, remover funcionalidades ou reescrever todo o jogo. O orçamento de rede pode limitar cobertura; deve ser observável e não anunciado como dados completos. ImageBitmap pode mover custo ao driver; validar no Chrome real antes de escolher esse cache. Otimizações serão mantidas somente com evidência; uma implementação anterior de desempenho já existe e precisa ser corrigida, não duplicada.
