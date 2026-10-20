// СГЕНЕРИРОВАНО scripts/gen-contract.mjs из ItdApi — руками не править. npm run gen:contract
import type { ItdApi, MemberSpec, TypeSpec } from './agentApi'
export const CONTRACT = {
  "schema": 1,
  "hash": "ba24fb6d5f78",
  "methods": {
    "version": {
      "kind": "prop",
      "type": "{ sha: string; builtAt: string; version: string; }",
      "readonly": true,
      "doc": "Штамп сборки: {sha, builtAt, version} + `<meta name=\"build\">` в html; version —\nгод.мес.день.час.мин коммита (ITGAME-140), она же в меню; сейв ею не сверяется (ITGAME-169).",
      "examples": [
        "itd.version"
      ]
    },
    "state": {
      "kind": "method",
      "params": [],
      "returns": "AgentState",
      "doc": "Баланс, день, часы, доход, ФОТ, штат, сеть, долг, цель, сид/сценарий\n(null до первого снапшота); debtLimit — порог долга, глубже которого вечер\nбанкротит: лимит кредита или, на Лёгком/Норме, овердрафт = расходы дня\n(creditLimit там 0, ITGAME-156); menuReady — меню создано, активно, его перезапуск\nне в очереди (itd.sandbox()/restore() перезапускают меню) и сводка сейва\nустоялась: после true плашки меню больше не сдвигаются (ITGAME-88), cx/cy можно\nбрать для настоящего клика. Анимации въезда у меню нет.",
      "examples": [
        "itd.state()",
        "await itd.wait(s => s.menuReady)"
      ]
    },
    "server": {
      "kind": "method",
      "params": [],
      "returns": "AgentServer",
      "doc": "Снапшот целиком + сокет: open|reconnecting|closed, lastEventId, rev/cause\nпоследнего снапшота (ITGAME-45), rtt, reconnects, sid (куда уходят команды\nи itd.journal(): liveSid ?? sid хранилища), liveSid (sid живой партии вкладки\nили null — тогда прочие debug-вызовы отказывают not_in_party, ITGAME-131),\nsidSwitches.",
      "examples": [
        "itd.server()",
        "itd.wait((s, srv) => srv.rev >= 42)"
      ]
    },
    "nodes": {
      "kind": "method",
      "params": [],
      "returns": "AgentNode[]",
      "doc": "Все объекты живых сцен: {scene, type, id, text, x, y, w, h, cx, cy,\nvisible, alpha, interactive, depth, active, disabled, fill}. x/y — позиция по origin,\ncx/cy — центр bounds (точка для настоящего клика); visible — видим в мире:\nскрытый контейнер даёт false всем детям (ITGAME-87); disabled — кнопка\nпокупки/найма неактивна (ITGAME-72), null у прочих; fill — заливка фигуры\n'#rrggbb' (Rectangle/Triangle/Arc/Ellipse/Polygon), null у прочих (ITGAME-88).",
      "examples": [
        "itd.nodes()",
        "itd.nodes().find(n => n.type === 'Triangle' && n.scene === 'menu').fill"
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
      "returns": "{ id: string; safe: string; scene: string; type: string; text: string | null; active: boolean | null; }[]",
      "doc": "Стабильные id интерактивов (btn.*, nav.*, office.*, room.*, menu.*,\nmodal.*) + active — состояние переключателя, null у прочих (НЕ\nGameObject.active). safe — тот же id с «:» вместо точек (не режется\nинструментом агента как JWT); click/hover/hit принимают и его.",
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
          "type": "'buy_pc' | 'hire' | 'buy_router' | 'hire_boss' | 'buy_office' | 'buy_server' | 'buy_gateway' | 'next_day' | 'restart' | 'buy_cooler' | 'buy_fridge' | 'buy_coffee' | 'set_speed' | 'upgrade_server' | 'upgrade_core' | 'motivate' | 'repair_click' | 'call_master' | 'event_choice' | 'fire' | 'virus_click' | 'set_antivirus' | 'hire_admin' | 'fire_admin' | 'buy_admin_dept' | 'abandon' | 'exit'",
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
      "doc": "Команда с квитанцией сервера (ITGAME-30/45): Promise<{ok, code?, id, rev}> —\nответ на ЭТУ команду по её id (state|error с re = id), тики и команды\nдругих соединений квитанцию не закрывают. rev — версия снапшота-ответа.",
      "examples": [
        "await itd.cmd('hire')"
      ]
    },
    "trace": {
      "kind": "prop",
      "type": "TraceApi",
      "readonly": true,
      "doc": "Живая трассировка окна вокруг action (ITGAME-37): подписка ДО action,\nокно windowMs (0..10000, по умолчанию 1000) ПОСЛЕ него — реальный путь\nигрока (клавиши/команды/переходы/тосты/звуки), а не срез log()/net().\nITGAME-45: sent — с id команды, states — снапшоты окна {rev, cause, re?}:\nответ на команду — state с re = её id. ITGAME-179: sent[].src — itd (ушла внутри\nвызова itd.*: cmd/click/key/pause/resume/speed/step) или ui (настоящий клик/клавиша,\nреакция UI); itd.trace.summary(id? | tr) — окно строками по времени, не закрывая.\nITGAME-88: pointer — настоящие\nmousedown/mouseup в окне: {type: down|up, button, x, y (мировые 1280×720),\nonCanvas, wins — метка победителя хит-теста Phaser в момент события, та же форма,\nчто got (safe id или тип без id; полная строка — stack[0]), stack — как itd.stack,\ngot — до кого дошёл pointerdown/up (GAMEOBJECT_POINTER_DOWN/UP объекта; кнопка,\nудалившая себя в pointerdown, в got на down есть, на up её нет)}; itd.click() сюда не попадает\n(мимо input-слоя). Открытое окно для клика другим вызовом инструмента:\nitd.trace.start() → {id} … клик … itd.trace.stop(id?) → тот же TraceResult\n(windowMs — длина окна; само закроется через maxMs, по умолчанию 120 с, cut: true).",
      "examples": [
        "itd.trace(() => itd.click('btn.pc'), 1000)",
        "itd.trace.start()",
        "itd.trace.stop().pointer",
        "itd.trace.summary().lines"
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
      "doc": "Линтер вёрстки: kind text — тексты одного depth; occlusion — текст под\nнепрозрачной плашкой (text и occlusion обходят и контейнеры — ITGAME-117:\nвидимость по всей цепочке предков, альфа — произведение, слой ребёнка —\ndepth верхнего контейнера, «выше» — по порядку отрисовки); interactive — интерактив частично перекрыт\nинтерактивом или текстом (вложенность целиком — не находка). Каждая\nпара: ratio — площадь пересечения / площадь меньшего из пары (occlusion —\n/ площадь текста), threshold — порог, с которым сравнили. minAreaRatio\n0..1 заменяет пороги по умолчанию для всех kind (text и interactive — 0,\nocclusion — 0.25 и >50% по каждой оси: заданный minAreaRatio снимает и\nправило по осям, находок может стать больше, чем без него); 0 — строгий\nрежим, вне 0..1 — RangeError. Затемнение модалки (отчёт дня, финал «ТУПИК»/\n«ПОБЕДА!», «Пока вас не было», showModal, окна меню, обрыв связи — markDim)\n— не перекрывающий при любой альфе (ITGAME-87; раньше финал 0.9 давал ~22\nocclusion, отчёт 0.75 — 0): что оно закрывает от клика — itd.hit()/stack().",
      "examples": [
        "itd.overlaps()",
        "itd.overlaps({ minAreaRatio: 0 })"
      ]
    },
    "offscreen": {
      "kind": "method",
      "params": [],
      "returns": "OffscreenEntry[]",
      "doc": "Линтер: вылезание за канвас 1280×720 (мировые px). Плюс одна запись\n{scene:'page', type:'canvas', id:null} — сам канвас не влез в видимую область\nокна (bounds/out — CSS px окна): масштаб UI крупнее окна, страница скроллится.",
      "examples": [
        "itd.offscreen()",
        "itd.offscreen().filter(e => e.scene === 'page')"
      ]
    },
    "hit": {
      "kind": "method",
      "params": [
        {
          "name": "id",
          "type": "string",
          "optional": false
        }
      ],
      "returns": "HitResult",
      "doc": "Попадёт ли НАСТОЯЩИЙ клик в центр объекта в него самого: настоящий\nхит-тест Phaser, тот же, что stack() (hitArea, renderList, topOnly; сцены\nсверху вниз). ok:false + top — кто перехватит клик (например, затемнение\nотчёта дня поверх HUD); top null — точку не берёт никто (hitArea объекта\nеё не накрывает). itd.click() этого не проверяет: он мимо хит-теста.",
      "examples": [
        "itd.hit('btn.menu')",
        "itd.hit('btn.menu').top"
      ]
    },
    "blocker": {
      "kind": "method",
      "params": [],
      "returns": "HitTarget | null",
      "doc": "Что сейчас перекрывает ввод во весь холст: верхний видимый interactive,\nчьи bounds покрывают 1280×720 (затемнение отчёта дня, модалки, «Пока вас\nне было»). null — сплошного перекрытия нет. Под ним нажимаются только\nобъекты той же сцены с большей глубиной. safe — id с «:», title — заголовок\nокна этой подложки (ITGAME-72).",
      "examples": [
        "itd.blocker()"
      ]
    },
    "screen": {
      "kind": "method",
      "params": [
        {
          "name": "opts",
          "type": "ScreenOptions",
          "optional": true
        }
      ],
      "returns": "ScreenMap",
      "doc": "Карта экрана одним вызовом (ITGAME-72): {meta, n, items}. meta — sha, tab\n(sid), day, clock, t, bal, speed, phase, staff, pay, hudClock/hudBal (что\nнарисовано в HUD, рядом с серверными clock/bal), blocker, title (заголовок\nверхнего окна), stale (последний itd.stale()). items — строки 'safe|подпись|x|y|флаги' по видимым\nинтерактивам с id: подпись — тексты, целиком лежащие в рамке элемента (сосед,\nчей центр лёг на её кромку, — не подпись), x/y — центр в CSS px окна, с frame — в рамке снимка такой\nширины; флаги A — выбрана, X — перекрыта (настоящий клик не попадёт), D —\nнеактивна (нет денег/мест). free — только без X, scene — одна сцена.",
      "examples": [
        "itd.screen()",
        "itd.screen({ free: true, frame: 1280 })"
      ]
    },
    "stale": {
      "kind": "method",
      "params": [],
      "returns": "Promise<StaleInfo>",
      "doc": "Вкладка на старом JS? (ITGAME-78) Свежая проверка: {client, server, dist,\nstale, at}. client — sha этой вкладки, dist — sha сборки, которую стенд\nотдаст при перезагрузке (meta build его index.html), server — sha бинаря\n(GET /api/version). stale: client ≠ dist (без dist — ≠ server); null —\nсверить не с чем: vite dev, либо сборка без git и без штампа BUILD_SHA/-ldflags\n(sha dev/unknown, ITGAME-81; со штампом без git sha есть). Та же проверка красит метку\n«устарело, обнови» в #topbar; shown — видна ли метка на экране после неё\n(ITGAME-88: скрытая метка остаётся в DOM — display:none, 0×0, — по DOM её\nне судить); false и там, где #topbar нет (без ?debug=1 / itd.admin).",
      "examples": [
        "await itd.stale()",
        "(await itd.stale()).shown"
      ]
    },
    "sandbox": {
      "kind": "prop",
      "type": "SandboxApi",
      "readonly": true,
      "doc": "Песочница агента (ITGAME-77): itd.sandbox('acc3') → {ok, sid, owner:{sid,\ndiff}} — ставит вкладке свой sid a-<метка>-<время> и запоминает общие ключи\nвладельца (localStorage itd.sid/itd.diff/itd.onboard, ITGAME-21) и вкладки (sessionStorage); меню\nперечитывает сводку. Пока песочница есть, новая партия и финал («Сдаться»)\nберут новый sid песочницы, а не общий ключ. Ставится из меню (в партии —\ncode in_party). itd.sandbox.restore() → {sidSame, diffSame, fake, restored,\nkept, removed}: сверка (то и есть замер гарда), возврат ключей как при\nвходе — для itd.sid/itd.diff наше (fake) или стёртое значение возвращается,\nчужое (kept) не перетирается; itd.onboard (его пишет только HUD) возвращается\nк значению при входе при ЛЮБОМ отличии, даже если его записала вкладка владельца;\nтоже только из меню. itd.sandbox.fakeOwner() → {sid, diff} —\n«чужой» общий ключ вызовом игры (agent javascript_tool писать в\nlocalStorage не может); restore() вернёт настоящий.",
      "examples": [
        "itd.sandbox('acc3')",
        "itd.sandbox.fakeOwner()",
        "itd.sandbox.restore()"
      ]
    },
    "sprite": {
      "kind": "prop",
      "type": "SpriteApi",
      "readonly": true,
      "doc": "Примерка спрайта (ITGAME-119): itd.sprite.try(key, dataUrl) ставит PNG вместо\nтекстуры ключа манифеста во вкладке и перевешивает живые объекты сцен →\n{ok, key, w, h, sha256, objects, problems, warnings, stats} — problems считает\nтот же контракт, что npm run check:sprites (палитра, альфа, шум), текстура при\nнарушениях всё равно стоит. Третий аргумент {filter: 'linear'} — билинейный\nфильтр только этой текстуре (вся игра — NEAREST по pixelArt): детальный\nисходник крупнее слота сжимается гладко; по умолчанию — фильтр ключа (linear у\nrender: smooth в манифесте, иначе nearest), в квитанции\nи list() — filter. Отказы: unknown_key (ключа нет в sprites.json),\nbad_src (не data:image/png;base64 или PNG битый), bad_size (не size·frames ×\nsize ключа), bad_filter (не nearest/linear). itd.sprite.list() → [{key, w, h,\nfilter, sha256, problems}];\nitd.sprite.reset(key?) → {ok, reset[]} — вернуть исходную текстуру (без ключа —\nвсе), not_tried — ключ не подменён. В репо, dist и сейв ничего не пишется,\nперезагрузка страницы снимает подмену.",
      "examples": [
        "await itd.sprite.try('desk_pc', dataUrl)",
        "await itd.sprite.try('icon_money', dataUrl, { filter: 'linear' })",
        "itd.sprite.list()",
        "itd.sprite.reset()"
      ]
    },
    "stack": {
      "kind": "method",
      "params": [
        {
          "name": "safeOrX",
          "type": "string | number",
          "optional": false
        },
        {
          "name": "gy",
          "type": "number",
          "optional": true
        }
      ],
      "returns": "StackResult",
      "doc": "Стек под точкой по НАСТОЯЩЕМУ хит-тесту Phaser (InputManager.hitTest:\nhitArea, камера, видимость контейнеров; порядок — sortGameObjects по\nrenderList камеры; сцены сверху вниз, globalTopOnly + topOnly). Точка —\nцентр (cx/cy) объекта по id/safe-id или мировые gx, gy (1280×720).\nstack — все interactive под точкой сверху вниз ('safe scene dN Type WxH';\n'!' — сцена ниже забравшей клик), wins — кто получит pointerdown.\nhit() и флаг X в screen() — тот же хит-тест, только верх в центре объекта.\nОбъект, добавленный в этом кадре, виден со следующего кадра (ITGAME-113):\nsetInteractive() ставит его в очередь input-плагина, в список хит-теста он\nпопадает на следующем шаге лупа — и настоящий клик в тот же момент его\nтоже не видит (уходит тому, кто под ним). Нужен сразу — дождаться кадра:\nawait new Promise(r => requestAnimationFrame(r)); в скрытой вкладке кадр\nпрогревает сам stack().",
      "examples": [
        "itd.stack('office:slot:0')",
        "itd.stack(260, 190).wins"
      ]
    },
    "zones": {
      "kind": "method",
      "params": [
        {
          "name": "safeA",
          "type": "string",
          "optional": false
        },
        {
          "name": "safeB",
          "type": "string",
          "optional": false
        }
      ],
      "returns": "ZonesResult",
      "doc": "Где зона A перекрыта B и наоборот: обход сетки 1 px по объединению bounds\nA и B тем же хит-тестом, что stack(); aUnderB — прямоугольники, где точка в\nhitArea A, а клик забирает B (bUnderA — наоборот), area — площади в px².\nПустой aUnderB — A везде получает свой клик сам (от B).",
      "examples": [
        "itd.zones('office:slot:0', 'office:master:0')"
      ]
    },
    "offline": {
      "kind": "method",
      "params": [],
      "returns": "AgentOffline | null",
      "doc": "Последний офлайн-догон этой страницы: {ticks, days, shown, at, droppedAt,\nleftAt, liveTicks, open, paused, seq, awayId} или null. Это ПОСЛЕДНИЙ догон\nстраницы, не «текущий»: после ухода без догона он остаётся прежним — сверять\nпо ключу (ITGAME-87): seq — номер догона на странице (1, 2, …), awayId —\nitd.away, во время которого он пришёл (null — F5, реконнект, «Продолжить»).\ndroppedAt — последний сейв\n(сервер заметил обрыв), leftAt — уход со страницы этой вкладки, liveTicks —\nсколько тиков партия шла вживую между ними. shown:false — догон внутри дня, окно «Пока вас не было» игроку не\nпоказано; open — окно открыто сейчас; paused — скорость сейчас 0 (пока окно\nоткрыто, партия стоит).\nДогона нет и при ticks 0 (сейв на паузе или в отчёте дня) — тогда null.",
      "examples": [
        "itd.offline()",
        "const r = await itd.away(3); itd.offline()?.awayId === r.awayId // false — у этого ухода догона не было"
      ]
    },
    "away": {
      "kind": "method",
      "params": [
        {
          "name": "sec",
          "type": "number",
          "optional": false
        },
        {
          "name": "opts",
          "type": "AwayOptions",
          "optional": true
        }
      ],
      "returns": "Promise<AwayResult | (AgentResult & { code: 'bad_sec' | 'bad_mode'; })>",
      "doc": "Уход без ухода со страницы (ITGAME-76): на sec секунд (0..600) вкладка\nпропадает для сервера и возвращается в ту же партию — тот же sid,\nпесочницы или владельца; без example.com, новой вкладки и пропавшего\nпервого клика. mode 'close' (по умолчанию) — как закрытая вкладка:\nclose-фрейм без exit, сервер узнаёт сразу. mode 'net' — как обрыв сети:\nPOST /api/debug/drop (ITGAME_DEBUG): сервер перестаёт читать и писать в\nсоединение без close-фрейма и замечает уход своим таймаутом чтения\n(ITGAME_READ_TIMEOUT, по умолчанию 30 с; timeout — свой для этого\nсоединения, мс), а партия до этого идёт вживую — offline.liveTicks.\nВсё время ухода вкладка глуха и нема: команды — not_connected, сокет —\nreconnecting, сама не реконнектится. Ответ {ok, mode, sid, leftAt, back,\nresumed, rev, drop, awayId, offline}: back — первый снапшот нового сокета (cause\nresume), drop — ответ ручки {at, timeoutMs, noticeBy}, awayId — номер этого\nухода на странице (ITGAME-87), offline — догон ЭТОГО ухода (offline.awayId ===\nawayId; droppedAt — когда сервер заметил уход) или null; itd.offline() после\nухода без догона отдаёт прежний догон с другим awayId. Коды: bad_sec, bad_mode, already_away, not_connected, finished,\ndrop_failed, interrupted (вкладка ушла в меню/новую партию), no_return,\nnot_resumed.",
      "examples": [
        "await itd.away(5)",
        "await itd.away(20, { mode: 'net', timeout: 3000 })"
      ]
    },
    "injectError": {
      "kind": "method",
      "params": [
        {
          "name": "message",
          "type": "string",
          "optional": true
        }
      ],
      "returns": "AgentResult",
      "doc": "Бросить тестовую ошибку страницы (асинхронно, через setTimeout) — чтобы\nпроверить журнал itd.errors() и его поле load, когда настоящих ошибок 0.\nСообщение начинается с «itd.injectError»: в отчёте это не ошибка игры.",
      "examples": [
        "itd.injectError('проверка')"
      ]
    },
    "contrast": {
      "kind": "method",
      "params": [],
      "returns": "ContrastEntry[]",
      "doc": "Линтер: контраст текста к фону ниже 3:1. Тексты в контейнерах тоже (видимость и альфа — по цепочке родителей).",
      "examples": [
        "itd.contrast()"
      ]
    },
    "tiny": {
      "kind": "method",
      "params": [],
      "returns": "TinyEntry[]",
      "doc": "Линтер: шрифт мельче 12px. Тексты в контейнерах тоже.",
      "examples": [
        "itd.tiny()"
      ]
    },
    "assets": {
      "kind": "method",
      "params": [],
      "returns": "{ textures: AssetReport[]; duplicates: { keys: string[]; expected: boolean; }[]; textTextures: number; }",
      "doc": "Аудит текстур: размер, прозрачность %, доля #f4f4f4, цвета вне\nпалитры манифеста этого ключа (manifest.palettes[spec.palette]), дубли\nключей.\nsource: tried — ключ подменён пробой itd.sprite.try (ITGAME-119), это не эталон.",
      "examples": [
        "itd.assets()"
      ]
    },
    "assetSet": {
      "kind": "method",
      "params": [],
      "returns": "AssetSetEntry[]",
      "doc": "Чем рисуют сцены: png (подменён из assets/), pixelart (кодоген-фолбэк) или\ntried (проба itd.sprite.try).",
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
      "returns": "{ socket: AgentServer['socket']; reconnects: number; rtt: number | null; rev: number | null; last: { dir: 'in' | 'out'; at: number; type: string; info: Record<string, unknown>; }[]; }",
      "doc": "Последние сообщения WS в обе стороны + сокет/rtt/реконнекты и rev\nпоследнего снапшота. ITGAME-45: у out в info — id команды, у state — rev,\ncause и re (id своей команды, породившей снапшот), у error — re и rev.",
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
          "name": "msOrTicks",
          "type": "number | { ticks: number; }",
          "optional": false
        }
      ],
      "returns": "Promise<DebugAdvanceResult>",
      "doc": "Пауза (set_speed 0 — так и остаётся) + промотка тиков ОФЛАЙН-движком через\n/api/debug/advance. Две формы: step(ms) — мс, 1 тик = 1000 мс, округление до\nцелых, 500..10000 мс (1..10 тиков); step({ticks}) — целое 1..10000 тиков за\nвызов. Офлайн-движок — сводная формула: без кофе-роллов, событий, поломок и\nXP; конец дня закрывается без day_report и без роллов next_day (ни\nday_report, ни offline_report не приходят). Из фазы day_report сервер\nсначала делает обычный next_day. Сводка {ticks, days, income, payroll,\nbalance, gameOver, victory, reason?} — в ответе .advance (+ .state) и строкой\n«debug · advance» в itd.snapshot().events; в itd.log() — только переходы\nснапшота (day/phase/speed — пауза step на идущей игре тоже даёт speed) и\ngame_over/victory при финале. Вне фазы running (например game_over) сервер\nотвечает 200 с advance.ticks 0 — ничего не промотано. Настоящий отчёт дня —\nпромотать до последнего тика и дать ему пройти вживую.\nВне партии вкладки — reject «not_in_party: …» без запроса и без паузы (ITGAME-131, см. scenario).",
      "examples": [
        "itd.step(2000)",
        "itd.step({ticks: 60})"
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
      "doc": "Промотка n целых дней (1..90) ОФЛАЙН-движком через /api/debug/advance:\nдень N → N+n, тик дня тот же; set_speed сама не шлёт. Из фазы day_report\nсервер сначала делает обычный next_day (итог — день N+1+n, тик 0), а HUD,\nувидев running, закрывает отчёт и возвращает скорость до отчёта, как кнопка\n«Дальше» (никто другой set_speed не слал) — партия побежит живьём, тик 0 не\nгарантирован. Нужна пауза — itd.pause() ДО вызова (его set_speed сдвигает\nсчётчик, и HUD скорость не вернёт) или itd.step(): он сам ставит паузу.\nОфлайн-движок: без кофе-роллов, событий, поломок и XP; дни закрываются\nбез day_report и offline_report — отчётов дней в itd.log() НЕТ, там только\nсмена дня (type 'day') и game_over/victory при финале. Сводка {ticks,\ndays, income, payroll, balance, …} — в ответе .advance и строкой\n«debug · advance» в itd.snapshot().events. Вне фазы running (например\ngame_over) сервер отвечает 200 с advance.ticks 0 — ничего не промотано.\nВне партии вкладки — reject «not_in_party: …» без запроса (ITGAME-131, см. scenario).",
      "examples": [
        "itd.advanceDays(3)"
      ]
    },
    "play": {
      "kind": "method",
      "params": [
        {
          "name": "steps",
          "type": "PlayStep[]",
          "optional": false
        }
      ],
      "returns": "Promise<string[]>",
      "doc": "Партия из консоли (ITGAME-73): шаги по очереди, на каждый — строка\n«cmd | ok/FAIL code | dN tN | бал>бал | staff a>b | pay N | phase».\nШаг {cmd, office?, extra?} — команда с квитанцией (как itd.cmd), {days: n} —\nпромотка офлайн-движком (как itd.advanceDays). Таймеров нет: шаг ждёт\nквитанцию своей команды (ответ по id) и снапшот, который она породила\n(state.rev ≥ rev квитанции; у days — rev ответа advance); «после» — этот\nснапшот, «до» — последний снапшот вкладки перед шагом. FAIL не прерывает\nпартию; пропал снапшот за 5с — в вердикте «нет rev≥N». Деньги на идущей\nигре сдвигают и тики — для сверки ставьте первым шагом {cmd:'set_speed', extra:{speed:0}}.\nРазложение дневной разницы — itd.ledger(day).",
      "examples": [
        "await itd.play([{cmd:'set_speed', extra:{speed:0}}, {cmd:'hire'}, {cmd:'hire'}, {days:1}, {cmd:'buy_pc'}, {cmd:'hire'}, {days:1}])"
      ]
    },
    "ledger": {
      "kind": "method",
      "params": [
        {
          "name": "day",
          "type": "number",
          "optional": true
        }
      ],
      "returns": "Promise<DayLedger>",
      "doc": "Бухгалтерия дня с сервера (ITGAME-73, GET /api/debug/ledger): из чего\nсложилась разница баланса — {day, balanceStart, income, eventMoney,\nevents[{what, money, clock}], purchases[{type, price, clock}], payroll,\ngatewayOpex, antivirus, interest, adjust, balanceEnd, profit, delta, balanced, closed,\noffline, history}. balanceStart + income + eventMoney − purchasesTotal −\npayroll − gatewayOpex − antivirus − interest + adjust = balanceEnd ровно (balanced).\nprofit = day_report.profit (покупки и процент в него не входят). Без day —\nтекущий день (balanceEnd — живой баланс, payroll 0 до вечера); иначе один из\nhistory: 7 последних закрытых дней + текущий, хранятся в сейве. Дня нет —\nошибка «нет книги дня N: есть [...]».\nВне партии вкладки — reject «not_in_party: …» без запроса (ITGAME-131, см. scenario).",
      "examples": [
        "await itd.ledger()",
        "await itd.ledger(1)"
      ]
    },
    "journal": {
      "kind": "method",
      "params": [
        {
          "name": "opts",
          "type": "{ tail?: number; sid?: string; }",
          "optional": true
        }
      ],
      "returns": "Promise<JournalView>",
      "doc": "Журнал партии (ITGAME-46, GET /api/debug/journal; сервер с ITGAME_DEBUG=1):\nхвост входов своей партии — команды с id и отказами, debug-правки, вехи\nдней, resume с офлайн-догоном, end — строками и объектами (без сейвов).\ntail — сколько последних записей (1..500, по умолчанию 20); sid — чужая\nпартия (по умолчанию — своя: liveSid ?? sid хранилища, как itd.server().sid). Строка:\n«#seq k что | dДЕНЬ tТИК $ДЕНЬГИ фаза Nx revR +tk», tk — тики с прошлой\nзаписи. cmd — «тип cN idN ok|FAIL код»: cN — номер соединения в партии\n(ITGAME-91: id — счётчик страницы, после F5 снова с 1, у моста агента свой;\nуникальна пара (conn, id)), « bridge» — команда моста /ws/agent. start/resume\n— «cN»: соединение, с которого партия началась/продолжилась. end — evicted\n(сессию забрал другой актор) | read_timeout (сторож чтения: вкладка молчала\nдольше ITGAME_READ_TIMEOUT) | debug_drop (сторож после /api/debug/drop, itd.away\nnet) | disconnect (соединение закрыл клиент: закрытие, F5, away close).\nПолный журнал для реплея — по url (make replay ARGS=\"-url …\").\nНет журнала — ошибка journal_off / no_journal.\nПартии во вкладке не требует (ITGAME-131): журнал живёт на сервере и после конца партии. Без sid\nчитается журнал sid вкладки: он цел после «Сохранить и выйти»/«Выйти без сохранения», а после\n«Сдаться» и после финала → «В меню» sid вкладки стёрт — вызов идёт под свежий sid и отвечает\nno_journal; тогда возьмите sid из itd.server().sid до выхода и читайте itd.journal({sid}).",
      "examples": [
        "(await itd.journal({tail: 5})).lines",
        "(await itd.journal({tail: 500})).records.filter(r => r.k === 'cmd').map(r => `c${r.conn}:${r.id}`)"
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
      "doc": "Читы живой сессии: {money, day, tickInDay}.\nВне партии вкладки — reject «not_in_party: …» без запроса (ITGAME-131, см. scenario).",
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
      "doc": "Пересоздать партию фикстурой: fresh|broke_day3|mid_day10|full_office|\nsoft_lock|pre_victory|spare_pcs|broken_pc|doomed_debt|virus_outbreak|admin_dept. Сбрасывает клиентское состояние партии: активный\nофис → О1 (ITGAME-55), оверлеи HUD — отчёт дня, событие, «Пока вас не было», финал,\nокно выхода — и учёт паузы отчёта (ITGAME-64), окна офиса и серверной — устройства,\nувольнение (ITGAME-69). Скорость сессии не трогает: вызванный\nиз открытого отчёта или окна выхода, оставляет новую партию на паузе — itd.resume(). Работает и после\nфинала (сессия жива до «В меню»). Ошибка (неизвестная фикстура) партию не трогает.\nТолько в партии вкладки (ITGAME-131): из меню — до первой партии, после «В меню»/«Сдаться» — и\nпосле перехвата сессии другой вкладкой отказ сразу, без запроса: reject «not_in_party: …».\nИз меню — itd.click('menu.diff.normal') (при живом сейве меню спросит «Начать заново?» —\nitd.click('modal.btn.confirm'); или itd.click('menu.continue')), затем await itd.wait(s => s.connected);\nпосле перехвата меню нет — обновите страницу (F5). Так же set, step, advanceDays, ledger,\nsnapshot, restore; itd.journal() — без этого правила.",
      "examples": [
        "itd.scenario('soft_lock')"
      ]
    },
    "snapshot": {
      "kind": "method",
      "params": [],
      "returns": "Promise<DebugState>",
      "doc": "Полный стейт с сервера: {sid, state, save, events}.\nВне партии вкладки — reject «not_in_party: …» без запроса (ITGAME-131, см. scenario).",
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
      "doc": "Вернуть состояние из snapshot().save (дельта над текущим). Партию не сбрасывает;\nесли активный офис в новом состоянии закрыт — вкладка переходит в О1 (ITGAME-63).\nОкна офиса и серверной (устройства, увольнение) закрывает: они собраны по прошлому\nстейту (ITGAME-69); оверлеи HUD не трогает.\nВне партии вкладки — reject «not_in_party: …» без запроса (ITGAME-131, см. scenario).",
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
          "doc": "Ключ спрайта иконки в манифесте (ITGAME-83: было эмодзи), рисуется рядом с Text через attachIcon."
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
        "cx": {
          "type": "number",
          "optional": false,
          "doc": ""
        },
        "cy": {
          "type": "number",
          "optional": false,
          "doc": ""
        },
        "safe": {
          "type": "string | null",
          "optional": false,
          "doc": ""
        },
        "visible": {
          "type": "boolean",
          "optional": false,
          "doc": "видим в мире (ITGAME-87): сам и все его контейнеры visible; скрытый контейнер — false у всех детей"
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
        },
        "disabled": {
          "type": "boolean | null",
          "optional": false,
          "doc": ""
        },
        "fill": {
          "type": "string | null",
          "optional": false,
          "doc": "ITGAME-88: заливка фигуры '#rrggbb' (Rectangle, Triangle, Arc/Circle, Ellipse, Polygon — Shape с isFilled); null — не фигура или без заливки (Text, Image, Container; Graphics — цвет в буфере команд, не отдаём)"
        }
      }
    },
    "AgentOffline": {
      "kind": "object",
      "fields": {
        "open": {
          "type": "boolean",
          "optional": false,
          "doc": "окно «Пока вас не было» открыто сейчас"
        },
        "paused": {
          "type": "boolean",
          "optional": false,
          "doc": "скорость партии сейчас 0"
        },
        "seq": {
          "type": "number",
          "optional": false,
          "doc": "ITGAME-87: номер догона на этой странице (1, 2, … по приходу offline_report); сверять догоны — по нему, не по at"
        },
        "awayId": {
          "type": "number | null",
          "optional": false,
          "doc": "ITGAME-87: itd.away, во время которого догон пришёл (= его awayId); null — не в away (F5, реконнект, «Продолжить»)"
        },
        "ticks": {
          "type": "number",
          "optional": false,
          "doc": ""
        },
        "days": {
          "type": "number",
          "optional": false,
          "doc": ""
        },
        "shown": {
          "type": "boolean",
          "optional": false,
          "doc": "показано ли игроку окно «Пока вас не было»"
        },
        "at": {
          "type": "number",
          "optional": false,
          "doc": "epoch ms прихода"
        },
        "droppedAt": {
          "type": "number | null",
          "optional": false,
          "doc": "epoch ms последнего сейва: тогда сервер заметил обрыв"
        },
        "leftAt": {
          "type": "number | null",
          "optional": false,
          "doc": "epoch ms ухода со страницы (pagehide этой вкладки), null — не знаем"
        },
        "liveTicks": {
          "type": "number | null",
          "optional": false,
          "doc": "тиков прошло вживую между уходом и тем, как сервер заметил обрыв"
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
          "doc": "счётчик принятых сообщений этой страницы (не rev: тот — версия сессии)"
        },
        "rev": {
          "type": "number | null",
          "optional": false,
          "doc": "ITGAME-45: версия состояния последнего снапшота (+1 на каждый; ждать — wait((s, srv) => srv.rev >= N))"
        },
        "cause": {
          "type": "'tick' | 'cmd' | 'debug' | 'start' | 'resume' | null",
          "optional": false,
          "doc": "ITGAME-45: почему разослан последний снапшот: tick | cmd | debug | start | resume"
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
          "doc": "ITGAME-30/68: sid, в чью партию уходят команды и itd.journal(): liveSid ?? sid хранилища; прочие debug-вызовы — только liveSid (ITGAME-131)"
        },
        "liveSid": {
          "type": "string | null",
          "optional": false,
          "doc": "ITGAME-68: sid живой партии вкладки (сокет); null — до первой партии, после «В меню»/«Сдаться»/перехвата: debug-вызовы, кроме journal, тогда отказывают not_in_party (ITGAME-131)"
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
          "doc": "кредитный порог, $; 0 — кредита нет (Лёгкий/Норма: там овердрафт, порог — debtLimit)"
        },
        "creditRatePct": {
          "type": "number | null",
          "optional": false,
          "doc": ""
        },
        "debtLimit": {
          "type": "number | null",
          "optional": false,
          "doc": "порог долга, $: глубже — вечер банкротит; creditLimit или, без кредита, payrollPerDay (овердрафт, ITGAME-156/177)"
        },
        "bankruptInDays": {
          "type": "number | null",
          "optional": false,
          "doc": "обречённая партия: банкротство через N закрытий дня, 0 — нет (ITGAME-118)"
        },
        "virusPCs": {
          "type": "number | null",
          "optional": false,
          "doc": "заражённых мест по компании (ITGAME-103); по офисам — snapshot().state.offices[i].virusPCs"
        },
        "virusWaveAt": {
          "type": "string | null",
          "optional": false,
          "doc": "«HH:MM», с которого видна следующая волна; '' — заражённых нет"
        },
        "antivirusTier": {
          "type": "number | null",
          "optional": false,
          "doc": "подписка на антивирус: 0 — нет, 1..3 (ITGAME-137); подробно — snapshot().state.antivirus"
        },
        "adminDept": {
          "type": "boolean | null",
          "optional": false,
          "doc": "отдел админов куплен (ITGAME-101/145)"
        },
        "admins": {
          "type": "number | null",
          "optional": false,
          "doc": "нанято админов по компании; цель каждого — snapshot().state.offices[i].adminSlot/adminKind"
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
    "AntivirusInfo": {
      "kind": "object",
      "fields": {
        "tier": {
          "type": "number",
          "optional": false,
          "doc": "0 — нет, 1..3 — prices.antivirusTiers[tier - 1]"
        },
        "name": {
          "type": "string",
          "optional": false,
          "doc": "'' — нет"
        },
        "seats": {
          "type": "number",
          "optional": false,
          "doc": "мест в тарифе; 0 — все"
        },
        "covered": {
          "type": "number",
          "optional": false,
          "doc": "мест под защитой сейчас"
        },
        "billedToday": {
          "type": "number",
          "optional": false,
          "doc": "спишется вечером, $"
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
          "type": "'png' | 'pixelart' | 'tried'",
          "optional": false,
          "doc": "подменённый PNG, кодоген или проба itd.sprite.try (ITGAME-119)"
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
          "doc": "цвета вне палитры манифеста этого ключа (у кодогена и render: smooth пусто всегда)"
        },
        "render": {
          "type": "'pixel' | 'smooth'",
          "optional": false,
          "doc": "как ключ рисуется (ITGAME-83): smooth — LINEAR, палитра не контракт"
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
          "type": "'png' | 'pixelart' | 'tried'",
          "optional": false,
          "doc": "чем реально рисуют сцены; tried — проба itd.sprite.try"
        }
      }
    },
    "AwayMode": {
      "kind": "enum",
      "values": [
        "close",
        "net"
      ]
    },
    "AwayOptions": {
      "kind": "object",
      "fields": {
        "mode": {
          "type": "'close' | 'net'",
          "optional": true,
          "doc": "close (по умолчанию) — как закрытая вкладка; net — как обрыв сети (debug-ручка drop)"
        },
        "timeout": {
          "type": "number",
          "optional": true,
          "doc": "net: таймаут чтения этого соединения на сервере, мс (50..600000); без него — серверный (ITGAME_READ_TIMEOUT, по умолчанию 30 с)"
        }
      }
    },
    "AwayResult": {
      "kind": "object",
      "fields": {
        "awayId": {
          "type": "number",
          "optional": false,
          "doc": "ITGAME-87: номер этого ухода на странице (1, 2, …); догон этого ухода — offline.awayId === awayId"
        },
        "offline": {
          "type": "AgentOffline | null",
          "optional": false,
          "doc": "догон ЭТОГО ухода (offline.awayId === awayId) или null — догона не было (сервер не заметил уход до возврата или партия на паузе); itd.offline() тогда отдаёт прежний догон со своим awayId/seq"
        },
        "ok": {
          "type": "boolean",
          "optional": false,
          "doc": ""
        },
        "code": {
          "type": "'not_connected' | 'already_away' | 'finished' | 'drop_failed' | 'interrupted' | 'no_return' | 'not_resumed'",
          "optional": true,
          "doc": ""
        },
        "error": {
          "type": "string",
          "optional": true,
          "doc": ""
        },
        "mode": {
          "type": "'close' | 'net'",
          "optional": false,
          "doc": ""
        },
        "sid": {
          "type": "string | null",
          "optional": false,
          "doc": "sid после возврата (= до ухода, если ok)"
        },
        "leftAt": {
          "type": "number | null",
          "optional": false,
          "doc": "epoch ms ухода: вкладка «пропала» для сервера"
        },
        "back": {
          "type": "number | null",
          "optional": false,
          "doc": "epoch ms возврата: первый снапшот нового сокета"
        },
        "resumed": {
          "type": "boolean | null",
          "optional": false,
          "doc": "первый снапшот возврата помечен resumed (та же партия)"
        },
        "rev": {
          "type": "number | null",
          "optional": false,
          "doc": "его rev (cause 'resume')"
        },
        "drop": {
          "type": "AwayDrop | null",
          "optional": false,
          "doc": "mode net: ответ ручки drop"
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
          "type": "'not_enough_money' | 'no_free_office_slot' | 'no_free_pc' | 'no_free_rack_slot' | 'router_maxed' | 'wrong_phase' | 'staff_limit' | 'office_locked' | 'boss_already' | 'offices_maxed' | 'gateway_already' | 'bad_office' | 'equipment_already' | 'bad_slot' | 'server_maxed' | 'core_maxed' | 'motivate_cooldown' | 'not_broken' | 'not_infected' | 'no_event' | 'bad_option' | 'need_cooler' | 'bad_tier' | 'antivirus_already' | 'admin_already' | 'no_admin' | 'admin_dept_already' | 'admin_dept_locked' | 'unknown_command' | 'bad_speed' | 'not_connected' | 'receipt_timeout' | 'disconnected'",
          "optional": true,
          "doc": ""
        },
        "error": {
          "type": "string",
          "optional": true,
          "doc": ""
        },
        "id": {
          "type": "number",
          "optional": true,
          "doc": "ITGAME-45: id команды на проводе (= sent[].id в itd.trace(), info.id в itd.net())"
        },
        "rev": {
          "type": "number",
          "optional": true,
          "doc": "ITGAME-45: rev снапшота-ответа; у серверного отказа — текущий rev (не меняется)"
        }
      }
    },
    "CommandType": {
      "kind": "enum",
      "values": [
        "abandon",
        "buy_admin_dept",
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
        "exit",
        "fire",
        "fire_admin",
        "hire",
        "hire_admin",
        "hire_boss",
        "motivate",
        "next_day",
        "repair_click",
        "restart",
        "set_antivirus",
        "set_speed",
        "upgrade_core",
        "upgrade_server",
        "virus_click"
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
    "DayLedger": {
      "kind": "object",
      "fields": {
        "day": {
          "type": "number",
          "optional": false,
          "doc": ""
        },
        "fromTick": {
          "type": "number",
          "optional": false,
          "doc": "книга с этого тика: 0 — с утра; >0 — фикстура посреди дня или сейв до ITGAME-73"
        },
        "balanceStart": {
          "type": "number",
          "optional": false,
          "doc": ""
        },
        "income": {
          "type": "number",
          "optional": false,
          "doc": "доход тиков"
        },
        "eventMoney": {
          "type": "number",
          "optional": false,
          "doc": "деньги событий, со знаком (= day_report.eventMoney)"
        },
        "events": {
          "type": "LedgerEvent[]",
          "optional": false,
          "doc": ""
        },
        "purchases": {
          "type": "LedgerPurchase[]",
          "optional": false,
          "doc": ""
        },
        "purchasesTotal": {
          "type": "number",
          "optional": false,
          "doc": ""
        },
        "payroll": {
          "type": "number",
          "optional": false,
          "doc": "зарплаты вечером (= day_report.payroll); у открытого дня 0"
        },
        "gatewayOpex": {
          "type": "number",
          "optional": false,
          "doc": "опекс шлюза вечером"
        },
        "antivirus": {
          "type": "number",
          "optional": false,
          "doc": "подписка на антивирус вечером (ITGAME-137), в «Прибыль» входит"
        },
        "interest": {
          "type": "number",
          "optional": false,
          "doc": "процент по долгу при закрытии дня (кредит), в «Прибыль» не входит"
        },
        "adjust": {
          "type": "number",
          "optional": false,
          "doc": "debug-правка баланса (itd.set, itd.restore); в игре 0"
        },
        "balanceEnd": {
          "type": "number",
          "optional": false,
          "doc": "у текущего дня — живой баланс"
        },
        "profit": {
          "type": "number",
          "optional": false,
          "doc": "income + eventMoney − payroll − gatewayOpex − antivirus = day_report.profit закрытого дня"
        },
        "delta": {
          "type": "number",
          "optional": false,
          "doc": "balanceEnd − balanceStart"
        },
        "balanced": {
          "type": "boolean",
          "optional": false,
          "doc": "слагаемые сходятся с delta ровно"
        },
        "closed": {
          "type": "boolean",
          "optional": false,
          "doc": "вечер прошёл, ФОТ списан"
        },
        "offline": {
          "type": "boolean",
          "optional": false,
          "doc": "день закрыт офлайн-движком (itd.advanceDays/step, догон после реконнекта)"
        },
        "history": {
          "type": "number[]",
          "optional": false,
          "doc": "дни, по которым есть книга: 7 закрытых + текущий"
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
          "doc": "клики починки уже сделаны (k из «k/N»)"
        },
        "repairNeeded": {
          "type": "number",
          "optional": false,
          "doc": "N кликов этой поломки, 3..15 (ITGAME-93); 0 — ПК цел"
        },
        "motivateReadyAt": {
          "type": "string",
          "optional": false,
          "doc": "«HH:MM» клика возможен; '' — уже можно"
        },
        "infected": {
          "type": "boolean",
          "optional": false,
          "doc": ""
        },
        "virusClicks": {
          "type": "number",
          "optional": false,
          "doc": "клики чистки уже сделаны (k)"
        },
        "virusNeeded": {
          "type": "number",
          "optional": false,
          "doc": "кликов на чистку (3); 0 — место здорово"
        },
        "avCovered": {
          "type": "boolean",
          "optional": false,
          "doc": "место под подпиской на антивирус: не заражается (ITGAME-137)"
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
        },
        "load": {
          "type": "number",
          "optional": false,
          "doc": "номер загрузки страницы в этой вкладке (1 — первая); ошибки прошлых загрузок переживают навигацию"
        },
        "injected": {
          "type": "boolean",
          "optional": false,
          "doc": "тестовая ошибка itd.injectError — не ошибка игры"
        }
      }
    },
    "FakeOwnerResult": {
      "kind": "object",
      "fields": {
        "ok": {
          "type": "boolean",
          "optional": false,
          "doc": ""
        },
        "sid": {
          "type": "string",
          "optional": true,
          "doc": "«чужой» общий sid: fake-owner-<время>"
        },
        "diff": {
          "type": "string",
          "optional": true,
          "doc": "его сложность — всегда не та, что у владельца"
        },
        "code": {
          "type": "'no_sandbox'",
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
    "HitResult": {
      "kind": "object",
      "fields": {
        "ok": {
          "type": "boolean",
          "optional": false,
          "doc": "true — клик в центр цели попадёт в саму цель"
        },
        "id": {
          "type": "string",
          "optional": false,
          "doc": ""
        },
        "at": {
          "type": "{ x: number; y: number; } | null",
          "optional": false,
          "doc": "центр цели, мировые 1280×720 (= nodes().cx/cy)"
        },
        "top": {
          "type": "HitTarget | null",
          "optional": false,
          "doc": "кто примет клик в этой точке; null — никто"
        },
        "why": {
          "type": "string",
          "optional": true,
          "doc": "нет узла / узел невидим"
        }
      }
    },
    "HitTarget": {
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
        "safe": {
          "type": "string | null",
          "optional": false,
          "doc": "id с «:» вместо точек (ITGAME-72)"
        },
        "depth": {
          "type": "number",
          "optional": false,
          "doc": ""
        },
        "title": {
          "type": "string | null",
          "optional": false,
          "doc": "заголовок окна, если это его подложка (markTitle, ITGAME-72)"
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
          "type": "{ sha: string; builtAt: string; version: string; hash: string; }",
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
    "JournalRecord": {
      "kind": "object",
      "fields": {
        "k": {
          "type": "'cmd' | 'debug' | 'start' | 'resume' | 'day' | 'cp' | 'end'",
          "optional": false,
          "doc": ""
        },
        "seq": {
          "type": "number",
          "optional": false,
          "doc": ""
        },
        "tk": {
          "type": "number",
          "optional": true,
          "doc": "тиков g.Tick() с прошлой записи"
        },
        "rev": {
          "type": "number",
          "optional": false,
          "doc": "rev снапшота после входа (ITGAME-45)"
        },
        "day": {
          "type": "number",
          "optional": false,
          "doc": ""
        },
        "tick": {
          "type": "number",
          "optional": false,
          "doc": ""
        },
        "money": {
          "type": "number",
          "optional": false,
          "doc": ""
        },
        "phase": {
          "type": "string",
          "optional": false,
          "doc": ""
        },
        "speed": {
          "type": "number",
          "optional": false,
          "doc": ""
        },
        "h": {
          "type": "string",
          "optional": false,
          "doc": "хэш состояния после входа — его сверяет реплей"
        },
        "id": {
          "type": "number",
          "optional": true,
          "doc": "cmd: id команды клиента — тот же, что в itd.trace().sent и квитанции itd.cmd()"
        },
        "type": {
          "type": "string",
          "optional": true,
          "doc": "cmd: тип команды"
        },
        "office": {
          "type": "number",
          "optional": true,
          "doc": ""
        },
        "slot": {
          "type": "number",
          "optional": true,
          "doc": ""
        },
        "arg": {
          "type": "number",
          "optional": true,
          "doc": "cmd: speed у set_speed/exit (0 сервер опускает)"
        },
        "err": {
          "type": "string",
          "optional": true,
          "doc": "cmd: код отказа"
        },
        "conn": {
          "type": "number",
          "optional": true,
          "doc": "cmd/start/resume (ITGAME-91): номер соединения в партии (1, 2, … по порядку появления); пара (conn, id) у cmd уникальна в партии"
        },
        "src": {
          "type": "'tab' | 'bridge'",
          "optional": true,
          "doc": "cmd/start/resume (ITGAME-91): источник — вкладка (/ws) или мост агента (/ws/agent)"
        },
        "op": {
          "type": "string",
          "optional": true,
          "doc": "debug: patch | scenario | restore | advance"
        },
        "patch": {
          "type": "{ money?: number; day?: number; tickInDay?: number; }",
          "optional": true,
          "doc": ""
        },
        "scenario": {
          "type": "string",
          "optional": true,
          "doc": ""
        },
        "days": {
          "type": "number",
          "optional": true,
          "doc": ""
        },
        "ticks": {
          "type": "number",
          "optional": true,
          "doc": ""
        },
        "pre": {
          "type": "string",
          "optional": true,
          "doc": "resume: хэш поднятого сейва до догона"
        },
        "offline": {
          "type": "number",
          "optional": true,
          "doc": "resume: тики офлайн-догона"
        },
        "saveSpeed": {
          "type": "number",
          "optional": true,
          "doc": ""
        },
        "took": {
          "type": "boolean",
          "optional": true,
          "doc": "resume: прежний актор не закрыл журнал — перехват"
        },
        "evicted": {
          "type": "boolean",
          "optional": true,
          "doc": "end: сессию забрал другой актор (в строке — «end evicted»)"
        },
        "reason": {
          "type": "string",
          "optional": true,
          "doc": "end: read_timeout | debug_drop — закрыл сторож чтения (в строке — «end read_timeout»/«end debug_drop»); нет evicted и reason — «end disconnect»: соединение закрыл клиент (вкладка закрыта, F5, itd.away close, abandon)"
        },
        "hasSave": {
          "type": "boolean",
          "optional": true,
          "doc": "в записи был полный сейв (cp, resume)"
        },
        "hasState": {
          "type": "boolean",
          "optional": true,
          "doc": "debug restore: была дельта состояния"
        }
      }
    },
    "JournalView": {
      "kind": "object",
      "fields": {
        "sid": {
          "type": "string",
          "optional": false,
          "doc": ""
        },
        "seed": {
          "type": "string",
          "optional": false,
          "doc": ""
        },
        "difficulty": {
          "type": "string",
          "optional": false,
          "doc": ""
        },
        "scenario": {
          "type": "string",
          "optional": false,
          "doc": ""
        },
        "version": {
          "type": "string",
          "optional": false,
          "doc": "sha сервера, писавшего журнал"
        },
        "total": {
          "type": "number",
          "optional": false,
          "doc": "записей в журнале (без заголовка)"
        },
        "dropped": {
          "type": "number",
          "optional": false,
          "doc": "срезано кольцом с головы"
        },
        "overflow": {
          "type": "boolean",
          "optional": false,
          "doc": "журнал упёрся в потолок без чекпоинта"
        },
        "kinds": {
          "type": "Record<string, number>",
          "optional": false,
          "doc": "сколько записей каждого вида во всём журнале"
        },
        "lines": {
          "type": "string[]",
          "optional": false,
          "doc": "Хвост одной строкой на запись: «#seq k что | dN tN $M phase Nx revR +tk». «что» по\nвиду: cmd — «тип [oN] [sN] [=скорость] cN [bridge] idN ok|FAIL код» (cN — номер\nсоединения в партии, bridge — команда моста агента, ITGAME-91); start/resume —\n«cN [bridge]», у resume ещё «offline Nt [took]»; debug — «op детали»; end —\nevicted (сессию забрал другой актор: вторая вкладка, реконнект раньше, чем\nсервер заметил обрыв) | read_timeout (сторож чтения: вкладка молчала дольше\nITGAME_READ_TIMEOUT) | debug_drop (сторож после POST /api/debug/drop, itd.away\nnet) | disconnect (соединение закрыл клиент: вкладка, F5, away close, abandon);\n+tk — тики с прошлой записи."
        },
        "records": {
          "type": "JournalRecord[]",
          "optional": false,
          "doc": "тот же хвост объектами"
        },
        "url": {
          "type": "string",
          "optional": false,
          "doc": "полный JSONL: GET этого адреса; реплей — make replay ARGS=\"-url <origin> -sid <sid>\""
        }
      }
    },
    "LedgerEvent": {
      "kind": "object",
      "fields": {
        "what": {
          "type": "string",
          "optional": false,
          "doc": "«аудит провален», «дедлайн выполнен», «дедлайн отклонён», …"
        },
        "money": {
          "type": "number",
          "optional": false,
          "doc": "со знаком: штраф < 0, награда > 0"
        },
        "clock": {
          "type": "string",
          "optional": false,
          "doc": "«HH:MM» игрового дня"
        }
      }
    },
    "LedgerPurchase": {
      "kind": "object",
      "fields": {
        "type": {
          "type": "string",
          "optional": false,
          "doc": "команда протокола: buy_pc, hire, fire, call_master, …; event_choice — звезда из события; «…» — сводная строка сверх 32"
        },
        "price": {
          "type": "number",
          "optional": false,
          "doc": "списано, $"
        },
        "clock": {
          "type": "string",
          "optional": false,
          "doc": "«HH:MM» игрового дня"
        },
        "n": {
          "type": "number",
          "optional": true,
          "doc": "у сводной строки «…» — сколько покупок в ней"
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
      "type": "{ kind: 'method'; params: ParamSpec[]; returns: string; doc: string; examples: string[]; } | { kind: 'prop'; type: string; readonly: boolean; doc: string; examples?: string[]; }"
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
        "admin": {
          "type": "string",
          "optional": false,
          "doc": "'' — админа нет"
        },
        "adminUnpaidToday": {
          "type": "boolean",
          "optional": false,
          "doc": ""
        },
        "adminSlot": {
          "type": "number",
          "optional": false,
          "doc": "место, по которому его следующий клик; -1 — свободен или админа нет"
        },
        "adminKind": {
          "type": "'' | 'repair' | 'virus'",
          "optional": false,
          "doc": "что он там делает"
        },
        "adminFirePrice": {
          "type": "number",
          "optional": false,
          "doc": "компенсация увольнения; 0 — админа нет"
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
        "virusPCs": {
          "type": "number",
          "optional": false,
          "doc": "заражённых мест офиса (ITGAME-103)"
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
          "doc": "ключ сцены; 'page' — сам канвас против окна (ITGAME-61)"
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
          "doc": "на сколько вылез, px; у scene 'page' — CSS px окна"
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
    "PlayCmdStep": {
      "kind": "object",
      "fields": {
        "cmd": {
          "type": "'buy_pc' | 'hire' | 'buy_router' | 'hire_boss' | 'buy_office' | 'buy_server' | 'buy_gateway' | 'next_day' | 'restart' | 'buy_cooler' | 'buy_fridge' | 'buy_coffee' | 'set_speed' | 'upgrade_server' | 'upgrade_core' | 'motivate' | 'repair_click' | 'call_master' | 'event_choice' | 'fire' | 'virus_click' | 'set_antivirus' | 'hire_admin' | 'fire_admin' | 'buy_admin_dept' | 'abandon' | 'exit'",
          "optional": false,
          "doc": ""
        },
        "office": {
          "type": "number",
          "optional": true,
          "doc": "по умолчанию 0"
        },
        "extra": {
          "type": "Record<string, number>",
          "optional": true,
          "doc": "поля команды: {speed: 0} у set_speed, {slot: n} у fire/motivate/…"
        }
      }
    },
    "PlayDaysStep": {
      "kind": "object",
      "fields": {
        "days": {
          "type": "number",
          "optional": false,
          "doc": "1..90"
        }
      }
    },
    "PlayStep": {
      "kind": "alias",
      "type": "PlayCmdStep | PlayDaysStep"
    },
    "SandboxApi": {
      "kind": "object",
      "fields": {
        "restore": {
          "type": "() => SandboxRestore",
          "optional": false,
          "doc": "Выйти: сверить и вернуть ключи владельца, убрать служебные; не в партии."
        },
        "fakeOwner": {
          "type": "() => FakeOwnerResult",
          "optional": false,
          "doc": "Поставить «чужой» общий ключ (localStorage itd.sid/itd.diff) вызовом игры; restore() его уберёт."
        }
      },
      "call": [
        "(label: string) => SandboxResult"
      ]
    },
    "SandboxRestore": {
      "kind": "object",
      "fields": {
        "ok": {
          "type": "boolean",
          "optional": false,
          "doc": ""
        },
        "sidSame": {
          "type": "boolean",
          "optional": true,
          "doc": "localStorage itd.sid — тот, что был при входе (или fakeOwner): гард не тронул"
        },
        "diffSame": {
          "type": "boolean",
          "optional": true,
          "doc": "то же для itd.diff"
        },
        "fake": {
          "type": "boolean",
          "optional": true,
          "doc": "сверяли с «чужим» ключом fakeOwner()"
        },
        "restored": {
          "type": "string[]",
          "optional": true,
          "doc": "ключи, возвращённые как при входе"
        },
        "kept": {
          "type": "string[]",
          "optional": true,
          "doc": "общие ключи с ЧУЖИМ значением — не перетёрты: их мог записать сам владелец"
        },
        "removed": {
          "type": "string[]",
          "optional": true,
          "doc": "служебные ключи вкладки, убранные при выходе"
        },
        "code": {
          "type": "'in_party' | 'no_sandbox'",
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
    "SandboxResult": {
      "kind": "object",
      "fields": {
        "ok": {
          "type": "boolean",
          "optional": false,
          "doc": ""
        },
        "sid": {
          "type": "string",
          "optional": true,
          "doc": "sid песочницы во вкладке: a-<метка>-<время>"
        },
        "owner": {
          "type": "{ sid: boolean; diff: string | null; }",
          "optional": true,
          "doc": "общий ключ владельца при входе: есть ли sid, его сложность"
        },
        "code": {
          "type": "'bad_label' | 'in_party'",
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
    "ScreenMap": {
      "kind": "object",
      "fields": {
        "meta": {
          "type": "ScreenMeta",
          "optional": false,
          "doc": ""
        },
        "n": {
          "type": "number",
          "optional": false,
          "doc": ""
        },
        "items": {
          "type": "string[]",
          "optional": false,
          "doc": ""
        }
      }
    },
    "ScreenMeta": {
      "kind": "object",
      "fields": {
        "sha": {
          "type": "string",
          "optional": false,
          "doc": "сборка вкладки (itd.version.sha)"
        },
        "tab": {
          "type": "string",
          "optional": false,
          "doc": "первые 8 символов sid сокета вкладки"
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
        "t": {
          "type": "number | null",
          "optional": false,
          "doc": "тик дня"
        },
        "bal": {
          "type": "number | null",
          "optional": false,
          "doc": "баланс по серверу"
        },
        "speed": {
          "type": "number | null",
          "optional": false,
          "doc": ""
        },
        "phase": {
          "type": "'running' | 'day_report' | 'game_over' | 'won' | null",
          "optional": false,
          "doc": ""
        },
        "staff": {
          "type": "string | null",
          "optional": false,
          "doc": "«штат/лимит»"
        },
        "pay": {
          "type": "number | null",
          "optional": false,
          "doc": "ФОТ в день"
        },
        "hudClock": {
          "type": "string | null",
          "optional": false,
          "doc": "что НАРИСОВАНО в hud.day"
        },
        "hudBal": {
          "type": "string | null",
          "optional": false,
          "doc": "что НАРИСОВАНО в hud.money"
        },
        "blocker": {
          "type": "string | null",
          "optional": false,
          "doc": "«safe|сцена@depth» перекрытия во весь холст или null"
        },
        "title": {
          "type": "string | null",
          "optional": false,
          "doc": "заголовок верхнего окна (markTitle) или null"
        },
        "stale": {
          "type": "boolean | null",
          "optional": false,
          "doc": "вкладка на старом JS по последней проверке (itd.stale(), ITGAME-78); null — не проверяли или не с чем"
        }
      }
    },
    "ScreenOptions": {
      "kind": "object",
      "fields": {
        "frame": {
          "type": "number",
          "optional": true,
          "doc": "ширина рамки снимка инструмента, px: x/y сразу в ней (по умолчанию — CSS px окна)"
        },
        "free": {
          "type": "boolean",
          "optional": true,
          "doc": "только элементы, которые примут настоящий клик (без флага X)"
        },
        "scene": {
          "type": "string",
          "optional": true,
          "doc": "только эта сцена (hud, office, serverRoom, adminDept, menu)"
        }
      }
    },
    "ServerErrorCode": {
      "kind": "enum",
      "values": [
        "admin_already",
        "admin_dept_already",
        "admin_dept_locked",
        "antivirus_already",
        "bad_office",
        "bad_option",
        "bad_slot",
        "bad_speed",
        "bad_tier",
        "boss_already",
        "core_maxed",
        "equipment_already",
        "gateway_already",
        "motivate_cooldown",
        "need_cooler",
        "no_admin",
        "no_event",
        "no_free_office_slot",
        "no_free_pc",
        "no_free_rack_slot",
        "not_broken",
        "not_enough_money",
        "not_infected",
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
    "SpriteApi": {
      "kind": "object",
      "fields": {
        "try": {
          "type": "Promise<SpriteReceipt>",
          "optional": false,
          "doc": ""
        },
        "reset": {
          "type": "SpriteResetResult",
          "optional": false,
          "doc": ""
        },
        "list": {
          "type": "SpriteTried[]",
          "optional": false,
          "doc": ""
        }
      }
    },
    "SpriteFilter": {
      "kind": "enum",
      "values": [
        "linear",
        "nearest"
      ]
    },
    "SpriteReceipt": {
      "kind": "object",
      "fields": {
        "ok": {
          "type": "boolean",
          "optional": false,
          "doc": ""
        },
        "key": {
          "type": "string",
          "optional": true,
          "doc": ""
        },
        "w": {
          "type": "number",
          "optional": true,
          "doc": ""
        },
        "h": {
          "type": "number",
          "optional": true,
          "doc": ""
        },
        "filter": {
          "type": "SpriteFilter",
          "optional": true,
          "doc": ""
        },
        "sha256": {
          "type": "string | null",
          "optional": true,
          "doc": "null — страница не в secure context, crypto.subtle нет"
        },
        "objects": {
          "type": "number",
          "optional": true,
          "doc": "живых объектов сцен перевешено на новую текстуру"
        },
        "problems": {
          "type": "string[]",
          "optional": true,
          "doc": "нарушения контракта; текстура при этом СТОИТ"
        },
        "warnings": {
          "type": "string[]",
          "optional": true,
          "doc": ""
        },
        "stats": {
          "type": "{ transparentPct: number; whitePct: number; noiseSummary: string; totalSpecks: number; maxSpecks: number; }",
          "optional": true,
          "doc": ""
        },
        "code": {
          "type": "'unknown_key' | 'bad_src' | 'bad_size' | 'bad_filter'",
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
    "SpriteResetResult": {
      "kind": "object",
      "fields": {
        "ok": {
          "type": "boolean",
          "optional": false,
          "doc": ""
        },
        "reset": {
          "type": "string[]",
          "optional": false,
          "doc": ""
        },
        "code": {
          "type": "'not_tried'",
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
    "SpriteTried": {
      "kind": "object",
      "fields": {
        "key": {
          "type": "string",
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
        "filter": {
          "type": "SpriteFilter",
          "optional": false,
          "doc": ""
        },
        "sha256": {
          "type": "string | null",
          "optional": false,
          "doc": ""
        },
        "problems": {
          "type": "string[]",
          "optional": false,
          "doc": ""
        }
      }
    },
    "SpriteTryOptions": {
      "kind": "object",
      "fields": {
        "filter": {
          "type": "SpriteFilter",
          "optional": true,
          "doc": "по умолчанию — как ключ рисуется в игре: linear у render: smooth, иначе nearest"
        }
      }
    },
    "StackResult": {
      "kind": "object",
      "fields": {
        "ok": {
          "type": "boolean",
          "optional": false,
          "doc": "false — нет узла / узел невидим (why)"
        },
        "at": {
          "type": "{ x: number; y: number; } | null",
          "optional": false,
          "doc": "точка, мировые 1280×720"
        },
        "stack": {
          "type": "string[]",
          "optional": false,
          "doc": ""
        },
        "wins": {
          "type": "HitTarget | null",
          "optional": false,
          "doc": "кто получит pointerdown; null — никто"
        },
        "why": {
          "type": "string",
          "optional": true,
          "doc": ""
        }
      }
    },
    "StaleInfo": {
      "kind": "object",
      "fields": {
        "client": {
          "type": "string",
          "optional": false,
          "doc": "sha JS этой вкладки (= itd.version.sha)"
        },
        "server": {
          "type": "string | null",
          "optional": false,
          "doc": "sha бинаря сервера (GET /api/version); null — неизвестен"
        },
        "dist": {
          "type": "string | null",
          "optional": false,
          "doc": "sha сборки, которую стенд отдаст при перезагрузке (<meta name=\"build\"> его index.html)"
        },
        "stale": {
          "type": "boolean | null",
          "optional": false,
          "doc": "вкладка на старом JS (client ≠ dist, без dist — ≠ server); null — сверить не с чем"
        },
        "at": {
          "type": "number",
          "optional": false,
          "doc": "epoch ms проверки"
        },
        "shown": {
          "type": "boolean",
          "optional": false,
          "doc": "ITGAME-88: метка «устарело, обнови» видна на экране после этой проверки (в DOM она живёт всегда, скрытая — display:none, 0×0); false и без #topbar (нет ?debug=1/itd.admin)"
        }
      }
    },
    "StateCause": {
      "kind": "enum",
      "values": [
        "cmd",
        "debug",
        "resume",
        "start",
        "tick"
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
        "rev": {
          "type": "number",
          "optional": false,
          "doc": ""
        },
        "cause": {
          "type": "'tick' | 'cmd' | 'debug' | 'start' | 'resume'",
          "optional": false,
          "doc": ""
        },
        "re": {
          "type": "number",
          "optional": true,
          "doc": "id команды ЭТОГО соединения, породившей снапшот; у других соединений нет"
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
        "adminDept": {
          "type": "boolean",
          "optional": false,
          "doc": "отдел админов куплен (ITGAME-101): без него админов не нанять"
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
        "adminSalaryPerDay": {
          "type": "number",
          "optional": false,
          "doc": "зарплата админа офиса (ITGAME-101)"
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
        "offlineReport": {
          "type": "boolean",
          "optional": true,
          "doc": "первый снапшот после resume: следом идёт offline_report (ITGAME-76)"
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
        "debtLimit": {
          "type": "number",
          "optional": false,
          "doc": "порог долга, $: глубже — вечер банкротит; creditLimit или, без кредита, payrollPerDay (овердрафт, ITGAME-156)"
        },
        "bankruptInDays": {
          "type": "number",
          "optional": false,
          "doc": "обречённая партия: банкротство через N закрытий дня, 0 — нет (ITGAME-118)"
        },
        "virusWaveAt": {
          "type": "string",
          "optional": false,
          "doc": "«HH:MM», с которого видна следующая волна вируса; '' — заражённых нет (ITGAME-103)"
        },
        "antivirus": {
          "type": "AntivirusInfo",
          "optional": false,
          "doc": "подписка на антивирус (ITGAME-137)"
        },
        "activeEvent": {
          "type": "ActiveEventInfo | null",
          "optional": false,
          "doc": "висящее событие Unseen Forces"
        },
        "dayLog": {
          "type": "string[]",
          "optional": false,
          "doc": ""
        },
        "prices": {
          "type": "{ pc: number; hire: number; boss: number; admin: number; adminDept: number; gateway: number; cooler: number; fridge: number; coffeeMachine: number; repair: number; serverLevels: { mult: number; price: number; }[]; coreLevels: { capacity: number; price: number; mult: number; }[]; antivirusTiers: { name: string; seats: number; price: number; }[]; }",
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
    "TraceApi": {
      "kind": "object",
      "fields": {
        "start": {
          "type": "(opts?: TraceStartOptions) => TraceStart",
          "optional": false,
          "doc": "Открыть окно: подписки сразу, до stop(id?) или maxMs (1..600000, по умолчанию 120000) → {ok, id, t0, maxMs, open}; коды bad_max, too_many (больше 8 окон)."
        },
        "stop": {
          "type": "(id?: number) => TraceResult | (AgentResult & { code: 'no_trace'; })",
          "optional": false,
          "doc": "Закрыть окно id (без id — последнее открытое) → TraceResult того же вида, что у itd.trace(), с id, windowMs = длина окна, cut — закрылось само по maxMs; нет окна — {ok:false, code:'no_trace'}."
        },
        "summary": {
          "type": "(src?: number | TraceResult) => TraceSummary",
          "optional": false,
          "doc": "Окно короткими строками по времени (ITGAME-179), не закрывая: summary(id?) — открытое (или cut) окно, без id — последнее; summary(tr) — любой TraceResult → {ok, id?, cut?, error?, lines['t<мс> ptr|key|sent|recv|state|trans|toast|sound …']}; нет окна / не TraceResult — {ok:false, code:'no_trace', lines: []}."
        }
      },
      "call": [
        "(action: () => unknown, windowMs?: number) => Promise<TraceResult>"
      ]
    },
    "TracePointer": {
      "kind": "object",
      "fields": {
        "t": {
          "type": "number",
          "optional": false,
          "doc": ""
        },
        "type": {
          "type": "'down' | 'up'",
          "optional": false,
          "doc": "mousedown / mouseup (Phaser слушает именно их)"
        },
        "button": {
          "type": "number",
          "optional": false,
          "doc": "0 — левая, 2 — правая (увольнение в офисе)"
        },
        "x": {
          "type": "number",
          "optional": false,
          "doc": "мировые 1280×720 — как nodes().cx/cy и itd.stack(gx, gy)"
        },
        "y": {
          "type": "number",
          "optional": false,
          "doc": ""
        },
        "onCanvas": {
          "type": "boolean",
          "optional": false,
          "doc": "событие пришло в канвас; false — мимо холста (#topbar, поля страницы)"
        },
        "wins": {
          "type": "string | null",
          "optional": false,
          "doc": "ITGAME-179: метка победителя хит-теста Phaser в момент события — та же форма, что got (safe id или тип без id); полная строка — stack[0]; null — ни одна hitArea не накрывает точку"
        },
        "stack": {
          "type": "string[]",
          "optional": false,
          "doc": "все interactive под точкой сверху вниз, как itd.stack().stack"
        },
        "got": {
          "type": "string[]",
          "optional": false,
          "doc": "до кого Phaser реально довёл pointerdown/up в этом событии (GAMEOBJECT_POINTER_DOWN/UP объекта): safe id или тип без id; [] — до объектов не дошло. Кнопка, удалившая себя в pointerdown, в got на down есть, на up её нет"
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
          "type": "TraceSent[]",
          "optional": false,
          "doc": "полная команда, по порядку отправки; src — откуда (ITGAME-179)"
        },
        "recv": {
          "type": "{ t: number; type: string; info: Record<string, unknown>; }[]",
          "optional": false,
          "doc": "не-state входящие: error/day_report/game_over/… (у error info.re/rev)"
        },
        "states": {
          "type": "{ t: number; rev: number; cause: string; re?: number; }[]",
          "optional": false,
          "doc": "ITGAME-45: снапшоты окна — rev, cause (tick|cmd|debug|start|resume), re — id своей команды-причины."
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
        },
        "pointer": {
          "type": "TracePointer[]",
          "optional": false,
          "doc": "ITGAME-88: настоящие нажатия указателя в окне (mousedown/mouseup): мировые x/y,\nwins — метка победителя (как got), stack — хит-тест Phaser в момент события, got — до кого дошёл\npointerdown/up (GAMEOBJECT_POINTER_DOWN/UP самих объектов, ITGAME-112:\nсценовый gameobjectdown терял объект, удаливший себя в обработчике).\nitd.click() сюда не попадает: он мимо input-слоя.\nПусто при «команда не ушла» — клик до страницы не дошёл; есть запись с\ngot [] — дошёл до хит-теста, цели нет; got с целью — до неё дошёл\npointerdown/up, обработчик сам решил не слать (или закрыл своё окно: такой\nобъект в got на down есть, а на up его уже нет — удалённый до отпускания\nне попадает в хит-тест Phaser)."
        },
        "id": {
          "type": "number",
          "optional": true,
          "doc": "ITGAME-88: открытое окно itd.trace.start() — его id"
        },
        "cut": {
          "type": "boolean",
          "optional": true,
          "doc": "ITGAME-88: открытое окно закрылось само по maxMs раньше stop()"
        }
      }
    },
    "TraceSent": {
      "kind": "object",
      "fields": {
        "t": {
          "type": "number",
          "optional": false,
          "doc": ""
        },
        "type": {
          "type": "string",
          "optional": false,
          "doc": ""
        },
        "office": {
          "type": "number",
          "optional": true,
          "doc": ""
        },
        "src": {
          "type": "'itd' | 'ui'",
          "optional": false,
          "doc": "itd — ушла синхронно внутри вызова itd.* (cmd, click, key, pause, resume, speed, step; play — через cmd); ui — всё прочее: настоящий клик/клавиша, реакция UI на снапшот"
        }
      },
      "index": [
        "[k: string]: unknown"
      ]
    },
    "TraceStart": {
      "kind": "object",
      "fields": {
        "ok": {
          "type": "boolean",
          "optional": false,
          "doc": ""
        },
        "id": {
          "type": "number",
          "optional": true,
          "doc": "ключ для itd.trace.stop(id)"
        },
        "t0": {
          "type": "number",
          "optional": true,
          "doc": "epoch ms постановки подписок"
        },
        "maxMs": {
          "type": "number",
          "optional": true,
          "doc": ""
        },
        "open": {
          "type": "number[]",
          "optional": true,
          "doc": "id открытых сейчас окон (с этим)"
        },
        "code": {
          "type": "'bad_max' | 'too_many'",
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
    "TraceStartOptions": {
      "kind": "object",
      "fields": {
        "maxMs": {
          "type": "number",
          "optional": true,
          "doc": "окно закроется само через столько мс, если stop() не позвали: 1..600000, по умолчанию 120000"
        }
      }
    },
    "TraceSummary": {
      "kind": "object",
      "fields": {
        "ok": {
          "type": "boolean",
          "optional": false,
          "doc": "как у TraceResult (false — action упал, см. error); нет окна — false и code no_trace"
        },
        "code": {
          "type": "'no_trace'",
          "optional": true,
          "doc": ""
        },
        "error": {
          "type": "string",
          "optional": true,
          "doc": "no_trace — почему; иначе ошибка action окна (TraceResult.error)"
        },
        "id": {
          "type": "number",
          "optional": true,
          "doc": "окно itd.trace.start()"
        },
        "cut": {
          "type": "boolean",
          "optional": true,
          "doc": "окно закрылось само по maxMs"
        },
        "lines": {
          "type": "string[]",
          "optional": false,
          "doc": "По строке на запись окна по возрастанию t (при равном t: ptr, key, sent, recv,\nstate, trans, toast, sound); [] при no_trace.\n't<мс> ptr down|up [b<кнопка>] x,y canvas|page wins <метка>|- got [..]',\n't<мс> key <KEY> dom|itd [repeat] handled [сцены]|unhandled [acted [сцена:действие ..]]',\n't<мс> sent <type> [o<office>] [k=v ..] [id<id>] itd|ui',\n't<мс> recv <type> [<code>] [re<id>] [rev<N>] [k=v ..]', 't<мс> state rev<N> <cause> [re<id>]',\n't<мс> trans <kind> <from>→<to>' (null — '-'), 't<мс> toast \"<текст>\"', 't<мс> sound <name> ok|fail'."
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
      "type": "{ kind: 'object'; fields: Record<string, FieldSpec>; index?: string[]; call?: string[]; } | { kind: 'enum'; values: string[]; } | { kind: 'alias'; type: string; }"
    },
    "ZoneRect": {
      "kind": "object",
      "fields": {
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
        }
      }
    },
    "ZonesResult": {
      "kind": "object",
      "fields": {
        "ok": {
          "type": "boolean",
          "optional": false,
          "doc": ""
        },
        "a": {
          "type": "string",
          "optional": false,
          "doc": ""
        },
        "b": {
          "type": "string",
          "optional": false,
          "doc": ""
        },
        "aUnderB": {
          "type": "ZoneRect[]",
          "optional": false,
          "doc": ""
        },
        "bUnderA": {
          "type": "ZoneRect[]",
          "optional": false,
          "doc": ""
        },
        "area": {
          "type": "{ a: number; aUnderB: number; b: number; bUnderA: number; }",
          "optional": false,
          "doc": ""
        },
        "why": {
          "type": "string",
          "optional": true,
          "doc": ""
        }
      }
    }
  }
} satisfies { schema: 1; hash: string; methods: { [K in keyof ItdApi]-?: MemberSpec }; types: Record<string, TypeSpec> }
