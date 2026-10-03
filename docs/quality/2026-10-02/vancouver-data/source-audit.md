# Auditoria das capturas oficiais de Vancouver

## Demografia — captura 2 de outubro de 2026 (Vancouver)

`vancouver-demography.json` conserva as colunas originais selecionadas, metadados e hash da resposta Census Profile. Recaptura: `node --import tsx tools/canada-demography.ts`. A ferramenta interrompe a gravação quando a validação municipal falha. Os CSVs integrais de pesquisa permanecem no workspace local, fora do bundle.

Statistics Canada SDMX, fluxo `STC_CP:DF_CSD(1.3)`, DGUID `2021A00055915022`, código CSD `5915022`, gênero total, estatística Counts. Metadados obtidos de `https://api.statcan.gc.ca/census-recensement/profile/sdmx/rest/datastructure/STC_CP/DSD_CSD/1.3?references=all`. Licença: Statistics Canada Open Licence. Valores suprimidos x/F e não numéricos permanecem ausentes.

| Medida | CHARACTERISTIC | Valor | Referência/universo |
|---|---|---|---|
| População | 1 | 662.248 | Censo 2021, município |
| Faixas 0–14 / 15–64 / 65+ | 35 / 36 / 37 | 10,7 / 72,3 / 17,0% | População por idade, 100% dos dados |
| Domicílios | 50 | 305.335 | Domicílios particulares, 2021 |
| Tamanho médio | 56 | 2,1 | Pessoas por domicílio particular |
| Renda mediana total do domicílio | 229 | CAD 82.000 | Renda de 2020, censo 2021 |
| Emprego | 2229 | 61,9% | População 15+ em domicílios particulares, amostra 25% |
| Deslocamento ao trabalho | 2604/2607/2608/2609/2610 | Contagens convertidas em percentuais | Denominador 2603 = 233.960: empregados 15+ com local usual ou sem local fixo, amostra 25%, 2021 |

As classes de deslocamento são carro/caminhão/van, transporte público, caminhada, bicicleta e outros. Motorista e passageiro são subconjuntos e não são somados novamente. Contagens arredondadas do censo podem gerar pequena diferença na soma dos percentuais. Não representam trânsito atual.

BC Stats: recurso municipal do catálogo `86839277-986a-4a29-9f70-fa9b1166f6cb`, CSV `municipality-population.csv`. Licença Open Government Licence – British Columbia. Filtro `Region=15022`, `Region.Type=Municipality`, `Gender=T`, `Type=Estimate`, `Year=2025`. Total **740.443**; soma das idades 0–89 e 90+ validada igual ao total. A estimativa não substitui o censo e não se confunde com projeções. O ano 2021 na série de estimativas BC não é a contagem do censo.

Junção pela identidade cadastrada Q24639 → CSD 5915022 → DGUID 2021A00055915022. Nenhum total da região metropolitana foi usado. Datas e método viajam por medida; a UI mantém o indicador de moradores simulados no painel de gestão.

## Finanças aprovadas e realizadas

Ata oficial `https://council.vancouver.ca/20251125/documents/regu20251125min.pdf`, aprovada 25/11/2025, movimento final F, página impressa 20: **CAD 2.392.516.009**, orçamento operacional 2026. Movimento I, página 21: **CAD 894 milhões**, despesas anuais de capital 2026; normalização ×1.000.000 = CAD 894.000.000. Movimento H, página 20: CAD 698 milhões de novas autorizações plurianuais, excluídas do total anual. Download via navegador nativo, extração local `pdftotext -layout` e conferência visual de PNGs das páginas 20–21. Hash original no JSON.

O livro final do orçamento de 12MB retornou 403 no acesso CLI e excedeu limite de download da ferramenta web. A ata da decisão final fornece os valores aprovados exatos, evitando o arredondamento CAD 2,39 bilhões da notícia municipal. Termos municipais conferidos em `https://vancouver.ca/your-government/terms-of-use.aspx`: não atribuímos licença aberta ao PDF e não reproduzimos o relatório; o bundle contém apenas os fatos numéricos e referências.

Contas realizadas BC LGDE 2024: arquivos oficiais `schedule401_2024.xlsx` e `schedule402_2024.xlsx`, baixados via navegador do catálogo municipal provincial. `Sheet1!A151=Vancouver`, `B151=C` (City), `C151=MVRD`; crosswalk municipal Q24639/CSD5915022 verificado contra identidade de Vancouver, sem usar North Vancouver ou West Vancouver. Receita consolidada `N151=3.164.278.000 CAD`; despesa consolidada `R151=2.303.644.000 CAD`. Valores em dólares, nenhuma conversão de milhares. Incluem contabilidade consolidada e amortização; não equivalem ao orçamento operacional. Ano, status `actual`, célula e hash separados no JSON. Fonte provincial publica dados recebidos de municípios/auditores; preservamos essa distinção. Metadados públicos em `https://www2.gov.bc.ca/gov/content/governments/local-governments/facts-framework/statistics/statistics`.
