#!/usr/bin/env bash
# Постобработка спрайтов AI-генерации в стиль игры: downscale до
# игрового размера + жёсткая квантизация в палитру Sweetie-16.
# Использование: remap.sh <in.png> <out.png> [размер=32]
set -euo pipefail

in=${1:?in.png}
out=${2:?out.png}
size=${3:-32}
dir=$(cd "$(dirname "$0")" && pwd)

# -filter point: пиксель-арт без сглаживания; -dither None: чистые
# цвета палитры, без шума; фон вырезаем по углу (0,0).
magick "$in" -resize "${size}x${size}^" -gravity center -extent "${size}x${size}" \
  -filter point -sample "${size}x${size}" \
  +dither -remap "$dir/sweetie16.png" "$out"
echo "$out (${size}px, sweetie16)"
