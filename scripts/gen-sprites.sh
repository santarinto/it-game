#!/usr/bin/env bash
# gen-sprites — dev-time пайплайн спрайтов через PixelLab API v2 (ITGAME-6,
# HD-заготовка). НЕ runtime: игра офлайн, в репо коммитятся готовые PNG из
# client/public/assets/sprites/ — этот скрипт их туда не пишет напрямую,
# см. "Установка" ниже.
#
# Поля запросов и форма ответа сверены с /v2/openapi.json (снятым
# 2026-09-26). Эндпоинты, которые использует скрипт:
#   • POST /v2/create-image-pixen    — синхронный; тело: description,
#     image_size{width,height} (кратно 4, 16..768, площадь ≤512×512),
#     outline/detail/view/direction, no_background, seed, enhance_prompt.
#     Ответ: {usage, image, enhanced_prompt?, enhance_usage?} — нет
#     shading/negative_description/text_guidance_scale/color_image.
#   • POST /v2/create-image-pixflux  — синхронный; тело: то же + isometric,
#     negative_description, text_guidance_scale (≤20), shading, init_image,
#     init_image_strength, color_image (принудительная палитра). Ответ:
#     {usage, image}. image_size: 16..400.
#   • POST /v2/create-image-bitforge — синхронный; тело: как pixflux, плюс
#     style_strength (ЦЕЛОЕ 0..100), style_image/inpainting_image/mask_image.
#     Ответ: {usage, image}. image_size: 16..200.
#   • GET  /v2/balance — {credits:{usd}, subscription:{status,plan,
#     generations,total}} — свободный вызов.
#   • GET  /v2/background-jobs/{id} — {usage, id, status
#     (processing|completed|failed), created_at, last_response} — опрос НА
#     СЛУЧАЙ асинхронного ответа; сами create-image-* синхронны и его не
#     требуют, но детектор асинхронности не гадает: срабатывает только если
#     в ответе одновременно есть id И status (форма BackgroundJobResponse).
# image/style_image/color_image и т.п. — объект Base64Image
# {"type":"base64","base64":"…","format":"png"}, НЕ голая строка.
# Коды ошибок 401/402/422/429/529 обрабатывает do_create_request(): 402 —
# нет кредитов/генераций, 429/529 — один повтор с паузой, 422 — печать
# detail из тела ответа.
#
# Использование:
#   scripts/gen-sprites.sh --balance
#   scripts/gen-sprites.sh --dry-run [--engine pixen|pixflux|bitforge] [--hd] [имя]
#   scripts/gen-sprites.sh [--engine …] [--hd] [--out-dir DIR] [имя]
#   scripts/gen-sprites.sh --install <ключ> <файл.png>
#
# Ключ: SPRITES_API_KEY в .env корня (gitignored) или в окружении —
# нужен только для реальных вызовов и --balance, НЕ для --dry-run/--install.
# Промпты: scripts/sprites/prompts.txt (64px, sweetie16) или, с --hd,
# scripts/sprites/prompts-hd.txt (128px, hd32, isometric). Без "имени" —
# все строки выбранного файла (кроме закомментированных #).
#
# Размер/палитра берутся из client/src/assets/sprites.json по ключу —
# так текущие 64px-ключи не меняют поведение (обратная совместимость).
# Если ключа в манифесте ещё нет (HD-заготовки), включается --hd
# (128/hd32) либо явные --size/--palette.
#
# --lock-palette (по умолчанию включено для pixflux/bitforge, недоступно
# для pixen — предупреждение вместо ошибки) собирает из палитры ключа
# (palettes.<palette> в манифесте) PNG-полоску N×1 пикселей на pngjs и
# передаёт её как color_image — принудительная палитра генерации.
# --no-lock-palette выключает.
#
# Результат каждой генерации (сырой PNG + JSON-ответ + remap-PNG) уходит в
# OUT_DIR (по умолчанию свежий mktemp -d, можно задать OUT_DIR=… или
# --out-dir) — НЕ в client/public. Чтобы принять конкретный файл в игру
# (после ручного просмотра/куриции), явно: `--install <ключ> <файл>` —
# он прогоняет тот же контракт, что check-sprites.mjs, и копирует файл
# в client/public/assets/sprites/<ключ>.png только если контракт пройден.
#
# MAX_GENERATIONS (по умолчанию 20) — жёсткий стоп на число реальных
# вызовов генерации за сессию (--dry-run/--balance/--install не считаются).
set -euo pipefail
cd "$(dirname "$0")/.."

