# Open Sim — implementação atual: contratos e limites

Este documento descreve o que existe hoje no repositório: contratos, limites entre módulos e pontos de extensão do protótipo. Ele é a referência para trocar adaptadores ou acrescentar um cliente (aplicativo desktop, futura partida em rede) sem mover regras para a interface. A visão de longo prazo — mundos interoperáveis, autoridade, transporte e perfis de jogo — está em `docs/architecture.md`.

## Camadas

| Camada | Arquivos | Pode importar |
| --- | --- | --- |
| Núcleo | `src/core/*` | apenas `src/core` |
| Sessão | `src/session/*` | núcleo e `src/session` |
| Adaptadores | `src/adapters/osm/*`, `src/adapters/storage/*` | núcleo, contratos da sessão, `@mapbox/vector-tile`, `pbf` |
| Apresentação | `src/presentation/*` | núcleo, contratos da sessão, `src/presentation` |
| Cliente | `src/browser/*`, `index.html`, `src/browser/style.css` | todas as camadas |

`tests/architecture.test.ts` verifica isso de verdade, não por busca textual: extrai cada especificador com um tokenizador, resolve importações relativas pelo caminho real e pacotes pela resolução do Node, e recusa qualquer arquivo de `src` que alcance módulo nativo do Node, `electron`, `tauri` ou `nostr`. Também recusa `Date` e `Math.random` no núcleo e compila `src/core` com o compilador TypeScript sem DOM e sem tipos de Node.

A direção das dependências é única: o núcleo nunca conhece sessão, adaptador, apresentação ou browser. Um futuro host desktop pode reutilizar o cliente atual ou escrever outro; nenhuma regra econômica mora na interface.

## Contrato portátil

O que um cliente diferente precisa saber para conviver com este aqui está em `docs/world-protocol.md`: manifesto do mundo (`src/core/protocol.ts`), componentes com namespace no estado durável, preservação do que o cliente não entende ao ler e gravar (`src/core/snapshot.ts`) e identidade durável por texto canônico (`durableJson`, endereçável com `sha256` pelo adaptador em `src/adapters/hash/content.ts`). O perfil cidade continua dono do seu próprio estado (`chunks`, `money`, `tick`) e outro perfil anexa o dele sem editar este código.

## Formatos portáteis

Todos os dados são objetos JSON, sem `Map`, `Set`, função ou valor não finito, com versão explícita.

- **Grade global** (`src/core/coordinates.ts`): `2 ** 22` células por eixo. X circula no antimeridiano (`wrapX`); Y fica dentro da cobertura Web Mercator. Trechos têm `32 × 32` células e endereço `cx:cy` derivado da divisão inteira. A resolução geográfica não depende do zoom da câmera.
- **Célula** (`src/core/model.ts`): terreno (`land`, `water`, `green`), via opcional, ocupação opcional (`residential`, `commercial`, `industrial`, `park`, `power`), estágio e origem (`imported`, `player`). Ausência de dado não é terreno: é estado de carregamento.
- **`BaseChunk`**: id, fonte, `normalizerVersion`, 1024 células ordenadas por Y e X. É a base congelada de uma região administrada.
- **`GameState`**: `formatVersion`, `rulesVersion`, `worldId`, `seed`, `revision`, `tick`, saldo inteiro, trechos administrados (base congelada + edições explícitas + resumo econômico) e último número aceito por ator.
- **`Action` / `Command` / `CommandResult`**: a ação é de domínio (`build`, `demolish`, `tick`); o envelope acrescenta `version`, `worldId`, `actorId`, `sequence` e `expectedRevision`. `(worldId, actorId, sequence)` identifica uma tentativa. Deduplicar vem **antes** de conferir a revisão: número já aceito devolve `duplicate` sem cobrar de novo; lacuna de sequência ou revisão antiga devolve `rejected` sem tocar no estado. Um lote é atômico.
- **`SavedGame` / `ViewState`**: `{version, state, view}`; a câmera, o zoom, a velocidade e o lugar ficam no `view`, fora do estado compartilhável da cidade.
- **`canonicalJson`** (`src/core/snapshot.ts`): chaves ordenadas, sem espaços, terminador `\n`. É o mesmo texto para o mesmo valor em qualquer runtime — é o que permite comparar o replay do Node com o do browser byte a byte.

