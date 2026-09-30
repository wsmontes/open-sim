# Adaptadores — API e matriz de capacidades comprovadas

Um adaptador é o único lugar onde este projeto toca uma plataforma, um SDK ou a rede. `tests/architecture.test.ts`
recusa um import de plataforma fora de `src/adapters/**`, e as camadas puras (`core`, `world`, `session`, `profiles`,
`presentation`) compilam sem DOM e sem tipos de Node (`npm run typecheck:core`, `npx tsc -p tsconfig.world.json`). A
consequência prática: trocar de transporte, de armazenamento ou de provedor de mapas não muda `CityRules` nem o formato
do mundo.

O que se exige de qualquer adaptador:

- **não decide** autoridade, economia nem geografia — ele transporta, guarda ou traduz;
- **declara seus limites** (bytes, tempo, quantidade) e recusa o que passa deles, em vez de truncar;
- **reporta a recusa de terceiros** com a mensagem do terceiro, sem inventar sucesso;
- **preserva** o que não entende (componente, namespace, campo de extensão);
- e é **removível**: nenhum adaptador é requisito para a partida local existir.

## 1. Portas e implementações

| Porta | Declarada em | Implementações neste repositório |
| --- | --- | --- |
| `WorldCodec.encode(value) → bytes` | `src/world/ports.ts` | `src/adapters/codec/jcs.ts` (JCS/RFC 8785, puro) |
| `ContentHasher.ref(bytes) → ObjectRef` | `src/world/ports.ts` | `src/adapters/hash/content.ts` (WebCrypto, browser e Node) |
| `WorldStorage` (objetos, cabeças, recibos, transação) | `src/session/world-ports.ts` | `src/adapters/storage/world-memory.ts`, `src/adapters/storage/world-indexed-db.ts` |
| `KernelTransport` (publish/query/subscribe/resolve, §30) | `src/world/kernel.ts` | `src/adapters/nostr/relay.ts`, `src/adapters/matrix/rooms.ts` (+ um adaptador em memória no executor de conformidade) |
| `SessionTransport` (mensagem, controle, efêmero) | `src/session/multiplayer-ports.ts` | `src/adapters/network/memory.ts`, `src/adapters/network/webrtc.ts` |
| `Signaling` (sinal assinado, cópia/cola) | `src/adapters/network/manual-signaling.ts` | `src/adapters/network/webrtc.ts` (sinalização manual) |
| `IdentityProvider`, `SignatureVerifier` | `src/world/permissions.ts` | `src/adapters/crypto/session-keys.ts` (Ed25519), `src/adapters/nostr/identity.ts` (NIP-07/chave local), `src/adapters/matrix/identity.ts` |
| Convite / entrada (`InviteService`) | `src/adapters/nostr/invites.ts` | `src/adapters/nostr/invites.ts`, `createMatrixInviteService` em `src/adapters/matrix/rooms.ts` |
| `ObjectStore` (get/put por endereço) | `src/adapters/blobs/direct.ts` | `direct.ts`, `http.ts`, `blossom.ts` |
| `CryptoPort` (objetos privados selados) | `src/adapters/crypto/private-objects.ts` | `private-objects.ts` (AES-GCM com nonce e contexto autenticado) |
| `RealitySource.capture(region, request)` | `src/world/reality.ts` | `src/adapters/reality/osm-capture.ts`, `gtfs.ts`, `observation-file.ts` |
| `ObjectResolver` (cópias, cabeça, objeto) | `src/world/world-links.ts` | implementado pelo chamador; o cartão/link não abre soquete sozinho |
| Cartão e link públicos | `src/adapters/social/world-card.ts`, `src/world/world-links.ts` | puros, sem rede: compartilhar é decisão de quem compartilha |

## 2. Matriz de capacidades

**Implementado** = existe código e teste na suíte. **Exercitado contra serviço real** = foi rodado contra
infraestrutura de verdade, e o que foi feito está dito. **Contrato** = a interface existe e é exercitada por um
implementação de teste, sem serviço real. **Futuro** = desenhado, não implementado.

