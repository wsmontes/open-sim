#!/usr/bin/env bash
# Publica o jogo no GitHub Pages.
#
# O Pages serve o último commit de uma branch, e este repositório não tem CI (foi removido por custo), então publicar é:
# construir, escrever o resultado numa branch própria e empurrá-la. A branch de trabalho nunca recebe artefato de build:
# o que sobe é um commit órfão, que não carrega o histórico do jogo atrás de si, e a publicação é idempotente — rodar
# duas vezes seguidas publica o mesmo estado.
set -euo pipefail
repo=$(cd "$(dirname "$0")/.." && pwd)
cd "$repo"

# Sem CI, o gate é aqui: nada vai para o ar com typecheck ou teste vermelho.
echo "→ verificando"
npm run check
echo "→ construindo"
npm run build

# Publicar o que ninguém revisou é a única forma de um site publicado mentir sobre o código: a árvore tem de estar
# limpa, e o commit que está indo para o ar fica escrito na mensagem do commit de publicação.
if [ -n "$(git status --porcelain)" ]; then
 echo "A árvore de trabalho tem alterações não commitadas. Faça o commit antes de publicar." >&2
 git status --short >&2
 exit 1
fi
published=$(git rev-parse --short HEAD)
branch=$(git rev-parse --abbrev-ref HEAD)

# Um worktree temporário, para que o checkout da branch publicada não mexa no que o jogador tem aberto na sua.
room=$(mktemp -d)
trap 'git worktree remove --force "$room/pages" >/dev/null 2>&1 || true; rm -rf "$room"' EXIT
git worktree add -q --detach "$room/pages" HEAD
cd "$room/pages"
# A branch that already exists would make `--orphan` fail, and publishing has to work the second time as well as the
# first: the local branch is discarded and rebuilt from the build output, and the push below replaces the remote one.
git branch -D gh-pages >/dev/null 2>&1 || true
git checkout -q --orphan gh-pages
git rm -rq --cached . >/dev/null 2>&1 || true
find . -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
cp -R "$repo/dist/." .

# O Pages roda Jekyll por padrão, e o Jekyll ignora diretórios que começam com underscore. Hoje os assets são
# `assets/index-*.js`, mas o arquivo custa zero e a regra deixa de ser uma surpresa no dia em que um deles mudar.
touch .nojekyll

git add -A
git commit -q -F - <<MESSAGE
deploy: publish the build of $published

Built from $branch at $published by tools/deploy-pages.sh.
MESSAGE
echo "→ enviando a branch gh-pages"
git push -f -q origin gh-pages
echo "✓ publicado o commit $published"
echo "  o Pages constrói em alguns minutos; confira com: curl -sI https://wsmontes.github.io/open-sim/ | head -1"
