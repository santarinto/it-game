// СГЕНЕРИРОВАНО scripts/gen-contract.mjs из ItdApi — руками не править. npm run gen:contract
import type { ItdApi, MemberSpec, TypeSpec } from './agentApi'
export const CONTRACT = {
  "schema": 1,
  "hash": "4f6b00aec527",
  "methods": {
    "version": {
      "kind": "prop",
      "type": "{ sha: string; builtAt: string; }",
      "readonly": true,
      "doc": "Штамп сборки: {sha, builtAt} + `<meta name=\"build\">` в html."
    },
    "state": {
      "kind": "method",
      "params": [],
      "returns": "AgentState",
      "doc": "Баланс, день, часы, доход, ФОТ, штат, сеть, долг, цель, сид/сценарий\n(null до первого снапшота); menuReady — меню создано, активно и сводка сейва устоялась.",
      "examples": [
        "itd.state()"
      ]
    },
    "server": {
      "kind": "method",
      "params": [],
      "returns": "AgentServer",
      "doc": "Снапшот целиком + сокет: open|reconnecting|closed, lastEventId, rtt,\nreconnects, sid, sidSwitches.",
      "examples": [
        "itd.server()"
      ]
    },
    "nodes": {
      "kind": "method",
      "params": [],
      "returns": "AgentNode[]",
      "doc": "Все объекты живых сцен: {scene, type, id, text, x, y, w, h, visible,\nalpha, interactive, depth, active}.",
      "examples": [
        "itd.nodes()"
      ]
    },
    "text": {
      "kind": "method",
      "params": [],
      "returns": "AgentNode[]",
      "doc": "nodes() с непустым текстом.",
      "examples": [
        "itd.text()"
      ]
    },
    "ids": {
      "kind": "method",
      "params": [],
      "returns": "{ id: string; scene: string; type: string; text: string | null; active: boolean | null; }[]",
      "doc": "Стабильные id интерактивов (btn.*, nav.*, office.*, room.*, menu.*,\nmodal.*) + active — состояние переключателя, null у прочих (НЕ\nGameObject.active).",
      "examples": [
        "itd.ids()"
      ]
    },
    "click": {
      "kind": "method",
      "params": [
        {
          "name": "id",
          "type": "string",
          "optional": false
        }
      ],
      "returns": "AgentResult & { id?: string; scene?: string; }",
      "doc": "Клик по id: дёргает pointerdown-обработчик напрямую, мимо input-слоя.\nok:false + code 'debounced' — обработчик отбросил клик (дребезг switchRoom\n250 мс игрового времени): повторите после паузы.",
      "examples": [
        "itd.click('btn.hire')"
      ]
    },
    "hover": {
      "kind": "method",
      "params": [
        {
          "name": "id",
          "type": "string",
          "optional": false
        }
      ],
      "returns": "AgentResult & { id?: string; scene?: string; }",
      "doc": "Наведение по id (тултипы).",
      "examples": [
        "itd.hover('office.worker.0')"
      ]
    },
    "key": {
      "kind": "method",
      "params": [
        {
          "name": "k",
          "type": "string",
          "optional": false
        }
      ],
      "returns": "AgentResult & { key?: string; scenes?: string[]; }",
      "doc": "Клавиша: 1-4 — сложность в меню, up/down — фокус меню, enter — пункт в фокусе меню / отчёт дня, space/esc — отчёт дня.",
      "examples": [
        "itd.key('enter')"
      ]
    },
    "cmd": {
      "kind": "method",
      "params": [
        {
          "name": "type",
          "type": "'buy_pc' | 'hire' | 'buy_router' | 'hire_boss' | 'buy_office' | 'buy_server' | 'buy_gateway' | 'next_day' | 'restart' | 'buy_cooler' | 'buy_fridge' | 'buy_coffee' | 'set_speed' | 'upgrade_server' | 'upgrade_core' | 'motivate' | 'repair_click' | 'call_master' | 'event_choice' | 'fire' | 'abandon'",
          "optional": false
        },
        {
          "name": "office",
          "type": "number",
          "optional": true
        },
        {
          "name": "extra",
          "type": "Record<string, number>",
          "optional": true
        }
      ],
      "returns": "Promise<CmdReceipt>",
      "doc": "Команда с квитанцией сервера (ITGAME-30): Promise<{ok, code?}> — первый\nstate|error после отправки, по порядку команд.",
      "examples": [
        "await itd.cmd('hire')"
      ]
    },
    "trace": {
      "kind": "method",
      "params": [
        {
          "name": "action",
          "type": "() => unknown",
          "optional": false
        },
        {
          "name": "windowMs",
          "type": "number",
          "optional": true
        }
      ],
      "returns": "Promise<TraceResult>",
      "doc": "Живая трассировка окна вокруг action (ITGAME-37): подписка ДО action,\nокно windowMs (0..10000, по умолчанию 1000) ПОСЛЕ него — реальный путь\nигрока (клавиши/команды/переходы/тосты/звуки), а не срез log()/net().",
      "examples": [
        "itd.trace(() => itd.click('btn.pc'), 1000)"
      ]
    },
    "warm": {
      "kind": "method",
      "params": [],
      "returns": "number",
      "doc": "Прогреть кадр вручную (сколько шагов лупа сделали); в скрытой вкладке\nitd делает это сам.",
      "examples": [
        "itd.warm()"
      ]
    },
    "wait": {
      "kind": "method",
      "params": [
        {
          "name": "cond",
          "type": "(s: AgentState, srv: AgentServer) => boolean",
          "optional": false
        },
        {
          "name": "timeoutMs",
          "type": "number",
          "optional": true
        }
      ],
      "returns": "Promise<AgentState>",
      "doc": "Промис: поллинг state()/server() до условия (таймаут 5с по умолчанию,\nвторой аргумент — свой).",
      "examples": [
        "itd.wait(s => s.day === 2)"
      ]
    },
    "overlaps": {
      "kind": "method",
      "params": [
        {
          "name": "opts",
          "type": "OverlapOptions",
          "optional": true
        }
      ],
      "returns": "OverlapEntry[]",
      "doc": "Линтер вёрстки: kind text — тексты одного depth; occlusion — текст под\nнепрозрачной плашкой; interactive — интерактив частично перекрыт\nинтерактивом или текстом (вложенность целиком — не находка). Каждая\nпара: ratio — площадь пересечения / площадь меньшего из пары (occlusion —\n/ площадь текста), threshold — порог, с которым сравнили. minAreaRatio\n0..1 заменяет пороги по умолчанию для всех kind (text и interactive — 0,\nocclusion — 0.25 и >50% по каждой оси: заданный minAreaRatio снимает и\nправило по осям, находок может стать больше, чем без него); 0 — строгий\nрежим, вне 0..1 — RangeError.",
      "examples": [
        "itd.overlaps()",
        "itd.overlaps({ minAreaRatio: 0 })"
      ]
    },
    "offscreen": {
      "kind": "method",
      "params": [],
      "returns": "OffscreenEntry[]",
      "doc": "Линтер: вылезание за канвас 1280×720.",
      "examples": [
        "itd.offscreen()"
      ]
    },
    "contrast": {
      "kind": "method",
      "params": [],
      "returns": "ContrastEntry[]",
      "doc": "Линтер: контраст текста к фону ниже 3:1.",
      "examples": [
        "itd.contrast()"
      ]
    },
    "tiny": {
      "kind": "method",
      "params": [],
      "returns": "TinyEntry[]",
      "doc": "Линтер: шрифт мельче 12px.",
      "examples": [
        "itd.tiny()"
      ]
    },
    "assets": {
      "kind": "method",
      "params": [],
      "returns": "{ textures: AssetReport[]; duplicates: { keys: string[]; expected: boolean; }[]; textTextures: number; }",
      "doc": "Аудит текстур: размер, прозрачность %, доля #f4f4f4, цвета вне\nпалитры манифеста этого ключа (manifest.palettes[spec.palette]), дубли\nключей.",
      "examples": [
        "itd.assets()"
      ]
    },
    "assetSet": {
      "kind": "method",
      "params": [],
      "returns": "AssetSetEntry[]",
      "doc": "Чем рисуют сцены: png (подменён из assets/) или pixelart (кодоген-фолбэк).",
      "examples": [
        "itd.assetSet()"
      ]
    },
    "reset": {
      "kind": "method",
      "params": [],
      "returns": "AgentResult & { removed: string[]; }",
      "doc": "Снести все ключи itd.* (sid в обоих хранилищах, сложность, хинты, зум,\nотчёты).",
      "examples": [
        "itd.reset()"
      ]
    },
    "log": {
      "kind": "method",
      "params": [
        {
          "name": "n",
          "type": "number",
          "optional": true
        }
      ],
      "returns": "LogEntry[]",
      "doc": "Журнал переходов (кольцевой на 200, переживает чистку консоли); + звуки\nи тосты ({type:'sound', ...} / {type:'toast', ...}).",
      "examples": [
        "itd.log(50)"
      ]
    },
    "errors": {
      "kind": "method",
      "params": [],
      "returns": "ErrorEntry[]",
      "doc": "Ошибки страницы (window.onerror + unhandledrejection).",
      "examples": [
        "itd.errors()"
      ]
    },
    "net": {
      "kind": "method",
      "params": [
        {
          "name": "n",
          "type": "number",
          "optional": true
        }
      ],
      "returns": "{ socket: AgentServer['socket']; reconnects: number; rtt: number | null; last: { dir: 'in' | 'out'; at: number; type: string; info: Record<string, unknown>; }[]; }",
      "doc": "Последние сообщения WS в обе стороны + сокет/rtt/реконнекты.",
      "examples": [
        "itd.net(20)"
      ]
    },
    "pause": {
      "kind": "method",
      "params": [],
      "returns": "AgentResult & { code?: string; }",
      "doc": "Темп сессии — пауза (set_speed 0, серверный, живёт в сейве); до коннекта\n— {ok:false, code:'not_connected'}.",
      "examples": [
        "itd.pause()"
      ]
    },
    "resume": {
      "kind": "method",
      "params": [],
      "returns": "AgentResult & { code?: string; }",
      "doc": "Темп сессии — возобновить (set_speed 1).",
      "examples": [
        "itd.resume()"
      ]
    },
    "speed": {
      "kind": "method",
      "params": [
        {
          "name": "n",
          "type": "number",
          "optional": false
        }
      ],
      "returns": "AgentResult & { code?: string; }",
      "doc": "Темп сессии: set_speed 0..3 (0 — пауза).",
      "examples": [
        "itd.speed(2)"
      ]
    },
    "step": {
      "kind": "method",
      "params": [
        {
          "name": "ms",
          "type": "number",
          "optional": false
        }
      ],
      "returns": "Promise<DebugAdvanceResult>",
      "doc": "Пауза + промотка ms игровых тиков через /api/debug/advance (2000мс =\n2 тика).",
      "examples": [
        "itd.step(2000)"
      ]
    },
    "advanceDays": {
      "kind": "method",
      "params": [
        {
          "name": "n",
          "type": "number",
          "optional": false
        }
      ],
      "returns": "Promise<DebugAdvanceResult>",
      "doc": "Промотка дней офлайн-движком: день N → N+n, отчёты дней в itd.log().",
      "examples": [
        "itd.advanceDays(3)"
      ]
    },
    "set": {
      "kind": "method",
      "params": [
        {
          "name": "patch",
          "type": "{ money?: number; day?: number; tickInDay?: number; }",
          "optional": false
        }
      ],
      "returns": "Promise<DebugState>",
      "doc": "Читы живой сессии: {money, day, tickInDay}.",
      "examples": [
        "itd.set({money: 50000})"
      ]
    },
    "scenario": {
      "kind": "method",
      "params": [
        {
          "name": "name",
          "type": "string",
          "optional": false
        }
      ],
      "returns": "Promise<DebugState>",
      "doc": "Пересоздать партию фикстурой: fresh|broke_day3|mid_day10|full_office|\nsoft_lock|pre_victory|spare_pcs.",
      "examples": [
        "itd.scenario('soft_lock')"
      ]
    },
    "snapshot": {
      "kind": "method",
      "params": [],
      "returns": "Promise<DebugState>",
      "doc": "Полный стейт с сервера: {sid, state, save, events}.",
      "examples": [
        "await itd.snapshot()"
      ]
    },
    "restore": {
      "kind": "method",
      "params": [
        {
          "name": "save",
          "type": "Record<string, unknown>",
          "optional": false
        }
      ],
      "returns": "Promise<DebugState>",
      "doc": "Вернуть состояние из snapshot().save (дельта над текущим).",
      "examples": [
        "itd.restore(save)"
      ]
    },
    "quiet": {
      "kind": "method",
      "params": [],
      "returns": "AgentResult",
      "doc": "Стоп твитов/миганий для стабильных скриншотов.",
      "examples": [
        "itd.quiet()"
      ]
    },
    "meta": {
      "kind": "method",
      "params": [],
      "returns": "{ stats: MetaStats; achievements: { unlockedCount: number; totalCount: number; list: (AchievementDef & { unlocked: boolean; unlockedAt?: number; })[]; }; }",
      "doc": "Статистика прогонов и состояние достижений (localStorage).",
      "examples": [
        "itd.meta()"
      ]
    },
    "resetMeta": {
      "kind": "method",
      "params": [],
      "returns": "AgentResult",
      "doc": "Сбросить мета-статистику и достижения.",
      "examples": [
        "itd.resetMeta()"
      ]
    },
    "unlockAchievement": {
      "kind": "method",
      "params": [
        {
          "name": "id",
          "type": "string",
          "optional": false
        }
      ],
      "returns": "AgentResult & { achievement?: AchievementDef; }",
      "doc": "Принудительно открыть ачивку: {ok:true, achievement} | {ok:false, code}.",
      "examples": [
        "itd.unlockAchievement('id')"
      ]
    },
    "help": {
      "kind": "method",
      "params": [],
      "returns": "string",
      "doc": "Человекочитаемая справка по всем методам (печатает в консоль и\nвозвращает ту же строку).",
      "examples": [
        "itd.help()"
      ]
    },
    "contract": {
      "kind": "method",
      "params": [],
      "returns": "ItdContract",
      "doc": "Машинный контракт API (ITGAME-39): методы, типы, коды ошибок и команд;\nversion.hash — цитировать в отчётах приёмки вместо пересказа help().",
      "examples": [
        "itd.contract().version.hash"
      ]
    }
  },
  "types": {
    "AchievementDef": {
      "kind": "object",
      "fields": {
        "id": {
          "type": "string",
          "optional": false,
          "doc": ""
        },
        "title": {
          "type": "string",
          "optional": false,
          "doc": ""
        },
        "desc": {
          "type": "string",
          "optional": false,
          "doc": ""
        },
        "icon": {
          "type": "string",
          "optional": false,
          "doc": ""
        }
      }
    },
    "ActiveEventInfo": {
      "kind": "object",
      "fields": {
        "id": {
          "type": "'virus' | 'deadline' | 'audit' | 'raise' | 'star'",
          "optional": false,
          "doc": ""
        },
        "title": {
          "type": "string",
          "optional": false,
          "doc": ""
        },
        "text": {
          "type": "string",
          "optional": false,
          "doc": ""
        },
        "options": {
          "type": "string[]",
          "optional": false,
          "doc": "индекс опции уходит в event_choice (slot)"
        }
      }
    },
    "AgentNode": {
      "kind": "object",
      "fields": {
        "scene": {
          "type": "string",
          "optional": false,
          "doc": ""
        },
        "type": {
          "type": "string",
          "optional": false,
          "doc": ""
        },
        "id": {
          "type": "string | null",
          "optional": false,
          "doc": ""
        },
        "text": {
          "type": "string | null",
          "optional": false,
          "doc": ""
        },
        "x": {
          "type": "number",
          "optional": false,
          "doc": ""
        },
        "y": {
          "type": "number",
          "optional": false,
          "doc": ""
        },
        "w": {
          "type": "number",
          "optional": false,
          "doc": ""
        },
        "h": {
          "type": "number",
          "optional": false,
          "doc": ""
        },
        "visible": {
          "type": "boolean",
          "optional": false,
          "doc": ""
        },
        "alpha": {
          "type": "number",
          "optional": false,
          "doc": ""
        },
        "interactive": {
          "type": "boolean",
          "optional": false,
          "doc": ""
        },
        "depth": {
          "type": "number",
          "optional": false,
          "doc": ""
        },
        "active": {
          "type": "boolean | null",
          "optional": false,
          "doc": ""
        }
      }
    },
    "AgentResult": {
      "kind": "object",
      "fields": {
        "ok": {
          "type": "boolean",
          "optional": false,
          "doc": ""
        },
        "error": {
          "type": "string",
          "optional": true,
          "doc": ""
        },
        "code": {
          "type": "string",
          "optional": true,
          "doc": ""
        }
      }
    },
    "AgentServer": {
      "kind": "object",
      "fields": {
        "socket": {
          "type": "'open' | 'reconnecting' | 'closed'",
          "optional": false,
          "doc": ""
        },
        "lastEventId": {
          "type": "number",
          "optional": false,
          "doc": "счётчик принятых сообщений (своих id у протокола нет)"
        },
        "rtt": {
          "type": "number | null",
          "optional": false,
          "doc": "мс от последней команды до ближайшего ответа"
        },
        "reconnects": {
          "type": "number",
          "optional": false,
          "doc": ""
        },
        "lastMessageAt": {
          "type": "number | null",
          "optional": false,
          "doc": "epoch ms"
        },
        "sid": {
          "type": "string",
          "optional": false,
          "doc": "ITGAME-30: sid текущего соединения (каким партиям уезжают команды)"
        },
        "sidSwitches": {
          "type": "number",
          "optional": false,
          "doc": "ITGAME-30: сколько раз sid сменился между соединениями (гарда вкладок)"
        },
        "snapshot": {
          "type": "StateMessage | null",
          "optional": false,
          "doc": ""
        }
      }
    },
    "AgentState": {
      "kind": "object",
      "fields": {
        "connected": {
          "type": "boolean",
          "optional": false,
          "doc": ""
        },
        "menuReady": {
          "type": "boolean",
          "optional": false,
          "doc": ""
        },
        "balance": {
          "type": "number | null",
          "optional": false,
          "doc": ""
        },
        "day": {
          "type": "number | null",
          "optional": false,
          "doc": ""
        },
        "clock": {
          "type": "string | null",
          "optional": false,
          "doc": ""
        },
        "lunch": {
          "type": "boolean | null",
          "optional": false,
          "doc": ""
        },
        "phase": {
          "type": "'running' | 'day_report' | 'game_over' | 'won' | null",
          "optional": false,
          "doc": ""
        },
        "speed": {
          "type": "number | null",
          "optional": false,
          "doc": ""
        },
        "difficulty": {
          "type": "DifficultyId | null",
          "optional": false,
          "doc": ""
        },
        "incomePerTick": {
          "type": "number | null",
          "optional": false,
          "doc": ""
        },
        "payrollPerDay": {
          "type": "number | null",
          "optional": false,
          "doc": ""
        },
        "forecastEndOfDay": {
          "type": "number | null",
          "optional": false,
          "doc": ""
        },
        "staff": {
          "type": "number | null",
          "optional": false,
          "doc": ""
        },
        "staffConnected": {
          "type": "number | null",
          "optional": false,
          "doc": ""
        },
        "staffLimit": {
          "type": "number | null",
          "optional": false,
          "doc": ""
        },
        "officesUnlocked": {
          "type": "number | null",
          "optional": false,
          "doc": ""
        },
        "officesTotal": {
          "type": "number | null",
          "optional": false,
          "doc": ""
        },
        "servers": {
          "type": "number | null",
          "optional": false,
          "doc": ""
        },
        "coreLevel": {
          "type": "number | null",
          "optional": false,
          "doc": ""
        },
        "coreConnected": {
          "type": "number | null",
          "optional": false,
          "doc": ""
        },
        "coreCapacity": {
          "type": "number | null",
          "optional": false,
          "doc": ""
        },
        "gateway": {
          "type": "boolean | null",
          "optional": false,
          "doc": ""
        },
        "debt": {
          "type": "number | null",
          "optional": false,
          "doc": "-balance, когда баланс ушёл в минус"
        },
        "creditLimit": {
          "type": "number | null",
          "optional": false,
          "doc": ""
        },
        "creditRatePct": {
          "type": "number | null",
          "optional": false,
          "doc": ""
        },
        "winTarget": {
          "type": "number | null",
          "optional": false,
          "doc": ""
        },
        "winStaff": {
          "type": "number | null",
          "optional": false,
          "doc": ""
        },
        "winCore": {
          "type": "number | null",
          "optional": false,
          "doc": ""
        },
        "winDayLimit": {
          "type": "number | null",
          "optional": false,
          "doc": ""
        },
        "activeEvent": {
          "type": "string | null",
          "optional": false,
          "doc": ""
        },
        "seed": {
          "type": "string | null",
          "optional": false,
          "doc": ""
        },
        "scenario": {
          "type": "string | null",
          "optional": false,
          "doc": ""
        },
        "tickInDay": {
          "type": "number | null",
          "optional": false,
          "doc": ""
        },
        "dayIncome": {
          "type": "number | null",
          "optional": false,
          "doc": ""
        },
        "dayProfit": {
          "type": "number | null",
          "optional": false,
          "doc": "= hud.dayProfit и «Прибыль» отчёта к концу дня (ITGAME-53)"
        }
      }
    },
    "AssetReport": {
      "kind": "object",
      "fields": {
        "key": {
          "type": "string",
          "optional": false,
          "doc": ""
        },
        "source": {
          "type": "'png' | 'pixelart'",
          "optional": false,
          "doc": "чем заполнен ключ: подменённый PNG или кодоген"
        },
        "w": {
          "type": "number",
          "optional": false,
          "doc": ""
        },
        "h": {
          "type": "number",
          "optional": false,
          "doc": ""
        },
        "transparentPct": {
          "type": "number",
          "optional": false,
          "doc": "доля прозрачных пикселей (alpha < 26)"
        },
        "f4Pct": {
          "type": "number",
          "optional": false,
          "doc": "доля #f4f4f4: детектор запечённого чекерборда/фона"
        },
        "offPalette": {
          "type": "string[]",
          "optional": false,
          "doc": "цвета вне палитры манифеста этого ключа (у кодогена пусто всегда)"
        }
      }
    },
    "AssetSetEntry": {
      "kind": "object",
      "fields": {
        "key": {
          "type": "string",
          "optional": false,
          "doc": ""
        },
        "pngLoaded": {
          "type": "boolean",
          "optional": false,
          "doc": "ai:<key> приехал с сервера"
        },
        "active": {
          "type": "'png' | 'pixelart'",
          "optional": false,
          "doc": "чем реально рисуют сцены"
        }
      }
    },
    "CmdReceipt": {
      "kind": "object",
      "fields": {
        "ok": {
          "type": "boolean",
          "optional": false,
          "doc": ""
        },
        "code": {
          "type": "'not_enough_money' | 'no_free_office_slot' | 'no_free_pc' | 'no_free_rack_slot' | 'router_maxed' | 'wrong_phase' | 'staff_limit' | 'office_locked' | 'boss_already' | 'offices_maxed' | 'gateway_already' | 'bad_office' | 'equipment_already' | 'bad_slot' | 'server_maxed' | 'core_maxed' | 'motivate_cooldown' | 'not_broken' | 'no_event' | 'bad_option' | 'unknown_command' | 'bad_speed' | 'not_connected' | 'receipt_timeout' | 'disconnected'",
          "optional": true,
          "doc": ""
        },
        "error": {
          "type": "string",
          "optional": true,
          "doc": ""
        }
      }
    },
    "CommandType": {
      "kind": "enum",
      "values": [
        "abandon",
        "buy_coffee",
        "buy_cooler",
        "buy_fridge",
        "buy_gateway",
        "buy_office",
        "buy_pc",
        "buy_router",
        "buy_server",
        "call_master",
        "event_choice",
        "fire",
        "hire",
        "hire_boss",
        "motivate",
        "next_day",
        "repair_click",
        "restart",
        "set_speed",
        "upgrade_core",
        "upgrade_server"
      ]
    },
    "ContrastEntry": {
      "kind": "object",
      "fields": {
        "scene": {
          "type": "string",
          "optional": false,
          "doc": ""
        },
        "id": {
          "type": "string | null",
          "optional": false,
          "doc": ""
        },
        "text": {
          "type": "string",
          "optional": false,
          "doc": "сниппет"
        },
        "fg": {
          "type": "string",
          "optional": false,
          "doc": ""
        },
        "bg": {
          "type": "string",
          "optional": false,
          "doc": ""
        },
        "ratio": {
          "type": "number",
          "optional": false,
          "doc": ""
        }
      }
    },
    "CoreInfo": {
      "kind": "object",
      "fields": {
        "level": {
          "type": "number",
          "optional": false,
          "doc": "0 — не куплен"
        },
        "capacity": {
          "type": "number",
          "optional": false,
          "doc": ""
        },
        "connected": {
          "type": "number",
          "optional": false,
          "doc": "занято мест по компании"
        },
        "mult": {
          "type": "number",
          "optional": false,
          "doc": "1.1 на финальном уровне, иначе 1.0"
        },
        "nextPrice": {
          "type": "number",
          "optional": false,
          "doc": ""
        },
        "maxed": {
          "type": "boolean",
          "optional": false,
          "doc": ""
        }
      }
    },
    "DebugAdvanceResult": {
      "kind": "object",
      "fields": {
        "sid": {
          "type": "string",
          "optional": false,
          "doc": ""
        },
        "advance": {
          "type": "{ ticks: number; days: number; income: number; payroll: number; balance: number; gameOver: boolean; victory: boolean; reason?: string; }",
          "optional": false,
          "doc": ""
        },
        "state": {
          "type": "StateMessage",
          "optional": false,
          "doc": ""
        }
      }
    },
    "DebugState": {
      "kind": "object",
      "fields": {
        "sid": {
          "type": "string",
          "optional": false,
          "doc": ""
        },
        "state": {
          "type": "StateMessage",
          "optional": false,
          "doc": ""
        },
        "save": {
          "type": "Record<string, unknown>",
          "optional": false,
          "doc": ""
        },
        "events": {
          "type": "string[]",
          "optional": true,
          "doc": ""
        }
      }
    },
    "DifficultyId": {
      "kind": "enum",
      "values": [
        "easy",
        "hard",
        "hardcore",
        "normal"
      ]
    },
    "DifficultyStats": {
      "kind": "object",
      "fields": {
        "runs": {
          "type": "number",
          "optional": false,
          "doc": ""
        },
        "wins": {
          "type": "number",
          "optional": false,
          "doc": ""
        },
        "bankruptcies": {
          "type": "number",
          "optional": false,
          "doc": ""
        },
        "timeUps": {
          "type": "number",
          "optional": false,
          "doc": ""
        },
        "bestDay": {
          "type": "number",
          "optional": false,
          "doc": ""
        },
        "bestWinDay": {
          "type": "number | null",
          "optional": false,
          "doc": ""
        },
        "bestBalance": {
          "type": "number",
          "optional": false,
          "doc": ""
        }
      }
    },
    "EffectInfo": {
      "kind": "object",
      "fields": {
        "token": {
          "type": "'thirst' | 'hunger' | 'coffee' | 'motivated' | 'offended'",
          "optional": false,
          "doc": ""
        },
        "percent": {
          "type": "number",
          "optional": false,
          "doc": ""
        },
        "until": {
          "type": "string",
          "optional": false,
          "doc": "«HH:MM»; '' — до конца дня"
        }
      }
    },
    "EmployeeInfo": {
      "kind": "object",
      "fields": {
        "name": {
          "type": "string",
          "optional": false,
          "doc": ""
        },
        "incomePerTick": {
          "type": "number",
          "optional": false,
          "doc": ""
        },
        "effectiveIncomePerTick": {
          "type": "number",
          "optional": false,
          "doc": ""
        },
        "connected": {
          "type": "boolean",
          "optional": false,
          "doc": "получил место в ёмкости core"
        },
        "unpaidToday": {
          "type": "boolean",
          "optional": false,
          "doc": ""
        },
        "effects": {
          "type": "EffectInfo[]",
          "optional": false,
          "doc": ""
        },
        "netMult": {
          "type": "number",
          "optional": false,
          "doc": ""
        },
        "serverSlot": {
          "type": "number",
          "optional": false,
          "doc": "1-based сервер; 0 — без сервера"
        },
        "offlineReason": {
          "type": "'' | 'no_router' | 'no_core' | 'no_server'",
          "optional": false,
          "doc": ""
        },
        "pcBroken": {
          "type": "boolean",
          "optional": false,
          "doc": "ПК сломан: доход места 0 до починки"
        },
        "repairClicks": {
          "type": "number",
          "optional": false,
          "doc": "клики починки уже сделаны"
        },
        "motivateReadyAt": {
          "type": "string",
          "optional": false,
          "doc": "«HH:MM» клика возможен; '' — уже можно"
        },
        "salary": {
          "type": "number",
          "optional": false,
          "doc": "дневная зарплата этого сотрудника с надбавками"
        },
        "level": {
          "type": "number",
          "optional": false,
          "doc": "0–3; производный от XP"
        },
        "xp": {
          "type": "number",
          "optional": false,
          "doc": "накопленный опыт"
        },
        "xpNext": {
          "type": "number",
          "optional": false,
          "doc": "до следующего уровня; 0 — потолок"
        },
        "star": {
          "type": "boolean",
          "optional": false,
          "doc": "звезда: золотой бейдж, выработка ×1.5 при найме"
        },
        "firePrice": {
          "type": "number",
          "optional": false,
          "doc": "компенсация увольнения этого сотрудника"
        },
        "hiredToday": {
          "type": "boolean",
          "optional": false,
          "doc": "нанят в текущий день (компенсация ниже)"
        }
      }
    },
    "ErrorEntry": {
      "kind": "object",
      "fields": {
        "t": {
          "type": "number",
          "optional": false,
          "doc": ""
        },
        "kind": {
          "type": "'error' | 'unhandledrejection'",
          "optional": false,
          "doc": ""
        },
        "message": {
          "type": "string",
          "optional": false,
          "doc": ""
        }
      }
    },
    "FieldSpec": {
      "kind": "object",
      "fields": {
        "type": {
          "type": "string",
          "optional": false,
          "doc": ""
        },
        "optional": {
          "type": "boolean",
          "optional": false,
          "doc": ""
        },
        "doc": {
          "type": "string",
          "optional": false,
          "doc": ""
        }
      }
    },
    "ItdContract": {
      "kind": "object",
      "fields": {
        "schema": {
          "type": "1",
          "optional": false,
          "doc": ""
        },
        "version": {
          "type": "{ sha: string; builtAt: string; hash: string; }",
          "optional": false,
          "doc": ""
        },
        "methods": {
          "type": "Record<string, MemberSpec>",
          "optional": false,
          "doc": ""
        },
        "types": {
          "type": "Record<string, TypeSpec>",
          "optional": false,
          "doc": ""
        }
      }
    },
    "LogEntry": {
      "kind": "object",
      "fields": {
        "t": {
          "type": "number",
          "optional": false,
          "doc": "epoch ms"
        },
        "type": {
          "type": "string",
          "optional": false,
          "doc": ""
        }
      },
      "index": [
        "[k: string]: unknown"
      ]
    },
    "MemberSpec": {
      "kind": "alias",
      "type": "{ kind: 'method'; params: ParamSpec[]; returns: string; doc: string; examples: string[]; } | { kind: 'prop'; type: string; readonly: boolean; doc: string; }"
    },
    "MetaStats": {
      "kind": "object",
      "fields": {
        "totalRuns": {
          "type": "number",
          "optional": false,
          "doc": ""
        },
        "totalWins": {
          "type": "number",
          "optional": false,
          "doc": ""
        },
        "totalLosses": {
          "type": "number",
          "optional": false,
          "doc": ""
        },
        "peakBalance": {
          "type": "number",
          "optional": false,
          "doc": ""
        },
        "peakDay": {
          "type": "number",
          "optional": false,
          "doc": ""
        },
        "byDifficulty": {
          "type": "Record<DifficultyId, DifficultyStats>",
          "optional": false,
          "doc": ""
        }
      }
    },
    "OfficeInfo": {
      "kind": "object",
      "fields": {
        "unlocked": {
          "type": "boolean",
          "optional": false,
          "doc": ""
        },
        "price": {
          "type": "number",
          "optional": false,
          "doc": ""
        },
        "pcs": {
          "type": "number",
          "optional": false,
          "doc": ""
        },
        "nextPC": {
          "type": "number",
          "optional": false,
          "doc": "цена следующего ПК офиса (растёт ×1.15); 0 — мест нет"
        },
        "routerTier": {
          "type": "number",
          "optional": false,
          "doc": ""
        },
        "ports": {
          "type": "number",
          "optional": false,
          "doc": ""
        },
        "nextRouter": {
          "type": "number",
          "optional": false,
          "doc": ""
        },
        "nextPorts": {
          "type": "number",
          "optional": false,
          "doc": "порты следующего тира; 0 — тир максимальный"
        },
        "boss": {
          "type": "string",
          "optional": false,
          "doc": ""
        },
        "bossUnpaidToday": {
          "type": "boolean",
          "optional": false,
          "doc": ""
        },
        "employees": {
          "type": "EmployeeInfo[]",
          "optional": false,
          "doc": ""
        },
        "cooler": {
          "type": "boolean",
          "optional": false,
          "doc": ""
        },
        "fridge": {
          "type": "boolean",
          "optional": false,
          "doc": ""
        },
        "coffeeMachine": {
          "type": "boolean",
          "optional": false,
          "doc": ""
        },
        "virusUntil": {
          "type": "string",
          "optional": false,
          "doc": "вирус: «HH:MM»; '' — нет"
        },
        "servers": {
          "type": "ServerInfo[]",
          "optional": false,
          "doc": ""
        },
        "serverSlots": {
          "type": "number",
          "optional": false,
          "doc": ""
        }
      }
    },
    "OffscreenEntry": {
      "kind": "object",
      "fields": {
        "scene": {
          "type": "string",
          "optional": false,
          "doc": ""
        },
        "type": {
          "type": "string",
          "optional": false,
          "doc": ""
        },
        "id": {
          "type": "string | null",
          "optional": false,
          "doc": ""
        },
        "text": {
          "type": "string | null",
          "optional": false,
          "doc": ""
        },
        "bounds": {
          "type": "{ x: number; y: number; w: number; h: number; }",
          "optional": false,
          "doc": ""
        },
        "out": {
          "type": "{ left: number; right: number; top: number; bottom: number; }",
          "optional": false,
          "doc": "на сколько вылез, px"
        }
      }
    },
    "OverlapEntry": {
      "kind": "object",
      "fields": {
        "scene": {
          "type": "string",
          "optional": false,
          "doc": ""
        },
        "kind": {
          "type": "OverlapKind",
          "optional": false,
          "doc": ""
        },
        "a": {
          "type": "string",
          "optional": false,
          "doc": "сниппет текста или id"
        },
        "b": {
          "type": "string",
          "optional": false,
          "doc": ""
        },
        "overlap": {
          "type": "{ w: number; h: number; }",
          "optional": false,
          "doc": ""
        },
        "at": {
          "type": "{ x: number; y: number; }",
          "optional": false,
          "doc": ""
        },
        "ratio": {
          "type": "number",
          "optional": false,
          "doc": "доля перекрытия 0..1: площадь пересечения / площадь меньшего из пары (occlusion — / площадь текста), 3 знака"
        },
        "threshold": {
          "type": "number",
          "optional": false,
          "doc": "порог, с которым сравнили ratio: minAreaRatio из вызова или DEFAULT_MIN_AREA_RATIO[kind]"
        }
      }
    },
    "OverlapKind": {
      "kind": "enum",
      "values": [
        "interactive",
        "occlusion",
        "text"
      ]
    },
    "OverlapOptions": {
      "kind": "object",
      "fields": {
        "minAreaRatio": {
          "type": "number",
          "optional": true,
          "doc": "0..1: пара — находка при ratio ≥ minAreaRatio; задан — заменяет пороги всех kind, у occlusion и правило >50% по осям (0 — строгий режим), не задан — DEFAULT_MIN_AREA_RATIO"
        }
      }
    },
    "ParamSpec": {
      "kind": "object",
      "fields": {
        "name": {
          "type": "string",
          "optional": false,
          "doc": ""
        },
        "type": {
          "type": "string",
          "optional": false,
          "doc": ""
        },
        "optional": {
          "type": "boolean",
          "optional": false,
          "doc": ""
        }
      }
    },
    "ServerErrorCode": {
      "kind": "enum",
      "values": [
        "bad_office",
        "bad_option",
        "bad_slot",
        "bad_speed",
        "boss_already",
        "core_maxed",
        "equipment_already",
        "gateway_already",
        "motivate_cooldown",
        "no_event",
        "no_free_office_slot",
        "no_free_pc",
        "no_free_rack_slot",
        "not_broken",
        "not_enough_money",
        "office_locked",
        "offices_maxed",
        "router_maxed",
        "server_maxed",
        "staff_limit",
        "unknown_command",
        "wrong_phase"
      ]
    },
    "ServerInfo": {
      "kind": "object",
      "fields": {
        "slot": {
          "type": "number",
          "optional": false,
          "doc": "0-based индекс стойки"
        },
        "level": {
          "type": "number",
          "optional": false,
          "doc": ""
        },
        "mult": {
          "type": "number",
          "optional": false,
          "doc": ""
        },
        "nextPrice": {
          "type": "number",
          "optional": false,
          "doc": "0 — уровень максимальный"
        },
        "maxed": {
          "type": "boolean",
          "optional": false,
          "doc": ""
        },
        "servedFrom": {
          "type": "number",
          "optional": false,
          "doc": "обслуживаемые работники офиса, 1-based"
        },
        "servedTo": {
          "type": "number",
          "optional": false,
          "doc": ""
        }
      }
    },
    "SocketStatus": {
      "kind": "enum",
      "values": [
        "closed",
        "open",
        "reconnecting"
      ]
    },
    "StateMessage": {
      "kind": "object",
      "fields": {
        "type": {
          "type": "'state'",
          "optional": false,
          "doc": ""
        },
        "money": {
          "type": "number",
          "optional": false,
          "doc": ""
        },
        "offices": {
          "type": "OfficeInfo[]",
          "optional": false,
          "doc": ""
        },
        "gateway": {
          "type": "boolean",
          "optional": false,
          "doc": ""
        },
        "core": {
          "type": "CoreInfo",
          "optional": false,
          "doc": ""
        },
        "incomePerTick": {
          "type": "number",
          "optional": false,
          "doc": ""
        },
        "day": {
          "type": "number",
          "optional": false,
          "doc": ""
        },
        "clock": {
          "type": "string",
          "optional": false,
          "doc": ""
        },
        "isLunch": {
          "type": "boolean",
          "optional": false,
          "doc": ""
        },
        "ticksPerHour": {
          "type": "number",
          "optional": false,
          "doc": ""
        },
        "payrollPerDay": {
          "type": "number",
          "optional": false,
          "doc": ""
        },
        "salaryPerDay": {
          "type": "number",
          "optional": false,
          "doc": ""
        },
        "bossSalaryPerDay": {
          "type": "number",
          "optional": false,
          "doc": ""
        },
        "forecastEndOfDay": {
          "type": "number",
          "optional": false,
          "doc": ""
        },
        "staffLimit": {
          "type": "number",
          "optional": false,
          "doc": ""
        },
        "officeSlots": {
          "type": "number",
          "optional": false,
          "doc": ""
        },
        "phase": {
          "type": "'running' | 'day_report' | 'game_over' | 'won'",
          "optional": false,
          "doc": ""
        },
        "speed": {
          "type": "number",
          "optional": false,
          "doc": "темп сессии: 0 — пауза, 1..3"
        },
        "resumed": {
          "type": "boolean",
          "optional": false,
          "doc": "снапшот восстановленной сессии (ITGAME-8)"
        },
        "seed": {
          "type": "string",
          "optional": false,
          "doc": "сид RNG партии, десятичная строка (ITGAME-26)"
        },
        "scenario": {
          "type": "string",
          "optional": false,
          "doc": "фикстура старта (ITGAME-26); '' — обычная партия"
        },
        "tickInDay": {
          "type": "number",
          "optional": false,
          "doc": "тик текущего дня (ITGAME-26)"
        },
        "dayIncome": {
          "type": "number",
          "optional": false,
          "doc": "доход, накопленный за текущий день (ITGAME-26)"
        },
        "dayProfit": {
          "type": "number",
          "optional": false,
          "doc": "прибыль дня с прогнозом до вечера, = «Прибыль» отчёта (ITGAME-53)"
        },
        "difficulty": {
          "type": "DifficultyId",
          "optional": false,
          "doc": ""
        },
        "winTarget": {
          "type": "number",
          "optional": false,
          "doc": "денежная часть цели, $"
        },
        "winStaff": {
          "type": "number",
          "optional": false,
          "doc": "комбо-цель: сотрудников (0 — нет; сложность 2.0)"
        },
        "winCore": {
          "type": "number",
          "optional": false,
          "doc": "комбо-цель: уровень core (0 — нет)"
        },
        "winDayLimit": {
          "type": "number",
          "optional": false,
          "doc": "дедлайн цели: дней (0 — нет)"
        },
        "marketToday": {
          "type": "number",
          "optional": false,
          "doc": "рынок: % выработки сегодня (0 — нет)"
        },
        "marketTomorrow": {
          "type": "number",
          "optional": false,
          "doc": "завтрашний рынок, виден заранее"
        },
        "creditLimit": {
          "type": "number",
          "optional": false,
          "doc": "кредитный порог, $ (0 — кредита нет)"
        },
        "creditRatePct": {
          "type": "number",
          "optional": false,
          "doc": "процент за день на долг"
        },
        "activeEvent": {
          "type": "ActiveEventInfo | null",
          "optional": false,
          "doc": "висящее событие Unseen Forces"
        },
        "prices": {
          "type": "{ pc: number; hire: number; boss: number; gateway: number; cooler: number; fridge: number; coffeeMachine: number; repair: number; serverLevels: { mult: number; price: number; }[]; coreLevels: { capacity: number; price: number; mult: number; }[]; }",
          "optional": false,
          "doc": ""
        }
      }
    },
    "TinyEntry": {
      "kind": "object",
      "fields": {
        "scene": {
          "type": "string",
          "optional": false,
          "doc": ""
        },
        "id": {
          "type": "string | null",
          "optional": false,
          "doc": ""
        },
        "text": {
          "type": "string",
          "optional": false,
          "doc": ""
        },
        "size": {
          "type": "number",
          "optional": false,
          "doc": ""
        }
      }
    },
    "TraceResult": {
      "kind": "object",
      "fields": {
        "ok": {
          "type": "boolean",
          "optional": false,
          "doc": ""
        },
        "error": {
          "type": "string",
          "optional": true,
          "doc": ""
        },
        "result": {
          "type": "unknown",
          "optional": true,
          "doc": ""
        },
        "t0": {
          "type": "number",
          "optional": false,
          "doc": "epoch ms — момент постановки подписок (до action)"
        },
        "t1": {
          "type": "number",
          "optional": false,
          "doc": "epoch ms — момент закрытия окна"
        },
        "windowMs": {
          "type": "number",
          "optional": false,
          "doc": ""
        },
        "actionMs": {
          "type": "number",
          "optional": false,
          "doc": "rel() сразу после await action()"
        },
        "keys": {
          "type": "{ t: number; key: string; source: 'dom' | 'itd'; repeat: boolean; handled: boolean; scenes: string[]; acted: { scene: string; action: string; }[]; }[]",
          "optional": false,
          "doc": "handled — в активной сцене есть подписчик keydown-<KEY>/keydown; acted —\nсцены, реально отработавшие клавишу; [] при handled:true — guard обработчика\nеё отбросил."
        },
        "sent": {
          "type": "{ [k: string]: unknown; t: number; type: string; office?: number; }[]",
          "optional": false,
          "doc": "полная команда, по порядку отправки"
        },
        "recv": {
          "type": "{ t: number; type: string; info: Record<string, unknown>; }[]",
          "optional": false,
          "doc": "не-state входящие: error/day_report/game_over/…"
        },
        "transitions": {
          "type": "{ t: number; kind: 'phase' | 'speed' | 'day' | 'scenes'; from: string | number | null; to: string | number | null; }[]",
          "optional": false,
          "doc": ""
        },
        "toasts": {
          "type": "{ t: number; text: string; where: 'top' | 'bottom'; ms: number; scene: string; }[]",
          "optional": false,
          "doc": ""
        },
        "sounds": {
          "type": "{ t: number; name: string; key: string; volume: number; ok: boolean; scene: string; }[]",
          "optional": false,
          "doc": ""
        }
      }
    },
    "TransportErrorCode": {
      "kind": "enum",
      "values": [
        "disconnected",
        "not_connected",
        "receipt_timeout"
      ]
    },
    "TypeSpec": {
      "kind": "alias",
      "type": "{ kind: 'object'; fields: Record<string, FieldSpec>; index?: string[]; } | { kind: 'enum'; values: string[]; } | { kind: 'alias'; type: string; }"
    }
  }
} satisfies { schema: 1; hash: string; methods: { [K in keyof ItdApi]-?: MemberSpec }; types: Record<string, TypeSpec> }
