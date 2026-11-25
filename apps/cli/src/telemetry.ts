// Anonymous, opt-out usage telemetry, modeled on PaceBar's and on Turborepo's first-run notice. docs/telemetry.md is the
// public description and must match this file.
//
// What one event holds (nothing else is ever sent): a random install ID, the CLI's version, release channel, OS and
// CPU architecture, the command's fixed name, its outcome category and its duration. Never a file path, project name,
// IRI, argument, username, hostname, IP address or error message.
//
// When nothing is sent:
// - DO_NOT_TRACK or ERDEN_TELEMETRY_DISABLED is set (to anything but 0, false, no or off);
// - a CI service is detected;
// - `erden telemetry disable` was run;
// - the CLI is not a release archive (a checkout, or a package built from one);
// - on the run that shows the first-run notice, so the notice always comes before any event.
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { Installation, ReleaseChannel } from './installation.js';

export type Environment = Readonly<Record<string, string | undefined>>;

export const TELEMETRY_DOCS_URL = 'https://github.com/erden-sh/erden/blob/main/docs/telemetry.md';
export const TELEMETRY_ORIGIN = 'https://telemetry.erden.sh';
export const TELEMETRY_STATE_FILE = 'telemetry.json';
export const TELEMETRY_EVENT_SCHEMA = 'erden.telemetry-event/v1';

/** The commands an event may name. Anything else is sent as `unknown`, so nothing a user typed is ever sent. */
export const TELEMETRY_COMMANDS = Object.freeze([
    'add',
    'check',
    'doctor',
    'help',
    'init',
    'install',
    'login',
    'logout',
    'pack',
    'path',
    'publication',
    'publish',
    'query',
    'remove',
    'store',
    'store path',
    'store prune',
    'store status',
    'unknown',
    'update',
    'upgrade',
    'version',
] as const);
export type TelemetryCommand = (typeof TELEMETRY_COMMANDS)[number];

export const TELEMETRY_OUTCOMES = Object.freeze([
    'success',
    'failure',
    'usage-error',
    'operational-error',
    'crash',
] as const);
export type TelemetryOutcome = (typeof TELEMETRY_OUTCOMES)[number];

export interface TelemetryEvent {
    readonly schema: typeof TELEMETRY_EVENT_SCHEMA;
    readonly installId: string;
    readonly version: string;
    readonly channel: ReleaseChannel;
    readonly os: string;
    readonly arch: string;
    readonly command: TelemetryCommand;
    readonly outcome: TelemetryOutcome;
    readonly durationMs: number;
}

/** The per-user telemetry setting, in <state directory>/telemetry.json. */
export interface TelemetryState {
    readonly schema: 'erden.telemetry/v1';
    readonly enabled: boolean;
    /** Random UUID v4. Disabling keeps it (it is then never sent), so enabling again does not count a new install. */
    readonly installId: string;
    /** Whether the first-run notice was shown (or a choice was made with `erden telemetry`). */
    readonly noticeShown: boolean;
}

export type TelemetryReason =
    | 'enabled'
    | 'DO_NOT_TRACK'
    | 'ERDEN_TELEMETRY_DISABLED'
    | 'ci'
    | 'disabled'
    | 'source-build'
    | 'no-state-directory';

/** Whether an opt-out variable is set: any value except empty, 0, false, no and off, so a mistake errs toward off. */
export function optOutSet(value: string | undefined): boolean {
    return value !== undefined && !['', '0', 'false', 'no', 'off'].includes(value.trim().toLowerCase());
}

/**
 * Variables CI services set. `CI`, `BUILD_NUMBER` and `RUN_ID` are what GitHub CLI checks (after ci-info); the rest name
 * services that set no `CI`.
 */
const CI_VARIABLES = Object.freeze([
    'CI',
    'CONTINUOUS_INTEGRATION',
    'BUILD_NUMBER',
    'RUN_ID',
    'GITHUB_ACTIONS',
    'GITLAB_CI',
    'TF_BUILD',
    'BUILDKITE',
    'CIRCLECI',
    'JENKINS_URL',
    'TEAMCITY_VERSION',
    'CODEBUILD_BUILD_ID',
    'BITBUCKET_BUILD_NUMBER',
]);

export function inCi(environment: Environment): boolean {
    return CI_VARIABLES.some((name) => optOutSet(environment[name]));
}

