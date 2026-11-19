-- Erden CLI anonymous telemetry (D1 database erden-telemetry).
--
-- What the CLI sends is documented in docs/telemetry.md, and this schema stores exactly that, split so that no install
-- ID is kept for long: command runs are rolled up with no install ID, and the install IDs seen each day are kept 35
-- days, only to count distinct installs, whose daily, 7-day and 30-day counts are then kept with no ID. The Worker adds
-- the coarse country Cloudflare derives from the client's IP address; the address itself is never stored. Times are UTC
-- days, not instants. No account, file path, project name, IRI, argument, username, hostname or error message is ever
-- sent or stored.

-- Command runs per UTC day, with no install ID. Deleted after 730 days.
CREATE TABLE IF NOT EXISTS command_runs (
    day          TEXT NOT NULL,      -- UTC day, YYYY-MM-DD
    command      TEXT NOT NULL,      -- the command's fixed name, for example check or store status
    outcome      TEXT NOT NULL,      -- success | failure | usage-error | operational-error | crash
    version      TEXT NOT NULL,      -- CLI version, for example 0.1.0 or 0.2.0-rc.1
    channel      TEXT NOT NULL,      -- stable | canary
    os           TEXT NOT NULL,      -- linux | darwin | win32
    arch         TEXT NOT NULL,      -- x64 | arm64
    country      TEXT NOT NULL DEFAULT '',  -- two-letter country from Cloudflare, '' if unknown
    runs         INTEGER NOT NULL,   -- how many runs this row counts
    duration_ms  INTEGER NOT NULL,   -- their total duration, in milliseconds
    max_ms       INTEGER NOT NULL,   -- the longest of them, in milliseconds
    PRIMARY KEY (day, command, outcome, version, channel, os, arch, country)
);

-- Which install IDs sent an event on which UTC day, and nothing else. Deleted after 35 days.
CREATE TABLE IF NOT EXISTS active_installs (
    day          TEXT NOT NULL,      -- UTC day, YYYY-MM-DD
    install_id   TEXT NOT NULL,      -- the random UUID v4 the CLI made on its first run
    PRIMARY KEY (day, install_id)
);

-- Distinct installs per day, over the 7 and 30 days ending that day, with no install ID. Deleted after 730 days.
CREATE TABLE IF NOT EXISTS active_totals (
    day          TEXT PRIMARY KEY,   -- UTC day, YYYY-MM-DD
    daily        INTEGER NOT NULL,
    weekly       INTEGER NOT NULL,
    monthly      INTEGER NOT NULL
);
