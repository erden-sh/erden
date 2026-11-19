import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { cleanupTestTempRoot, makeTestTempRoot } from '../../../scripts/lib/test-temp-root.mjs';
import { runBackgroundJob } from '../src/background.js';
import {
    cliUserAgent,
    describeInstallation,
    releaseChannel,
    stateDirectory,
    type Installation,
} from '../src/installation.js';
import { CLI_EXIT, runCli, type CliRuntime } from '../src/main.js';
import { beginSession, type BackgroundJob, type SessionDependencies } from '../src/session.js';
import {
    TELEMETRY_NOTICE,
    inCi,
    optOutSet,
    readTelemetryState,
    telemetryCommandName,
    telemetryOutcome,
    telemetryStatus,
} from '../src/telemetry.js';
import { compareVersions, readUpdateCheck, updateNotice, writeUpdateCheck } from '../src/updates.js';

const roots: string[] = [];
function tempRoot(): string {
    const root = makeTestTempRoot('erden-cli-telemetry-');
    roots.push(root);
    return root;
}

afterEach(() => {
    for (const root of roots.splice(0)) {
        cleanupTestTempRoot(root);
    }
});

const SCRIPT_INSTALL: Installation = { method: 'script', root: '/home/alice/.local/share/erden/0.1.0' };

interface SessionRun {
    readonly stderr: string;
    readonly jobs: BackgroundJob[];
}

function session(
    directory: string | undefined,
    overrides: Partial<SessionDependencies> = {},
    arguments_: string[] = ['check', '/home/alice/secret-project', '--offline'],
    exitCode: number | undefined = 1,
): SessionRun {
    let stderr = '';
    const jobs: BackgroundJob[] = [];
    const dependencies: SessionDependencies = {
        environment: {},
        platform: 'linux',
        arch: 'x64',
        version: '0.1.0',
        userAgent: cliUserAgent('0.1.0', 'linux', 'x64'),
        installation: SCRIPT_INSTALL,
        stateDirectory: directory,
        stdoutIsTty: true,
        stderrIsTty: true,
        stderr: (text) => {
            stderr += text;
        },
        now: () => Date.parse('2026-11-19T12:00:00Z'),
        spawnBackground: (job) => jobs.push(job),
        ...overrides,
    };
    beginSession(arguments_, dependencies).finish(exitCode, 1234.4);
    return { stderr, jobs };
}

describe('telemetry settings', () => {
    it('treats every opt-out value but empty, 0, false, no and off as set', () => {
        for (const value of ['1', 'true', 'TRUE', 'yes', 'anything']) {
            expect(optOutSet(value)).toBe(true);
        }
        for (const value of [undefined, '', '0', 'false', 'No', ' off ']) {
            expect(optOutSet(value)).toBe(false);
        }
        expect(inCi({ CI: 'true' })).toBe(true);
        expect(inCi({ GITHUB_ACTIONS: 'true' })).toBe(true);
        expect(inCi({ CI: 'false' })).toBe(false);
        expect(inCi({})).toBe(false);
    });

    it('lets DO_NOT_TRACK, ERDEN_TELEMETRY_DISABLED, CI and the setting turn telemetry off, in that order', () => {
        const state = { schema: 'erden.telemetry/v1', enabled: false, installId: 'x', noticeShown: true } as const;
        expect(
            telemetryStatus({ DO_NOT_TRACK: '1', ERDEN_TELEMETRY_DISABLED: '1' }, null, SCRIPT_INSTALL, true),
        ).toEqual({ enabled: false, reason: 'DO_NOT_TRACK' });
        expect(telemetryStatus({ ERDEN_TELEMETRY_DISABLED: 'true' }, null, SCRIPT_INSTALL, true).reason).toBe(
            'ERDEN_TELEMETRY_DISABLED',
        );
        expect(telemetryStatus({ CI: '1' }, null, SCRIPT_INSTALL, true).reason).toBe('ci');
        expect(telemetryStatus({}, state, SCRIPT_INSTALL, true).reason).toBe('disabled');
        expect(telemetryStatus({}, null, { method: 'source' }, true).reason).toBe('source-build');
        expect(telemetryStatus({}, null, SCRIPT_INSTALL, false).reason).toBe('no-state-directory');
        expect(telemetryStatus({}, null, SCRIPT_INSTALL, true)).toEqual({ enabled: true, reason: 'enabled' });
    });

    it('names commands only from the fixed list, never from what was typed', () => {
        expect(telemetryCommandName(['check', '/home/alice/project'])).toBe('check');
        expect(telemetryCommandName(['store', 'status', '--json'])).toBe('store status');
        expect(telemetryCommandName(['store', 'my-secret'])).toBe('store');
        expect(telemetryCommandName(['https://example.com/ontology'])).toBe('unknown');
        expect(telemetryCommandName(['store path'])).toBe('unknown');
        expect(telemetryCommandName(['--version'])).toBe('version');
        expect(telemetryCommandName([])).toBe('help');
        expect(telemetryCommandName(['telemetry', 'disable'])).toBe('telemetry');
        expect([0, 1, 2, 3, 70, undefined].map(telemetryOutcome)).toEqual([
            'success',
            'failure',
            'usage-error',
            'operational-error',
            'crash',
            'crash',
        ]);
    });
});

