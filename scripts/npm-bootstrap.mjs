// The one-time npm setup the release workflow's trusted publishing needs, run by hand by an owner of the erden-sh npm
// organization. npm sets up a trusted publisher only for a package that already exists, so:
//
// 1. `node scripts/npm-bootstrap.mjs` publishes the npm packages of an already published release (by default the
//    version in apps/cli/package.json) from its GitHub release archives, built, packed and checked exactly as
//    release.yml does (release/npm-packages.mjs), with your npm sign-in (`npm login` first). These versions have no
//    provenance statement: only a CI run can sign one. A version already on the registry is skipped. --dry-run runs
//    `npm publish --dry-run` instead, and needs no sign-in.
// 2. `node scripts/npm-bootstrap.mjs --trust` makes release.yml, in its `npm` environment, the trusted publisher of
//    every package (`npm trust github`, npm 11.15.0 or later, two-factor authentication on the account). npm drops a
//    trusted publisher that has not published within 2 days, so run this just before the release that should publish,
//    then set the repository variable NPM_PUBLISH to true. --dry-run prints the commands without running them.
//
// Usage: node scripts/npm-bootstrap.mjs [--version <version>] [--assets <dir>] [--dry-run]
//        node scripts/npm-bootstrap.mjs --trust [--dry-run]
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { RELEASE_PLATFORMS } from '../release/lib/platforms.mjs';
import {
    MAIN_PACKAGE,
    NPM_REGISTRY,
    buildNpmPackages,
    downloadReleaseArchives,
    platformPackageName,
    publishNpmPackages,
} from '../release/npm-packages.mjs';

const root = resolve(import.meta.dirname, '..');

/** The trusted publisher release.yml needs on every package. */
export const TRUSTED_PUBLISHER = Object.freeze({
    repository: 'erden-sh/erden',
    workflow: 'release.yml',
    environment: 'npm',
});

function npm(args, options = {}) {
    return spawnSync('npm', args, {
        encoding: 'utf8',
        env: { ...process.env, npm_config_update_notifier: 'false', npm_config_fund: 'false' },
        ...options,
    });
}

/** Refuses unless this npm is `minimum` or later. */
function requireNpm(minimum, reason) {
    const version = npm(['--version']).stdout.trim();
    const [a, b, c] = version.split('.').map(Number);
    const [x, y, z] = minimum.split('.').map(Number);
    if (a < x || (a === x && (b < y || (b === y && c < z)))) {
        throw new Error(
            `${reason} needs npm ${minimum} or later; this is npm ${version} (npm install -g npm@^${minimum})`,
        );
    }
}

/** The packages, platform packages first, as release.yml publishes them. */
function packageNames() {
    return [...Object.keys(RELEASE_PLATFORMS).sort().map(platformPackageName), MAIN_PACKAGE];
}

/** The `npm trust github` arguments of every package. */
export function trustCommands() {
    return packageNames().map((name) => [
        'trust',
        'github',
        name,
        '--file',
        TRUSTED_PUBLISHER.workflow,
        '--repo',
        TRUSTED_PUBLISHER.repository,
        '--env',
        TRUSTED_PUBLISHER.environment,
        '--allow-publish',
        '--registry',
        NPM_REGISTRY,
        '--yes',
    ]);
}

function trust(dryRun) {
    const commands = trustCommands();
    if (dryRun) {
        for (const args of commands) {
            process.stdout.write(`npm ${args.join(' ')}\n`);
        }
        return;
    }
    requireNpm('11.15.0', 'npm trust');
    for (const [index, args] of commands.entries()) {
        if (index > 0) {
            // npm asks for a pause between trust calls, against its rate limit.
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
        }
        const child = npm(args, { stdio: 'inherit' });
        if (child.status !== 0) {
            throw new Error(`npm ${args.join(' ')} failed (${String(child.status)})`);
        }
    }
    process.stdout.write(
        `Every package now trusts ${TRUSTED_PUBLISHER.repository}'s ${TRUSTED_PUBLISHER.workflow} in the ` +
            `${TRUSTED_PUBLISHER.environment} environment. Set the repository variable NPM_PUBLISH to true, and ` +
            'release within 2 days, before npm drops an unused trusted publisher.\n',
    );
}

async function publish({ version, assets, dryRun }) {
    if (!dryRun) {
        const whoami = npm(['whoami', '--registry', NPM_REGISTRY]);
        if (whoami.status !== 0) {
            throw new Error(`Sign in to ${NPM_REGISTRY} first (npm login), as an owner of the erden-sh organization`);
        }
    }
    const work = mkdtempSync(join(tmpdir(), 'erden-npm-bootstrap-'));
    try {
        let archives = assets;
        if (archives === undefined) {
            archives = join(work, 'assets');
            await downloadReleaseArchives(version, archives);
        }
        const packages = buildNpmPackages({
            assets: archives,
            version,
            out: join(work, 'packages'),
            packInto: join(work, 'tarballs'),
        });
        for (const entry of packages) {
            process.stdout.write(`packed ${entry.name}@${version} (${String(entry.files)} files, verified)\n`);
        }
        publishNpmPackages(packages, version, { dryRun });
    } finally {
        rmSync(work, { recursive: true, force: true });
    }
}

async function main() {
    const { values } = parseArgs({
        options: {
            version: { type: 'string' },
            assets: { type: 'string' },
            trust: { type: 'boolean', default: false },
            'dry-run': { type: 'boolean', default: false },
        },
    });
    if (values.trust) {
        trust(values['dry-run']);
        return;
    }
    await publish({
        version: values.version ?? JSON.parse(readFileSync(join(root, 'apps/cli/package.json'), 'utf8')).version,
        assets: values.assets === undefined ? undefined : resolve(values.assets),
        dryRun: values['dry-run'],
    });
}

if (import.meta.main) {
    await main();
}
