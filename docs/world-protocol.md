# Open Sim — contrato do mundo portátil

Este documento diz o que do mundo durável é contrato (e portanto prometido a qualquer cliente) e o que ainda é implementação do perfil cidade. Ele é o mapa entre a direção arquitetural da carta (`docs/architecture.md`), os precedentes pesquisados (`docs/research/interoperability-precedents.md`) e o código que existe hoje.

A evolução proposta está na [especificação de mundos versionados e colaboração federada](superpowers/specs/2026-09-29-federated-world-design.md) e no [plano de implementação](superpowers/plans/2026-09-29-federated-world.md). Ela amplia procedência, linhagem e composição, sem declarar o manifesto v2 ou o multiplayer como implementados. A ordem futura passa a incluir colaboração assíncrona antes da sessão em rede; a lista abaixo continua registrando as lacunas do contrato atual.

## O que já é contrato

### Manifesto (`src/core/protocol.ts`)

Um mundo tem identidade e linhagem, não só um `worldId` solto:

```ts
type WorldManifest = {
  protocol: 1;                                  // versão do contrato
  worldId: string;
  rules: {family: string; version: number};     // ex.: {family:'city', version:1}
  base: {source: string; normalizerVersion: number};
  snapshot?: {hash: string; bytes: number};     // endereço de conteúdo de um checkpoint
  parent?: {worldId: string; manifestHash?: string};
  authority: {kind: 'local' | 'host'; actorId?: string};
  extensions: {key: string; version: number; durable: boolean}[];
};
```

`decodeManifest` valida o que conhece (versão de protocolo, mundo, regras, base, autoridade, extensões) e **preserva o que não conhece** — campos escritos por um cliente mais novo sobrevivem a um cliente antigo. `encodeManifest` é JSON canônico, então dois clientes comparam o mesmo texto.

### Estado durável com componentes de namespace (`src/core/model.ts`)

```ts
type Components = Record<string, Record<string, unknown>>;   // namespace -> entidade -> valor
```

O perfil cidade escreve o seu próprio estado (`chunks`, `money`, `tick`, `actors`) e qualquer outro perfil anexa o dele sob um namespace que este cliente não precisa entender: `lifesim.residence`, `vehicle.transform`, `population.aggregate`. Regras do namespace (`OpenSim Protocol 0.1` §8): `perfil.nome`, primeira letra de cada segmento minúscula e o resto
livre (`x.wagner.experimentalTrafficModel` é legal), sem palavra reservada em nenhum segmento; identificadores de entidade `[-\w]{1,80}`; payload apenas JSON simples (sem `undefined`, `NaN`, função, instância de classe, e com limites de profundidade e tamanho).

Um componente é escrito pelo comando normal, com o mesmo envelope, sequência, revisão e deduplicação:

```ts
{type: 'component', key: 'lifesim.residence', entity: 'household-1', value: {...}}   // value: null remove
```

Ele não cobra dinheiro, não toca na economia do perfil cidade e é atômico como os outros comandos.

### Preservação do que não se entende (`src/core/snapshot.ts`)

`decodeSave` **ignora e preserva**: campos desconhecidos no save, no estado, no trecho, na base, na célula, na visão e nos componentes voltam idênticos no próximo `encodeSave`, clonados (nada de alias com a entrada). Isso é o que a carta pede em "Extensibility by namespaced components" e é pré-requisito do experimento das duas simulações: um cliente que não implementa casas não pode apagar as casas do outro.

Campo com chave reservada (`__proto__`, `constructor`, `prototype`) é **recusado**, não descartado em silêncio.

### Identidade durável e endereço de conteúdo — dois usos, dois textos

**Identidade semântica** (`durableJson(state, extensions)`, `identityVersion: 2`): a projeção do estado persistente que dois clientes precisam concordar. Ficam de fora `revision` e `actors` (existem para ordenar comandos e reconhecer reenvio, não para descrever o mundo) e os namespaces declarados efêmeros (`durable: false`). Assim cem mensagens de posição de veículo não mudam a identidade do mundo, mas uma rua construída, um saldo alterado ou um fato de outro perfil mudam.

**Endereço de conteúdo** (`contentRef(texto)` em `src/adapters/hash/content.ts`): `sha256` dos bytes exatos de um arquivo — snapshot completo, com contadores, usado em `manifest.snapshot.hash` para localizar e conferir o arquivo. Restaurar um save continua dependendo desses contadores: sem eles não há deduplicação de comando nem revisão.

