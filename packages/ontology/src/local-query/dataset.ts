import { Writer, type Quad } from 'n3';

import type { ReasonedOntology } from '../model.js';
import { oxigraphQuad } from '../questions.js';

/**
 * The graphs of a local query. They are the registry's release query graphs, so one query text runs over a local
 * project and over a published release: the default graph holds the declared (asserted) statements, and the
 * inferred graph the reasoner's inferences that are not also asserted.
 */
export const LOCAL_QUERY_GRAPHS = Object.freeze({
    declared: 'urn:erden:release-query:v1:graph:declared',
    inferred: 'urn:erden:release-query:v1:graph:inferred',
});

/**
 * N-Triples of the given quads (their graph is dropped), one statement per line, with assembled blank-node labels
 * made valid the same way competency questions make them, so the text from different calls joins on blank nodes.
 */
export function localQueryNTriples(quads: Iterable<Quad>): string {
    const writer = new Writer({ format: 'N-Triples' });
    const lines: string[] = [];
    for (const quad of quads) {
        const relabeled = oxigraphQuad(quad);
        lines.push(writer.quadToString(relabeled.subject, relabeled.predicate, relabeled.object));
    }
    return lines.join('');
}

/** The statements a reasoned graph adds to its asserted one: the inferred graph of a local query. */
export function inferredDeltaQuads(reasoned: ReasonedOntology): ReadonlyArray<Quad> {
    return Object.freeze(reasoned.provenance.filter((entry) => entry.asserted.length === 0).map((entry) => entry.quad));
}

/** One N-Quads document from N-Triples text per graph: each line `s p o .` becomes `s p o <graph> .`. */
export function localQueryNQuads(graphs: ReadonlyArray<Readonly<{ graph: string; ntriples: string }>>): string {
    const parts: string[] = [];
    for (const { graph, ntriples } of graphs) {
        const suffix = ` <${graph}> .`;
        for (const line of ntriples.split('\n')) {
            if (line.length === 0) {
                continue;
            }
            if (!line.endsWith(' .')) {
                throw new TypeError('local query N-Triples must hold one statement per line');
            }
            parts.push(`${line.slice(0, -2)}${suffix}\n`);
        }
    }
    return parts.join('');
}