Os limites de zoom da visão salva (`VIEW_ZOOM_MIN`/`VIEW_ZOOM_MAX`, 0,05 a 3) ficam no núcleo porque o snapshot precisa validá-los; a câmera isométrica é apresentação e apenas reutiliza as mesmas constantes. Sem isso, ampliar a faixa de zoom tornaria ilegível todo save existente — e o jogador veria "save incompatível" depois de uma mudança de código.

Versões: `formatVersion` e `rulesVersion` descrevem o estado; `SAVE_VERSION` o envelope; `normalizerVersion` a conversão do mapa. Mudar regra de simulação exige subir `rulesVersion`; `decodeSave` recusa versões que não conhece em vez de adivinhar.

## Sessão local

`createSession({maps, saves, worldId, seed, slot?, actorId?})` coordena uma partida:

- `initialize(id)` lê o slot uma vez. Slot vazio carrega o trecho inicial do mapa e cria a partida. Save válido restaura **sem consultar o OSM**: cada trecho administrado volta `ready` a partir da base congelada. Save ilegível ou de versão desconhecida vira status observável `blocked` e **as escritas ficam bloqueadas** (nada sobrescreve automaticamente); o jogador segue jogando em memória e só um `enableSaving()` explícito libera a substituição.
- `loadVisible(ids)` apenas carrega e atualiza o status de cada trecho (`loading`, `ready`, `error`). Não adota trecho nenhum, não mexe em câmera e um retorno tardio só altera o status do seu próprio id. Só `initialize` adota o trecho inicial; intervenções aceitas adotam os demais.
- `dispatch(action)` monta o envelope local (`sequence = último aceito + 1`, `expectedRevision = revision`) e chama o núcleo com as bases já carregadas. Estado só muda quando o resultado é `applied`.
- `save(view)` é serial: nunca há duas escritas em voo, a mais recente vence, e a promise resolve no fim da escrita correspondente. **Nunca rejeita**: falha aparece em `getSaveStatus()` e o progresso em memória fica intacto.
- `subscribe(listener)` avisa em comando aplicado e em mudança de status de trecho.

O agendamento pertence ao cliente: autosave com debounce de 500 ms quando `revision` muda, `pagehide`/aba oculta, um tick por segundo em 1× e dois em 2× com suspensão enquanto o documento está oculto (sem compensar o tempo escondido). Renderizar mais quadros nunca acelera a simulação.

## Adaptadores

### Mapa — `MapSource`

```ts
type MapLevel = 'detail' | 'overview';
interface MapSource {
  loadChunk(id: string, level?: MapLevel): Promise<BaseChunk>;
  attribution: { text: string; url: string };
}
```

`detail` é o Shortbread no zoom canônico 14; `overview` é o mesmo fornecedor no zoom 11, onde água, uso do solo e vias principais existem e **prédio não existe** (o TileJSON declara `buildings` com `minzoom=14`, `sites`/`addresses`/`pois` idem). Um save registra a aproximação na própria `source` do trecho (`… (aproximação z11)`), e o núcleo nunca adota uma aproximação: `available` em `dispatch` só aceita trechos `level: 'detail'`, então intervir numa área que só existe grosseira é recusado com "Espere o mapa carregar" e o cliente responde carregando aquele trecho em detalhe.

`createOsmSource(config)` (`src/adapters/osm/provider.ts`) busca Shortbread em `vector.openstreetmap.org` no zoom canônico 14, com no máximo quatro requisições simultâneas, deduplicação de pedidos em voo, cache HTTP padrão e cache de memória de 32 tiles. Falha de rede ou timeout rejeita a promise: o adaptador **nunca** inventa terreno, e o trecho fica em estado recuperável que o cliente pode tentar de novo.

