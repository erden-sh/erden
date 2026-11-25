# Erden

GitHub for ontologies: versioned, proof-checked company knowledge that AI agents can build on.

Open-source local tools for Erden: the `erden`/`den` CLI, registry client, contracts, local checking, package format, reasoner protocol, and both engines. Apache-2.0.

The local tools in this repository are Apache-2.0 (see [LICENSE](/LICENSE)). The hosted Erden registry is closed source and not part of this repository. Publishing, discovery, and the web UI are provided by the hosted service at [erden.sh](https://erden.sh). Self-hosting isn't offered. The name "Erden" is a trademark of Ingenio Ventures Inc (see [TRADEMARKS.md](/TRADEMARKS.md)).

## What is here

| Path                       | What it is                                                                        |
| -------------------------- | --------------------------------------------------------------------------------- |
| `apps/cli/`                | the `erden` CLI: `init`, `check`, `query`, `install`, `pack`, `publish`, `doctor` |
| `packages/client/`         | registry client: upload, download, reads                                          |
| `packages/contracts/`      | manifest, lockfile, check report and registry wire formats                        |
| `packages/project/`        | local project operations: check, install, pack, the package store                 |
| `packages/ontology/`       | local assembly, SHACL, competency questions                                       |
| `packages/package-format/` | the package archive format                                                        |
| `reasoner/`                | the reasoner's Rust source, qualification, protocol and resolver                  |
| `shacl/`                   | the `erden-shacl` engine's Rust source, qualification and resolver                |
| `workers/`                 | the Cloudflare Workers behind erden.sh/install, downloads and telemetry           |
| `docs/`                    | public documentation: local query and its exit codes, what telemetry collects     |

The engine binaries are never committed. A release ships them inside the CLI archive; a checkout builds them from
source.

## Installing

Linux (x64 and arm64, glibc or musl) and macOS on Apple silicon:

```bash
curl -fsSL https://erden.sh/install | sh
```

Windows x64, in PowerShell:

```powershell
irm https://erden.sh/install.ps1 | iex
```

Or with a package manager:

```bash
brew install erden-sh/tap/erden                      # macOS arm64, Linux x64 and arm64
scoop bucket add erden https://github.com/erden-sh/scoop-bucket
scoop install erden                                  # Windows x64
```

Or, for one project (in CI, for example), as a development dependency from npm, which pins the version in the
project's lockfile:

```bash
pnpm add -D @erden-sh/cli      # or: npm install --save-dev @erden-sh/cli
pnpm exec erden check          # or: npx erden check
```

`@erden-sh/cli` holds only a small launcher for `erden` and `den`. Erden itself is in one package per platform,
`@erden-sh/cli-<platform>` (`linux-x64`, `linux-arm64`, `linux-x64-musl`, `linux-arm64-musl`, `darwin-arm64`,
`win32-x64`), each holding that platform's release archive file for file, byte for byte. They are optional
dependencies, so the package manager installs only the one for the machine; installing with `--no-optional` or
`--omit=optional` leaves Erden out. None of them runs an install script, and the release workflow publishes them with
npm provenance (`npm audit signatures` checks it).

Each release has one archive per platform: Linux x64 and arm64 for glibc and for musl (Alpine), macOS arm64 and
Windows x64, with the Linux and macOS ones as both `.tar.xz` and `.tar.gz`. An archive holds the `erden` CLI as one
executable (Node.js with the CLI built in), the `den` command beside it, and both engines. Each release also has
`install.sh`, `install.ps1` and `SHA256SUMS`. `https://erden.sh/install` and `https://erden.sh/install.ps1` redirect to
the latest stable release's `install.sh` and `install.ps1` on GitHub; you can also download them from the
[releases page](https://github.com/erden-sh/erden/releases) and run `sh install.sh` or
`powershell -ExecutionPolicy Bypass -File install.ps1`. An install script carries its release's archive digests and
refuses any other file. The tool uses the hosted registry at `https://registry.erden.sh` unless `--registry` or a
project's manifest names another; `erden login` signs in to it. `https://erden.sh` is the website and documentation,
not the registry: the tool reads `--registry https://erden.sh` as `https://registry.erden.sh`, and a manifest's
`registry` must name `https://registry.erden.sh` itself.

The scripts install for the current user, with no administrator rights:

- `install.sh` puts the release in `~/.local/share/erden/<version>/` and links `erden` and `den` into `~/.local/bin`.
  Unless that directory is already on your `PATH`, it adds one line to `~/.profile`, to the bash files you have
  (`~/.bashrc`, `~/.bash_profile`, `~/.bash_login`), to `~/.zshenv` when you use zsh, and a file in
  `~/.config/fish/conf.d/` when you use fish. Each line sources `~/.local/share/erden/env`, which adds the directory
  once. It prints the line to run to use `erden` in the current shell. Running the script again adds nothing twice.
- `install.ps1` puts the release in `%LOCALAPPDATA%\Programs\Erden\<version>\` and launchers for `erden` and `den` in
  `%LOCALAPPDATA%\Programs\Erden\bin\`, which it adds to your user `PATH` in the registry once. New terminals find it;
  the current session is updated too.
- On Alpine and other musl systems, Erden needs the C++ runtime Node.js uses: `apk add libstdc++ libgcc`. The script
  checks for it and names that command before it downloads anything.

Options, for either script:

| `install.sh`          | `install.ps1`     | Environment variable     | Effect                                         |
| --------------------- | ----------------- | ------------------------ | ---------------------------------------------- |
| `--version <version>` | `-Version <v>`    | `ERDEN_VERSION`          | install that release instead of the latest     |
| `--no-modify-path`    | `-NoModifyPath`   | `ERDEN_NO_MODIFY_PATH=1` | leave your shell profiles or user `PATH` alone |
| `--archive <file>`    | `-Archive <file>` |                          | install a downloaded archive, offline          |
| `--uninstall`         | `-Uninstall`      |                          | remove Erden and the `PATH` changes            |

Pass `install.sh` options after `sh -s --`, and set the environment variables for the `irm | iex` form:

```bash
curl -fsSL https://erden.sh/install | sh -s -- --version 0.1.0 --no-modify-path
```

```powershell
$env:ERDEN_VERSION = '0.1.0'; irm https://erden.sh/install.ps1 | iex
```

A script checks its own release's archives against the digests it carries. For another version it checks the
archive against that release's `SHA256SUMS`, fetched over HTTPS from the same release.

`erden upgrade` updates an install made this way to the latest release: it checks the new release's install script and
archive against its `SHA256SUMS` and then runs that script. An install made by Homebrew or Scoop is updated by them
instead, and one from npm like any other dependency (`pnpm update @erden-sh/cli`). Canary releases (`v<x.y.z>-rc.<n>`, GitHub prereleases) are for trying what comes next: install one with
`curl -fsSL https://erden.sh/install/canary | sh` (Windows: `irm https://erden.sh/install/canary.ps1 | iex`), or move
an install to that channel with `erden upgrade --channel canary`, and back with `erden upgrade --channel stable`.

### Shell completions

`erden completions <bash|zsh|fish|powershell>` writes a completion script for `erden` and `den`. Homebrew installs them
for you. Otherwise, add one of these to your shell's startup file:

```bash
source <(erden completions bash)                                # ~/.bashrc
source <(erden completions zsh)                                 # ~/.zshrc, after compinit
erden completions fish | source                                 # ~/.config/fish/config.fish
erden completions powershell | Out-String | Invoke-Expression   # $PROFILE
```

### Uninstalling

```bash
curl -fsSL https://erden.sh/install | sh -s -- --uninstall
```

```powershell
& ([scriptblock]::Create((irm https://erden.sh/install.ps1))) -Uninstall
```

This removes the installed versions, the `erden` and `den` links or launchers, and the `PATH` lines or entry the
script added. Your projects, Erden's package store (`~/.local/share/erden/store`, or `%LOCALAPPDATA%\Erden\store`)
and saved registry sign-ins (`erden logout` removes them) are left as they were. Installed with Homebrew or Scoop,
run `brew uninstall erden` or `scoop uninstall erden` instead, and from npm, `pnpm remove @erden-sh/cli` (or
`npm uninstall @erden-sh/cli`).

### Checking where a release came from

Each archive and every other release asset has a build provenance attestation, signed by the GitHub Actions run that
built it. With the [GitHub CLI](https://cli.github.com):

```bash
gh attestation verify erden-<version>-<platform>.tar.gz --repo erden-sh/erden
```

Erden 0.1.0 has no attestations; check its assets against `SHA256SUMS`. The npm packages carry npm provenance from
the release workflow, which `npm audit signatures` checks in a project that installed them.

### Telemetry

Release builds send anonymous usage data: each command's name, outcome and duration, the version, channel, OS, CPU
architecture and a random install ID, never paths, project names, IRIs, arguments or error messages. The first run says
so and sends nothing. Turn it off with `erden telemetry disable`, `ERDEN_TELEMETRY_DISABLED=1` or `DO_NOT_TRACK=1`; it
is always off in CI. Once a day, on a terminal, the CLI also checks for a newer release (`ERDEN_NO_UPDATE_NOTIFIER=1`
turns that off). [docs/telemetry.md](/docs/telemetry.md) lists exactly what is sent and stored.

### Installing without network access

1. On a connected machine, download the install script (`install.sh`, or `install.ps1` on Windows) and the archive for
   the offline machine's platform, both from the same release.
2. Carry both files to the offline machine.
3. Run `sh install.sh --archive erden-<version>-<platform>.tar.xz` (smaller, and needs `xz` or macOS's `tar`), or
   `--archive erden-<version>-<platform>.tar.gz` (needs only `gzip`). On Windows, run
   `powershell -ExecutionPolicy Bypass -File install.ps1 -Archive erden-<version>-win32-x64.zip`.

The script checks the archive's size and SHA-256 before it extracts anything, and makes no network request. The CLI
makes none either beyond a registry you configure, telemetry, the daily update check and `erden upgrade` when you
run it, and with `DO_NOT_TRACK=1` it makes only the registry's and `erden upgrade`'s. It also checks each engine binary against its pinned size and SHA-256
before every use.

## Building from source

Node.js 24 (the exact version is in `.node-version`) and pnpm 12.21.0 (`packageManager`). The engines build in a
pinned Docker builder image on Linux, or with the Rust toolchain each engine's `rust-toolchain.toml` names on macOS and Windows.
A Linux build is installed only if it is byte-identical to its pin. A macOS or Windows build also depends on the
machine's linker and system libraries, which no pin covers, so it can differ from the pin; in CI the minted binary is
then fetched from the release run that built it, checked against the pin, and installed instead.

```bash
pnpm run bootstrap:workspace
pnpm run reasoner:build:linux   # the reasoner, built twice and compared
pnpm run build:shacl            # erden-shacl, checked against its pin
ERDEN_REASONER_BIN="$PWD/reasoner/source-build/x86_64-unknown-linux-gnu/erden-reasoner" pnpm test
```

These commands are for Linux x64. On Linux arm64, use `aarch64-unknown-linux-gnu` in the executable path.
On macOS arm64 and Windows x64, install the toolchain in `reasoner/rust-toolchain.toml`, build the reasoner
with `pnpm run reasoner:build`, then run `pnpm run build:shacl` and `pnpm test`. The CLI finds that native
reasoner in `reasoner/target/release/` without an environment override.

`pnpm test` runs the workspace gate: the repository guards, formatting, lint, typecheck, the package packs, a packed
CLI install, and every test.

## How a release is made

`.github/workflows/release.yml` runs three ways:

1. **Engine mint** (dispatched): builds both engines twice for Linux x64 and arm64 (glibc and musl), macOS arm64 and
   Windows x64, checks that every platform gives the same answers, and uploads their pins for a pull request. The Linux
   builds must be byte-identical. A difference between the two macOS or Windows builds, or in their answers, is a warning in the job
   summary, since those builds use the runner image's linker, which no pin covers. The Windows engines link the C
   runtime statically, so they need no Visual C++ Redistributable.
2. **Archive mint** (dispatched after the engine pins are merged): builds no engine. It builds each platform's CLI
   archive twice with the exact pinned engine binaries, fetched from the engine mint run, and uploads
   `release/pins/<version>.json`, naming this run, for a pull request. The musl archives build in a pinned Node.js
   Alpine image. Each archive gets a build provenance attestation. Every archive's Node.js is pinned in
   `release/node-runtime.json`: the official builds from nodejs.org, the Node.js project's unofficial build for
   linux-x64-musl, and for linux-arm64-musl the Node.js of that pinned Alpine image, because the unofficial arm64 musl
   build is not position-independent and postject cannot inject the CLI into it. That Node.js links `libstdc++` and
   `libgcc` dynamically, which the install script already requires on Alpine; its `LICENSE` comes from the official,
   checksummed Node.js source tarball.
3. **Release** (a `v<version>` tag on the merged pins): builds nothing. It fetches the archives of the mint run the
   pins name, refuses unless each one's size and SHA-256 are the pinned ones, and publishes them with `SHA256SUMS` and
   the install scripts, which check every archive's digest before they extract it, attesting every asset. Once the
   published release installs and runs on every platform, the workflow writes the Homebrew formula and the Scoop
   manifest from the pins (`release/write-package-manifests.mjs`) and pushes them to
   [erden-sh/homebrew-tap](https://github.com/erden-sh/homebrew-tap) and
   [erden-sh/scoop-bucket](https://github.com/erden-sh/scoop-bucket). It also builds the npm packages from the
   release's own archives, each checked against its pin (`release/npm-packages.mjs`), packs them, checks every packed
   file against the archive, and publishes them, the platform packages first, with npm trusted publishing: npm
   accepts the job's OIDC identity (this repository, `release.yml`, the `npm` environment) instead of a stored token,
   and signs a provenance statement for each package.

npm sets up a trusted publisher only for a package that already exists, so the npm packages start with a one-time
setup by an owner of the `erden-sh` npm organization: `node scripts/npm-bootstrap.mjs` publishes an existing
release's packages with their own sign-in (`--dry-run` first; these versions have no provenance statement, which
only a CI run can sign), and `node scripts/npm-bootstrap.mjs --trust` makes
`release.yml` the trusted publisher of every package, after which the repository variable `NPM_PUBLISH` is set to
`true`. Until then the release skips npm with a warning. npm drops a trusted publisher that has not published within
two days, so `--trust` runs just before a release. `pnpm run test:npm:packages` builds the packages of the current
version from its release, installs them into a scratch project and runs them, without the registry.

A canary is made the same way with the version `x.y.z-rc.n` and the tag `vx.y.z-rc.n`, which
`.github/workflows/release-canary.yml` publishes as a GitHub prerelease that is never marked latest.

GitHub keeps a run's artifacts for 90 days. The archive mint must follow its engine mint, and the tag its archive
mint, within that time; otherwise run the mint again.

## Contributing and security

Outside contributions are not accepted at this time; issues are welcome (see [CONTRIBUTING.md](/CONTRIBUTING.md)).
Report vulnerabilities privately as [SECURITY.md](/SECURITY.md) describes.
