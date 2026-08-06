-- Rebuildable application index/cache. Markdown in Git remains canonical.
CREATE TABLE IF NOT EXISTS migrations (
    migration_number INTEGER PRIMARY KEY,
    migration_name TEXT NOT NULL,
    executed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS song_index (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    normalized_title TEXT NOT NULL,
    source_hash TEXT NOT NULL,
    rendered_html TEXT NOT NULL,
    indexed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS song_index_normalized_title
ON song_index(normalized_title);

CREATE TABLE IF NOT EXISTS set_index (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    event_date TEXT NOT NULL DEFAULT '',
    location TEXT NOT NULL DEFAULT '',
    source_hash TEXT NOT NULL,
    indexed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO migrations (migration_number, migration_name)
VALUES (001, '001-base');
