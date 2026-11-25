# Querying a project with `erden query`

`erden query` asks SPARQL questions in two places:

- **A local project**, on your machine: `erden query [project-dir] --file q.rq`. Full SPARQL 1.1, over the project's
  sources and its installed dependencies. This page is about this form.
- **A published release**, on the registry: `erden query <identifier>@<version> --file q.rq`. A bounded query
  language that the registry runs on shared hardware. It works as it always has.

The first argument decides which: `<alias-or-IRI>@<version>` is a release; anything else, or nothing, is a project
directory, found the way `erden check` finds it. Query text is read only from a file (`--file`) or standard input
(`--stdin`), never from the command line.

```text
erden query [project-dir] (--file <path> | --stdin)
            [--config <file>]
            [--regime asserted|entailed]
            [--json | --sparql-json | --csv | --tsv]
            [--timeout <seconds>] [--allow-incomplete] [--registry-compatible] [--offline]
```

## What a query sees

The project's ontology sources and those of its installed, locked dependencies: the same statements `erden check`
assembles. The query runs in Oxigraph 0.5.9, the engine competency questions and the registry use, so the three give
the same answers. Local query never touches the network; `--offline` is accepted and changes nothing.

The graphs are the registry's, so a query that uses only them runs the same way on a project and on its release:

| Graph                                       | Holds                                                                  |
| ------------------------------------------- | ---------------------------------------------------------------------- |
| `urn:erden:release-query:v1:graph:declared` | the statements the files assert                                        |
| `urn:erden:release-query:v1:graph:inferred` | what Erden's reasoner infers from them, beyond the asserted statements |

The default graph depends on the regime: the declared graph in the asserted regime, and the union of both in the
entailed regime. `GRAPH <urn:erden:release-query:v1:graph:inferred> { … }` reads the inferences alone, in the entailed
regime. On the registry the default graph is always the declared graph; a query that reads inferences through the
`GRAPH` pattern gets the same rows from a release and from its project in the entailed regime.

## Regimes: asserted and entailed

Every answer says which regime it used:

- **Asserted**: what the files say. W3C simple entailment, `http://www.w3.org/ns/entailment/Simple`. Always
  available, even for a project that does not reason.
- **Entailed**: what the files imply under Erden's reasoner. OWL 2 Direct Semantics,
  `http://www.w3.org/ns/entailment/OWL-Direct`, restricted to Erden's profile
  (`https://erden.sh/ns/profile/erden-required-constructs-v2`). Every inference is proof-checked, exactly as in
  `erden check`.

Without `--regime`, a query answers entailed when the project's reasoning succeeds, and asserted otherwise, saying why.
`--regime asserted` never runs the reasoner. `--regime entailed` answers entailed or not at all: when reasoning fails,
the query prints why and exits 4 without an answer.

Reasoning costs what it costs in `erden check`. So Erden keeps the inferences of the last successful reasoning run, by
a digest of everything reasoning reads (the reasoner and the exact bytes, names and settings of every source), and
reuses them while nothing changed. `erden check` keeps them too, so a query after a check is fast. A reasoning run that
the reasoner refuses for these inputs (over a limit, or inconsistent) is kept as well, with the reasoner
limits it ran under, so a query does not try again until something changes. The cache is in
`$XDG_CACHE_HOME/erden/entailments/v1` (by default `~/.cache/erden/entailments/v1`), or
`%LOCALAPPDATA%\Erden\cache\entailments\v1` on Windows. It holds at most 32 entries, and you can delete it at any time.

The reasoner limits are those of `erden check`: `ERDEN_REASONER_MAX_WALL_TIME_MS`, `ERDEN_REASONER_MAX_INPUT_AXIOMS`,
`ERDEN_REASONER_MAX_INFERENCES` and `ERDEN_REASONER_MAX_REQUEST_BYTES`.

## Answers on a broken project

A query answers from whatever it can, and says what is missing. It never drops anything silently.

| Project state                                                               | What the query answers                                       | Reason in the answer                                          |
| --------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------- |
| Everything parses, reasoning succeeds                                       | the regime asked for                                         | none: complete                                                |
| A source is missing, unreadable or does not parse                           | the same, over the sources that parsed                       | `sources-unparsed`, per file with line and column where known |
| Dependencies are declared but not installed, or not verifiable              | the project's own sources only                               | `dependencies-missing`, with `erden check`'s error code       |
| The reasoner refuses (limits, unsupported statements, …)                    | asserted                                                     | `entailment-unavailable`, with `erden check`'s failure code   |
| The ontology is inconsistent                                                | asserted: an inconsistent ontology entails everything        | `entailment-unavailable: global-inconsistency`                |
| Statements outside the reasoner's profile, in `outsideProfile: report` mode | entailed over the profile part, and every asserted statement | `statements-outside-profile`, with their count                |

