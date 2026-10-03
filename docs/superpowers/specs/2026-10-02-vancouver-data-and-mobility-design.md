# Vancouver: dados oficiais e mobilidade dinâmica

## Intenção e aprovação

O usuário quer elevar dados e efeitos dinâmicos ao nível da evolução gráfica: carros, ônibus, caminhões e pessoas visíveis, população e orçamento reais, e trânsito relacionado à cidade observada. Vancouver foi escolhida como referência. O desenho híbrido apresentado no chat foi aprovado: movimento simulado contínuo, calibrado por fontes oficiais, com observações ao vivo quando houver acesso e cobertura.

A orientação posterior do usuário simplifica os ônibus: rotas reais com movimento simulado, sem sincronização obrigatória com horários ou posições reais. Este documento incorpora essa alteração. A aprovação no chat autorizou sua elaboração; implementação e plano ainda dependem das revisões previstas no fluxo de brainstorming. Não interpretar o documento anterior de vida urbana como autorização para alterar as regras econômicas deste trabalho.

## Escopo e sequência

A entrega compreende três módulos com interfaces separadas: fatos municipais, movimento urbano e calibração por observações. Implementar nessa ordem permite validar as fontes antes de usá-las no movimento. Todos fazem parte da mesma entrega Vancouver. Uma fonte sem acesso não deve bloquear os módulos independentes; sua integração deve permanecer explicitamente indisponível, nunca apresentada como concluída ou ao vivo.

Vancouver significa o município identificado por Wikidata Q24639. Dados da região metropolitana ou da rede regional TransLink precisam declarar seu território; somente trajetos dentro da área carregada são desenhados. Outras cidades continuam usando os adaptadores existentes e movimento estimado, sem herdar valores de Vancouver.

## Estado atual e pontos de integração

- `src/adapters/reality/wikidata.ts` e `ibge.ts` já consultam demografia; `src/browser/main.ts` conecta essas fontes ao cliente.
- `src/adapters/reality/city.ts` e `src/client/facts.ts` repetem o contrato de fatos. Centralizar o contrato compartilhado ao acrescentar finanças e proveniência por campo.
- `src/presentation/street-life.ts` escolhe até um elemento por célula a partir de coordenadas e vizinhos. Não mantém trajetos, filas ou identidade entre células.
- Existem renderizadores Canvas geográfico e de células. Integrar o movimento à geometria realmente exibida e validar ambos; não presumir que uma alteração no renderizador de células alcança o mapa geográfico.
- `src/adapters/reality/gtfs.ts` já importa paradas, rotas, viagens e calendários. Declara corretamente que não calcula roteamento nem inclui tempo real. Estender esse importador para shapes e referências das viagens, em vez de criar um leitor concorrente.
- `src/world/observations.ts` e `src/world/reality.ts` oferecem contratos de observações e proveniência; reutilizá-los para capturas persistentes.
- `src/core/simulation.ts` contém uma economia determinística. Nenhum acesso de rede ou relógio externo deve entrar nesse núcleo.

## Fontes e contratos dos fatos

Cada medida registra valor, unidade/moeda, território, fonte URL/dataset, período observado, data de retirada e método (`reported`, `derived` ou `simulated`). Licença só é registrada quando declarada. População, área e cada medida financeira têm proveniência própria; uma fonte financeira não substitui o crédito do censo.

### População

Wikidata continua como diretório global e fonte solicitada pelo usuário. Para Vancouver, verificar o município e selecionar a declaração válida mais recente com ano, respeitando declarações depreciadas. O censo de 2021 de 662.248 habitantes é uma referência verificável publicada pela prefeitura, não uma afirmação sobre população atual de 2026. Uma estimativa posterior deve ser identificada como estimativa e carregar seu ano. Consulta por nome deve evitar Vancouver de outro país; resolução geográfica não confunde Burnaby, Richmond ou Surrey com Vancouver.

### Finanças

Importar medidas do orçamento final aprovado de 2026 publicado pela prefeitura: operação e investimentos anuais, separadamente. Cada medida distingue orçamento aprovado, valor realizado e plano plurianual; não somar esses conceitos. Não usar o PIB como orçamento e não converter automaticamente orçamento anual em saldo disponível do jogador.

