# Mundos reais versionados e multiplayer federado — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Executar uma tarefa de cada vez, preservando a preferência do usuário por economia de contexto.

**Goal:** transformar o protótipo local em um mundo real versionável, compartilhável por propostas e jogável em grupo, sem servidor dedicado de simulação e sem dependência de uma plataforma social.

**Architecture:** contratos puros de mundo e regras ficam separados de repositório, sessão e adaptadores. Primeiro entregar versões e colaboração por arquivos; depois ligar a mesma semântica a WebRTC, Nostr, Matrix e armazenamento substituível. Novas fontes e perfis usam procedência, composição e histórico já existentes.

**Tech Stack:** cliente de referência atual em TypeScript/Vite/Vitest; IndexedDB no browser; portas para I/O, hashes e assinaturas; JCS para novos objetos; WebRTC para sessão ao vivo. SDKs de Nostr/Matrix e bibliotecas de criptografia/codecs entram somente na tarefa que precisar deles, com versão fixada e licença conferida.

**Spec:** [Mundos reais, versões e colaboração federada](../specs/2026-09-29-federated-world-design.md). Ler junto com [implementação atual](../../implementation.md) e [contrato portátil](../../world-protocol.md). Base do planejamento: `8c7f793`. Este documento não registra etapas como executadas.

## Global Constraints

- Uma partida local continua abrindo e funcionando sem conta, relay ou rede.
- Nenhum servidor dedicado executando a simulação é obrigatório; serviços de conexão, identidade e armazenamento podem existir.
- O contrato não exige navegador, engine, banco, fornecedor de mapas, protocolo social ou armazenamento específico.
- Preservar saves atuais, `durableJson`/`identityVersion: 2`, componentes desconhecidos e bases congeladas. Novo envelope: `worldProtocol: 2`; rede: `wireVersion: 1`; novo codec: `JCS/RFC8785 + UTF-8`, sem newline.
- Não consultar rede, relógio ou aleatoriedade global dentro de regras e transformações determinísticas. Não escrever no OSM. Não usar tiles públicos para download em massa.
- IDs de mundo e branch são distintos; permissão é explícita; assinatura não concede direitos. O `actorId` externo será `p_` + SHA-256 da identidade canônica.
- O primeiro multiplayer é cooperativo, para 2–8 pessoas, uma branch ativa por sessão. Falha de host pausa; nenhuma eleição por timeout.
- Limites iniciais: 64 KiB por mensagem durável/controle; 16 KiB por segmento; 32 MiB por objeto; 64 MiB de transferência concorrente; 128 propostas na fila; 20 propostas/s e 10 presenças/s por participante; checkpoint de 128 MiB e 256 trechos administrados por sessão. Negociar para baixo; não perder progresso ao atingir limites.
- Sem merge automático de dinheiro/ticks entre forks; integração de projeto recalcula efeitos no destino. Alteração de fonte não sobrescreve obra sem revisão.
- Implementar UI com nomes simples e configurações técnicas avançadas. Novos SDKs e funções de plataforma ficam restritos a adaptadores.

## Review Focus

1. **Legado sem procedência/IDs detalhados:** preservar bytes e campos desconhecidos, registrar incerteza e não inventar IDs OSM — tarefas 1–2.
2. **Mudança em borda/antimeridiano e dados externos contraditórios:** não duplicar objeto, apagar obra ou aceitar integração economicamente inválida — tarefas 4–5 e 16.
3. **Confirmação perdida, disco cheio e suspensão do host:** não cobrar duas vezes, não declarar salvamento falso e não criar duas autoridades — tarefas 7–9 e 13.
4. **Conteúdo hostil ou grande após decifrar/descompactar:** validar antes de alocação/execução; preservar a versão boa — tarefas 1, 6, 8, 12 e 15.
5. **Plataforma não suporta o recurso ou desaparece:** continuar local, exportar e usar outro adaptador; desconhecido crítico impede escrita — tarefas 6, 10–12 e 17.

## Entregas e ordem

| Entrega | Tarefas | Resultado utilizável sem esperar as demais |
| --- | --- | --- |
| A — Arquivo e histórico | 1–3 | Exportar mundo, abrir offline, criar versões e voltar a um ponto |
| B — Colaboração assíncrona | 4–5 | Amigos trocam projetos por arquivo e revisam atualizações reais |
| C — Multiplayer inicial | 6–10 | Grupo constrói na mesma branch; convite Nostr opcional; host é um jogador |
| D — Federação e recuperação | 11–13 | Comunidades Matrix, cópias externas privadas e transferência de host |
| E — Realidade e dimensões | 14–16 | Compor cenários, outra fonte de dados e segundo perfil sobre entidades comuns |
| F — Ecossistema | 17 | Pacote público de interoperabilidade, cartões sociais e links entre mundos |

Dependências principais: `1 → 2 → 3 → 4 → 5`; `3+4 → 6 → 7 → 8 → 9 → 10`; `10 → 11`, `3+6 → 12`, `7+9+12 → 13`; `5 → 14 → 15`; `4+14 → 16`; `11+15+16 → 17`. A ordem numérica é uma sequência econômica de execução; não exige fazer todas as entregas de uma vez.

Cada tarefa é uma unidade revisável com seu ciclo de teste. Ao retomar, conferir HEAD e reaproveitar o que tiver sido implementado; não repetir scaffolding ou pesquisa inteira. Atualizar este plano com commit e evidência real ao concluir uma tarefa.

## Organização de arquivos e contratos

Novos caminhos abaixo são propostas; os caminhos existentes citados foram conferidos no repositório.

| Área | Arquivos principais | Responsabilidade |
| --- | --- | --- |
| Mundo puro | `src/world/model.ts`, `codec.ts`, `changes.ts`, `merge.ts`, `composition.ts`, `entities.ts` | Schemas, decisões e transformações sem I/O |
| Fontes | `src/world/reality.ts`; `src/adapters/reality/*` | Revisões, procedência, normalização e acesso a fornecedores |
| Persistência | `src/session/world-ports.ts`, `world-repository.ts`; `src/adapters/storage/world-memory.ts`, `world-indexed-db.ts` | Objetos, referências, transações, recibos e retenção |
| Colaboração | `src/session/multiplayer-ports.ts`, `host-session.ts`, `replica-session.ts`, `recovery.ts` | Ordenação, validação, estado da conexão e recuperação |
| Infraestrutura | `src/adapters/crypto/*`, `network/*`, `nostr/*`, `matrix/*`, `blobs/*` | APIs/SDKs e transporte substituíveis |
| Experiência | `src/presentation/world-history.ts`, `world-diff.ts`, `multiplayer.ts`; montagem em `src/browser/main.ts` | Fluxos visuais e configuração |
| Conformidade | `tests/fixtures/federated-world/*`, `tests/browser/world-replay.*`, `tools/world-replay.ts` | Mesmos cenários em runtimes e adaptadores diferentes |

