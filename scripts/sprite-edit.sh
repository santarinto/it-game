#!/usr/bin/env bash
# sprite-edit — правка существующего спрайта через Gemini (nano banana,
# ITGAME-6): картинка + инструкция → отредактированный PNG → remap
# (client/scripts/sprite-remap.mjs, pngjs) → в client/public/assets/sprites/.
#
# Использование: scripts/sprite-edit.sh <имя> "<инструкция>"
#   scripts/sprite-edit.sh desk_empty "remove all equipment, bare desk top only"
#
# Ключ: GEMINI_API_KEY в .env корня (gitignored). Роль — редактирование
# и доводка (генерация с нуля — scripts/gen-sprites.sh, PixelLab).
#
# Постобработка — client/scripts/sprite-remap.mjs, без ресемплинга
# (см. его шапку): --downscale-nearest покрывает случай, когда Gemini
# вернул картинку РОВНО в целое число раз крупнее size (частый случай —
# модели отдают квадратные степени двойки, напр. 1024 = 16×64). Если
# результат другого разрешения/не квадратный — remap падает с понятной
# ошибкой (раньше здесь молча звался недостающий в контейнере `magick`).
set -euo pipefail
cd "$(dirname "$0")/.."
source .env 2>/dev/null || true
KEY=${GEMINI_API_KEY:?Нет GEMINI_API_KEY в .env корня}

name=${1:?имя спрайта}
instruction=${2:?инструкция для правки}
MODEL=${GEMINI_IMAGE_MODEL:-gemini-2.5-flash-image}
SRC="client/public/assets/sprites/$name.png"
[[ -f "$SRC" ]] || { echo "нет $SRC"; exit 2; }

GEMINI_OUT=".gen-$name.gemini.png"
REMAP_OUT=".gen-$name.remap.png"
# Провал remap (контракт не пройден) не должен портить уже закоммиченный
# $SRC — ремапим во временный файл и переносим на место только при успехе.
trap 'rm -f "$GEMINI_OUT" "$REMAP_OUT"' EXIT

python3 - "$KEY" "$MODEL" "$SRC" "$instruction" "$GEMINI_OUT" <<'PYEOF'
import base64, json, sys, urllib.request

key, model, src, instruction, out = sys.argv[1:6]
b64 = base64.b64encode(open(src, 'rb').read()).decode()
payload = {
    "contents": [{
        "parts": [
            {"text": instruction + ". Keep flat pixel art style, clean silhouette, "
                     "same camera angle and colors as the original."},
            {"inline_data": {"mime_type": "image/png", "data": b64}},
        ],
    }],
}
req = urllib.request.Request(
    f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
    data=json.dumps(payload).encode(),
    headers={"Content-Type": "application/json", "x-goog-api-key": key},
)
with urllib.request.urlopen(req, timeout=120) as r:
    resp = json.load(r)
parts = resp.get("candidates", [{}])[0].get("content", {}).get("parts", [])
for p in parts:
    data = p.get("inline_data", {}).get("data")
    if data:
        open(out, "wb").write(base64.b64decode(data))
        print("ok")
        break
else:
    print("FAIL:", json.dumps(resp)[:300])
    sys.exit(1)
PYEOF

node client/scripts/sprite-remap.mjs "$GEMINI_OUT" "$REMAP_OUT" --key "$name" --downscale-nearest
mv "$REMAP_OUT" "$SRC"
echo "правка сохранена: $SRC — просмотрите результат глазами перед коммитом"
