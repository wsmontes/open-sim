# Continuação do Open Sim

## Pedido e autorizações

O usuário quer um jogo fofo e simples, inspirado em SimCity 2000, com cidades e geografia reais do OpenStreetMap. É possível reformar cidades existentes ou construir em áreas vazias de um mundo contínuo. O núcleo deve ser independente de plataforma; browser é o primeiro cliente, aplicativo desktop e Nostr para amigos/multiplayer vêm depois.

O usuário aprovou a especificação, o plano e a execução direta. Não é necessário repetir brainstorming ou pedir aprovação para continuar o escopo aprovado. O trabalho foi interrompido a pedido do usuário por limite de uso e preparado para outro agente.

## Documentos

- Especificação: `docs/superpowers/specs/2026-09-29-open-sim-design.md`.
- Plano: `docs/superpowers/plans/2026-09-29-open-sim.md`.
- Este arquivo preserva o andamento; o ledger temporário da skill fica ignorado pelo Git e não deve ser necessário para retomar.

## Estado atual

- **Task 1 concluída**, commit `c5cf8df`: tipos portáteis, grade global, construção/demolição, custos, revisão e deduplicação de comandos.
- **Task 2 concluída**, commit `d76c1ad`: crescimento, energia, economia e felicidade determinísticos.
- **Task 3 implementada e verificada por testes automáticos**: adaptador HTTP/MVT do OSM, cache, limite de concorrência, normalização de polígonos, água, edifícios e vias. Falta a comparação visual com dados reais, que depende do cliente da Task 5.
- São 17 testes passando, além de `typecheck` e `typecheck:core`.
- Ainda não existe interface jogável, `index.html`, sessão local ou persistência implementada. Os scripts `dev`, `build`, `preview` e `replay` já estão declarados, mas seus pontos de entrada ainda precisam ser criados.

## Próximos passos

1. Continuar pela **Task 4**: sessão local, validação de snapshots, restauração, autosave e IndexedDB. `src/session/ports.ts` já define os contratos de mapa/save; aproveitar esses tipos.
2. Implementar a **Task 5**: cliente browser, renderização isométrica, câmera, ferramentas, indicadores, escolha de lugares e controles.
3. Completar a verificação visual da **Task 3** com cidade e costa reais, incluindo erros de rede e limites dos trechos.
4. Implementar a **Task 6**: replay equivalente em browser/Node, verificação de limites de dependência, documentação, revisão final e validação integrada.

Seguir os detalhes e contratos do plano. Não adicionar Nostr, contas, relevo real ou empacotamento desktop neste primeiro ciclo.

## Execução e verificação

Na pasta principal do projeto:

```sh
npm ci
npm test
npm run typecheck
npm run typecheck:core
```

O desenvolvimento foi feito com Node 26.8.1 e npm 11.19.0; `package.json` exige Node >=22.12. Há lockfile. O build completo só poderá ser verificado após criar o cliente.

## Decisões e cuidados

- A cópia isolada original fica em `/Users/wagnermontes/.codex/worktrees/open-sim-playable/open-sim`, branch `codex/open-sim-playable`. O usuário pediu que os commits fossem incorporados à pasta principal `/Users/wagnermontes/Documents/GitHub/open-sim` para continuar ali.
- As regras não importam DOM, Canvas, HTTP ou armazenamento. A configuração `tsconfig.core.json` compila sem tipos de navegador ou Node.
- A fonte confirmada é `https://vector.openstreetmap.org/shortbread_v1/{z}/{x}/{y}.mvt`, no zoom 14, substituível por configuração. O TileJSON foi consultado e o endpoint permite CORS; o cliente ainda não foi testado com mapas reais na tela.
- Testes de mapas usam HTTP controlado e geometria sintética; esses dados não são apresentados como mapas reais ao jogador.
- IDs de células não dependem da câmera. Mudanças são sobrepostas à base; demolições registram células vazias explicitamente.
- Títulos de tarefas no plano foram alterados de `Tarefa` para `Task` apenas para compatibilidade com os scripts das skills.
- Nenhum push, deploy ou publicação foi feito.
