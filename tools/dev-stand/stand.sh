#!/bin/bash
# Постоянный локальный стенд :15555 (ITGAME-123, ITGAME-139).
#
#   stand.sh               make stand: сборка из РАБОЧЕГО дерева (с WIP, если
#                          дерево грязное) — ручная проверка
#   stand.sh init          make stand-init: bare-репо ~/.local/share/itgame-dev/
#                          repo.git с хуком pre-receive, remote «stand» в этом
#                          клоне и первый деплой (git push stand main)
#   stand.sh deploy SRC SHA
#                          зовёт хук pre-receive: сборка дерева SRC (выкладка
#                          запушенного sha, без .git) со штампом SHA
#
# Обе сборки раскладывают бинарь и client/dist в ~/.local/share/itgame-dev
# (bin/, dist/; сейвы — saves/), ставят unit itgame-dev.service, перезапускают
# его и ждут, что :15555 отдаёт ровно эту сборку (<meta name="build">). Не
# поднялась — откат на прежние бинарь и dist, стенд остаётся жив, код ошибки.
set -euo pipefail

REPO=$(cd "$(dirname "$0")/../.." && pwd)
STAND=${ITGAME_STAND:-$HOME/.local/share/itgame-dev}
UNIT=itgame-dev.service
URL=http://127.0.0.1:15555/

say() { printf '%s\n' "stand: $*"; }
fail() { printf '%s\n' "ОШИБКА (stand): $*" >&2; exit 1; }
build_meta() { grep -o '<meta name="build" content="[^"]*"' | sed 's/.*content="\([^"]*\)"/\1/'; }

# serve <src> — разложить собранные client/dist и bin/itdirector.new из <src>,
# перезапустить unit, сверить штамп; при отказе — откат на .prev.
serve() {
  local src=$1 want got
  mkdir -p "$STAND/bin" "$STAND/dist" "$STAND/saves"
  if [ -e "$STAND/bin/itdirector" ]; then
    cp -a "$STAND/bin/itdirector" "$STAND/bin/itdirector.prev"
    rsync -a --delete "$STAND/dist/" "$STAND/dist.prev/"
  fi
  # rename(2) поверх работающего бинаря — без «text file busy».
  mv -f "$STAND/bin/itdirector.new" "$STAND/bin/itdirector"
  rsync -a --delete "$src/client/dist/" "$STAND/dist/"
  want=$(build_meta < "$STAND/dist/index.html")

  install -Dm644 "$src/tools/dev-stand/$UNIT" "$HOME/.config/systemd/user/$UNIT"
  systemctl --user daemon-reload
  systemctl --user enable --quiet "$UNIT"
  systemctl --user restart "$UNIT"

  if got=$(wait_build "$want"); then
    say "OK ${URL}?debug=1 — сборка $got"
    return 0
  fi
  journalctl --user -u "$UNIT" -n 20 --no-pager >&2 || true
  if [ -e "$STAND/bin/itdirector.prev" ]; then
    say "откат на прежнюю сборку"
    mv -f "$STAND/bin/itdirector.prev" "$STAND/bin/itdirector"
    rsync -a --delete "$STAND/dist.prev/" "$STAND/dist/"
    systemctl --user restart "$UNIT"
    wait_build "$(build_meta < "$STAND/dist/index.html")" >/dev/null ||
      say "ВНИМАНИЕ: и прежняя сборка не поднялась — journalctl --user -u itgame-dev"
  fi
  fail "$URL отдаёт сборку '${got:-нет ответа}', ждали '$want'"
}

# wait_build <want> — до 30 с ждать, что стенд отдаёт <want>; печатает, что отдал.
wait_build() {
  local want=$1 got=
  for _ in $(seq 1 30); do
    got=$(curl -s -m 2 "$URL" | build_meta || true)
    [ "$got" = "$want" ] && break
    sleep 1
  done
  printf '%s' "$got"
  [ "$got" = "$want" ]
}

