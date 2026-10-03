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
