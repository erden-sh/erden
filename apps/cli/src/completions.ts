// Shell completion scripts for `erden completions <shell>`. The commands, subcommands and flags are read from the
// usage lines of the CLI's help, so a command added there is completed without a change here.

/** The shells `erden completions` writes a script for; `pwsh` is accepted as another name for PowerShell. */
export const COMPLETION_SHELLS = Object.freeze(['bash', 'zsh', 'fish', 'powershell'] as const);
export type CompletionShell = (typeof COMPLETION_SHELLS)[number];

export interface CompletionFlag {
    readonly name: string;
    /** Whether the flag takes a value in the next word. */
    readonly takesValue: boolean;
    /** The values a flag takes, when the help lists them (`--format <json|yml>`); none means any word or a file. */
    readonly values: ReadonlyArray<string>;
}

export interface CompletionCommand {
    readonly name: string;
    readonly subcommands: ReadonlyArray<string>;
    readonly flags: ReadonlyArray<CompletionFlag>;
}

export interface CompletionTable {
    readonly commands: ReadonlyArray<CompletionCommand>;
    readonly globalFlags: ReadonlyArray<string>;
}

const WORD = /^[a-z][a-z-]*$/u;
const ENUMERATION = /^[a-z0-9]+(?:\|[a-z0-9]+)+$/u;

/** The completion table of a help text whose usage lines read `  erden <command> ...`. */
export function completionTable(help: string): CompletionTable {
    const commands = new Map<string, { subcommands: Set<string>; flags: Map<string, CompletionFlag> }>();
    const globalFlags = new Set(['--help']);
    for (const line of help.split('\n')) {
        const match = /^ {2}erden (\S.*)$/u.exec(line);
        if (match?.[1] === undefined) {
            continue;
        }
        const [name, ...rest] = match[1].split(/\s+/u);
        if (name === undefined) {
            continue;
        }
        if (name.startsWith('-')) {
            globalFlags.add(name);
            continue;
        }
        const command = commands.get(name) ?? {
            subcommands: new Set<string>(),
            flags: new Map<string, CompletionFlag>(),
        };
        commands.set(name, command);
        // A subcommand is a bare word (`store path`) or one of an enumeration (`telemetry <status|enable|disable>`).
        const first = rest[0];
        if (first !== undefined && WORD.test(first)) {
            command.subcommands.add(first);
        }
        const choices = first === undefined ? undefined : /^<([^>]+)>$/u.exec(first)?.[1];
        if (choices !== undefined && ENUMERATION.test(choices)) {
            for (const choice of choices.split('|')) {
                command.subcommands.add(choice);
            }
        }
        const words = rest
            .join(' ')
            .replaceAll(/[[\]()]/gu, ' ')
            .split(/\s+/u)
            .map((word) => word.replace(/\.{3}$/u, ''))
            .filter((word) => word !== '' && word !== '|');
        words.forEach((word, index) => {
            if (!/^--[a-z][a-z-]*$/u.test(word)) {
                return;
            }
            const next = words[index + 1];
            const placeholder = next === undefined ? undefined : /^<([^>]+)>$/u.exec(next)?.[1];
            const values =
                placeholder !== undefined && ENUMERATION.test(placeholder)
                    ? placeholder.split('|')
                    : next !== undefined && ENUMERATION.test(next)
                      ? next.split('|')
                      : [];
            const takesValue = placeholder !== undefined || values.length > 0;
            const known = command.flags.get(word);
            if (known === undefined || (!known.takesValue && takesValue)) {
                command.flags.set(word, { name: word, takesValue, values });
            }
        });
    }
    return {
        commands: [...commands].map(([name, { subcommands, flags }]) => ({
            name,
            subcommands: [...subcommands],
            flags: [...flags.values()],
        })),
        globalFlags: [...globalFlags],
    };
}

const PROGRAMS = ['erden', 'den'] as const;

function words(values: Iterable<string>): string {
    return [...values].join(' ');
}