Grafo permitido: `core → core`; `world → core/world`; `session → core/world/session`; adaptadores dependem de contratos puros/sessão; apresentação depende dos contratos de sessão e modelos, nunca dos SDKs. Browser faz a composição. Compilar também `world` sem DOM/Node, com `tsconfig.world.json`. Núcleo continua sem bibliotecas externas; se JCS precisar de biblioteca, colocá-la no adaptador de codec e injetar pela porta, mantendo os modelos puros.

Tipos compartilhados nas tarefas:

- `ObjectRef = {hash: string; bytes: number}`; hash em hex minúsculo, SHA-256. IDs de conteúdo não são CIDs IPFS.
- `WorldAddress = {worldId: string; branchId: string}`; `Head = WorldAddress & {commit: ObjectRef; generation: number}`.
- `WorldResult<T> = {ok: true; value: T} | {ok: false; error: {code: string; message: string}}`; códigos estáveis para incompatibilidade, ausência, conflito, quota, assinatura e permissão.
- `WorldBundle` contém envelope v2, head, objetos, termos e estado de completude. `Checkpoint` inclui `GameState`, bases, head anterior/referências necessárias, versões e metadados restauráveis da sessão. Construir sem referência circular: hash do checkpoint não contém o hash do commit que o referencia.
- `WorldCommitBody` contém `parents`, `tree`, `rules`, `datasets`, `acceptedOperations`, `author`; aceitação de sessão acrescenta contexto de branch, época e sequência em prova destacada. Criar schemas fechados para campos críticos e um espaço explícito de extensões preservadas.
- `PreparedChange` contém origem, head do destino, intenções, precondições, dependências, custo e hash da prévia. `MergePreview` contém resultado candidato, conflitos tipados e ações selecionadas. Tipos detalhados entram na tarefa responsável, conforme a especificação; nenhum SDK define esses formatos.

## A — Arquivo e histórico

### Tarefa 1: pacote portátil e codec verificável

**Arquivos:** criar `src/world/model.ts`, `src/world/codec.ts`, `src/session/world-ports.ts`, `src/adapters/codec/jcs.ts`, `src/session/world-bundle.ts`, `tsconfig.world.json`, `tests/world-bundle.test.ts`, `tests/fixtures/federated-world/legacy.json`; ajustar `tests/architecture.test.ts`.

**Interfaces:** `importLegacy(save: SavedGame): WorldResult<WorldBundle>`; `decodeBundle(bytes: Uint8Array): WorldResult<WorldBundle>`; `encodeBundle(bundle: WorldBundle, codec: WorldCodec): Uint8Array`. `WorldCodec.encode(value: JsonValue): Uint8Array`; `ContentHasher.ref(bytes: Uint8Array): Promise<ObjectRef>`. O adaptador de hash atual continua aceitando texto antigo; acrescentar caminho de bytes sem alterar sua saída anterior.

- [x] Escrever testes: `expect(imported.state).toEqual(legacy.state)` incluindo extras; `expect(reencodedUnknown).toEqual(originalUnknown)`; recusar chave JSON duplicada, versão crítica desconhecida, profundidade excessiva e objeto maior que 32 MiB; vetores JCS com ordenação Unicode/números e ausência de newline.
- [x] Rodar `npx vitest run tests/world-bundle.test.ts`; confirmar falha pela API ausente, não por fixture inválida.
- [x] Implementar envelope, limites e codec. Migração cria origem explícita a partir do save; não fabrica histórico anterior. Pacote parcial lista referências ausentes. Preservar separação entre hash de arquivo e identidade semântica.
- [x] Rodar os novos testes mais `tests/protocol.test.ts`, `tests/snapshot.test.ts`, `tests/architecture.test.ts` e `npx tsc -p tsconfig.world.json`; exigir PASS.
- [x] Commit: `feat: add portable world bundles and versioned wire codec`.

### Tarefa 2: procedência e capturas reais reproduzíveis

**Arquivos:** criar `src/world/reality.ts`, `src/adapters/reality/osm-capture.ts`, `tests/reality.test.ts`, fixtures `base-a.json`/`base-b.json`; ajustar `src/adapters/osm/provider.ts` somente para expor metadados já disponíveis, sem aumentar o volume de requisições.

**Interfaces:** `DatasetRevision`, `SourceClaim`, `Coverage`, `CaptureContext` conforme §3 da spec; `captureBase(base: BaseChunk, context: CaptureContext, hash: ContentHasher): Promise<CapturedBase>`, onde `CapturedBase = {base: BaseChunk; revision: DatasetRevision; claims: SourceClaim[]; objects: WorldObject[]}`. `RealitySource.capture(region: GeoRegion, request: CaptureRequest): Promise<WorldResult<CapturedBase[]>>`; contexto recebe horário e versão de transformação pelo chamador.

- [x] Testar `expect(captured.base).toEqual(input)`; `observedAt` ausente quando só há data de download; ausência de ID de origem não ganha um ID OSM; fonte/atribuição/extras sobrevivem ao pacote; falha de fonte não vira terreno.
- [x] Rodar `npx vitest run tests/reality.test.ts` e confirmar RED.
- [x] Implementar captura por trecho normalizado, marcada como tal; guardar hash e parâmetros. Não prometer que tiles obtidos em momentos diferentes formem um snapshot global do OSM. Fixtures sintéticas representam estacionamento→edifício e mudança de fonte sem licença de redistribuição declarada.
- [x] Rodar `npx vitest run tests/reality.test.ts tests/map-provider.test.ts tests/normalize.test.ts`; exigir PASS e atribuição intacta.
- [x] Commit: `feat: preserve source revisions and geographic provenance`.

### Tarefa 3: repositório local, branches e cópias completas

