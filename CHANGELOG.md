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

- **Competency questions on their own: `erden query --questions [<id-or-path>…]`.** Runs the project's questions, or
  those named, without the rest of the check, each with its rows, expectation, verdict and regime.
- **`# @regime asserted|entailed`** in a question's header picks its regime (entailed when absent).
- **Expected results files.** `# @expect results <file>` compares the answer with a W3C results file (`.srj`,
  `.json`, `.csv`, `.tsv`), as a set or, with a top-level `ORDER BY`, a sequence; `# @expect contains <file>` checks
  that it holds at least those rows. `erden check` reads them too.
- **One named graph per source.** Questions and local queries can read `urn:erden:source:<source-id>`, which holds what
  one source file asserts.

### Changed

- **New exit code 4 (public interface).** `erden query [project-dir]` exits 4 when it answered but the answer is
  partial, or when `--regime entailed` could not be had. 0 to 3 keep their meaning, and no other command returns 4.
  `--allow-incomplete` turns 4 into 0. Anonymous telemetry counts exit 4 as `success`.
- `erden query <identifier>@<version>` is unchanged. A first argument that is not `<alias-or-IRI>@<version>` used to
  be a usage error; it is now the project directory of a local query.
- **`erden check` runs competency questions when its reasoning does not complete.** They run over the asserted
  statements and are reported as advisory, in a new optional `advisoryCompetencyQuestions` section of the
  `erden.check-report/v1` JSON report, or under the error when no report is written. The verdict and exit code do not
  change. Reports without it keep their bytes. A question's result in the report gains an optional `regime:
"asserted"` when it answered asserted, and the metadata diagnostic `invalid-regime` is new.
