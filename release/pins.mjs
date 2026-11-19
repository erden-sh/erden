// The release pins: what a mint run built, and the check a tag must pass before anything is published. A tag does not
// build: it publishes the archives the mint run uploaded, fetched from that run (mintRunId) and checked here against
// these pins. GitHub keeps a run's artifacts for 90 days, so a tag must follow its mint within that time.
//
//   node release/pins.mjs mint --artifacts <dir> --out <dir> --run-id <id> [--allow-partial]
//       Reads each platform's build record (<platform>.json, from build-cli-archive.mjs) and its archive from
//       <dir>, and writes release/pins/<version>.json under --out, for a pull request, naming the mint run (the run
//       whose archive artifacts the tag publishes). Refuses unless all six platforms are present, the records agree
//       on version, commit and epoch, and each archive is the one its record names. --allow-partial accepts fewer
//       platforms, for a local rehearsal; `verify --release` refuses such pins.
//   node release/pins.mjs verify --artifacts <dir> [--release] [--tag v<version>]
//       Refuses unless every archive in <dir> (the .tar.gz or .zip, and the .tar.xz where a platform has one) is byte for
//       byte the one release/pins/<version>.json in this checkout pins, every pinned platform is present, and each
//       record's engines are the pinned ones. --release also requires all six platforms, a .tar.xz on every platform
//       that ships one and, with --tag, that the tag names the pinned version.
//   node release/pins.mjs mint-run --version <version>
//       Prints the mint run whose archive artifacts the tag publishes.
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { RELEASE_PLATFORMS, assertPinned, sha256 } from './lib/platforms.mjs';

const release = import.meta.dirname;
const PLATFORMS = Object.keys(RELEASE_PLATFORMS).sort();

/**
 * Whether an archive build record's two builds are acceptable: identical, or, on the natively built platforms (Windows,
 * macOS) only, differing with the first kept (build-cli-archive.mjs warns about it). The pins name the kept bytes.
 */
export function acceptedBuildResult(platform, record) {
    const native = platform.startsWith('win32-') || platform.startsWith('darwin-');
    return record.result === 'byte-identical' || (native && record.result === 'native-builds-differ');
}

function readRecords(directory) {
    const records = {};
    for (const name of readdirSync(directory).sort()) {
        const platform = name.replace(/\.json$/u, '');
        if (name.endsWith('.json') && PLATFORMS.includes(platform)) {
            const record = JSON.parse(readFileSync(join(directory, name), 'utf8'));
            if (record.schema !== 'erden.cli-archive-build/v1' || record.platform !== platform) {
                throw new Error(`${name} is not a CLI archive build record for ${platform}`);
            }
            if (!acceptedBuildResult(platform, record)) {
                throw new Error(`${platform}: the two builds were not identical`);
            }
            assertPinned(join(directory, record.archive.file), record.archive, `${platform} archive`);
            if (record.xzArchive !== undefined) {
                assertPinned(join(directory, record.xzArchive.file), record.xzArchive, `${platform} .tar.xz archive`);
            }
            records[platform] = record;
        }
    }
    if (Object.keys(records).length === 0) {
        throw new Error(`No CLI archive build records in ${directory}`);
    }
    return records;
}

function single(records, field) {
    const values = new Set(Object.values(records).map((record) => JSON.stringify(record[field])));
    if (values.size !== 1) {
        throw new Error(`The platform builds disagree on ${field}`);
    }
    return JSON.parse([...values][0]);
}

/** Whether the builds are single executables; refuses records that disagree. */
function singleExecutable(records) {
    const kinds = new Set(Object.values(records).map((record) => record.singleExecutable !== undefined));
    if (kinds.size !== 1) {
        throw new Error('The platform builds disagree on the archive layout');
    }
    return [...kinds][0];
}

/** The pins file a mint writes from its build records. */
export function pinsOf(records, { allowPartial = false, mintRunId } = {}) {
    const missing = PLATFORMS.filter((platform) => records[platform] === undefined);
    if (missing.length > 0 && !allowPartial) {
        throw new Error(`No build for ${missing.join(', ')}`);
    }
    const platforms = Object.keys(records).sort();
    return {
        schema: 'erden.release-pins/v1',
        version: single(records, 'version'),
        sourceCommit: single(records, 'sourceCommit'),
        sourceDateEpoch: single(records, 'sourceDateEpoch'),
        // Each platform ships its own Node.js archive, so only the version must agree.
        node: single(
            Object.fromEntries(
                Object.entries(records).map(([platform, record]) => [platform, { node: record.node.version }]),
            ),
            'node',
        ),
        complete: missing.length === 0,
        // How the archives lay out the CLI: 'single-executable' (bin/erden is Node.js with the CLI built in) when every
        // build record says so. Pins without it are of archives that run lib/dist/bin.js with node/node.
        ...(singleExecutable(records) ? { layout: 'single-executable' } : {}),
        // The release run whose archive artifacts these pins name; the tag fetches and publishes exactly those.
        ...(mintRunId === undefined ? {} : { mintRunId }),
        archives: Object.fromEntries(platforms.map((platform) => [platform, records[platform].archive])),
        // The .tar.xz beside the .tar.gz, on the platforms that ship one; the install script prefers it.
        ...(platforms.some((platform) => records[platform].xzArchive !== undefined)
            ? {
                  xzArchives: Object.fromEntries(
                      platforms
                          .filter((platform) => records[platform].xzArchive !== undefined)
                          .map((platform) => {
                              const { file, bytes, sha256: digest } = records[platform].xzArchive;
                              return [platform, { file, bytes, sha256: digest }];
                          }),
                  ),
              }
            : {}),
        engines: Object.fromEntries(
            ['reasoner', 'shacl'].map((engine) => [
                engine,
                Object.fromEntries(platforms.map((platform) => [platform, records[platform].engines[engine].sha256])),
            ]),
        ),
    };
}

