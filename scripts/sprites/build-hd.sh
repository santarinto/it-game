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
#   • boss.raw.png / boss_lunch.raw.png — по 96×96, PixelLab
#     /v2/create-image-pixflux-background (--background: синхронный
#     эндпойнт периодически отдаёт 502 от шлюза со списанием генерации —
#     см. docs/development.md), --size 96 --palette hd32 --lock-palette,
#     outline "single color black outline", shading "medium shading",
#     detail "medium detail", seed 4099860094 (= cksum("boss")) — ОДИН И
#     ТОТ ЖЕ seed для обоих, чтобы это был один и тот же персонаж в двух
#     позах. boss — в тёмном костюме с галстуком, стоит и печатает на
#     открытом ноутбуке (решение владельца: начальник 128px, в костюме, с
#     ноутбуком). boss_lunch — тот же начальник на обеде, с кофе и
#     сэндвичем («как все», см. desk_pc на обеде у сотрудников). Промпты —
#     scripts/sprites/prompts-hd.txt.
#   • rack_server.raw.png — 128×128 (стойка выше остального — свой холст),
#     router.raw.png/gateway.raw.png/cooler.raw.png/coffee_machine.raw.png —
#     по 96×96, все PixelLab /v2/create-image-pixflux-background, тот же
#     outline/shading/detail, --palette hd32 --lock-palette. Замена
#     оставшихся 64px sweetie16 (серверная + быт + роутер) на HD — холст
#     генерации подобран под экранный размер предмета, --size/--palette
#     передавались ЯВНО (манифест на момент генерации ещё держал эти ключи
#     как 64/sweetie16 — без явных флагов gen-sprites.sh взял бы их оттуда
#     и isometric=false). seed по умолчанию (cksum ключа, см.
#     scripts/gen-sprites.sh --dry-run): rack_server 1439954681, router
#     604758682, gateway 778627568, cooler 3555790590, coffee_machine
#     1105630005.
#   • fridge.raw.png — 96×96, тот же движок/палитра/outline/shading/detail,
#     но seed ЯВНЫЙ 20260926 (не cksum): первая генерация с дефолтным
#     seed и промптом без «large tall» дала холодильник крошечным (bbox
#     26×48 на холсте 96 — вдвое ниже cooler), перегенерирован с «large
#     tall … full height» в промпте и этим seed. Промпты и разбор —
#     scripts/sprites/prompts-hd.txt.
#   • rack_empty.png — НЕ генерация (как desk_empty выше): pixflux
#     игнорирует отрицания («empty», «no servers») так же, как «no
#     computer, no chair» у desk_empty — это пиксельная правка
#     rack_server.raw.png (тот же силуэт/альфа, во фронтальном проёме
#     стёрты серверы, оставлена тёмная пустота с монтажными рейками).
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
# rack_server/rack_empty/router/gateway/cooler/fridge/coffee_machine —
# HD-замена оставшихся 64px sweetie16-спрайтов (серверная, роутер офиса,
# полка быта). Спрайт рисуется с origin по центру кадра, поэтому
# --bottom-margin ≈ (128 − высота bbox)/2 ставит предмет в центр своего
# бокса; где предметы стоят рядом, margin общий на группу:
#   • rack_server/rack_empty — ОДИН И ТОТ ЖЕ --bottom-margin 8 (bbox 72×111
#     по центру): пустая и полная стойка совпадают пиксель-в-пиксель по
#     силуэту и подменяют друг друга в ServerRoomScene.ts без «прыжка».
#   • router --bottom-margin 24 (bbox 72×79), gateway --bottom-margin 27
#     (80×73) — по центру боксов 84×84 (слот сети офиса / шлюз серверной).
#   • cooler/fridge/coffee_machine — ОДИН И ТОТ ЖЕ --bottom-margin 22:
#     общая линия пола на полке быта (office.amenity.*); bbox по высоте
#     84/83/78 — самый высокий (cooler) по центру, у остальных сверху запас.
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

