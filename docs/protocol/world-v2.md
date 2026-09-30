# OpenSim 0.1 — pacote de conformidade deste cliente

Este documento é a fronteira pública do cliente de referência: o que ele publica em nome do **OpenSim Protocol 0.1**
(`docs/OpenSim-Protocol-0.1.txt`, `osim/0.1`), como um terceiro confere que os mesmos bytes dão o mesmo resultado, e o
que ainda **não** está implementado. O pseudocódigo de referência do kernel é `docs/kernel.md`; as implementações puras
são `src/world/osim.ts` (envelope, identificadores, operações de estado, vocabulário central, tempo) e
`src/world/kernel.ts` (os seis objetos e as cinco operações de §39).

O pacote **v2** (`{worldProtocol: 2, wireVersion: 1, kind: 'bundle'}`) continua sendo o formato de arquivo entre
clientes deste projeto. Ele não é a interface de interoperabilidade: tudo o que sai para outro ecossistema sai no
envelope do protocolo.

## 1. Duas políticas, e por que elas não se contradizem

| Camada | Política | Onde é verificada |
| --- | --- | --- |
| Registro de protocolo (envelope §48, cabeça, referências, completude, definição de mundo) | **fechado**: um campo que este contrato não declara é uma versão mais nova, e um cliente antigo recusa em vez de descartar em silêncio | `tests/osim-boundary.test.ts`, `tests/world-replay.test.ts` (`checkBundle`), `tests/world-conformance.test.ts` |
| Componente (`osim.*`, namespace de perfil, valor dentro de um componente) | **aberto**: um cliente que não implementa um namespace precisa poder carregá-lo intacto (§2.3) | `tests/osim-boundary.test.ts`, `tests/world-conformance.test.ts` (caso `profiles`) |

Consequência prática para quem lê `docs/world-protocol.md`: a frase "campo desconhecido é recusado" vale **só** para o
registro. Um componente — e qualquer campo dentro dele — atravessa este cliente sem ser interpretado.

## 2. Os objetos que este cliente publica

`schemas/world-v2/*.schema.json` (JSON Schema 2020-12) descrevem exatamente esses objetos, e
`tests/world-conformance.test.ts` valida contra eles o que o cliente realmente emite — schema que divirja do código
quebra a suíte.

| Arquivo | Objeto | Fechado? |
| --- | --- | --- |
| `envelope.schema.json` | envelope comum (§48) | fechado |
| `entity.schema.json` | declaração de entidade (§6) | corpo aberto |
| `event.schema.json` | evento (§14, quatro operações de §15) | corpo aberto |
| `session.schema.json` | descritor de sessão (§23) | corpo aberto |
| `capability.schema.json` | declaração de capacidade (§27) | fechado |
| `snapshot.schema.json` | `city-state`, `world-tree`, `world-commit`, `base-chunk` (`oneOf`, cada um fechado) | fechado |
| `world-link.schema.json` | link entre mundos (documento deste cliente) | fechado |
| `world-card.schema.json` | cartão público (documento deste cliente) | fechado |
| `world-address.schema.json`, `dataset-term.schema.json` | fragmentos reutilizados | fechado |

Link e cartão **não** são kinds novos do protocolo: §3 define sete e nenhum deles é "link". São documentos deste
cliente em volta de um URI de vista (§40) e de declarações de capacidade (§27).

## 3. O pacote de conformidade

`tests/fixtures/federated-world/conformance.json` — **licença CC0-1.0**, dados sintéticos (provedor `synthetic-test`,
nunca OSM), nenhuma rede. Cada caso é um par `{bundle, operations, expected}`:

| Caso | O que ele prova |
| --- | --- |
| `merge` | um merge de três vias (linha principal com uma rua, ramificação com um parque) é uma **composição**: a operação aceita carrega o estado que produziu, e o replay chega ao mesmo endereço |
| `sources` | as regiões congeladas são endereçadas por conteúdo e os termos (fonte, atribuição, licença) atravessam o replay sem serem reescritos; o valor do componente nomeia o dataset e o instante que declarou |
| `profiles` | três perfis sobre as mesmas entidades: cidade, explorador e um namespace (`transit.schedule`) que este cliente **não** entende e preserva intacto |

Limitações declaradas na própria fixture: as bases vêm de um provedor sintético; o digest de uma composição é o
endereço do estado que ela produziu; e a versão composta é registrada pelo caminho de commit comum (`accepted` é a marca
da composição, o autor é o ator), porque um replay de conformidade reconstrói a versão a partir da operação e não
reexecuta a política de `commitPrepared`.

### 3.1 Receita que um terceiro pode repetir

1. Um pacote completo traz, como objetos endereçados, o commit da cabeça, a árvore, o estado (`city-state`), os anexos e
   os ancestrais.
2. Cada objeto é lido por endereço e **re-encodado** com o codec canônico (JCS/RFC 8785, UTF-8, sem newline) e
   re-hasheado (SHA-256, hex minúsculo): o endereço é a afirmação, e re-hashear é a única forma de testá-la.
