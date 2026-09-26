CREATE TABLE IF NOT EXISTS lib_equipment (
    id serial PRIMARY KEY,
    name text NOT NULL,
    locale_token text NOT NULL UNIQUE
);
