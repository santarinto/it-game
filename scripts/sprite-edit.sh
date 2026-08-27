#!/usr/bin/env bash
# sprite-edit — правка существующего спрайта через Gemini (nano banana,
# ITGAME-6): картинка + инструкция → отредактированный PNG → remap
# Sweetie-16 → в client/public/assets/sprites/.
#
# Использование: scripts/sprite-edit.sh <имя> "<инструкция>"
#   scripts/sprite-edit.sh desk_empty "remove all equipment, bare desk top only"
#
# Ключ: GEMINI_API_KEY в .env корня (gitignored). Роль — редактирование
# и доводка (генерация с нуля — scripts/gen-sprites.sh, PixelLab).
set -euo pipefail
cd "$(dirname "$0")/.."
source .env 2>/dev/null || true
KEY=${GEMINI_API_KEY:?Нет GEMINI_API_KEY в .env корня}

name=${1:?имя спрайта}
instruction=${2:?инструкция для правки}
MODEL=${GEMINI_IMAGE_MODEL:-gemini-2.5-flash-image}
SRC="client/public/assets/sprites/$name.png"
[[ -f "$SRC" ]] || { echo "нет $SRC"; exit 2; }

python3 - "$KEY" "$MODEL" "$SRC" "$instruction" ".gen-$name.gemini.png" <<'PYEOF'
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

scripts/sprites/remap.sh ".gen-$name.gemini.png" "$SRC" 64
rm -f ".gen-$name.gemini.png"
echo "правка сохранена: $SRC (куриция: LocalMind по пути $SRC)"
