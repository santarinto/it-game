#!/usr/bin/env bash
# Атомарный деплой itgame.santarinto.ru (IT Director). Запускается на боксе
# обёрткой /usr/local/bin/itgame-deploy (та держит flock и уже сделала
# git reset в repo/ на протестированный SHA из payload вебхука).
#
#   bash /opt/itgame/repo/bin/deploy-local.sh [sha]
#
# Собирает НОВЫЙ каталог releases/<id> и свопает симлинк current только при
# успехе — прод всё это время живёт на старом релизе. Любое падение до свопа
# оставляет прод нетронутым.
#
# Раскладка (паттерн gitflic-ci-cd-playbook §5, как у my.santarinto.ru):
#   repo/      — чекаут gitflic, источник сборки
#   releases/  — собранные релизы, храним последние KEEP
#   shared/    — то, чего нет в git: itgame.env (будущая БД), логи деплоя
#   current    — симлинк на активный релиз
set -euo pipefail

APP_DIR=/opt/itgame
REPO="${APP_DIR}/repo"
RELEASES="${APP_DIR}/releases"
KEEP=3
GO=/usr/local/go/bin/go

say() { printf '\n\033[36m==> %s\033[0m\n' "$*"; }

cd "${REPO}"
SHA=$(git rev-parse --short HEAD)
ID="$(date +%Y%m%d-%H%M%S)-${SHA}"
REL="${RELEASES}/${ID}"
say "релиз ${ID}: $(git log -1 --pretty=%s)"

# Падение до свопа: убрать недособранный каталог, прод не тронут.
cleanup_failed() {
    [ -d "${REL}" ] && rm -rf "${REL:?}"
    echo "ДЕПЛОЙ УПАЛ — current не тронут, прод работает на старом релизе" >&2
}
trap cleanup_failed ERR

say "1/5 выгрузить код в ${REL}"
mkdir -p "${REL}"
# git archive, а не cp: в релиз попадает только то, что в КОММИТЕ.
git archive HEAD | tar -x -C "${REL}"

say "2/5 сборка клиента (node_modules сносим — нужен только на сборку)"
( cd "${REL}/client" && npm ci --no-audit --no-fund && npm run build && rm -rf node_modules )

say "3/5 сборка сервера (Go)"
( cd "${REL}/server" && "${GO}" build -trimpath -o "${REL}/bin/itdirector" ./cmd/server )

# ─── ТОЧКА НЕВОЗВРАТА ────────────────────────────────────────────────────────
say "4/5 АТОМНЫЙ СВОП current -> ${ID} + рестарт сервиса"
trap - ERR
ln -sfn "${REL}" "${APP_DIR}/current.tmp"
mv -T "${APP_DIR}/current.tmp" "${APP_DIR}/current"   # rename(2) — атомарен
# Сейвы сессий живут в shared/ (ITGAME-8): переживают смену релиза. Рестарт
# рвёт активные WS, но клиент переподключается с тем же sid и продолжает
# партию с последнего тика (каталог подхватывается сервером автоматически).
mkdir -p "${APP_DIR}/shared/saves"
sudo systemctl restart itgame

say "проверка: сервис поднялся и отвечает"
CODE=""
for _ in 1 2 3 4 5; do
    sleep 1
    CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:8080/admin || true)
    [ "${CODE}" = "200" ] && break
done
if [ "${CODE}" != "200" ]; then
    # После точки невозврата: прод РЕАЛЬНО сломан, честно роняем деплой.
    echo "ПРОВАЛ: /admin отвечает '${CODE}' — journalctl -u itgame -n 50" >&2
    exit 1
fi
echo "  /admin → 200, PID $(systemctl show -p MainPID --value itgame)"

# Подчистка — после точки невозврата: её провал НЕ валит успешный деплой.
say "5/5 подчистка старых релизов (храним ${KEEP})"
OLD=$(cd "${RELEASES}" && ls -1dt -- */ 2>/dev/null | tail -n +$((KEEP + 1)) | sed 's#/##')
if [ -n "${OLD}" ]; then
    for rel in ${OLD}; do
        if rm -rf "${RELEASES:?}/${rel}"; then
            echo "  убран: ${rel}"
        else
            echo "  ВНИМАНИЕ: не удалось убрать ${rel} — деплой это не отменяет" >&2
        fi
    done
else
    echo "  нечего убирать"
fi

say "DONE → https://itgame.santarinto.ru (${ID})"