Trocar a fonte (outro fornecedor, arquivo local, dados de teste) é implementar `loadChunk` devolvendo `BaseChunk` com `source` e `normalizerVersion` honestos. O cliente monta o adaptador em `src/browser/main.ts`, em uma linha.

### Armazenamento — `SaveStore`

```ts
interface SaveStore {
  read(slot: string): Promise<unknown | null>;
  write(slot: string, data: SavedGame): Promise<void>;
}
```

`createIndexedDbStore({name?, factory?, timeoutMs?})` usa uma base `open-sim` com um object store `saves`, uma transação de substituição por slot e resolve só no `oncomplete`. O `open` é **limitado no tempo** e trata `blocked`/`versionchange`: uma aba que morre segurando a conexão (ou outra aba no meio de um upgrade) deixava `indexedDB.open()` pendurado para sempre e o jogo congelava num mapa vazio sem mensagem — hoje isso vira erro em português com instrução de fechar as outras abas, e uma leitura impossível faz a sessão começar em memória com o slot intacto e o salvamento bloqueado até o jogador mandar sobrescrever. `createMemoryStore()` existe para cenários e testes. Qualquer implementação nova (arquivo em desktop, servidor) precisa apenas de leitura, escrita e falha honesta: nada de regra econômica aqui.

### Apresentação

`src/presentation/` é receita, não biblioteca de framework: `camera.ts` (projeção isométrica 32×16, `project`/`pick`/`centerOn`/`visibleChunks`/`zoomTo`/`closestChunks`, zoom de 0,05× a 3×), `canvas-renderer.ts` (`render(ctx, WorldView)`), `input.ts` (`attachInput`, traço de rua deduplicado), `hud.ts` (barra de ferramentas, indicadores, lugares, mensagens; recebe estado e callbacks) e `clock.ts` (relógio de ticks).

Duas escalas de desenho convivem, escolhidas por `isCoarse` (passo de célula abaixo de `COARSE_STEP` = 6 pixels de buffer):

- **zoom de célula** (acima do limiar): um losango por célula, com telhado, fachada, árvores e vias desenhados a partir das coordenadas e da semente. A ordem de pintura é estável (linhas de `x+y` crescente) e o que a câmera não vê é recortado.
- **mosaico de trecho** (zoom amplo): a cidade inteira não caberia célula a célula — a 0,05× uma célula tem menos de dois pixels e uma tela larga cobre centenas de trechos. `aggregateCells` resume cada trecho em 8×8 blocos de 4×4 células cuja cor segue o que domina o bloco (água, asfalto, vegetação ou o telhado do tipo mais frequente; blocos mistos usam a média ponderada). O resultado é determinístico, reage às edições do jogador, fica em cache por trecho (invalidado por revisão nos trechos administrados) e mantém 60 fps com a cidade toda na tela. Área ainda carregando ou com erro continua com o padrão de hachura, nunca com terreno inventado.

Trocar o desenho é escrever outra função `render` que consuma o mesmo `WorldView` — ela recebe câmera, viewport, estado, status de trechos, seleção e prévia, e nada de HTTP ou armazenamento. Trocar os controles é outro `attachInput` com os mesmos callbacks. Um cliente com WebGL, terminal ou canvas de desktop não precisa tocar no núcleo.

### Memória durante a exploração

A sessão guarda três coisas: as regiões que o cliente diz que vê agora (`retainVisible`, chamado a cada parada de câmera), as regiões administradas — que valem pelo estado durável, não pelo cache — e até 256 regiões recentes fora da janela visível. O resto é descartado por uso recente (a ordem do `Map` é a ordem de uso), o que impede uma exploração longa de crescer sem limite. Uma resposta de rede que chega para uma região já descartada é **ignorada** (cada pedido tem uma senha; o descarte apaga a senha), e um pedido novo para a mesma região nunca é sobrescrito pelo antigo. A LRU de 32 tiles do fornecedor e o limite de quatro requisições simultâneas continuam como estavam.

