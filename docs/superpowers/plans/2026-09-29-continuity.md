# Open Sim — melhorias e continuidade

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Execução direta é a preferência já indicada pelo usuário.

**Goal:** Consolidar o protótipo existente antes de ampliar o contrato de mundos compartilhados.

**Architecture:** Manter núcleo puro, sessão local e adaptadores. Corrigir os contratos existentes de identidade e preservação; limitar o cache de exploração sem descartar regiões administradas. Desktop e rede continuam etapas separadas.

**Tech Stack:** TypeScript, Vite, Canvas 2D, Vitest e IndexedDB já instalados; nenhuma dependência nova prevista neste ciclo.

**Spec:** [Escopo original](../specs/2026-09-29-open-sim-design.md), [implementação atual](../../implementation.md), [carta arquitetural](../../architecture.md) e [contrato portátil](../../world-protocol.md).

## Estado verificado

Base da análise: commit `631bb49`, branch `codex/open-sim-design`, árvore inicialmente limpa. O registro antigo `docs/HANDOFF.md` foi removido; não usar o estado da conversa anterior como retrato do código atual.

- Já existem jogo browser, mapas reais, construção, economia, salvamento/restauração, controles de mapa, rotação, visão geral e carregamento progressivo.
- O núcleo roda fora do browser; há replay, limites de dependência, componentes com namespace, manifesto e hash de conteúdo.
- Verificação desta análise: **98 testes em 14 arquivos passando**, `typecheck:core` e build de produção passando. Bundle principal: 56,20 kB, 20,29 kB gzip.
- Não foi repetida a avaliação visual nesta análise econômica. Resultados de desempenho descritos nos documentos são registros anteriores, não medições novas.
- Ainda faltam entidades genéricas, materialização conservando população e uma prova com outro perfil. Desktop empacotado e Nostr não estão implementados.

## Global Constraints

- Não haverá acoplamento do domínio a browser, Electron, Tauri ou Nostr.
- Comandos e snapshots usam objetos serializáveis em JSON e versões explícitas.
- A câmera nunca determina os resultados da economia.
- Não incluir download em massa do mapa.
- O jogo nunca envia essas mudanças ao OpenStreetMap.
- Preservar saves existentes e campos de outros perfis; não repetir as seis tarefas já concluídas do plano original.

## Review Focus

1. Campo desconhecido dentro de um objeto conhecido do manifesto: preservar valor sem aceitar tipos inválidos; Task 1.
2. Ciclo real de sessão → armazenamento → sessão: preservar metadados extras do envelope e da visão; Task 1.
3. Um ou vários comandos efêmeros entre alterações duráveis: identidade durável deve permanecer igual; Task 2.
4. Hash de identidade versus hash de arquivo: referências a snapshots precisam conferir com os bytes realmente exportados; Task 2.
5. Exploração longa e respostas antigas de rede: memória de áreas apenas visitadas deve poder ser liberada sem perder obras; Task 3.

## Achados que determinam a prioridade

| Prioridade | Evidência atual | Efeito |
| --- | --- | --- |
| P0 | `decodeManifest` reconstrói `rules`, `base`, `authority`, `snapshot` e `parent`; uma propriedade de teste em `rules` desapareceu | Outro cliente pode perder metadados ao atravessar este cliente |
| P0 | `createSession().save()` monta um envelope novo; propriedade extra no save desapareceu após restaurar e salvar | O codec preserva dados que o fluxo real acaba descartando |
| P0 | `durableJson` filtra componentes efêmeros, mas inclui `revision` e `actors`; um comando efêmero alterou o resultado na reprodução | Movimento transitório invalida a suposta identidade durável |
| P1 | `requested` no browser e `chunks` na sessão acumulam entradas sem descarte; somente tiles do fornecedor têm LRU | O consumo de memória cresce conforme se visita mais regiões; magnitude ainda não medida |

## Ciclo imediato — três entregas pequenas

### Task 1: Preservação completa no caminho real de salvamento

**Files:** modificar `src/core/protocol.ts`, `src/session/local-session.ts`, `tests/protocol.test.ts`, `tests/session.test.ts`; ajustar `tests/snapshot.test.ts` apenas se o codec precisar mudar.

**Interfaces:** preservar as assinaturas de `decodeManifest(value: unknown): WorldManifest`, `createSession(...)`, `save(view: ViewState): Promise<void>` e `SaveStore`. A sessão conserva os metadados do envelope restaurado e mescla a visão atual aos campos desconhecidos da visão anterior.

- [x] Escrever regressões com campo `future` em cada objeto conhecido do manifesto; o valor deve sobreviver a decode/encode sem alias com a entrada. Validar também tipos estritos de `actorId`, `key` e `durable`, namespaces duplicados e recusa de chaves reservadas.
- [x] Escrever teste integrado com `createMemoryStore`: restaurar save com extras no envelope e na visão, avançar um tick, salvar uma câmera nova e restaurar novamente. Asserções: extras intactos, tick avançado e câmera atualizada.
- [x] Rodar `npm test -- tests/protocol.test.ts tests/session.test.ts tests/snapshot.test.ts`; confirmar que as regressões falham antes da correção.
- [x] Aplicar a preservação de extras nos objetos conhecidos do manifesto com a mesma validação de JSON seguro. Guardar na sessão o envelope restaurado e preservar seus extras ao gerar saves, mantendo estado e campos conhecidos da câmera atuais. Não reutilizar metadados de um save recusado.
- [x] Rodar os testes acima e `npm run typecheck`; exigir sucesso. Commit isolado: `fix: preserve portable metadata across session saves`.

### Task 2: Separar identidade durável de contadores operacionais

