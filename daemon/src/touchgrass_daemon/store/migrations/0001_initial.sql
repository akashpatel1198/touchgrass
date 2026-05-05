-- Initial schema for the touchgrass session store.
-- Migrations are applied in filename order; never edit a migration after it ships —
-- add a new one instead.

CREATE TABLE schema_version (
    version INTEGER NOT NULL
);
INSERT INTO schema_version (version) VALUES (1);

CREATE TABLE sessions (
    id            TEXT PRIMARY KEY,
    project_name  TEXT NOT NULL,
    goal          TEXT,
    status        TEXT NOT NULL CHECK (status IN (
                      'active',
                      'waiting_permission',
                      'completed',
                      'failed'
                  )),
    created_at    TEXT NOT NULL  -- ISO 8601 UTC
);
CREATE INDEX idx_sessions_project_name ON sessions(project_name);
CREATE INDEX idx_sessions_status ON sessions(status);

CREATE TABLE messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    role        TEXT NOT NULL CHECK (role IN (
                    'user',
                    'assistant',
                    'tool_call',
                    'tool_result'
                )),
    content     TEXT NOT NULL,
    tool_name   TEXT,
    tool_args   TEXT,            -- JSON-encoded
    created_at  TEXT NOT NULL    -- ISO 8601 UTC
);
CREATE INDEX idx_messages_session ON messages(session_id, id);

CREATE TABLE permission_requests (
    id           TEXT PRIMARY KEY,
    session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    tool_name    TEXT NOT NULL,
    tool_args    TEXT NOT NULL,  -- JSON-encoded
    status       TEXT NOT NULL CHECK (status IN (
                     'pending',
                     'allowed_once',
                     'allowed_project',
                     'denied'
                 )),
    created_at   TEXT NOT NULL,
    resolved_at  TEXT
);
CREATE INDEX idx_permission_requests_session ON permission_requests(session_id);
CREATE INDEX idx_permission_requests_status ON permission_requests(status);
