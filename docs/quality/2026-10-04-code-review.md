# Revisão do projeto — 4 de outubro de 2026

Revisão transversal do estado atual de `src`, interfaces browser/texto/JSON, persistência, mapa, multiplayer, testes e build. Nenhuma correção de implementação foi aplicada. Prioridades: P1 exige atenção antes de ampliar o uso; P2 é um problema funcional ou de escala; P3 é manutenção. Recomendações de desenho estão separadas dos defeitos. A revisão não constitui prova de ausência de outros bugs nem benchmark em aparelhos reais.

## Evidência executada

- `npm run check`: typecheck e lint concluídos; 86 arquivos de teste aprovados, 718 testes aprovados e 5 ignorados. Lint: 9 avisos em testes.
- `npm run build`: aprovado. JS principal: 471,79 kB, 166,50 kB gzip; worker do mapa: 14,84 kB.
- `tsc --noEmit --noUnusedLocals --noUnusedParameters`: 22 diagnósticos, dos quais 7 em `src`. Não é a configuração atual do check.
- Reprodução direta com Node/tsx: `parseStrictJson` aceita `{"__proto__":{"x":1},"ok":2}`, retorna apenas `ok` como chave própria e muda o protótipo do objeto retornado.
- Revisão independente do armazenamento reproduziu com IDB sem resposta o bloqueio do mapa; com fake-indexeddb reproduziu `InvalidStateError` após fechar por mudança de versão.
- Revisão independente da UI executou 30 testes direcionados; reproduziu Ctrl+A movendo a câmera e impedindo a ação padrão, e quatro tiles demandados sem cobertura apesar de parents carregados.
- Não executados: perf:browser, medição de INP/FPS/memória em dispositivo, testes manuais de leitor de tela, sessão WebRTC real e atualização off-line entre dois deploys.

## Problemas prioritários

### 1. P1 — cache local pode bloquear o mapa indefinidamente

Referências: `src/adapters/osm/tile-cache.ts:78`, `src/adapters/osm/chunk-cache.ts:40`, `src/adapters/osm/provider.ts:47`.

As aberturas dos caches IndexedDB não possuem prazo. O provider aguarda o cache antes da rede. Seu timer aborta o fetch, mas não encerra o await de IndexedDB. Quatro leituras presas ocupam toda a concorrência do mapa. A preparação off-line também depende dessas leituras.

Reprodução: fábrica IDB cuja abertura nunca responde; timeout do provider de 10 ms; após 50 ms, `loadVisualTile` segue pendente e nenhum fetch começou.

Correção: usar abertura recuperável com deadline em todos os bancos; limitar também leituras/transações; tratar timeout do cache como miss; liberar o slot e permitir retry. Testar abertura sem eventos, blocked, abort e sucesso tardio. Evitar três implementações distintas do ciclo de abertura.

### 2. P2 — reconectar WebRTC reutiliza readiness antiga

Referências: `src/adapters/network/webrtc.ts:208`, `:223`, `:569`.

`drop()` remove o link e rejeita a deferred, mas conserva a entrada de `openings`. Uma reconexão com o mesmo peer recebe a Promise da conexão anterior: já resolvida quando antes houve sucesso, ou permanentemente rejeitada quando houve falha. A espera pode terminar antes dos novos canais abrirem.

Correção: readiness por geração de conexão; remover a entrada antiga com cuidado para callbacks tardios não afetarem a conexão nova. Testar abrir → cair → convidar novamente e falhar antes de abrir → tentar novamente. Achado estático; sem reprodução RTC real nesta revisão.

### 3. P2 — fechamento por versionchange deixa banco fechado em cache

Referência: `src/adapters/storage/bounded-db.ts:44`.

O callback fecha o banco, mas não limpa `handle`. As operações seguintes recebem a conexão fechada. Reprodução com fake-indexeddb: ler, apagar o banco externamente e ler novamente gera `InvalidStateError`.

Correção: invalidar o handle correspondente ao fechar; reabrir na operação seguinte e tratar operações em andamento. Cobrir upgrade/delete entre duas abas, além do timeout de abertura já testado.