**Arquivos:** criar `src/session/world-repository.ts`, `src/adapters/storage/world-memory.ts`, `src/adapters/storage/world-indexed-db.ts`, `src/presentation/world-history.ts`, `tests/world-repository.test.ts`; ajustar `src/session/world-ports.ts`, `src/browser/main.ts`.

**Interfaces:** `WorldRepository.create(bundle): Promise<WorldResult<Head>>`; `fork(head: Head, target: WorldAddress): Promise<WorldResult<Head>>`; `commit(expected: Head, change: AcceptedChange): Promise<WorldResult<Head>>`; `checkout(head: Head): Promise<WorldResult<Checkpoint>>`; `export(head: Head): Promise<WorldResult<WorldBundle>>`. `AcceptedChange` contém transição validada, operações, novos objetos e metadados/recibos; tipos de tarefa 1. Porta de storage oferece transação atômica de objetos + recibos + comparação/avanço de referência.

- [x] Testar `expect(childBaseHash).toBe(parentBaseHash)`, pai inalterado após obra do filho, compare-and-swap de head antigo recusado, falha no meio da transação não avança head, exportação abre sem `MapSource`, câmera não aparece no checkpoint.
- [x] Rodar `npx vitest run tests/world-repository.test.ts`; confirmar RED.
- [x] Implementar objetos imutáveis, primeiro pai e referências estáveis; guardar snapshot inteiro inicialmente se dentro dos limites, sem copiar bytes iguais no armazenamento. Fork de outro mundo recontextualiza `worldId`, registra origem e não copia concessões/sessão ativa; acrescentar teste dessa separação. Novo slot por mundo/branch; nunca sobrescrever `sameworld` ao abrir convite. Entregar UI Criar versão/Exportar/Importar/Histórico.
- [x] Rodar os testes novos e `tests/session.test.ts`; abrir uma cópia exportada offline e registrar o hash restaurado. Exigir head idêntico e ausência de pedido ao OSM.
- [x] Commit: `feat: add local world history and branches`.

## B — Colaboração assíncrona

### Tarefa 4: intenções, diferenças e propostas por arquivo

**Arquivos:** criar `src/world/changes.ts`, `src/world/city-profile.ts`, `src/presentation/world-diff.ts`, `tests/world-changes.test.ts`; ajustar `src/session/local-session.ts` e montagem de histórico no browser.

**Interfaces:** `describeChange(before: GameState, command: Command, after: GameState): ChangeSet`; `diffWorlds(base: Checkpoint, other: Checkpoint): WorldDiff`; `prepareProject(target: Checkpoint, changes: ChangeSet, selection: string[]): WorldResult<PreparedChange>`. `ChangeSet` define por operação ID, intenção, campos lidos/escritos, precondições, referências de base e dependências; `WorldDiff` separa dado real, jogador, simulação e metadados.

- [x] Testar mudanças de campos independentes versus mesma célula, rua atravessando borda e antimeridiano, preservação de namespace desconhecido; `expect(importedProject.money).toBe(target.money - acceptedCost)` e `expect(importedProject.tick).toBe(target.tick)` após integração simulada pelo perfil.
- [x] Rodar `npx vitest run tests/world-changes.test.ts`; confirmar RED.
- [x] Registrar intenção de novos comandos e tratar edição legada como célula opaca. Prévia de projeto usa `quote`/regras do destino, não o saldo da origem. Exportar/importar proposta com objetos necessários e seleção estável; não autorizar ações só pela autoria declarada do arquivo.
- [x] Rodar os testes novos e `tests/commands.test.ts tests/presentation.test.ts`; comparar duas versões na UI com contagem/custo e região visível.
- [x] Commit: `feat: describe and exchange world change proposals`.

### Tarefa 5: merge conservador e atualização da base real

**Arquivos:** criar `src/world/merge.ts`, `src/core/base-update.ts`, `tests/world-merge.test.ts`, `tests/base-update.test.ts`; ajustar `src/world/city-profile.ts`, `src/presentation/world-diff.ts`, `src/session/world-repository.ts`.

**Interfaces:** `previewMerge(ancestor: Checkpoint, target: Checkpoint, source: Checkpoint, selection: string[]): MergePreview`; `resolveMerge(preview: MergePreview, choices: ConflictChoice[]): WorldResult<PreparedChange>`; `previewBaseUpdate(target: Checkpoint, captured: CapturedBase[]): MergePreview`; `applyBaseUpdate(state: GameState, update: ApprovedBaseUpdate): CommandResult`; `prepareCompensation(target: Checkpoint, commit: WorldCommit): WorldResult<PreparedChange>`. `ApprovedBaseUpdate` contém head/revisão esperados, bases verificadas e resolução por célula; `commitPrepared(expected: Head, prepared: PreparedChange): Promise<WorldResult<Head>>` no repositório.

- [ ] Testar estacionamento→parque do jogador versus estacionamento→prédio real: conflito obrigatório; preservar parque mantém overlay e adota origem B com divergência registrada. Testar gasto conjunto acima do saldo, remoção versus edição, namespace crítico desconhecido, candidato baseado em head antigo e ausência de ancestral.
- [ ] Rodar `npx vitest run tests/world-merge.test.ts tests/base-update.test.ts`; confirmar RED.
- [ ] Implementar merge de três vias por campos conhecidos e dependências do perfil; relações desconhecidas conflitam. Integração de projeto reexecuta ações selecionadas atomicamente. Atualização de base preserva `money`, `tick`, edições e estágios resolvidos; recalcula capacidade/base e indicadores, sem renda retroativa. A prévia mostra a população/capacidade resultante antes do aceite. Desfazer prepara compensação pelas regras atuais; testar usina já utilizada, sem apagar história ou devolver dinheiro indevido.
- [ ] Rodar novos testes e suíte de simulação/comandos. Demonstrar duas propostas por arquivos e uma atualização com fixtures A/B, sem rede pública. Registrar conflitos e hashes antes/depois.
- [ ] Commit: `feat: review semantic merges and real-map updates`.

## C — Multiplayer inicial

### Tarefa 6: identidade, concessões e negociação de capacidades