A project whose manifest cannot be read, or an Erden installation without its engines, is not answered: that is
exit 3, as for `erden check`.

## The query language

Full SPARQL 1.1 Query as Oxigraph implements it: `SELECT`, `ASK`, `CONSTRUCT` and `DESCRIBE`, subqueries, property
paths, `REGEX`, aggregates and the rest. Two things are refused:

- `SERVICE`: local query never reaches the network (`LOCAL_QUERY_SERVICE_FORBIDDEN`).
- SPARQL Update: query only (`LOCAL_QUERY_UPDATE_FORBIDDEN`).

The registry runs a smaller language. When a query uses something it refuses, `erden query` prints a warning that
names the registry's reason, and still runs the query locally. With `--registry-compatible`, it refuses the query
instead (`RELEASE_QUERY_REJECTED`, exit 1), so a script can check that a query will also run on a published release.

`--timeout` bounds loading and running the query, 60 seconds by default. Local query text may be up to 1 MiB.

## Output

| Flag            | Standard output                                                                                        |
| --------------- | ------------------------------------------------------------------------------------------------------ |
| (none)          | a table and the row count, then the regime and completeness lines; `CONSTRUCT`/`DESCRIBE` as N-Triples |
| `--sparql-json` | W3C SPARQL 1.1 Query Results JSON                                                                      |
| `--csv`         | W3C SPARQL 1.1 Query Results CSV                                                                       |
| `--tsv`         | W3C SPARQL 1.1 Query Results TSV                                                                       |
| `--json`        | Erden's envelope, below                                                                                |

With `--sparql-json`, `--csv` and `--tsv` standard output holds only the W3C document, and the regime and completeness
lines go to standard error. These three hold `SELECT` and `ASK` answers; a `CONSTRUCT` or `DESCRIBE` query prints
N-Triples, or the envelope with `--json`.

The envelope, `erden.local-query-result/v1`, labels the answer with SPARQL 1.1 Entailment Regimes and Service
Description terms:

```json
{
    "schema": "erden.local-query-result/v1",
    "project": { "canonicalIri": "https://example.org/onto/", "manifest": "erden.config.yaml" },
    "query": { "form": "select", "sha256": "…" },
    "regime": {
        "entailmentRegime": "http://www.w3.org/ns/entailment/OWL-Direct",
        "supportedEntailmentProfile": "https://erden.sh/ns/profile/erden-required-constructs-v2",
        "reasoner": { "name": "erden-reasoner", "version": "…", "calculusDigest": "sha256:…" },
        "inputDigest": "sha256:…",
        "certificateDigest": "sha256:…",
        "method": "materialized",
        "cached": true
    },
    "completeness": {
        "complete": false,
        "reasons": [
            {
                "code": "sources-unparsed",
                "sources": [
                    {
                        "file": "modules/broken.ttl",
                        "line": 3,
                        "column": 7,
                        "code": "TURTLE_SOURCE_PARSE_ERROR",
                        "message": "…"
                    }
                ]
            }
        ]
    },
    "dataset": { "quadCounts": { "declared": 161700, "inferred": 52522 } },
    "warnings": [],
    "result": { "head": { "vars": ["x"] }, "results": { "bindings": [] } }
}
```

In the asserted regime, `regime` holds only `entailmentRegime: "http://www.w3.org/ns/entailment/Simple"`. For
`CONSTRUCT` and `DESCRIBE`, `result` is `{ "ntriples": "…" }`. `warnings` lists `{ "code": "registry-refuses",
"reason": "…" }` when the registry's language refuses the query.

## Exit codes

Exit codes are part of Erden's public interface. Local query adds code 4:

| Code | Meaning                                                                                                           |
| ---- | ----------------------------------------------------------------------------------------------------------------- |
| 0    | answered, and complete under the regime the answer names                                                          |
| 1    | the query was refused: a syntax error, `SERVICE`, an update, or `--registry-compatible` refusing it               |
| 2    | usage error                                                                                                       |
| 3    | could not complete: the project could not be read, the engine is unavailable, or `--timeout` ran out              |
| 4    | answered, but partial: the answer names at least one completeness reason; or `--regime entailed` could not be had |

A build that needs trusted answers treats 4 as a failure. An editor or an exploratory script passes
`--allow-incomplete`, which turns 4 into 0; the labels stay in the output. The other commands keep codes 0 to 3, and
`erden query <identifier>@<version>` is unchanged.