Um processo de atualização reproduzível produz uma captura versionada, com URL, página/tabela de origem, período, unidade original e valor normalizado em CAD. Valores de PDF exigem conferência contra a tabela oficial. O jogo lê essa captura; não tenta interpretar o PDF a cada frame. Dados estruturados oficiais podem substituir essa etapa quando sua equivalência for verificada. A captura é um dado real datado, não um feed ao vivo.

O painel apresenta as finanças reais e sua aplicação ao cenário. A calibração econômica é explícita: orçamento operacional anual por habitante, dividido por 12, fornece uma referência mensal; qualquer multiplicador necessário à escala do jogo é mostrado e versionado. Aplicar a calibração é uma ação explícita de início de cenário ou política, registrada no mundo. Não altera silenciosamente dinheiro, dívida ou taxas de saves existentes. A implementação define e testa essa ação e a versão de regras necessária antes de ativá-la; saves antigos mantêm sua política até a ação ser solicitada.

## Movimento urbano

### Rede e agentes

Construir uma rede de segmentos e conexões a partir das vias exibidas. No mapa geográfico, usar linhas e atributos disponíveis, incluindo sentido e classe quando declarados. No modo de células, usar adjacências reais das células de rua. Interseções dependem de conexão topológica; viadutos e cruzamentos em níveis diferentes não se conectam quando a fonte declara essa separação. Quando atributos faltarem, a regra inferida fica identificada como derivada.

Agentes têm identidade, tipo (`car`, `bus`, `truck`, `pedestrian`), trajeto, posição ao longo do segmento, sentido e velocidade. O motor de movimento é separado do desenho Canvas. Faz curvas e atravessa limites de células sem desaparecer e reaparecer a cada trecho. Rede se reconstrói somente quando geometria ou edição muda.

Carros ocupam faixas coerentes com condução pela direita. Caminhões recebem proporção maior nas vias rápidas e acessos industriais; essa distribuição é estimada quando não houver classificação observada. Pedestres usam calçadas ou caminhos e travessias conectadas, excluindo rodovias. Animação de passos e silhuetas distintas tornam cada tipo reconhecível no zoom de rua.

Filas limitam a distância entre veículos na mesma faixa. Controle de interseção impede passagens conflitantes dentro do modelo. Sem tempos oficiais de semáforos, usar ciclos simulados declarados como tais. Entradas e saídas acontecem nos limites da rede carregada; nenhum agente atravessa água ou ligação inexistente. Trechos sem saída permitem retorno somente quando houver uma conexão representável; caso contrário, a geração não escolhe esse trajeto.

O relógio de movimento respeita pausa e velocidades do jogo. Integração usa passos limitados; retomar uma aba não produz saltos gigantes. Alterações do jogador invalidam trajetos afetados; agentes replanejam ou saem de forma controlada. Posições transitórias não são gravadas por frame no histórico nem transmitidas como comandos.

### Polícia, semáforos e ônibus escolares

O usuário explicitou três requisitos adicionais: carros de polícia circulando, semáforos visíveis e ônibus escolares. São parte da entrega de mobilidade, com a mesma continuidade, pausa, aceleração e limites de desempenho dos demais agentes.

Viaturas têm pintura estilizada, identificação legível e barra de luzes, percorrem trajetos de patrulha simulados e respeitam filas e sinais. A barra não pisca permanentemente durante patrulha. Ocorrências, perseguições, sirene sonora e atendimento emergencial não são exigidos; não insinuar posições ou rotas reais de patrulha.

Semáforos são objetos visíveis nos cruzamentos, com vermelho, amarelo e verde ligados ao mesmo controlador que autoriza passagem dos veículos. O desenho não usa um relógio diferente do motor. Onde for possível associar o cadastro municipal de sinais à rede, preservar localização e fonte. Sinais gerados em cruzamentos sem cadastro são identificados como derivados. Não colocar semáforos em toda curva ou passagem em níveis separados. Pedestres atravessam somente na fase compatível do modelo, sem conflito com movimentos veiculares liberados.

