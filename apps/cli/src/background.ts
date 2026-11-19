// The detached process session.ts starts after a command: it sends the command's telemetry event and refreshes the
// stored update check, each with a short timeout, then exits. It prints nothing and its failures go nowhere; the
// command it follows has already exited. It imports nothing but the small modules it needs, so it starts quickly.
import type { BackgroundJob } from './session.js';
import { fetchChannelRelease, writeUpdateCheck } from './updates.js';

const TIMEOUT_MS = 5000;

async function sendEvent(job: BackgroundJob): Promise<void> {
    if (job.event === undefined) {
        return;
    }
    const response = await fetch(job.event.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': job.userAgent },
        body: JSON.stringify(job.event.body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: 'error',
    });
    await response.body?.cancel();
}

async function checkForUpdate(job: BackgroundJob): Promise<void> {
    if (job.updateCheck === undefined) {
        return;
    }
    const release = await fetchChannelRelease(job.updateCheck.url, job.userAgent, fetch, TIMEOUT_MS);
    writeUpdateCheck(job.updateCheck.path, {
        schema: 'erden.update-check/v1',
        checkedAt: Date.now(),
        channel: job.updateCheck.channel,
        latest: release.version,
    });
}

export async function runBackgroundJob(encoded: string | undefined): Promise<void> {
    if (encoded === undefined) {
        return;
    }
    const job = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Partial<BackgroundJob>;
    if (job.schema !== 'erden.background-job/v1' || typeof job.userAgent !== 'string') {
        return;
    }
    const complete = job as BackgroundJob;
    await Promise.allSettled([sendEvent(complete), checkForUpdate(complete)]);
}

if (import.meta.main) {
    try {
        await runBackgroundJob(process.argv[2]);
    } catch {
        // Nothing to report to: the command this follows has exited.
    }
}