describe('the session around a command', () => {
    function queued(directory: string): unknown[] {
        const path = join(directory, 'telemetry-queue.jsonl');
        return existsSync(path)
            ? readFileSync(path, 'utf8')
                  .split('\n')
                  .filter(Boolean)
                  .map((line) => JSON.parse(line) as unknown)
            : [];
    }

    it('shows the notice once with nothing sent or checked that run, then queues only the documented fields', () => {
        const directory = tempRoot();
        const first = session(directory);
        expect(first).toEqual({ stderr: TELEMETRY_NOTICE, jobs: [] });
        expect(queued(directory)).toEqual([]);
        expect(existsSync(join(directory, 'update-check.json'))).toBe(false);
        const state = readTelemetryState(join(directory, 'telemetry.json'));
        expect(state).toMatchObject({ enabled: true, noticeShown: true });

        const second = session(directory);
        expect(second.stderr).toBe('');
        expect(queued(directory)).toEqual([
            {
                schema: 'erden.telemetry-event/v1',
                installId: state?.installId,
                version: '0.1.0',
                channel: 'stable',
                os: 'linux',
                arch: 'x64',
                command: 'check',
                outcome: 'failure',
                durationMs: 1234,
            },
        ]);
        expect(second.jobs).toEqual([
            {
                schema: 'erden.background-job/v2',
                userAgent: 'erden/0.1.0 (linux; x64)',
                events: {
                    url: 'https://telemetry.erden.sh/v1/events',
                    path: join(directory, 'telemetry-queue.jsonl'),
                },
                // Telemetry is on, so the check names this CLI, which the release Worker counts.
                updateCheck: {
                    url: 'https://erden.sh/updates/stable/linux/x64/0.1.0',
                    path: join(directory, 'update-check.json'),
                    channel: 'stable',
                },
            },
        ]);
        expect(readFileSync(join(directory, 'telemetry-queue.jsonl'), 'utf8')).not.toContain('secret-project');
    });

    it('starts at most one sender a second for events, queueing the rest', () => {
        const directory = tempRoot();
        const quiet = { stdoutIsTty: false };
        session(directory, quiet);
        function at(time: string) {
            return { ...quiet, now: () => Date.parse(time) };
        }
        expect(session(directory, at('2026-11-19T12:00:00.000Z')).jobs).toHaveLength(1);
        expect(session(directory, at('2026-11-19T12:00:00.500Z')).jobs).toEqual([]);
        expect(session(directory, at('2026-11-19T12:00:01.200Z')).jobs).toHaveLength(1);
        expect(queued(directory)).toHaveLength(3);
    });

    it('queues nothing when an opt-out applies, and checks updates only at the address that is not counted', () => {
        for (const environment of [{ ERDEN_TELEMETRY_DISABLED: '1' }, { ERDEN_TELEMETRY_DISABLED: 'yes' }]) {
            const directory = tempRoot();
            const run = session(directory, { environment });
            expect(run.stderr).toBe('');
            expect(run.jobs.map((job) => [job.events, job.updateCheck?.url])).toEqual([
                [undefined, 'https://erden.sh/updates/stable'],
            ]);
            expect(existsSync(join(directory, 'telemetry.json'))).toBe(false);
            expect(queued(directory)).toEqual([]);
        }
        const disabledByCommand = tempRoot();
        session(disabledByCommand);
        writeFileSync(
            join(disabledByCommand, 'telemetry.json'),
            JSON.stringify({ ...readTelemetryState(join(disabledByCommand, 'telemetry.json')), enabled: false }),
        );
        expect(session(disabledByCommand).jobs.map((job) => [job.events, job.updateCheck?.url])).toEqual([
            [undefined, 'https://erden.sh/updates/stable'],
        ]);
        for (const environment of [{ DO_NOT_TRACK: '1' }, { CI: 'true' }]) {
            const directory = tempRoot();
            expect(session(directory, { environment })).toEqual({ stderr: '', jobs: [] });
            expect(existsSync(join(directory, 'telemetry.json'))).toBe(false);
        }
        const source = tempRoot();
        expect(session(source, { installation: { method: 'source' } })).toEqual({ stderr: '', jobs: [] });
        expect(existsSync(join(source, 'telemetry.json'))).toBe(false);
    });

    it('sends no event for erden telemetry itself, and prints instead of sending under ERDEN_TELEMETRY_DEBUG', () => {
        const directory = tempRoot();
        session(directory);
        expect(session(directory, { stdoutIsTty: false }, ['telemetry', 'status']).jobs).toEqual([]);
        const debug = session(directory, { environment: { ERDEN_TELEMETRY_DEBUG: '1' }, stdoutIsTty: false });
        expect(debug.stderr).toContain('Erden telemetry (debug, not sent): {"schema":"erden.telemetry-event/v1"');
        expect(debug.jobs).toEqual([]);
        expect(queued(directory)).toEqual([]);
    });

    it('accepts only https or local http for the testing origins', () => {
        const directory = tempRoot();
        session(directory);
        let second = 0;
        function origins(environment: Record<string, string>) {
            second += 2000;
            const now = Date.parse('2026-11-25T00:00:00Z') + second;
            return session(directory, { environment, now: () => now }).jobs.map((job) => [
                job.events?.url,
                job.updateCheck?.url,
            ]);
        }
        expect(
            origins({
                ERDEN_TELEMETRY_ORIGIN: 'http://127.0.0.1:8788',
                ERDEN_RELEASES_ORIGIN: 'http://localhost:8789',
            }),
        ).toEqual([['http://127.0.0.1:8788/v1/events', 'http://localhost:8789/updates/stable/linux/x64/0.1.0']]);
        expect(
            origins({ ERDEN_TELEMETRY_ORIGIN: 'http://telemetry.example', ERDEN_RELEASES_ORIGIN: 'ftp://x.example' }),
        ).toEqual([['https://telemetry.erden.sh/v1/events', undefined]]);
    });

    it('checks for updates at most once a day and prints one line from the stored check', () => {
        const directory = tempRoot();
        const disabled = { stdoutIsTty: true, environment: { ERDEN_TELEMETRY_DISABLED: '1' } };
        const first = session(directory, disabled);
        expect(first.jobs).toEqual([
            {
                schema: 'erden.background-job/v2',
                userAgent: 'erden/0.1.0 (linux; x64)',
                updateCheck: {
                    url: 'https://erden.sh/updates/stable',
                    path: join(directory, 'update-check.json'),
                    channel: 'stable',
                },
            },
        ]);
        // The pending check is stored first, so the next run does not start another.
        expect(session(directory, disabled).jobs).toEqual([]);
        const path = join(directory, 'update-check.json');
        writeUpdateCheck(path, {
            schema: 'erden.update-check/v1',
            checkedAt: Date.parse('2026-11-19T11:00:00Z'),
            channel: 'stable',
            latest: '0.2.0',
        });
        const noticed = session(directory, disabled);
        expect(noticed.stderr).toBe(
            'Erden 0.2.0 is available (you have 0.1.0). Update: erden upgrade. Hide this: ERDEN_NO_UPDATE_NOTIFIER=1\n',
        );
        expect(noticed.jobs).toEqual([]);
        const later = session(directory, { ...disabled, now: () => Date.parse('2026-11-20T11:30:00Z') });
        expect(later.jobs).toHaveLength(1);
        for (const overrides of [
            { stdoutIsTty: false },
            { stderrIsTty: false },
            { environment: { ERDEN_TELEMETRY_DISABLED: '1', ERDEN_NO_UPDATE_NOTIFIER: '1' } },
            { environment: { ERDEN_TELEMETRY_DISABLED: '1', NO_UPDATE_NOTIFIER: '1' } },
            { environment: { DO_NOT_TRACK: '1' } },
            { environment: { CI: '1' } },
        ]) {
            expect(session(directory, { ...disabled, ...overrides })).toEqual({ stderr: '', jobs: [] });
        }
        expect(session(directory, disabled, ['upgrade'])).toEqual({ stderr: '', jobs: [] });
    });

    it('never fails a command when its state cannot be written', () => {
        const directory = tempRoot();
        writeFileSync(join(directory, 'blocker'), '');
        expect(() => session(join(directory, 'blocker', 'erden'))).not.toThrow();
    });
});