Ônibus escolares são amarelos, com silhueta e identificação diferentes do ônibus urbano. Destinos são escolas reais verificadas no diretório do Vancouver School Board ou outra fonte oficial local, mantendo o território correto (não Vancouver, Washington). Percursos até a escola são calculados na rede e explicitamente simulados; não alegar que existe transporte escolar em toda escola nem que o trajeto é uma rota oficial publicada. Não usar endereços residenciais de alunos nem dados pessoais. Circulação ganha destaque nas janelas simuladas de entrada/saída escolar, com paradas de embarque/desembarque e veículos aguardando atrás da parada no modelo. Fora dessas janelas, reduzir circulação, sem transformar frota escolar em ônibus urbano permanente.

Aceitação adicional: reconhecer viatura, ônibus urbano e escolar visualmente; sinal verde/amarelo/vermelho coerente com autorização de passagem, filas diante do vermelho, travessias sem conflito; ônibus escolar conectado a escola verificada e rótulo de percurso simulado; todos congelam na pausa. Esta entrega não promete reprodução integral de regras legais de trânsito.

Fontes de referência: https://vancouver.opendatasoft.com/explore/dataset/traffic-signals/table/ e https://vsb.bc.ca/school-directory-and-map . Verificar exportação/coordenadas na implementação; a existência do catálogo não prova matching concluído.

### Ônibus TransLink

O requisito é que os ônibus façam as rotas reais da TransLink. Sua posição, frequência, velocidade e duração das paradas são simuladas pelo relógio do jogo; sincronização com horários ou posições reais não faz parte desta entrega. Pausa e aceleração funcionam para ônibus como para os demais agentes.

GTFS estático fornece rotas, paradas e variantes de percurso. Ler `shapes.txt` e `shape_id` das viagens para preservar direção e variante; uma sequência de paradas sozinha não autoriza inventar uma linha reta através de quarteirões. Sem shape utilizável, obter um caminho na rede carregada e marcá-lo como derivado; se não houver conexão, não desenhar esse percurso como rota real.

Desenhar ônibus em percursos distintos, nas duas direções quando fornecidas, com paradas reais e tempo de parada simulado. Frequência simulada é limitada pela capacidade visual, sem alegar correspondência à oferta real. Mostrar “Rotas TransLink · movimento simulado”, com data e fonte do feed. Calendários e horários permanecem preservados pelo importador existente, sem determinar a animação nesta entrega.

GTFS Realtime e chaves de API não são necessários. Integração de posições ao vivo fica fora do escopo atual.

## Aviação: aeroportos reais e operações simuladas

O usuário acrescentou aviões de companhias aéreas decolando e pousando. A referência inicial é Vancouver International Airport (YVR/CYVR), com cobertura regional declarada, sem misturar o aeroporto com os fatos financeiros do município de Vancouver.

OurAirports fornece localização, identificadores e extremos de pistas em arquivos públicos; é fonte comunitária, não autoridade aeronáutica. Conferir as pistas do CYVR contra informações publicadas pelo YVR. A lista oficial de companhias do YVR fornece identidade dos operadores; uma companhia listada não determina aeronave, frequência ou voo atual. Capturas preservam fonte, data e termos por conjunto.

Aeronaves distinguíveis têm asas, fuselagem, cauda, porte e esquema de cores associado à companhia confirmada. Começar com Air Canada, WestJet e outras companhias validadas no diretório oficial. Pinturas são representações estilizadas, sem alegar reprodução exata da frota. Nome/código aparecem na inspeção. Jatos comerciais usam pistas terrestres; operadores exclusivamente de hidroaviões/helicópteros não geram jatos por aparecerem na mesma lista.

O movimento simulado percorre aproximação, alinhamento, descida, toque e desaceleração; decolagem percorre espera, alinhamento, aceleração e subida. Trajetos terminam ou começam nos extremos reais das pistas, com altitude e sombra coerentes. Taxiar só quando houver geometria conectada de taxiways utilizável; ausência de taxiways não autoriza atravessar terminal ou quarteirões. Não exigir gates ou pushback nesta entrega.

Cada pista física, incluindo seus dois sentidos e pistas que a cruzam, tem reserva de ocupação no simulador para impedir operações conflitantes. Escolha de sentido e curvas de aproximação são estimadas, não procedimentos oficiais de navegação. Não afirmar pista ativa, frequência real, modelo operado ou posição ao vivo sem dados específicos. Não integrar rastreamento de voos nesta entrega.