**Arquivos:** criar `src/world/permissions.ts`, `src/world/wire.ts`, `src/session/multiplayer-ports.ts`, `src/adapters/crypto/session-keys.ts`, `tests/world-permissions.test.ts`, `tests/world-wire.test.ts`; ajustar testes de arquitetura e allowlists de dependências estritamente por adaptador.

**Interfaces:** `Principal = {scheme: string; id: string}`; `IdentityProvider.bindSession(request: SessionBindingRequest): Promise<WorldResult<IdentityProof>>`; `SignatureVerifier.verify(proof: IdentityProof | MessageProof, bytes: Uint8Array): Promise<boolean>`; `authorize(grant: Grant, proposal: Proposal, context: AuthorizationContext): WorldResult<AuthorizedProposal>`; `negotiate(local: Capabilities, remote: Capabilities): WorldResult<SessionAgreement>`. Schemas definem `Proposal`, `Grant`, `SessionAgreement`, provas e limites de §7/9; nenhuma assinatura é um booleano fornecido pelo remetente.

- [x] Testar principal falso, assinatura adulterada, grant expirado/revogado/fora de região, replay noutra branch/época e namespace proibido; `expect(roleForUnknownCritical).toBe('spectator')` quando há formato legível; `expect(actorId.length).toBe(66)`; proposta rejeitada não avança sequência aceita do core.
- [x] Rodar `npx vitest run tests/world-permissions.test.ts tests/world-wire.test.ts`; confirmar RED.
- [x] Implementar assinatura local com algoritmo e biblioteca/API disponíveis nos runtimes alvo, sem criptografia caseira; usar Ed25519 como esquema inicial com vetores conhecidos. Raiz/delegação fica separada da chave curta. Relógio de validade entra por contexto, nunca ordena commits. Recusar regras incompatíveis para escrita.
- [x] Rodar novos testes, vetores negativos de assinatura, `tests/architecture.test.ts` e compilação pura; provar que SDK fora do adaptador continua proibido.
- [x] Commit: `feat: authenticate scoped multiplayer proposals`.

### Tarefa 7: anfitrião e réplica com transporte em memória

**Arquivos:** criar `src/session/host-session.ts`, `src/session/replica-session.ts`, `src/adapters/network/memory.ts`, `tests/multiplayer-session.test.ts`, fixture `session-chaos.json`; estender repositório/ports com recibos transacionais.

**Interfaces:** `createHostSession(options: HostOptions): HostSession`, com `submit(proposal: Proposal): Promise<ProposalReceipt>` e `step(): Promise<WorldResult<Head>>`; `createReplicaSession(options: ReplicaOptions): ReplicaSession`, com `receive(commit: AcceptedCommit): Promise<ReplicaReceipt>`; `SessionTransport.send(peer: string, message: WireMessage): Promise<void>` e `subscribe(listener): () => void`. Options incluem repositório, identidade, verificador, concessões, regras e transporte injetados; sem import de adaptador.

- [ ] Testar duas obras competindo pelo mesmo saldo, commit repetido/invertido, pai ausente, proposta rejeitada seguida por válida, base OSM diferente entre peers e queda após persistir antes de responder; `expect(hostSemanticHash).toBe(replicaSemanticHash)` e cobrança única após reenvio.
- [ ] Rodar `npx vitest run tests/multiplayer-session.test.ts`; confirmar RED.
- [ ] Implementar pipeline da spec §7.4; recibo e head gravam na mesma transação. Persistência falha não emite confirmação durável. Replica verifica operações e resultado; solicita bases antes de adotar. Anfitrião revalida propostas antigas somente com precondições e teto de custo intactos; ticks só via host.
- [ ] Rodar teste de caos determinístico e reabertura a partir de checkpoint/recibos; exigir ausência de aplicação dupla e de divergência não sinalizada. Limitar filas e pedidos de pais ausentes.
- [ ] Commit: `feat: replicate deterministic sessions with durable receipts`.

### Tarefa 8: WebRTC com sinalização manual

**Arquivos:** criar `src/adapters/network/webrtc.ts`, `src/adapters/network/manual-signaling.ts`, `src/adapters/network/object-transfer.ts`, `tests/webrtc-adapter.test.ts`, `tests/object-transfer.test.ts`, `tests/browser/multiplayer.html`, `tests/browser/multiplayer.ts`.

**Interfaces:** `Signaling.send(peer: string, signal: SignedSignal): Promise<void>` e `subscribe(listener): () => void`; `createWebRtcTransport(config: WebRtcConfig): SessionTransport`; config declara sinalização, verificação do vínculo, STUN/TURN e política direta/relay. `transferObject(ref: ObjectRef, peer: string, ports: TransferPorts): Promise<WorldResult<Uint8Array>>`; mensagem recebida nunca excede limites negociados.

- [ ] Testar sinal de outra sessão, oferta antiga, objeto truncado/adulterado, backpressure e desconexão no meio; limites 64 KiB/16 KiB/32 MiB e total concorrente de 64 MiB; bytes inválidos não chegam a `receive`.
- [ ] Rodar `npx vitest run tests/webrtc-adapter.test.ts tests/object-transfer.test.ts`; confirmar RED com portas WebRTC falsas, sem rede pública.
- [ ] Implementar canais separados e retomada por segmentos; suspender envio ao atingir 1 MiB no buffer e retomar abaixo de 256 KiB, reduzindo conforme acordo. Sinalização manual por copiar/colar mensagem autenticada primeiro. TURN usa credenciais temporárias configuradas, nunca segredo permanente no bundle do app.
- [ ] Exigir testes PASS; verificar dois browsers/dispositivos, conexão direta e modo relay num ambiente de teste configurado. Registrar ambientes e falhas; não declarar compatibilidade NAT ampla a partir de duas abas na mesma máquina.
- [ ] Commit: `feat: connect player-hosted sessions over WebRTC`.

### Tarefa 9: integrar a experiência multiplayer ao jogo

**Arquivos:** criar `src/presentation/multiplayer.ts`, `tests/multiplayer-ui.test.ts`; ajustar `src/browser/main.ts`, `src/presentation/clock.ts`, `src/session/ports.ts`, `src/browser/style.css`.

**Interfaces:** `GameSessionView` expõe estado, modo local/host/replica, head, pendências e persistência; `submitAction(action: Action): Promise<ProposalReceipt>` para rede, adaptando `LocalSession.dispatch` sem mudar seu contrato existente. `SessionStatus` distingue persistido local, replicado, pendente, pausado, erro de fonte e erro de armazenamento.