3. Cada operação aceita é uma **marca** `p.<epoch>.<id>@<digest>`:
   - comando → `digest` = SHA-256 dos bytes JCS de `{"kind":"accepted-command","command"}`;
   - composição → `digest` = endereço do objeto de estado que ela produziu (`{"kind":"city-state","state"}`).
   A marca tem de carregar o próprio digest, e o digest é recomputado a partir das operações — o livro-razão não é
   acreditado por estar escrito.
4. Um comando é reaplicado pelas regras (`applyCommand`); uma composição é aceita como afirmação do emissor, e é
   conferida no que uma afirmação pode ser conferida: pertence a este mundo, segue as mesmas regras e **avança** a
   revisão.
5. Cada operação aceita produz uma versão, com o mesmo formato que o repositório usa: árvore
   (`world-tree` com `attached`, sem o estado novo), commit (`parents` = versão anterior, `datasets` herdados,
   `accepted` = a marca, `author` = o ator) e `generation` + 1.
6. O resultado é comparado pelo **endereço** (`stateRef`, `head.commit`) e pela **identidade semântica**
   (`durableJson(state)` de `src/core/protocol.ts`, hasheado em UTF-8). O identificador semântico é a projeção que dois
   clientes precisam ter igual; os bytes canônicos são o que dá o endereço do conteúdo.

Recusas, com código estável: `WORLD_PROTOCOL_UNSUPPORTED` (outro `worldProtocol` ou outra família de regras),
`WIRE_VERSION_UNSUPPORTED`, `MALFORMED` (registro com campo não declarado, marca que não carrega o próprio digest,
operação de tipo desconhecido), `HASH_MISMATCH` (bytes que não correspondem ao endereço, digest que não corresponde às
operações), `MISSING_OBJECT` (pacote incompleto ou objeto ausente), `CONFLICT` (comando de outro mundo, comando que não
se aplica, composição que rewind a revisão) e `LIMIT` (mais de 256 operações — o chamador decide o que fazer, e nada é
aplicado parcialmente).

Reenvio: uma marca repetida entra em `duplicates` e **não** é aplicada duas vezes; a versão final é a mesma.

### 3.2 Como executar

```sh
npx tsx tools/world-replay.ts                       # pacote padrão; imprime o relatório e o checklist §47
npx vitest run tests/world-conformance.test.ts tests/world-links.test.ts
npm run dev   # e abra http://127.0.0.1:5173/tests/browser/world-replay.html
```

O executor Node e a página do navegador leem **a mesma** fixture, rodam o **mesmo** replay e imprimem o texto canônico
inteiro. Valores registrados em 2026-09-29 (Node 26.8.1 e Chromium do harness; idênticos nos dois):

| Caso | geração | endereço do estado (`stateRef`) | hash semântico |
| --- | --- | --- | --- |
| `merge` | 3 | `bcc163bad7f09b1d…` (19 969 bytes) | `1058955c3619bfea…` |
| `sources` | 3 | `3572fd1da79720d0…` (20 042 bytes) | `61cffd916553c2c1…` |
| `profiles` | 4 | `c5274632519f5d7d…` (20 214 bytes) | `0ae8f7fe1d98953f…` |

O `expected` de cada caso guarda os valores completos e também a **cabeça** que o repositório de referência produziu, de
modo que o replay não é comparado com uma recontagem própria: ele é comparado com o resultado do repositório.

### 3.3 Checklist do §47

`tools/world-replay.ts` executa os sete itens e imprime o resultado; `tests/world-conformance.test.ts` exige que todos
passem:

1. **envelope** — §48 é lido, e um campo que ele não declara é recusado;
2. **identificadores** — `osim:entity:` é nosso, `did:key:…` continua de outro ecossistema (§4);
3. **componentes desconhecidos** — um namespace que este cliente não implementa atravessa a publicação e volta igual;
4. **operações de estado** — `set`, `merge`, `remove`, `delete` e nada além (§15);
5. **tempo** — linha do tempo e instante entram no evento, um período continua período, e `observedTime` não se
   confunde com `validTime` (§13);
6. **resolução** — `resolve` devolve o objeto pelo URI; um URI que ninguém tem é `null`, não erro;
7. **transporte** — `publish` muda o estado local antes da rede (§2.1) e um segundo cliente recebe o objeto pelo
   adaptador (§30).

## 4. Links entre mundos

`src/world/world-links.ts`, schema em `world-link.schema.json`. Campos: `kind`, `version`, `id`, `world`
(`worldId`/`branchId`), `target`, `arrival`, `capabilities`, `actor`, `sources` e opcionalmente `bridge`, `publishedAt`,
`title`.

- **Fixo versus móvel.** `target: {kind:'commit', commit}` abre exatamente aquela versão e **nunca** pergunta a cabeça de
  uma ramificação; `target: {kind:'branch'}` abre onde a ramificação está. Um documento que declare os dois é recusado:
  são duas promessas diferentes.
