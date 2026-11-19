// What the CLI does around every command, for telemetry and the update notice, without ever slowing a command down or
// changing its result: before it, the one-time telemetry notice; after it, the update notice from the last stored
// check, then one detached background process (background.ts) that sends the command's event and refreshes the update
// check. The command's exit code is the same whatever happens here; every failure in this file is swallowed.
import { spawn } from 'node:child_process';
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
    updateCheckPath,
    updateEndpoint,
    updateNotice,
    updateNoticeAllowed,
    writeUpdateCheck,
} from './updates.js';

/** What the background process does; passed to it as one base64url JSON argument. */
export interface BackgroundJob {
    readonly schema: 'erden.background-job/v1';
    readonly userAgent: string;
    readonly event?: { readonly url: string; readonly body: TelemetryEvent };
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
    const configured = environment.ERDEN_TELEMETRY_ORIGIN;
    return configured !== undefined && /^https?:\/\/[^/?#]+$/u.test(configured) ? configured : TELEMETRY_ORIGIN;
}

export function beginSession(arguments_: ReadonlyArray<string>, dependencies: SessionDependencies): Session {
    const command = telemetryCommandName(arguments_);
    const directory = dependencies.stateDirectory;
    let installId: string | undefined;
    try {
        const statePath = directory === undefined ? undefined : telemetryStatePath(directory);
        const state = statePath === undefined ? null : readTelemetryState(statePath);
        const status = telemetryStatus(
            dependencies.environment,
            state,
            dependencies.installation,
            directory !== undefined,
        );
        if (status.enabled && command !== 'telemetry' && statePath !== undefined) {
            if (state === null || !state.noticeShown) {
                // The notice comes first and this run sends nothing, so it can be turned off before any event.
                dependencies.stderr(TELEMETRY_NOTICE);
                writeTelemetryState(statePath, newTelemetryState(true, true, state));
            } else {
                installId = state.installId;
            }
        }
    } catch {
        installId = undefined;
    }
    return Object.freeze({
        finish(exitCode: number | undefined, durationMs: number): void {
            try {
                finishSession(command, installId, exitCode, durationMs, dependencies);
            } catch {
                // Telemetry and the update notice never change a command's result.
            }
        },
    });
}

function finishSession(
    command: ReturnType<typeof telemetryCommandName>,
    installId: string | undefined,
    exitCode: number | undefined,
    durationMs: number,
    dependencies: SessionDependencies,
): void {
    const channel = releaseChannel(dependencies.version);
    let event: BackgroundJob['event'];
    if (installId !== undefined && command !== 'telemetry') {
        const body: TelemetryEvent = {
            schema: TELEMETRY_EVENT_SCHEMA,
            installId,
            version: dependencies.version,
            channel,
            os: dependencies.platform,
            arch: dependencies.arch,
            command,
            outcome: telemetryOutcome(exitCode),
            durationMs: Math.max(0, Math.min(86_400_000, Math.round(durationMs))),
        };
        if (optOutSet(dependencies.environment.ERDEN_TELEMETRY_DEBUG)) {
            dependencies.stderr(`Erden telemetry (debug, not sent): ${JSON.stringify(body)}\n`);
        } else {
            event = { url: `${telemetryOrigin(dependencies.environment)}/v1/events`, body };
        }
    }
    let updateCheck: BackgroundJob['updateCheck'];
    const directory = dependencies.stateDirectory;
    if (
        directory !== undefined &&
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
                    dependencies.platform,
                    dependencies.arch,
                    dependencies.version,
                ),
                path,
                channel,
            };
        }
    }
    if (event !== undefined || updateCheck !== undefined) {
        dependencies.spawnBackground({
            schema: 'erden.background-job/v1',
            userAgent: dependencies.userAgent,
            ...(event === undefined ? {} : { event }),
            ...(updateCheck === undefined ? {} : { updateCheck }),
        });
    }
}

/** Starts background.js detached, with no stdio, so this process exits without waiting for it. */
export function spawnNodeBackground(job: BackgroundJob): void {
    const script = fileURLToPath(new URL('./background.js', import.meta.url));
    const child = spawn(process.execPath, [script, Buffer.from(JSON.stringify(job), 'utf8').toString('base64url')], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
    });
    child.on('error', () => undefined);
    child.unref();
}
