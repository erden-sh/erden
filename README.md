# Erden

GitHub for ontologies: versioned, proof-checked company knowledge that AI agents can build on.

Open-source local tools for Erden: the `erden`/`den` CLI, registry client, contracts, local checking, package format, reasoner protocol, and both engines. Apache-2.0.

The local tools in this repository are Apache-2.0 (see [LICENSE](/LICENSE)). The hosted Erden registry is closed source and not part of this repository. Publishing, discovery, and the web UI are provided by the hosted service at [erden.sh](https://erden.sh). Self-hosting isn't offered. The name "Erden" is a trademark of Ingenio Ventures Inc (see [TRADEMARKS.md](/TRADEMARKS.md)).

## What is here

| Path                       | What it is                                                               |
| -------------------------- | ------------------------------------------------------------------------ |
| `apps/cli/`                | the `erden` CLI: `init`, `check`, `install`, `pack`, `publish`, `doctor` |
| `packages/client/`         | registry client: upload, download, reads                                 |
| `packages/contracts/`      | manifest, lockfile, check report and registry wire formats               |
| `packages/project/`        | local project operations: check, install, pack, the package store        |
| `packages/ontology/`       | local assembly, SHACL, competency questions                              |
| `packages/package-format/` | the package archive format                                               |
| `reasoner/`                | the reasoner's Rust source, qualification, protocol and resolver         |
| `shacl/`                   | the `erden-shacl` engine's Rust source, qualification and resolver       |

The engine binaries are never committed. A release ships them inside the CLI archive; a checkout builds them from
source.

## Installing

Each release has one archive per platform: Linux x64 and arm64 (glibc), macOS arm64 and Windows x64. An archive
holds the `erden` CLI, the Node.js runtime it runs on, and both engines. Each release also has `install.sh`,
`install.ps1` and `SHA256SUMS`. An install script carries its release's archive digests and refuses any other
file. The tool uses the hosted registry at `https://registry.erden.sh` unless `--registry` or a project's manifest names
another. It installs for the current user, with no administrator rights, to `~/.local/share/erden/<version>/` with
`erden` and `den` linked into `~/.local/bin` (Windows: `%LOCALAPPDATA%\Programs\Erden\<version>\`).

```bash
curl -fsSLO https://github.com/erden-sh/erden/releases/latest/download/install.sh
sh install.sh
```

On Windows, download `install.ps1` from the same release and run `powershell -ExecutionPolicy Bypass -File install.ps1`.

### Installing without network access

1. On a connected machine, download the install script (`install.sh`, or `install.ps1` on Windows) and the archive for
   the offline machine's platform, both from the same release.
2. Carry both files to the offline machine.
3. Run `sh install.sh --archive erden-<version>-<platform>.tar.gz`. On Windows, run
   `powershell -ExecutionPolicy Bypass -File install.ps1 -Archive erden-<version>-win32-x64.zip`.

The script checks the archive's size and SHA-256 before it extracts anything, and makes no network request. The CLI
makes none either, except to a registry you configure. It also checks each engine binary against its pinned size and
SHA-256 before every use.

## Building from source

Node.js 24 (the exact version is in `.node-version`) and pnpm 10.15.0 (`packageManager`). The engines build in a
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

1. **Engine mint** (dispatched): builds both engines twice on Linux x64, Linux arm64, macOS arm64 and Windows x64, checks
   that every platform gives the same answers, and uploads their pins for a pull request. The Linux builds must be
   byte-identical. A difference between the two macOS or Windows builds, or in their answers, is a warning in the job
   summary, since those builds use the runner image's linker, which no pin covers. The Windows engines link the C
   runtime statically, so they need no Visual C++ Redistributable.
2. **Archive mint** (dispatched after the engine pins are merged): builds no engine. It builds each platform's CLI
   archive twice with the exact pinned engine binaries, fetched from the engine mint run, and uploads
   `release/pins/<version>.json`, naming this run, for a pull request.
3. **Release** (a `v<version>` tag on the merged pins): builds nothing. It fetches the archives of the mint run the
   pins name, refuses unless each one's size and SHA-256 are the pinned ones, and publishes them with `SHA256SUMS` and
   the install scripts, which check every archive's digest before they extract it.

GitHub keeps a run's artifacts for 90 days. The archive mint must follow its engine mint, and the tag its archive
mint, within that time; otherwise run the mint again.

## Contributing and security

Outside contributions are not accepted at this time; issues are welcome (see [CONTRIBUTING.md](/CONTRIBUTING.md)).
Report vulnerabilities privately as [SECURITY.md](/SECURITY.md) describes.