/** Whether telemetry is on for this run, and why; `state` is the stored setting (null before the first run). */
export function telemetryStatus(
    environment: Environment,
    state: TelemetryState | null,
    installation: Installation,
    stateDirectoryKnown: boolean,
): { readonly enabled: boolean; readonly reason: TelemetryReason } {
    if (optOutSet(environment.DO_NOT_TRACK)) {
        return { enabled: false, reason: 'DO_NOT_TRACK' };
    }
    if (optOutSet(environment.ERDEN_TELEMETRY_DISABLED)) {
        return { enabled: false, reason: 'ERDEN_TELEMETRY_DISABLED' };
    }
    if (inCi(environment)) {
        return { enabled: false, reason: 'ci' };
    }
    if (state?.enabled === false) {
        return { enabled: false, reason: 'disabled' };
    }
    if (installation.method === 'source') {
        return { enabled: false, reason: 'source-build' };
    }
    if (!stateDirectoryKnown) {
        return { enabled: false, reason: 'no-state-directory' };
    }
    return { enabled: true, reason: 'enabled' };
}

export function describeReason(reason: TelemetryReason): string {
    switch (reason) {
        case 'enabled':
            return 'enabled';
        case 'DO_NOT_TRACK':
            return 'disabled (DO_NOT_TRACK is set)';
        case 'ERDEN_TELEMETRY_DISABLED':
            return 'disabled (ERDEN_TELEMETRY_DISABLED is set)';
        case 'ci':
            return 'disabled (a CI service was detected)';
        case 'disabled':
            return 'disabled (erden telemetry disable)';
        case 'source-build':
            return 'disabled (this is not a release build)';
        case 'no-state-directory':
            return 'disabled (no home directory to keep the setting in)';
    }
}

const INSTALL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export function telemetryStatePath(directory: string): string {
    return join(directory, TELEMETRY_STATE_FILE);
}

/** The stored setting, or null when there is none or it cannot be read (the first run, in effect). */
export function readTelemetryState(path: string): TelemetryState | null {
    try {
        const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<TelemetryState>;
        if (
            value.schema === 'erden.telemetry/v1' &&
            typeof value.enabled === 'boolean' &&
            typeof value.installId === 'string' &&
            INSTALL_ID.test(value.installId) &&
            typeof value.noticeShown === 'boolean'
        ) {
            return {
                schema: value.schema,
                enabled: value.enabled,
                installId: value.installId,
                noticeShown: value.noticeShown,
            };
        }
        return null;
    } catch {
        return null;
    }
}

/** Replaces the stored setting in one rename, readable by this user only. */
export function writeTelemetryState(path: string, state: TelemetryState): void {
    writeStateFile(path, state);
}

export function writeStateFile(path: string, value: unknown): void {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const stage = `${path}.${randomUUID()}.tmp`;
    writeFileSync(stage, `${JSON.stringify(value, null, 4)}\n`, { mode: 0o600 });
    renameSync(stage, path);
}

export function newTelemetryState(enabled: boolean, noticeShown: boolean, previous: TelemetryState | null) {
    return Object.freeze({
        schema: 'erden.telemetry/v1' as const,
        enabled,
        installId: previous?.installId ?? randomUUID(),
        noticeShown,
    });
}

/** The fixed name of the command `arguments_` runs. */
export function telemetryCommandName(arguments_: ReadonlyArray<string>): TelemetryCommand | 'telemetry' {
    const [command, subcommand] = arguments_;
    if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
        return 'help';
    }
    if (command === '--version' || command === '-V' || command === 'version') {
        return 'version';
    }
    if (command === 'telemetry') {
        return 'telemetry';
    }
    if (command === 'store') {
        const name = `store ${subcommand ?? ''}`;
        return (TELEMETRY_COMMANDS as ReadonlyArray<string>).includes(name) ? (name as TelemetryCommand) : 'store';
    }
    return (TELEMETRY_COMMANDS as ReadonlyArray<string>).includes(command) && !command.includes(' ')
        ? (command as TelemetryCommand)
        : 'unknown';
}

/** The outcome category of an exit code (see CLI_EXIT); `undefined` is a command that threw. */
export function telemetryOutcome(exitCode: number | undefined): TelemetryOutcome {
    switch (exitCode) {
        case 0:
        // 4 is an answer labeled partial (`erden query`): the command did its job and said what was missing.
        case 4:
            return 'success';
        case 1:
            return 'failure';
        case 2:
            return 'usage-error';
        case 3:
            return 'operational-error';
        default:
            return 'crash';
    }
}

export const TELEMETRY_NOTICE = `Erden collects anonymous usage data to improve the CLI: the command's name, whether it worked, how long it took,
the Erden version, release channel, OS and CPU architecture, and a random install ID. It never collects file paths,
project names, IRIs, arguments or error messages. Nothing was sent from this run.
Turn it off with \`erden telemetry disable\`, ERDEN_TELEMETRY_DISABLED=1 or DO_NOT_TRACK=1.
Learn more: ${TELEMETRY_DOCS_URL}
`;