- [ ] Testar que réplica não agenda tick, aba oculta do host indica pausa, rejeição restaura prévia sem perder seleção, convite não sobrescreve save pessoal, fila cheia preserva estado e presença não muda identidade durável.
- [ ] Rodar `npx vitest run tests/multiplayer-ui.test.ts`; confirmar RED.
- [ ] Entregar Criar sessão/Entrar/Convidar/Sair/Continuar em versão pessoal; mostrar nome da branch, participantes e estados de salvamento da spec. Usar câmera local, porta efêmera e revogação de colaboração; não otimizar resultado econômico antes de confirmação.
- [ ] Rodar testes novos e `tests/input.test.ts tests/hud.test.ts tests/presentation.test.ts`. Exercitar orçamento disputado e reconexão por UI; avaliar 2 e 8 clientes no limite de 256 trechos, registrando latência/memória, sem presumir meta já atingida.
- [ ] Commit: `feat: expose cooperative sessions in the city client`.

### Tarefa 10: Nostr para identidade e convites

**Arquivos:** criar `src/adapters/nostr/identity.ts`, `src/adapters/nostr/invites.ts`, `src/adapters/nostr/signaling.ts`, `tests/nostr-adapter.test.ts`; ajustar montagem/configuração no browser e `package.json`/lockfile se houver SDK.

**Interfaces:** adaptador de `IdentityProvider` da tarefa 6; `InviteService.create(input: InviteInput): Promise<WorldResult<Invite>>`, `open(invite: Invite): Promise<WorldResult<JoinRequest>>`; adaptador `Signaling` da tarefa 8. Invite fixa destinatário ou política de aprovação, mundo/branch/head, capacidades, validade e endpoints; possuir link sozinho não concede escrita.

- [ ] Testar ausência/recusa de assinador, identidade do usuário distinta do bunker, relay recusando mensagem, replay de convite e acesso sem grant. `expect(publicPayload).not.toContain(privateKeyOrSnapshot)`; NIP-78 nunca usado como descoberta pública.
- [ ] Rodar `npx vitest run tests/nostr-adapter.test.ts`; confirmar RED usando relay/assinador simulados.
- [ ] Implementar NIP-07 e interface compatível com futura NIP-46; começar com convite legível NIP-17 ou cópia manual. Mensagens automáticas de sinalização usam envelope versionado explícito em canal privado compatível e aprovado para a sessão; não registrar kind novo arbitrariamente. NIP-46 entra somente com seus testes completos de identidade/permissão.
- [ ] Exigir PASS; em ambiente de teste com contas próprias, verificar dois relays, um indisponível e usuário sem Nostr. Compartilhamento real com contatos não é parte de teste automático. Não bloquear o modo manual quando um assinador faltar.
- [ ] Commit: `feat: add optional Nostr identity and private invitations`.

## D — Federação e recuperação

### Tarefa 11: comunidade Matrix usando o mesmo mundo

**Arquivos:** criar `src/adapters/matrix/identity.ts`, `src/adapters/matrix/rooms.ts`, `src/adapters/matrix/signaling.ts`, `tests/matrix-adapter.test.ts`, `tests/federated-adapters.test.ts`; ajustar configuração/SDK em browser e dependências.

**Interfaces:** mesmas portas `IdentityProvider`, `InviteService` e `Signaling`; `RoomBinding` associa conta autenticada, sala, chave de sessão e prova de aprovação do convite. Nenhum campo Matrix entra em `GameState` ou na regra econômica.

- [ ] Testar evento de sala indevida, membro sem grant, chave de sessão trocada, evento criptografado não decifrável e duplicação entre transportes; `expect(matrixResult.semanticHash).toBe(nostrResult.semanticHash)` para o mesmo cenário/ordem de operações.
- [ ] Rodar `npx vitest run tests/matrix-adapter.test.ts tests/federated-adapters.test.ts`; confirmar RED.
- [ ] Implementar sala privada com SDK e criptografia existentes; eventos próprios só sob namespace configurado/controlado. Convite estabelece vínculo verificável; power level não vira permissão de jogo. Permitir convidados de Nostr e Matrix na mesma sessão WebRTC sem ponte de chats.
- [ ] Exigir testes PASS e prova de integração com duas contas em homeservers distintos de teste; desligar a sinalização após conexão e observar a continuidade da partida. Se infraestrutura de teste faltar, registrar essa verificação como pendente, sem afirmar federação validada.
- [ ] Commit: `feat: add Matrix community and signaling adapters`.

### Tarefa 12: cópias privadas, retenção e provedores de objetos

**Arquivos:** criar `src/adapters/blobs/direct.ts`, `http.ts`, `blossom.ts`, `src/adapters/crypto/private-objects.ts`, `src/session/world-retention.ts`, `tests/world-blobs.test.ts`, `tests/world-retention.test.ts`; ajustar repositório para inventário/retomada.

**Interfaces:** `ObjectStore.get(ref: ObjectRef): Promise<WorldResult<Uint8Array>>`, `put(bytes: Uint8Array): Promise<WorldResult<ObjectRef>>`; `sealObject(plain: Uint8Array, key: ObjectKey, crypto: CryptoPort): Promise<SealedObject>`; `openObject(sealed: SealedObject, key: ObjectKey, crypto: CryptoPort): Promise<WorldResult<Uint8Array>>`; `planRetention(roots: RetainedRoot[], inventory: ObjectInventory): RetentionPlan`. CryptoPort usa AEAD de biblioteca/API consolidada, nonce único por chave e contexto autenticado de formato/mundo.

- [ ] Testar bytes cifrados com hash diferente do plaintext, alteração de nonce/contexto/ciphertext, ausência de chave, provedor indisponível e fallback para cópia local; GC não remove base de branch/proposta retida, checkpoint ou objeto referenciado; arquivo de 32 MiB+1 é recusado antes de decifrar em massa.
- [ ] Rodar `npx vitest run tests/world-blobs.test.ts tests/world-retention.test.ts`; confirmar RED.
- [ ] Implementar transferência direta/HTTP e Blossom por portas; chaves fora de referências públicas. Retenção por alcançabilidade, exportação completa e compactação de recibos com marca de reconciliação. IPFS fica como adaptador posterior à prova desses contratos, sem embutir daemon obrigatório.
- [ ] Exigir PASS; restaurar mesmo mundo de duas origens independentes e após remoção de uma delas; simular quota de IndexedDB e objeto faltante. Não apagar histórico alcançável para esconder limite de armazenamento.
- [ ] Commit: `feat: replicate private world objects with explicit retention`.

