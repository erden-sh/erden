# Telemetry, update checks and downloads

The Erden CLI sends a small amount of anonymous data to Erden, and the erden.sh download links count downloads. This
page lists all of it. The code that sends it is in [`apps/cli/src`](../apps/cli/src) (`telemetry.ts`, `session.ts`,
`updates.ts`, `background.ts`, `upgrade.ts`), and the code that receives and stores it is in [`workers/`](../workers),
with each database's schema in its `schema.sql`. Both are open source, so you can check this page against them.

Everything goes to Erden's own Cloudflare Workers. The telemetry Worker also forwards each usage event it stores,
without the install ID or anything from your connection, to Erden's PostHog project ([below](#forwarding-to-posthog)).
There is no advertising and no sharing or selling of the data. Ingenio Ventures Inc runs these services.

## Usage telemetry

Telemetry is **on by default** in release builds and easy to turn off. The first time you run `erden`, it prints a
notice on standard error that says what it collects and how to turn it off, and **that run sends nothing at all**: no
event and no update check. Later runs each queue one event when the command finishes, and a background process sends
the queue.

### What one event holds

| Field        | Example                                | What it is                                                                                                                       |
| ------------ | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `installId`  | `3b241101-e2bb-4255-8caf-4136c566a962` | a random ID (UUID v4) made on your machine on the first run; it is not derived from anything                                     |
| `command`    | `check`, `store status`                | the command's name, from a fixed list; anything else is sent as `unknown`                                                        |
| `outcome`    | `success`                              | `success`, `failure`, `usage-error`, `operational-error` or `crash`, from the exit code (a partial answer, exit 4, is `success`) |
| `durationMs` | `812`                                  | how long the command took, in whole milliseconds                                                                                 |
| `version`    | `0.1.0`                                | the CLI's version                                                                                                                |
| `channel`    | `stable`                               | `stable` or `canary`                                                                                                             |
| `os`         | `linux`                                | `linux`, `darwin` or `win32`                                                                                                     |
| `arch`       | `x64`                                  | `x64` or `arm64`                                                                                                                 |

That is the whole event (plus a `schema` field naming its format). It **never** includes file or directory paths,
project or package names, aliases, IRIs, command arguments or flags, query text, registry addresses, error messages,
your username, hostname or IP address, or anything about your account. The telemetry Worker refuses any event that is
not exactly this, including a command name that is not on its fixed list.

### What is stored, and for how long

When an event arrives, the telemetry Worker adds the **country** Cloudflare derives from the connection (a two-letter
code such as `DE`) and the **UTC day** it arrived, and stores:

- **Command runs, without the install ID**: per day, command, outcome, version, channel, OS, architecture and country,
  the number of runs and their total and longest duration. Kept **730 days**.
- **Which install IDs were active on which day**, and nothing else with them, only to count distinct installs. Kept
  **35 days**, then deleted.
- **Distinct install counts, without any ID**: per day, how many installs were active that day, in the 7 days and in
  the 30 days ending that day, computed each night from the list above. Kept **730 days**.

Your IP address is not stored. To limit how many events one sender can post (120 a minute), the Worker passes the
connection's IP address to Cloudflare's rate limiter, which uses it in memory for that request only; it is never written
to the database or to logs. The Workers' request logs (Workers Logs) are turned off.

To see exactly what would be sent, set `ERDEN_TELEMETRY_DEBUG=1`: each event is printed on standard error instead of
being queued.

### Forwarding to PostHog

