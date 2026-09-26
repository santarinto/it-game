#!/usr/bin/env bash
# build-hd — воспроизводимая постобработка HD-заготовок (ITGAME-6/HD) в
# готовые ассеты client/public/assets/sprites/. Никакой сети/ИИ — только
# sprite-remap.mjs (квантизация в hd32 + вписывание в холст 128×128) и
# sprite-recolor.mjs (точечная hex→hex замена для «состояний» силуэта),
# оба на pngjs, детерминированно.
#
# Откуда исходники (scripts/sprites/hd-src/*.raw.png, уже в репо):
#   • desk_pc.raw.png — 128×128, PixelLab /v2/create-image-pixflux,
#     isometric=true, lock-palette hd32 (color_image), outline "single
#     color black outline", shading "medium shading", detail "medium
#     detail", seed 2087953640. Стол с ПК: монитор, клавиатура, мышь,
#     пустое кресло спинкой к зрителю. Экран нарисован тёмным (выключен).
#   • worker.raw.png — 80×80, тот же движок/палитра/outline/shading/detail,
#     seed по умолчанию (scripts/gen-sprites.sh: cksum от имени ключа
#     "worker"). Сотрудник в кресле, вид со спины 3/4, смотрит
#     вправо-вверх — --flip-x зеркалит его влево-вверх, к монитору.
#
# desk_pc_off/desk_pc/desk_pc_broken — один и тот же стол, три состояния
# экрана монитора (выкл/вкл-синий/сбой-красный) — sprite-recolor.mjs
# перекрашивает связную компоненту тёмных пикселей экрана внутри рамки
# монитора (--region 45,36,70,64), не задевая кресло/клавиатуру (тоже
# тёмные, но вне region).
#
# worker_1/worker_2/worker_3 — уровни сотрудника 1..3 (зелёная/синяя/
# бордовая рубашка вместо белой) — та же перекраска, на светлые цвета
# рубашки (уникальны для неё во всём спрайте, --region не нужен).
#
# Прогон: scripts/sprites/build-hd.sh (без аргументов) из любого места —
# скрипт сам cd в корень репо. Результат — в client/public/assets/sprites/,
# затем `cd client && node scripts/check-sprites.mjs` проверяет контракт.
set -euo pipefail
cd "$(dirname "$0")/../.."

SRC=scripts/sprites/hd-src
OUT=client/public/assets/sprites
REMAP=client/scripts/sprite-remap.mjs
RECOLOR=client/scripts/sprite-recolor.mjs

# ── desk_pc_off: стол+ПК+кресло, как есть (экран тёмный) ───────────────
node "$REMAP" "$SRC/desk_pc.raw.png" "$OUT/desk_pc_off.png" \
  --key desk_pc_off --size 128 --palette hd32

# ── desk_pc: экран «включён» — тёмная связная компонента экрана внутри ──
# рамки монитора (x 45..70, y 36..64 на холсте 128×128) перекрашена в
# синий свет по возрастанию яркости источника: 1a1c2c (ядро, 509px) →
# 272c42 (1px) → 333c57 (7px, edge/AA на границе с рамкой).
node "$RECOLOR" "$OUT/desk_pc_off.png" "$OUT/desk_pc.png" \
  --key desk_pc --size 128 --palette hd32 \
  --region 45,36,70,64 \
  --map 1a1c2c=324a9c,272c42=3b5dc9,333c57=41a6f6

# ── desk_pc_broken: тот же экран, «красный» сбой (ядро b13e53 — ярче
# синего «вкл», читается на масштабе слота рядом с оверлеем ремонта) ─────
node "$RECOLOR" "$OUT/desk_pc_off.png" "$OUT/desk_pc_broken.png" \
  --key desk_pc_broken --size 128 --palette hd32 \
  --region 45,36,70,64 \
  --map 1a1c2c=b13e53,272c42=873358,333c57=d05e55

# ── worker: зеркалим (смотрел вправо-вверх → влево-вверх, к монитору) и ──
# кладём bbox в (47,58) — подобрано вручную так, чтобы кресло сотрудника
# легло ровно на кресло desk_pc (оба спрайта рисуются в одной точке слота).
node "$REMAP" "$SRC/worker.raw.png" "$OUT/worker.png" \
  --key worker --size 128 --palette hd32 \
  --flip-x --place 47,58

# ── worker_1..3: перекраска рубашки (уровни сотрудника 1..3) ────────────
# Светлые цвета рубашки (f4f4f4/c4d2db/94b0c2/758ea4) уникальны для неё во
# всём спрайте worker.png (не встречаются в лице/руках/волосах/кресле) —
# --region не нужен.
node "$RECOLOR" "$OUT/worker.png" "$OUT/worker_1.png" \
  --key worker_1 --size 128 --palette hd32 \
  --map f4f4f4=a7f070,c4d2db=70d46a,94b0c2=38b764,758ea4=2f946f

node "$RECOLOR" "$OUT/worker.png" "$OUT/worker_2.png" \
  --key worker_2 --size 128 --palette hd32 \
  --map f4f4f4=5acbf7,c4d2db=41a6f6,94b0c2=3e82e0,758ea4=324a9c

node "$RECOLOR" "$OUT/worker.png" "$OUT/worker_3.png" \
  --key worker_3 --size 128 --palette hd32 \
  --map f4f4f4=d05e55,c4d2db=b13e53,94b0c2=873358,758ea4=5d275d

echo
echo "готово: $OUT/{desk_pc_off,desk_pc,desk_pc_broken,worker,worker_1,worker_2,worker_3}.png"
echo "проверка контракта: cd client && node scripts/check-sprites.mjs"