**Files:** modificar `src/core/protocol.ts`, `tests/protocol.test.ts`, `docs/world-protocol.md`; verificar consumidores em `src/adapters/hash/content.ts` e `tests/replay.test.ts`.

**Interfaces:** conservar `durableJson(state: GameState, extensions?: readonly ExtensionDeclaration[]): string` e `contentRef(text: string)`. Definir identidade semântica como projeção do estado persistente, excluindo `revision`, `actors` e componentes declarados efêmeros. O snapshot completo continua contendo contadores para restauração e deduplicação.

- [x] Escrever testes comparando um estado com zero, um e vários comandos efêmeros sucessivos. Todos devem ter a mesma identidade durável; uma construção ou alteração de dinheiro deve mudar essa identidade. Testar declaração de namespace efêmero ainda ausente do estado.
- [x] Escrever teste em que `snapshot.hash` corresponde exatamente ao texto completo do snapshot exportado, incluindo contadores; restaurá-lo deve manter a deduplicação de comandos. Não usar a projeção semântica como se fosse o arquivo completo.
- [x] Rodar `npm test -- tests/protocol.test.ts tests/replay.test.ts`; observar as falhas relevantes.
- [x] Ajustar a projeção de `durableJson` sem retirar contadores de `GameState` ou do save. Serializar a identidade como `{identityVersion: 2, state: projection}` com o serializador canônico existente. Documentar que identidades antigas não são comparáveis sem recálculo; hashes de arquivos existentes continuam representando seus bytes originais.
- [x] Documentar os dois usos: identidade semântica para comparar fatos duráveis e endereço de conteúdo para localizar/verificar um arquivo exato. Efêmeros fora da sessão durável são evolução posterior, não uma infraestrutura nova neste ciclo.
- [x] Rodar os testes acima, `npm run typecheck:core` e `npm run typecheck`. Commit: `fix: keep transient events out of durable identity`.

### Task 3: Memória limitada durante a exploração

**Files:** modificar `src/session/local-session.ts`, `src/browser/main.ts`, `tests/session.test.ts`; atualizar `docs/implementation.md` com a política adotada.

**Interfaces:** acrescentar `LocalSession.retainVisible(ids: readonly string[]): void`. O browser informa a área visível atual; regiões administradas ficam protegidas pelo estado durável. Manter, além das visíveis, até 256 regiões recentes não administradas.

- [x] Escrever teste que visita sucessivos conjuntos de regiões e consulta `getChunk`: antigas fora da janela devem ser descartadas; regiões visíveis e administradas devem continuar disponíveis. Retornar a uma região descartada deve recarregá-la normalmente.
- [x] Escrever teste com resposta atrasada de região já descartada: ela não deve repovoar indefinidamente o cache. Testar retorno rápido à mesma região enquanto uma requisição antiga ainda está em voo, sem resultado antigo substituir o novo estado.
- [x] Rodar `npm test -- tests/session.test.ts`; confirmar as falhas esperadas.
- [x] Implementar descarte por uso recente na sessão e substituir a acumulação de `requested` por acompanhamento da área atual. Preservar trechos administrados, edições e resumos; não alterar a LRU de 32 tiles do fornecedor nem aumentar requisições em paralelo.
- [x] Rodar testes de sessão e mapas. Fazer uma única verificação no browser: navegar, voltar a uma obra, recarregar, girar e mudar zoom. Registrar cache/memória antes e depois em exploração manual; não executar varredura automatizada contra servidores públicos.
- [x] Rodar `npm test`, `npm run typecheck:core` e `npm run build`. Commit: `perf: bound explored-region memory`.

## Continuidade após esse ciclo

Cada linha abaixo merece um plano pequeno próprio quando chegar sua vez; não executar tudo de uma vez.

| Ordem | Entrega | Critério de conclusão |
| --- | --- | --- |
| 4 | Exportar/importar um mundo local: manifesto + snapshot verificado | Transferir para outro navegador e recuperar obras, componentes e câmera; rejeitar hash incorreto sem sobrescrever a partida atual |
| 5 | Entidades com ID estável e `geo.position` em longitude/latitude | Dois consumidores identificam o mesmo objeto sem depender da grade isométrica; saves antigos continuam abrindo |
| 6 | Materialização transacional de moradores | `64 = 60 agregados + 4 entidades`; reenvio e desmaterialização não duplicam nem eliminam população |
| 7 | Segundo perfil mínimo, inicialmente um executor simples | Abrir o mundo, materializar uma entidade, salvar e voltar ao perfil cidade preservando os dois estados; sem importar browser/apresentação |
| 8 | Aplicativo desktop | Reutilizar núcleo e, inicialmente, interface web; abrir/restaurar a mesma partida em pacote local |
| 9 | Nostr e cooperação | Primeiro identidade, convites e descoberta; depois ações com autoridade, ordenação e reconexão verificadas. Transporte de tempo real é decisão posterior baseada em necessidade medida |

Na etapa de materialização, resolver primeiro a contabilidade: população total permanece 64; o restante agregado é 60. Receita, energia e emprego não podem cair só porque quatro moradores passaram a ser entidades. Exclusão genérica de componente não deve servir de desmaterialização. Atualizar a receita simplificada de `docs/world-protocol.md` antes de implementá-la.

## Forma econômica de continuar

Executar diretamente, uma tarefa e um commit por vez. Reaproveitar testes e componentes existentes. Rodar testes focados durante alterações e a suíte completa ao fechar o ciclo. Evitar reescrita, novo motor gráfico, pesquisa adicional de protocolos e novos serviços enquanto as três correções imediatas não estiverem verificadas.

Este documento é uma proposta de continuidade, não uma implementação. Nenhum código do produto foi alterado nesta análise.
