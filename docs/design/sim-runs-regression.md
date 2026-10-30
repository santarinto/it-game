# Прогоны в PostgreSQL с авторегрессией — предложение схемы (ITGAME-126)

**Статус: предложение схемы и правил авторегрессии на согласование владельцу (ITGAME-126)**  
Связанные документы:
- [`docs/design/auto-gaming.md`](auto-gaming.md) — ретроспектива и инвентарь инструментов headless-игры (`ITGAME-206`).
- [`docs/design/party-analytics.md`](party-analytics.md) — живые партии со стенда и прода (`ITGAME-237` / `ITGAME-239`, миграция `0003_parties.sql`).
- [`docs/development.md`](../development.md) — секции `sim`, `Load test` и `Database`.

---

## 1. Вопросы, на которые отвечаем

1. **Не сломал ли свежий коммит экономический баланс?**
   - Например: *«После коммита X политика `greedy` на Норме стала беднее на 20% к 30-му дню»* или *«На Норме внезапно появились банкротства у жадной стратегии, где исторически был 0%»*.
2. **Как распределены исходы и метрики выживания по сидам?**
   - Какова медиана денег, 25-й и 75-й перцентили, какова доля ранних банкротств (дни $\le 7$) при первом аудите?
3. **Не деградировали ли прогоны реальных WebSocket-ботов на стейдже?**
   - Сравнение билдов `stage` между собой по доле побед и доживаемости ботов `load-bots.mjs`.
4. **Укладываются ли сценарии-фикстуры в эталонный коридор?**
   - Прогон фиксированных состояний (`server/internal/game/fixtures/*.json`) без ручного разбора логов.

Метрики Prometheus/Grafana (`ITGAME-189`) остаются как есть — они считают общие счётчики соединений и команд в реальном времени. В PostgreSQL идут структурированные результаты симуляций для глубокого сравнительного анализа между коммитами.

---

## 2. Разделение источников: почему не писать sim в `parties`

В `ITGAME-239` создана таблица `parties` (`0003_parties.sql`). В неё пишутся живые сессии игроков и сессии ботов `load-bots.mjs` по WebSocket:
- Каждая запись привязана к `sid_hash`, держит `expires_at`, токены сессии, `jsonb`-книгу дня и тики.
- `make sim` (`server/cmd/sim`) работает принципиально иначе: это чистый Go-движок, прогоняющий **10 000 дней в секунду** (300 сидов $\times$ 30 дней за секунды) без вебсокетов, сессий и задержек.

Попытка писать сотни тысяч синтетических тиков `sim` в `parties` приведет к:
1. Засорению аналитики реальных игроков и искажению метрик удержания.
2. Неоправданному раздутию таблиц `parties` и `party_days` (миллионы строк при каждом локальном подборе параметров баланса).
3. Потере группировки: `make sim` запускается **батчем** (набором сидов, политик и флагов под одним коммитом), и сравнивать нужно **батч с батчем**, а не отдельные разрозненные партии.

**Решение**:
- Для `make sim` и QA-фикстур создаются компактные таблицы `sim_batches` и `sim_runs` (миграция `0004_sim_runs.sql`).
- Для `load-bots.mjs` используется уже существующая таблица `parties` с фильтром `client = 'bot'` и строится агрегированное представление `bot_batch_summaries` по билдам.

---

## 3. Схема данных (предложение миграции `0004_sim_runs.sql`)

