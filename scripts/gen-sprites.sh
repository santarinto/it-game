#!/usr/bin/env bash
# gen-sprites — dev-time пайплайн спрайтов через PixelLab API v2 (ITGAME-6,
# HD-заготовка). НЕ runtime: игра офлайн, в репо коммитятся готовые PNG из
# client/public/assets/sprites/ — этот скрипт их туда не пишет напрямую,
# см. "Установка" ниже.
#
# ДОПУЩЕНИЯ ОБ API (не подтверждены офиц. доками — сверить с
# GET /v2/openapi.json перед первым реальным вызовом; ключа/сети сейчас
# нет, весь скрипт разрабатывался и тестировался только через --dry-run):
#   • эндпоинты генерации: POST /v2/create-image-{pixen,pixflux,bitforge};
#     pixen — как раньше (description/image_size/no_background/seed);
#     pixflux — плюс "isometric": bool; bitforge — плюс опциональные
#     "style_image" (base64) и "style_strength" (0..1);
#   • ответ — либо сразу {"image":{"base64":...}, "usage"/"credits"/"cost":…},
#     либо асинхронная задача: наличие "background_job_id"/"job_id" или
#     status тела в {"processing","pending","queued"} означает "опроси
#     статус"; путь опроса ПРЕДПОЛОЖИТЕЛЬНО GET /v2/generate-image/<id>
#     (SPRITES_JOB_STATUS_PATH переопределяет шаблон, "{id}" — подстановка);
#   • терминальные статусы опроса: succeeded/completed/done/success (успех),
#     failed/error (провал), всё прочее — ещё в процессе;
#   • баланс: GET /v2/balance, бесплатный вызов, ответ — произвольный JSON.
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
JOB_STATUS_PATH=${SPRITES_JOB_STATUS_PATH:-/v2/generate-image/{id}}

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
STYLE_STRENGTH=${SPRITES_STYLE_STRENGTH:-0.5}
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
  --style-image FILE      bitforge: файл-референс стиля (base64 в тело)
  --style-strength F      bitforge: сила стиля 0..1 (default 0.5)
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
  curl -sS --fail-with-body --connect-timeout "$CONNECT_TIMEOUT" --max-time "$BALANCE_MAX_TIME" \
    "$API/balance" -H "Authorization: Bearer $KEY"
  echo
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

# Одна функция сборки тела запроса на движок — правьте поля здесь, сверяя
# с /v2/openapi.json (эндпоинты и поля НЕ подтверждены, см. шапку файла).
build_body() {
  local engine=$1 description=$2 size=$3 seed=$4 isometric=$5 style_b64_file=$6 style_strength=$7
  python3 - "$engine" "$description" "$size" "$seed" "$isometric" "$style_b64_file" "$style_strength" <<'PY'
import base64
import json
import sys

engine, desc, size, seed, isometric, style_file, style_strength = sys.argv[1:8]
size = int(size)
seed = int(seed) % 2147483647
isometric = isometric == 'true'
# HD-ключи (isometric=true, см. gen_one: привязано к palette==hd32) несут
# свой стилевой суффикс — общий для всех промптов из prompts-hd.txt.
if isometric:
    full_desc = desc + ", HD isometric pixel art game asset, 128px, clean readable silhouette, transparent background, no text"
else:
    full_desc = desc + ", flat pixel art game sprite, clean readable silhouette, few colors, no text"

if engine == 'pixen':
    body = {
        "description": full_desc,
        "image_size": {"width": size, "height": size},
        "no_background": True,
        "seed": seed,
    }
elif engine == 'pixflux':
    body = {
        "description": full_desc,
        "image_size": {"width": size, "height": size},
        "isometric": isometric,
        "no_background": True,
        "seed": seed,
    }
elif engine == 'bitforge':
    body = {
        "description": full_desc,
        "image_size": {"width": size, "height": size},
        "isometric": isometric,
        "no_background": True,
        "seed": seed,
    }
    if style_file:
        with open(style_file, 'rb') as f:
            body["style_image"] = base64.b64encode(f.read()).decode()
        body["style_strength"] = float(style_strength)
else:
    print(f"неизвестный engine {engine}", file=sys.stderr)
    sys.exit(1)

print(json.dumps(body))
PY
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

# Опрос асинхронной задачи. Форма ответа НЕ подтверждена (см. шапку файла) —
# разбор нарочно гибкий: любое поле status, любой из "терминальных" наборов.
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
      succeeded|completed|done|success) return 0 ;;
      failed|error)
        echo "job $job_id: терминальный статус '$st' — провал" >&2
        return 1
        ;;
      *) ;; # processing/pending/queued/пусто — ждём дальше
    esac
  done
  echo "job $job_id: таймаут ${POLL_TIMEOUT}s без терминального статуса" >&2
  return 1
}