### 4. P2 — detalhe parcial remove cobertura provisória do mapa

Referência: `src/browser/geographic-stream.ts:43`.

O stream encontra parents como fallback, mas depois remove qualquer parent que possua ao menos um child visível. Se apenas um child chegou e os siblings continuam pendentes ou falharam, a cobertura do parent para esses siblings também desaparece.

Correção: conservar cobertura das subáreas ainda sem detalhe, usando recorte por tile ou uma política de substituição por cobertura completa. Testar parent pronto + um child pronto + siblings pendentes e com falha. Não basta testar ausência de sobreposição.

### 5. P2 — atalhos globais interceptam comandos do navegador

Referência: `src/surfaces/canvas/input.ts:229`.

O handler ignora campos de texto, mas não Ctrl/Meta/Alt. Ctrl/Meta+A/S/W/D podem acionar pan; o branch de pan chama `preventDefault`. Teclas numéricas modificadas também podem selecionar ferramentas em vez de trocar abas.

Correção: delimitar o contexto de teclado e ignorar modificadores não usados explicitamente pelo jogo. Verificar composição de texto e foco em controles/painéis. Testar atalhos com Ctrl, Meta e Alt.

### 6. P2 — tolerância de tap muda com a densidade da tela

Referências: `src/surfaces/canvas/input.ts:106`, `:118`, `:151`.

`TAP_SLOP=6` é comparado a coordenadas do backing buffer. Com buffer em 2×, apenas 3 pixels CSS já contam como arrasto, enquanto em 1× são 6. Pequeno tremor do dedo pode impedir o card de abrir.

Correção: medir o limiar em pixels CSS, reservando coordenadas de buffer para projeção. Testar o mesmo gesto físico com escalas 1 e 2.

### 7. P2 — cache do shell cresce entre deploys

Referência: `public/sw.js:2` e `:12`.

O cache tem nome fixo, recebe respostas GET do escopo e nunca remove assets antigos. Cada deploy com novos hashes adiciona JS/CSS/workers; URLs com query também criam entradas. Esse armazenamento disputa quota com mapa e saves.

Correção: manifest de assets por versão, instalação completa antes de ativação, limpeza segura das versões antigas e política explícita de cache para navegação e assets. Preservar a consistência das abas abertas durante a atualização. Testar A → B → reload off-line; quota insuficiente; interrupção da instalação. Crescimento confirmado pelo desenho; não medido durante vários deploys.

### 8. P2 — bytes de tiles não incluem identidade da fonte

Referência: `src/adapters/osm/provider.ts:44`.

A chave persistida é apenas `z:x:y`, embora o provider aceite `tileUrl`. Trocar a fonte com o mesmo cache pode servir bytes antigos como se fossem da fonte nova. O cache normalizado já inclui o template e a versão do normalizador.

Correção: namespace por fonte e versão também nos bytes brutos. É relevante à API configurável; a aplicação atual usa a fonte padrão.

### 9. P2 — parser estrito altera o protótipo e perde uma chave JSON

Referência: `src/world/codec.ts:99`.

`result[key.value] = item.value` em objeto `{}` trata `__proto__` como setter. A reprodução mostrou perda da chave e mudança do protótipo. Não é evidência de poluição global de Object.prototype; é uma violação local do contrato do parser e risco de divergência entre leitores/validação/hash.

Correção: rejeitar chaves reservadas antes da atribuição, conforme o contrato em `core/guards`, ou criar propriedades próprias de forma segura quando a especificação permitir. Testar valor objeto, número e null, inclusive dentro de arrays e objetos abertos. Não depender apenas de validações posteriores para detectar o problema.

### 10. P2 — stop não encerra todos os trabalhos do cliente

Referências: `src/client/time.ts:25`, `src/client/city-client.ts:254`, `:423`, `:640`.

`debounce` descarta o cancel retornado por `time.after`. `client.stop()` para o relógio e listeners, mas deixa timers de load/save e operações assíncronas em andamento. Um cliente desmontado pode continuar salvando ou carregando mapa. Impacto maior em reutilização, testes e troca de hosts; a página atual normalmente tem uma única instância.