### Tarefa 13: transferência planejada e recuperação após falha

**Arquivos:** criar `src/session/recovery.ts`, `tests/host-recovery.test.ts`; ajustar `host-session.ts`, `replica-session.ts`, `src/presentation/multiplayer.ts` e fixtures de caos.

**Interfaces:** `prepareHandover(session: HostSession, successor: Principal): Promise<WorldResult<HandoverOffer>>`; `acceptHandover(offer: HandoverOffer, grant: EpochGrant, repository: WorldRepository): Promise<WorldResult<Head>>`; `recoverBranch(candidates: RecoveryCandidate[], decision: RecoveryDecision): WorldResult<RecoveryPlan>`. EpochGrant liga proprietário, sucessor, branch, sessão, época e último head; recuperação nunca escolhe apenas pelo timestamp.

- [ ] Testar queda antes/depois de ACK, concessão de época antiga, duas concessões concorrentes, proprietário ausente, novo host sem todos os objetos e recibo antigo após checkpoint; `expect(activeWritersForBranch).toBe(1)` na transferência válida e `0` na divergência não resolvida.
- [ ] Rodar `npx vitest run tests/host-recovery.test.ts`; confirmar RED.
- [ ] Implementar pausa, barreira, persistência/replicação final e nova época autorizada; recuperação explícita ou fork. Respeitar head confirmado conhecido localmente, preservando evidências quando candidato disponível for anterior. Não prometer restauração de bytes que nenhuma cópia reteve.
- [ ] Exigir PASS no cenário de três participantes; encerrar o host no browser durante obra e durante transferência; conferir hash, saldo, contador e mensagem de pausa/recuperação.
- [ ] Commit: `feat: transfer and recover player-hosted world sessions`.

## E — Realidade e dimensões

### Tarefa 14: composições de camadas e comparação de cenários

**Arquivos:** criar `src/world/composition.ts`, `src/presentation/world-composition.ts`, `tests/world-composition.test.ts`; ajustar `src/world/model.ts`, `src/world/city-profile.ts`, histórico e repositório.

**Interfaces:** `composeWorld(definition: Composition, objects: ResolvedObjects): WorldResult<ComposedWorld>`; `compareScenarios(a: ScenarioRun, b: ScenarioRun): ScenarioComparison`. `Composition` fixa base, commits das camadas, regras, parâmetros e política temporal; cada `LayerContract` declara leituras/escritas, dependências e efeito visual ou durável. `ScenarioRun` inclui estado inicial, intervalo de ticks e entradas externas, além dos indicadores.

- [ ] Testar dependência ausente/cíclica, duas camadas escrevendo o mesmo campo, troca de ordem visual sem mudar resultado, camada visual fora da identidade durável e regras incompatíveis. `expect(comparison.comparable).toBe(false)` se diferem intervalo ou premissas sem declaração.
- [ ] Rodar `npx vitest run tests/world-composition.test.ts`; confirmar RED.
- [ ] Implementar composição explícita e preview; hipóteses duráveis só mudam por commit, ou nova branch quando há migração. Não inserir política genérica “última camada vence”. Mostrar cenários lado a lado com dados reais fixados, decisões e indicadores explicáveis.
- [ ] Exigir PASS; demonstrar mesma base com projeto de parque e projeto industrial, rodando o mesmo intervalo/entradas. Bases devem compartilhar hashes; simulações não compartilhar saldo mutável.
- [ ] Commit: `feat: compose versioned world scenarios`.

### Tarefa 15: segunda família de dados e entradas temporais gravadas

**Arquivos:** criar `src/adapters/reality/gtfs.ts`, `src/world/observations.ts`, `src/adapters/reality/observation-file.ts`, `src/presentation/source-inspector.ts`, `tests/gtfs-source.test.ts`, `tests/external-input.test.ts`, fixtures `transit-small.zip`/`weather-observations.json`; acrescentar só bibliotecas de parsing necessárias.

**Interfaces:** `importTransit(bytes: Uint8Array, context: CaptureContext): WorldResult<TransitDataset>`; `normalizeObservation(input: RawObservation, policy: ObservationPolicy): WorldResult<ExternalInput>`; `applyExternalInput(state: GameState, input: ExternalInput): CommandResult`. `ExternalInput` inclui ID, dataset/revisão, tipo observado/previsão, instante/intervalo representado, unidade, payload e tick de efeito. `TransitDataset` contém procedência, linhas/paradas e calendário/fuso declarados, sem fingir cálculo de rotas completo.

- [ ] Testar transporte sem linha/parada referenciada, duplicação de IDs de fornecedores diferentes, ZIP expandido acima do limite, unidade inválida, horário com fuso e revisão posterior de previsão. `expect(replayWithoutNetwork).toEqual(originalRun)` e chegada fora de ordem não altera ticks passados.
- [ ] Rodar `npx vitest run tests/gtfs-source.test.ts tests/external-input.test.ts`; confirmar RED.
- [ ] Implementar GTFS Schedule por arquivo/região como primeira família nova; preservar licença e associar componentes `transit.*` com geometria. Implementar importação de observações de clima normalizadas e política fixada de ausência. Perfil pode exibir esses dados antes de lhes dar efeito econômico; qualquer efeito exige regra versionada, não inferência do adaptador.
- [ ] Exigir PASS; comparar dois pacotes da mesma fonte e rejeitar associação ambígua. Exercitar ao menos um pacote real pequeno redistribuível com origem/termos documentados; fixtures unitárias permanecem sintéticas. Chuva gravada deve reproduzir sem API. Relevo/GeoTIFF/STAC será adaptador adicional, depois dessa prova, com datum/resolução explícitos.
- [ ] Commit: `feat: import transit data and replay external observations`.

### Tarefa 16: entidades geográficas e segundo perfil

