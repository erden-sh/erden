import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { COMPLETION_SHELLS, completionScript, completionTable } from '../src/completions.js';
import { CLI_EXIT, CLI_HELP, runCli, type CliRuntime } from '../src/index.js';

function capture(): { runtime: CliRuntime; stdout: string[]; stderr: string[] } {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const runtime = {
        cwd: () => tmpdir(),
        stdout: { write: (text: string) => void stdout.push(text) },
        stderr: { write: (text: string) => void stderr.push(text) },
    } as unknown as CliRuntime;
    return { runtime, stdout, stderr };
}

function available(command: string, args: ReadonlyArray<string>): boolean {
    return spawnSync(command, args, { encoding: 'utf8' }).status === 0;
}

/** Runs `body` in `shell` with the completion script for it saved to a file named by $SCRIPT. */
function inShell(shell: string, args: ReadonlyArray<string>, script: string, body: string): string {
    const directory = mkdtempSync(join(tmpdir(), 'erden-completions-'));
    try {
        const file = join(directory, 'completion');
        writeFileSync(file, script);
        const result = spawnSync(shell, [...args, body], {
            encoding: 'utf8',
            env: { PATH: process.env.PATH, HOME: directory, SCRIPT: file },
        });
        expect(result.stderr).toBe('');
        expect(result.status).toBe(0);
        return result.stdout;
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
}

describe('erden completions', () => {
    it('reads the commands, subcommands and flags from the help', () => {
        const table = completionTable(CLI_HELP);
        const names = table.commands.map((command) => command.name);
        for (const name of [
            'init',
            'check',
            'install',
            'pack',
            'publish',
            'store',
            'doctor',
            'upgrade',
            'telemetry',
            'completions',
            'help',
        ]) {
            expect(names).toContain(name);
        }
        expect(table.globalFlags).toEqual(expect.arrayContaining(['--version', '--help']));
        function command(name: string) {
            return table.commands.find((entry) => entry.name === name);
        }
        expect(command('store')?.subcommands).toEqual(['path', 'status', 'prune']);
        expect(command('check')?.subcommands).toEqual([]);
        expect(command('completions')?.subcommands).toEqual(['bash', 'zsh', 'fish', 'powershell']);
        expect(command('pack')?.subcommands).toEqual([]);
        expect(command('telemetry')?.subcommands).toEqual(['status', 'enable', 'disable']);
        expect(command('upgrade')?.flags).toEqual([
            { name: '--channel', takesValue: true, values: ['stable', 'canary'] },
            { name: '--check', takesValue: false, values: [] },
        ]);
        expect(command('init')?.flags).toContainEqual({
            name: '--format',
            takesValue: true,
            values: ['json', 'jsonc', 'yml', 'yaml', 'toml'],
        });
        expect(command('publish')?.flags).toContainEqual({
            name: '--visibility',
            takesValue: true,
            values: ['public', 'private'],
        });
        expect(command('query')?.flags).toContainEqual({ name: '--file', takesValue: true, values: [] });
        expect(command('query')?.flags).toContainEqual({ name: '--stdin', takesValue: false, values: [] });
        expect(command('store')?.flags).toContainEqual({ name: '--dry-run', takesValue: false, values: [] });
    });

    it.each([...COMPLETION_SHELLS, 'pwsh'])('writes a %s script on stdout', async (shell) => {
        const captured = capture();
        expect(await runCli(['completions', shell], captured.runtime)).toBe(CLI_EXIT.success);
        expect(captured.stderr).toEqual([]);
        expect(captured.stdout).toEqual([completionScript(shell, CLI_HELP)]);
        expect(captured.stdout[0]).toMatch(/\berden\b[\s\S]*\bden\b/u);
    });

    it.each([[[]], [['tcsh']], [['bash', 'zsh']]])('refuses %j as a usage error', async (args) => {
        const captured = capture();
        expect(await runCli(['completions', ...args], captured.runtime)).toBe(CLI_EXIT.usage);
        expect(captured.stdout).toEqual([]);
        expect(captured.stderr.join('')).toContain('completions requires one shell: bash, zsh, fish, powershell');
    });

    it.skipIf(!available('bash', ['-c', 'true']))('completes commands, subcommands, flags and values in bash', () => {
        const script = completionScript('bash', CLI_HELP) ?? '';
        function complete(...words: string[]): string {
            return inShell(
                'bash',
                ['-c'],
                script,
                `source "$SCRIPT"; COMP_WORDS=(${words.map((word) => `'${word}'`).join(' ')}); COMP_CWORD=${String(words.length - 1)}; _erden; echo "\${COMPREPLY[*]}"`,
            ).trim();
        }
        expect(complete('erden', 'st')).toBe('store');
        expect(complete('den', 'comp')).toBe('completions');
        expect(complete('erden', '--v')).toBe('--version');
        expect(complete('erden', 'store', '')).toBe('path status prune');
        expect(complete('erden', 'store', 'prune', '--d')).toBe('--dry-run');
        expect(complete('erden', 'init', '--format', 'j')).toBe('json jsonc');
        expect(complete('erden', 'check', '--o')).toBe('--offline');
        expect(complete('erden', 'completions', '')).toBe('bash zsh fish powershell');
        expect(complete('erden', 'telemetry', 'd')).toBe('disable');
        expect(complete('erden', 'upgrade', '--channel', 'c')).toBe('canary');
        expect(complete('erden', 'query', '--file', '')).toBe('');
        expect(inShell('bash', ['-c'], script, 'source "$SCRIPT"; complete -p erden den')).toBe(
            'complete -o default -F _erden erden\ncomplete -o default -F _erden den\n',
        );
    });

    it.skipIf(!available('zsh', ['-c', 'true']))('writes a zsh script zsh can parse', () => {
        inShell('zsh', ['-n', '-c'], completionScript('zsh', CLI_HELP) ?? '', 'source "$SCRIPT"');
        expect(completionScript('zsh', CLI_HELP)).toMatch(/^#compdef erden den\n/u);
    });

    it.skipIf(!available('fish', ['-c', 'true']))('writes a fish script fish loads', () => {
        const out = inShell(
            'fish',
            ['-c'],
            completionScript('fish', CLI_HELP) ?? '',
            'source $SCRIPT; complete -C"erden st"; complete -C"den init --format j"',
        );
        expect(out).toContain('store');
        expect(out).toContain('json');
    });

    it.skipIf(!available('pwsh', ['-NoProfile', '-Command', 'exit 0']))(
        'completes through PowerShell tab expansion',
        () => {
            const out = inShell(
                'pwsh',
                ['-NoProfile', '-Command'],
                completionScript('powershell', CLI_HELP) ?? '',
                [
                    'Get-Content -Raw $env:SCRIPT | Invoke-Expression',
                    "foreach ($line in 'erden st', 'den store ', 'erden init --format j', 'erden check --o') {",
                    '    (TabExpansion2 $line $line.Length).CompletionMatches.CompletionText -join ","',
                    '}',
                ].join('\n'),
            );
            expect(out.trim().split(/\r?\n/u)).toEqual(['store', 'path,status,prune', 'json,jsonc', '--offline']);
        },
    );
});
