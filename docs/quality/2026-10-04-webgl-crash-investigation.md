# Investigação do crash WebGL — 4 de outubro de 2026

## Resultado

Há um crash nativo registrado no Chrome deste Mac às **19:57:21, America/Vancouver**, no processo `renderer`, com a origem `https://wsmontes.github.io` carregada. O minidump pertence ao **Chrome 151.0.7922.174**. Os testes desta investigação foram executados no **Chrome 154.0.8037.93**, que estava instalado quando o navegador foi aberto novamente. A diferença de versão impede afirmar que o ambiente original foi reproduzido.

O crash original não foi reproduzido nos testes. A perda forçada do contexto WebGL funcionou: o jogo removeu o canvas GPU, mudou de `webgl2` para `worker-canvas2d` e continuou apresentando o mapa e aceitando rotação. O aviso também foi observado ao recarregar a página. Assim, o aviso isolado não identifica a causa do encerramento da aba.

## Evidência do crash local

- Relatório local: `c8654691-03df-4741-9985-4897a225af9f`, mostrado em `chrome://crashes`.
- Produto/versão: `Chrome_Mac`, `151.0.7922.174`.
- Processo: `renderer`; `loaded-origin-0` corresponde à origem do app publicado.
- Exceção recuperada no minidump: tipo `0x1`, flags `0x1`, endereço `0x10`, compatível com `EXC_BAD_ACCESS`/acesso inválido a endereço próximo de nulo.
- PC: `Google Chrome Framework + 0xa551748`; primeiro chamador: `Google Chrome Framework + 0x1674920`.
- ANGLE: `2.1.28234`, hash `a17d6c8e9269`; driver `26.3.1`.
- Não foi possível atribuir uma função ao endereço do PC: as consultas aos símbolos públicos do módulo retornaram HTTP 404. Não há evidência suficiente para atribuir o crash a uma função do navegador, driver ou trecho do jogo.

A interpretação usa os formatos oficiais de [minidump do Crashpad](https://chromium.googlesource.com/crashpad/crashpad/+/refs/heads/main/minidump/minidump_extensions.h) e [exceções macOS](https://chromium.googlesource.com/chromium/src/+/f4adeaac49556e68664aac66b2f2fb95d7fddf0e/third_party/crashpad/crashpad/compat/non_win/dbghelp.h). Um crash nativo não demonstra, por si só, falta de memória; pressão de recursos continua sendo hipótese.

## Ambiente e versão do jogo

- Mac Apple M4, macOS 26.3.1, display lógico 1470 × 956, escala 2.
- Chrome atual: 154.0.8037.93, WebGL e Canvas acelerados, backend ANGLE Metal.
- `chrome://gpu` mostrou zero crashes do processo GPU na nova sessão.
- Bundle publicado: `assets/index-BVqxMTYh.js`; worker de cena: `scene-worker-DH4K8F6w.js`.
- Código publicado corresponde ao commit `00df96b`, que produz os mesmos nomes de bundles ao construir.
- A branch principal aberta inicialmente estava em `c86acc1`, cujo renderer usa Canvas 2D. Por isso, a investigação do código publicado ocorreu no worktree isolado `/Users/wagnermontes/.codex/worktrees/webgl-crash-investigation/open-sim`.

## Testes no Chrome real

1. Abrir o app publicado com `?debug=1`, esperar o mapa, inspecionar `#open-sim-frame-stats` e `performance.memory.usedJSHeapSize`.
2. Forçar a perda do WebGL no canvas GPU:

```js
document.querySelector('canvas')
  .getContext('webgl2')
  .getExtension('WEBGL_lose_context')
  .loseContext();
```

Resultado: apenas um canvas permanece; backend `worker-canvas2d`; mapa visível após rotação. Antes da perda: 22.2 MB de pixels apresentados/texture contabilizados; depois: 11.1 MB. Esses valores não medem toda a memória nativa do navegador.

3. Alternar entre `#hud-overview` e `#hud-city` 12 vezes, com intervalo de 1.2 s, no publicado; depois 20 vezes com intervalo de 2 s e viewport completo.

Resultado: sem encerramento da aba; heap da página em torno de 110–216 MB em amostras posteriores; cache raster em torno de 52–56 MB, com mais de mil entradas. O processo chegou a aproximadamente 2.7 GiB de RSS. A coleta de lixo e o tempo de repouso reduziram esse consumo substancialmente; não foi demonstrado crescimento ilimitado.

4. No código original em cópia local, simular 3×, alternar escalas 20 vezes com intervalo de 1.5 s e girar a câmera a cada terceira alternância. Capturar `webglcontextlost` no document e `error` no window.

Resultado: **zero perdas de contexto e zero erros capturados na página**. Pico de heap amostrado da página: 446 MB. Última amostra: backend `webgl2`, heap 301 MB, cache raster 56,846,328 bytes/1,415 entradas, worker 5.8 ms, taxa de apresentação 5 fps. A última amostra coincidiu com worker ativo e pedido pendente; não representa desempenho estacionário. Houve compilação/testes concorrentes no computador, portanto os números de tempo e memória são exploratórios.

## Experimentos descartados

O renderer cria um `OffscreenCanvas` para cada prédio em cache. O orçamento contabiliza `width × height × 4`, sem medir overhead nativo/contexto/filas gráficas.

- Desativar temporariamente esse cache reduziu as entradas de mais de mil para uma e o raster de cerca de 75 MB para 11 MB. RSS observado após a navegação caiu de aproximadamente 1.3 GiB para 592 MiB.
- Solicitar `{willReadFrequently:true}` nos canvases dos prédios não produziu melhoria consistente de RSS.
- As amostras variaram em quantidade de tiles/prédios, coleta de lixo e momento de carga. Portanto, esses experimentos sugerem custo significativo dos canvases individuais, mas não constituem comparação controlada nem comprovam a causa do crash.
- Ambas as alterações foram revertidas. O código do worktree voltou integralmente ao commit publicado; nenhuma correção especulativa foi mantida.

## Verificação do código original

- Build (`npm run build`): passou; aviso de bundle principal maior que 500 kB.
- Suite padrão: 999 passaram, 5 ignorados, 4 timeouts de 5 s em `architecture.test.ts` e três testes de `browser-shell.test.ts`.
- Os dois arquivos, executados isoladamente com um worker: 22 passaram.
- Suite completa com dois workers: 1,002 passaram, 5 ignorados, 1 timeout de 5 s no teste que executa compilação dos contratos sem DOM/Node (`architecture.test.ts:110`). Esses timeouts são limitações observadas no baseline; não houve alteração de código de produção.

## Próximo passo sustentado pela evidência

A evidência mais direta é o crash nativo do renderer no Chrome 151. A primeira comparação útil é repetir o uso habitual no Chrome 154 e, se o crash voltar, correlacionar o novo relatório local, versão, origem e PC com este relatório. Para atribuir o custo elevado de memória ao cache de prédios, a comparação deve usar os mesmos tiles já carregados, viewport/câmera, simulação, número de alternâncias e medidas de heap/RSS após repouso. O fallback de perda WebGL já passou no teste real; não há evidência para substituí-lo.
