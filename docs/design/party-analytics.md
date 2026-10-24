# Партии в PostgreSQL для аналитики — предложение схемы

**Статус: на вычитке владельца, 24.10.2026 (ITGAME-237).** Здесь только схема и
что пишем; миграции и кода ещё нет — они после согласования. Прогоны sim,
load-bots и qa-сценарии с авторегрессией — отдельная задача ITGAME-126, мета-прогресс
на сервер — ITGAME-132 (встаёт рядом с этими таблицами).

## Вопросы, на которые отвечаем

1. Где проигрывают: на каком дне, по какой причине, на какой сложности, с каким
   штатом и офисами.
2. На каком дне бросают: игрок нажал «Сдаться» или просто не вернулся.
3. Что было перед концом: деньги, доход, ФОТ, покупки и решения в событиях за
   последние дни.

Счётчики ITGAME-189 (Prometheus, Grafana) остаются как есть: сколько партий
начато и закончено, команды по типам, дни до финала гистограммой. В базу идут
сами партии — то, что счётчиком не собрать: путь одной партии по дням.

## Что есть в коде сейчас

- Партию ведёт актор сессии, `server/internal/ws/session.go`. Старт, финал,
  «Сдаться» и рестарт он уже ловит для метрик (`partyMetrics` в `ws/metrics.go`:
  `started`, `settle`, `finish`; финал засчитывается один раз) — те же точки
  годятся для записи.
- **`sid` — это партия, а не игрок.** Новую партию из меню клиент начинает с
  нового `sid` (`prepareNewGame`, `client/src/net.ts`); в одном `sid` партии
  сменяются только рестартом после проигрыша (`game.Restart`, работает лишь в
  `PhaseGameOver`, строит игру с нуля). Значит, внутри `sid` партии идут строго
  по очереди, и ключ партии — `sid` плюс номер рестарта. Своего id в сейве не
  нужно — и его нельзя добавить даром: любое новое поле `ws.sessionSave` поднимает
  `SaveFormat`, а это сброс всех живых партий на деплое (`docs/development.md`,
  «Sessions and saves»).
- Постоянного id игрока нет вовсе: регистрации нет, `sid` живёт одну партию.
- Книга дня `game.DayLedger` (ITGAME-73): баланс на утро и вечер, доход, деньги
  событий, покупки по типам (`buy_pc`, `hire`, `fire`, `call_master`, …), ФОТ,
  шлюз, антивирус, процент, debug-правка. Закрытый день на отчёте дня ещё лежит
  в `g.Ledger` (в `LedgerHistory` он уходит только на `NextDay`), поэтому берём
  `g.LedgerOf(report.Day)` после тика — он ставит `BalanceEnd`. История держит
  `LedgerDays = 7` закрытых дней.
- Выбор игрока в событии (`game.ChooseEvent`) в книге не виден: там только деньги
  исхода текстом. Невыбранное к вечеру событие гасит `autoResolveEvents`
  («просьба о повышении проигнорирована») — это тоже решение.
- Метрика финала считает весь `PhaseGameOver` как `bankrupt`; в базе причина
  точная — `game.LoseReason`: `bankrupt`, `time_up`, `deadlock`.
- У прода и стейджа свои базы (`itgame` и `itgame_stage`, ITGAME-168), у стенда
  :15555 — `itdirector_dev`. Окружение — это сама база, колонки под него не нужно.

## Схема (миграция `0003_parties.sql`)