API=${SPRITES_API_BASE:-https://api.pixellab.ai/v2}
CONNECT_TIMEOUT=${SPRITES_CONNECT_TIMEOUT:-10}
MAX_TIME=${SPRITES_MAX_TIME:-90}
BALANCE_MAX_TIME=${SPRITES_BALANCE_MAX_TIME:-15}
MAX_GENERATIONS=${MAX_GENERATIONS:-20}
POLL_INTERVAL=${SPRITES_POLL_INTERVAL:-5}
POLL_TIMEOUT=${SPRITES_POLL_TIMEOUT:-180}
JOB_STATUS_PATH=${SPRITES_JOB_STATUS_PATH:-/background-jobs/{id}}
RETRY_SLEEP=${SPRITES_RETRY_SLEEP:-15}

MANIFEST=client/src/assets/sprites.json
REMAP=client/scripts/sprite-remap.mjs
SPRITES_DIR=client/public/assets/sprites

ENGINE=pixen
DRY_RUN=0
HD=0
DO_BALANCE=0
PROMPTS_FILE=""
SIZE_OVERRIDE=""
PALETTE_OVERRIDE=""
STYLE_IMAGE=""
STYLE_STRENGTH=${SPRITES_STYLE_STRENGTH:-40}
LOCK_PALETTE=auto
VIEW=""
OUTLINE=""
SHADING=""
DETAIL=""
DIRECTION=""
NEGATIVE=""
GUIDANCE=""
SEED_OVERRIDE=""
OUT_DIR=${OUT_DIR:-}
INSTALL_KEY=""
INSTALL_FILE=""
ONLY=""

usage() {
  cat <<'USAGE'
Usage:
  scripts/gen-sprites.sh --balance
  scripts/gen-sprites.sh --dry-run [--engine pixen|pixflux|bitforge] [--hd] [--size N] [--palette sweetie16|hd32] [имя]
  scripts/gen-sprites.sh [--engine …] [--hd] [--out-dir DIR] [имя]
  scripts/gen-sprites.sh --install <ключ> <файл.png>

Флаги:
  --dry-run              печатает эндпоинт+тело запроса (без ключа), не вызывает сеть
  --engine E             pixen (default) | pixflux | bitforge
  --hd                   промпты из prompts-hd.txt, дефолт size=128 palette=hd32 isometric=true
  --prompts FILE          свой файл промптов вместо prompts.txt/prompts-hd.txt
  --size N / --palette P  переопределить размер/палитру (иначе — из манифеста, потом --hd/дефолт)
  --style-image FILE      bitforge: файл-референс стиля (Base64Image в тело)
  --style-strength N      bitforge: сила стиля, целое 0..100 (default 40)
  --lock-palette          принудительная палитра ключа как color_image (default: вкл для
                          pixflux/bitforge; для pixen недоступно — предупреждение)
  --no-lock-palette       выключить --lock-palette
  --view V                CameraView: side | "low top-down" | "high top-down"
  --outline V             Outline: "single color black outline" | "single color outline" |
                          "selective outline" | lineless
  --shading V             Shading (pixflux/bitforge): "flat shading" | "basic shading" |
                          "medium shading" | "detailed shading" | "highly detailed shading"
  --detail V              Detail: "low detail" | "medium detail" | "highly detailed"
  --direction V           Direction: north|north-east|east|south-east|south|south-west|west|north-west
  --negative TEXT         negative_description (pixflux/bitforge)
  --guidance N            text_guidance_scale, 1..20 (pixflux/bitforge)
  --seed N                переопределить вычисляемый seed
  --out-dir DIR           куда класть сырые/промежуточные файлы (default: mktemp -d)
  --balance               GET /v2/balance и выход (бесплатно)
  --install KEY FILE      скопировать уже прошедший remap FILE в client/public/assets/sprites/KEY.png
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --engine) ENGINE=${2:?--engine требует значение}; shift 2 ;;
    --hd) HD=1; shift ;;
    --prompts) PROMPTS_FILE=${2:?--prompts требует путь}; shift 2 ;;
    --size) SIZE_OVERRIDE=${2:?--size требует число}; shift 2 ;;
    --palette) PALETTE_OVERRIDE=${2:?--palette требует значение}; shift 2 ;;
    --style-image) STYLE_IMAGE=${2:?--style-image требует путь}; shift 2 ;;
    --style-strength) STYLE_STRENGTH=${2:?--style-strength требует число}; shift 2 ;;
    --lock-palette) LOCK_PALETTE=on; shift ;;
    --no-lock-palette) LOCK_PALETTE=off; shift ;;
    --view) VIEW=${2:?--view требует значение}; shift 2 ;;
    --outline) OUTLINE=${2:?--outline требует значение}; shift 2 ;;
    --shading) SHADING=${2:?--shading требует значение}; shift 2 ;;
    --detail) DETAIL=${2:?--detail требует значение}; shift 2 ;;
    --direction) DIRECTION=${2:?--direction требует значение}; shift 2 ;;
    --negative) NEGATIVE=${2:?--negative требует текст}; shift 2 ;;
    --guidance) GUIDANCE=${2:?--guidance требует число}; shift 2 ;;
    --seed) SEED_OVERRIDE=${2:?--seed требует число}; shift 2 ;;
    --out-dir) OUT_DIR=${2:?--out-dir требует путь}; shift 2 ;;
    --balance) DO_BALANCE=1; shift ;;
    --install)
      INSTALL_KEY=${2:?--install требует <ключ> <файл>}
      INSTALL_FILE=${3:?--install требует <ключ> <файл>}
      shift 3
      ;;
    -h|--help) usage; exit 0 ;;
    --) shift; break ;;
    -*) echo "неизвестный флаг: $1" >&2; usage >&2; exit 2 ;;
    *) ONLY=$1; shift ;;
  esac
