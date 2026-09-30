# OpenSim kernel — pseudocódigo de referência

O protocolo é um kernel, não uma aplicação. Um jogo de corrida em Unreal, um construtor de cidades no navegador e um
jogo de cartas no terminal compartilham **este pseudocódigo**; não compartilham código, compartilham as mesmas
decisões. Este documento é o kernel em forma de contrato; `src/world/osim.ts` e `src/world/kernel.ts` são a
implementação de referência em TypeScript, e `tests/kernel.test.ts` / `tests/osim-boundary.test.ts` verificam cada
linha abaixo.

Fonte normativa: `docs/OpenSim-Protocol-0.1.txt`. Onde este texto e o protocolo divergirem, o protocolo manda.

## 1. O modelo

```text
ENTITY        = identidade estável + componentes arbitrários
COMPONENT     = um aspecto que outra aplicação pode entender sem entender a entidade
EVENT         = mudança imutável     (+ timeline, time, actor)
TIMELINE      = quadro temporal      (+ parent, forkAt, rate)
SNAPSHOT      = estado materializado em um ponto conhecido
SESSION       = interação temporária de alta frequência
CAPABILITY    = autorização sobre entidade/componente/ação
ASSET         = blob externo endereçado por conteúdo
```

Nada disso é hierarquia de classes: o significado vem dos componentes, e o namespace é a fronteira de entendimento
(`osim.*` é o núcleo; `org.openstreetmap.*`, `com.exemplo.*` são de quem os define; `x.*` é experimental).

## 2. As cinco operações

```text
resolve(uri)
    se o objeto está no armazenamento local: devolva a melhor representação local
    senão: pergunte aos adaptadores; "ninguém tem" é uma resposta, não um erro

query(space, time, filter)
    o kernel NÃO tem geografia: o perfil fornece o índice espacial e o kernel filtra
    devolva as identidades que satisfazem o filtro, em ordem estável

publish(object)
    valide o envelope; aplique ao estado local PRIMEIRO; só então replique
    um adaptador que recusa é reportado e NÃO desfaz a realidade local

subscribe(filter)
    entregue o que este cliente publica e o que os transportes trazem
    aplicação local do recebido usa exatamente a mesma deduplicação do publicado

join(sessionUri)
    resolva o descritor da sessão; a negociação de tempo real é da aplicação
```

## 3. As quatro operações de estado

```text
set(entity, component, value)     substitui o componente
merge(entity, component, fields)  escreve campos dentro de um componente estruturado
                                  -> o que este cliente não escreveu permanece
remove(entity, component)         remove um componente
delete(entity)                    marca a entidade como apagada (tombstone), não reescreve história
```

Aplicar um evento é puro: recebe componentes, devolve componentes novos. Um evento recusado não muda nada, e um
evento repetido (mesmo id) não muda nada **pela segunda vez** — a ordem de entrega da rede não é a ordem da
simulação, então duplicado, atrasado e reordenado são normais, não excepcionais.

## 4. As duas políticas

```text
REGISTRO DE PROTOCOLO (envelope, cabeça, referências, completude, operação)
    é FECHADO: campo que este contrato não define é recusado, e acrescentar um exige versão nova

COMPONENTE (valor, namespace, corpo de entidade)
    é ABERTO: o que este cliente não entende atravessa intacto e volta idêntico
```

A assimetria é o coração do protocolo (§2.3): um cliente que não implementa `building.interior` não pode apagar a
sala de estar de outro perfil, mas também não pode fingir que entendeu um campo novo no enquadramento.

## 5. Invariantes

```text
1. Identidade e significado pertencem aos objetos, não aos servidores nem às aplicações.
2. O dispositivo local é o primeiro detentor do estado; nenhum servidor é necessário para o mundo existir.
3. O transporte é substituível e nenhum adaptador muda o significado do que carrega.
4. Tempo é coordenada: quando aconteceu != quando soubemos; um período não vira instante.
5. Assets vivem fora do fluxo de eventos e são endereçados por conteúdo.
6. Autoridade é avaliada por componente e por época; o kernel não julga, ele carrega a prova.
7. Sessão não é história: só resultados significativos viram eventos (§24).
```

## 6. Checklist de conformidade (§47)

Uma implementação é **OpenSim 0.1 Core Compatible** se consegue:

```text
[1] ler o envelope do núcleo
[2] identificar entidades
[3] RETER componentes desconhecidos
[4] processar as quatro operações de estado
[5] identificar timeline e tempo
[6] resolver objetos globalmente referenciáveis
[7] publicar e receber por pelo menos um adaptador de transporte
```

Os sete itens estão em `tests/osim-boundary.test.ts` como teste; o item 7 usa o codec canônico (bytes
determinísticos) porque os adaptadores reais entram nas tarefas de rede.

## 7. Onde cada linha vive neste repositório

| Pseudocódigo | Implementação de referência |
| --- | --- |
| Envelope, identificadores, quatro operações, vocabulário `osim.*`, tempo | `src/world/osim.ts` |
| `resolve/query/publish/subscribe/join`, armazenamento local, deduplicação | `src/world/kernel.ts` |
| Estado durável local (manifesto, linhagem, identidade semântica) | `src/core/protocol.ts`, `src/core/snapshot.ts` |
| Aplicação dos comandos do perfil ao estado | `src/core/commands.ts`, `src/core/simulation.ts` |
| Transporte (Nostr, Matrix, WebRTC) | `src/adapters/*` — nunca importados pelo kernel |
| Assets e retenção | `src/adapters/blobs/*`, `src/session/world-retention.ts` |
| Sessão (anfitrião, réplica, handover) | `src/session/host-session.ts`, `src/session/replica-session.ts` |
| Perfil cidade (regras do jogo, custos, crescimento) | `src/world/city-profile.ts`, `src/core/*` |

## 8. O que não é kernel

Gráficos, física, economia, regras do jogo, moderação, hospedagem de assets, índices geográficos, política de
conflito e IA local. O teste de desenho do §51 vale para toda adição: *isto poderia ser um componente?* Se sim, não
entra no núcleo — foi assim que "construir uma rua" ficou como intenção do perfil cidade e o kernel ficou com
`set/merge/remove/delete`.
