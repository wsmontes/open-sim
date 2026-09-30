# Open Sim — primeira versão

Status: proposta para revisão; implementação ainda não iniciada.

## Intenção

Um jogo fofo de construir e reformar cidades, inspirado na simplicidade e na perspectiva isométrica de SimCity 2000. O mundo parte da geografia e das cidades existentes no OpenStreetMap. O jogador transforma bairros, expande cidades ou funda uma cidade em um espaço vazio do mesmo mundo.

Requisitos expressos pelo usuário: mapas reais atuais, cidades existentes conforme os dados disponíveis, construção sobre esse mundo, visual dos anos 90, jogo simples e terreno contínuo. Escolhas propostas para o primeiro protótipo: navegador no computador, mouse e teclado, terreno plano, partida individual e salvamento local.

## Experiência

Ao abrir, o jogador escolhe um dos lugares iniciais ou informa latitude e longitude. A cidade aparece pronta: ruas, construções, água e vegetação disponíveis na fonte. A interface mostra o lugar e oferece ferramentas para explorar, construir e demolir.

Não há modos separados de reforma e construção do zero. As mesmas ferramentas funcionam no centro de uma cidade e em áreas vazias. O jogador pode apagar uma construção, substituir por um parque, abrir uma rua ou marcar uma área residencial, comercial ou industrial.

O ciclo é curto: construir uma rua, oferecer energia, marcar terrenos, ver construções crescerem e receber receita para continuar. Casas surgem em lotes livres que tenham acesso a rua e energia. Parques melhoram a felicidade nas proximidades. A cidade cresce por regras agregadas, sem simular cada morador.

## Aparência e controles

- Perspectiva isométrica fixa, com zoom e deslocamento livre da câmera.
- Arte própria de baixa resolução: fachadas claras, telhados coloridos, sombras simples, água azul e árvores arredondadas.
- Uma barra de ferramentas: explorar, rua, residencial, comércio, indústria, energia, parque e demolir.
- Indicadores de dinheiro, população, energia e felicidade; pausa e duas velocidades.
- Prévia da construção e do custo antes do clique. Água, terrenos ocupados e áreas ainda não carregadas bloqueiam construções incompatíveis.
- Ruas podem ser desenhadas arrastando; o custo corresponde às novas células válidas, sem cobrar novamente por uma rua existente.
- O jogo informa se está carregando o mapa, sem conexão ou com falha ao salvar.

## O que vem do mundo real

Usar geometria vetorial derivada do OpenStreetMap para ruas, contornos de edifícios, rios, lagos, costa e áreas verdes. Converter esses dados para uma grade geográfica comum, preservando o desenho reconhecível das cidades na resolução do jogo. Aplicar a aparência isométrica sobre essa grade.

Edifícios mapeados aparecem desde o início. A arte é estilizada: não há promessa de reproduzir fachadas, altura ou uso exatos. Quando o fornecedor não trouxer o uso de uma construção, o jogo adota uma classificação simples e determinística, apresentada como simulação. População, felicidade e dinheiro são valores do jogo, não estatísticas reais.

A proposta usa tiles vetoriais Shortbread como fonte inicial, com fornecedor e versão configuráveis. O esquema documenta ruas, água, uso do solo e edifícios; a camada básica de edifícios não oferece todos os atributos urbanos do OSM. Por isso o adaptador usa apenas os atributos realmente presentes, sem presumir altura, moradores ou endereço.

Novas regiões usam os dados disponíveis no momento do carregamento, respeitando o cache do fornecedor. Atualizações externas não sobrescrevem células já modificadas pelo jogador. A interface explica que a base cartográfica pode ter diferenças de cobertura e atualização.

## Mundo contínuo e persistência

O mundo é dividido em trechos com coordenadas estáveis. O carregamento acompanha a área visível; trechos distantes saem da memória. Mudar o zoom altera o desenho, não a grade nem as posições das construções. Nas bordas dos trechos, a mesma célula tem uma única identidade, evitando prédios e ruas duplicados.

“Infinito” significa explorar e construir sem uma borda artificial para a cidade. A primeira versão respeita a cobertura da projeção cartográfica; não promete um planeta literalmente infinito nem cobertura dos polos. A longitude dá a volta ao mundo.

