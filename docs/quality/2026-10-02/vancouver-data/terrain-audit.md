# Captura de relevo real — 3 de outubro de 2026

Fonte oficial: catálogo STAC CanElevation `https://datacube.services.geo.ca/stac/api/collections`; consulta HRDEM-LiDAR por bbox `-123.35,49.15,-122.95,49.5`. Foram identificadas cinco coleções, inclusive Vancouver, Lower Mainland e Sunshine Coast; bounding box não prova cobertura. A máscara nodata do raster determina a disponibilidade efetiva. A coleção municipal Vancouver é aquisição 2013-02-19; não representa mudanças recentes de terraplenagem.

Captura urbana: `VILLE_VANCOUVER-VILLE_VANCOUVER-1m-dtm.tif`, overview oficial fator 16. Fonte original de terreno LiDAR classificado, resolução nominal 1m; este pacote usa amostragem efetiva de aproximadamente **16m**, depois grid geográfico com passo máximo ~35m. Não afirmamos representação de detalhes de 1m. O overview pertence ao COG oficial e é o raster de referência da extração; a comparação não mede fidelidade ao raster base de 1m.

Contexto regional/North Shore: `mrdem-30-dtm.tif`, recorte limitado 30m. Fonte nacional DTM multiorigem, incluindo HRDEM e terreno derivado de Copernicus. Não recebe o mesmo nível de qualidade local do LiDAR municipal. Não usamos DSM como chão urbano. A superfície deve preferir o DTM urbano onde válido e usar contexto regional nas lacunas, mantendo origem por tile.

Os dois produtos oficiais usam altitude ortométrica **CGVD2013 (EPSG6647)** em metros. Coordenadas originais EPSG3979 → EPSG4326 com PROJ/pyproj, nearest sample, sem transformação vertical ou exagero. Especificações oficiais: HRDEM edição 1.7 de 19/05/2026, MRDEM edição 1.2 de 20/06/2025. Dados de solo não são batimetria; água e decks de pontes terão superfícies próprias.

Ferramenta reproduzível: `node --import tsx tools/terrain-capture.ts /path/to/python`, Python com rasterio/pyproj/numpy. O comando acessa somente overview municipal e janela regional via HTTP Range, não baixa o raster nacional inteiro. Grid 65×65 por tile, Float32 little endian e máscara byte, header OST1. Borda compartilhada usa coordenadas arredondadas ao mesmo grid. Nenhum nodata vira zero; nenhuma lacuna recebe montanha procedural.

Resultado: **242 tiles, 5.156.990 bytes brutos**, cada tile <32KiB. Bounding box do pacote: oeste -123.30, leste -123.00, sul49.18, norte49.50. Amostras urbanas ausentes permanecem máscara0. Manifest registra fonte, licença, datum e resolução. Adaptador limita 8 downloads e cache decodificado 32MiB; os arquivos são servidos pelo host estático em `public/terrain/vancouver`.

`terrain-capture-audit.json` registra versões Rasterio/GDAL, transformação, hashes dos recortes, 10 pontos por fonte e 3 perfis de 65 pontos por fonte. Perfis municipais passam pelo sul da cidade, Queen Elizabeth Park e região central; perfis regionais atravessam North Shore. Erro de extração entre amostra coincidente no raster de referência e Float32 publicado ≤0,1m (observado zero). Isso é precisão de **extração**, não precisão física do levantamento; a qualidade absoluta varia com projeto LiDAR e origem MRDEM e não foi medida nesta captura.

Licença Open Government Licence – Canada, atribuição NRCan e avisos Copernicus mantidos no manifest. Documentação: `https://download-telecharger.services.geo.ca/pub/elevation/dem_mne/highresolution_hauteresolution/HRDEM_Product_Specification.pdf` e `https://download-telecharger.services.geo.ca/pub/elevation/dem_mne/MRDEM_MNEMR/CanElevation-MRDEM-Product-Specifications.pdf`.

Status: captura e contrato validados; projeção, apoio, seleção, água e desempenho visual seguem nas tarefas 8–9 e22.
