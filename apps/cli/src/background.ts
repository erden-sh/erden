// The detached process session.ts starts after a command: it sends the queued telemetry events and refreshes the
// stored update check, each request with a short timeout, then exits. It prints nothing and its failures go nowhere;
// the command it follows has already exited. It imports nothing but the small modules it needs, so it starts quickly.
import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, rmSync } from 'node:fs';

import type { BackgroundJob } from './session.js';
import { fetchChannelRelease, writeUpdateCheck } from './updates.js';

const TIMEOUT_MS = 5000;
/** At most this many queued events are sent by one sender; the rest of a backlog is dropped. */
const MAXIMUM_EVENTS = 50;

/** Takes the queue (a rename, so runs that queue meanwhile start a new one) and sends each event once. */
async function sendEvents(job: BackgroundJob): Promise<void> {
    if (job.events === undefined) {
        return;
    }
    const taken = `${job.events.path}.${randomUUID()}.sending`;
    try {
        renameSync(job.events.path, taken);
    } catch {
        return;
    }
    let lines: string[];
    try {
        lines = readFileSync(taken, 'utf8').split('\n').filter(Boolean).slice(0, MAXIMUM_EVENTS);
    } finally {
        rmSync(taken, { force: true });
    }
    for (const line of lines) {
        const response = await fetch(job.events.url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'user-agent': job.userAgent },
            body: line,
            signal: AbortSignal.timeout(TIMEOUT_MS),
            redirect: 'error',
        });
        await response.body?.cancel();
        if (response.status === 429) {
            return;
        }
    }
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
    if (job.schema !== 'erden.background-job/v2' || typeof job.userAgent !== 'string') {
        return;
    }
    const complete = job as BackgroundJob;
    await Promise.allSettled([sendEvents(complete), checkForUpdate(complete)]);
}

if (import.meta.main) {
    try {
        await runBackgroundJob(process.argv[2]);
    } catch {
        // Nothing to report to: the command this follows has exited.
    }
}