| Capacidade | Estado | Evidência / ressalva |
| --- | --- | --- |
| Bytes canônicos JCS + endereço por SHA-256 | Implementado | `tests/world-bundle.test.ts`, `tests/osim-boundary.test.ts`; mesmos bytes → mesmo endereço em Node e no navegador (`tests/world-conformance.test.ts`) |
| Replay de conformidade do §47 + pacote público | Implementado | `tests/world-conformance.test.ts`; `tools/world-replay.ts`; `tests/browser/world-replay.html` |
| Links entre mundos (fixo/móvel, chegada, capacidades, cópias, ponte) | Implementado | `tests/world-links.test.ts`; nenhuma rede: os links são valores |
| Cartão público e documento para ActivityPub | Implementado (documento) | `tests/world-links.test.ts`; o documento é uma `Note` para compartilhamento explícito, **sem** ator/inbox |
| Objeto endereçado em armazenamento local | Implementado | `tests/world-repository.test.ts`, `tests/world-blobs.test.ts` |
| IndexedDB no navegador | Implementado, sem teste de unidade | `src/adapters/storage/world-indexed-db.ts` é usado pela montagem do browser; a porta é exercitada por `world-memory` e pelo IndexedDB do navegador |
| Nostr: identidade NIP-07 / chave local | Implementado | `tests/nostr-adapter.test.ts` |
| Nostr: relay como `KernelTransport` (kind 1 público, kind 4 privado) | Implementado e **exercitado** | `tests/nostr-adapter.test.ts` com `OSIM_NOSTR_RELAY=ws://127.0.0.1:7777` (túnel local até o strfry do operador): publicação e leitura de volta |
| Nostr: NIP-46 (bunker) | Futuro | Só entra com os testes completos de identidade/permissão; NIP-78 nunca é usado para descoberta pública |
| Nostr: sinalização automática | Futuro | O caminho exercitado é o sinal manual assinado (copiar/colar) |
| Matrix: conta, sala privada, capacidade | Implementado | `tests/matrix-adapter.test.ts`, `tests/federated-adapters.test.ts` |
| Matrix: homeserver real | Contrato nesta máquina | O teste é pulado sem `OSIM_MATRIX_HOMESERVER` (e `OSIM_MATRIX_SECRET_FILE`); o laboratório descartável de Synapse está descrito no plano (`wawa-irc/tests/e2e/matrix`, cópia local com `ports: 6167:8008`) |
| Matrix: sinalização por sala | Futuro | Mesma decisão do Nostr: a sinalização exercitada é manual/assinada; nada de declarar federação validada sem prova |
| WebRTC: sessão e transferência de objetos | Implementado | `tests/webrtc-adapter.test.ts`, `tests/object-transfer.test.ts` — com portas WebRTC falsas, sem rede pública; compatibilidade ampla de NAT **não** foi medida |
| WebRTC: TURN com credenciais temporárias | Implementado (configuração) | `src/adapters/network/webrtc.ts`; nunca segredo permanente no pacote do aplicativo |
| Objetos privados (selagem AEAD, chaves fora de referências públicas) | Implementado | `tests/world-blobs.test.ts` |
| Provedores de objetos: direto, HTTP, Blossom | Implementado | `tests/world-blobs.test.ts`; IPFS fica para depois desses contratos, sem daemon obrigatório |
| Retenção por alcançabilidade | Implementado | `tests/world-retention.test.ts` — recusa recolher quando o inventário está incompleto |
| Perfil cidade: núcleo portátil, comandos, economia | Implementado | suíte principal (`tests/simulation.test.ts`, `tests/commands.test.ts`, …) |
| Perfil explorador sobre as mesmas entidades | Implementado | `tests/cross-profile.test.ts`, `tests/world-entities.test.ts` |
| GTFS (transporte) por arquivo/região | Implementado, com limites declarados | `tests/gtfs-source.test.ts`; o adaptador declara `routing: 'not-computed'`, `realtime: 'not-included'` |
| Observações gravadas (clima) com replay sem rede | Implementado | `tests/external-input.test.ts` |
| OSM (tiles vetoriais) com procedência congelada | Implementado e **exercitado** contra o serviço real | `tests/map-provider.test.ts`, `tests/reality.test.ts`; somente área visível, sem download em massa, sem escrita no OSM |
| Relevo / GeoTIFF / STAC | Futuro | Precisa de catálogo com termos adequados e datum/resolução explícitos |
| Ator ActivityPub nativo | Futuro | Compartilhar o documento existe; operar ator/serviço social não é requisito do jogo |
| IPFS / libp2p / desktop | Futuro | Primeiro uma prova pequena de armazenamento em arquivo ou segundo provedor; sem criar outra simulação |

## 3. Regras que cada adaptador social segue

- **Kinds e tipos de evento controlados.** No Nostr, este projeto escreve kind 1 (público) e kind 4 (privado a um
  destinatário); no Matrix, apenas o tipo de evento `org.opensim.*`. Nenhum kind novo é registrado por conta própria.
- **Namespace controlado na leitura.** Um evento de sala de outro tipo, ou um objeto cujo ator não é a conta que o
  homeserver atesta, é descartado: o adaptador não faz ponte entre comunidades.
- **Nada de segredo em documento público.** Chave, prova, concessão e estado privado ficam fora de cartão, link e
  payload público (`tests/world-links.test.ts`, `tests/nostr-adapter.test.ts`).
- **Power level de sala e posse de link não são permissão de jogo.** Escrever continua passando por `authorize` contra a
  versão que o autor viu.
- **Nada é publicado automaticamente** nas comunidades de ninguém: cartão, link e convite são valores que uma pessoa
  decide compartilhar.

## 4. Como exercitar os serviços reais

```sh
# Relay Nostr do operador (strfry no Pi, por túnel local; a ponte sobe 127.0.0.1:7777)
OSIM_NOSTR_RELAY=ws://127.0.0.1:7777 npx vitest run tests/nostr-adapter.test.ts

# Homeserver Matrix: suba o laboratório descartável descrito no plano e aponte a variável
OSIM_MATRIX_HOMESERVER=http://127.0.0.1:6167 \
OSIM_MATRIX_SECRET_FILE=/tmp/opensim-matrix-lab/registration-secret.txt \
npx vitest run tests/matrix-adapter.test.ts
```

Os dois testes são pulados por padrão; nenhum deles escreve nas comunidades reais do usuário. A verificação de 2026-09-29
cobriu o relay Nostr (publicação e leitura de volta) e **não** cobriu o homeserver Matrix nesta máquina — o relatório do
plano registra cada uma como o que ela foi.