**Arquivos:** criar `src/world/entities.ts`, `src/world/materialization.ts`, `src/profiles/explorer/model.ts`, `src/profiles/explorer/commands.ts`, `tools/explorer.ts`, `tests/world-entities.test.ts`, `tests/materialization.test.ts`, `tests/cross-profile.test.ts`; ajustar agregados do perfil cidade em `src/core/simulation.ts` e o grafo explícito de arquitetura para `profiles`.

**Interfaces:** `reconcileEntities(before: EntityIndex, incoming: SourceEntity[]): EntityReconciliation`; `materialize(state: SharedPopulation, request: MaterializeRequest): WorldResult<SharedPopulation>`; `dematerialize(state: SharedPopulation, entityIds: string[]): WorldResult<SharedPopulation>`; `runExplorer(bundle: WorldBundle, actions: ExplorerAction[]): WorldResult<WorldBundle>`. Perfis podem importar `core/world`, nunca apresentação/browser; normalizador não dá a uma célula de jogo a identidade de um prédio físico sem evidência.

- [ ] Testar entidade cruzando trechos/antimeridiano contada uma vez, feição dividida/fundida com associação ambígua, IDs estáveis em fork e namespaces desconhecidos preservados. `expect(aggregate + materialized).toBe(64)` antes/depois de materializar 4 e desmaterializar; reserva duplicada não cria pessoas adicionais.
- [ ] Rodar `npx vitest run tests/world-entities.test.ts tests/materialization.test.ts tests/cross-profile.test.ts`; confirmar RED.
- [ ] Implementar `entity.index`, `geo.position`/geometrias e relação com fonte; manter ligação legada à célula como aproximação declarada. Definir operação de reserva/devolução e migrar a versão de regras necessária; excluir alterações efêmeras do histórico. Explorador de referência abre, materializa e exporta sem código da UI de cidade.
- [ ] Exigir PASS; cidade → explorador → cidade conserva total, histórico, procedência e dados desconhecidos. Perfil incompatível entra como leitura; conflito entre reservas simultâneas passa pelo mesmo coordenador.
- [ ] Commit: `feat: share geodetic entities across city and explorer profiles`.

## F — Ecossistema

### Tarefa 17: conformidade pública, cartões sociais e navegação entre mundos

**Arquivos:** criar `docs/protocol/world-v2.md`, `docs/protocol/adapters.md`, `schemas/world-v2/*.schema.json`, `src/world/world-links.ts`, `src/adapters/social/world-card.ts`, `tools/world-replay.ts`, `tests/browser/world-replay.html`, `tests/browser/world-replay.ts`, `tests/world-conformance.test.ts`, `tests/world-links.test.ts`; atualizar README e documentação atual com o que tiver sido comprovado.

**Interfaces:** `resolveWorldLink(link: WorldLink, resolver: ObjectResolver): Promise<WorldResult<VisitTarget>>`; `createWorldCard(input: PublicWorldInfo): PublicWorldCard`; `replayWorld(bundle: WorldBundle, operations: AcceptedOperation[]): WorldResult<Checkpoint>`. `WorldLink` distingue commit fixo de branch móvel, lugar de chegada e capacidades; `PublicWorldInfo` nunca aceita chaves/objetos privados por conveniência.

- [ ] Testar visita sem herdar permissão, link móvel versus fixo, origem indisponível com cópia válida, informações privadas ausentes do cartão e bridge deduplicando ID original/limite de encaminhamento. `expect(browserSemanticHash).toBe(nodeSemanticHash)` com fixtures de merge, fontes e múltiplos perfis.
- [ ] Rodar `npx vitest run tests/world-conformance.test.ts tests/world-links.test.ts`; confirmar RED.
- [ ] Implementar pacote de conformidade, esquemas e cartões/links compartilháveis em clientes sociais, incluindo ActivityPub por compartilhamento explícito. Publicação nativa via ator ActivityPub exige adaptador/serviço opcional separado; não tornar servidor social requisito do jogo. Documentar API de adaptadores e matriz de capacidades comprovadas.
- [ ] Exigir PASS e replay Node/browser dos mesmos bytes. Publicar no repositório exemplos sintéticos com licença e limitações; não enviar mensagens/propostas às comunidades automaticamente. Registrar decisões para extensões Nostr/Matrix a partir dos testes, sem afirmar padronização já aceita.
- [ ] Commit: `docs: publish world interoperability contracts and conformance examples`.

## Verificação e critérios de saída

Cada tarefa segue RED → implementação mínima → GREEN; executar testes relevantes indicados e revisar o diff. Ao fechar uma entrega A–F, rodar `npm test`, `npm run typecheck`, `npm run typecheck:core`, `npx tsc -p tsconfig.world.json` e `npm run build`. Verificações de rede/browser registram ambiente, resultado e limitações; não substituir teste de federação real por mock e alegar que foi comprovada.

Uma entrega só está pronta quando seus cenários passam e a documentação distingue implementado, experimental e futuro. Não introduzir infraestrutura de produção para “completar” uma tarefa de teste. SDKs devem poder ser removidos/trocados sem alterar CityRules ou formatos de mundo.

| Requisito da spec | Tarefas que o entregam |
| --- | --- |
| R1 local/offline | 1–3, 9, 12 |
| R2 procedência e separação real/simulado | 2, 4, 15–16 |
| R3 revisões fixadas | 2, 5, 14–15 |
| R4 história e integração | 3–5, 14 |
| R5 invariantes | 4–7, 16 |
| R6 agnosticismo | 1, 6–8, 10–12, 17 |
| R7 determinismo | 1, 5, 7, 15, 17 |
| R8 sem servidor de simulação obrigatório | 7–10, 13 |
| R9 responsabilidades separadas | 6–8, 10–13 |
| R10 desconhecido e capacidades | 1, 5–6, 14, 16 |
| R11 privacidade | 6, 8–12, 17 |
| R12 termos e cobertura | 1–2, 5, 12, 15, 17 |
| R13 limites e escala | 3, 7–9, 12, 16 |

## Evolução condicionada a evidência

Depois dessas entregas, quatro expansões têm ponto de entrada definido, sem fazer parte do MVP:

