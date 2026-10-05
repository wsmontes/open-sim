# Integração do trabalho do DeepSeek

Integração dos seis commits d2f2776..c86acc1 da branch codex/open-sim-design com a arquitetura de dados, relevo, mobilidade e worker/GPU de codex/vancouver-data-mobility. A branch original do DeepSeek foi preservada.

Foram incorporados o cache de valores derivados por vizinhança, o reuso dos endereços de conteúdo de commits, os índices compactos de footprints/cruzamentos, a consulta de edições visíveis, a leitura reutilizada do retângulo do canvas e o resize/layout de celular agrupado. O índice de cortes agora trabalha também na preparação persistente da cena, conservando projeção, fundações e ordem de profundidade do relevo.

Correções desta integração:

- Grade CSR limitada a262144bins, incluindo pontos muito afastados; buffers de candidatos não truncam colisões, e cruzamentos repetidos são deduplicados.
- Área candidata dos cruzamentos expandida pelo intervalo de elevação dos tiles carregados; ruas elevadas que entram na tela continuam desenhadas.
- Referência independente da simulação atualizada para regras5/calibração municipal antes da comparação com o cache.
- JSON público mutável serializado e validado novamente; cache por identidade restrito a JSON profundamente congelado com propriedades de dados. Getters não são tratados como conteúdo constante. A detecção é limitada e reconhece ciclos, preservando erros de profundidade da validação.
- Objetos externos recebidos pelo repositório sempre são codificados e verificados novamente contra seu hash.
- Retângulo do ponteiro invalidado quando o viewport muda, antes de reconfigurar o backing buffer; ResizeObserver compartilha o mesmo agrupamento120ms dos demais eventos móveis.
- Horário interno da mobilidade atualizado sem avisar o próprio agendador; a pausa deixa de produzir um ciclo de quadros redundantes.

## Verificação

`npm run check`:1003testes passaram,5ignorados,144arquivos; typecheck aprovado,10avisos de lint existentes. `npm run build`: aprovado; aviso conhecido do bundle principal acima500kB. Não foram feitas novas rodadas longas de benchmarking nem é afirmado um ganho percentual geral.

Verificação nativa: execução em Vancouver com carros, caminhões, pedestres, ônibus e polícia; rotação; dia/noite; viewport390×844 e retorno ao desktop. População municipal662248/2021 mantida. WebGL2 ativo. As capturas `desktop.png` e `mobile.png` mostram as duas superfícies. A verificação móvel é de viewport do navegador, não de aparelho físico.

O registro `idle.json` compara dois snapshots depois de estabilizar a cidade pausada. Recursos contabilizados são do aplicativo, não todo o heap do navegador/GPU. Metal segue dependendo do backend do navegador, sem verificação direta.

## Revisão e decisões

Revisão independente da integração: nenhum achado crítico;3importantes corrigidos em uma passagem com regressões reproduzidas: visibilidade com relevo, getters congelados e prewalk de JSON profundo. O ponto menor de uma flag/comentário de movimento sem implementação foi removido.

Decisões de integração: manter a composição persistente em worker/GPU ao resolver conflitos do renderer; combinar o índice geral existente com as consultas CSR especializadas; manter o gate semântico do HUD existente; conservar os detalhes durante movimento, pois a reprojeção da imagem pronta já evita seu redesenho na interface; limitar o cache do JSON público a entradas comprovadamente imutáveis, preservando ownership e comportamento de saves. Custo: alguma serialização de conteúdo mutável permanece, evitando bytes/validação obsoletos.

Itens excluídos pelo revisor foram considerados: benchmark longo permanece pendente conforme o escopo de desenvolvimento; interação em aparelho físico não é reivindicada, sendo coberta aqui apenas a dimensão móvel nativa; qualidade integral de todos os terrenos não foi reavaliada, mas regressão elevada e capturas foram verificadas; deploy é tratado pelo executor após checks/build, fora da revisão de código.
