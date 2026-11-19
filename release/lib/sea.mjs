// The archive tree of a single executable application: `bin/erden` (`bin\erden.exe` on Windows) is the pinned Node.js
// with the bundled CLI injected, `bin/den` the companion command that runs it, and `lib/` the sidecar files the CLI
// reads from disk (bundle.mjs). The executable is Node.js itself, so `erden doctor`'s Node.js pin, the worker resource
// limits and the permission model are Node's own.
//
// The steps, on the platform the archive is for (the blob's code cache is that Node.js's V8):
// 1. The bundle becomes a SEA blob, with a V8 code cache so the CLI starts without compiling its JavaScript, written
//    under --predictable so that it is the same on every build.
// 2. The Node.js executable is copied and prepared: its symbol tables stripped on Linux (`strip --strip-all`; the
//    dynamic symbols stay) and on macOS (`strip -x`, after its signature is removed; the exported symbols stay); on
//    Windows, which has no symbols in the executable, its Authenticode signature is removed, as the injection would
//    leave it invalid.
// 3. postject injects the blob. On macOS the executable is then signed ad hoc (`codesign -s -`), as Apple silicon runs
//    only signed code; a Developer ID signature replaces that once there is a certificate.
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { bundleCli, sidecarFiles } from './bundle.mjs';
import { pruneDeployedTree } from './prune.mjs';

/** The fuse Node.js looks for to know a blob was injected (the same in every Node.js release with SEA). */
export const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

function run(command, args, options = {}) {
    const child = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 1 << 26, ...options });
    if (child.status !== 0) {
        throw new Error(
            `${command} ${args.join(' ')} failed (${String(child.status)}): ${child.error?.message ?? ''}${child.stderr}${child.stdout}`,
        );
    }
    return child.stdout;
}

/**
 * Removes a PE file's Authenticode signature: the certificate table the security data directory names, which a
 * signed file ends with, and that directory entry. Returns the bytes removed (0 for an unsigned file).
 */
export function removeAuthenticodeSignature(path) {
    const bytes = readFileSync(path);
    const pe = bytes.readUInt32LE(0x3c);
    if (bytes.readUInt32LE(pe) !== 0x00004550) {
        throw new Error(`${path} is not a PE file`);
    }
    const optional = pe + 24;
    const magic = bytes.readUInt16LE(optional);
    const directories = optional + (magic === 0x20b ? 112 : 96);
    const entry = directories + 4 * 8;
    const offset = bytes.readUInt32LE(entry);
    const size = bytes.readUInt32LE(entry + 4);
    if (size === 0) {
        return 0;
    }
    if (offset + size !== bytes.length) {
        throw new Error(`${path}: its signature is not at its end; refusing to cut it`);
    }
    const unsigned = Buffer.from(bytes.subarray(0, offset));
    unsigned.writeUInt32LE(0, entry);
    unsigned.writeUInt32LE(0, entry + 4);
    writeFileSync(path, unsigned);
    return size;
}

/** Prepares the copied Node.js executable for injection (step 2); returns how, for the build record. */
function prepareExecutable(path, os) {
    if (os === 'linux') {
        run('strip', ['--strip-all', path]);
        return { strip: run('strip', ['--version']).split('\n')[0].trim(), mode: '--strip-all' };
    }
    if (os === 'darwin') {
        run('codesign', ['--remove-signature', path]);
        run('strip', ['-x', path]);
        return { strip: 'strip (Xcode)', mode: '-x; signed ad hoc after injection' };
    }
    const removed = removeAuthenticodeSignature(path);
    return { strip: null, mode: `no symbols to strip; Authenticode signature removed (${String(removed)} bytes)` };
}

const POSIX_DEN = `#!/bin/sh
# den: the companion command of erden. Runs the erden beside this file; links to this file are followed to find it.
set -e
self=$0
while [ -L "$self" ]; do
    link=$(readlink "$self")
    case $link in
        /*) self=$link ;;
        *) self=$(dirname "$self")/$link ;;
    esac
done
exec "$(cd "$(dirname "$self")" && pwd -P)/erden" "$@"
`;

const WINDOWS_DEN = `@echo off\r
rem den: the companion command of erden. Runs the erden.exe beside this file.\r
"%~dp0erden.exe" %*\r
`;

/**
 * Writes the single-executable tree at `stage` (bin/, lib/) from a deployed CLI at `deployed` and the Node.js
 * executable `node` of `os`. `enginePackages` are this platform's engine packages (`@erden/<name>`), already holding
 * their binaries; `work` is an empty directory for the intermediate files. Returns the build record's details.
 */
export async function writeSeaTree({ deployed, node, os, enginePackages, stage, work }) {
    mkdirSync(work, { recursive: true });
    const bundle = join(work, 'erden.cjs');
    const bundled = await bundleCli(deployed, bundle);
    const blob = join(work, 'erden.blob');
    const config = join(work, 'sea-config.json');
    writeFileSync(
        config,
        // Paths relative to `work`: the blob records the main script's path, which must not name the build directory.
        `${JSON.stringify({ main: 'erden.cjs', output: 'erden.blob', disableExperimentalSEAWarning: true, useCodeCache: true, useSnapshot: false })}\n`,
    );
    // V8 writes its code cache from whatever its background threads and random seeds left compiled, so two blobs of the
    // same bundle differ; under --predictable (one thread, fixed seeds) they are byte-identical. The cache is still
    // accepted when the executable runs without it: `erden help` starts as fast as with an unpredictable cache.
    run(node, ['--predictable', '--experimental-sea-config', config], { cwd: work });

    const lib = join(stage, 'lib');
    const files = sidecarFiles(deployed, enginePackages);
    for (const file of files) {
        mkdirSync(dirname(join(lib, file)), { recursive: true });
        copyFileSync(join(deployed, file), join(lib, file));
    }
    pruneDeployedTree(
        lib,
        enginePackages.map((name) => `node_modules/${name}`),
    );

    const bin = join(stage, 'bin');
    mkdirSync(bin, { recursive: true });
    const executable = join(bin, os === 'win32' ? 'erden.exe' : 'erden');
    copyFileSync(node, executable);
    chmodSync(executable, 0o755);
    const prepared = prepareExecutable(executable, os);
    const { inject } = createRequire(import.meta.url)('postject');
    await inject(executable, 'NODE_SEA_BLOB', readFileSync(blob), {
        sentinelFuse: SEA_FUSE,
        ...(os === 'darwin' ? { machoSegmentName: 'NODE_SEA' } : {}),
    });
    if (os === 'darwin') {
        run('codesign', ['--sign', '-', '--force', executable]);
    }
    chmodSync(executable, 0o755);
    if (os === 'win32') {
        writeFileSync(join(bin, 'den.cmd'), WINDOWS_DEN);
    } else {
        writeFileSync(join(bin, 'den'), POSIX_DEN);
        chmodSync(join(bin, 'den'), 0o755);
    }
    return {
        bundleBytes: bundled.bytes,
        blobBytes: readFileSync(blob).length,
        sidecarFiles: files.length,
        executable: prepared,
    };
}
