-- Cache for AI-generated file summaries. Keyed by (project, path); invalidated
-- when the file's mtime changes. Size cap on contents lives at the API layer,
-- not here.

CREATE TABLE file_summaries (
    project_name  TEXT NOT NULL,
    path          TEXT NOT NULL,
    file_mtime    REAL NOT NULL,
    summary       TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    PRIMARY KEY (project_name, path)
);
