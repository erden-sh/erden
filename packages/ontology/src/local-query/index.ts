export {
    runLocalQuery,
    type LocalQueryEngineFormat,
    type LocalQueryEngineInput,
    type LocalQueryEngineResult,
} from './engine.js';
export { LOCAL_QUERY_GRAPHS, inferredDeltaQuads, localQueryNQuads, localQueryNTriples } from './dataset.js';
export { scanSparqlQuery, type SparqlQueryForm, type SparqlScan } from './scan.js';