describe('update notices', () => {
    it('compares versions with a release above its own release candidates', () => {
        expect(compareVersions('0.2.0', '0.2.0-rc.3')).toBeGreaterThan(0);
        expect(compareVersions('0.2.0-rc.10', '0.2.0-rc.9')).toBeGreaterThan(0);
        expect(compareVersions('0.1.0', '0.1.0')).toBe(0);
        const check = {
            schema: 'erden.update-check/v1',
            checkedAt: 0,
            channel: 'canary',
            latest: '0.2.0-rc.2',
        } as const;
        expect(updateNotice(check, '0.2.0-rc.1', 'canary', 'homebrew')).toContain('brew upgrade erden');
        expect(updateNotice(check, '0.2.0-rc.1', 'stable', 'script')).toBeNull();
        expect(updateNotice(check, '0.2.0-rc.2', 'canary', 'script')).toBeNull();
        expect(releaseChannel('0.2.0-rc.1')).toBe('canary');
        expect(releaseChannel('0.2.0')).toBe('stable');
    });
});

describe('installation', () => {
    it('tells install-script, Homebrew, Scoop, hand-unpacked and source installs apart', () => {
        function probe(platform: NodeJS.Platform, root: string, environment: Record<string, string> = {}) {
            const sep = platform === 'win32' ? '\\' : '/';
            return describeInstallation({
                modulePath: [root, 'lib', 'dist', 'installation.js'].join(sep),
                execPath: [root, 'node', platform === 'win32' ? 'node.exe' : 'node'].join(sep),
                platform,
                environment,
                version: '0.1.0',
            }).method;
        }
        expect(probe('linux', '/home/alice/.local/share/erden/0.1.0', { HOME: '/home/alice' })).toBe('script');
        expect(probe('darwin', '/Users/alice/.local/share/erden/0.1.0', { HOME: '/Users/alice' })).toBe('script');
        expect(
            probe('win32', 'C:\\Users\\alice\\AppData\\Local\\Programs\\Erden\\0.1.0', {
                LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local',
            }),
        ).toBe('script');
        expect(probe('darwin', '/opt/homebrew/Cellar/erden/0.1.0/libexec', { HOME: '/Users/alice' })).toBe('homebrew');
        expect(probe('linux', '/home/linuxbrew/.linuxbrew/Cellar/erden/0.1.0', { HOME: '/home/alice' })).toBe(
            'homebrew',
        );
        expect(probe('win32', 'C:\\Users\\alice\\scoop\\apps\\erden\\0.1.0', { LOCALAPPDATA: 'C:\\x' })).toBe('scoop');
        expect(probe('linux', '/opt/erden-0.1.0', { HOME: '/home/alice' })).toBe('archive');
        expect(probe('linux', '/home/alice/.local/share/erden/0.0.9', { HOME: '/home/alice' })).toBe('archive');
        expect(
            describeInstallation({
                modulePath: '/src/erden/apps/cli/dist/installation.js',
                execPath: '/usr/bin/node',
                platform: 'linux',
                environment: { HOME: '/home/alice' },
                version: '0.1.0',
            }).method,
        ).toBe('source');
        expect(stateDirectory({ HOME: '/home/alice' }, 'linux')).toBe('/home/alice/.config/erden');
        expect(stateDirectory({ HOME: '/home/alice', XDG_CONFIG_HOME: '/x' }, 'linux')).toBe('/x/erden');
        expect(stateDirectory({ LOCALAPPDATA: 'C:\\L' }, 'win32')).toBe('C:\\L\\Erden');
        expect(stateDirectory({ HOME: 'relative' }, 'linux')).toBeUndefined();
        expect(cliUserAgent('0.1.0', 'win32', 'x64')).toBe('erden/0.1.0 (win32; x64)');
    });
});