A edição fica em uma camada própria, identificada por coordenadas: construções novas, alterações e remoções explícitas. Essa camada prevalece sobre a base; um prédio demolido não reaparece ao sair e voltar. O jogo nunca envia essas mudanças ao OpenStreetMap.

O trecho inicial já entra na economia da partida. Outras áreas entram quando o jogador faz sua primeira intervenção nelas. Apenas visitar outra cidade não concede dinheiro nem população. Trechos administrados mantêm resumos de população, receita e manutenção, independentemente da posição da câmera. Não há simulação do planeta inteiro nem crescimento durante o tempo com o aplicativo fechado.

Construções importadas começam ocupadas e com atendimento básico de energia suficiente para a ocupação original, calculado pelo jogo. O jogador fornece capacidade adicional para o crescimento. A importação não cobra compra retroativa das construções existentes. Receita e manutenção iniciais são equilibradas para permitir começar reformando uma cidade sem falência imediata.

Salvar automaticamente a câmera, o relógio da partida, o saldo, as células modificadas e os resumos dos trechos administrados em IndexedDB, com versão de formato. Exibir estado de salvamento; se o armazenamento falhar, manter a sessão aberta e informar que o progresso ainda não foi salvo.

## Estrutura técnica proposta

Aplicação pequena em TypeScript, Vite e Canvas 2D. Interface em HTML/CSS. O desenho em Canvas usa resolução interna reduzida e ampliação sem suavização. O motor não depende de um framework de interface.

Separar seis responsabilidades: leitura e cache de mapas; transformação para células; câmera e desenho; ferramentas de edição; simulação econômica; salvamento. O carregamento assíncrono nunca deve bloquear a interação com trechos já disponíveis.

Fluxo: fonte vetorial → células geográficas → sobreposição das mudanças salvas → desenho e simulação. O simulador recebe o estado do jogo, sem depender da rede ou do Canvas, permitindo verificar as regras isoladamente.

A versão do esquema e o TileJSON serão confirmados na implementação. Usar requisições apenas para a região vista, com concorrência limitada e cache conforme os cabeçalhos HTTP. Respeitar a atribuição visível e permitir trocar o fornecedor. Não incluir download em massa do mapa. Se a fonte falhar, manter regiões disponíveis, mostrar a área pendente e permitir tentar novamente; não substituir silenciosamente por terreno inventado.

## Limite da primeira versão

Entregar uma partida jogável que prove o diferencial: reconhecer uma cidade real, reformá-la, avançar para uma região vazia, construir e reencontrar as alterações depois de recarregar.

Ficam para depois: relevo real, redes de água, trânsito com rotas individuais, desastres, multiplayer, contas, busca mundial por nome e fachadas específicas de cada prédio. A entrada por coordenadas permite experimentar lugares além dos atalhos iniciais. A ausência de relevo é uma simplificação visual do protótipo; OpenStreetMap não é uma base geral de elevação.

## Verificação de aceitação

1. Comparar uma região urbana e uma região com água com a fonte: ruas e ocupação devem ser reconhecíveis, dentro da resolução adotada.
2. Demolir uma construção importada, criar um parque e construir em área vazia. Sair, voltar e recarregar a página; as mudanças devem persistir.
3. Cruzar bordas de trechos e mudar o zoom sem deslocar, duplicar ou ressuscitar construções.
4. Verificar crescimento com acesso a rua e energia, cobrança de construção, manutenção e receita. Visitar regiões novas não deve alterar a economia.
5. Simular falha de rede e armazenamento: erro visível, sessão preservada e nenhuma área indisponível tratada como terreno livre.
6. Inspecionar no navegador os controles, a legibilidade, a atribuição e a fluidez de navegação em uma área urbana densa.

## Referências consultadas

- [Esquema Shortbread 1.1](https://shortbread-tiles.org/schema/1.1/): camadas e atributos disponíveis.
- [Política de tiles vetoriais da OSM Foundation](https://operations.osmfoundation.org/policies/vector/): uso interativo, cache, atribuição e limites de distribuição.
- [Elevação no OpenStreetMap](https://wiki.openstreetmap.org/wiki/Key%3Aele): limites da informação de altitude.
