# Telemetry, update checks and downloads

The Erden CLI sends a small amount of anonymous data to Erden, and the erden.sh download links count downloads. This
page lists all of it. The code that sends it is in [`apps/cli/src`](../apps/cli/src) (`telemetry.ts`, `session.ts`,
`updates.ts`, `background.ts`), and the code that receives and stores it is in [`workers/`](../workers), with each
database's schema in its `schema.sql`. Both are open source, so you can check this page against them.

Everything goes to Erden's own Cloudflare Workers. There is no third-party analytics service, no advertising and no
sharing or selling of the data. Ingenio Ventures Inc runs these services.

## Usage telemetry

Telemetry is **on by default** in release builds and easy to turn off. The first time you run `erden`, it prints a
notice on standard error that says what it collects and how to turn it off, and **sends nothing from that run**. Every
later run sends one event when the command finishes.

### What one event holds

| Field        | Example                                | What it is                                                                                   |
| ------------ | -------------------------------------- | -------------------------------------------------------------------------------------------- |
| `installId`  | `3b241101-e2bb-4255-8caf-4136c566a962` | a random ID (UUID v4) made on your machine on the first run; it is not derived from anything |
| `command`    | `check`, `store status`                | the command's name, from a fixed list; anything else is sent as `unknown`                    |
| `outcome`    | `success`                              | `success`, `failure`, `usage-error`, `operational-error` or `crash`, from the exit code      |
| `durationMs` | `812`                                  | how long the command took, in whole milliseconds                                             |
| `version`    | `0.1.0`                                | the CLI's version                                                                            |
| `channel`    | `stable`                               | `stable` or `canary`                                                                         |
| `os`         | `linux`                                | `linux`, `darwin` or `win32`                                                                 |
| `arch`       | `x64`                                  | `x64` or `arm64`                                                                             |

That is the whole event (plus a `schema` field naming its format). It **never** includes file or directory paths,
project or package names, aliases, IRIs, command arguments or flags, query text, registry addresses, error messages,
your username, hostname or IP address, or anything about your account.

When an event arrives, the telemetry Worker adds the **country** Cloudflare derives from the connection (a two-letter
code such as `DE`) and the **UTC day** it arrived. It does not store your IP address or any request header. It keeps a
row per install ID with the first and last day it reported and what it last reported, and a daily count, total and
longest duration per command and outcome. Rows older than **730 days** are deleted automatically.

To see exactly what would be sent, set `ERDEN_TELEMETRY_DEBUG=1`: each event is printed on standard error instead of
being sent.

### When nothing is sent

Nothing is sent, and no command writes a telemetry file, when any of these is true:

- `DO_NOT_TRACK` is set, the cross-tool convention from [consoledonottrack.com](https://consoledonottrack.com/);
- `ERDEN_TELEMETRY_DISABLED` is set;
- a CI service is detected: any of `CI`, `CONTINUOUS_INTEGRATION`, `BUILD_NUMBER`, `RUN_ID`, `GITHUB_ACTIONS`,
  `GITLAB_CI`, `TF_BUILD`, `BUILDKITE`, `CIRCLECI`, `JENKINS_URL`, `TEAMCITY_VERSION`, `CODEBUILD_BUILD_ID` or
  `BITBUCKET_BUILD_NUMBER` is set;
- the CLI is not a release build: a source checkout, or a package built from one.

A variable counts as set when it has any value other than empty, `0`, `false`, `no` or `off`, so a typo errs toward
off.

Nothing is sent after you turn telemetry off with `erden telemetry disable` either. Telemetry is on in terminals and
off them alike, because scripts and AI agents that run `erden` are real use. It never runs in CI, where the runs are
machines checking code rather than people using the tool.

### Turning it off and on

```sh
erden telemetry status    # whether it is on, and why
erden telemetry disable   # stop sending, from now on
erden telemetry enable
```

Or set `ERDEN_TELEMETRY_DISABLED=1` or `DO_NOT_TRACK=1` in your environment.

The setting is kept in `telemetry.json` in the CLI's settings directory: `$XDG_CONFIG_HOME/erden/` or
`~/.config/erden/` on Linux and macOS, `%LOCALAPPDATA%\Erden\` on Windows. Disabling keeps the install ID in that file
(it is never sent while telemetry is off) so that turning it back on does not count you as a new install. Delete the
file to forget the ID. To have the data stored for an install ID deleted, open an issue at
<https://github.com/erden-sh/erden/issues> with the ID `erden telemetry status` shows; nothing else is needed, and the
ID tells us nothing about you.

## Update checks

Once a day at most, the CLI asks `https://erden.sh/updates/<channel>/<os>/<arch>/<version>` for the latest release of
its channel, and on a later run prints one line on standard error when a newer one exists. The check runs in a
separate background process after the command has finished, so it never slows a command down.

The request carries only what its address shows (channel, OS, CPU architecture, the CLI's version) and the
User-Agent described below; no install ID. The release Worker counts it per UTC day, channel, OS, architecture,
version and country, with no identifier of any kind.

The check and the notice run only when standard output and standard error are both terminals and no CI service is
detected. Set `ERDEN_NO_UPDATE_NOTIFIER=1` (or `NO_UPDATE_NOTIFIER=1`, the npm convention) to turn them off.
`DO_NOT_TRACK` turns them off too, as its convention asks. The last check is kept in `update-check.json` next to
`telemetry.json`.

`erden upgrade` asks the same address when you run it, and downloads the new release through erden.sh (below).

## Downloads

`https://erden.sh/install`, `https://erden.sh/install.ps1`, `https://erden.sh/install/canary`,
`https://erden.sh/install/canary.ps1` and `https://erden.sh/download/...` redirect to the release's files on GitHub,
so the files themselves always come from the GitHub release and are checked against its `SHA256SUMS` and the digests
the install scripts carry. Each request is counted per UTC day with the release version, channel (`stable`, `canary`,
or `pinned` for a link to an exact version), the kind of file (`archive`, `install.sh`, `install.ps1` or
`SHA256SUMS`), the archive's or the CLI's OS and architecture, whether the request came from the CLI, an install
script or anything else (decided from the User-Agent's form, which is not stored), and the country. No IP address,
User-Agent or other header is stored, and requests from Erden's own CI are not counted.

## What every CLI request carries

Every request the CLI makes, to the registry and to the endpoints above, carries the User-Agent
`erden/<version> (<os>; <arch>)`, for example `erden/0.1.0 (linux; x64)`, and no other identifying header.

## Testing against your own Workers

`ERDEN_TELEMETRY_ORIGIN` replaces `https://telemetry.erden.sh`, and `ERDEN_RELEASES_ORIGIN` replaces `https://erden.sh`
for the update checks and `erden upgrade`, for example to try the Workers locally with `wrangler dev`.

## Changes to this page

If Erden ever collects anything new, this page will say so before a release that does, and it will follow the same
rules: anonymous, documented here, and off with the same switches.
