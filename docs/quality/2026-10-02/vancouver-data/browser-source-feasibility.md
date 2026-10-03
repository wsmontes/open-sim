# Fontes Vancouver sem backend próprio

Pesquisa solicitada pelo usuário em 2026-10-02, data local America/Vancouver. O produto atual usa GitHub Pages. “Sem servidor” significa sem backend/proxy operado pelo projeto; APIs externas continuam sendo servidores dos fornecedores.

## Método e limite da verificação

Consultadas documentação primária e respostas HTTP GET públicas, com `Origin: https://wsmontes.github.io`, sem credenciais. Inspecionados status, content type, amostra de payload e `Access-Control-Allow-Origin`. CORS `*` permite leitura por origem externa em requests simples sem credentials; CORS ausente ou restrito a outro domínio não permite `fetch` do GitHub Pages. Testes foram de HTTP/headers, não execução JavaScript no navegador. Não são garantia de disponibilidade futura, cobertura completa ou autorização de qualquer uso comercial.

Não usar `mode:no-cors`: resposta opaca não permite ler dados. Não recorrer a proxies públicos para chamar bloqueios de CORS de solução sem backend. Empacotar uma captura no próprio site é alternativa válida para dados estáticos, não é um feed ao vivo.

## GETs verificados

| Fonte | Resultado | CORS observado | Payload e conclusão |
|---|---|---|---|
| Wikidata Q24639 | 200 | `*` | JSON da entidade: consulta direta sem chave; população é medida datada, não contador instantâneo |
| Vancouver `traffic-signals` | 200 | `*` | 966 pontos no teste; tipo e localização aproximada, sem fase vermelha/amarela/verde atual |
| Vancouver `intersection-traffic-movement-counts` | 200 | `*` | 659 registros; localização e link VanMap, não valores de contagem no payload consultado |
| Vancouver `road-ahead-projects-under-construction` | 200 | `*` | 68 registros; geometria, conclusão prevista e link, campos podem ser null; obras publicadas, não velocidade de trânsito |
| Vancouver capital 2026 | 200 | `*` | 630 linhas; projetos, orçamento plurianual e despesa anual em campos distintos |
| OurAirports `runways.csv` | 200 | `*` | CSV de pistas; dados públicos comunitários, download direto possível |
| TransLink GTFS ZIP | 200 | ausente | ZIP acessível em download/script, bloqueado para leitura cross-origin do jogo; preparar captura local antes do build |
| Open-Meteo forecast | 200 | `*` | Condições modeladas atuais, precipitação, vento e sunrise/sunset para Vancouver, sem chave |
| Open-Meteo air-quality | 200 | `*` | PM2.5 e índice de qualidade do ar modelados, sem chave |
| DriveBC Open511 events | 200 | `*` | Eventos rodoviários; API pública documentada, escopo de rodovias provinciais |
| Mobi GBFS discovery | 200 | `*` | Descoberta de feeds, sem chave |
| Mobi GBFS station_status | 200 | `*` | 263 estações no teste, bicicletas/vagas disponíveis, last_reported e TTL de 60 s |
| OpenSky bounding box Vancouver | 200 | `https://opensky-network.org` | Posições reais disponíveis via HTTP, mas resposta não permite leitura por origem GitHub Pages |
| ADSB.lol região Vancouver | 200 | ausente | Sete aeronaves na amostra; lat/lon/altitude/callsign/modelo possíveis, mas leitura cross-origin bloqueada |

Quantidades são observadas no teste, não constantes para código ou promessa de cobertura. Foram baixadas somente amostras necessárias, não snapshots completos do jogo.

## Endpoints reproduzíveis

- Wikidata: https://www.wikidata.org/wiki/Special:EntityData/Q24639.json
- Sinais: https://opendata.vancouver.ca/api/explore/v2.1/catalog/datasets/traffic-signals/records?limit=1
- Contagens: https://opendata.vancouver.ca/api/explore/v2.1/catalog/datasets/intersection-traffic-movement-counts/records?limit=1
- Obras: https://opendata.vancouver.ca/api/explore/v2.1/catalog/datasets/road-ahead-projects-under-construction/records?limit=1
- Capital: https://opendata.vancouver.ca/api/explore/v2.1/catalog/datasets/2026-multi-year-capital-project-budget-requests-and-capital-expenditure-budget/records?limit=1
- Pistas: https://davidmegginson.github.io/ourairports-data/runways.csv
- GTFS: https://gtfs-static.translink.ca/gtfs/google_transit.zip (link oferecido na página oficial TransLink)
- Clima: https://api.open-meteo.com/v1/forecast?latitude=49.2827&longitude=-123.1207&current=temperature_2m,precipitation,weather_code,wind_speed_10m&daily=sunrise,sunset&timezone=America%2FVancouver&forecast_days=1
- Ar: https://air-quality-api.open-meteo.com/v1/air-quality?latitude=49.2827&longitude=-123.1207&current=pm2_5,us_aqi
- DriveBC: https://api.open511.gov.bc.ca/events?limit=1
- Mobi: https://gbfs.kappa.fifteen.eu/gbfs/2.2/mobi/en/gbfs.json
- Status Mobi: https://gbfs.kappa.fifteen.eu/gbfs/2.2/mobi/en/station_status.json
- OpenSky: https://opensky-network.org/api/states/all?lamin=49&lomin=-123.5&lamax=49.5&lomax=-122.5
- ADSB.lol: https://api.adsb.lol/v2/point/49.2827/-123.1207/30

