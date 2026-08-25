#!/usr/bin/env bash
# gen-sprites — dev-time пайплайн генерации спрайтов внешним AI-сервисом
# (ITGAME-6). НЕ runtime: игра остаётся офлайн, в репо коммитятся готовые
# PNG из client/public/assets/sprites/.
#
# Одна команда: промпты из prompts.txt → API → 256×256 → remap.sh
# (downscale + Sweetie-16) → client/public/assets/sprites/<имя>.png.
#
# Ключ берётся из .env корня репо (gitignored): SPRITES_API_KEY=...
# Опционально: SPRITES_API_URL, SPRITES_API_MODEL — под конкретный сервис.
#
# ВНИМАНИЕ: интеграционная часть (формат запроса/ответа) написана по
# публичной документации Leonardo AI REST и НЕ проверена живым ключом —
# ключа не было на момент задачи. Перед первым прогоном сверься с
# актуальной документацией своего сервиса (см. README, раздел «Ассеты»).
set -euo pipefail
cd "$(dirname "$0")/.."

KEY=${SPRITES_API_KEY:-$(grep -E '^SPRITES_API_KEY=' .env 2>/dev/null | cut -d= -f2)}
if [[ -z "${KEY}" ]]; then
  echo "Нет SPRITES_API_KEY (в .env корня или в окружении) — генерация недоступна." >&2
  echo "Бесключевые части пайплайна: scripts/sprites/remap.sh (постобработка), куриция LocalMind." >&2
  exit 2
fi
URL=${SPRITES_API_URL:-https://cloud.leonardo.ai/api/rest/v1/generations}
MODEL=${SPRITES_API_MODEL:-b24e16ff-06e3-43eb-8d33-4416c2d75876} # Leonardo Phoenix
OUT=${SPRITES_OUT:-client/public/assets/sprites}
SIZE=32 # игровой размер после постобработки

mkdir -p "$OUT" .gen-sprites
trap 'rm -rf .gen-sprites' EXIT

# Стиль-префикс: единый стиль сета — суть пайплайна.
STYLE="top-down 2D game sprite, flat pixel art style, clean silhouette on solid background, no text, no watermark, centered, high contrast"

while IFS='|' read -r name prompt; do
  [[ -z "$name" || "$name" == \#* ]] && continue
  echo "→ $name"
  # 1. Генерация.
  resp=$(curl -sf -X POST "$URL" \
    -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
    -d "{\"modelId\":\"$MODEL\",\"prompt\":\"$STYLE. $prompt.\",\"width\":512,\"height\":512,\"num_images\":1}")
  # 2. Забрать URL результата (поллинг статуса генерации).
  gen_id=$(printf '%s' "$resp" | python3 -c 'import json,sys; print(json.load(sys.stdin)["sdGenerationJob"]["generationId"])')
  img=""
  for _ in $(seq 1 30); do
    sleep 3
    img=$(curl -sf "$URL/$gen_id" -H "Authorization: Bearer $KEY" \
      | python3 -c 'import json,sys; d=json.load(sys.stdin)["generations_by_pk"]; print(d["generated_images"][0]["url"] if d["status"]=="COMPLETE" else "")' || true)
    [[ -n "$img" ]] && break
  done
  [[ -z "$img" ]] && { echo "  таймаут генерации $name"; continue; }
  # 3. Скачать и постобработать в палитру игры.
  curl -sf "$img" -o ".gen-sprites/$name.png"
  scripts/sprites/remap.sh ".gen-sprites/$name.png" "$OUT/$name.png" "$SIZE"
  # 4. Куриция: прогнать вектор читаемости через LocalMind можно командой
  #    из README (раздел «Ассеты») и при необходимости перегенерировать.
  echo "  готово: $OUT/$name.png"
done < scripts/sprites/prompts.txt