gen_one() {
  local key=$1 prompt=$2 override_seed=${3:-}
  local seed
  seed=${override_seed:-$(seed_of "$key")}

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

  local body
  body=$(build_body "$ENGINE" "$prompt" "$size" "$seed" "$isometric" "$STYLE_IMAGE" "$STYLE_STRENGTH")

  if [[ "$DRY_RUN" == "1" ]]; then
    echo "→ $key (dry-run, engine=$ENGINE, size=$size, palette=$palette, isometric=$isometric, seed=$seed, manifest=${m_found})"
    echo "  POST $API/create-image-$ENGINE"
    echo "$body" | python3 -m json.tool | sed 's/^/  /'
    return 0
  fi

  if (( GEN_COUNT >= MAX_GENERATIONS )); then
    echo "MAX_GENERATIONS=$MAX_GENERATIONS достигнут за сессию — стоп перед '$key'" >&2
    exit 1
  fi

  echo "→ $key (engine=$ENGINE, size=$size, palette=$palette, isometric=$isometric, seed=$seed)"
  local resp resp_file
  resp_file="$OUT_DIR/$key.response.json"
  resp=$(curl -sS --fail-with-body --connect-timeout "$CONNECT_TIMEOUT" --max-time "$MAX_TIME" \
    -X POST "$API/create-image-$ENGINE" \
    -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
    -d "$body")
  GEN_COUNT=$((GEN_COUNT + 1))
  printf '%s' "$resp" > "$resp_file"

  # Асинхронная задача? Проверяем оба гибких признака: явный job id или
  # status в незавершённом наборе (см. допущения в шапке файла).
  local job_id status
  job_id=$(json_field "$resp_file" background_job_id)
  [[ -z "$job_id" ]] && job_id=$(json_field "$resp_file" job_id)
  status=$(json_field "$resp_file" status)
  case "$status" in
    processing|pending|queued) ;;
    *) status="" ;;
  esac
  if [[ -n "$job_id" || -n "$status" ]]; then
    if [[ -z "$job_id" ]]; then
      echo "  ответ выглядит асинхронным (status=$status), но нет job id (background_job_id/job_id) — не могу опросить" >&2
      exit 1
    fi
    echo "  асинхронная задача job=$job_id — опрашиваю $JOB_STATUS_PATH каждые ${POLL_INTERVAL}s (таймаут ${POLL_TIMEOUT}s)"
    if ! poll_job "$job_id" "$resp_file"; then
      echo "  '$key': задача не завершилась успешно" >&2
      exit 1
    fi
  fi

  node --input-type=module - "$resp_file" "$OUT_DIR/$key.raw.png" <<'NODE_EOF'
import { readFileSync, writeFileSync } from 'node:fs'
const [respPath, outPath] = process.argv.slice(2)
const r = JSON.parse(readFileSync(respPath, 'utf8'))
// Форма ответа не подтверждена (см. шапку файла): предполагаем image.base64.
const b64 = r?.image?.base64
if (!b64) {
  console.error(`нет image.base64 в ${respPath} — сверить форму ответа с /v2/openapi.json`)
  process.exit(1)
}
writeFileSync(outPath, Buffer.from(b64, 'base64'))
NODE_EOF

  local remap_args=(--key "$key")
  [[ "$m_found" != "1" ]] && remap_args+=(--size "$size" --palette "$palette")
  node "$REMAP" "$OUT_DIR/$key.raw.png" "$OUT_DIR/$key.png" "${remap_args[@]}"

  local usage_json
  usage_json=$(json_field "$resp_file" usage)
  [[ -z "$usage_json" ]] && usage_json=$(json_field "$resp_file" credits)
  [[ -z "$usage_json" ]] && usage_json=$(json_field "$resp_file" cost)
  echo "  usage/cost: ${usage_json:-н/д} (генераций в сессии: $GEN_COUNT/$MAX_GENERATIONS)"
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