```sql
-- Батч запуска sim или набора фикстур
CREATE TABLE IF NOT EXISTS sim_batches (
    id            bigserial PRIMARY KEY,
    batch_uuid    text NOT NULL UNIQUE,          -- UUID запуска (клиентский или gen_random_uuid())
    git_commit    text NOT NULL,                 -- короткий sha (git rev-parse --short HEAD) или BuildVersion
    git_branch    text NOT NULL DEFAULT '',      -- ветка (main, feature/...)
    created_at    timestamptz NOT NULL DEFAULT now(),
    source        text NOT NULL,                 -- 'sim' | 'qa_fixture' | 'cli'
    difficulty    text NOT NULL,                 -- easy | normal | hard | hardcore
    scenario      text NOT NULL DEFAULT '',      -- '' для стандартной игры, имя фикстуры для сценариев
    days_limit    int  NOT NULL,                 -- запрошенное число дней (обычно 30 или 60)
    seeds_count   int  NOT NULL,                 -- число сидов в батче
    policies      text[] NOT NULL,               -- массив запущенных политик, e.g. {'greedy','idle','random'}
    params        jsonb NOT NULL DEFAULT '{}',   -- флаги запуска: audit_share, answer_raise, answer_leave и т.д.
    label         text NOT NULL DEFAULT '',      -- опциональный тег: 'baseline-v1', 'pre-release', 'test-nerf'
    is_baseline   bool NOT NULL DEFAULT false    -- эталонный батч для автосравнения в этой категории
);
CREATE INDEX IF NOT EXISTS sim_batches_lookup ON sim_batches (difficulty, scenario, git_commit, created_at DESC);
CREATE INDEX IF NOT EXISTS sim_batches_baseline ON sim_batches (difficulty, scenario, is_baseline) WHERE is_baseline = true;

-- Итог каждой симулированной партии внутри батча (одна строка на сид/политику)
CREATE TABLE IF NOT EXISTS sim_runs (
    id            bigserial PRIMARY KEY,
    batch_id      bigint NOT NULL REFERENCES sim_batches (id) ON DELETE CASCADE,
    policy        text NOT NULL,                 -- greedy | idle | random | handsoff | delegate | expand
    seed          bigint NOT NULL,               -- сид генератора
    scenario      text NOT NULL DEFAULT '',      -- '' для стандартной игры, имя фикстуры для сценариев
    outcome       text NOT NULL,                 -- victory | bankrupt | time_up | deadlock | timeout
    days_survived int  NOT NULL,                 -- на каком дне завершилась партия
    final_money   bigint NOT NULL,               -- итоговый баланс (или баланс на момент гибели)
    final_income  bigint NOT NULL,               -- суточный доход
    final_payroll bigint NOT NULL,               -- суточный ФОТ + шлюз
    final_staff   int  NOT NULL,                 -- число сотрудников
    final_offices int  NOT NULL,                 -- число купленных офисов
    final_pcs     int  NOT NULL,                 -- число рабочих ПК
    events_count  int  NOT NULL DEFAULT 0,       -- суммарное число выпавших событий
    audit_failed  bool NOT NULL DEFAULT false,   -- был ли за партию провален аудит
    UNIQUE (batch_id, policy, seed, scenario)
);
CREATE INDEX IF NOT EXISTS sim_runs_batch_policy ON sim_runs (batch_id, policy);

-- Агрегированная сводка батча: ключевые статистические метрики
CREATE OR REPLACE VIEW sim_batch_summaries AS
SELECT
    b.id AS batch_id,
    b.batch_uuid,
    b.git_commit,
    b.git_branch,
    b.created_at,
    b.difficulty,
    b.scenario,
    b.days_limit,
    b.label,
    b.is_baseline,
    r.policy,
    count(*) AS total_runs,
    count(*) FILTER (WHERE r.outcome = 'victory')  AS victory_count,
    count(*) FILTER (WHERE r.outcome = 'bankrupt') AS bankrupt_count,
    count(*) FILTER (WHERE r.outcome = 'timeout')  AS timeout_count,
    count(*) FILTER (WHERE r.outcome = 'deadlock') AS deadlock_count,
    -- Проценты исходов
    round(100.0 * count(*) FILTER (WHERE r.outcome = 'victory') / count(*), 1)  AS victory_pct,
    round(100.0 * count(*) FILTER (WHERE r.outcome = 'bankrupt') / count(*), 1) AS bankrupt_pct,
    -- Ранняя смертность (до 7-го дня включительно, ключевой маркер жесткости первого аудита)
    round(100.0 * count(*) FILTER (WHERE r.outcome = 'bankrupt' AND r.days_survived <= 7) / count(*), 1) AS early_bankrupt_pct,
    -- Медианы и квартили по деньгам
    round(percentile_cont(0.50) WITHIN GROUP (ORDER BY r.final_money))::bigint AS median_money,
    round(percentile_cont(0.25) WITHIN GROUP (ORDER BY r.final_money))::bigint AS p25_money,
    round(percentile_cont(0.75) WITHIN GROUP (ORDER BY r.final_money))::bigint AS p75_money,
    -- Медиана дней выживания
    round(percentile_cont(0.50) WITHIN GROUP (ORDER BY r.days_survived))::int  AS median_days,
    -- Средний доход и штат к концу партии
    round(avg(r.final_income))::bigint  AS avg_income,
    round(avg(r.final_payroll))::bigint AS avg_payroll,
    round(avg(r.final_staff), 1)        AS avg_staff
FROM sim_batches b
JOIN sim_runs r ON r.batch_id = b.id
GROUP BY b.id, r.policy, b.scenario;

-- Сводка для load-bots поверх существующей таблицы parties (с расчетом долей от завершенных партий)
CREATE OR REPLACE VIEW bot_batch_summaries AS
SELECT
    build,
    difficulty,
    count(*) AS total_parties,
    count(*) FILTER (WHERE outcome IS NOT NULL) AS finished_parties,
    count(*) FILTER (WHERE outcome = 'victory') AS victory_count,
    count(*) FILTER (WHERE outcome = 'lost' AND lose_reason = 'bankrupt') AS bankrupt_count,
    round(100.0 * count(*) FILTER (WHERE outcome = 'lost' AND lose_reason = 'bankrupt') /
          nullif(count(*) FILTER (WHERE outcome IS NOT NULL), 0), 1) AS bankrupt_pct,
    round(percentile_cont(0.50) WITHIN GROUP (ORDER BY money))::bigint AS median_money,
    round(percentile_cont(0.50) WITHIN GROUP (ORDER BY day))::int      AS median_day,
    min(started_at) AS first_seen,
    max(last_seen_at) AS last_seen
FROM parties
WHERE client = 'bot' AND NOT debug
GROUP BY build, difficulty;
```