done

case "$ENGINE" in
  pixen|pixflux|bitforge) ;;
  *) echo "неизвестный --engine '$ENGINE' (ожидается pixen|pixflux|bitforge)" >&2; exit 2 ;;
esac

# ── валидация enum-флагов по /v2/openapi.json (Outline/Shading/Detail/
#    CameraView/Direction) — до сети, чтобы не тратить вызов на опечатку ──
validate_enum() {
  local flag=$1 value=$2; shift 2
  local v
  for v in "$@"; do
    [[ "$value" == "$v" ]] && return 0
  done
  echo "неверное значение --$flag '$value' (ожидается одно из: $*)" >&2
  exit 2
}
[[ -n "$OUTLINE" ]] && validate_enum outline "$OUTLINE" \
  "single color black outline" "single color outline" "selective outline" "lineless"
[[ -n "$SHADING" ]] && validate_enum shading "$SHADING" \
  "flat shading" "basic shading" "medium shading" "detailed shading" "highly detailed shading"
[[ -n "$DETAIL" ]] && validate_enum detail "$DETAIL" \
  "low detail" "medium detail" "highly detailed"
[[ -n "$VIEW" ]] && validate_enum view "$VIEW" \
  "side" "low top-down" "high top-down"
[[ -n "$DIRECTION" ]] && validate_enum direction "$DIRECTION" \
  north north-east east south-east south south-west west north-west

if ! [[ "$STYLE_STRENGTH" =~ ^[0-9]+$ ]] || (( STYLE_STRENGTH < 0 || STYLE_STRENGTH > 100 )); then
  echo "--style-strength должен быть целым 0..100 (получено '$STYLE_STRENGTH')" >&2
  exit 2
fi
if [[ -n "$GUIDANCE" ]]; then
  if ! [[ "$GUIDANCE" =~ ^[0-9]+(\.[0-9]+)?$ ]]; then
    echo "--guidance должен быть числом 1..20 (получено '$GUIDANCE')" >&2
    exit 2
  fi
  if ! awk -v g="$GUIDANCE" 'BEGIN { exit !(g >= 1 && g <= 20) }'; then
    echo "--guidance должен быть в диапазоне 1..20 (получено '$GUIDANCE')" >&2
    exit 2
  fi
fi
if [[ -n "$SEED_OVERRIDE" ]] && ! [[ "$SEED_OVERRIDE" =~ ^-?[0-9]+$ ]]; then
  echo "--seed должен быть целым числом (получено '$SEED_OVERRIDE')" >&2
  exit 2
fi

# ── поля, которых нет в схеме выбранного движка — ошибка до сети ────────
if [[ "$ENGINE" == "pixen" ]]; then
  [[ -n "$SHADING" ]] && { echo "--shading недоступен для engine=pixen (нет поля shading в CreateImagePixenRequest)" >&2; exit 2; }
  [[ -n "$NEGATIVE" ]] && { echo "--negative недоступен для engine=pixen (нет negative_description)" >&2; exit 2; }
  [[ -n "$GUIDANCE" ]] && { echo "--guidance недоступен для engine=pixen (нет text_guidance_scale)" >&2; exit 2; }
fi
if [[ "$ENGINE" != "bitforge" && -n "$STYLE_IMAGE" ]]; then
  echo "--style-image доступен только для engine=bitforge" >&2
  exit 2
fi

# ── --install: отдельная команда, никакой сети ──────────────────────────
if [[ -n "$INSTALL_KEY" ]]; then
  [[ -f "$INSTALL_FILE" ]] || { echo "install: нет файла $INSTALL_FILE" >&2; exit 1; }
  [[ -f "$MANIFEST" ]] || { echo "install: нет манифеста $MANIFEST" >&2; exit 1; }
  echo "install: проверяю $INSTALL_FILE против манифеста (ключ '$INSTALL_KEY')…"
  if ! node --input-type=module - "$MANIFEST" "$INSTALL_KEY" "$INSTALL_FILE" <<'NODE_EOF'
