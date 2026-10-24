-- Живые партии для аналитики (ITGAME-237/239, docs/design/party-analytics.md).
-- Пишет internal/partylog из актора сессии; игра от этих таблиц не зависит.
CREATE TABLE IF NOT EXISTS parties (
    id            bigserial PRIMARY KEY,
    sid_hash      text NOT NULL,               -- sha256(sid) hex; сырой sid — ключ сейва, не храним
    n             int  NOT NULL,               -- 1, 2, … — партии одного sid по рестартам
    partial       bool NOT NULL DEFAULT false, -- старт не записан: строку завело позднее событие
    build         text NOT NULL,
    difficulty    text NOT NULL,
    scenario      text NOT NULL DEFAULT '',
    seed          text NOT NULL,
    client        text NOT NULL,               -- desktop | mobile | unknown | agent
    started_at    timestamptz NOT NULL,
    last_seen_at  timestamptz NOT NULL,
    expires_at    timestamptz NOT NULL,        -- последний сейв + TTL сейва
    ended_at      timestamptz,
    outcome       text,                        -- NULL | victory | lost | abandon | reset
    lose_reason   text,                        -- при lost: bankrupt | time_up | deadlock
    day           int    NOT NULL DEFAULT 1,
    money         bigint NOT NULL DEFAULT 0,
    sessions      int    NOT NULL DEFAULT 1,
    ended_offline bool   NOT NULL DEFAULT false,
    debug         bool   NOT NULL DEFAULT false,
    UNIQUE (sid_hash, n)
);
CREATE INDEX IF NOT EXISTS parties_started ON parties (started_at);

CREATE TABLE IF NOT EXISTS party_days (
    party_id   bigint NOT NULL REFERENCES parties (id) ON DELETE CASCADE,
    day        int    NOT NULL,
    closed_at  timestamptz NOT NULL,
    offline    bool   NOT NULL,
    balance    bigint NOT NULL,
    income     bigint NOT NULL,
    payroll    bigint NOT NULL,
    staff      int    NOT NULL,
    offices    int    NOT NULL,
    pcs        int    NOT NULL,
    ledger     jsonb  NOT NULL,
    PRIMARY KEY (party_id, day)
);

CREATE TABLE IF NOT EXISTS party_choices (
    party_id   bigint NOT NULL REFERENCES parties (id) ON DELETE CASCADE,
    day        int  NOT NULL,
    tick       int  NOT NULL,
    event      text NOT NULL,
    choice     int  NOT NULL,                  -- выбранная опция; -1 — проигнорировано до вечера
    at         timestamptz NOT NULL,
    PRIMARY KEY (party_id, day, tick, event)
);

CREATE OR REPLACE VIEW party_status AS
SELECT p.*,
       CASE WHEN p.outcome IS NOT NULL THEN p.outcome
            WHEN p.expires_at < now() THEN 'dropped'
            ELSE 'running' END AS status
FROM parties p;
