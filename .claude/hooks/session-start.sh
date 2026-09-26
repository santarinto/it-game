#!/bin/bash
# SessionStart-хук для Claude Code on the web: готовит свежий контейнер,
# чтобы сразу работали make test / make build / make smoke-ui / visreg
# и тест слоя БД. Локально (не в облаке) ничего не делает.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}"
ENV_FILE=${CLAUDE_ENV_FILE:-/dev/null}

# Go: тулчейн из go.mod скачивается сам (GOTOOLCHAIN=auto), модули — сюда же.
(cd server && go mod download)

# Клиент: ci, а не install — npm 10 образа переписывает lock от npm 11
# (поля libc) и пачкает дерево в каждой сессии.
(cd client && npm ci --no-audit --no-fund --loglevel=error)

# Chromium: в образе Playwright-сборка, не /usr/bin/chromium, которую ищут
# smoke-ui, visreg и check-sprites (часть npm run build).
chrome=$(find /opt/pw-browsers -path '*/chromium-*/chrome-linux/chrome' -type f 2>/dev/null | sort -V | tail -1 || true)
if [ -n "$chrome" ]; then
  echo "export CHROME_PATH=$chrome" >> "$ENV_FILE"
else
  echo "session-start: chromium не найден — smoke-ui/visreg/build без CHROME_PATH упадут" >&2
fi

# PostgreSQL: поднять кластер, завести роль и две базы — рабочую (для
# /admin в make dev) и тестовую (TEST_DATABASE_URL, тест internal/db).
if command -v pg_isready >/dev/null; then
  service postgresql start >/dev/null
  for _ in $(seq 1 30); do
    pg_isready -q -h localhost && break
    sleep 1
  done
  pg_isready -q -h localhost
  psql_pg() { su postgres -c "psql -v ON_ERROR_STOP=1 -tAc \"$1\""; }
  [ "$(psql_pg "SELECT 1 FROM pg_roles WHERE rolname='itd'")" = "1" ] ||
    psql_pg "CREATE ROLE itd LOGIN PASSWORD 'itd'"
  for db in itdirector itdirector_test; do
    [ "$(psql_pg "SELECT 1 FROM pg_database WHERE datname='$db'")" = "1" ] ||
      su postgres -c "createdb -O itd $db"
  done
  echo "export DATABASE_URL=postgres://itd:itd@localhost:5432/itdirector" >> "$ENV_FILE"
  echo "export TEST_DATABASE_URL=postgres://itd:itd@localhost:5432/itdirector_test" >> "$ENV_FILE"
else
  echo "session-start: PostgreSQL не установлен — тест БД будет SKIP" >&2
fi