describe('erden telemetry', () => {
    function runtime(directory: string | undefined, environment: Record<string, string> = {}) {
        let stdout = '';
        let stderr = '';
        const value = {
            cwd: () => '/',
            stdout: { write: (text: string) => (stdout += text) },
            stderr: { write: (text: string) => (stderr += text) },
            services: {} as CliRuntime['services'],
            telemetry: { environment, installation: SCRIPT_INSTALL, stateDirectory: directory },
        } as CliRuntime;
        return { value, output: () => ({ stdout, stderr }) };
    }

    it('shows, disables and enables the setting, keeping the install ID', async () => {
        const directory = tempRoot();
        const status = runtime(directory);
        expect(await runCli(['telemetry', 'status'], status.value)).toBe(CLI_EXIT.success);
        expect(status.output().stdout).toContain('Erden telemetry is enabled\n');
        const disable = runtime(directory);
        expect(await runCli(['telemetry', 'disable'], disable.value)).toBe(CLI_EXIT.success);
        expect(disable.output().stdout).toContain('Erden telemetry is disabled (erden telemetry disable)');
        const id = readTelemetryState(join(directory, 'telemetry.json'))?.installId;
        expect(id).toMatch(/^[0-9a-f-]{36}$/u);
        const enable = runtime(directory, { DO_NOT_TRACK: '1' });
        expect(await runCli(['telemetry', 'enable'], enable.value)).toBe(CLI_EXIT.success);
        expect(enable.output().stdout).toContain('disabled (DO_NOT_TRACK is set)');
        expect(enable.output().stdout).toContain('nothing is sent while the reason above applies');
        expect(readTelemetryState(join(directory, 'telemetry.json'))).toMatchObject({ enabled: true, installId: id });
        const usage = runtime(directory);
        expect(await runCli(['telemetry', 'off'], usage.value)).toBe(CLI_EXIT.usage);
        const homeless = runtime(undefined);
        expect(await runCli(['telemetry', 'disable'], homeless.value)).toBe(CLI_EXIT.operational);
    });
});