O carregamento é racionado e em dois tempos: `visibleChunks` resolve os trechos visíveis (passo em nível de trecho, não de célula, com meia célula de folga para casar com o desenho), o cliente pede primeiro a passada grosseira (`overview`, até 512 trechos — um tile z11 cobre 4.096 trechos, então a cidade inteira cabe em uma ou duas requisições) e em seguida a passada detalhada (`detail`, até 120 por vez, mais próxima do centro primeiro, repetindo enquanto sobrar área). Falha de rede não dispara novas tentativas automáticas — o jogador decide pelo botão.

Medido em São Paulo (cidade densa, Chromium, viewport 1440×900): a vista ampla de 412 trechos aparece pintada em menos de um segundo, fica completa em ~4 s e custa **2 tiles grosseiros + 8 detalhados**; a 0,05× o desenho sustenta **60 fps**.

### Onde o tempo estava indo

Normalizar um trecho custava de 4 a 51 segundos *por tile* em cidades densas:

| Cidade | Regiões/s antes | Regiões/s depois |
| --- | --- | --- |
| Vancouver centro | 19 | 424 |
| Lisboa Baixa | 4 | 481 |
| São Paulo centro | 1 | 374 |

Três correções, todas com a mesma saída trecho a trecho (hashes comparados antes e depois):

1. **Anel por anel em vez de feature por célula.** O tile traz *uma* feature `buildings` com milhares de anéis (São Paulo: 10.137 anéis, 108 mil pontos). O código antigo testava cada célula da região contra **todos** os anéis; agora cada anel é recortado pela sua própria caixa envolvente e a paridade é acumulada por célula, o que preserva o resultado ímpar-par (buracos continuam buracos) e corta ~300× o trabalho.
2. **Ordenação uma vez por tile** (`WeakMap` sobre a lista de features) e **índice de features por trecho** no adaptador, em vez de reordenar e varrer o tile inteiro em cada uma das 64 regiões.
3. **Cache do mosaico com chave por nível**, para uma região que chegou grosseira ser redesenhada quando o detalhe chega (e teto de 2.048 entradas, senão com centenas de regiões em dois níveis o cache entra em thrashing e o quadro cai de 60 para 22 fps).

## Mapa real

A fonte confirmada é `https://vector.openstreetmap.org/shortbread_v1/{z}/{x}/{y}.mvt` (TileJSON: esquema Shortbread, `minzoom 0`, `maxzoom 14`), com atribuição `© OpenStreetMap` e a política de tiles vetoriais da OSM Foundation: uso interativo, cache conforme os cabeçalhos, sem download em massa. O jogo **nunca** envia alterações ao OpenStreetMap.

`normalizeChunk(id, features)` converte a geometria vetorial para a grade, com tabelas explícitas de *kind* (a comparação com dados reais em 2026-09-29 mostrou que casar por substring estava errado: `/park/` também casa com `parking`):

- Rua: somente vias dirigíveis (`motorway`…`service`, com `_link`) e `street_polygons` `pedestrian`/`service`. Contar calçadas, escadas, ciclovias e praças como rua cobria 55–59% de um trecho central e apagava construções importadas sob o asfalto; só vias dirigíveis derrubaram isso para ~20–34% e devolveram os quarteirões.
- Terreno verde: apenas kinds de vegetação e recreação (`park`, `garden`, `grass`, `forest`, `meadow`, `scrub`, `farmland`, `recreation_ground`, `cemetery`…). Áreas de estacionamento (`sites/parking`) continuam terreno comum.
- Ordem de prioridade: água e verde primeiro, construções depois, vias por último; via sobre água só quando o dado traz `bridge`. Prédio sem uso declarado recebe classificação determinística (residencial/comercial/industrial por hash da coordenada) e isso é apresentado como simulação.
- Fronteiras: os tiles do fornecedor trazem geometria com buffer além da borda, então uma construção ou uma costa que cruza o limite aparece igual nos dois lados; o endereço do trecho (divisão inteira) garante uma única identidade por célula. O antimeridiano circula: um trecho a 179,99° e outro a −179,99° carregam tiles reais sem caso especial.

