# Партии в PostgreSQL для аналитики — предложение схемы

**Статус: на вычитке владельца, 24.10.2026 (ITGAME-237).** Здесь только схема и
что пишем; миграции и кода ещё нет — они после согласования. Прогоны sim,
load-bots и qa-сценарии с авторегрессией — отдельная задача ITGAME-126, мета-прогресс
на сервер — ITGAME-132 (встаёт рядом с этими таблицами).

## Вопросы, на которые отвечаем

1. Где банкротятся: на каком дне, по какой причине, на какой сложности, с каким
   штатом и офисами.
2. На каком дне бросают: игрок нажал «Сдаться» или просто не вернулся.
3. Что было перед концом: деньги, доход, ФОТ, покупки и выборы в событиях за
   последние дни.

Счётчики ITGAME-189 (Prometheus, Grafana) остаются как есть: сколько партий
начато и закончено, команды по типам, дни до финала гистограммой. В базу идут
сами партии — то, что счётчиком не собрать: путь одной партии по дням.

## Что есть в коде сейчас

- Партию ведёт актор сессии, `server/internal/ws/session.go`. Старт, финал,
  «Сдаться» и рестарт он уже ловит для метрик (`partyMetrics` в `ws/metrics.go`:
  `started`, `settle`, `finish`) — те же точки годятся для записи.
- Книга дня `game.DayLedger` (ITGAME-73) уже держит день целиком: баланс на
  утро и вечер, доход, деньги событий, покупки по типам (`buy_pc`, `hire`,
  `fire`, `call_master`, …), ФОТ, шлюз, антивирус, процент, debug-правку.
  Её и пишем, не раскладывая по колонкам заново.
- Выбор игрока в событии (`game.ChooseEvent`) в книге не виден: там только
  деньги исхода текстом. Для него — своя таблица.
- `sid` — ключ сейва, он переживает рестарт после банкротства: в одной сессии
  бывает несколько партий. Значит, у партии свой id.
- Метрика финала считает весь `PhaseGameOver` как `bankrupt`; в базе причина
  точная — `game.LoseReason`: `bankrupt`, `time_up`, `deadlock`.
- Своего окружения сервер не знает: в юнитах есть `DATABASE_URL` и
  `ITGAME_METRICS_ADDR`, но нет «это прод».

## Схема (миграция `0003_parties.sql`)

```sql
CREATE TABLE parties (
    id            uuid PRIMARY KEY,           -- party_id, живёт в sessionSave
    env           text NOT NULL,              -- ITGAME_ENV: prod | stage | stand | dev
    player        text NOT NULL,              -- sha256(sid) hex; сырой sid не храним
    build         text NOT NULL,              -- BuildVersion() на старте партии
    difficulty    text NOT NULL,
    scenario      text NOT NULL DEFAULT '',   -- фикстура старта; '' — обычная партия
    seed          text NOT NULL,
    client        text NOT NULL,              -- desktop | mobile | unknown (?client=)
    started_at    timestamptz NOT NULL,
    last_seen_at  timestamptz NOT NULL,       -- последний сейв, день или уход актора
    ended_at      timestamptz,
    outcome       text,                       -- NULL идёт | victory | lost | abandon | reset
    lose_reason   text,                       -- при lost: bankrupt | time_up | deadlock
    day           int  NOT NULL,              -- последний достигнутый день
    money         int  NOT NULL,              -- баланс на последней записи
    sessions      int  NOT NULL DEFAULT 1,    -- старт + подъёмы из сейва
    ended_offline bool NOT NULL DEFAULT false,-- финал пришёл в офлайн-догоне
    debug         bool NOT NULL DEFAULT false -- была debug-правка: из аналитики вон
);
CREATE INDEX parties_env_started ON parties (env, started_at);
CREATE INDEX parties_player      ON parties (player, started_at); -- ITGAME-132

CREATE TABLE party_days (
    party_id   uuid NOT NULL REFERENCES parties (id) ON DELETE CASCADE,
    day        int  NOT NULL,
    closed_at  timestamptz NOT NULL,
    offline    bool NOT NULL,                 -- день закрыт офлайн-движком
    balance    int  NOT NULL,                 -- BalanceEnd книги
    income     int  NOT NULL,
    payroll    int  NOT NULL,
    staff      int  NOT NULL,                 -- сотрудников на вечер
    offices    int  NOT NULL,
    pcs        int  NOT NULL,
    ledger     jsonb NOT NULL,                -- game.DayLedger закрытого дня целиком
    PRIMARY KEY (party_id, day)
);

CREATE TABLE party_choices (
    party_id   uuid NOT NULL REFERENCES parties (id) ON DELETE CASCADE,
    day        int  NOT NULL,
    tick       int  NOT NULL,                 -- тик дня
    event      text NOT NULL,                 -- EventID
    option     int  NOT NULL,                 -- выбранная опция
    at         timestamptz NOT NULL,
    PRIMARY KEY (party_id, day, tick, event)
);
```

Пять колонок `party_days` дублируют книгу намеренно: по ним строятся графики
«перед банкротством», и в `jsonb` за ними лазить не нужно. Всё прочее за день
берётся из `ledger`.

### Исходы

| `outcome` | Когда |
|---|---|
| `NULL` | партия идёт или брошена (см. ниже) |
| `victory` | `PhaseWon` |
| `lost` | `PhaseGameOver`, причина в `lose_reason` |
| `abandon` | «Сдаться» (`cmdAbandon`) |
| `reset` | сейв не поднялся: чужой формат после деплоя (ITGAME-169) |