describe('the background process', () => {
    it('posts the queued events, empties the queue and stores the update check, with only the CLI User-Agent', async () => {
        const directory = tempRoot();
        const requests: Array<{ url: string; headers: IncomingMessage['headers']; body: string }> = [];
        const server = createServer((request, response) => {
            let body = '';
            request.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
            request.on('end', () => {
                requests.push({ url: request.url ?? '', headers: request.headers, body });
                if (request.url?.startsWith('/updates/')) {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.end(JSON.stringify({ schema: 'erden.cli-release/v1', version: '0.3.0', tag: 'v0.3.0' }));
                } else {
                    response.writeHead(204);
                    response.end();
                }
            });
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        const origin = `http://127.0.0.1:${String(typeof address === 'object' && address !== null ? address.port : 0)}`;
        try {
            const path = join(directory, 'update-check.json');
            const queue = join(directory, 'telemetry-queue.jsonl');
            const event = {
                schema: 'erden.telemetry-event/v1',
                installId: '3b241101-e2bb-4255-8caf-4136c566a962',
                version: '0.1.0',
                channel: 'stable',
                os: 'linux',
                arch: 'x64',
                command: 'check',
                outcome: 'success',
                durationMs: 5,
            };
            writeFileSync(queue, `${JSON.stringify(event)}\n${JSON.stringify({ ...event, command: 'pack' })}\n`);
            const job: BackgroundJob = {
                schema: 'erden.background-job/v2',
                userAgent: 'erden/0.1.0 (linux; x64)',
                events: { url: `${origin}/v1/events`, path: queue },
                updateCheck: { url: `${origin}/updates/stable/linux/x64/0.1.0`, path, channel: 'stable' },
            };
            await runBackgroundJob(Buffer.from(JSON.stringify(job)).toString('base64url'));
            expect(readUpdateCheck(path)).toMatchObject({ channel: 'stable', latest: '0.3.0' });
            expect(requests.map((request) => request.url).sort()).toEqual([
                '/updates/stable/linux/x64/0.1.0',
                '/v1/events',
                '/v1/events',
            ]);
            expect(readdirSync(directory).sort()).toEqual(['update-check.json']);
            for (const request of requests) {
                expect(request.headers['user-agent']).toBe('erden/0.1.0 (linux; x64)');
                expect(request.headers.cookie).toBeUndefined();
                expect(request.headers.authorization).toBeUndefined();
            }
            expect(
                requests
                    .filter((request) => request.url === '/v1/events')
                    .map((request) => JSON.parse(request.body) as unknown),
            ).toEqual([event, { ...event, command: 'pack' }]);
            expect(readFileSync(path, 'utf8')).not.toContain('installId');
        } finally {
            await new Promise<void>((resolve) => {
                server.close(() => {
                    resolve();
                });
            });
        }
    });
});
