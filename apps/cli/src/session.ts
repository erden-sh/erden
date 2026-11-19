// What the CLI does around every command, for telemetry and the update notice, without ever slowing a command down or
// changing its result: before it, the one-time telemetry notice; after it, the update notice from the last stored
// check, then a detached background process (background.ts) that sends the queued events and refreshes the update
// check. The command's exit code is the same whatever happens here; every failure in this file is swallowed.
//
// Events go into a small queue file (telemetry-queue.jsonl in the state directory), and a sender is started at most
// once a second (background.lock holds when the last one started), so a script running erden in a tight loop does not start a
// process per command: an event queued while a sender runs goes with the next one.
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { releaseChannel, type Installation } from './installation.js';
import {
    TELEMETRY_EVENT_SCHEMA,
    TELEMETRY_NOTICE,
    TELEMETRY_ORIGIN,
    newTelemetryState,
    optOutSet,
    readTelemetryState,
    telemetryCommandName,
    telemetryOutcome,
    telemetryStatePath,
    telemetryStatus,
    writeTelemetryState,
    type Environment,
    type TelemetryEvent,
} from './telemetry.js';
import {
    UPDATE_CHECK_INTERVAL_MS,
    readUpdateCheck,
    releasesOrigin,
    testingOrigin,
    updateCheckPath,
    updateEndpoint,
    updateNotice,
    updateNoticeAllowed,
    writeUpdateCheck,
} from './updates.js';

export const TELEMETRY_QUEUE_FILE = 'telemetry-queue.jsonl';
export const BACKGROUND_LOCK_FILE = 'background.lock';
/** A queue this large is not added to: events are dropped rather than piled up while offline. */
export const MAXIMUM_QUEUE_BYTES = 64 * 1024;
const SENDER_INTERVAL_MS = 1000;

/** What the background process does; passed to it as one base64url JSON argument. */
export interface BackgroundJob {
    readonly schema: 'erden.background-job/v2';
    readonly userAgent: string;
    /** Send the events queued in `path` to `url`. */
    readonly events?: { readonly url: string; readonly path: string };
    readonly updateCheck?: {
        readonly url: string;
        readonly path: string;
        readonly channel: 'stable' | 'canary';
    };
}

export interface SessionDependencies {
    readonly environment: Environment;
    readonly platform: string;
    readonly arch: string;
    readonly version: string;
    readonly userAgent: string;
    readonly installation: Installation;
    readonly stateDirectory: string | undefined;
    readonly stdoutIsTty: boolean;
    readonly stderrIsTty: boolean;
    readonly stderr: (text: string) => void;
    readonly now: () => number;
    readonly spawnBackground: (job: BackgroundJob) => void;
}

export interface Session {
    /** Call once the command has returned (`undefined` when it threw). Never throws. */
    readonly finish: (exitCode: number | undefined, durationMs: number) => void;
}

/** The telemetry endpoint's origin; ERDEN_TELEMETRY_ORIGIN replaces it for testing against a local Worker. */
export function telemetryOrigin(environment: Environment): string {
    return testingOrigin(environment.ERDEN_TELEMETRY_ORIGIN, TELEMETRY_ORIGIN);
}

interface SessionStart {
    /** Set when this run sends an event: telemetry is on and its notice was shown on an earlier run. */
    readonly installId: string | undefined;
    /** Whether telemetry is on, which decides which update address is asked. */
    readonly telemetryOn: boolean;
    /** True on the run that shows the notice: nothing at all leaves the machine on that run. */
    readonly noticeRun: boolean;
}

export function beginSession(arguments_: ReadonlyArray<string>, dependencies: SessionDependencies): Session {
    const command = telemetryCommandName(arguments_);
    const directory = dependencies.stateDirectory;
    let start: SessionStart = { installId: undefined, telemetryOn: false, noticeRun: false };
    try {
        const statePath = directory === undefined ? undefined : telemetryStatePath(directory);
        const state = statePath === undefined ? null : readTelemetryState(statePath);
        const status = telemetryStatus(
            dependencies.environment,
            state,
            dependencies.installation,
            directory !== undefined,
        );
        if (status.enabled && statePath !== undefined && (state === null || !state.noticeShown)) {
            if (command !== 'telemetry') {
                // The notice comes first and this run sends nothing, so it can be turned off before anything is sent.
                dependencies.stderr(TELEMETRY_NOTICE);
                writeTelemetryState(statePath, newTelemetryState(true, true, state));
            }
            start = { installId: undefined, telemetryOn: true, noticeRun: true };
        } else {
            start = {
                installId: status.enabled ? state?.installId : undefined,
                telemetryOn: status.enabled,
                noticeRun: false,
            };
        }
    } catch {
        // A state that cannot be read or written: nothing is sent this run.
        start = { installId: undefined, telemetryOn: false, noticeRun: true };
    }
    return Object.freeze({
        finish(exitCode: number | undefined, durationMs: number): void {
            try {
                finishSession(command, start, exitCode, durationMs, dependencies);
            } catch {
                // Telemetry and the update notice never change a command's result.
            }
        },
    });
}

