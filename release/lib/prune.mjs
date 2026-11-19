// What the CLI archive leaves out of the deployed `lib/` tree: files the CLI never loads at run time. Each rule names
// why its files are safe to drop. The archive build runs the CLI from the pruned tree (smoke.mjs) before archiving it,
// and scripts/test/release.test.mjs runs the CLI from a pruned deployment, so a rule that removed a file the CLI
// needs fails the build or the tests, not a user.
import { readdirSync, rmSync, rmdirSync } from 'node:fs';
import { join, relative } from 'node:path';

/** The engine packages of every release platform; `platformPackages` keeps this platform's. */
const ENGINE_PACKAGE = /^node_modules\/@erden\/(?:reasoner|shacl)-(?:darwin|linux|win32)-[^/]+$/u;

/**
 * The denylist: each rule is a reason and a test on a path relative to `lib/` (`/`-separated; directories end in `/`).
 * A matching directory goes with everything in it.
 */
export function pruneRules(platformPackages) {
    return [
        {
            reason: 'TypeScript sources and declarations (lib/src, effect/src, every *.d.ts): Node.js loads only the built JavaScript',
            test: (path) => /\.(?:[cm]?ts)$/u.test(path),
        },
        {
            reason: 'source maps: nothing in the archive reads them',
            test: (path) => path.endsWith('.map'),
        },
        {
            reason: "oxigraph's browser build: the CLI loads node.js and node_bg.wasm",
            test: (path) => /^node_modules\/oxigraph\/web(?:\.js|_bg\.wasm)$/u.test(path),
        },
        {
            reason: "the other platforms' engine packages: the resolver loads only this platform's",
            test: (path) =>
                ENGINE_PACKAGE.test(path.replace(/\/$/u, '')) && !platformPackages.has(path.replace(/\/$/u, '')),
        },
    ];
}

/**
 * Removes every path the rules match under `lib`, then any directory left empty. `platformPackages` are this platform's
 * engine packages as `node_modules/@erden/<name>`. Returns the removed paths, sorted.
 */
export function pruneDeployedTree(lib, platformPackages) {
    const rules = pruneRules(new Set(platformPackages));
    const removed = [];
    function walk(directory) {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const absolute = join(directory, entry.name);
            const path = `${relative(lib, absolute).replaceAll('\\', '/')}${entry.isDirectory() ? '/' : ''}`;
            if (rules.some((rule) => rule.test(path))) {
                rmSync(absolute, { recursive: true, force: true });
                removed.push(path);
            } else if (entry.isDirectory()) {
                walk(absolute);
                if (readdirSync(absolute).length === 0) {
                    rmdirSync(absolute);
                }
            }
        }
    }
    walk(lib);
    return removed.sort();
}
