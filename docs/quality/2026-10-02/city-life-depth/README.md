# Identidade, ruas, obra, vida e luz — 2 de outubro de 2026

Segunda passada sobre as cinco intenções de cidade viva, depois do checkpoint `c143559` e da primeira entrega (`docs/quality/2026-10-02/city-life/`). As duas referências anteriores continuam válidas: nada aqui substitui `../README.md`.

Capturas do servidor de desenvolvimento, em 1024 × 768; a de celular em 390 × 844.

- `bairro.jpg` — Lisboa no nível de bairro. Linhas de janelas, faixas de cornija nos prédios baixos, telhados de barro com cumeeira, faixas de pedestres nos cruzamentos, calçadas, árvores em canteiro e as juntas de pavimento da praça no alto do quadro.
- `praca.jpg` — São Paulo. A praça é pavimentada, não apenas tingida; a água reflete e se move com o relógio do jogo.
- `obras.jpg` — prévia de construção: o volume que a ferramenta vai colocar aparece na cor do que o jogador pode pagar, antes de qualquer gasto.
- `canteiro.jpg` — lote comprado e ainda vazio: terra batida, cerca tracejada, linha de fundação e placa de obra virada para a rua. O jogo está pausado, então o lote não cresceu.
- `noite.jpg` — Lisboa à noite: janelas acesas onde a rede elétrica chega, postes ao longo das ruas, cruzamentos iluminados.
- `celular.jpg` — 390 × 844, com a barra de ferramentas por rolagem horizontal.

O que estas capturas não provam sozinhas: as divisões das casas geminadas, a serra do telhado dos galpões, a caixa d'água dos apartamentos e a sombra única das torres são afirmadas por testes (`tests/architecture-identity.test.ts`, `tests/geographic-render.test.ts`), não por imagem. `npm run check` e `npm run build` foram executados neste estado.