```sql
CREATE TABLE parties (
    id            bigserial PRIMARY KEY,
    sid_hash      text NOT NULL,              -- sha256(sid) hex; сырой sid — ключ сейва, не храним
    n             int  NOT NULL,              -- 1, 2, … — партии одного sid по рестартам
    partial       bool NOT NULL DEFAULT false,-- старт не записан: строку завело позднее событие
    build         text NOT NULL,              -- BuildVersion() на старте
    difficulty    text NOT NULL,
    scenario      text NOT NULL DEFAULT '',   -- фикстура старта; '' — обычная партия
    seed          text NOT NULL,
    client        text NOT NULL,              -- desktop | mobile | bot | unknown (?client=)
    started_at    timestamptz NOT NULL,
    last_seen_at  timestamptz NOT NULL,       -- последняя запись по партии
    expires_at    timestamptz NOT NULL,       -- last_seen_at + TTL сейва (-save-ttl)
    ended_at      timestamptz,
    outcome       text,                       -- NULL идёт | victory | lost | abandon | reset
    lose_reason   text,                       -- при lost: bankrupt | time_up | deadlock
    day           int    NOT NULL DEFAULT 1,  -- последний достигнутый день
    money         bigint NOT NULL,            -- баланс на последней записи
    sessions      int  NOT NULL DEFAULT 1,    -- старт + подъёмы из сейва
    ended_offline bool NOT NULL DEFAULT false,-- финал пришёл в офлайн-догоне
    debug         bool NOT NULL DEFAULT false,-- была debug-мутация: из аналитики вон
    UNIQUE (sid_hash, n)
);
CREATE INDEX parties_started ON parties (started_at);

CREATE TABLE party_days (
    party_id   bigint NOT NULL REFERENCES parties (id) ON DELETE CASCADE,
    day        int    NOT NULL,
    closed_at  timestamptz NOT NULL,
    offline    bool   NOT NULL,               -- день закрыт офлайн-движком
    balance    bigint NOT NULL,               -- BalanceEnd книги
    income     bigint NOT NULL,
    payroll    bigint NOT NULL,
    staff      int    NOT NULL,               -- сотрудников на вечер — из g, не из книги
    offices    int    NOT NULL,
    pcs        int    NOT NULL,
    ledger     jsonb  NOT NULL,               -- g.LedgerOf(day) целиком
    PRIMARY KEY (party_id, day)
);

CREATE TABLE party_choices (
    party_id   bigint NOT NULL REFERENCES parties (id) ON DELETE CASCADE,
    day        int  NOT NULL,
    tick       int  NOT NULL,                 -- тик дня
    event      text NOT NULL,                 -- EventID
    choice     int  NOT NULL,                 -- выбранная опция; -1 — проигнорировано до вечера
    at         timestamptz NOT NULL,
    PRIMARY KEY (party_id, day, tick, event)
);
```

Шесть колонок `party_days` рядом с `ledger` — намеренно: по ним строятся
графики «перед проигрышем» без разбора `jsonb`; три из них (`staff`, `offices`,
`pcs`) в книге и не лежат.

### Исходы

| `outcome` | Когда |
|---|---|
| `NULL` | партия идёт или брошена (см. ниже) |
| `victory` | `PhaseWon` |
| `lost` | `PhaseGameOver`, причина в `lose_reason` |
| `abandon` | «Сдаться» (`cmdAbandon`) |
| `reset` | сейв не поднялся: чужой формат после деплоя (ITGAME-169), битый, чужой по `sid`, `Restore` упал — все ветки `resume`, что кончаются `Saves.Finish` |

«Брошенную» в базу не пишем отдельным событием — её некому заметить. Это вид:
партия без исхода, чей сейв уже истёк (`expires_at` пишется с каждой записью из
настоящего `-save-ttl`, а не зашитых 24 ч).

```sql
CREATE VIEW party_status AS
SELECT p.*,
       CASE WHEN outcome IS NOT NULL THEN outcome
            WHEN expires_at < now() THEN 'dropped'
            ELSE 'running' END AS status
FROM parties p;
```

(`p.*` вид замораживает: колонки, добавленные позже, — через `CREATE OR REPLACE VIEW`.)

## Когда и что пишем

Пишет актор только при `withSaves` — без сейвов (`-saves off`, невалидный `sid`)
партии нечем адресовать, и она в базу не идёт.

| Момент в акторе | Запись |
|---|---|
| новая партия (`pm.started`: новый `sid` или рестарт) | `parties`: новая строка с `n = max(n) + 1` по `sid_hash`; после рестарта `scenario = ''` |
| подъём из сейва | последняя партия `sid`: `sessions + 1`, `last_seen_at`, `expires_at` |
| сейв не поднялся (`Finish` в `resume`) | последняя партия `sid`: `outcome = 'reset'` |
| закрытие дня (отчёт дня, офлайн-догон, промотка) | `party_days` по дню, `parties.day/money` |
| выбор в событии (`event_choice` прошёл) | `party_choices` |
| событие погашено вечером (`autoResolveEvents`) | `party_choices` с `choice = -1` |
| финал (`pm.finish`: победа, проигрыш, «Сдаться») | `parties.outcome/lose_reason/ended_at/ended_offline` |
| уход актора (разрыв, вытеснение, таймаут) | `parties.last_seen_at/expires_at/money/day` |
| debug-мутация (`applyDebug` сменил `rev`, как у `jn.debug`) | `parties.debug = true` |

**Адресация.** Каждая запись несёт `sid_hash`; писатель — одна горутина, так что
«последняя партия этого `sid`» без гонок. Старт заводит новую строку. Прочие
записи меняют последнюю; если строки нет или последняя уже с исходом, а пришёл
день или выбор — значит, старт потерялся: заводится новая строка с
`partial = true`. Уход актора после финала остаётся у финальной партии — после
финала сессия живёт до «В меню» (ITGAME-51).