Correção: debouncer com cancel/flush, estado disposed e geração para ignorar respostas tardias. Definir quais operações stop cancela e quais precisa concluir. Não cancelar gravações duráveis já aceitas sem um contrato explícito.

### 11. P2 — painéis flutuantes podem ficar fora da janela após resize

Referências: `src/browser/main.ts:634`, `src/surfaces/canvas/hud.ts:254`.

O host evita `setMode` quando os flags de layout não mudam; a operação também faz o clamp dos painéis. Reduzir a janela de 1.500 para 1.200 pixels dentro da mesma categoria pode deixar um painel posicionado à direita com cabeçalho/fechar fora da área visível.

Correção: clamp em toda mudança real do viewport, independente da categoria. Testar painel arrastado para borda, resize dentro da categoria e viewport reduzido pelo teclado virtual. Achado por análise do caminho; sem validação visual real nesta revisão.

### 12. P2 — perda de foco pode deixar espaço de pan ativo

Referência: `src/surfaces/canvas/input.ts:231` e `:253`.

Space é global, inclusive sobre botões, e só keyup limpa o flag. Segurar espaço e trocar de aplicativo antes de soltá-lo pode deixar o próximo gesto de construção interpretado como pan.

Correção: restringir shortcuts ao contexto adequado e limpar teclas/gestos em blur e mudanças de visibilidade. Testar perda de foco com botão pressionado. Achado estático.

## Responsividade e performance: ações de desenho

1. **Isolar trabalho pesado.** `client/versions.ts:304` chama `runScenario` síncrono para dois futuros de 60 ticks. `Promise.all` não paraleliza CPU. Parsing/validação de bundles aceita até 64 MiB e também é síncrono. Medir long tasks nessas operações e, conforme resultado, mover cálculo portátil para worker ou dividir em lotes com yields, progresso e cancelamento. O bloqueio potencial é comprovado pelo caminho; sua duração não foi medida.
2. **Usar orçamento de frame.** O scheduler já invalida por demanda e limita ambient a 30 FPS, o que é positivo. Adaptar qualidade visual ao tempo de frame observado; reduzir movimento decorativo quando não visível, em modo economia e com preferência por movimento reduzido. Não alterar ticks/regras da simulação conforme hardware.
3. **Evitar custo quadrático em gestos.** `presentation/strokes.ts:48` busca com `some` em cada célula. O teto de 1.024 limita o dano, mas Set de coordenadas evita buscas repetidas. `core/quote.ts` também copia edits a cada célula; avaliar um builder local por chunk compartilhado com a validação de comandos. Só mudar após benchmark e teste de equivalência.
4. **Separar carregamento inicial de funções opcionais.** O build gera um JS principal de 166,50 kB gzip. Investigar imports dinâmicos para multiplayer, export/import e planejamento. O tamanho sozinho não prova lentidão; medir cold start, warm start e parse/execute antes de estabelecer um alvo.
5. **Instrumentação de interação.** Acrescentar duração pointer→frame, tick, save, decode, import, cenário e gravação do checkpoint; p50/p95 e long tasks. FPS sozinho não revela atraso do input ou pressão de memória. Evitar telemetria remota como requisito para diagnóstico local.
6. **Decodificação visual ainda ocorre no main thread.** `adapters/osm/provider.ts:67` chama `decodeVisualTile` síncrono; `adapters/osm/decode.ts:33` percorre features/geometrias. O worker atual cobre chunks da simulação, não esse caminho visual. Medir esse decode e estender o port do worker se o custo justificar.
7. **HUD durante arrasto direto.** `browser/main.ts:772` agenda atualização completa para mudanças do client; em `:670`, moving representa glide, não gesto direto. Portanto o arrasto pode cair no caminho de HUD completo apesar do comentário de otimização. Separar dirtiness de câmera/hover/estado e publicar gesto ativo; medir quantidade e custo das atualizações DOM.
8. **Precisão das métricas.** `frame-scheduler` conta drawn quando chama draw; o browser pode depois evitar render via sameFrame. Separar callback de frame e execução efetiva do renderer antes de usar esses números para decisões.