/** Every way the built records differ from the pins; empty when they match. */
export function pinDifferences(pins, records, { release: releaseMode = false } = {}) {
    const differences = [];
    if (releaseMode && pins.complete !== true) {
        differences.push('the pins were minted for fewer than every release platform');
    }
    if (releaseMode && !Number.isSafeInteger(pins.mintRunId)) {
        differences.push('the pins name no mint run to publish the archives of');
    }
    const expected = releaseMode ? PLATFORMS : Object.keys(pins.archives).sort();
    for (const platform of expected) {
        const record = records[platform];
        const pin = pins.archives[platform];
        if (pin === undefined) {
            differences.push(`${platform}: not pinned`);
            continue;
        }
        if (record === undefined) {
            differences.push(`${platform}: not built`);
            continue;
        }
        if (record.version !== pins.version) {
            differences.push(`${platform}: version ${record.version}, pinned ${pins.version}`);
        }
        if (record.sourceDateEpoch !== pins.sourceDateEpoch) {
            differences.push(`${platform}: built with another source date epoch`);
        }
        if (
            record.archive.file !== pin.file ||
            record.archive.bytes !== pin.bytes ||
            record.archive.sha256 !== pin.sha256
        ) {
            differences.push(
                `${platform}: ${record.archive.file} is ${record.archive.sha256} (${String(record.archive.bytes)} bytes), pinned ${pin.sha256} (${String(pin.bytes)} bytes)`,
            );
        }
        const xzPin = pins.xzArchives?.[platform];
        const xz = record.xzArchive;
        if (releaseMode && RELEASE_PLATFORMS[platform].xz === true && xzPin === undefined) {
            differences.push(`${platform}: no .tar.xz archive pinned`);
        } else if (xz === undefined && xzPin !== undefined) {
            differences.push(`${platform}: ${xzPin.file} pinned but not built`);
        } else if (xz !== undefined && xzPin === undefined) {
            differences.push(`${platform}: ${xz.file} built but not pinned`);
        } else if (
            xz !== undefined &&
            (xz.file !== xzPin.file || xz.bytes !== xzPin.bytes || xz.sha256 !== xzPin.sha256)
        ) {
            differences.push(
                `${platform}: ${xz.file} is ${xz.sha256} (${String(xz.bytes)} bytes), pinned ${xzPin.sha256} (${String(xzPin.bytes)} bytes)`,
            );
        }
        for (const engine of ['reasoner', 'shacl']) {
            if (record.engines[engine].sha256 !== pins.engines[engine][platform]) {
                differences.push(
                    `${platform}: the ${engine} is ${record.engines[engine].sha256}, pinned ${pins.engines[engine][platform]}`,
                );
            }
        }
    }
    for (const platform of Object.keys(records)) {
        if (!expected.includes(platform)) {
            differences.push(`${platform}: built but not pinned`);
        }
    }
    return differences;
}

export function readPins(version, root = resolve(release, '..')) {
    const path = join(root, 'release', 'pins', `${version}.json`);
    if (!existsSync(path)) {
        throw new Error(`No release pins for ${version} (${path}); mint them first`);
    }
    return JSON.parse(readFileSync(path, 'utf8'));
}

function main() {
    const { positionals, values } = parseArgs({
        allowPositionals: true,
        options: {
            artifacts: { type: 'string' },
            out: { type: 'string' },
            version: { type: 'string' },
            tag: { type: 'string' },
            release: { type: 'boolean', default: false },
            'allow-partial': { type: 'boolean', default: false },
            'run-id': { type: 'string' },
        },
    });
    const [mode] = positionals;
    if (mode === 'mint-run') {
        const { mintRunId } = readPins(values.version);
        if (!Number.isSafeInteger(mintRunId)) {
            throw new Error(`release/pins/${String(values.version)}.json names no mint run`);
        }
        process.stdout.write(`${String(mintRunId)}\n`);
        return;
    }
    if (values.artifacts === undefined || (mode !== 'mint' && mode !== 'verify')) {
        throw new Error(
            'Usage: pins.mjs mint --artifacts <dir> --out <dir> --run-id <id> | verify --artifacts <dir> [--release] [--tag <tag>] | mint-run --version <v>',
        );
    }
    const records = readRecords(resolve(values.artifacts));
    if (mode === 'mint') {
        if (values.out === undefined) {
            throw new Error('--out is required');
        }
        const mintRunId = values['run-id'] === undefined ? undefined : Number(values['run-id']);
        if (!values['allow-partial'] && !Number.isSafeInteger(mintRunId)) {
            throw new Error('--run-id (the mint run) is required');
        }
        const pins = pinsOf(records, { allowPartial: values['allow-partial'], mintRunId });
        const directory = join(resolve(values.out), 'release', 'pins');
        mkdirSync(directory, { recursive: true });
        const text = `${JSON.stringify(pins, null, 4)}\n`;
        writeFileSync(join(directory, `${pins.version}.json`), text);
        process.stdout.write(`release/pins/${pins.version}.json: ${sha256(text)}\n`);
        return;
    }
    const version = single(records, 'version');
    if (values.tag !== undefined && values.tag !== `v${version}`) {
        throw new Error(`Tag ${values.tag} does not name version ${version}`);
    }
    const differences = pinDifferences(readPins(version), records, { release: values.release });
    if (differences.length > 0) {
        throw new Error(`The builds do not match release/pins/${version}.json:\n- ${differences.join('\n- ')}`);
    }
    process.stdout.write(`Every archive and engine matches release/pins/${version}.json\n`);
}

if (import.meta.main) {
    main();
}