**Обновления, а не полная строка.** `started_at`, `build`, `client` в сейве не
лежат, и актор после подъёма их не знает, — их пишет только старт. Остальное —
монотонно, чтобы запоздалая запись вытесненного актора ничего не откатила:
`day = GREATEST(day, $day)`, `last_seen_at`/`expires_at` — `GREATEST`,
`outcome = COALESCE(outcome, $outcome)`, `debug = debug OR $debug`,
`sessions = sessions + 1`. Дни — upsert по `(party_id, day)`: офлайн-догон и
debug-откат закрывают день повторно.

**Игра базу не ждёт** (правило ITGAME-190). Актор кладёт запись в буферный канал
без блокировки; писатель пишет в базу. База лежит или канал полон — запись
теряется и считается метрикой `itgame_partylog_dropped_total`. Старт и финал при
полном канале вытесняют дни, а не наоборот: без них партия становится `partial`
или ложно `dropped`. Мягкой остановки у сервера нет (`log.Fatal` на
`ListenAndServe`), так что хвост буфера при деплое теряется — потеря одного
`last_seen_at`, исход и дни уже записаны раньше. Это статистика, а не учёт.

**Длинный офлайн.** День — 54 тика по секунде на темпе 1; уход минут на шесть
уже закрывает за догон больше семи дней, а книга помнит только `LedgerDays = 7`.
Дни старше не пишутся вовсе — их баланса и дохода уже нигде нет; `parties.day`
при этом верен.
Дыра в `party_days` — сама по себе ответ «игрок долго не заходил».

**Боты.** load-bots ходят на `/ws` без `?client=` и считаются `desktop`. Им —
`?client=bot`, в `clientKinds` — вид `bot`; это же значение метки Prometheus,
так что таблица метрик в `docs/development.md` и `TestMetricsPresetSeries`
меняются вместе.

**Заодно в акторе.** Переменная `scenario` на рестарте не сбрасывается — новая
партия тащит в сейв и журнал фикстуру прошлой. Чинится той же задачей.

## Запросы под вопросы

Аналитика — `NOT debug AND scenario = '' AND client <> 'bot'` на базе прода.

```sql
-- 1. Где проигрывают: день и причина по сложности
SELECT difficulty, lose_reason, day, count(*)
FROM parties
WHERE outcome = 'lost' AND NOT debug AND scenario = '' AND client <> 'bot'
GROUP BY 1, 2, 3 ORDER BY 1, 2, 3;

-- 2. На каком дне бросают: «Сдаться» и тихий уход
SELECT status, day, count(*)
FROM party_status
WHERE status IN ('abandon', 'dropped') AND NOT debug AND scenario = '' AND client <> 'bot'
GROUP BY 1, 2 ORDER BY 1, 2;

-- 3. Три последних дня перед проигрышем
SELECT p.id, p.difficulty, p.lose_reason, d.day, d.balance, d.income, d.payroll, d.staff, d.pcs
FROM parties p JOIN party_days d ON d.party_id = p.id
WHERE p.outcome = 'lost' AND d.day > p.day - 3
  AND NOT p.debug AND p.scenario = '' AND p.client <> 'bot'
ORDER BY p.id, d.day;
```

Читать их агенту — через MCP `itd-db` (только чтение) на стенде; к базе прода —
отдельный вопрос minipc.

## Объём

Книга дня — несколько килобайт (покупки сверх потолка сворачиваются в сводную
строку). Люди дают сотни строк `party_days` в день — мегабайты в месяц, чистка
не нужна. Боты другое дело: на темпе 3 один бот закрывает ~200 дней в час, и
стейдж после прогона 50 ботов (ITGAME-193) копит сотни мегабайт — там нужна
чистка партий `client = 'bot'` старше недели. Замерить на том же прогоне.

## Мета-прогресс (ITGAME-132)

Эти таблицы дают ему партии, но не игрока: `sid` живёт одну партию. Достижения и
рекорд «на браузер» потребуют своего ключа — постоянного id из `localStorage`,
который клиент шлёт при подключении (`?player=`). Это не сейв, формат не
трогает; колонка `player` в `parties` и таблица `player_meta` — в ITGAME-132.

## Порядок работ после согласования

1. Миграция `0003_parties.sql`, писатель с буфером и метрикой потерь, точки в
   акторе, сброс `scenario` на рестарте; тесты на `TEST_DATABASE_URL`.
2. `?client=bot` у load-bots и вид `bot` в метриках.
3. Запросы — в `docs/development.md`, раздел «Database».

Задачи minipc не нужно: окружение — это база, юниты не меняются.

## Решить владельцу

1. Сырой `sid` не храним, только `sha256` — годится?
2. Брошенная = без исхода и с истёкшим сейвом (`-save-ttl`, сейчас 24 ч) — или свой порог?
3. Книга дня в `jsonb` целиком — или только шесть колонок без `ledger`?
4. Партии с debug-мутацией писать с флагом `debug` — или не писать вовсе?