## Off-line e recursos locais

Há boas proteções: save ilegível não é sobrescrito automaticamente; mapas são limitados em concorrência; regiões verificam leitura após escrita e reavaliam cobertura depois de eviction; dados administrados são duráveis e separados dos transitórios.

Ainda falta uma política integrada de recursos. A busca no código encontrou DPR limitado e detecção de pointer coarse, mas não uso de `storage.estimate/persist`, `saveData`, `deviceMemory`, `hardwareConcurrency` ou reduced-motion. Recomendações:

- Compor um port pequeno de capacidades no browser; retornar desconhecido quando uma API não existir. Usar detecção de capacidades, sem inferir dispositivo por user agent.
- Medir quota/uso aproximados por origem; separar orçamento de shell, tiles, chunks normalizados e história. `navigator.storage.estimate()` é aproximado; `persist()` pode ser recusado. Fontes: https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/estimate e https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/persist.
- Evictar primeiro dados recuperáveis; conservar saves, bases administradas e histórico alcançável. O módulo de retenção já fornece parte desse vocabulário; conectar a política ao host e apresentar exportação quando faltar espaço.
- Mostrar região, cobertura e uso antes/depois de preparar off-line. Diferenciar pausa do usuário, orçamento atingido e falha de rede. Hoje `region-cache.ts:35` marca orçamento como stopped e o controller oferece continuar, embora o mesmo orçamento possa impedir qualquer progresso.
- Propagar cancelamento onde possível. Hoje a pausa é cooperativa entre tiles; o fetch em andamento e a varredura final não recebem o AbortSignal da região. Definir tempo máximo de resposta à pausa.
- Tratar “app instalado”, “shell disponível”, “região disponível” e “save persistido” como estados independentes. Um botão de download concluído não garante que o navegador conservará os dados para sempre.
- Dimensionar limites por bytes além de contagem de entradas. `core/simulation.ts:111` conserva memo global por id de chunk sem eviction; visitar/jogar mundos com coordenadas distintas pode reter arrays derivados. Preferir memo de vida útil da sessão, WeakMap onde adequado ou limite com métricas. Impacto não medido.

## SOLID, Clean Architecture e simplicidade

**Preservar:** núcleo determinístico, ports de tempo/mapa/save, separação de superfícies e adaptadores, estado interoperável preservando componentes desconhecidos e testes de equivalência. Não é necessário converter funções em classes para aplicar SOLID.

**SRP:** `browser/main.ts` tem 908 linhas e mistura composição, DOM, câmera, HUD, render loop, off-line e instalação. Extrair composição de ports, lifecycle do host e instalação do shell. `city-client.ts` tem 642 linhas e reúne interação, streaming, fatos, tempo, versões e sessão; extrair controladores por responsabilidade, conservando a fachada usada pelas três superfícies.

**ISP e DIP:** `ActionRouter` combina métodos de ação com `Partial<SessionRouter>`; capacidades opcionais exigem branches em runtime. Separar portas de ação local, sessão cooperativa e persistência. Apresentar composição de capacidades explícita ao client. Modelos de apresentação carregam callbacks (`HistoryInfo.compare`); preferir dados + intents para facilitar serialização/worker e reduzir acoplamento entre modelo e execução.

**Portabilidade real:** `presentation/frame-scheduler.ts:25` lê globalThis com performance/document/RAF/timers e fallback em Date. Compilar sem DOM não torna esse módulo independente da plataforma. Injetar esses ports no host ou mover o scheduler para uma camada de runtime; manter a lógica de decisão pura em presentation.

**OCP:** preservar ports estáveis para novas fontes, storage e superfícies. Evitar uma generalização antecipada do renderer; definir extensão somente onde existe segunda implementação ou requisito concreto.

**LSP:** adicionar testes de contrato reutilizáveis entre stores e transports: deadlines, reabertura, erros, identidade de conteúdo, ordering, cancelamento e reconexão. Testes apenas de happy path não garantem substituibilidade.

