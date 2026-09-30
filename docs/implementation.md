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

## Formatos portáteis

Todos os dados são objetos JSON, sem `Map`, `Set`, função ou valor não finito, com versão explícita.

- **Grade global** (`src/core/coordinates.ts`): `2 ** 22` células por eixo. X circula no antimeridiano (`wrapX`); Y fica dentro da cobertura Web Mercator. Trechos têm `32 × 32` células e endereço `cx:cy` derivado da divisão inteira. A resolução geográfica não depende do zoom da câmera.
- **Célula** (`src/core/model.ts`): terreno (`land`, `water`, `green`), via opcional, ocupação opcional (`residential`, `commercial`, `industrial`, `park`, `power`), estágio e origem (`imported`, `player`). Ausência de dado não é terreno: é estado de carregamento.
- **`BaseChunk`**: id, fonte, `normalizerVersion`, 1024 células ordenadas por Y e X. É a base congelada de uma região administrada.
- **`GameState`**: `formatVersion`, `rulesVersion`, `worldId`, `seed`, `revision`, `tick`, saldo inteiro, trechos administrados (base congelada + edições explícitas + resumo econômico) e último número aceito por ator.
- **`Action` / `Command` / `CommandResult`**: a ação é de domínio (`build`, `demolish`, `tick`); o envelope acrescenta `version`, `worldId`, `actorId`, `sequence` e `expectedRevision`. `(worldId, actorId, sequence)` identifica uma tentativa. Deduplicar vem **antes** de conferir a revisão: número já aceito devolve `duplicate` sem cobrar de novo; lacuna de sequência ou revisão antiga devolve `rejected` sem tocar no estado. Um lote é atômico.
- **`SavedGame` / `ViewState`**: `{version, state, view}`; a câmera, o zoom, a velocidade e o lugar ficam no `view`, fora do estado compartilhável da cidade.
- **`canonicalJson`** (`src/core/snapshot.ts`): chaves ordenadas, sem espaços, terminador `\n`. É o mesmo texto para o mesmo valor em qualquer runtime — é o que permite comparar o replay do Node com o do browser byte a byte.

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
interface MapSource {
  loadChunk(id: string): Promise<BaseChunk>;
  attribution: { text: string; url: string };
}
```

`createOsmSource(config)` (`src/adapters/osm/provider.ts`) busca Shortbread em `vector.openstreetmap.org` no zoom canônico 14, com no máximo quatro requisições simultâneas, deduplicação de pedidos em voo, cache HTTP padrão e cache de memória de 32 tiles. Falha de rede ou timeout rejeita a promise: o adaptador **nunca** inventa terreno, e o trecho fica em estado recuperável que o cliente pode tentar de novo.

Trocar a fonte (outro fornecedor, arquivo local, dados de teste) é implementar `loadChunk` devolvendo `BaseChunk` com `source` e `normalizerVersion` honestos. O cliente monta o adaptador em `src/browser/main.ts`, em uma linha.

### Armazenamento — `SaveStore`

```ts
interface SaveStore {
  read(slot: string): Promise<unknown | null>;
  write(slot: string, data: SavedGame): Promise<void>;
}
```

`createIndexedDbStore()` usa uma base `open-sim` com um object store `saves`, uma transação de substituição por slot e resolve só no `oncomplete`. `createMemoryStore()` existe para cenários e testes. Qualquer implementação nova (arquivo em desktop, servidor) precisa apenas de leitura, escrita e falha honesta: nada de regra econômica aqui.

### Apresentação

`src/presentation/` é receita, não biblioteca de framework: `camera.ts` (projeção isométrica 32×16, `project`/`pick`/`centerOn`/`visibleChunks`), `canvas-renderer.ts` (`render(ctx, WorldView)`, desenho determinístico derivado das coordenadas e da semente), `input.ts` (`attachInput`, traço de rua deduplicado), `hud.ts` (barra de ferramentas, indicadores, lugares, mensagens; recebe estado e callbacks) e `clock.ts` (relógio de ticks).

Trocar o desenho é escrever outra função `render` que consuma o mesmo `WorldView` — ela recebe câmera, viewport, estado, status de trechos, seleção e prévia, e nada de HTTP ou armazenamento. Trocar os controles é outro `attachInput` com os mesmos callbacks. Um cliente com WebGL, terminal ou canvas de desktop não precisa tocar no núcleo.

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
