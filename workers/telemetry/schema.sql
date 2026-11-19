-- Erden CLI anonymous telemetry (D1 database erden-telemetry).
--
-- What the CLI sends is documented in docs/telemetry.md, and this schema stores exactly that: a random install ID, the
-- CLI's version, release channel, OS and CPU architecture, and per command the command's name, its outcome category,
-- how many times it ran and how long it took. The Worker adds the coarse country Cloudflare derives from the client's
-- IP address; the address itself is never stored. Times are UTC days, not instants. No account, file path, project
-- name, IRI, argument, username, hostname or error message is ever sent or stored.
--
-- Rows older than 730 days are deleted by the Worker's daily scheduled run.

-- One row per install ID: first and last day it reported, and what it last reported.
CREATE TABLE IF NOT EXISTS installs (
    id         TEXT PRIMARY KEY,   -- random UUID v4 the CLI made on first run
    first_day  TEXT NOT NULL,      -- UTC day of the first event, YYYY-MM-DD
    last_day   TEXT NOT NULL,      -- UTC day of the latest event
    version    TEXT NOT NULL,      -- CLI version, for example 0.1.0 or 0.2.0-rc.1
    channel    TEXT NOT NULL,      -- stable | canary
    os         TEXT NOT NULL,      -- linux | darwin | win32
    arch       TEXT NOT NULL,      -- x64 | arm64
    country    TEXT NOT NULL DEFAULT ''  -- two-letter country from Cloudflare, '' if unknown
);

CREATE INDEX IF NOT EXISTS installs_last_day ON installs (last_day);

-- Command runs, rolled up per UTC day, install and command, so the table stays small.
CREATE TABLE IF NOT EXISTS command_runs (
    day          TEXT NOT NULL,      -- UTC day, YYYY-MM-DD
    install_id   TEXT NOT NULL,      -- installs.id
    command      TEXT NOT NULL,      -- the command's fixed name, for example check or store status
    outcome      TEXT NOT NULL,      -- success | failure | usage-error | operational-error | crash
    version      TEXT NOT NULL,
    channel      TEXT NOT NULL,
    os           TEXT NOT NULL,
    arch         TEXT NOT NULL,
    country      TEXT NOT NULL DEFAULT '',
    runs         INTEGER NOT NULL,   -- how many runs this row counts
    duration_ms  INTEGER NOT NULL,   -- their total duration, in milliseconds
    max_ms       INTEGER NOT NULL,   -- the longest of them, in milliseconds
    PRIMARY KEY (day, install_id, command, outcome, version, channel, os, arch, country)
);

CREATE INDEX IF NOT EXISTS command_runs_day ON command_runs (day);