**Testes de arquitetura:** `tests/architecture.test.ts` verifica import graph por tokenizer e permite exceções amplas para adapters. Templates e regex têm limites conhecidos; aliases/platform reads não são plenamente cobertos. Melhorar os guardrails com testes positivos/negativos do extrator e limites por subcamada. Usar uma ferramenta de análise de dependências apropriada após avaliar compatibilidade do compilador; evitar criar outro parser ad hoc.

**Legibilidade:** muitos arquivos comprimem várias operações em uma linha. Aplicar formatter em mudança dedicada, sem misturar com correções funcionais. Reduzir comentários históricos que repetem a implementação; conservar invariantes e motivos das decisões.

## Código morto confirmado e cautelas

O check adicional encontrou em produção `_PREVIEW_FUTURE_TICKS` (`browser/main.ts:78`) e `_currentView` (`:440`) sem leitura. Encontrou também parâmetros sem uso em `world-indexed-db.ts:59`, `main.ts:661`, `strokes.ts:36`, `replica-session.ts:388` e `canvas-renderer.ts:221`.

Remover bindings locais mortos; preservar assinaturas quando necessárias ao contrato. Ativar noUnusedLocals/noUnusedParameters após limpar os diagnósticos. Não concluir que exports públicos, fixtures ou adaptadores opcionais estão mortos apenas por não participarem do bundle browser. A detecção completa de exports inacessíveis precisa considerar tools, testes e pontos de entrada públicos.

## Práticas por interface

| Interface | Prioridades |
|---|---|
| Browser mouse/teclado | Contexto explícito de atalhos; modificadores; foco restaurado; navegação e construção sem depender de pointer; feedback de operação longa. |
| Touch | Slop em CSS; pointercancel; alvos consistentes; rotação/pinch sem confundir seleção; testar DPR, orientação e teclado virtual. |
| Canvas/acessibilidade | `index.html:14` possui aria-label, mas o mapa não oferece seleção/construção equivalente por teclado e semântica das células. Disponibilizar cursor lógico, descrição textual e ações DOM; testar leitor de tela. A existência do CLI não substitui acesso ao browser. |
| Painéis DOM | Conferir semântica de menu/dialog, foco inicial/retorno, Esc e comportamento ao ocultar. Há implementação de foco: testar suas garantias em vez de presumir ausência. |
| Terminal | Validar JSON antes de convertê-lo a Intent (`surfaces/text/parse.ts:91`), impor limites de ticks/duração no client e garantir cleanup em falhas. Hoje JSON cru é apenas cast e `city-client.ts:543` deixa o teto ao caller. |
| JSON/agente | Contrato de erro uniforme inclusive JSON inválido; schema e limites de entrada; operações consistentes entre quote e act. `city-json.ts:29` aceita tick/component, mas applyAction os recusa: alinhar capacidade declarada. Manter stdout exclusivo para respostas. |
| Multiplayer | Estado de reconexão/epoch explícito; readiness por link; backpressure e limite de objetos; contrato para mudança de papel e perda de persistência. |

## Sequência sugerida

1. Corrigir deadlines/reabertura do storage, readiness WebRTC e parser; adicionar regressões dos cenários descritos.
2. Corrigir cobertura parcial, atalhos e slop; testar escala e foco.
3. Versionar/limitar shell cache; melhorar cancelamento e comunicação de orçamento off-line; integrar quota/retention.
4. Medir interações em navegador real: cidade pequena/grande, DPR 1/2, CPU limitada, rede lenta/off-line e storage bloqueado. Usar os resultados para decidir worker, qualidade adaptativa e lazy loading.
5. Extrair responsabilidades e limpar código sem uso em alterações pequenas, preservando contratos e equivalência entre interfaces.

Critérios de aceite: cache travado não trava o jogo; reconnect aguarda canais novos; detalhe parcial conserva cobertura; nenhum atalho do navegador é roubado; stop não inicia novos trabalhos; atualização conserva shell consistente; operação pesada possui limite/progresso e orçamento medido; estado determinístico permanece igual entre runtimes.
