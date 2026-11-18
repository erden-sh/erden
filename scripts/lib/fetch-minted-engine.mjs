// Installs an engine binary that a mint built, fetched from the release run that minted it, for a Windows or macOS host
// whose own build differs from the pin. Those builds use the runner image's linker and system libraries, which no pin
// covers, so a newer image can build other bytes from the same source; the minted bytes are what ships, so they are the
// ones to test. The artifact is the mint's own upload (`<engine>-<target>`, holding `<target>/<executable>`); its size
// and SHA-256 must be the pin's. GitHub keeps a run's artifacts for 90 days; after that, mint the engine again.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
    chmodSync,
    copyFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { warnInJobSummary } from './ci-warning.mjs';

function sha256(bytes) {
    return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/** Fetches `artifact` from run `runId`, checks `<target>/<executable>` in it against `anchor`, installs it at `destination`. */
export function installMintedBinary({ artifact, runId, target, executable, anchor, destination, reason }) {
    const repository = process.env.GITHUB_REPOSITORY;
    if (repository === undefined || process.env.GH_TOKEN === undefined || !Number.isSafeInteger(runId)) {
        throw new Error(
            `${reason}; the minted binary can be fetched only in GitHub Actions (GITHUB_REPOSITORY, GH_TOKEN) from the run ` +
                `that minted it (${String(runId)})`,
        );
    }
    warnInJobSummary(`${reason}; installing the minted binary from run ${String(runId)} instead`);
    const directory = mkdtempSync(join(realpathSync.native(tmpdir()), 'erden-minted-engine-'));
    try {
        const child = spawnSync(
            'gh',
            ['run', 'download', String(runId), '-R', repository, '-n', artifact, '-D', directory],
            {
                encoding: 'utf8',
                windowsHide: true,
            },
        );
        if (child.status !== 0) {
            throw new Error(
                `${reason}, and ${artifact} could not be fetched from run ${String(runId)} (its artifacts may have expired; ` +
                    `mint the engine again): ${child.stderr}${child.stdout}`,
            );
        }
        const fetched = join(directory, target, executable);
        if (!existsSync(fetched)) {
            throw new Error(`${artifact} from run ${String(runId)} holds no ${target}/${executable}`);
        }
        const bytes = readFileSync(fetched);
        if (bytes.length !== anchor.bytes || sha256(bytes) !== anchor.sha256) {
            throw new Error(
                `${artifact} from run ${String(runId)} is ${sha256(bytes)} (${String(bytes.length)} bytes), not the pinned ` +
                    `${anchor.sha256} (${String(anchor.bytes)} bytes)`,
            );
        }
        mkdirSync(dirname(destination), { recursive: true });
        copyFileSync(fetched, destination);
        chmodSync(destination, 0o755);
    } finally {
        rmSync(directory, { recursive: true, force: true, maxRetries: 5 });
    }
}
