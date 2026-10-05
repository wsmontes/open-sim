# Arquitetura de desempenho

Implementação concluída em 3/10/2026: interação e composição da cidade agora usam superfícies independentes. A interface reprojeta imediatamente a imagem existente; workers decodificam os tiles, preparam geografia, relevo, rede, rotas de ônibus e frotas. Uma fila admite um trabalho ativo e substitui o pendente pela solicitação mais recente. A cena estática precede a publicação dos atores, inclusive quando pausados.

WebGL2 apresenta a imagem pela GPU quando o navegador oferece aceleração; Canvas2D recupera a superfície quando esse caminho falha. Metal depende do backend do navegador e não foi verificado diretamente. Limites por memória regulam resolução, cache raster, quantidade de atores processados e frequência de efeitos. Esses limites contabilizam recursos do aplicativo, não toda a memória do navegador/driver. Recursos rejeitados ou descartados liberam seus pixels.

Veículos genéricos usam viagens conectadas e limitadas sobre ruas reais, sem busca por toda a cidade em cada quadro. Ônibus continuam preparados a partir de trajetos/paradas reais; rotas escolares e polícia são preparados fora da interface. Hosts sem workers usam uma rede menor e tarefas que cedem execução, podendo omitir trajetos que excedem o limite de busca. A economia e o formato de saves permanecem compatíveis.

## Verificação

Check completo aprovado: TypeScript, lint e977testes passaram,5ignorados; build de produção aprovado. Dez avisos de lint existentes permanecem. Testes cobrem coalescência, descarte de bitmaps, orçamento de memória, atores pausados após confirmação estática, recuperação da superfície após perda da GPU e publicação assíncrona de frotas.

Verificação nativa em 1280×720, DPR2, escala100m, False Creek: WebGL2 ativo,225atores (131carros,9caminhões,81pedestres,2ônibus e2policiais),128339arestas. Durante execução, trabalho da interface p50~1,4ms/p95~3,3ms; após pausar e girar, worker e filas ociosos, estático confirmado e atores mantidos. Cache raster~49,36MB e bitmap/textura apresentados~29,49MB. Esta observação curta não é uma comparação controlada com a baseline nem confirma metas para todos os dispositivos.

## Evidência histórica

- `reproduction.json/png`: diagnóstico inicial em Vite100m, cerca de4FPS/196–198ms de desenho.
- `production-baseline.json` e `baseline-bundle.json`:30execuções anteriores à otimização,1280×720,15s de aquecimento e3×30s por cena. Algoritmo28c9d09, instrumentação b53a29b. O cenário chamado Reproduction repete o corredor TransLink em50m; não equivale à captura100m.
- `production-baseline-100m.json`: suplementação explícita da baseline100m/45°.
- `production-intermediate.json` e `current-bundle.json`: versão intermediária a35693c, anterior ao worker/GPU e às últimas correções. Não representam o build publicado.

A rodada final extensa de30execuções/20viagens não foi executada nesta etapa, seguindo a orientação de priorizar desenvolvimento. Nenhuma meta quantitativa geral é declarada cumprida com base na observação curta.

## Revisões e decisões

A revisão original apontou7problemas importantes, todos corrigidos: revisão de conteúdo da rede, chave semântica do HUD, câmera final e cobertura independente, ordenação de profundidade, áreas de brilho da água, fallback assíncrono e propriedade dos rasters de terreno. A nova revisão do worker/GPU encontrou3problemas importantes: recuperação de apresentação, publicação dos atores congelados após o estático e preparação de frotas/buscas no thread da interface. Todos receberam correções e verificações direcionadas. Nenhum problema crítico ou julgamento excluído.

Decisões registradas: desenvolver preparação enquanto a baseline imutável era medida; reutilizar o canvas persistente com restauração de áreas sujas (regiões grandes podem exigir replay); ampliar a arquitetura para worker/WebGL2 conforme a nova orientação do usuário (aumenta complexidade de backend, coberta por fallback/lifecycle); substituir a rodada longa de aceitação por checks e observação nativa nesta entrega, sem reivindicar suas metas. Teste automático de equivalência de pixels permanece melhoria posterior; o antigo ponto menor de varrer energia a cada quadro foi corrigido no novo escopo por cache semântico.