O que o adaptador **não** promete: altura, fachada, moradores, endereço ou uso exato. A camada básica de edifícios do Shortbread não traz tudo o que o OSM tem.

## Simulação

`src/core/simulation.ts` mantém as constantes: crescimento a cada cinco ticks, contabilidade a cada 30, quatro moradores por lote residencial, seis e dez empregos em comércio e indústria, 64 unidades de energia por usina e duas por construção ocupada, renda por construção ocupada (4/6/8), manutenção de rua, parque e usina, felicidade com bônus de parque e penalidade de indústria num raio Manhattan de oito células. Crescer exige rua adjacente ortogonal, energia disponível e felicidade local mínima. A ordem é global e estável: inserir trechos em ordem diferente não muda o resultado, e a câmera não é argumento de nada.

`src/core/quote.ts` responde "quanto custa e pode?" antes do clique, espelhando exatamente as checagens de `applyCommand` — água bloqueia, rua existente é grátis, ocupado bloqueia, trecho não carregado bloqueia, lote é deduplicado. `tests/presentation.test.ts` compara o custo orçado com o saldo efetivamente cobrado pelo núcleo em vários lotes, o que trava a divergência entre prévia e cobrança.

## Prova de portabilidade

Um cenário é um documento `{version, worldId, seed, initial, commands}` (o `worldId` foi acrescentado ao esboço do plano porque `createGame` exige um e todo comando carrega o seu). `replayScenario` usa apenas o núcleo e tolera envelope reenviado (`duplicate`), recusando qualquer coisa que o núcleo rejeitaria.

- Node: `npm run replay -- tests/fixtures/portable-scenario.json` imprime o estado canônico; cenário inválido sai com código 1.
- Browser: `tests/browser/replay.html` importa a **mesma** função e imprime o mesmo texto.
- Verificado em 2026-09-29: os dois textos têm o mesmo SHA-256 (`b1d35e43…`), 20.623 bytes, e `tests/replay.test.ts` também prova que salvar e restaurar no meio do cenário produz o mesmo estado final.

## Caminho futuro para Nostr (não implementado)

Nada aqui abre conexão, pede chave ou define kind. O que já existe é o que um adaptador de rede vai consumir: comandos serializáveis com sequência e revisão, deduplicação, recuperação por snapshot e um envelope com `actorId` opaco.

Decisões registradas para essa etapa: identidade por chave pública **não** concede permissão (NIP-02 descreve listas de contatos, não autorização); um anfitrião autoritativo ordena e publica resultados com sequência crescente; réplicas verificam anfitrião, sessão e sequência; horários de evento não são consenso; reenvio, lacuna de sequência, reconexão e recuperação por snapshot são obrigatórios; snapshots carregam `rulesVersion` e a base geográfica congelada para dois jogadores não simularem bases diferentes. Migração de anfitrião e colaboração offline simultânea estão fora do escopo.

## Notas de ferramenta

- TypeScript 7 (compilador nativo) não expõe a API JS clássica: `typescript` resolve para `lib/version.cjs` e `typescript/unstable/*` não traz um parser utilizável. Por isso `tests/architecture.test.ts` usa um tokenizador próprio para o grafo de importação e delega a decisão sobre DOM/Node ao próprio compilador.
- `tsconfig.json` declara `"types": ["node"]` explicitamente (o TypeScript 7 não inclui `@types` automaticamente). `tsconfig.core.json` sobrescreve com `"types": []` e `lib: ["ES2022"]`, que é o que prova a ausência de DOM e Node no núcleo.
- `vite.config.ts` serve em `127.0.0.1:5173` com alvo `es2022`; o canvas desenha em buffer de metade do tamanho CSS e é esticado sem suavização, o que dá o visual de baixa resolução.
