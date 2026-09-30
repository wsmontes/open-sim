# Open Sim

Jogo fofo de construir e reformar cidades reais, em perspectiva isométrica fixa, inspirado na simplicidade do SimCity 2000. O mundo parte da geografia do OpenStreetMap: a cidade aparece com ruas, construções, água e vegetação que existem na fonte, e o jogador reforma quarteirões, abre ruas, oferece energia e expande para áreas vazias do mesmo terreno contínuo.

Este repositório é um protótipo com escopo aprovado: cliente de referência no navegador, partida individual, salvamento local e terreno plano (sem relevo real). Aplicativo desktop empacotado, contas e partida em rede ficam para etapas posteriores — a arquitetura já está preparada para eles (ver `docs/implementation.md`).

## Executar

Node 22.12 ou superior (desenvolvido com Node 26.8.1 e npm 11.19.0).

```sh
npm ci
npm run dev          # abre o cliente em http://127.0.0.1:5173
```

Outros comandos:

```sh
npm test             # suíte Vitest completa
npm run typecheck    # projeto inteiro (src, tests, tools)
npm run typecheck:core   # só o núcleo, sem DOM e sem tipos de Node
npm run build        # typecheck + build de produção em dist/
npm run preview      # serve o build
npm run replay -- tests/fixtures/portable-scenario.json   # executor independente do núcleo
```

Para conferir a portabilidade no navegador, rode `npm run dev` e abra `http://127.0.0.1:5173/tests/browser/replay.html`: a página executa o mesmo cenário sintético com o mesmo núcleo e imprime exatamente o mesmo texto canônico que o executor Node.

## Controles

- **Ferramentas** (barra inferior): explorar, rua, residencial, comércio, indústria, energia, parque e demolir, com o custo de cada uma. Esc volta para explorar.
- **Construir**: clique ou arraste com a ferramenta ativa. Arrastar rua desenha um traço; células já ocupadas ficam bloqueadas e a prévia mostra o custo antes do clique (verde quando cabe no saldo, vermelha quando não).
- **Câmera**: botão do meio ou espaço + arrasto desloca; a roda do mouse ajusta o zoom (0,5×–3×) ancorado no ponteiro.
- **Tempo**: pausa, 1× (um tick por segundo) e 2× (dois por segundo). Com a aba oculta o relógio para e não compensa o tempo escondido.
- **Lugares**: atalhos para Vancouver, São Paulo e Lisboa, ou latitude/longitude. Mudar de lugar só move a câmera: a partida e os trechos administrados continuam os mesmos. Apenas visitar uma região não dá dinheiro, população nem crescimento — ela entra na economia na primeira intervenção aceita.
- **Salvamento**: automático (após alterações e ao ocultar a página) no IndexedDB do navegador. A barra inferior informa "Salvando…", "Salvo" ou o motivo da falha. Se o save guardado for ilegível ou de versão desconhecida, o jogo avisa e **não** sobrescreve sozinho — há um botão explícito para substituí-lo.

Indicadores: dinheiro, população, energia (usada/fornecida) e felicidade.

## Dados do mundo real

- Fonte: tiles vetoriais **Shortbread v1** em `https://vector.openstreetmap.org/shortbread_v1/{z}/{x}/{y}.mvt`, zoom canônico 14 (o zoom visual não muda a fonte da simulação). Atribuição sempre visível: **© OpenStreetMap contributors** (`https://www.openstreetmap.org/copyright`).
- Uso conforme a política de tiles vetoriais da OSM Foundation: somente a área visível, no máximo quatro requisições simultâneas, cache HTTP padrão e cache de memória limitado a 32 tiles, sem download em massa. O jogo **nunca** escreve no OpenStreetMap.
- A grade é global e contínua (`2 ** 22` células por eixo, trechos de `32 × 32`), com longitude circulando no antimeridiano. Cada célula tem um único dono, então cruzar borda de trecho não duplica nem ressuscita construção.
- Edifícios mapeados aparecem ocupados desde o começo, com energia básica calculada pelo jogo e sem cobrança retroativa; a base geográfica de cada região administrada é congelada no save, então uma atualização do mapa não muda uma partida em andamento.
- Altura, fachada, moradores e uso exato **não** vêm da fonte: quando o dado não traz o uso, o jogo escolhe residencial/comercial/industrial de forma determinística e apresenta isso como simulação. Dinheiro, população, energia e felicidade são valores do jogo, não estatísticas reais.
- A ausência de relevo é uma simplificação do protótipo: o OpenStreetMap não é uma base de elevação.

## Testes

`npm test` roda tudo:

| Arquivo | O que trava |
| --- | --- |
| `tests/coordinates.test.ts`, `tests/commands.test.ts` | grade global, antimeridiano, custos, atomicidade do lote, deduplicação por sequência, revisão antiga |
| `tests/simulation.test.ts` | crescimento determinístico, energia, economia e felicidade independentes da câmera e da ordem dos trechos |
| `tests/normalize.test.ts`, `tests/map-provider.test.ts` | conversão do mapa real (água, buracos, ponte, vias dirigíveis, vegetação), cache, concorrência, erro de rede sem terreno inventado |
| `tests/snapshot.test.ts`, `tests/session.test.ts` | validação de snapshot, restauração sem OSM, retorno tardio de mapa, save corrompido sem sobrescrita, falha de escrita, fila serial |
| `tests/presentation.test.ts` | projeção e seleção (inclusive no antimeridiano), traço de rua deduplicado, relógio pausado/oculto sem rajada, prévia de custo igual ao núcleo |
| `tests/replay.test.ts` | cenário sintético executável, reenvio tolerado, equivalência depois de salvar e restaurar |
| `tests/architecture.test.ts` | limites de importação entre camadas, nenhuma dependência de plataforma ou Nostr no `src`, nenhum `Date`/`Math.random` no núcleo, núcleo compilando sem DOM/Node |

## Estado das entregas

- **Pronto**: núcleo portátil (grade, comandos, economia, crescimento); adaptador de mapa real isolado; sessão local com snapshots versionados, autosave e IndexedDB; cliente browser jogável com arte isométrica própria; prova de portabilidade rodando o mesmo cenário em Node e no navegador com estado canônico idêntico.
- **Fora deste ciclo**: empacotamento desktop (Electron/Tauri), multiplayer e Nostr, contas e permissões, relevo real, redes de água, trânsito com rotas, desastres, busca mundial por nome e fachadas específicas.
- O executor Node (`npm run replay`) é uma prova de portabilidade, não um aplicativo desktop.

`docs/implementation.md` descreve os contratos, os limites entre módulos e como trocar a fonte de mapa, o armazenamento e o renderizador. `docs/architecture.md` é a carta de arquitetura de longo prazo (mundos interoperáveis, autoridade e transporte).
