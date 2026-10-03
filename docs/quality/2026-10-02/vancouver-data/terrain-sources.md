# Relevo real: fontes e proposta técnica

Pesquisa em 2026-10-02. Status: fontes documentadas e arquitetura proposta; nenhum relevo implementado ou tile de elevação validado nesta etapa.

## Diagnóstico

`src/core/model.ts` define Cell apenas com classe land/water/green; BaseChunk não contém raster de altitude. `src/surfaces/canvas/geographic-renderer.ts` projeta geometria em um plano via projectRing/roadPath. Elevação não pode ser resolvida por cor ou sombra sem mudar a geometria e o posicionamento dos objetos.

## Fontes por cobertura

| Alcance | Fonte | Uso e limites |
|---|---|---|
| BC | [LidarBC/GeoBC](https://www2.gov.bc.ca/gov/content/data/geographic-data-services/topographic-data/lidarbc) | Coleções abertas de lidar. Selecionar modelo de terreno/bare earth ou derivá-lo de pontos classificados; conferir cobertura, data, resolução e datum por produto. Não afirmar cobertura completa de BC ou Vancouver sem consultar footprints |
| Canadá | [CanElevation/NRCan](https://natural-resources.canada.ca/maps-tools-publications/satellite-elevation-air-photos/national-elevation-data-strategy), [HRDEM](https://open.canada.ca/data/en/dataset/957782bf-847c-4644-a757-e383c0057995) | MRDEM cobre Canadá; HRDEM é de alta resolução em áreas disponíveis. Escolher versão de terreno, conferir raster e datum. Não presumir HRDEM nacional completo |
| Mundo | [Copernicus DEM GLO-30/GLO-90](https://dataspace.copernicus.eu/explore-data/data-collections/copernicus-contributing-missions/collections-description/COP-DEM) | Cobertura global nominal em 30/90 m. É DSM: inclui vegetação/edifícios, não terreno nu. Não usar telhados como altitude de fundação e depois adicionar prédio novamente. Global como fallback de paisagem; em áreas urbanas, qualidade limitada e marcada |

A documentação de Copernicus especifica altitudes em metros, datum vertical EGM2008 e formatos GeoTIFF/DTED; redistribuição/modificação exige os avisos de atribuição documentados. Acesso CDSE pode requerer registro/credenciais. Não colocar segredo no frontend. Documentação de BC/NRCan apareceu na busca oficial, mas acesso direto retornou 502/403 nesta sessão; captura de raster e CORS não foram testados. Consulta de elevação pontual não substitui um DEM para toda a superfície.

## Abordagem recomendada

Preparar tiles de elevação durante a captura/build e servi-los com o site; o navegador carrega somente a região e nível de detalhe necessários. Isso funciona sem backend próprio e offline para regiões capturadas. Não empacotar raster global completo; cidades sem pacote só recebem dados de fornecedor validado, caso contrário mostram a ausência de cobertura real.

Separar terrain (solo) de surface (telhados/copas). Cada tile registra bounds, CRS horizontal/vertical, resolução, origem, data, tipo, máscara no-data e transformação aplicada. Reprojetar e harmonizar datums antes de combinar fontes; missing não equivale a zero. Bordas compartilham amostras para evitar degraus artificiais. Melhor resolução é usada apenas onde disponível, com transição consistente e qualidade identificada.

Renderizar malha de terreno com amostras em metros, triangulação e sombreamento pela inclinação. A altitude altera projeção e ordenação/oclusão, não apenas a paleta. Ruas são amostradas ao longo do terreno, com subdivisão suficiente em curvas/encostas. Bases de edifícios usam apoio coerente e fundações locais; não inclinar fachadas nem deformar o raster para nivelar cidades inteiras. Veículos/pedestres usam a mesma superfície das ruas. Pontes mantêm deck separado; túneis não seguem encostas na superfície. Água tem superfície coerente por corpo hídrico; mar e rios não devem virar lençol único arbitrário. DEM terrestre não é bathymetria nem informação de calado.

Picking, previews e ferramentas devem usar a projeção elevada, não coordenadas do plano antigo. Relacionar declividade com viabilidade de ruas/construção é etapa posterior à representação, com regras simuladas explícitas; não alterar economia ou histórico silenciosamente. Alterações de terreno pelo jogador não fazem parte desta primeira proposta.

Manter altitude física 1:1 como padrão, sem montanhas procedurais. Qualquer exagero visual futuro deve ser opção identificada e nunca modificar altitude real, declividade ou dados de inspeção.

## Alternativas

- Sombrear mapa plano com hillshade: barato, mas não satisfaz representação geométrica pedida.
- Malha elevada no renderizador atual: recomendada; preserva linguagem visual e integra dados reais, porém exige projeção, picking e apoio de objetos coerentes.
- Migrar todo renderizador para motor 3D: maior escopo; considerar somente se medição demonstrar que malha/oclusão no canvas atual não atende desempenho e qualidade.

## Verificação necessária antes de declarar resultado

Capturar amostra real de Vancouver e região do North Shore com procedência; conferir pontos e perfil contra raster original. Validar bordas, nodata, água, datum, declividade e ausência de altura de prédio duplicada. No navegador, conferir encostas locais, litoral, montanhas do North Shore, ruas/edifícios apoiados, picking correto, pontes, rotação, dia/noite e zoom. Medir custo com tráfego terrestre, marítimo e aéreo. North Shore é contexto regional e não deve alterar a demografia do município de Vancouver.