Consequências registradas: identidades gravadas antes desta regra (`identityVersion: 1` era o estado inteiro) não são comparáveis com as novas — recalcule; e um hash de arquivo antigo continua válido para os bytes que ele endereçava, porque nenhum byte de save mudou.

O núcleo não conhece hash: ele produz o texto canônico, o adaptador endereça.

## Pacote portátil v2 (tarefa 1 do plano federado)

O que existe hoje em código, além do formato v1 acima:

| Peça | Onde | O que garante |
| --- | --- | --- |
| Modelo puro | `src/world/model.ts` | `ObjectRef`, `WorldAddress`, `Head`, `WorldResult`, `WorldBundle`, limites (32 MiB por objeto, 64 MiB por pacote, profundidade 32) |
| Codec verificável | `src/world/codec.ts` | envelope `worldProtocol: 2` + `wireVersion: 1`, parser JSON estrito (recusa chave repetida, `NaN`/`Infinity`, substituto solto, lixo no fim), UTF-8 estrito (recusa forma longa, truncamento, substituto) e verificação de endereço por `verifyBundle` |
| Codec canônico | `src/adapters/codec/jcs.ts` | RFC 8785 (JCS): bytes UTF-8, sem espaço, sem newline final, chaves ordenadas por unidade UTF-16, números na forma mais curta do ECMAScript |
| Portas | `src/world/ports.ts` | `WorldCodec` e `ContentHasher`: o mundo descreve os bytes canônicos e o adaptador os produz |
| Importação local | `src/session/world-bundle.ts` | `importLegacy(save, hasher, codec, terms?)` cria origem explícita (`legacy-save`), sem inventar histórico; a câmera **não** entra no pacote |

Regras de schema decididas aqui: os objetos críticos (envelope, definição, cabeça, referências, completude, termos) são **fechados** — campo que este contrato não define é recusado, e acrescentar um é assunto de `wireVersion` novo, não de um cliente antigo ignorar em silêncio. O que um perfil quer guardar sem mudar o contrato vai para o valor do objeto e para `extensions`, que este cliente preserva intacto.

Desvio registrado do plano: a assinatura `importLegacy(save)` não podia funcionar sem as duas portas que a própria tarefa define (um `ObjectRef` exige hash), então a função recebe `hasher` e `codec` além do save. `decodeBundle` também aceita limites injetáveis, para os testes exercitarem as recusas sem alocar dezenas de megabytes.

Verificação: `npx vitest run tests/world-bundle.test.ts` (7 testes, incluindo os vetores publicados da RFC 8785), `npx tsc -p tsconfig.world.json` e o teste de arquitetura, que agora exige `world → core/world` e nenhum DOM/Node nesse módulo.

## Fronteira com o OpenSim Protocol 0.1

Decidido em 2026-09-29: o protocolo geral (`docs/OpenSim-Protocol-0.1.txt`, `osim/0.1`) passa a ser a fronteira de
interoperabilidade. O manifesto e os componentes deste documento continuam sendo o estado durável **local**; o que sai
para outro ecossistema sai no envelope do protocolo, com identificadores URI e as quatro operações de estado
(`set`/`merge`/`remove`/`delete`). O contrato vive em `src/world/osim.ts`, compilado sem DOM e sem Node, e
`tests/osim-boundary.test.ts` verifica inclusive o checklist de conformidade do §47 do protocolo.

Duas políticas convivem, e a diferença é o ponto: **registro de protocolo é fechado** (envelope, cabeça, referências,
completude recusam campo que não conhecem, e acrescentar um exige versão nova), **componente é aberto** (campo e
namespace desconhecidos atravessam intactos, como já acontece no save e no manifesto).

