-- Migration 0001: Create routes table
CREATE TABLE IF NOT EXISTS routes (
  slug TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('redirect', 'page')),
  target TEXT NOT NULL,
  status_code INTEGER NOT NULL DEFAULT 301 CHECK (status_code IN (301, 302)),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  track_hits INTEGER NOT NULL DEFAULT 0 CHECK (track_hits IN (0, 1)),
  hits INTEGER NOT NULL DEFAULT 0,
  last_hit_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_routes_active ON routes (active);
