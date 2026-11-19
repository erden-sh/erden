-- Erden release downloads and update checks (D1 database erden-releases).
--
-- Both tables are per-day rollups with no identifier of any kind, like PaceBar's update-check log: which release,
-- channel, asset, OS and CPU architecture was fetched or asked about, and the coarse country Cloudflare derives from the
-- client's IP address. The address, the User-Agent and every other header are never stored. Requests that carry the
-- X-Erden-CI header (Erden's own CI) are not counted. docs/telemetry.md describes it publicly.
--
-- Rows older than 730 days are deleted by the Worker's daily scheduled run.

-- Downloads through erden.sh/install* and erden.sh/download/*, each redirected to the GitHub release asset.
CREATE TABLE IF NOT EXISTS downloads (
    day      TEXT NOT NULL,              -- UTC day, YYYY-MM-DD
    channel  TEXT NOT NULL,              -- stable | canary | pinned (an exact version was asked for)
    version  TEXT NOT NULL,              -- a published release's version, for example 0.1.0, or other
    asset    TEXT NOT NULL,              -- archive | install.sh | install.ps1 | SHA256SUMS
    os       TEXT NOT NULL DEFAULT '',   -- linux | darwin | win32: an archive's platform, or the CLI's; '' if unknown
    arch     TEXT NOT NULL DEFAULT '',   -- x64 | arm64, the same way
    client   TEXT NOT NULL,              -- cli (erden upgrade) | script (an install script) | other
    country  TEXT NOT NULL DEFAULT '',   -- two-letter country from Cloudflare, '' if unknown
    hits     INTEGER NOT NULL,
    PRIMARY KEY (day, channel, version, asset, os, arch, client, country)
);

-- Update checks from a CLI with telemetry on (/updates/<channel>/<os>/<arch>/<version>). /updates/<channel>, which a
-- CLI with telemetry off asks, is never counted.
CREATE TABLE IF NOT EXISTS update_checks (
    day      TEXT NOT NULL,              -- UTC day, YYYY-MM-DD
    channel  TEXT NOT NULL,              -- stable | canary
    os       TEXT NOT NULL,              -- linux | darwin | win32
    arch     TEXT NOT NULL,              -- x64 | arm64
    version  TEXT NOT NULL,              -- the asking CLI's version if a release has it, else other
    country  TEXT NOT NULL DEFAULT '',
    hits     INTEGER NOT NULL,
    PRIMARY KEY (day, channel, os, arch, version, country)
);

-- The last good release list from the GitHub API (one row), served when GitHub cannot answer. Public data only.
CREATE TABLE IF NOT EXISTS release_index (
    id          INTEGER PRIMARY KEY CHECK (id = 1),
    fetched_at  TEXT NOT NULL,       -- when it was fetched, ISO 8601
    releases    TEXT NOT NULL        -- JSON: tag, version, publishedAt and asset names of each published release
);