Ingenio Ventures Inc operates Erden and uses [PostHog](https://posthog.com) Cloud US as a processor for product
analytics. After the telemetry Worker has checked and stored an event as above, it forwards that event to PostHog's
capture API (`https://us.i.posthog.com/i/v0/e/`), in the background, so the CLI never waits for it. The forwarded
event is named `cli_command_run` and holds exactly:

| Property                  | Example   | What it is                                                              |
| ------------------------- | --------- | ----------------------------------------------------------------------- |
| `command`                 | `check`   | the command's name, as above                                            |
| `outcome`                 | `success` | the outcome, as above                                                   |
| `duration_ms`             | `812`     | the duration in whole milliseconds, as above                            |
| `version`                 | `0.1.0`   | the CLI's version                                                       |
| `channel`                 | `stable`  | `stable` or `canary`                                                    |
| `os`                      | `linux`   | `linux`, `darwin` or `win32`                                            |
| `arch`                    | `x64`     | `x64` or `arm64`                                                        |
| `country`                 | `DE`      | the two-letter country the Worker derived, as above; empty when unknown |
| `$geoip_disable`          | `true`    | tells PostHog not to look up a location                                 |
| `$process_person_profile` | `false`   | tells PostHog not to make a person profile                              |

with the time the Worker received it and a **new random ID for every event** (PostHog's `distinct_id`), so PostHog
cannot tell which events came from the same installation.

What is **not** forwarded:

- **The install ID.** It stays in the Worker's short-lived list of active installs and nowhere else, so install counts
  are made only from that list, never in PostHog.
- **Your IP address.** The Worker makes the request to PostHog itself, with only a content type and the fixed
  User-Agent `erden-telemetry-worker`, so none of your connection's headers (no IP address header, cookie or
  User-Agent) reaches PostHog. The only address PostHog sees is Cloudflare's, and GeoIP lookups are turned off; the only
  location PostHog gets is the coarse country above.
- **Your User-Agent**, or anything else from your request beyond the event's own fields.

Events the Worker refuses or rate-limits are not forwarded. A forwarding failure is dropped, not retried or logged, and
never changes what is stored. The storage and retention above are unchanged by forwarding; PostHog's retention for
Erden's project applies to the forwarded events. Turning telemetry off in the CLI stops both, since nothing is sent to
the Worker at all.

### When no event is sent

No event is queued or sent, and no command writes a telemetry file, when any of these is true:

- `DO_NOT_TRACK` is set, the cross-tool convention from [consoledonottrack.com](https://consoledonottrack.com/);
- `ERDEN_TELEMETRY_DISABLED` is set;
- a CI service is detected: any of `CI`, `CONTINUOUS_INTEGRATION`, `BUILD_NUMBER`, `RUN_ID`, `GITHUB_ACTIONS`,
  `GITLAB_CI`, `TF_BUILD`, `BUILDKITE`, `CIRCLECI`, `JENKINS_URL`, `TEAMCITY_VERSION`, `CODEBUILD_BUILD_ID` or
  `BITBUCKET_BUILD_NUMBER` is set;
- the CLI is not a release build: a source checkout, or a package built from one.

A variable counts as set when it has any value other than empty, `0`, `false`, `no` or `off`, so a typo errs toward
off.

No event is sent after you turn telemetry off with `erden telemetry disable` either. With telemetry off, the daily
update check below can still run, unless `DO_NOT_TRACK` or one of its own switches is set, and it then asks an address
the release Worker does not count. Telemetry is on in terminals and off them alike, because scripts and AI agents that
run `erden` are real use. It never runs in CI, where the runs are machines checking code rather than people using the
tool.

### Turning it off and on

```sh
erden telemetry status    # whether it is on, and why
erden telemetry disable   # stop sending, from now on
erden telemetry enable
```

Or set `ERDEN_TELEMETRY_DISABLED=1` or `DO_NOT_TRACK=1` in your environment.

The setting is kept in `telemetry.json` in the CLI's settings directory: `$XDG_CONFIG_HOME/erden/` or
`~/.config/erden/` on Linux and macOS, `%LOCALAPPDATA%\Erden\` on Windows. Events wait in `telemetry-queue.jsonl` in
the same directory until the background process sends them (at most 50 at a time; a queue over 64 KiB is not added
to, so nothing piles up while you are offline). Disabling keeps the install ID in `telemetry.json` (it is never sent
while telemetry is off) so that turning it back on does not count you as a new install. Delete the file to forget the
ID. The server keeps an install ID for 35 days at most, as above; to have it deleted sooner, open an issue at
<https://github.com/erden-sh/erden/issues> with the ID `erden telemetry status` shows.

## Update checks

Once a day at most, the CLI asks the release Worker on erden.sh for the latest release of its channel, and on a later
run prints one line on standard error when a newer one exists. The check runs in a separate background process after
the command has finished, so it never slows a command down, and it never runs on the first run, before the telemetry
notice.

- With telemetry on, it asks `https://erden.sh/updates/<channel>/<os>/<arch>/<version>`. The release Worker counts
  that per UTC day, channel, OS, architecture, version (`other` unless a published release has it) and country, with
  no identifier of any kind.
- With telemetry off, it asks `https://erden.sh/updates/<channel>`, which carries nothing about your installation
  beyond the User-Agent below and which the Worker never counts.

The check and the notice run only when standard output and standard error are both terminals and no CI service is
detected. Set `ERDEN_NO_UPDATE_NOTIFIER=1` (or `NO_UPDATE_NOTIFIER=1`, the npm convention) to turn them off.
`DO_NOT_TRACK` turns them off too, as its convention asks. The last check is kept in `update-check.json` next to
`telemetry.json`.

`erden upgrade` asks the same address (by the same rule) when you run it, only to learn the latest version. It then
downloads the release's `SHA256SUMS`, install script and archive straight from
`https://github.com/erden-sh/erden/releases/download/<tag>/`, refuses any file that did not finally come from GitHub's
release hosts or whose SHA-256 is not the one `SHA256SUMS` lists, and runs that release's own install script.

## Downloads

`https://erden.sh/install`, `https://erden.sh/install.ps1`, `https://erden.sh/install/canary`,
`https://erden.sh/install/canary.ps1` and `https://erden.sh/download/...` redirect to the release's files on GitHub,
so the files themselves always come from the GitHub release and are checked against its `SHA256SUMS` and the digests
the install scripts carry. Each request is counted per UTC day with the release version (`other` unless a published
release has it), channel (`stable`, `canary`, or `pinned` for a link to an exact version), the kind of file
(`archive`, `install.sh`, `install.ps1` or `SHA256SUMS`), the archive's or the CLI's OS and architecture, whether the
request came from the CLI, an install script or anything else (decided from the User-Agent's form, which is not
stored), and the country. No IP address, User-Agent or other header is stored, and requests from Erden's own CI are not
counted. Download and update-check counts are kept 730 days.

## What every CLI request carries

Every request the CLI makes, to the registry, to the endpoints above and to GitHub, carries the User-Agent
`erden/<version> (<os>; <arch>)`, for example `erden/0.1.0 (linux; x64)`, and no other identifying header.

## Testing against your own Workers

`ERDEN_TELEMETRY_ORIGIN` replaces `https://telemetry.erden.sh`, and `ERDEN_RELEASES_ORIGIN` replaces `https://erden.sh`
for the update checks and `erden upgrade`, for example to try the Workers locally with `wrangler dev`. Each accepts an
`https://` origin, or `http://` only for `localhost`, `127.0.0.1` or `[::1]`.

## Changes to this page

If Erden ever collects anything new, this page will say so before a release that does, and it will follow the same
rules: anonymous, documented here, and off with the same switches.