# ── desk_empty: пустой стол (без ПК/кресла) — НЕ генерация, а ────────────
# детерминированная пиксельная правка hd-src/desk_empty.png, полученного
# из desk_pc.raw.png (стёрты монитор/клавиатура/мышь/кресло, закрытые ими
# пиксели столешницы/кромки/правой тумбы восстановлены по изометрической
# геометрии стола, остальное — пиксель-в-пиксель из оригинала). Генерация
# не удалась: pixflux с seed якоря рисует ПК и кресло даже при "no
# computer, no chair" в промпте; --negative (negative_description) дважды
# вернул 502 upstream со списанием генерации без картинки — см.
# scripts/sprites/prompts-hd.txt.
node "$REMAP" "$SRC/desk_empty.png" "$OUT/desk_empty.png" \
  --key desk_empty --size 128 --palette hd32

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

# ── boss / boss_lunch: тот же начальник, две позы (работа/обед) ─────────
# --bottom-margin 18 ОДИНАКОВ для обоих — bbox непрозрачных пикселей у
# исходников разной высоты (boss 42×91, boss_lunch 34×94 на холсте
# 96×96), но одинаковый margin кладёт НИЖНИЙ край bbox на одну и ту же
# строку холста (128 − 18 = 110) в обоих PNG: при переключении
# работа↔обед (OfficeScene.ts, s.isLunch) ноги не «прыгают», меняется
# только сама фигура над ними. По той же формуле фигура остаётся
# примерно по центру холста 128×128 (полу-разница высот 91 и 94 — то
# небольшое смещение центра масс, которое и даёт разброс margin 17–18,
# см. комментарий в шапке файла).
node "$REMAP" "$SRC/boss.raw.png" "$OUT/boss.png" \
  --key boss --size 128 --palette hd32 --bottom-margin 18

node "$REMAP" "$SRC/boss_lunch.raw.png" "$OUT/boss_lunch.png" \
  --key boss_lunch --size 128 --palette hd32 --bottom-margin 18

# ── rack_server/rack_empty: серверная стойка, полная и пустая ───────────
# ОДИН И ТОТ ЖЕ --bottom-margin 8 — по силуэту/альфе pixel-в-pixel
# совпадают (rack_empty — правка rack_server.raw.png, не своя генерация).
node "$REMAP" "$SRC/rack_server.raw.png" "$OUT/rack_server.png" \
  --key rack_server --size 128 --palette hd32 --bottom-margin 8

node "$REMAP" "$SRC/rack_empty.png" "$OUT/rack_empty.png" \
  --key rack_empty --size 128 --palette hd32 --bottom-margin 8

# ── router/gateway: слоты сети (офис/серверная), центр своего бокса 84×84 ─
node "$REMAP" "$SRC/router.raw.png" "$OUT/router.png" \
  --key router --size 128 --palette hd32 --bottom-margin 24

node "$REMAP" "$SRC/gateway.raw.png" "$OUT/gateway.png" \
  --key gateway --size 128 --palette hd32 --bottom-margin 27

# ── cooler/fridge/coffee_machine: полка быта, общая линия пола ──────────
node "$REMAP" "$SRC/cooler.raw.png" "$OUT/cooler.png" \
  --key cooler --size 128 --palette hd32 --bottom-margin 22

node "$REMAP" "$SRC/fridge.raw.png" "$OUT/fridge.png" \
  --key fridge --size 128 --palette hd32 --bottom-margin 22

node "$REMAP" "$SRC/coffee_machine.raw.png" "$OUT/coffee_machine.png" \
  --key coffee_machine --size 128 --palette hd32 --bottom-margin 22

echo
echo "готово: $OUT/{desk_pc_off,desk_pc,desk_pc_broken,desk_empty,worker,worker_1,worker_2,worker_3,boss,boss_lunch,rack_server,rack_empty,router,gateway,cooler,fridge,coffee_machine}.png"
echo "проверка контракта: cd client && node scripts/check-sprites.mjs"