---

## 4. Правила сравнения с историей и детекция регрессий

### 4.1 Выбор базы сравнения (Baseline)
При сравнении текущего прогона (Target) baseline выбирается по строгому совпадению `(difficulty, scenario, days_limit)`:
1. **Явный эталон**: самый свежий батч с `is_baseline = true`, той же сложностью, сценарием и лимитом дней:
   ```sql
   SELECT id FROM sim_batches
   WHERE difficulty = $diff AND scenario = $scenario AND days_limit = $days AND is_baseline = true
   ORDER BY created_at DESC LIMIT 1;
   ```
2. **Предыдущий коммит в ветке `main`**: последний батч на ветке `main` с теми же параметрами, созданный ранее текущего.
3. **Непосредственно предшествующий батч**: предыдущий прогон с идентичными параметрами `(difficulty, scenario, days_limit, seeds_count)`.

### 4.2 Пороги регрессии (Health Checks)

> **Требование к объёму выборки**: Для надёжной проверки порогов регрессии размер батча должен составлять $N \ge 100$ сидов. На малых выборках ($N \le 20$) исход одного случайного сида даёт скачок $+5.0\%$, вызывая ложные срабатывания.

Сравнение производится по каждой паре `(difficulty, policy)`:

| Метрика | Эталонное поведение | Порог регрессии (FAIL) | Предупреждение (WARN) |
|---|---|---|---|
| **Банкротства на `normal` для `greedy` / `delegate`** | Исторически 0.0% | $> 0.0\%$ (хотя бы 1 банкротство из 100) | — |
| **Банкротства на `hard` для `greedy`** | $\le 5.0\%$ | Рост $> +5.0\%$ от базы | Рост $+2.0\% .. +5.0\%$ |
| **Ранняя смертность (`early_bankrupt_pct`, день $\le 7$)** | $\approx 0\%$ на Норме | Любой рост $> +3.0\%$ | Любой рост $> +1.5\%$ |
| **Медианный капитал (`median_money`)** | Зависит от сложности | Падение $> 15.0\%$ от базы | Падение $7.0\% .. 15.0\%$ |
| **Устойчивость к хаосу (`random` на `normal`)** | Медиана $\sim 1$–$4$ дня | Падение медианы $> 1.0$ дня | Падение медианы $> 0.5$ дня |
| **Выживаемость бездействия на фикстуре (`idle` на `admin_dept`)** | Смерть от ФОТ за $K$ дней | Ускорение банкротства $> 1$ дня | Любое ускорение |
| **Доля побед на `easy` для `greedy`** | $100\%$ | Снижение $< 98.0\%$ | Снижение $< 100.0\%$ |

*Примечание о политике `idle` на чистом старте*: при нулевом штате, отсутствии ПК и нулевом ФОТ чистый `idle` не расходует средства и доживает до 30-го дня со $100\%$ исходом `timeout` (на normal) или `time_up` (на hardcore). Поэтому проверка выживаемости бездействия осмысленна именно для сценариев с преднастроенными расходами (`scenario != ''`).

### 4.3 Формулы дельт
$$\Delta_{\text{bankrupt}} = \text{Current.bankrupt\_pct} - \text{Base.bankrupt\_pct}$$
$$\text{Ratio}_{\text{money}} = \frac{\text{Current.median\_money} - \text{Base.median\_money}}{\max(1, |\text{Base.median\_money}|)}$$

