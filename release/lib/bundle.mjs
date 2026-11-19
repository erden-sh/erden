// The CLI as one JavaScript file for a Node.js single executable application (SEA), and the `lib/` tree beside the
// executable that it still reads from disk.
//
// esbuild bundles the deployed CLI's single-executable entry (`lib/dist/sea.js`, which runs the CLI or its background
// job) and everything it imports into one CommonJS file. A few
// modules find files relative to themselves through `import.meta.url`: the engine resolvers their fixtures and
// platform packages, the CLI its package.json, and the ontology package oxigraph, n3 and rdf-canonize, which it loads
// with createRequire (oxigraph's WebAssembly is hashed from disk; n3 and rdf-canonize are imported by path inside a
// Worker). Each such `import.meta.url` becomes the URL of the same file under `<root>/lib/`, where `<root>` is the
// directory above the executable's `bin/`. The modules that do this are listed (SIDECAR_URL_MODULES), so a new one
// fails the build until it is reviewed. The sidecar tree (sidecarFiles) holds exactly what those modules read.
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, sep } from 'node:path';

/** The modules, by their path under `lib/`, that read files relative to themselves at run time. */
export const SIDECAR_URL_MODULES = Object.freeze([
    // The CLI's package.json (its version) and the archive root, which tells how it was installed.
    'dist/installation.js',
    // background.js, which only Node.js running the CLI from source starts by path (sea.ts runs it in a single executable).
    'dist/session.js',
    'node_modules/@erden/ontology/dist/comparison-rdf/normalize.js',
    'node_modules/@erden/ontology/dist/oxigraph-runtime.js',
    'node_modules/@erden/ontology/dist/release-query/engine.js',
    'node_modules/@erden/ontology/dist/source-formats/graph-hash.js',
    'node_modules/@erden/reasoner-distribution/src/index.js',
    'node_modules/@erden/shacl-distribution/src/index.js',
]);

/**
 * What the bundle leaves to run time: msgpackr-extract is a native addon, which a single executable cannot load from
 * its bundle; msgpackr falls back to its JavaScript implementation without it, as it does wherever the addon is absent.
 */
const EXTERNAL = Object.freeze(['msgpackr-extract']);

/** Prepended to the bundle: the archive root (`bin/..`) and the URL of a path under `lib/`. */
const BANNER = `"use strict";
var __erdenPath = require("node:path");
var __erdenRoot = __erdenPath.dirname(__erdenPath.dirname(__filename));
function __erdenLibUrl(path) { return require("node:url").pathToFileURL(__erdenPath.join(__erdenRoot, "lib", path)).href; }`;

