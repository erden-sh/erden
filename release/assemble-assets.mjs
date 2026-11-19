// Assembles a release's assets after `pins.mjs verify --release` accepted the builds: the six archives, each checked
// against its pin again, the committed install scripts (refused unless they carry the pins), SHA256SUMS over all of
// them, and the release notes.
//
// Usage: node release/assemble-assets.mjs --artifacts <dir> --version <version> --out <dir>
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { RELEASE_PLATFORMS, assertPinned, sha256 } from './lib/platforms.mjs';
import { readPins } from './pins.mjs';
import { installScriptDifferences } from './write-install-scripts.mjs';

const release = import.meta.dirname;

function main() {
    const { values } = parseArgs({
        options: { artifacts: { type: 'string' }, version: { type: 'string' }, out: { type: 'string' } },
    });
    for (const name of ['artifacts', 'version', 'out']) {
        if (values[name] === undefined) {
            throw new Error(`--${name} is required`);
        }
    }
    const pins = readPins(values.version);
    const differences = installScriptDifferences(pins, release);
    if (differences.length > 0) {
        throw new Error(`The install scripts disagree with the pins:\n- ${differences.join('\n- ')}`);
    }
    const out = resolve(values.out);
    mkdirSync(out, { recursive: true });
    const sums = [];
    for (const platform of Object.keys(RELEASE_PLATFORMS).sort()) {
        const pin = pins.archives[platform];
        const source = join(resolve(values.artifacts), pin.file);
        assertPinned(source, pin, `${platform} archive`);
        copyFileSync(source, join(out, pin.file));
        sums.push(`${pin.sha256.slice('sha256:'.length)}  ${pin.file}`);
    }
    for (const name of ['install.sh', 'install.ps1']) {
        const bytes = readFileSync(join(release, name));
        writeFileSync(join(out, name), bytes);
        sums.push(`${sha256(bytes).slice('sha256:'.length)}  ${name}`);
    }
    writeFileSync(join(out, 'SHA256SUMS'), `${sums.sort((a, b) => (a.slice(66) < b.slice(66) ? -1 : 1)).join('\n')}\n`);
    writeFileSync(
        join(out, 'RELEASE-NOTES.md'),
        [
            `Erden is a registry for ontologies. This release holds the local tools: the \`erden\` command line tool (also`,
            'available as `den`), which checks an ontology project, packs it and talks to the hosted registry. Each archive',
            `carries everything the tool runs on: Node.js ${pins.node}, the Erden reasoner and the \`erden-shacl\` validator.`,
            '',
            '**This is a pre-1.0 release.** Commands and file formats can still change. The reasoner covers a documented',
            'part of OWL 2, not all of it: the [glossary](https://erden.sh/docs/glossary) lists what it reasons over today.',
            '',
            '**The hosted registry.** The tool talks to `https://registry.erden.sh` by default, and the docs are at',
            '<https://erden.sh>. The registry is invite-only and has no public packages yet, so checking a project on your',
            'own machine is what you can do with this release today.',
            '',
            '## Install',
            '',
            'This release on Linux x64 and arm64 (glibc or musl, such as Alpine) and macOS on Apple silicon:',
            '',
            '```sh',
            `curl -fsSL https://github.com/erden-sh/erden/releases/download/v${pins.version}/install.sh | sh`,
            '```',
            '',
            'On Windows x64, in PowerShell:',
            '',
            '```powershell',
            `irm https://github.com/erden-sh/erden/releases/download/v${pins.version}/install.ps1 | iex`,
            '```',
            '',
            'The latest release is always at `https://erden.sh/install` and `https://erden.sh/install.ps1`, and from Homebrew',
            '(`brew install erden-sh/tap/erden`) and Scoop (`scoop bucket add erden https://github.com/erden-sh/scoop-bucket`,',
            'then `scoop install erden`). The scripts add Erden to your `PATH` (`--no-modify-path` or `-NoModifyPath` leaves it',
            'alone) and remove it again with `--uninstall` or `-Uninstall`. On Alpine, install the C++ runtime first:',
            '`apk add libstdc++ libgcc`.',
            '',
            'Each script carries the digests of every archive and refuses any other file. To install without network',
            'access, download the archive for your platform and the script, carry both over, and run `sh install.sh --archive',
            '<file>`, or `install.ps1 -Archive <file>` on Windows. `SHA256SUMS` lists every asset.',
            '',
            '## Verify',
            '',
            'Every asset has a build provenance attestation from the GitHub Actions run that built it. With the GitHub CLI:',
            '',
            '```sh',
            `gh attestation verify erden-${pins.version}-linux-x64.tar.gz --repo erden-sh/erden`,
            '```',
            '',
            '## License and contributions',
            '',
            'Apache License 2.0; the copyright holder is Ingenio Ventures Inc. Outside pull requests are not accepted yet, and issues are welcome.',
            '',
            `Built from ${pins.sourceCommit}; every archive was built twice and matched its committed pin.`,
            '',
        ].join('\n'),
    );
    process.stdout.write(`Assembled ${String(sums.length)} assets in ${out}\n`);
}

if (import.meta.main) {
    main();
}