worktree() {
  cd "$REPO"
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    say "ВНИМАНИЕ: рабочее дерево грязное — в стенд уедут незакоммиченные правки поверх $(git rev-parse --short HEAD)"
  fi
  say "клиент: npm run build"
  out=$(cd client && npm run build 2>&1) || { printf '%s\n' "$out" >&2; fail "сборка клиента"; }
  say "сервер: go build"
  mkdir -p "$STAND/bin"
  (cd server && go build -o "$STAND/bin/itdirector.new" ./cmd/server) || fail "сборка сервера"
  serve "$REPO"
}

# deploy <src> <sha7> — сборка выкладки без .git, штамп как у tools/deploy
# (ITGAME-81/98): клиенту BUILD_SHA, серверу -ldflags buildSHA; версия сборки
# (ITGAME-140) — BUILD_VERSION и -ldflags buildVersion.
deploy() {
  local src=$1 sha=$2 lock ver
  # Версия — время коммита по Москве (MSK-3: POSIX TZ, UTC+3 без tzdata); читается, пока мы
  # ещё в bare-репо хука (его GIT_DIR и карантин объектов), в выкладке .git нет. Пусто —
  # сервер не сверяет сейвы, и об этом надо сказать.
  ver=$(TZ=MSK-3 git log -1 --format=%cd --date=format-local:%Y.%m.%d.%H.%M "$sha" 2>/dev/null || true)
  [ -n "$ver" ] || say "ВНИМАНИЕ: версия сборки не определилась (не из хука?) — сейвы сверяться не будут"
  # Хук git отдаёт свои GIT_* (bare-репо, карантин объектов) — сборке они чужие.
  unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_QUARANTINE_PATH \
    GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_PUSH_OPTION_COUNT
  cd "$src"
  lock=$(sha256sum client/package-lock.json | cut -d' ' -f1)
  if [ ! -d client/node_modules ] || [ "$(cat "$STAND/lock.sha256" 2>/dev/null)" != "$lock" ]; then
    say "клиент: npm ci (package-lock сменился или node_modules нет)"
    out=$(cd client && npm ci --no-audit --no-fund 2>&1) || { printf '%s\n' "$out" >&2; fail "npm ci"; }
    printf '%s\n' "$lock" > "$STAND/lock.sha256"
  fi
  say "клиент: npm run build (BUILD_SHA=$sha BUILD_VERSION=$ver)"
  out=$(cd client && BUILD_SHA=$sha BUILD_VERSION=$ver npm run build 2>&1) || { printf '%s\n' "$out" >&2; fail "сборка клиента"; }
  say "сервер: go build ($sha, версия $ver)"
  mkdir -p "$STAND/bin"
  (cd server && go build -trimpath -buildvcs=false \
    -ldflags "-X itdirector/internal/ws.buildSHA=$sha -X itdirector/internal/ws.buildVersion=$ver" -o "$STAND/bin/itdirector.new" ./cmd/server) ||
    fail "сборка сервера"
  serve "$src"
}

init() {
  local bare=$STAND/repo.git
  cd "$REPO"
  mkdir -p "$STAND"
  if [ ! -d "$bare" ]; then
    git init --quiet --bare "$bare"
    say "bare-репо $bare"
  fi
  # main нельзя удалить или переписать: стенд — история того, что видел владелец.
  git -C "$bare" config receive.denyDeletes true
  install -m755 tools/dev-stand/pre-receive "$bare/hooks/pre-receive"
  if git remote get-url stand >/dev/null 2>&1; then
    git remote set-url stand "$bare"
  else
    git remote add stand "$bare"
  fi
  say "remote stand → $bare; деплой: git push stand main"
  git push stand main
}

case "${1:-}" in
  '') worktree ;;
  init) init ;;
  deploy) [ $# -eq 3 ] || fail "usage: stand.sh deploy <src> <sha>"; deploy "$2" "$3" ;;
  *) fail "usage: stand.sh [init | deploy <src> <sha>]" ;;
esac
