# Changelog

Changes to the `erden` CLI that a user or a script can see. Each release's notes on the
[releases page](https://github.com/erden-sh/erden/releases) have the full story.

## Unreleased

### Added

- **`erden query [project-dir]` queries a local project.** Full SPARQL 1.1 (no `SERVICE`, no updates) over the
  project's sources and its installed dependencies, in the same Oxigraph engine as competency questions and the
  registry. Answers are entailed (what the files imply under Erden's reasoner) when the project's reasoning succeeds,
  else asserted (what the files say), and always say which, with the W3C entailment regime IRIs. They work on a broken
  project: sources that do not parse, missing dependencies and a refused or inconsistent reasoning run each make the
  answer partial, and the answer names what is missing. Output as a table, W3C SPARQL JSON, CSV or TSV, or Erden's
  `erden.local-query-result/v1` envelope (`--json`). `--regime asserted|entailed`, `--timeout`, `--allow-incomplete`.
  See [docs/query.md](docs/query.md).
- **`--registry-compatible`.** A local query the registry's query language would refuse gets a warning that names
  the registry's reason; `--registry-compatible` refuses it instead, so a script can check a query before running it
  on a release.
- **Entailment cache.** `erden check` and `erden query` keep the last proof-checked inferences of a project, by a
  digest of the reasoner and the exact sources, in `~/.cache/erden/entailments/v1` (`XDG_CACHE_HOME`; on Windows
  `%LOCALAPPDATA%\Erden\cache\entailments\v1`), so a query after a check does not reason again. It is safe to delete.

### Changed

- **New exit code 4 (public interface).** `erden query [project-dir]` exits 4 when it answered but the answer is
  partial, or when `--regime entailed` could not be had. 0 to 3 keep their meaning, and no other command returns 4.
  `--allow-incomplete` turns 4 into 0. Anonymous telemetry counts exit 4 as `success`.
- `erden query <identifier>@<version>` is unchanged. A first argument that is not `<alias-or-IRI>@<version>` used to
  be a usage error; it is now the project directory of a local query.
