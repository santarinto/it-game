#!/usr/bin/env bash
# gen-sprites — dev-time пайплайн спрайтов через PixelLab API (ITGAME-6).
# НЕ runtime: игра офлайн, в репо коммитятся готовые PNG из
# client/public/assets/sprites/.
#
# Использование: scripts/gen-sprites.sh [имя]   # один спрайт или все из prompts.txt
#
# Ключ: SPRITES_API_KEY в .env корня (gitignored) или в окружении.
# API: POST /v2/create-image-pixen (64×64, transparent bg, фиксированный
# seed на имя — воспроизводимость перегенерации), ответ base64 PNG.
# Постобработка: scripts/sprites/remap.sh — квантизация в Sweetie-16
# (палитру API не форсит, выравниваем сет сами).
# Баланс: curl /v2/balance.
set -euo pipefail
cd "$(dirname "$0")/.."

source .env 2>/dev/null || true
KEY=${SPRITES_API_KEY:?Нет SPRITES_API_KEY в .env корня репо}
API=https://api.pixellab.ai/v2
OUT=${SPRITES_OUT:-client/public/assets/sprites}
SIZE=${SPRITES_SIZE:-64}
mkdir -p "$OUT" .gen-sprites
trap 'rm -rf .gen-sprites' EXIT

# Стабильный seed из имени: одинаковый промпт+seed = одинаковый результат
# при перегенерации конкретного спрайта.
seed_of() { echo -n "$1" | cksum | cut -d' ' -f1; }

gen_one() {
  local name=$1 prompt=$2 override_seed=${3:-}
  local seed
  # Seed стабилен по имени (воспроизводимость), но куриция могла
  # забраковать результат — третье поле в prompts.txt задаёт новый seed.
  seed=${override_seed:-$(seed_of "$name")}
  echo "→ $name (seed $seed)"
  local resp
  resp=$(curl -sf --max-time 90 -X POST "$API/create-image-pixen" \
    -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
    -d "$(python3 - "$prompt" "$seed" "$SIZE" <<'PYEOF'
import json, sys
print(json.dumps({
    "description": sys.argv[1] + ", flat pixel art game sprite, clean readable silhouette, few colors, no text",
    "image_size": {"width": int(sys.argv[3]), "height": int(sys.argv[3])},
    "no_background": True,
    "seed": int(sys.argv[2]) % 2147483647,
}))
PYEOF
)")
  printf '%s' "$resp" | python3 -c '
import json, base64, sys
r = json.load(sys.stdin)
sys.stdout.buffer.write(base64.b64decode(r["image"]["base64"]))
' > ".gen-sprites/$name.raw.png"
  # Прозрачный фон уже есть; только выравниваем в палитру сета.
  scripts/sprites/remap.sh ".gen-sprites/$name.raw.png" "$OUT/$name.png" "$SIZE"
  echo "  готово: $OUT/$name.png (потрачено: $(printf '%s' "$resp" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("usage",{}))'))"
}

only=${1:-}
while IFS='|' read -r name prompt override_seed; do
  [[ -z "$name" || "$name" == \#* ]] && continue
  if [[ -n "$only" && "$name" != "$only" ]]; then continue; fi
  gen_one "$name" "$prompt" "$override_seed"
done < scripts/sprites/prompts.txt

echo
echo "Баланс: $(curl -sf --max-time 15 "$API/balance" -H "Authorization: Bearer $KEY")"
echo "Куриция: прогнать LocalMind (localmind_recognize) по $OUT/*.png —"
echo "«что изображено, читается ли силуэт на игровом масштабе?»"