Aviação compartilha o relógio e orçamento de desempenho da mobilidade, mas mantém motor próprio em coordenadas geográficas e altitude. Respeita pausa e aceleração; mudança de zoom não reinicia o voo. Renderizar somente aeroporto/voos no envelope visível com margem, com teto de agentes; decolagem, pouso, redução de detalhe e inspeção devem continuar legíveis. Mostrar “Aeroporto e pistas reais · operações simuladas”.

Aceitação adicional: captura CYVR conferida, companhias associadas a fontes, trajetórias alinhadas às pistas, continuidade no toque/subida, reserva de pistas cruzadas, ausência de taxiway tratada sem percurso fictício, pausa/zoom/câmera e cenas diurna/noturna. Inspecionar produção em YVR com pelo menos uma decolagem e um pouso completos.

## Relação com trânsito real

As contagens municipais calibram volumes por local, direção, categoria e período onde esses campos existirem. Contagem horária não é velocidade nem congestionamento instantâneo. Associação espacial tem distância máxima documentada e compatibilidade de sentido/classe; ponto sem correspondência fica sem uso e aparece no resumo da importação.

Na ausência de observação, demanda estimada depende da classe da via, ocupação próxima e hora do cenário, com limites de densidade. Não apresentar um número de carros desenhados como contagem oficial: os agentes são uma amostra visual cuja escala aparece no painel.

Uma porta independente permite futura fonte de velocidade/congestionamento ao vivo. Somente ativar um fornecedor após confirmar cobertura, acesso, formato e condições. Não é requisito contratar serviço para concluir o modo calibrado por contagens. Distinguir na interface: `estimado`, `calibrado por contagens — período`, e `ao vivo — observado às`. Uma captura histórica pode ser reproduzida, mas deixa de ser rotulada ao vivo.

## Falhas, persistência e interface

Adaptadores têm timeout, cancelamento, validação, cache limitado e tentativas com intervalo. Uma falha conserva o último resultado válido para o mesmo território e mostra sua idade; dado ausente permanece ausente. Trocar de cidade nunca mantém valores antigos sob o nome novo. Respostas atrasadas não substituem a consulta mais recente.

Capturas oficiais e parâmetros de cenário podem ser registrados pelos contratos existentes de observação/componentes. Rede em memória, buffers de desenho e posição de cada agente são transitórios. Reprodução determinística depende de sementes, relógio e capturas registradas; sessão ao vivo não promete posições idênticas entre clientes.

Painel compacto de Vancouver mostra população/ano, finanças/moeda/exercício, modo de mobilidade, data/hora de cenário e fontes clicáveis. Controles permitem ligar movimento e escolher estimado, calibrado e ao vivo somente quando disponível. Fonte ao vivo indisponível explica o requisito de acesso e mantém as outras opções utilizáveis. No zoom distante, reduzir detalhe e quantidade de agentes; no zoom próximo, preservar legibilidade e continuidade.

## Validação e aceitação

1. Valores de população e finanças conferidos com fontes oficiais; referências de página/tabela e normalização de unidades revisáveis. Nenhum placeholder financeiro nem número inventado.
2. Testes de município/QID, ranking e anos Wikidata, proveniência por campo, orçamento anual versus plano plurianual, ausência e respostas atrasadas.
3. Testes de trajetos conectados, curvas, condução pela direita, distância mínima em filas, conflitos em cruzamentos, exclusão de pedestres das rodovias e invalidação por edição.
4. Testes GTFS com shapes, variantes e direções; paradas reais, percurso conectado, deduplicação por rota/variante e movimento de ônibus respeitando pausa e aceleração do jogo.
5. Testes de calibração: contagem não vira velocidade; período e direção preservados; observação distante ou sem correspondência não afeta o trecho.
6. Economia reproduzível sem rede no núcleo; ação de calibração explícita e saves antigos preservados. Testes das regras e migrações realmente necessárias.
7. Verificação visual em Downtown Vancouver, corredor de ônibus, área industrial e via rápida da região, com cobertura geográfica declarada. Carros, ônibus, caminhões e pessoas distinguíveis; curvas, paradas, filas, pausa e zoom documentados em imagens ou gravação.
8. Comparar desempenho com a versão anterior nas mesmas cenas desktop e celular. Limitar agentes à região visível com margem, evitar alocações por frame e registrar quantidade de agentes e tempo de frame. Regressão superior a 20% na mediana exige ajuste antes de concluir; registrar ambiente e limitações da comparação.
9. Executar verificações do projeto apropriadas à alteração, build e revisão visual. Nenhuma alegação de integração ao vivo testada sem observações reais recebidas.

