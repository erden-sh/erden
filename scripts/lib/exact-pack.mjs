// `pnpm pack` that keeps the manifest's exact version. pnpm 11.0.9 and later drop SemVer build metadata from the
// version they pack (`0.3.0+purrdf.0.12.0.dfb1df7` becomes `0.3.0`), as npm drops it when it publishes. Erden's engine
// packages name their engine build in that metadata and their resolvers require it, so a pack whose version lost it is
// extracted, given the source version back, and packed again with npm, which keeps it. Everything else pnpm packed
// stays: the file selection and the workspace: specifiers it replaced with versions.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const isWindows = process.platform === 'win32';

function run(command, args, cwd) {
    const child = isWindows
        ? spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', [command, ...args].join(' ')], {
              cwd,
              encoding: 'utf8',
          })
        : spawnSync(command, args, { cwd, encoding: 'utf8' });
    if (child.status !== 0) {
        throw new Error(`${command} ${args.join(' ')} failed: ${child.stderr || child.stdout || child.error?.message}`);
    }
    return child.stdout;
}

/** The last JSON value a pack printed: lifecycle output can precede it. */
function packRecord(stdout) {
    for (const marker of ['\n{\n  "name":', '\n[\n  {']) {
        const index = stdout.lastIndexOf(marker);
        if (index >= 0) {
            return packRecordOf(JSON.parse(stdout.slice(index + 1)));
        }
    }
    return packRecordOf(JSON.parse(stdout));
}

function packRecordOf(result) {
    const record = Array.isArray(result) ? result[0] : result;
    if (typeof record?.name !== 'string' || typeof record.version !== 'string' || typeof record.filename !== 'string') {
        throw new Error('The pack printed no package record');
    }
    return record;
}

/**
 * Packs the workspace package in `directory` into `destination` with pnpm, with the version its manifest declares.
 * Returns its name, version and the tarball's absolute path.
 */
export function packExactVersion(directory, destination) {
    const { version } = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
    const packed = packRecord(run('pnpm', ['pack', '--json', '--pack-destination', destination], directory));
    const tarball = resolve(destination, packed.filename);
    if (packed.version === version) {
        return { name: packed.name, version, tarball };
    }
    if (version.split('+')[0] !== packed.version) {
        throw new Error(`pnpm packed ${packed.name} at ${packed.version}, not ${version}`);
    }
    const work = mkdtempSync(join(destination, '.exact-pack-'));
    try {
        run('tar', ['-xf', basename(tarball), '-C', basename(work)], destination);
        const root = join(work, 'package');
        const manifestPath = join(root, 'package.json');
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        manifest.version = version;
        writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
        rmSync(tarball);
        const repacked = packRecord(
            run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', destination], root),
        );
        if (repacked.version !== version) {
            throw new Error(`npm repacked ${packed.name} at ${repacked.version}, not ${version}`);
        }
        return { name: repacked.name, version, tarball: resolve(destination, repacked.filename) };
    } finally {
        rmSync(work, { recursive: true, force: true });
    }
}