function bash(table: CompletionTable): string {
    const values = table.commands.flatMap((command) =>
        command.flags
            .filter((flag) => flag.values.length > 0)
            .map((flag) => `        '${command.name} ${flag.name}') words='${words(flag.values)}' ;;`),
    );
    const files = table.commands.flatMap((command) =>
        command.flags
            .filter((flag) => flag.takesValue && flag.values.length === 0)
            .map((flag) => `        '${command.name} ${flag.name}') return ;;`),
    );
    const subcommands = table.commands
        .filter((command) => command.subcommands.length > 0)
        .map((command) => `        ${command.name}) words='${words(command.subcommands)}' ;;`);
    const flags = table.commands.map(
        (command) => `        ${command.name}) words='${words(command.flags.map((flag) => flag.name))}' ;;`,
    );
    return [
        '# bash completion for erden and den. Written by `erden completions bash`; load it with',
        '#   source <(erden completions bash)',
        '_erden() {',
        '    local cur=${COMP_WORDS[COMP_CWORD]} prev=${COMP_WORDS[COMP_CWORD-1]} command=${COMP_WORDS[1]} words=',
        '    COMPREPLY=()',
        '    if [ "$COMP_CWORD" -eq 1 ]; then',
        `        COMPREPLY=($(compgen -W '${words([...table.commands.map((command) => command.name), ...table.globalFlags])}' -- "$cur"))`,
        '        return',
        '    fi',
        '    case "$command $prev" in',
        ...values,
        ...files,
        '    esac',
        '    if [ -z "$words" ] && [ "$COMP_CWORD" -eq 2 ] && [[ $cur != -* ]]; then',
        '        case $command in',
        ...subcommands,
        '        esac',
        '    fi',
        '    if [ -z "$words" ] && [[ $cur == -* ]]; then',
        '        case $command in',
        ...flags,
        '        esac',
        '    fi',
        '    [ -n "$words" ] && COMPREPLY=($(compgen -W "$words" -- "$cur"))',
        '    return 0',
        '}',
        `complete -o default -F _erden ${words(PROGRAMS)}`,
        '',
    ].join('\n');
}

function zsh(table: CompletionTable): string {
    const values = table.commands.flatMap((command) =>
        command.flags
            .filter((flag) => flag.values.length > 0)
            .map((flag) => `        ${command.name}:${flag.name}) compadd -- ${words(flag.values)}; return ;;`),
    );
    const files = table.commands.flatMap((command) =>
        command.flags
            .filter((flag) => flag.takesValue && flag.values.length === 0)
            .map((flag) => `        ${command.name}:${flag.name}) _files; return ;;`),
    );
    const subcommands = table.commands
        .filter((command) => command.subcommands.length > 0)
        .map((command) => `            ${command.name}) compadd -- ${words(command.subcommands)}; return ;;`);
    const flags = table.commands.map(
        (command) => `            ${command.name}) compadd -- ${words(command.flags.map((flag) => flag.name))} ;;`,
    );
    return [
        `#compdef ${words(PROGRAMS)}`,
        '# zsh completion for erden and den. Written by `erden completions zsh`; save it as _erden in a directory on',
        '# your fpath, or load it with: source <(erden completions zsh)',
        '_erden() {',
        '    local command=${words[2]} previous=${words[CURRENT-1]}',
        '    if (( CURRENT == 2 )); then',
        `        compadd -- ${words([...table.commands.map((command) => command.name), ...table.globalFlags])}`,
        '        return',
        '    fi',
        '    case "$command:$previous" in',
        ...values,
        ...files,
        '    esac',
        '    if (( CURRENT == 3 )) && [[ $PREFIX != -* ]]; then',
        '        case $command in',
        ...subcommands,
        '        esac',
        '    fi',
        '    if [[ $PREFIX == -* ]]; then',
        '        case $command in',
        ...flags,
        '        esac',
        '    else',
        '        _files',
        '    fi',
        '}',
        'if [[ $funcstack[1] == _erden ]]; then',
        '    _erden "$@"',
        'else',
        `    compdef _erden ${words(PROGRAMS)}`,
        'fi',
        '',
    ].join('\n');
}

