# Open Sim — primeira versão

Status: escopo aprovado pelo usuário; incorporada a exigência de independência de plataforma e preparação para Nostr. Implementação ainda não iniciada.

## Intenção

Um jogo fofo de construir e reformar cidades, inspirado na simplicidade e na perspectiva isométrica de SimCity 2000. O mundo parte da geografia e das cidades existentes no OpenStreetMap. O jogador transforma bairros, expande cidades ou funda uma cidade em um espaço vazio do mesmo mundo.

Requisitos expressos pelo usuário: mapas reais atuais, cidades existentes conforme os dados disponíveis, construção sobre esse mundo, visual dos anos 90, jogo simples e terreno contínuo. O projeto deve permitir clientes para navegador e aplicativo desktop, com integração futura ao Nostr para contatos e partidas em rede. Escolhas para o primeiro protótipo: cliente de referência no navegador, mouse e teclado, terreno plano, partida individual e salvamento local. Empacotamento desktop e multiplayer são etapas posteriores; a portabilidade do núcleo deve ser demonstrada já no protótipo.

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

Salvar automaticamente a câmera, o relógio da partida, o saldo, as células modificadas e os resumos dos trechos administrados por uma interface de armazenamento, com versão de formato. IndexedDB é o primeiro adaptador, específico do navegador. Exibir estado de salvamento; se o armazenamento falhar, manter a sessão aberta e informar que o progresso ainda não foi salvo.

Ao incorporar um trecho à economia, congelar e salvar sua base normalizada junto com as mudanças. O estado administrado não depende de novas respostas do provedor para ser reconstruído. Áreas apenas visitadas continuam sob o cache normal do mapa. Isso evita que atualizações cartográficas mudem uma partida salva ou, no futuro, façam dois jogadores simularem bases diferentes.

## Arquitetura independente de plataforma

As regras e os formatos de dados são independentes da tecnologia de apresentação. A implementação de referência usa TypeScript para compartilhar o mesmo núcleo entre runtimes JavaScript. Isso não torna o código independente de linguagem: um cliente em outra linguagem pode implementar os mesmos contratos versionados. Não haverá acoplamento do domínio a browser, Electron, Tauri ou Nostr.

- **Núcleo:** coordenadas, células, construções, custos, população, energia e regras de evolução. Funções puras recebem estado e comandos e devolvem novo estado e resultado. Não acessa DOM, Canvas, rede, disco, relógio do sistema nem APIs de runtime.
- **Sessão:** coordena comandos, aquisição de trechos e salvamento. No protótipo, uma sessão local valida e ordena todas as ações. Identificadores de comandos e revisões permitem reconhecer reenvios sem cobrar ou construir duas vezes.
- **Adaptadores:** mapa real, armazenamento e apresentação implementam contratos pequenos. O primeiro cliente conecta HTTP, IndexedDB, HTML/CSS e Canvas 2D; um host desktop poderá reutilizar essa interface ou oferecer outra.

Dependências apontam para dentro: os adaptadores conhecem os contratos da sessão e do núcleo; o núcleo não importa adaptadores. Evitar contêiner de injeção, barramento genérico de plugins e microserviços. Interfaces e composição explícita bastam.

Fluxo: mapa normalizado → sessão → comando validado → núcleo → estado → renderização e salvamento. A câmera nunca determina os resultados da economia. Carregar um mapa não avança o relógio do jogo. Pedidos assíncronos antigos não podem substituir o destino atual da câmera.

O núcleo usa ticks inteiros, valores econômicos inteiros, ordenação estável e variação visual derivada das coordenadas e da semente. Não usa `Date.now()` ou `Math.random()` para decisões do jogo. Mesmo estado inicial, mesma versão de regras e mesmos comandos ordenados devem produzir o mesmo resultado.

Comandos e snapshots usam objetos serializáveis em JSON e versões explícitas. O núcleo recebe comandos de domínio como construir e demolir, sem envelopes, assinaturas, chaves ou tipos do Nostr. O relógio da interface solicita ticks à sessão; renderizar mais quadros não acelera a simulação. Câmera e preferências ficam em estado local da apresentação, fora do estado compartilhável da cidade.

O primeiro cliente usa Vite como ferramenta de desenvolvimento e Canvas 2D como adaptador visual, com resolução interna reduzida e ampliação sem suavização. A portabilidade será verificada executando o mesmo cenário no navegador e em Node, com estados finais equivalentes. O empacotamento desktop futuro poderá envolver esse cliente sem reescrever as regras; escolher Electron ou Tauri não é uma decisão do domínio.

A versão do esquema e o TileJSON serão confirmados na implementação. Usar requisições apenas para a região vista, com concorrência limitada e cache conforme os cabeçalhos HTTP. Respeitar a atribuição visível e permitir trocar o fornecedor. Não incluir download em massa do mapa. Se a fonte falhar, manter regiões disponíveis, mostrar a área pendente e permitir tentar novamente; não substituir silenciosamente por terreno inventado.

## Nostr e jogo em rede: evolução prevista

Nostr poderá fornecer identidade por chave pública, descoberta de contatos e transporte de eventos assinados através de relays. A NIP-02 descreve listas de pessoas seguidas; seguir alguém não concede permissão para editar sua cidade. Convites e permissões da partida serão regras próprias da aplicação.

Relays recebem e distribuem eventos; não substituem o responsável por validar ações, ordenar comandos e resolver disputas sobre o mesmo terreno. A proposta inicial para uma futura partida cooperativa é um anfitrião com autoridade sobre a sessão: participantes propõem ações, o anfitrião valida e publica resultados com sequência crescente. Réplicas verificam o anfitrião autorizado, a sessão e a sequência. Não usar horários de eventos como consenso.

O protocolo futuro precisará tratar reenvios, ações simultâneas, lacunas de sequência, reconexão e recuperação por snapshot. Snapshots identificarão versão das regras, base geográfica congelada e revisão da partida. Se o anfitrião ficar indisponível, novas alterações compartilhadas aguardam sua volta; migração de anfitrião e colaboração offline simultânea não fazem parte dessa primeira proposta.

Neste protótipo, implementar apenas comandos serializáveis, snapshots versionados e a sessão local. Não abrir conexões Nostr, solicitar chaves, publicar eventos, definir kinds experimentais ou construir uma infraestrutura multiplayer antecipadamente. Na etapa de rede, um adaptador converte eventos Nostr para os contratos existentes, com verificação de assinaturas, permissões e formato na entrada.

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
7. Executar o mesmo cenário com a mesma base, semente e comandos no navegador e em Node; obter estado final equivalente, sem importar APIs de plataforma no núcleo.
8. Reenviar um comando, fornecer revisão antiga e restaurar um snapshot inválido: não duplicar custos, não sobrescrever estado recente e preservar a última partida válida.

## Referências consultadas

- [Esquema Shortbread 1.1](https://shortbread-tiles.org/schema/1.1/): camadas e atributos disponíveis.
- [Política de tiles vetoriais da OSM Foundation](https://operations.osmfoundation.org/policies/vector/): uso interativo, cache, atribuição e limites de distribuição.
- [Elevação no OpenStreetMap](https://wiki.openstreetmap.org/wiki/Key%3Aele): limites da informação de altitude.
- [Nostr NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md): eventos assinados e comunicação entre clientes e relays.
- [Nostr NIP-02](https://github.com/nostr-protocol/nips/blob/master/02.md): listas de pessoas seguidas.
