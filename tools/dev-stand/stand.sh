#!/bin/bash
# Пересборка постоянного локального стенда (ITGAME-123), make stand.
# Собирает клиент и сервер из рабочего дерева, раскладывает их в
# ~/.local/share/itgame-dev (bin/, dist/, saves/), ставит unit
# itgame-dev.service в ~/.config/systemd/user, перезапускает его и ждёт, что
# :15555 отдаёт ровно ту сборку, что только что собрана (по <meta name="build">).
# Пересборка только по команде: хук на коммит дёргал бы стенд на каждом WIP.
set -euo pipefail

REPO=$(cd "$(dirname "$0")/../.." && pwd)
STAND=$HOME/.local/share/itgame-dev
UNIT=itgame-dev.service
URL=http://127.0.0.1:15555/

say() { printf '%s\n' "stand: $*"; }
fail() { printf '%s\n' "ОШИБКА (stand): $*" >&2; exit 1; }
build_meta() { grep -o '<meta name="build" content="[^"]*"' | sed 's/.*content="\([^"]*\)"/\1/'; }

cd "$REPO"
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  say "ВНИМАНИЕ: рабочее дерево грязное — в стенд уедут незакоммиченные правки поверх $(git rev-parse --short HEAD)"
fi

say "клиент: npm run build"
out=$(cd client && npm run build 2>&1) || { printf '%s\n' "$out" >&2; fail "сборка клиента"; }

say "сервер: go build"
mkdir -p "$STAND/bin" "$STAND/dist" "$STAND/saves"
(cd server && go build -o "$STAND/bin/itdirector.new" ./cmd/server)
# rename(2) поверх работающего бинаря — без «text file busy».
mv -f "$STAND/bin/itdirector.new" "$STAND/bin/itdirector"
rsync -a --delete client/dist/ "$STAND/dist/"
want=$(build_meta < "$STAND/dist/index.html")

install -Dm644 "tools/dev-stand/$UNIT" "$HOME/.config/systemd/user/$UNIT"
systemctl --user daemon-reload
systemctl --user enable --quiet "$UNIT"
systemctl --user restart "$UNIT"

got=
for _ in $(seq 1 30); do
  got=$(curl -s -m 2 "$URL" | build_meta || true)
  [ -n "$got" ] && break
  sleep 1
done
if [ "$got" != "$want" ]; then
  journalctl --user -u "$UNIT" -n 20 --no-pager >&2 || true
  fail "$URL отдаёт сборку '${got:-нет ответа}', ждали '$want'"
fi
say "OK ${URL}?debug=1 — сборка $got"