- **Lugar de chegada.** `arrival: {kind:'view'|'entity'|'session', uri}`. Uma vista precisa ser um URI de vista (§40);
  `osim://earth?server=example.org` é recusado, porque o URI identifica o que se pediu, não quem responde.
- **Capacidades.** Lista de declarações §27; o vocabulário público é o das quatro operações de estado mais as ações de
  escrita que este cliente escopa em `Grant` (`build`, `demolish`, `tick`, `component`). Um papel (`admin`, `host`) não
  é ação — ele decorre do que a sessão acordou — e uma ação inventada é recusada.
- **Cópias.** `sources` nomeia onde o mundo pode ser encontrado (§31). O resolver é perguntado na ordem declarada e
  depois nas cópias que o cliente conhece; a resposta diz `servedBy`, `unavailable` e `degraded`. **Ausência** de um
  objeto é `NOT_FOUND`; um objeto **diferente** onde ele deveria estar (outra ramificação, cabeça que o commit não
  confirma) é `CONFLICT` e a cópia seguinte é tentada.
- **Ponte.** `forwardWorldLink` publica um link em outro transporte. O `id` original nunca muda (duas pontes não podem
  transformar um mundo em dois) e o registro da ponte é `href = <bridge>#<origem>`: uma ponte que já publicou aquele
  `href` responde `duplicate` em vez de publicar de novo. Além de `maxHops` a cópia é recusada com `LIMIT` — laço não se
  detecta adivinhando quem é laço, se limita (§31).

**Visitar não é permissão.** `resolveWorldLink` devolve um `VisitTarget` com `role: 'visitor'` e `write: false`
literal, sem `grant` e sem `proof`. As capacidades do link são declaração do emissor; escrever continua exigindo uma
concessão verificada por `authorize` contra a versão que o autor viu (§28). Possuir o arquivo nunca foi autorização.

## 5. Cartões públicos

`src/adapters/social/world-card.ts`, schema em `world-card.schema.json`. O cartão carrega só o que declara: título,
URI de vista, link, termos dos dados e as capacidades publicadas. O que **nunca** entra:

- a informação de entrada é um conjunto fechado de campos: qualquer campo a mais — `state`, `objects`, `snapshot`,
  `grant`, `proof`, `privateKey` — é **recusado pelo nome**, não descartado em silêncio;
- antes de devolver, o documento inteiro é varrido atrás do que um arquivo público não pode conter: uma chave secreta
  Nostr (`nsec1…`) ou um PEM de chave privada.

`worldCardText(card)` é o texto para colar (diz explicitamente que a declaração é do emissor e que visitar não concede
permissão). `worldCardDocument(card)` é o documento no formato de uma `Note` do ActivityPub, com o cartão anexado como
documento JSON e **sem destinatário nem audiência**: endereçar uma comunidade é decisão de quem compartilha. Publicar
por um ator ActivityPub nativo é um adaptador/serviço opcional separado — este cliente não exige servidor social.

`readWorldCard(value)` valida um cartão que chegou de outra pessoa pelo **mesmo** caminho fechado: consome `kind` e
`version` (e recusa outra versão com `WIRE_VERSION_UNSUPPORTED`) e entrega o resto à mesma checagem que construiu o
cartão, de modo que um campo a mais ou uma chave escondida no texto livre são recusados com o nome do campo.

## 6. Extensões registradas a partir dos testes

Nada aqui é padronização aceita em outro ecossistema; são as decisões que os testes sustentam hoje.

- **Nostr.** O cartão e o link viajam como um objeto comum (kind 1) quando públicos, com a mesma política de kinds do
  adaptador (`src/adapters/nostr/relay.ts`), e como mensagem privada quando endereçados. O adaptador implementa a porta
  de objeto do §30; a sinalização é manual/assinada (tarefa 8).
- **Matrix.** Um cartão ou link publicado numa sala usa o tipo de evento `org.opensim.*` que o adaptador controla
  (`src/adapters/matrix/rooms.ts`); power level de sala não vira permissão de jogo.
- **Pontes.** O limite de saltos é política deste cliente (`maxHops`), não uma regra do protocolo: dois clientes podem
  escolher limites diferentes e ambos continuam corretos.

## 7. Pendências

- **Revogação de link.** Um link não é uma concessão, então revogá-lo não existe como operação: revogar é retirar a
  cópia ou girar a capacidade. Uma lista de revogação pública por link ainda não foi desenhada.
- **Transferência de recursos escassos entre mundos.** O plano a coloca atrás de uma especificação própria de
  reserva/aceite/consumo; este pacote só navega e visita.
- **Ator ActivityPub.** Compartilhar o documento existe; rodar um ator (inbox, followers, entrega) não.
- **Entrada numa sessão a partir de um link.** O link nomeia um URI de sessão (§23) e o descritor é resolvido por quem
  entra (tarefas 8–9); o link não carrega capacidade nem teste de admissão.
- **`osim:` para link e cartão.** Eles usam URIs próprias (`urn:opensim:…`) de propósito: o espaço de identificadores do
  protocolo é o de §3–4, e um kind que o protocolo não define não deveria ocupá-lo.