function fish(table: CompletionTable): string {
    const names = table.commands.map((command) => command.name);
    const lines = [
        '# fish completion for erden and den. Written by `erden completions fish`; save it as',
        '# ~/.config/fish/completions/erden.fish (and den.fish), or load it with: erden completions fish | source',
        `for program in ${words(PROGRAMS)}`,
        `    complete -c $program -n __fish_use_subcommand -f -a '${words(names)}'`,
        ...table.globalFlags.map(
            (flag) => `    complete -c $program -n __fish_use_subcommand -f -l ${flag.replace(/^--/u, '')}`,
        ),
    ];
    for (const command of table.commands) {
        const seen = `'__fish_seen_subcommand_from ${command.name}'`;
        if (command.subcommands.length > 0) {
            lines.push(
                `    complete -c $program -n '__fish_seen_subcommand_from ${command.name}; and not __fish_seen_subcommand_from ${words(command.subcommands)}' -f -a '${words(command.subcommands)}'`,
            );
        }
        for (const flag of command.flags) {
            const long = flag.name.replace(/^--/u, '');
            if (flag.values.length > 0) {
                lines.push(`    complete -c $program -n ${seen} -l ${long} -x -a '${words(flag.values)}'`);
            } else if (flag.takesValue) {
                lines.push(`    complete -c $program -n ${seen} -l ${long} -r -F`);
            } else {
                lines.push(`    complete -c $program -n ${seen} -l ${long}`);
            }
        }
    }
    lines.push('end', '');
    return lines.join('\n');
}

function powershellList(values: Iterable<string>): string {
    return `@(${[...values].map((value) => `'${value}'`).join(', ')})`;
}

function powershell(table: CompletionTable): string {
    const subcommands = table.commands
        .filter((command) => command.subcommands.length > 0)
        .map((command) => `    '${command.name}' = ${powershellList(command.subcommands)}`);
    const flags = table.commands.map(
        (command) => `    '${command.name}' = ${powershellList(command.flags.map((flag) => flag.name))}`,
    );
    const values = table.commands.flatMap((command) =>
        command.flags
            .filter((flag) => flag.values.length > 0)
            .map((flag) => `    '${command.name} ${flag.name}' = ${powershellList(flag.values)}`),
    );
    return [
        '# PowerShell completion for erden and den. Written by `erden completions powershell`; load it with',
        '#   erden completions powershell | Out-String | Invoke-Expression',
        '# or add that line to your $PROFILE.',
        'Register-ArgumentCompleter -Native -CommandName erden, den, erden.cmd, den.cmd -ScriptBlock {',
        '    param($wordToComplete, $commandAst, $cursorPosition)',
        `    $commands = ${powershellList([...table.commands.map((command) => command.name), ...table.globalFlags])}`,
        '    $subcommands = @{',
        ...subcommands,
        '    }',
        '    $flags = @{',
        ...flags,
        '    }',
        '    $values = @{',
        ...values,
        '    }',
        '    $elements = @($commandAst.CommandElements | Where-Object { $_.Extent.EndOffset -le $cursorPosition } | ForEach-Object { $_.ToString() })',
        "    if ($wordToComplete -ne '' -and $elements.Count -gt 0) { $elements = @($elements[0..($elements.Count - 2)]) }",
        '    $position = $elements.Count',
        '    $candidates = @()',
        '    if ($position -le 1) {',
        '        $candidates = $commands',
        '    } else {',
        '        $command = $elements[1]',
        '        $previous = $elements[$position - 1]',
        '        if ($values.ContainsKey("$command $previous")) {',
        '            $candidates = $values["$command $previous"]',
        "        } elseif ($position -eq 2 -and $subcommands.ContainsKey($command) -and -not $wordToComplete.StartsWith('-')) {",
        '            $candidates = $subcommands[$command]',
        "        } elseif ($wordToComplete.StartsWith('-') -and $flags.ContainsKey($command)) {",
        '            $candidates = $flags[$command]',
        '        }',
        '    }',
        '    $candidates | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {',
        "        [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)",
        '    }',
        '}',
        '',
    ].join('\n');
}

/** The completion script for `shell` (or `pwsh`), or undefined for a shell it does not know. */
export function completionScript(shell: string, help: string): string | undefined {
    const table = completionTable(help);
    switch (shell) {
        case 'bash':
            return bash(table);
        case 'zsh':
            return zsh(table);
        case 'fish':
            return fish(table);
        case 'powershell':
        case 'pwsh':
            return powershell(table);
        default:
            return undefined;
    }
}