## Referências verificadas durante o desenho

- Município e censo: https://vancouver.ca/news-calendar/our-city.aspx
- Orçamento aprovado: https://vancouver.ca/your-government/annual-budget.aspx
- Documento final: https://vancouver.ca/files/cov/2026-budget.pdf (extração/conferência das tabelas pertence à implementação; não foi concluída nesta revisão).
- Contagens municipais e acesso VanMap: https://vancouver.ca/streets-transportation/traffic-count-data.aspx
- TransLink GTFS estático para rotas e paradas: https://www.translink.ca/about-us/doing-business-with-translink/app-developer-resources/gtfs/gtfs-data

## Próxima etapa

Após revisão deste documento, elaborar o plano de implementação com tarefas, arquivos, contratos de teste e checkpoints visuais. O plano deve resolver a disponibilidade concreta dos arquivos de contagem e GTFS antes de prometer sua ingestão automática e apresentar o método de execução para escolha do usuário.


## Navegação marítima solicitada: porto, cruzeiros e transporte de passageiros

Incluir cargueiros, navios de cruzeiro que atracam no Canada Place, veleiros, SeaBus e Aquabus. Todos precisam de silhuetas, dimensões e velocidades distinguíveis; não representar uma balsa como ônibus sobre a água. Movimento respeita pausa e relógio compartilhado, com estado transitório separado do histórico de comandos.

SeaBus liga Waterfront a Lonsdale Quay; referência oficial: https://www.translink.ca/schedules-and-maps/seabus . Capturar terminais e percurso confirmado, verificando a presença no GTFS TransLink em vez de presumir que o parser atual já cobre ferries. Aquabus opera em False Creek; capturar docas e conexões publicadas pelo operador https://theaquabus.com/ . Não misturar sua identidade com False Creek Ferries. Paradas, espera, embarque e saída compõem o ciclo visual; horários locais podem ser simulados, com rótulo explícito.

Cruzeiros usam Canada Place e calendário publicado pelo Port of Vancouver, preservando temporada/ano, navio, companhia e berço quando disponível. Calendário é programação prevista, não posição atual. Conferir a temporada vigente antes de capturar: o resultado oficial encontrado em https://www.portvancouver.com/media/documents/cruise-schedule refere-se a 2025 e não deve ser promovido a 2026. Navios chegam pelo corredor aquático, reduzem velocidade, atracam, permanecem e partem; o modelo evita sobrepor navios no mesmo berço.

Cargueiros usam terminais e áreas de fundeio verificados no porto, com categorias como contêineres e graneleiros; não atracam no terminal de cruzeiro. Fonte de contexto e restrições: https://www.portvancouver.com/media/documents/port-information-guide-0 . Trajetos gerados sem rota oficial são estimativas visuais, não carta náutica ou procedimento de navegação. Veleiros partem de marinas confirmadas e têm passeios simulados em água navegável.

Construir rede aquática própria com costa, ilhas, pontes, docas e canais. Validar continuidade do trajeto, obstáculos e acesso ao berço; água no mapa sozinha não demonstra profundidade adequada para um cargueiro. Onde faltam dados de calado/altura sob ponte, restringir navios grandes a corredores previamente verificados. Evitar atalhos através de Stanley Park e da península de Downtown. Priorizar rotas de passageiros verificadas e áreas portuárias conhecidas.

AIS ao vivo é uma extensão opcional: não foi validado um feed público com CORS, cobertura, licença e acesso sem segredo para este site. Base estática capturada e navegação simulada atendem à primeira entrega sem backend. Fonte e data de captura aparecem na inspeção; não usar “ao vivo” para trajetos ou chegadas simuladas.

Aceitação: SeaBus reconhecível entre os terminais reais; Aquabus servindo docas confirmadas de False Creek; cruzeiro atracando e saindo do Canada Place; cargueiro junto a terminal apropriado; veleiros distinguíveis; nenhum trajeto cruzando terra ou berço ocupado; pausa/velocidade coerentes, detalhe por zoom e limite combinado de agentes terrestres, aéreos e marítimos.
