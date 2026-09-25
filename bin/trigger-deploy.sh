#!/usr/bin/env bash
# Запуск прод-деплоя itgame.santarinto.com через on-box webhook. Ни чекаута,
# ни SSH не нужно — только общий HMAC-секрет.
#
#   DEPLOY_HOOK_SECRET=... bin/trigger-deploy.sh <sha>
#
# sha — полный 40-hex коммит, прошедший тесты. Бокс ресетится на него, а не на
# origin/main: иначе гонка двух пайплайнов выкатит непротестированный коммит
# (playbook §9a). Без sha бокс задеплоит origin/main (ручной аварийный режим).
set -euo pipefail

: "${DEPLOY_HOOK_SECRET:?set DEPLOY_HOOK_SECRET (the webhook HMAC secret)}"
URL="${DEPLOY_URL:-https://itgame.santarinto.com/api/deploy}"
SHA="${1:-}"

BODY=$(printf '{"sha":"%s"}' "${SHA}")
SIG=$(printf '%s' "${BODY}" | openssl dgst -sha256 -hmac "${DEPLOY_HOOK_SECRET}" -hex | sed 's/^.* //')

echo "Triggering deploy (sha='${SHA}') → ${URL}"
curl -fsS --max-time 900 -X POST "${URL}" \
  -H 'Content-Type: application/json' \
  -H "X-Hub-Signature-256: sha256=${SIG}" \
  -d "${BODY}"
