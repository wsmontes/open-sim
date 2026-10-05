# Resposta da UI e confiabilidade local

## Intenção e decisões

O usuário autorizou especificação, plano e implementação autônomos a partir da revisão de 4 de outubro. O objetivo é tornar os fluxos existentes confiáveis, acessíveis e econômicos, preservando as mesmas regras e estado entre browser, terminal e JSON.

Adotamos correções incrementais com ports pequenos. A entrega preserva a organização existente e extrai responsabilidades onde os requisitos pedem. Não alteramos formato durável, regras econômicas ou protocolo. Não adicionamos dependências. Mudanças permanecem no worktree para revisão; publicação não faz parte desta entrega.

## Requisitos

1. Toda abertura de IndexedDB possui deadline recuperável (8 segundos padrão), fecha sucesso tardio e reabre depois de versionchange/erro. Caches descartáveis falham como miss; saves falham com mensagem. Leituras de cache não prendem todos os slots do provider. Fonte dos bytes participa da chave.
2. Readiness WebRTC pertence a uma conexão: callbacks antigos não podem resolver/rejeitar a nova. Reconectar depois de sucesso e de falha deve aguardar os canais novos.
3. Parser JSON estrito recusa chaves reservadas em qualquer profundidade antes de atribuição; nunca modifica protótipos.
4. Detalhe parcial mantém cobertura provisória do mapa. Parents desenham somente áreas ainda sem detalhe, evitando geometrias duplicadas.
5. Teclado respeita Ctrl/Meta/Alt, composição e eventos já consumidos. Space em controles DOM não arma pan; blur cancela gesto. Tap tem tolerância de 6 pixels CSS em todas as escalas. Canvas focável oferece cursor por células, inspeção e construção por teclado, feedback textual e instruções. Painéis são reposicionados em resize dentro da mesma categoria.
6. Debounce é cancelável. stop impede novos efeitos e ignora respostas tardias; gravação durável já iniciada pode concluir. Limite de tick de 10.000 vale no client, inclusive intents do terminal. JSON cru é validado antes de executar; quote e act anunciam somente ações suportadas.
7. Shell off-line usa cache por build, instalação consistente de assets essenciais e limpeza que preserva versões usadas por abas abertas. Não guarda qualquer GET indiscriminadamente. Abrir off-line usa cache sem esperar rede; respostas online continuam válidas mesmo se cache falhar.
8. Preparação de região diferencia orçamento, pausa e falha; orçamento atingido não sugere retomada impossível. Cancelamento pode interromper fetch/espera do chamador e varredura final. Informar quota aproximada e persistência, com fallback quando APIs não existem. Sem perda automática de saves/história.
9. Decodificação visual usa o mesmo port de worker dos chunks, com fallback equivalente e métricas de decode; falha de request não deve produzir fetch duplicado. Preferência de movimento reduzido limita animação decorativa e glide sem alterar simulação. Detecção de recursos tem fallback explícito, sem user agent.
10. HUD coalesce mudanças e distingue câmera/hover de estado para evitar trabalho DOM completo por pointermove. Diagnóstico separa frames do scheduler e renders reais. Memo da simulação tem limite, sem alterar resultados. Remover bindings mortos e simplificar buscas por células mantendo teto de 1.024.

## Arquitetura e responsabilidade

- Adaptador comum de abertura de banco suporta upgrade específico de cada store.
- Provider controla bytes, namespace e cancelamento; cache não conhece UI.
- Input controla gestos/cursor; client mantém intenções e limites; HUD recebe modelos.
- Browser compõe capacidades locais e instalação do shell em módulos próprios.
- Scheduler recebe plataforma pelo host; presentation não precisa consultar globais.
- Worker executa decodes portáveis; nenhuma decisão de simulação depende de hardware.

## Aceite e validação

Regressões exercitam storage sem resposta e sucesso tardio, versionchange, reconexão, protótipos, cobertura parcial, DPR 1/2, shortcuts, blur, teardown, orçamento/cancelamento, worker/fallback e instalação off-line. Executar check, build e benchmark real quando disponível; registrar limitações. Revisão independente final verifica erros, cleanup e consistência entre superfícies.

## Limites de escopo

A divisão geral de city-client/world-repository e revisão de todos os comentários não será uma reescrita estética: extrair somente responsabilidades exigidas pelos requisitos. HardwareConcurrency/deviceMemory/saveData são sinais opcionais; orçamento medido e preferências explícitas prevalecem. Comparações de futuros executam lotes de cinco ticks com yield do host, progresso e cancelamento; terminal mantém execução síncrona equivalente. Não introduzir heurísticas que mudam a simulação nem nova telemetria remota.