/** The nearest directory at or above `file` with a package.json, and that package's name. */
function owningPackage(file) {
    let directory = dirname(file);
    while (!existsSync(join(directory, 'package.json'))) {
        const parent = dirname(directory);
        if (parent === directory) {
            throw new Error(`No package.json above ${file}`);
        }
        directory = parent;
    }
    return { directory, name: JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')).name };
}

/** Where `file` of the CLI's dependency tree sits under the archive's `lib/`. */
function libPathOf(file, cliName) {
    const { directory, name } = owningPackage(file);
    const inside = relative(directory, file).split(sep).join('/');
    return name === cliName ? inside : `node_modules/${name}/${inside}`;
}

/**
 * Bundles the CLI deployed at `lib` (or any directory laid out as its package, with dependencies resolvable from
 * it) into `outfile`. Refuses if the modules that read files beside themselves are not SIDECAR_URL_MODULES.
 * Returns the bundle's size.
 */
export async function bundleCli(lib, outfile) {
    const require = createRequire(import.meta.url);
    const esbuild = require('esbuild');
    const cliName = JSON.parse(readFileSync(join(lib, 'package.json'), 'utf8')).name;
    const rewritten = new Set();
    const plugin = {
        name: 'erden-sidecar-urls',
        setup(build) {
            // jsonc-parser's main is a UMD module whose requires esbuild cannot follow; its ESM build is the same code.
            build.onResolve({ filter: /^jsonc-parser$/ }, async (args) => {
                const manifest = await build.resolve('jsonc-parser/package.json', {
                    kind: args.kind,
                    resolveDir: args.resolveDir,
                });
                if (manifest.errors.length > 0) {
                    return { errors: manifest.errors };
                }
                return { path: join(dirname(manifest.path), 'lib', 'esm', 'main.js') };
            });
            build.onLoad({ filter: /\.[cm]?js$/ }, (args) => {
                const contents = readFileSync(args.path, 'utf8');
                if (!contents.includes('import.meta')) {
                    return undefined;
                }
                const path = libPathOf(args.path, cliName);
                // A bundled module is never the main module.
                const replaced = contents
                    .replaceAll('import.meta.url', `__erdenLibUrl(${JSON.stringify(path)})`)
                    .replaceAll('import.meta.main', 'false');
                if (contents.includes('import.meta.url')) {
                    rewritten.add(path);
                }
                return { contents: replaced, loader: 'js' };
            });
        },
    };
    const result = await esbuild.build({
        entryPoints: [join(lib, 'dist', 'sea.js')],
        absWorkingDir: lib,
        outfile,
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node24',
        // Smaller and faster to parse; names stay, as error output and schemas may read them.
        minify: true,
        keepNames: true,
        legalComments: 'eof',
        charset: 'utf8',
        banner: { js: BANNER },
        external: [...EXTERNAL],
        plugins: [plugin],
        logLevel: 'silent',
    });
    if (result.errors.length > 0) {
        throw new Error(`esbuild failed: ${JSON.stringify(result.errors)}`);
    }
    // Any other import.meta in code a CommonJS bundle would leave empty; esbuild warns of each.
    const emptied = result.warnings.filter((warning) => warning.id === 'empty-import-meta');
    if (emptied.length > 0) {
        throw new Error(`The bundle would empty import.meta: ${JSON.stringify(emptied.map((w) => w.location))}`);
    }
    const found = [...rewritten].sort();
    const expected = [...SIDECAR_URL_MODULES].sort();
    if (JSON.stringify(found) !== JSON.stringify(expected)) {
        throw new Error(
            `The modules that read files beside themselves changed; review SIDECAR_URL_MODULES and the sidecar tree:\n` +
                `found ${found.join(', ')}\nlisted ${expected.join(', ')}`,
        );
    }
    return { bytes: statSync(outfile).size };
}

/**
 * The packages whose files the bundle reads from disk, as directories under `lib/node_modules`: the engine resolvers
 * (their fixtures, and createRequire bases for the platform packages), this platform's engine packages, oxigraph, and
 * n3 and rdf-canonize with the packages they depend on, which the RDF comparison Worker imports by path.
 */
export function sidecarPackages(lib, enginePackages) {
    const modules = join(lib, 'node_modules');
    const packages = new Set(['@erden/reasoner-distribution', '@erden/shacl-distribution', ...enginePackages]);
    const queue = ['n3', 'rdf-canonize'];
    while (queue.length > 0) {
        const name = queue.shift();
        if (packages.has(name)) {
            continue;
        }
        const manifestPath = join(modules, ...name.split('/'), 'package.json');
        if (!existsSync(manifestPath)) {
            throw new Error(`The sidecar needs ${name}, which the deployed tree does not hold at its top level`);
        }
        packages.add(name);
        queue.push(...Object.keys(JSON.parse(readFileSync(manifestPath, 'utf8')).dependencies ?? {}));
    }
    return [...packages].sort();
}

/** oxigraph's files the bundle reads: its manifest, the Node.js glue and its WebAssembly, and its license files. */
function oxigraphFiles(modules) {
    const directory = join(modules, 'oxigraph');
    return readdirSync(directory)
        .filter((name) => ['package.json', 'node.js', 'node_bg.wasm'].includes(name) || /^licen[cs]e/iu.test(name))
        .map((name) => `node_modules/oxigraph/${name}`);
}

/** Every file of `directory`, as paths under `base`, sorted. */
function filesUnder(base, directory) {
    return readdirSync(join(base, directory), { withFileTypes: true, recursive: true })
        .filter((entry) => entry.isFile())
        .map((entry) => relative(base, join(entry.parentPath, entry.name)).split(sep).join('/'))
        .sort();
}

/**
 * The allowlist of the sidecar `lib/`: every file, as a path under `lib`, that the bundled CLI reads from disk. The
 * deny rules of prune.mjs still apply to it (no TypeScript, declarations or source maps).
 */
export function sidecarFiles(lib, enginePackages) {
    const modules = join(lib, 'node_modules');
    const files = ['package.json', ...oxigraphFiles(modules)];
    for (const name of sidecarPackages(lib, enginePackages)) {
        files.push(...filesUnder(lib, join('node_modules', ...name.split('/'))));
    }
    return [...new Set(files)].sort();
}
