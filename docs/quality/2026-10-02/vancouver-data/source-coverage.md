# Cobertura de fontes: mundo, Canadá, BC e operadores locais

Pesquisa em 2026-10-02. Este catálogo orienta integrações; não declara todos os adaptadores implementados. “Global” descreve o alcance da fonte, não garantia de campos completos em toda cidade. “Sem backend” permite captura prévia distribuída no site; consulta direta exige CORS, termos, tamanho e limites verificados por endpoint.

## Base mundial reutilizável

| Fonte | Dados úteis | Cobertura efetiva e limite | Acesso no projeto |
|---|---|---|---|
| [OpenStreetMap](https://www.openstreetmap.org/about) | Ruas, edifícios, costa, água, infraestrutura e POIs | Mundial, com completude variável; escolas, marinas, sinais, terminais e limites dependem do mapeamento. Não fornece movimento ao vivo nem calado garantido | Capturas/tiles por região; respeitar ODbL, atribuição e política de cada serviço. Não confundir base aberta com API pública ilimitada |
| [Wikidata](https://www.wikidata.org/wiki/Wikidata:Introduction/simple) | Identidade QID, país, ligações a fontes e população datada | Mundial, cobertura e atualização variáveis; fonte secundária. Município, aglomeração e área metropolitana são entidades distintas | EntityData testado com CORS; cache e fallback. Preferir estatística oficial compatível quando disponível |
| [Open-Meteo](https://open-meteo.com/en/docs) | Clima modelado por coordenadas, vento, chuva, nascer/pôr do sol | Modelos globais com resolução variável; não equivale a sensor em cada rua | Forecast testado com CORS em Vancouver; termos e limites por produto/uso |
| [OurAirports](https://ourairports.com/data/) | Aeroportos e pistas | Mundial comunitário; um município pode não ter aeroporto. Não fornece voos atuais | CSV de pistas testado com CORS; capturar por região e conferir operações contra aeroporto oficial |
| [Mobility Database](https://beta.mobilitydatabase.org/faq) | Descoberta de feeds GTFS, GTFS-RT e GBFS | Catálogo mundial de operadores participantes; não garante feed para qualquer cidade | Descoberta, depois validar feed original, licença, área, vigência, chave e CORS |

GTFS/GBFS são padrões, não fontes universais. OSM e Wikidata também não são fontes universais de orçamento municipal. PIB e dados nacionais não substituem receita/despesa de uma cidade.

## Camada Canadá

| Fonte | Dados úteis | Cobertura efetiva e limite | Acesso no projeto |
|---|---|---|---|
| [Statistics Canada — Census Profile](https://www150.statcan.gc.ca/n1/en/catalogue/98-401-X) | População, idade, domicílios, renda, emprego e deslocamento ao trabalho | Cobertura nacional em subdivisões censitárias e outras geografias; variáveis podem ter supressão, arredondamento, amostragem ou enumeração incompleta. Subdivisão censitária inclui equivalentes municipais | CSV/SDMX documentados; captura estática recomendada. CORS não verificado |
| [Statistics Canada — WDS](https://www.statcan.gc.ca/en/developers/wds/user-guide) | Séries econômicas e sociais e metadados | Nacional como fornecedor; cada tabela tem territórios próprios. Uma série de província/CMA não é automaticamente municipal | Selecionar tabela e coordenadas, preservar unidade/período; CORS não verificado |
| [Statistics Canada — limites CSD](https://geo.statcan.gc.ca/geo_wa/rest/services/2025/lcsd000a25s_e/MapServer) | Polígonos e códigos de municípios/equivalentes | Canadá; versão de limites precisa ser compatível com ano estatístico | Captura geográfica; API/CORS ainda não verificados |
| [ECCC — GeoMet](https://github.com/ECCC-MSC/Wateroffice/blob/master/docs/msc-geomet-wfs3-api-howto-en.md) | Fonte oficial de observações meteorológicas/hidrométricas conforme coleção | Canadá; estações e coleções têm cobertura própria, não sensor para toda cidade | Candidata; selecionar coleção, verificar API/CORS/licença antes de adoção |

Orçamentos aprovados, fases de semáforos, posições de viaturas, ônibus escolares, trânsito urbano e AIS não têm nesta pesquisa uma fonte nacional aberta comprovada que resolva todas as cidades. Buscar fornecedor municipal/operador e manter ausência explícita.

## Camada British Columbia

| Fonte | Dados úteis | Cobertura efetiva e limite | Acesso no projeto |
|---|---|---|---|
| [BC Stats — estimativas populacionais](https://www2.gov.bc.ca/gov/content/data/statistics/people-population-community/population/population-estimates) e [catálogo](https://open.canada.ca/data/en/dataset/86839277-986a-4a29-9f70-fa9b1166f6cb) | Estimativas/projeções por município/CSD, distrito regional e outras áreas; idade/sexo conforme arquivo | BC, condicionado às geografias e variáveis publicadas. Separar estimativa de projeção e de censo; não aplicar total regional ao município | CSV municipal disponível no catálogo; parsing, período e CORS ainda não verificados |
| [Estatísticas financeiras municipais de BC](https://www2.gov.bc.ca/gov/content/governments/local-governments/facts-framework/statistics/statistics) | Finanças, tributação e estatísticas gerais municipais | Municípios reportantes em BC e anos disponíveis; dados financeiros históricos não equivalem a orçamento aprovado vigente | Captura de arquivos, validação de município/ano/definição; não colocar como saldo do jogador |
| [DriveBC/Open511](https://api.open511.gov.bc.ca/help) | Eventos, incidentes, obras e restrições nas rodovias cobertas | Rodovias provinciais; não cobertura de velocidades de todas as ruas de BC | GET testado com CORS; filtrar região e idade do evento |
| [BC Transit](https://www.bctransit.com/open-data/) | GTFS de sistemas publicados, horários/paradas/rotas | Somente sistemas atendidos/publicados pelo operador; não substituir TransLink em Metro Vancouver | Descobrir feed por sistema; verificar termos, shape, datas e CORS. Não testado |
| [BC Ferries](https://www.bcferries.com/routes-fares/discover-route-map) | Rotas, terminais e horários de balsas do operador | Rede de rotas específica, não todas as cidades nem todas as balsas em BC | Página oficial para captura; API pública/CORS não validados |

## Fontes de cobertura local ou de operador

| Fonte | Território/serviço | Não extrapolar para |
|---|---|---|
| Vancouver Open Data | Município de Vancouver e abrangência indicada em cada dataset | Burnaby, Richmond, toda Metro Vancouver, BC ou Canadá |
| TransLink/GTFS e SeaBus | Rede TransLink em Metro Vancouver | Victoria, Kelowna ou todo BC |
| Aquabus | Docas/conexões do operador em False Creek | Outros operadores de ferry ou toda costa |
| Mobi/GBFS | Estações do serviço Mobi | Disponibilidade de bicicletas em outra cidade |
| Port of Vancouver/Canada Place | Instalações/serviços do porto e seu calendário | Todos os portos canadenses ou posições AIS atuais |
| YVR | Aeroporto e operadores publicados pelo YVR | Voos/companhias de qualquer aeroporto |
| Vancouver School Board | Escolas cobertas pelo distrito | Todas as escolas de BC ou rotas escolares oficiais |

Links e testes dos fornecedores locais estão em [browser-source-feasibility.md](browser-source-feasibility.md). Informação publicada por uma organização regional pode descrever equipamentos fora do município; registrar a jurisdição de cada objeto.

## Regra de seleção por cidade e por variável

1. Identificar município, país, província, código oficial e geometria compatível; unir QID e códigos oficiais mediante correspondência verificada, não apenas nome.
2. Carregar base mundial disponível para a região. No Canadá, adicionar dados StatCan; em BC, adicionar BC Stats, finanças e eventos pertinentes. Habilitar fornecedores locais somente dentro de sua cobertura comprovada.
3. Escolher demografia por variável, território, período e método: censo oficial como base; estimativa oficial pode ser mais recente, mas permanece rotulada “estimativa”. Projeção não substitui automaticamente observação. Guardar séries paralelas quando comparáveis, sem alterar silenciosamente o conceito.
4. Cada valor mantém fonte, URL, unidade, referência temporal, data de captura, tipo (censo/estimativa/projeção/orçamento/realizado), geografia e indicadores de qualidade. Renda pode ter ano-base diferente do censo. Não combinar totais com denominadores de outro território/ano sem justificativa explícita.
5. Cada integração declara cobertura, capacidades, modo (pacote estático/consulta direta/chave/backend necessário), licença, atualização, validade e resultado da verificação. Recurso ausente aparece indisponível; movimento simulado permanece identificado.
6. Trânsito real exige fonte de trânsito; perfil de deslocamentos do censo calibra demanda, não posições atuais. Calendário de cruzeiros/voos é previsão programada, não rastreamento.

Exemplos: Vancouver combina fontes globais + StatCan + BC + TransLink/porto/Aquabus/Mobi/fontes municipais; Victoria reutiliza globais + StatCan + BC e seu sistema BC Transit, com fontes locais próprias; Toronto reutiliza globais + StatCan e precisa de camada Ontario/operadores locais; Lisboa reutiliza globais e precisa de camada Portugal/operadores locais. Essas composições são regras de seleção, não alegações de integração já executada.

## Elevação e relevo

Fontes e proposta em [terrain-sources.md](terrain-sources.md): LidarBC (cobertura por coleção), CanElevation MRDEM/HRDEM (Canadá, com HRDEM parcial), Copernicus GLO-30/GLO-90 (global DSM). Geometria OSM não substitui altitude. Distinguir solo de superfície, datums e ausência de cobertura.