## Restrições e lacunas

Open-Meteo documenta CORS e API gratuita para uso não comercial, 10.000 chamadas/dia, com atribuição e sem garantia de disponibilidade. “Current” meteorológico e qualidade do ar são derivados de modelos; não são necessariamente sensor local. Sugerir refresh de 15–30 min, não a cada frame.

DriveBC fornece acidentes, obras, fechamentos e condições em rodovias provinciais. Não equivale à velocidade de cada rua municipal. Sugerir refresh de 5 min com bounding box e timestamps. Aplicação de um evento à malha do jogo exige matching e classificação do evento, não bloquear automaticamente todas as vias próximas.

Mobi permite observar inventário de estações, não trajetos de pessoas pedalando. Honrar TTL, respeitar idade e termos ODbL declarados no catálogo. Sugerir refresh de 60–120 s somente quando a região estiver visível. Fonte/operador: https://www.mobibikes.ca/ ; descoberta registrada em https://mobilitydatabase.org/feeds/gbfs/gbfs-Mobibikes_CA_Vancouver .

TransLink realtime exige registro/chave, conforme https://www.translink.ca/about-us/doing-business-with-translink/app-developer-resources e sua documentação GTFS Realtime. Acesso autenticado e CORS não foram testados sem chave. Uma chave embutida em frontend fica pública; não declarar impossibilidade técnica universal, mas não escolher essa fonte como integração pública sem backend comprovada. Rotas/paradas estáticas podem ser processadas uma vez e servidas no site, atendendo ao pedido atual de ônibus.

OpenSky tem acesso anônimo limitado por créditos e autenticação OAuth2 client credentials para acesso autenticado. O GET anônimo respondeu, mas CORS observado restringe a origem. Credenciais de cliente não devem ser embutidas no site. ADSB.lol atualmente oferece API gratuita, porém sem CORS no GET testado e solicita contato para uso em produção. Ambas são candidatas a backend próprio futuramente, não feeds diretos aprovados nesta pesquisa.

AWC METAR não foi escolhido: a documentação https://aviationweather.gov/data/api/ declara que CORS não é permitido. Clima modelado Open-Meteo não determina qual pista está oficialmente ativa.

Não foi encontrado nesta pesquisa um feed público comprovado de posições de viaturas, rotas de ônibus escolares ou fases atuais dos semáforos. Manter esses movimentos/ciclos simulados e identificados. Não inferir que o dataset de crime seja localização de viatura nem que escola publicada implique rota escolar oficial.

## Recomendação para a entrega

1. Base distribuída com o site: fatos com fonte/ano, orçamento validado, rotas/paradas TransLink, aeroportos/pistas, escolas e cadastro de sinais. Atualização por ferramenta local de captura, sem backend em runtime.
2. Consultas diretas candidatas: Wikidata, obras municipais e DriveBC. Clima e Mobi são boas extensões opcionais, não requisitos novos autorizados de implementação pela pesquisa.
3. Simulação local: carros, polícia, escolares, ônibus em rotas reais, fases dos sinais, pousos/decolagens em pistas reais. Distinguir dado geográfico oficial de movimento estimado.
4. Persistir cache no navegador, mostrar última atualização, cancelar ao mudar cidade e manter experiência funcional offline/com fonte indisponível. Limites por usuário/IP crescem com visitas; não prometer SLA de fonte gratuita.

Documentação primária complementar: https://open-meteo.com/en/docs ; https://open-meteo.com/en/pricing ; https://api.open511.gov.bc.ca/help ; https://ourairports.com/data/ ; https://opendata.vancouver.ca/explore/dataset/traffic-signals/information/ ; https://opendata.vancouver.ca/explore/dataset/intersection-traffic-movement-counts/information/ ; https://www.translink.ca/about-us/doing-business-with-translink/app-developer-resources/gtfs/gtfs-data ; https://github.com/openskynetwork/opensky-api/blob/master/docs/free/rest.rst ; https://api.adsb.lol/docs .