- Если $\Delta_{\text{bankrupt}} > \text{Threshold}_{\text{bankrupt}} \implies$ **`FAIL: REGRESSION`**
- Если $\text{Ratio}_{\text{money}} < -0.15 \implies$ **`FAIL: REGRESSION (Economy Nerf)`**
- Если $\text{Ratio}_{\text{money}} > +0.35 \implies$ **`WARN: Economy Inflation`** (игра стала подозрительно легкой).

---

## 5. Как это выглядит для агента и разработчика в CLI

### 5.1 Запуск `sim` с записью в БД
Добавление флага `--db` (или автоматическая запись при наличии `DATABASE_URL`):
```bash
make sim ARGS="--diff normal --seed 1..100 --days 30 --policy greedy,delegate --db"
```
Команда выводит стандартную сводку, сохраняет батч в PostgreSQL и печатает UUID батча:
```
sim: normal, сидов 200, дней 30 — исходы: greedy/timeout=100, delegate/timeout=100
sim db: сохранён батч 3b8f1a2c (commit 07dc7e2, seeds 1..100, policies greedy,delegate)
```

### 5.2 Запуск авторегрессионного чека одной командой
```bash
make sim-check ARGS="--diff normal --policy greedy --seed 1..100 --days 30"
```
Утилита прогоняет симуляцию, сравнивает текущий батч с эталоном из базы и выводит наглядный отчёт:

```
=== SIM REGRESSION REPORT (Commit: 07dc7e2 vs Baseline: 0228fbb) ===
Difficulty: normal | Days: 30 | Seeds: 100

Policy: greedy
  Metric              Baseline        Current         Delta       Status
  ----------------------------------------------------------------------
  Bankruptcies        0.0% (0/100)    0.0% (0/100)    +0.0%       OK
  Early Bankrupt (≤7) 0.0% (0/100)    0.0% (0/100)    +0.0%       OK
  Median Money        $42,850         $34,100         -20.4%      FAIL [Nerf > 15%]
  Median Days         30              30              0           OK
  Avg Staff           10.0            9.2             -0.8        WARN

Verdict: 1 REGRESSION DETECTED! Exit code 1.
```
Если есть `FAIL`, утилита выходит с кодом `1`. Это позволяет включать `make sim-check` в CI или проверять баланс перед коммитом!

### 5.3 Проверка сценариев-фикстур
Для фикстур (`server/internal/game/fixtures/*.json`):
```bash
make sim-check ARGS="--scenario admin_dept --days 10"
```
Сверяет, что преднастроенный офис с админами стабильно выживает N дней и держит запланированный уровень выручки.

---

## 6. Объём данных и политика хранения

- **Размер записей**:
  - `sim_batches`: 1 строка на весь запуск (~500 байт).
  - `sim_runs`: 1 строка на сид $\times$ политику (~150 байт). Прогон 100 сидов $\times$ 3 политики = 300 строк (~45 КБ).
  - Даже при 50 тестовых прогонах в день за месяц накопится всего $\sim 65$ МБ данных.
- **Политика ротации**:
  - Строки батчей с флагом `is_baseline = true` или имеющие `label != ''` хранятся **бессрочно**.
  - Обычные промежуточные прогоны `sim_runs` без тегов очищаются через **30 дней** (cron или фоновая задача на стейдже).
  - Партии ботов `parties WHERE client = 'bot'` на стейдже очищаются через **14 дней** (как было запланировано в `party-analytics.md`).

---

## 7. Вопросы для согласования с владельцем (Decision Points)

1. **Где хранить baseline (эталон)?**
   - *Вариант А (рекомендуемый)*: В таблице `sim_batches` с флагом `is_baseline = true`, который выставляется специальной командой `make sim-baseline` при фиксации релизного баланса.
   - *Вариант Б*: Брать автоматически последний успешный прогон из ветки `main`.
2. **Нужна ли запись каждого дня симуляции (`sim_run_days`)?**
   - *Рекомендация*: **Нет, не нужна**. Детальные дни нужны только для живых партий в `party_days`. В симуляторе исход на любом сиде детерминирован и воспроизводим за 1 мс. Хранение только финальных показателей сида в `sim_runs` сэкономит 97% дискового пространства и сделает аналитические запросы мгновенными.
3. **Поведение `make sim` по умолчанию**:
   - Писать в БД только при явном флаге `--db` (чтобы локальные быстрые проверки разработчика без запущенного Postgres не спотыкались), либо автоматически, если определена переменная `DATABASE_URL`?
