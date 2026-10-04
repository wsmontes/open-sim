# Vancouver: dados, relevo e mobilidade

Implementação nativa no worktree `vancouver-data-mobility`, baseada no commit `07d39aa`. Esta entrega tem cobertura parcial de fontes; nenhuma posição sintética é apresentada como telemetria ao vivo. A conclusão dos checks não significa cobertura integral das rotas, datas ou municípios.

## Dados e fontes

- [Cobertura por mundo, Canadá, BC e operador](source-coverage.md).
- [Consulta direta pelo navegador, CORS e alternativas sem servidor](browser-source-feasibility.md).
- [População, demografia e orçamento conferidos](source-audit.md): Vancouver CSD 5915022/DGUID 2021A00055915022, censo 2021 **662.248 habitantes**. Estimativa BC 2025 **740.443**, mantida separada. Orçamento operacional aprovado 2026 **CAD 2.392.516.009**, capital anual **CAD 894.000.000**. Realizado 2024 separado do orçamento.
- [Terreno e datum](terrain-audit.md): HRDEM/MRDEM compatíveis com CGVD2013; ausência de altura permanece ausência. Apoio de prédios, pontes e aeronaves derivado do terreno. Água usa datum visual constante, sem marés.

## Movimento na cena principal

Carros, caminhões, pedestres, patrulhas e ônibus escolares compartilham rede, filas e interseções. Escolas e posições de semáforos são reais; itinerários escolares, horários de pico e fases dos sinais são hipóteses de simulação. Contagens oficiais georreferenciadas utilizáveis não foram capturadas; o modo calibrado permanece indisponível. O controle de movimento não altera as regras econômicas. O relógio civil pode usar hora atual ou um cenário fixo; partidas BC Ferries seguem esse relógio, independentemente da velocidade econômica.

- [Rede e encaminhamento terrestre](mobility-network-audit.md), [desenho e câmera](mobility-render-audit.md), [escolas, patrulhas e sinais](civic-motion-audit.md).
- [TransLink: fonte e correspondência](translink-audit.md), [movimento dos ônibus](transit-motion-audit.md). A cena principal recebe três variantes verificadas, 019 nas duas direções e 023 numa direção, e recalcula sua correspondência à rede carregada. Outras variantes permanecem rejeitadas/ausentes. Identidade, frequência e posição dos ônibus são simuladas. O subset de 86.828 bytes preserva a captura datada e a atribuição TransLink.
- [Fontes e corredores marítimos](maritime-source-audit.md), [atracação e movimento](maritime-motion-audit.md): SeaBus, Aquabus, carga, veleiros e três escalas de cruzeiro. Escalas de 3–4/10/2026 não têm ETA/ETD publicado; as janelas de dia inteiro são derivadas. Não há AIS, marés ou posicionamento real.
- [BC Ferries](bc-ferry-audit.md): 90 registros somente Horseshoe Bay–Bowen Island em 3–5/10/2026, com cancelamentos/extras publicados. Horários expirados não geram travessias. Não representa toda a rede BC Ferries e não fornece atrasos ao vivo.
- [YVR: pistas e operadores](airport-source-audit.md), [pouso/decolagem e ocupação](aviation-motion-audit.md). YVR fica em Richmond. Air Canada/WestJet e pistas reais; frequência, direção ativa e voo são simulados. Transições de cena por fade substituem taxiamento, pois não foi capturada uma rede de taxiways.

## Verificação final

Checks de integração concluídos: `npm run check` **920 testes passam, 5 ignorados** (122 arquivos) e `npm run build` passa, com os 10 avisos de lint pré-existentes. Provas desktop/390×844, comparação de produção e revisão independente estão abaixo.

**Desempenho, o mesmo instrumento nos dois lados.** A medição anterior em `performance-baseline.json` foi feita com várias páginas pesadas abertas ao mesmo tempo e registrou 76 ms de mediana em Downtown; esses números não são comparáveis e ficam no registro apenas como histórico. A comparação que vale foi refeita no mesmo navegador, mesmo viewport 1280×720, mesmas nove cenas, 15 s de aquecimento e três medições de 30 s por cena, medindo o intervalo real entre quadros (`requestAnimationFrame`), com uma única aba ativa por vez:

| Cena | Base p50 / p95 / quadros > 20 ms | Entrega p50 / p95 / quadros > 20 ms |
|---|---|---|
| Downtown | 16,7 / 66,6 / **27,8 %** | 16,7 / 16,8 / **0,2 %** |
| Corredor TransLink | 16,7 / 66,7 / **31,0 %** | 16,7 / 16,8 / **0,3 %** |
| Industrial | 16,7 / 50,1 / **27,2 %** | 16,7 / 16,8 / **0,4 %** |
| Via rápida regional | 16,7 / 50,0 / **25,5 %** | 16,7 / 16,8 / **0,7 %** |
| North Shore | 16,7 / 33,4 / **24,1 %** | 16,7 / 16,8 / **0,1 %** |
| False Creek | 16,7 / 50,0 / **28,4 %** | 16,7 / 16,8 / **0,1 %** |
| Canada Place | 16,7 / 16,8 / 0,1 % | 16,7 / 16,7 / **0,2 %** |
| BC Ferries | 16,7 / 16,8 / 0 % | 16,7 / 16,8 / **0,1 %** |
| YVR | 16,7 / 16,8 / 0 % | 16,7 / 16,8 / **0,1 %** |

A mediana fica no teto de 60 Hz nos dois lados; o que mudou é a cauda — a entrega não perde mais quadros nas cenas pesadas. Nenhuma cena piorou. As quatro cenas pesadas foram remedidas depois das duas correções de revisão; as cinco leves vêm da rodada anterior do mesmo código, e as correções só retiram trabalho por quadro, então aqueles números são limites superiores.

**Revisão independente.** Dois revisores frescos leram o conjunto. Achados corrigidos nesta entrega: (1) as capturas de Vancouver eram injetadas sempre que havia geografia, sem trava de cidade — ônibus, sinais, escolas e o painel de Vancouver apareciam em Lisboa; agora a mesma cobertura de 22 áreas locais que protege os fatos protege a mobilidade, e sair da cobertura desmonta as capturas (`syncMobilityCity`); (2) essa desmontagem esvaziava a rede e nada a republicava com cache quente e câmera parada — o stream ganhou `republish()`; (3) a chegada das duas travessias extras de 3/10 estava marcada como `reported` quando é derivada do intervalo publicado de vinte minutos — o dado agora diz `derived`; (4) o capital aprovado aparecia sem fonte na linha do painel; (5) as listas de comando de mobilidade, embarcações e aeronaves eram construídas duas vezes por quadro animado — agora são construídas uma vez e compartilhadas pelo quadro.

Capturas desta verificação: `mobility-traffic-reentry.png` (tráfego presente depois de voltar a Vancouver, o caso que o achado 2 descrevia), `globe-navigation.png` e `road-edit-preview.png`.

A verificação móvel usa um documento real de 390×844 num iframe nativo, pois a API de viewport do navegador não alterou o tamanho efetivo; isso não verifica chrome de navegador móvel nem hardware de toque.

Limites: até 480 agentes terrestres, 24 embarcações e 8 aeronaves; culling por viewport e limites menores no zoom distante; até 40.000 triângulos de terreno. Posições de barcos/aviões fora da tela não devem obrigar redesenho da cena estática. O orçamento real entra na economia apenas pela calibração explícita do jogador, com razão visível **0,01 unidades/CAD**.