«Брошенную» в базу не пишем отдельным событием — её некому заметить. Это вид:
партия без исхода, к которой не возвращались дольше TTL сейва (сейчас `-save-ttl`
24 ч — после него сейва нет, вернуться некуда).

```sql
CREATE VIEW party_status AS
SELECT p.*,
       CASE WHEN outcome IS NULL AND last_seen_at < now() - interval '24 hours'
            THEN 'dropped' ELSE coalesce(outcome, 'running') END AS status
FROM parties p;
```

## Когда и что пишем

| Момент в акторе | Запись |
|---|---|
| новая партия (`pm.started`, в том числе после рестарта) | `parties`: новая строка, новый `party_id` в сейв |
| подъём из сейва | `parties`: `sessions + 1`, `last_seen_at` |
| закрытие дня (отчёт дня, в том числе офлайн-догон и промотка) | `party_days` по дню, `parties.day/money` |
| выбор в событии (`event_choice` прошёл) | `party_choices` |
| финал (`pm.finish`: победа, проигрыш, «Сдаться») | `parties.outcome/lose_reason/ended_at` |
| уход актора (разрыв, вытеснение, таймаут) | `parties.last_seen_at`, `money`, `day` |
| debug-правка (`applyDebug`, чит, `advanceDays`) | `parties.debug = true` |

**Игра базу не ждёт** (правило ITGAME-190). Актор кладёт запись в буферный
канал без блокировки; одна горутина-писатель пишет в базу. База лежит или канал
полон — запись теряется и считается метрикой `itgame_partylog_dropped_total`.
Чтобы потерянный старт не ломал внешние ключи, каждая запись партии — upsert
полной строки `parties` (`ON CONFLICT (id) DO UPDATE`): следующий же день
восстановит строку, пусть и с приблизительным `started_at`. Дни — тоже upsert
по `(party_id, day)`: офлайн-догон и debug-откат закрывают день повторно.

**`party_id` в сейве.** Новое поле `sessionSave.PartyID` (`omitempty`). Формат
игры (`game.SaveFormat`) не меняется: это конверт сессии, а не состояние
игры. Старый сейв без поля при подъёме получает новый id — такая партия
начинается в базе не с первого дня, это видно по `party_days`.

**Окружение.** Новая переменная `ITGAME_ENV` (`prod`, `stage`, `stand`; нет
её — `dev`). Юниты прода и стейджа — у minipc (`deploy/itgame/systemd/`),
стенд :15555 — у нас. QA-серверы `selfServe` наследованный `DATABASE_URL`
сбрасывают (ITGAME-182) — в базу не пишут. `make sim` идёт мимо актора —
тоже не пишет, это поле ITGAME-126.

**Боты.** load-bots ходят на `/ws` без `?client=` и считаются `desktop`.
Чтобы не мешать их со стейджевыми людьми, им — `?client=bot`, а в
`clientKinds` — вид `bot` (заодно и в метке Prometheus).

## Запросы под вопросы

Аналитика — только `env = 'prod' AND NOT debug AND scenario = ''`.

```sql
-- 1. Где проигрывают: день и причина по сложности
SELECT difficulty, lose_reason, day, count(*)
FROM parties WHERE outcome = 'lost' AND env = 'prod' AND NOT debug AND scenario = ''
GROUP BY 1, 2, 3 ORDER BY 1, 2, 3;

-- 2. На каком дне бросают: «Сдаться» и тихий уход
SELECT status, day, count(*)
FROM party_status WHERE status IN ('abandon', 'dropped') AND env = 'prod' AND NOT debug
GROUP BY 1, 2 ORDER BY 1, 2;

-- 3. Три дня перед проигрышем
SELECT p.id, d.day, d.balance, d.income, d.payroll, d.staff, d.pcs
FROM parties p JOIN party_days d ON d.party_id = p.id
WHERE p.outcome = 'lost' AND d.day > p.day - 3 AND p.env = 'prod' AND NOT p.debug
ORDER BY p.id, d.day;
```

Читать их агенту — через MCP `itd-db` (только чтение) на стенде; на проде
доступ к базе — отдельный вопрос minipc.

## Объём

Книга дня — порядка нескольких килобайт (покупки сверх потолка сворачиваются
в сводную строку). Пятьдесят игроков по партии в день — сотни строк
`party_days` в день, мегабайты в месяц. Чистка сейчас не нужна; замерить на
стейдже прогоном 50 ботов (ITGAME-193) до прода.

## Мета-прогресс (ITGAME-132)

`player` — хэш `sid`, то есть браузер: регистрации нет. Достижения и рекорд
считаются сервером по `parties` и `party_days` этого `player`; своя таблица
`player_meta` — в ITGAME-132.

## Порядок работ после согласования

1. Миграция `0003_parties.sql`, писатель с буфером и метрикой потерь, точки в
   акторе, `PartyID` в сейве, `ITGAME_ENV`; тесты на `TEST_DATABASE_URL`.
2. Задача minipc: `ITGAME_ENV` в юнитах прода и стейджа.
3. `?client=bot` у load-bots.
4. Запросы — в `docs/development.md`, раздел «Database».

## Решить владельцу

1. Сырой `sid` не храним, только `sha256` — годится?
2. Брошенная = без исхода и без возврата дольше TTL сейва (24 ч) — или свой порог?
3. Книга дня в `jsonb` целиком — или только пять колонок без `ledger`?
4. Партии с debug-правкой писать с флагом `debug` — или не писать вовсе?
