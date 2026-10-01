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
npx tsx tools/world-replay.ts    # conformidade OpenSim 0.1: replay do pacote público + checklist do §47
```

Para conferir a portabilidade no navegador, rode `npm run dev` e abra `http://127.0.0.1:5173/tests/browser/replay.html`: a página executa o mesmo cenário sintético com o mesmo núcleo e imprime exatamente o mesmo texto canônico que o executor Node.

Para conferir a conformidade com o protocolo de outra forma, abra `http://127.0.0.1:5173/tests/browser/world-replay.html`: a página busca o mesmo pacote sintético que o executor Node lê do disco, roda o mesmo replay e imprime o texto canônico inteiro — o endereço e o hash semântico de cada caso têm de ser idênticos nos dois runtimes. O contrato dessa fronteira está em [`docs/protocol/world-v2.md`](docs/protocol/world-v2.md) e a API dos adaptadores, com a matriz de capacidades comprovadas, em [`docs/protocol/adapters.md`](docs/protocol/adapters.md).

## Controles

- **Ferramentas** (painel FERRAMENTAS): explorar, rua, **avenida**, **estrada**, residencial, comércio, indústria, parque, energia e demolir, com o custo de cada uma no próprio botão. As teclas **1–9** e **0** escolhem ferramenta na ordem do painel; Esc volta para explorar.
- **Navegar**: arraste com o botão esquerdo para mover o mapa quando a ferramenta é Explorar. Com uma ferramenta de construção ativa, o botão esquerdo constrói (clique ou arraste) e o mapa continua se movendo com o botão direito, o botão do meio ou espaço + arrasto. A roda do mouse dá zoom ancorado no ponteiro; **Ctrl**/⌘ + arrasto (ou as teclas **Q**/**E**) giram a visão em torno do que está no centro da tela, e a bússola do painel MAPA volta ao norte. Os botões **−**/**+** ajustam o zoom e **Visão geral** mostra a cidade inteira e os arredores.
- **Painéis flutuantes**: todos os painéis (CIDADE, ECONOMIA, FERRAMENTAS, LUGARES, MAPA, SITUAÇÃO e os que só aparecem com histórico ou sessão) podem ser arrastados pelo cabeçalho e minimizados no botão do canto; a posição e o estado ficam guardados no navegador, então voltam como você deixou. O centro da tela nasce livre para o mapa.
- **Construir**: com a ferramenta ativa, a prévia mostra o custo antes do clique (verde quando cabe no saldo, vermelha quando não) e células ocupadas ou na água ficam bloqueadas. Arrastar rua desenha um traço e não cobra duas vezes pela mesma célula.
- **Vias com classes**: **rua** (barata, a cidade cresce até dois andares em volta), **avenida** (mais carregada, valoriza os lotes e é onde a cidade cresce para cima) e **estrada** (carrega o tráfego que a rua não carrega, mas o barulho afasta quem mora perto). A classe decide custo, manutenção, a altura que o lote pode alcançar, o valor da terra em volta e quanto tráfego a via mostra — e é a mesma classificação que o OpenStreetMap já traz: uma avenida real entra no jogo como avenida.
- **Câmera**: a roda do mouse dá zoom e a pinça faz o mesmo no toque; **Ctrl**/⌘ + arrasto (ou **Q**/**E**) giram, as setas movem o mapa (Shift acelera) e a bússola volta ao norte. Zoom, "Visão geral" e os atalhos de lugar **deslizam** até o destino em vez de saltar, e o zoom para em degraus que mantêm cada tile num número inteiro de pixels — é o que impede o borrão e o desaparecimento de detalhes de um pixel.
- **Carregamento**: a área visível aparece primeiro em uma passada grosseira (água, terra e vias principais) e ganha prédios e detalhe conforme os tiles chegam; uma vista de cidade inteira custa cerca de dez tiles. O rodapé mostra "Carregando mapa…" enquanto isso e oferece "Tentar novamente" se a rede falhar.
- **Tempo**: pausa, 1× (um tick por segundo) e 2× (dois por segundo). Com a aba oculta o relógio para e não compensa o tempo escondido.
- **Natureza**: árvores, bosques e relva vêm do próprio mapa (o uso do solo vira vegetação) e são desenhadas onde a célula diz que há verde, com espaçamento e porte sorteados por endereço; parques têm canteiros e árvores, avenidas têm o meio plantado, e a beira d'água ganha espuma. Nada disso é arte de terceiros: é tudo desenhado por código.
- **Vida nas ruas**: carros, pedestres, bicicletas em avenidas e caminhões em estrada aparecem conforme o que dá para as ruas — uma rua sem construção em volta fica vazia, uma rua de prédios altos tem trânsito; quem passa a pé precisa de uma loja ou praça ao lado. O movimento segue o relógio do jogo: pausa congela as ruas e 2× apressa. Nada disso é simulado nem guardado: é pintado a partir do mapa, do relógio e do mesmo sorteio determinístico que escolhe a cor de cada célula, então dois clientes mostram o mesmo trânsito sem trocar um único byte (§ a posição de um pedestre nunca vira comando).
- **Lugares**: atalhos para Vancouver, São Paulo e Lisboa, ou latitude/longitude. Mudar de lugar só move a câmera: a partida e os trechos administrados continuam os mesmos. Apenas visitar uma região não dá dinheiro, população nem crescimento — ela entra na economia na primeira intervenção aceita.
- **Economia**: o painel ECONOMIA mostra o mês da cidade — arrecadação, despesa, resultado, valor da terra, dívida, juros, nota de crédito e o que a cidade está pedindo em moradia/comércio/indústria. Dois controles deslizantes decidem o **imposto** (0–20%) e o **nível dos serviços** (50–150% do padrão) e têm efeito imediato no mês seguinte: imposto alto arrecada mais e esfria a demanda, serviço caro custa mais e faz a cidade crescer mais alto. **Emprestar 10.000** entra no caixa agora e a dívida passa a cobrar juros todo mês, mais caros quanto mais fundo o município estiver nela.
- **Salvamento**: automático (após alterações e ao ocultar a página) no IndexedDB do navegador. A barra inferior informa "Salvando…", "Salvo" ou o motivo da falha. Se o save guardado for ilegível ou de versão desconhecida, o jogo avisa e **não** sobrescreve sozinho — há um botão explícito para substituí-lo.

Indicadores: dinheiro, população, energia (usada/fornecida), felicidade e os números do mês no painel Economia.

## Dados do mundo real

- **Demografia e economia da cidade real**: a população vem da **Wikidata** (CC0), por nome ou pela coordenada em que o jogador está — a cidade do ponto, não a maior do país. Quando a Wikidata traz o código de município, o **IBGE** responde também, e os números do instituto oficial entram no lugar dos da enciclopédia: população do **Censo 2022**, área, **densidade** e **produto interno bruto municipal**. Duas fontes nunca são misturadas por média — um instituto oficial ganha da enciclopédia, o ano acompanha todo número ("11.451.999 · 2022") e o crédito nomeia as duas. Uma cidade sem censo publicado fica **sem** o número, nunca com zero.
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
| `tests/simulation.test.ts` | crescimento determinístico, energia e felicidade independentes da câmera e da ordem dos trechos |
| `tests/street-life.test.ts` | trânsito derivado e não guardado: dois clientes pintam a mesma rua, o carro mantém identidade e faixa enquanto anda, rua vazia fica vazia e o movimento nunca sai da via |
| `tests/economy.test.ts` | demanda que cresce e esfria, valor da terra pelas redondezas, orçamento mensal que fecha, serviços com consequência, dívida com nota de crédito e imposto que trava a ocupação |
| `tests/normalize.test.ts`, `tests/map-provider.test.ts` | conversão do mapa real (água, buracos, ponte, vias dirigíveis, vegetação), cache, concorrência, erro de rede sem terreno inventado |
| `tests/snapshot.test.ts`, `tests/session.test.ts` | validação de snapshot, restauração sem OSM, retorno tardio de mapa, save corrompido sem sobrescrita, falha de escrita, fila serial |
| `tests/ibge.test.ts` | os números municipais do instituto oficial: censo, área e densidade com o ano de cada um, produto municipal ao lado, figura não declarada ausente em vez de zero, e a segunda pergunta falhando sem derrubar a primeira |
| `tests/road-classes.test.ts` | as três classes de via: custo e manutenção, prévia igual ao comando, a altura que o lote alcança em cada uma (2, 3 e 1 andar) e o efeito de cada uma no valor da terra |
| `tests/render-cost.test.ts` | o custo de um quadro é limitado pelo que está na tela: detalhe decresce com a distância, afastar custa menos e não mais, e tirar a cidade do enquadramento não muda o trabalho |
| `tests/presentation.test.ts` | projeção e seleção (inclusive no antimeridiano), traço de rua deduplicado, relógio pausado/oculto sem rajada, prévia de custo igual ao núcleo |
| `tests/replay.test.ts` | cenário sintético executável, reenvio tolerado, equivalência depois de salvar e restaurar |
| `tests/world-conformance.test.ts` | pacote público de conformidade (merge, fontes e múltiplos perfis) reproduzido byte a byte: endereço do estado e da versão idênticos aos do repositório, mesmos bytes canônicos e mesmo hash semântico em Node e no navegador, recusas por bytes/digest/limite, e os schemas publicados conferem com o que o cliente emite |
| `tests/world-links.test.ts` | link fixo versus ramificação móvel, origem indisponível sobrevivida por uma cópia válida, visita que não herda permissão, cartão que recusa chave/estado por nome e ponte que deduplica pelo id original e para no limite de saltos |
| `tests/architecture.test.ts` | limites de importação entre camadas, nenhuma dependência de plataforma ou Nostr no `src`, nenhum `Date`/`Math.random` no núcleo, núcleo compilando sem DOM/Node |

## Estado das entregas

- **Pronto**: núcleo portátil (grade, comandos, crescimento e economia municipal jogável — imposto, serviços e empréstimo com juros); arte isométrica própria com ruas, prédios por andar, parques e vida nas ruas; adaptador de mapa real isolado; sessão local com snapshots versionados, autosave e IndexedDB; cliente browser jogável com arte isométrica própria; prova de portabilidade rodando o mesmo cenário em Node e no navegador com estado canônico idêntico.
- **Pacote público de conformidade**: o cliente publica a fronteira de interoperabilidade do **OpenSim Protocol 0.1** — envelope fechado, componentes abertos, quatro operações de estado, cinco operações de kernel, esquemas JSON em `schemas/world-v2/`, links entre mundos (versão fixa ou ramificação móvel, com lugar de chegada e capacidades declaradas) e cartões públicos que recusam chave e estado por nome. `tests/fixtures/federated-world/conformance.json` (CC0-1.0, sintético) é reproduzido com o mesmo endereço de estado e o mesmo hash semântico em Node e no navegador, e `tools/world-replay.ts` roda o pacote mais o checklist do §47.
- **Contrato portátil em andamento**: o estado durável já aceita componentes com namespace (`lifesim.residence`, `vehicle.transform`…) que outros clientes escrevem e este preserva sem entender, um manifesto identifica mundo/regra/base/linhagem e existe identidade durável por endereço de conteúdo. Falta a materialização com invariante (agregado 64 = 60 + 4), o endereçamento geodésico dos fatos portáveis e a prova com um segundo perfil — o plano de cada um está em `docs/world-protocol.md`.
- **Fora deste ciclo**: empacotamento desktop (Electron/Tauri), multiplayer e Nostr, contas e permissões, relevo real, redes de água, trânsito com rotas, desastres, busca mundial por nome e fachadas específicas.
- O executor Node (`npm run replay`) é uma prova de portabilidade, não um aplicativo desktop.

## Publicar

O jogo é um site estático: não há servidor, nenhuma chamada precisa de proxy (o OpenStreetMap e a Wikidata respondem `access-control-allow-origin: *`) e o `vite.config.ts` usa `base: './'`, então o mesmo build roda na raiz de um domínio ou numa subpasta como `https://usuario.github.io/open-sim/`. Verificado neste repositório servindo o `dist/` a partir de uma subpasta: nenhuma requisição falha, nenhum 404, e o jogo guarda saves e tiles no IndexedDB normalmente.

`npm run build` gera `dist/`; publicar é copiar essa pasta para a branch que o Pages serve (`gh-pages`, `main` + `docs/`, ou publicar pela interface). Como o Pages serve o último commit daquela branch, um build novo aparece assim que ela é atualizada — os nomes de arquivo levam hash, então ninguém fica preso ao JavaScript antigo. Save e cache vivem no IndexedDB, que é por **origem** (esquema + host + porta): trocar de subpasta mantém o save, trocar de domínio ou de `localhost` para `github.io` começa do zero.

`docs/implementation.md` descreve os contratos, os limites entre módulos e como trocar a fonte de mapa, o armazenamento e o renderizador. `docs/architecture.md` é a carta de arquitetura de longo prazo (mundos interoperáveis, autoridade e transporte). A fronteira pública está em `docs/protocol/world-v2.md` e a API dos adaptadores, com a matriz de capacidades comprovadas (implementado, exercitado contra serviço real, contrato e futuro), em `docs/protocol/adapters.md`.

## Próxima etapa: mundos versionados e colaboração

A [especificação de mundos reais e colaboração federada](docs/superpowers/specs/2026-09-29-federated-world-design.md) propõe procedência dos dados reais, cenários e ramificações inspiradas em Git, integração de alterações e multiplayer sem servidor dedicado de simulação. O [plano de implementação](docs/superpowers/plans/2026-09-29-federated-world.md) divide o trabalho em seis entregas e registra, tarefa por tarefa, o commit e a evidência real de cada uma; é o documento que diz o que está pronto, o que é experimental e o que é futuro.