import { readFileSync } from 'node:fs'
import { PNG } from './client/node_modules/pngjs/lib/png.js'
import { checkSpriteImage } from './client/scripts/lib/sprite-check.mjs'

const [manifestPath, key, filePath] = process.argv.slice(2)
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const spec = manifest.sprites?.[key]
if (!spec) {
  console.error(`install: ключа '${key}' нет в манифесте ${manifestPath} — добавьте запись перед install`)
  process.exit(1)
}
const palette = manifest.palettes?.[spec.palette]
if (!palette) {
  console.error(`install: неизвестная палитра '${spec.palette}' для ключа '${key}'`)
  process.exit(1)
}
let png
try {
  png = PNG.sync.read(readFileSync(filePath))
} catch (e) {
  console.error(`install: PNG не читается — ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
}
const { problems, warnings } = checkSpriteImage(png, spec, palette, spec.palette)
for (const w of warnings) console.warn(`install: WARN ${w}`)
if (problems.length > 0) {
  console.error(`install: FAIL — ${problems.join('; ')}`)
  process.exit(1)
}
console.log('install: контракт пройден')
NODE_EOF
  then
    echo "install: отказано — файл не прошёл проверку (см. вывод выше)" >&2
    exit 1
  fi
  mkdir -p "$SPRITES_DIR"
  cp "$INSTALL_FILE" "$SPRITES_DIR/$INSTALL_KEY.png"
  echo "install: готово → $SPRITES_DIR/$INSTALL_KEY.png"
  exit 0
fi

# ── ключ нужен только для сети (--balance или реальная генерация) ───────
KEY=""
if [[ "$DO_BALANCE" == "1" || "$DRY_RUN" == "0" ]]; then
  source .env 2>/dev/null || true
  KEY=${SPRITES_API_KEY:?Нет SPRITES_API_KEY в .env корня репо (не нужен для --dry-run/--install)}
fi

# ── --balance: единственный бесплатный сетевой вызов ────────────────────
if [[ "$DO_BALANCE" == "1" ]]; then
  resp=$(curl -sS --fail-with-body --connect-timeout "$CONNECT_TIMEOUT" --max-time "$BALANCE_MAX_TIME" \
    "$API/balance" -H "Authorization: Bearer $KEY")
  printf '%s' "$resp" | python3 -c '
import json, sys
d = json.load(sys.stdin)
credits = d.get("credits") or {}
sub = d.get("subscription") or {}
print(f"Кредиты: ${credits.get(\"usd\", 0)} USD")
print(
    "Подписка: статус={status}, план={plan}, осталось {gen}/{total} генераций".format(
        status=sub.get("status", "?"),
        plan=sub.get("plan") or "-",
        gen=sub.get("generations", "?"),
        total=sub.get("total", "?"),
    )
)
'
  exit 0
fi

if [[ -z "$PROMPTS_FILE" ]]; then
  if [[ "$HD" == "1" ]]; then
    PROMPTS_FILE=scripts/sprites/prompts-hd.txt
  else
    PROMPTS_FILE=scripts/sprites/prompts.txt
  fi
fi
[[ -f "$PROMPTS_FILE" ]] || { echo "нет файла промптов $PROMPTS_FILE" >&2; exit 1; }

if [[ "$DRY_RUN" != "1" ]]; then
  [[ -z "$OUT_DIR" ]] && OUT_DIR=$(mktemp -d)
  mkdir -p "$OUT_DIR"
  echo "OUT_DIR=$OUT_DIR (сырые PNG/JSON-ответы/remap — сюда, НЕ в $SPRITES_DIR)"
fi

GEN_COUNT=0

# Стабильный seed из имени: одинаковый промпт+seed = одинаковый результат
# при перегенерации конкретного спрайта.
seed_of() { echo -n "$1" | cksum | cut -d' ' -f1; }

# Возвращает "size palette found" (found=1, если ключ есть в манифесте).
# Плейсхолдер "-" вместо пустой строки: `read` с дефолтным IFS схлопывает
# соседние разделители, и по-настоящему пустое поле потерялось бы.
manifest_lookup() {
  python3 - "$MANIFEST" "$1" <<'PY'
import json, sys
manifest = json.load(open(sys.argv[1], encoding='utf-8'))
spec = manifest.get('sprites', {}).get(sys.argv[2])
if spec:
    print(spec.get('size', '-'), spec.get('palette', '-'), 1)
else:
    print('-', '-', 0)
PY
}

# Собирает PNG-полоску N×1 из палитры ключа манифеста (--lock-palette),
# пишет во временный файл и печатает его путь. Используется как color_image
# (принудительная палитра) для pixflux/bitforge — pixen такого поля не
# принимает (см. валидацию в gen_one).
palette_image_file() {
  local palette=$1
  local out
  out=$(mktemp --suffix=.png)
  if ! node --input-type=module - "$MANIFEST" "$palette" "$out" <<'NODE_EOF'
import { readFileSync, writeFileSync } from 'node:fs'
import { PNG } from './client/node_modules/pngjs/lib/png.js'

const [manifestPath, paletteName, outPath] = process.argv.slice(2)
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const colors = manifest.palettes?.[paletteName]
if (!colors || !colors.length) {
  console.error(`palette_image: неизвестная палитра '${paletteName}' в ${manifestPath}`)
  process.exit(1)
}
const png = new PNG({ width: colors.length, height: 1 })
colors.forEach((hex, i) => {
  const idx = i * 4
  png.data[idx] = parseInt(hex.slice(0, 2), 16)
  png.data[idx + 1] = parseInt(hex.slice(2, 4), 16)
  png.data[idx + 2] = parseInt(hex.slice(4, 6), 16)
  png.data[idx + 3] = 255
})
writeFileSync(outPath, PNG.sync.write(png))
NODE_EOF
  then
    echo "lock-palette: не удалось собрать PNG-палитру для '$palette'" >&2
    exit 1
  fi
  printf '%s' "$out"
}

json_field() {
  # $1 = путь к файлу с JSON, $2 = точечный путь ("a.b"); печатает '' если
  # нет/не строка/не число. Файл, а не текст аргументом/heredoc-стдином —
  # ответ API мог быть заметно больше пары строк (base64-картинка внутри).
  python3 - "$1" "$2" <<'PY'
import json, sys
file_path, path = sys.argv[1], sys.argv[2]
try:
    with open(file_path, encoding='utf-8') as f:
        data = json.load(f)
except Exception:
    print('')
    sys.exit(0)
cur = data
for part in path.split('.'):
    if isinstance(cur, dict) and part in cur:
        cur = cur[part]
    else:
        print('')
        sys.exit(0)
print(cur if isinstance(cur, (str, int, float)) else json.dumps(cur))
PY
}

# Одна функция сборки тела запроса на движок, сверена с /v2/openapi.json
# (см. шапку файла). Входы — через переменные окружения, а не argv: часть
# значений (--negative, описание) — произвольный текст, и так не нужно
# городить bash-экранирование для кавычек/спецсимволов.
build_body() {
  BODY_ENGINE=$1 BODY_DESC=$2 BODY_SIZE=$3 BODY_SEED=$4 BODY_ISO=$5 \
  BODY_STYLE_FILE=$6 BODY_STYLE_STRENGTH=$7 BODY_COLOR_FILE=$8 \
  BODY_NEGATIVE=$9 BODY_GUIDANCE=${10} BODY_OUTLINE=${11} BODY_SHADING=${12} \
  BODY_DETAIL=${13} BODY_VIEW=${14} BODY_DIRECTION=${15} \
  python3 - <<'PY'
import base64
import json
import os


def b64_image(path):
    with open(path, 'rb') as f:
        data = f.read()
    fmt = 'jpeg' if path.lower().endswith(('.jpg', '.jpeg')) else 'png'
    return {"type": "base64", "base64": base64.b64encode(data).decode(), "format": fmt}


engine = os.environ['BODY_ENGINE']
desc = os.environ['BODY_DESC']
size = int(os.environ['BODY_SIZE'])
seed = int(os.environ['BODY_SEED']) % 2147483647
isometric = os.environ['BODY_ISO'] == 'true'
style_file = os.environ['BODY_STYLE_FILE']
style_strength = os.environ['BODY_STYLE_STRENGTH']
color_file = os.environ['BODY_COLOR_FILE']
negative = os.environ['BODY_NEGATIVE']
guidance = os.environ['BODY_GUIDANCE']
outline = os.environ['BODY_OUTLINE']
shading = os.environ['BODY_SHADING']
detail = os.environ['BODY_DETAIL']
view = os.environ['BODY_VIEW']
direction = os.environ['BODY_DIRECTION']

# HD-ключи (isometric=true, см. gen_one: привязано к palette==hd32) несут
# свой стилевой суффикс — общий для всех промптов из prompts-hd.txt.
if isometric:
    full_desc = desc + ", HD isometric pixel art game asset, 128px, clean readable silhouette, transparent background, no text"
else:
    full_desc = desc + ", flat pixel art game sprite, clean readable silhouette, few colors, no text"

body = {
    "description": full_desc,
    "image_size": {"width": size, "height": size},
    "no_background": True,
    "seed": seed,
}
# Общие для всех трёх движков (см. /v2/openapi.json).
if outline:
    body["outline"] = outline
if detail:
    body["detail"] = detail
if view:
    body["view"] = view
if direction:
    body["direction"] = direction

if engine == 'pixen':
    pass  # pixen не знает isometric/shading/negative_description/
          # text_guidance_scale/color_image/style_image — не добавляем
elif engine == 'pixflux':
    body["isometric"] = isometric
    if negative:
        body["negative_description"] = negative
    if guidance:
        body["text_guidance_scale"] = float(guidance)
    if shading:
        body["shading"] = shading
    if color_file:
        body["color_image"] = b64_image(color_file)
elif engine == 'bitforge':
    body["isometric"] = isometric
    body["style_strength"] = int(style_strength)
    if negative:
        body["negative_description"] = negative
    if guidance:
        body["text_guidance_scale"] = float(guidance)
    if shading:
        body["shading"] = shading
    if style_file:
        body["style_image"] = b64_image(style_file)
    if color_file:
        body["color_image"] = b64_image(color_file)
else:
    raise SystemExit(f"неизвестный engine {engine}")

print(json.dumps(body))
PY
}

# POST create-image-<ENGINE>. Возвращает тело 200-ответа на stdout.
# 402 — нет кредитов/генераций; 422 — печатает detail валидации; 429/529 —
# один повтор после паузы; остальное — общая ошибка. Все — понятное
# сообщение + exit 1, без сырого вывода curl.
do_create_request() {
  local body=$1
  local attempt raw status resp_body
  for attempt in 1 2; do
    raw=$(curl -sS --connect-timeout "$CONNECT_TIMEOUT" --max-time "$MAX_TIME" \
      -w '\n%{http_code}' \
      -X POST "$API/create-image-$ENGINE" \
      -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
      -d "$body") || { echo "  сетевая ошибка запроса к $API/create-image-$ENGINE" >&2; exit 1; }
    status=${raw##*$'\n'}
    resp_body=${raw%$'\n'"$status"}
    case "$status" in
      200)
        printf '%s' "$resp_body"
        return 0
        ;;
      401)
        echo "  401: неверный SPRITES_API_KEY" >&2
        exit 1
        ;;
      402)
        echo "  402: недостаточно кредитов/генераций на балансе (см. --balance)" >&2
        exit 1
        ;;
      422)
        echo "  422: ошибка валидации тела запроса:" >&2
        printf '%s' "$resp_body" | python3 -c '
import json, sys
try:
    d = json.loads(sys.argv[1])
except Exception:
    print("    (тело ответа не JSON)", file=sys.stderr)
    sys.exit(0)
detail = d.get("detail", d) if isinstance(d, dict) else d
if isinstance(detail, list):
    for e in detail:
        loc = ".".join(str(p) for p in e.get("loc", [])) if isinstance(e, dict) else ""
        msg = e.get("msg") if isinstance(e, dict) else e
        print(f"    {loc}: {msg}", file=sys.stderr)
else:
    print(f"    {detail}", file=sys.stderr)
' "$resp_body"
        exit 1
        ;;
      429|529)
        if [[ "$attempt" == "1" ]]; then
          echo "  HTTP $status: троттлинг, повтор через ${RETRY_SLEEP}с…" >&2
          sleep "$RETRY_SLEEP"
          continue
        fi
        echo "  HTTP $status: троттлинг после повтора — сдаюсь" >&2
        exit 1
        ;;
      *)
        echo "  HTTP $status: неожиданный ответ" >&2
        printf '%s\n' "$resp_body" >&2
        exit 1
        ;;
    esac
  done
}

# Печатает Usage {type: usd|generations, usd, generations} по-человечески.
print_usage() {
  local usage_json=$1
  if [[ -z "$usage_json" || "$usage_json" == "null" ]]; then
    echo "  usage: н/д"
    return 0
  fi
  python3 -c '
import json, sys
u = json.loads(sys.argv[1])
t = u.get("type", "usd")
if t == "usd" and u.get("usd") is not None:
    print(f"  usage: ${u[\"usd\"]} USD")
elif t == "generations" and u.get("generations") is not None:
    print(f"  usage: {u[\"generations\"]} генераций")
else:
    print(f"  usage: {json.dumps(u, ensure_ascii=False)}")
' "$usage_json"
}

# Опрос GET /background-jobs/{id} (BackgroundJobResponse: id, status,
# created_at, last_response). Статусы по /v2/openapi.json: processing —
# ждём, completed — успех, failed — провал; что-то ещё — тоже ждём, но
# предупреждаем (на случай, если API расширит набор статусов).
# resp_file перезаписывается на каждом опросе; при успехе в нём остаётся
# финальный ответ задачи (читает его вызывающий код через json_field).
poll_job() {
  local job_id=$1 resp_file=$2
  local waited=0
  local path=${JOB_STATUS_PATH/\{id\}/$job_id}
  while (( waited < POLL_TIMEOUT )); do
    sleep "$POLL_INTERVAL"
    waited=$((waited + POLL_INTERVAL))
    local st_resp
    if ! st_resp=$(curl -sS --fail-with-body --connect-timeout "$CONNECT_TIMEOUT" --max-time 30 \
      "$API$path" -H "Authorization: Bearer $KEY"); then
      echo "  poll: ошибка запроса статуса job=$job_id (${waited}s/${POLL_TIMEOUT}s)" >&2
      continue
    fi
    printf '%s' "$st_resp" > "$resp_file"
    local st
    st=$(json_field "$resp_file" status)
    echo "  poll job=$job_id status=${st:-?} (${waited}s/${POLL_TIMEOUT}s)"
    case "$st" in
      completed) return 0 ;;
      failed)
        echo "job $job_id: терминальный статус 'failed' — провал" >&2
        return 1
        ;;
      processing|"") ;; # ещё в процессе
      *) echo "  poll: незнакомый статус '$st' — продолжаю ждать" >&2 ;;
    esac
  done
  echo "job $job_id: таймаут ${POLL_TIMEOUT}s без терминального статуса" >&2
  return 1
}

gen_one() {
  local key=$1 prompt=$2 override_seed=${3:-}
  local seed
  if [[ -n "$SEED_OVERRIDE" ]]; then
    seed=$SEED_OVERRIDE
  elif [[ -n "$override_seed" ]]; then
    seed=$override_seed
  else
    seed=$(seed_of "$key")
  fi

  local m_size m_palette m_found
  read -r m_size m_palette m_found < <(manifest_lookup "$key")

  local size palette isometric
  if [[ "$m_found" == "1" ]]; then
    size=${SIZE_OVERRIDE:-$m_size}
    palette=${PALETTE_OVERRIDE:-$m_palette}
  elif [[ "$HD" == "1" ]]; then
    size=${SIZE_OVERRIDE:-128}
    palette=${PALETTE_OVERRIDE:-hd32}
  else
    size=${SIZE_OVERRIDE:-64}
    palette=${PALETTE_OVERRIDE:-sweetie16}
  fi
  isometric=false
  [[ "$palette" == "hd32" ]] && isometric=true

  # Лимиты image_size по движку (/v2/openapi.json). Наши размеры всегда
  # квадратные (одно --size на обе стороны), так что правило pixen
  # "width==height при стороне <32" выполняется автоматически.
  case "$ENGINE" in
    bitforge)
      (( size >= 16 && size <= 200 )) || { echo "bitforge: size=$size вне допустимых 16..200" >&2; exit 1; }
      ;;
    pixflux)
      (( size >= 16 && size <= 400 )) || { echo "pixflux: size=$size вне допустимых 16..400" >&2; exit 1; }
      ;;
    pixen)
      (( size >= 16 && size <= 768 )) || { echo "pixen: size=$size вне допустимых 16..768" >&2; exit 1; }
      (( size % 4 == 0 )) || { echo "pixen: size=$size должен быть кратен 4" >&2; exit 1; }
      (( size * size <= 512 * 512 )) || { echo "pixen: площадь ${size}x${size} превышает лимит 512x512" >&2; exit 1; }
      ;;
  esac

  # --lock-palette: по умолчанию (auto) включено для pixflux/bitforge и
  # выключено для pixen без единого слова — там просто нет color_image.
  # Явный --lock-palette при engine=pixen — предупреждение, а не отказ.
  local want_lock=0
  case "$LOCK_PALETTE" in
    on)
      if [[ "$ENGINE" == "pixen" ]]; then
        echo "  WARN: --lock-palette недоступен для pixen (нет color_image в CreateImagePixenRequest) — игнорирую" >&2
      else
        want_lock=1
      fi
      ;;
    off) want_lock=0 ;;
    auto) [[ "$ENGINE" != "pixen" ]] && want_lock=1 ;;
  esac
  local color_file=""
  [[ "$want_lock" == "1" ]] && color_file=$(palette_image_file "$palette")

  local body
  body=$(build_body "$ENGINE" "$prompt" "$size" "$seed" "$isometric" \
    "$STYLE_IMAGE" "$STYLE_STRENGTH" "$color_file" \
    "$NEGATIVE" "$GUIDANCE" "$OUTLINE" "$SHADING" "$DETAIL" "$VIEW" "$DIRECTION")

  if [[ "$DRY_RUN" == "1" ]]; then
    echo "→ $key (dry-run, engine=$ENGINE, size=$size, palette=$palette, isometric=$isometric, seed=$seed, manifest=${m_found}, lock_palette=${want_lock})"
    echo "  POST $API/create-image-$ENGINE"
    printf '%s' "$body" | python3 -c '
import json, sys

def shorten(obj):
    if isinstance(obj, dict):
        if obj.get("type") == "base64" and "base64" in obj:
            obj = dict(obj)
            b64 = obj["base64"]
            obj["base64"] = f"{b64[:32]}... (len={len(b64)})"
            return obj
        return {k: shorten(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [shorten(v) for v in obj]
    return obj

body = json.load(sys.stdin)
print(json.dumps(shorten(body), indent=2, ensure_ascii=False))
' | sed 's/^/  /'
    return 0
  fi

  if (( GEN_COUNT >= MAX_GENERATIONS )); then
    echo "MAX_GENERATIONS=$MAX_GENERATIONS достигнут за сессию — стоп перед '$key'" >&2
    exit 1
  fi

  echo "→ $key (engine=$ENGINE, size=$size, palette=$palette, isometric=$isometric, seed=$seed, lock_palette=${want_lock})"
  local resp resp_file
  resp_file="$OUT_DIR/$key.response.json"
  resp=$(do_create_request "$body")
  GEN_COUNT=$((GEN_COUNT + 1))
  printf '%s' "$resp" > "$resp_file"

  # Асинхронность определяем по факту (id+status в ответе, форма
  # BackgroundJobResponse), не по догадкам — create-image-* синхронны и
  # обычно этот путь не сработает.
  local resp_id resp_status
  resp_id=$(json_field "$resp_file" id)
  resp_status=$(json_field "$resp_file" status)
  if [[ -n "$resp_id" && -n "$resp_status" ]]; then
    echo "  ответ выглядит асинхронным (id=$resp_id status=$resp_status) — опрашиваю $JOB_STATUS_PATH каждые ${POLL_INTERVAL}s (таймаут ${POLL_TIMEOUT}s)"
    if ! poll_job "$resp_id" "$resp_file"; then
      echo "  '$key': задача не завершилась успешно" >&2
      exit 1
    fi
  fi

  node --input-type=module - "$resp_file" "$OUT_DIR/$key.raw.png" <<'NODE_EOF'
import { readFileSync, writeFileSync } from 'node:fs'
const [respPath, outPath] = process.argv.slice(2)
const r = JSON.parse(readFileSync(respPath, 'utf8'))
// Синхронный ответ: r.image.base64. Если каким-то образом пришла
// асинхронная форма (last_response) — первое найденное из
// last_response.image.base64 / last_response.images[0].base64.
let b64 = r?.image?.base64
if (!b64) {
  const lr = r?.last_response
  b64 = lr?.image?.base64 ?? lr?.images?.[0]?.base64
}
if (!b64) {
  console.error(`нет image.base64 (ни в ответе, ни в last_response.image/images[0]) в ${respPath} — сверить с /v2/openapi.json`)
  process.exit(1)
}
writeFileSync(outPath, Buffer.from(b64, 'base64'))
NODE_EOF

  local remap_args=(--key "$key")
  [[ "$m_found" != "1" ]] && remap_args+=(--size "$size" --palette "$palette")
  node "$REMAP" "$OUT_DIR/$key.raw.png" "$OUT_DIR/$key.png" "${remap_args[@]}"

  local usage_json
  usage_json=$(json_field "$resp_file" usage)
  print_usage "$usage_json"
  echo "  (генераций в сессии: $GEN_COUNT/$MAX_GENERATIONS)"
  echo "  готово (не в client/public): $OUT_DIR/$key.png — примите через --install $key $OUT_DIR/$key.png"
}

while IFS='|' read -r name prompt override_seed; do
  [[ -z "$name" || "$name" == \#* ]] && continue
  if [[ -n "$ONLY" && "$name" != "$ONLY" ]]; then continue; fi
  gen_one "$name" "$prompt" "${override_seed:-}"
done < "$PROMPTS_FILE"

if [[ "$DRY_RUN" != "1" ]]; then
  echo
  echo "Просмотр: $OUT_DIR/*.png. Куриция: LocalMind (localmind_recognize) —"
  echo "«что изображено, читается ли силуэт на игровом масштабе?»"
  echo "Приёмка: scripts/gen-sprites.sh --install <ключ> $OUT_DIR/<ключ>.png"
fi
