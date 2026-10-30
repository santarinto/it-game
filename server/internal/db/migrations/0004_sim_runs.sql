-- Батч запуска sim или набора фикстур (ITGAME-126, ITGAME-244)
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
CREATE INDEX IF NOT EXISTS sim_batches_lookup ON sim_batches (difficulty, scenario, days_limit, created_at DESC);
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