O que ainda depende desta decisão está nas tarefas 8–17 do [plano](superpowers/plans/2026-09-29-federated-world.md#reconciliação-com-o-opensim-protocol-01).

## O que ainda falta, em ordem

| # | Item da carta | Estado |
| --- | --- | --- |
| 1 | Componentes com namespace, preservação do desconhecido, manifesto, identidade durável | **feito** |
| 2 | Entidades duráveis com identificador estável (Layer C) | **parcial**: hoje a entidade durável do perfil cidade é a célula; não existe entidade genérica (prédio, casa, veículo) com componentes próprios |
| 3 | Materialização com invariante (seção 4) | **pendente** |
| 4 | Prova com um segundo perfil (seção 11 e "Recommended experiments") | **pendente** |
| 5 | Endereçamento geodésico nos fatos portáveis (Layer A / seção 7) | **parcial**: `toGeo` existe, mas os comandos ainda falam em células da grade do motor |
| 6 | Autoridade com escopo (Layer E) e classes de transporte (Layer F) | **adiado por decisão**: nenhuma conexão nesta etapa |
| 7 | Mundos derivados por fork (Layer B / seção 8) | **parcial**: o manifesto carrega `parent` e `snapshot`; o mecanismo de guardar só o divergente não existe |

### 2. Entidades genéricas

O que falta para o contrato não ser a grade do motor: uma entidade com identificador estável (`entityId`), tipo declarado por namespace e componentes. Proposta mínima, sem quebrar nada do que existe:

- um namespace reservado `entity.index` no perfil que cria a entidade, mapeando `entityId → {kind, key components}`;
- endereço geográfico obrigatório nas entidades portáveis, em `geo.position` (`lon`, `lat`, `altitude?`), derivável da grade via `toGeo`;
- a célula continua sendo o endereço do motor (`toCell`), não do contrato.

### 3. Materialização (o invariante)

Receita da carta: agregado 64 → quatro moradores materializados → restante agregado 60 → total 64. Concretamente, no perfil cidade:

- componente `population.materialized` com uma entrada por unidade materializada: `{cell, count, owner}`;
- `summarize()` **subtrai** de cada construção o que já estiver materializado, então a cidade passa a contar 60 enquanto o outro perfil tem 4 pessoas;
- identificadores determinísticos derivados de `(worldId, cell, índice, seed)`, para dois clientes não criarem pessoas diferentes para o mesmo lugar;
- desmaterializar devolve o efeito por uma operação definida, não por remoção;
- testes: `64 = 60 + 4`; dois clientes derivam os mesmos ids; remover o componente não muda o resto do estado.

### 4. Prova com um segundo perfil

O experimento recomendado pela pesquisa, reduzido a um cliente pequeno:

1. o perfil cidade cria ou modifica uma construção e exporta o mundo (manifesto + snapshot endereçado);
2. um "explorador" (residente ou veículo) abre o mesmo mundo, sem importar nada de `src/presentation` nem de `src/browser`;
3. ele materializa uma casa/pessoa como componente de namespace próprio e salva;
4. o perfil cidade recarrega, ignora o que não entende, mas reflete o agregado compatível.

O teste que prova a última linha é de dependência: o explorador usa apenas `src/core` e os adaptadores que ele mesmo escolher, e o `tests/architecture.test.ts` recusa o contrário.

### 5. Endereçamento geodésico

Camadas de interoperabilidade não podem exigir Web Mercator: fatos portáveis usam longitude/latitude (e altitude opcional) com nome explícito nos campos; a grade `2^22 × 32` continua sendo *endereço do motor*, derivado. Nada de migração de save: componentes novos já podem nascer com `geo.position`, e os comandos do perfil cidade continuam falando em células porque isso é regra dele, não do contrato.

### 6. Autoridade e transporte

Decisões registradas, nada implementado: a autoridade é um papel (cliente local, anfitrião eleito, serviço comunitário) e é **escopada** (por namespace, entidade, região ou sessão), nunca concedida por assinatura; metadados duráveis e de baixa frequência vão bem em Nostr (manifestos assinados, convites, descoberta, ponteiros para blobs endereçados); tráfego de tempo real pede WebRTC/libp2p; nada disso pode ser requisito para o núcleo, e o teste de arquitetura já proíbe `nostr`, `electron` e afins dentro de `src`.

### 7. Mundos derivados

O manifesto já tem `parent` e `snapshot`; falta o armazenamento por divergência (o filho guarda só o que difere do pai) e a decisão de descoberta (`real-world base → mundo de alguém → fork`). Sem merge global: um mundo estrangeiro decide o que aceita.

## Como verificar hoje

```sh
npx vitest run tests/protocol.test.ts   # manifesto, namespaces, identidade durável, hash
npx vitest run tests/snapshot.test.ts   # preservação do desconhecido, recusa de campo reservado
npx vitest run tests/commands.test.ts   # comando de componente: atômico, deduplicado, sem dinheiro
npx vitest run tests/architecture.test.ts  # limites de importação, nenhum acesso a plataforma no núcleo
```
