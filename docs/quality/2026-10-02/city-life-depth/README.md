# Identidade, ruas, obra, vida e luz — 2 de outubro de 2026

Segunda passada sobre as cinco intenções de cidade viva, depois do checkpoint `c143559` e da primeira entrega (`docs/quality/2026-10-02/city-life/`). As duas referências anteriores continuam válidas: nada aqui substitui `../README.md`.

Capturas do servidor de desenvolvimento, em 1024 × 768; a de celular em 390 × 844.

- `bairro.jpg` — Lisboa no nível de bairro. Linhas de janelas, faixas de cornija nos prédios baixos, telhados de barro com cumeeira, faixas de pedestres nos cruzamentos, calçadas, árvores em canteiro e as juntas de pavimento da praça no alto do quadro.
- `praca.jpg` — São Paulo. A praça é pavimentada, não apenas tingida; a água reflete e se move com o relógio do jogo.
- `obras.jpg` — prévia de construção: o volume que a ferramenta vai colocar aparece na cor do que o jogador pode pagar, antes de qualquer gasto.
- `canteiro.jpg` — lote comprado e ainda vazio: terra batida, cerca tracejada, linha de fundação e placa de obra virada para a rua. O jogo está pausado, então o lote não cresceu.
- `noite.jpg` — Lisboa à noite: janelas acesas onde a rede elétrica chega, postes ao longo das ruas, cruzamentos iluminados.
- `celular.jpg` — 390 × 844, com a barra de ferramentas por rolagem horizontal.

- `emendas-antes.jpg` / `emendas-depois.jpg` — o mesmo enquadramento em São Paulo (Praça da República, 10 m), o mesmo save, o mesmo zoom. Antes: cada rua era desenhada inteira, uma depois da outra, então a guia de uma rua era pintada por cima do asfalto da outra em cada cruzamento — uma barra clara atravessando a rua escura, e os caminhos de parque apareciam como ruas com guia. Depois: a cidade é pintada em passadas (terreno, todas as guias, todos os asfaltos, todas as marcas), então a rua é contínua no cruzamento e o caminho de parque para na guia. As duas capturas vêm do site publicado, antes e depois do commit `6e01ea1`.

- `arvores-claro.jpg` / `arvores-largo.jpg` — o mesmo parque em Lisboa a 10 m e a 20 m. As árvores de longe são as mesmas de perto, nos mesmos lugares: o plantio pertence ao chão, não ao recorte que o tile fez da rua naquele zoom. Antes disto as árvores nasciam no meio dos segmentos do tile e eram cortadas por um teto de 70 por quadro, então mudavam de lugar e de conjunto a cada zoom.

O que estas capturas não provam sozinhas: as divisões das casas geminadas, a serra do telhado dos galpões, a caixa d'água dos apartamentos e a sombra única das torres são afirmadas por testes (`tests/architecture-identity.test.ts`, `tests/geographic-render.test.ts`), não por imagem.

A ordem das passadas das ruas também é afirmada por teste (`tests/geographic-render.test.ts`, "every kerb in the city is laid before the first pavement"), que falha na implementação anterior à `6e01ea1` e passa nesta. `npm run check` e `npm run build` foram executados neste estado.