function queueEvent(path: string, body: TelemetryEvent): boolean {
    let size = 0;
    try {
        size = statSync(path).size;
    } catch {
        size = 0;
    }
    if (size > MAXIMUM_QUEUE_BYTES) {
        return false;
    }
    mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
    appendFileSync(path, `${JSON.stringify(body)}\n`, { mode: 0o600 });
    return true;
}

/** Whether a sender started less than a second ago (background.lock holds its start time); records this start when not. */
function senderRecentlyStarted(directory: string, now: number): boolean {
    const lock = join(directory, BACKGROUND_LOCK_FILE);
    try {
        const elapsed = now - Number(readFileSync(lock, 'utf8'));
        if (elapsed >= 0 && elapsed < SENDER_INTERVAL_MS) {
            return true;
        }
    } catch {
        // No lock yet.
    }
    writeFileSync(lock, String(now), { mode: 0o600 });
    return false;
}

function finishSession(
    command: ReturnType<typeof telemetryCommandName>,
    start: SessionStart,
    exitCode: number | undefined,
    durationMs: number,
    dependencies: SessionDependencies,
): void {
    const directory = dependencies.stateDirectory;
    if (directory === undefined || start.noticeRun) {
        return;
    }
    const channel = releaseChannel(dependencies.version);
    let events: BackgroundJob['events'];
    if (start.installId !== undefined && command !== 'telemetry') {
        const body: TelemetryEvent = {
            schema: TELEMETRY_EVENT_SCHEMA,
            installId: start.installId,
            version: dependencies.version,
            channel,
            os: dependencies.platform,
            arch: dependencies.arch,
            command,
            outcome: telemetryOutcome(exitCode),
            durationMs: Math.max(0, Math.min(86_400_000, Math.round(durationMs))),
        };
        const queue = join(directory, TELEMETRY_QUEUE_FILE);
        if (optOutSet(dependencies.environment.ERDEN_TELEMETRY_DEBUG)) {
            dependencies.stderr(`Erden telemetry (debug, not sent): ${JSON.stringify(body)}\n`);
        } else if (queueEvent(queue, body)) {
            events = { url: `${telemetryOrigin(dependencies.environment)}/v1/events`, path: queue };
        }
    }
    let updateCheck: BackgroundJob['updateCheck'];
    if (
        dependencies.installation.method !== 'source' &&
        command !== 'upgrade' &&
        command !== 'telemetry' &&
        updateNoticeAllowed(dependencies.environment, dependencies.stdoutIsTty, dependencies.stderrIsTty)
    ) {
        const path = updateCheckPath(directory);
        const check = readUpdateCheck(path);
        const notice = updateNotice(check, dependencies.version, channel, dependencies.installation.method);
        if (notice !== null) {
            dependencies.stderr(notice);
        }
        const now = dependencies.now();
        if (check === null || check.channel !== channel || now - check.checkedAt >= UPDATE_CHECK_INTERVAL_MS) {
            // Stored before the check runs, so runs in the meantime do not start another one.
            writeUpdateCheck(path, {
                schema: 'erden.update-check/v1',
                checkedAt: now,
                channel,
                latest: check?.channel === channel ? check.latest : null,
            });
            updateCheck = {
                url: updateEndpoint(
                    releasesOrigin(dependencies.environment),
                    channel,
                    start.telemetryOn
                        ? { platform: dependencies.platform, arch: dependencies.arch, version: dependencies.version }
                        : null,
                ),
                path,
                channel,
            };
        }
    }
    if (events === undefined && updateCheck === undefined) {
        return;
    }
    const recent = senderRecentlyStarted(directory, dependencies.now());
    if (updateCheck === undefined && recent) {
        return;
    }
    dependencies.spawnBackground({
        schema: 'erden.background-job/v2',
        userAgent: dependencies.userAgent,
        ...(events === undefined ? {} : { events }),
        ...(updateCheck === undefined ? {} : { updateCheck }),
    });
}

/** Starts background.js detached, in the temporary directory, with no stdio, so this process exits without waiting. */
export function spawnNodeBackground(job: BackgroundJob): void {
    const script = fileURLToPath(new URL('./background.js', import.meta.url));
    const child = spawn(process.execPath, [script, Buffer.from(JSON.stringify(job), 'utf8').toString('base64url')], {
        cwd: tmpdir(),
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
    });
    child.on('error', () => undefined);
    child.unref();
}
