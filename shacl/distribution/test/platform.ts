import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/**
 * Checks a platform package against the reproducibility record without requiring foreign-platform executables in a
 * source checkout. The binary is never committed: shacl/qualification/build-from-source.mjs installs a byte-identical
 * build, and the tools release (release.yml) ships the minted one.
 */
export function testPlatformPackage(directory: URL): void {
    const manifest = JSON.parse(readFileSync(new URL('package.json', directory), 'utf8')) as { name: string };
    const metadata = JSON.parse(readFileSync(new URL('metadata.json', directory), 'utf8')) as {
        target: string;
        binary: { path: string; bytes: number | null; sha256: string | null };
        knownAnswer: { responseBytes: number | null; responseSha256: string | null };
    };
    const record = JSON.parse(
        readFileSync(new URL('../../qualification/binary-reproducibility.json', import.meta.url), 'utf8'),
    ) as { targets: Record<string, { runs: Array<{ bytes: number; sha256: string }> }> };
    const path = metadata.target === 'x86_64-pc-windows-msvc' ? 'bin/erden-shacl.exe' : 'bin/erden-shacl';
    const binary = new URL(path, directory);
    const minted = record.targets[metadata.target];
    describe(`${manifest.name} artifact`, () => {
        it.runIf(minted !== undefined)('pins exactly the executable the reproducibility record names', () => {
            expect(metadata.binary.path).toBe(path);
            expect(minted?.runs.map(({ bytes, sha256 }) => ({ bytes, sha256 }))).toEqual([
                { bytes: metadata.binary.bytes, sha256: metadata.binary.sha256 },
                { bytes: metadata.binary.bytes, sha256: metadata.binary.sha256 },
            ]);
        });
        // A platform added after the engine was minted has no build in the record until the next mint.
        it.runIf(minted === undefined)('carries null pins until a mint builds it', () => {
            expect(metadata.binary).toEqual({ path, bytes: null, sha256: null });
            expect(metadata.knownAnswer).toMatchObject({ responseBytes: null, responseSha256: null });
        });
        it.skipIf(!existsSync(binary))(
            'holds the pinned executable (skipped when none is installed: build-from-source.mjs, or a tools release)',
            () => {
                const bytes = readFileSync(binary);
                expect(bytes.byteLength).toBe(metadata.binary.bytes);
                expect(`sha256:${createHash('sha256').update(bytes).digest('hex')}`).toBe(metadata.binary.sha256);
            },
        );
    });
}
