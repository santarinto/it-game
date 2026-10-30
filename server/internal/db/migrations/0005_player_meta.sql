-- Миграция 0005_player_meta.sql: мета-прогресс и достижения игроков (ITGAME-132, ITGAME-245)

-- 1. Добавление ссылки на игрока в таблицу parties
ALTER TABLE parties ADD COLUMN IF NOT EXISTS player text NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS parties_player ON parties (player) WHERE player <> '';

-- 2. Пересоздание представления party_status (включение новой колонки player)
DROP VIEW IF EXISTS party_status;
CREATE VIEW party_status AS
SELECT p.*,
       CASE WHEN p.outcome IS NOT NULL THEN p.outcome
            WHEN p.expires_at < now() THEN 'dropped'
            ELSE 'running' END AS status
FROM parties p;

-- 3. Таблица мета-прогресса игрока: агрегаты и ачивки
CREATE TABLE IF NOT EXISTS player_meta (
    player        text PRIMARY KEY,             -- стабильный player_id из localStorage (p_<uuid>)
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    total_runs    int    NOT NULL DEFAULT 0,    -- число завершённых партий
    total_wins    int    NOT NULL DEFAULT 0,    -- число побед
    total_losses  int    NOT NULL DEFAULT 0,    -- число поражений
    peak_balance  bigint NOT NULL DEFAULT 0,    -- максимальный баланс за всю историю
    peak_day      int    NOT NULL DEFAULT 0,    -- максимальный день выживания
    stats         jsonb  NOT NULL DEFAULT '{}', -- детальная статистика по сложностям (зеркало MetaStats.byDifficulty)
    achievements  jsonb  NOT NULL DEFAULT '{}'  -- полученные достижения (зеркало Record<string, AchievementState>)
);

CREATE INDEX IF NOT EXISTS player_meta_updated ON player_meta (updated_at DESC);