- **Relevo e sensoriamento:** implementar outro `RealitySource`/normalizador, selecionar catálogo/produto com termos adequados e validar datum, resolução, buracos e replay; só depois acrescentar regras de encosta/água. OSM não fornece uma base de elevação completa.
- **Replicação espacial maior:** particionar `WorldTree` e fechar dependências por interesse; medir objetos compartilhados, bytes alterados e memória. Separar economias regionais exige regra explícita antes de permitir anfitriões independentes por região.
- **Desktop, libp2p e IPFS:** usar os contratos já exercitados; primeiro prova pequena de armazenamento em arquivo ou segundo transporte/provedor, depois empacotamento. Não criar outra simulação para desktop.
- **Transferências entre mundos e operação contínua:** escrever especificação própria de reserva/aceite/consumo e falhas antes de movimentar recursos escassos; operação 24 horas requer algum processo ativo voluntário/comunitário, sem alterar o funcionamento local.

**Primeiro passo de execução:** tarefa 1. **Primeiro resultado colaborativo:** entrega B, útil por arquivos. **Primeiro jogo em rede:** entrega C. Não iniciar todos os adaptadores simultaneamente nem transformar a abertura do protocolo em obrigação de implementar cada possibilidade agora.

## Desvios registrados

- **Tarefa 6:** `authorize(grant, proposal, context)` devolve `Promise<WorldResult<AuthorizedProposal>>` — o plano escrevia
  síncrono, mas a verificação de assinatura e o digest do ator são assíncronos. As provas são **destacadas**: os bytes
  canônicos de proposta, concessão e identidade excluem o campo `proof`, então o digest é estável e a assinatura não cria ciclo.
- **Tarefa 4:** `prepareProject`/`integrateProject` vivem em `src/world/city-profile.ts` (o perfil decide; `changes.ts` guarda
  dados e descrição) e `ProjectTarget` é estrutural, então um `Checkpoint` satisfaz a assinatura fixada sem criar
  `world -> session`. `ChangeSet.author` é apenas declarado: a integração age como `PROJECT_ACTOR` no estado de destino, e
  autoria nunca autoriza. Exportar/importar proposta existe no nível de dados (`changeSetValue`/`parseChangeSet`/
  `verifyChangeSet`/`attachBases`); a montagem na UI fica para as tarefas de transporte.
- **Tarefa 2:** `CaptureContext` carrega o `WorldCodec` — sem bytes canônicos não há endereço, e a assinatura fixada pelo plano
  (`captureBase(base, context, hash)`) não tinha por onde recebê-los. `RealitySource` exige `OsmSource` (não `MapSource`) para
  registrar endpoint/esquema/normalizador reais. Fonte indisponível falha com `NOT_FOUND`, porque o union `WorldErrorCode` da
  Tarefa 1 não tem código de indisponibilidade.

## Pendência de história

Dois commits de documentação (`e90a84b` e `b326832`) foram feitos com `git add -A` enquanto três agentes escreviam o mesmo
working tree, então arrastaram arquivos em voo para dentro de commits nomeados como documentação. A **árvore final está
correta** (as tarefas 4 e 12 commitaram depois o estado final dos seus arquivos); o que está errado é a partição da história.
Limpeza a fazer quando ninguém estiver escrevendo: repartir esses dois commits, deixando neles apenas este arquivo, e
republicar com `--force-with-lease`. Desde então o stage é sempre por caminho explícito e cada commit é conferido com
`git show --stat`.

## Execução

| Tarefa | Commit | Evidência registrada |
| --- | --- | --- |
| 4 | `eadffcb` | 9 testes em `tests/world-changes.test.ts`: campos independentes vs mesma célula, rua atravessando borda de trecho e o antimeridiano, namespace desconhecido preservado, prévia com `quote`/regras do destino (saldo e tick da origem nunca entram), cota por operação e soma sem aplicação parcial, autor declarado não vira ator, edição sem intenção e `tick` recusados como conflito. No navegador: painel de comparação "Real: 0 · Jogador: 2 (custo ~20) · Simulação: 1 · Metadados: 2" com região clicável, e construir pela UI gravou o checkpoint "Rua em 1 célula(s) · build:road@48557:74362#618". Cinco defeitos reais corrigidos no ciclo RED→GREEN.
| 6 | `dd58ebe` | 22 testes novos (15 em `world-permissions`, 7 em `world-wire`) com vetores da RFC 8032: principal falso, assinatura de 1 bit trocado, comprimento 126, chave de outro vetor, grant expirado/revogado/fora de região, replay noutra branch/época, namespace crítico desconhecido => `spectator`, `actorId.length === 66`, proposta recusada sem abrir lacuna na sequência do core. Três defeitos reais corrigidos no ciclo: leitura de `algorithm` no lugar errado, `Capabilities` sem discriminador e um vetor cujo "chave trocada" era a própria chave. Corrente de delegação não amplia escopo. Compilação pura limpa; suíte 166 testes (só falham os arquivos em voo da Tarefa 12).
| 3 | `e137e6c` | 8 testes em `tests/world-repository.test.ts` (fork reutiliza objetos e o pacote do filho não copia bytes iguais, obra no filho deixa o pai intacto, head obsoleto recusado com recibo idempotente, disco cheio não avança head nem deixa objeto/recibo, cópia exportada abre sem `MapSource` com head idêntico e sem câmera, fork recontextualiza `worldId` sem herdar concessão nem sessão, slot por mundo/branch, histórico pelo primeiro pai). Defeito real encontrado e corrigido: o recibo era consultado depois do CAS de head, então reenvio com head antigo virava `CONFLICT` em vez de repetir o resultado. Suíte: 131 testes; verificado também no navegador (painel Versões criou branch `experimento` com "Rua em 1 célula(s)" e exportou 442138 bytes).
| 2 | `0b4faac` | 10 testes em `tests/reality.test.ts` (base intocada, cobertura em coordenadas nomeadas, `observedAt` ausente quando só há download, nenhum ID OSM inventado, fonte/atribuição/extensões sobrevivendo ao pacote, região indisponível sem terreno inventado, endpoint/normalizador/zoom reais). Fixtures sintéticas em `tests/fixtures/federated-world/base-a.json` e `base-b.json`. Atribuição intacta em `map-provider` e `normalize`.
| 1 | `ee3e77e` | 7 testes em `tests/world-bundle.test.ts` (vetores RFC 8785, recusas de chave repetida/versão/limite/UTF-8, preservação do espaço de extensões, verificação de endereço por hash), `npx tsc -p tsconfig.world.json` limpo e camada `world` no teste de arquitetura. Suíte: 113 testes. |
