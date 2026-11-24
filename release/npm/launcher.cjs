#!/usr/bin/env node
// The `erden` and `den` commands of the npm package @erden-sh/cli. The package holds no Erden itself: each release
// platform's executable is in its own package, @erden-sh/cli-<platform>, an optional dependency that npm, pnpm and
// Yarn install only on the platform its `os`, `cpu` and `libc` fields name. This file finds the one for this machine
// and runs its `bin/erden` with the same arguments, the terminal, and its exit status; the executable carries its own
// Node.js, so the Node.js running this file only starts it.
'use strict';

const { spawn } = require('node:child_process');
const { join } = require('node:path');

/** The release platforms, as release/lib/platforms.mjs names them (release/npm-packages.mjs checks the two agree). */
const PLATFORMS = ['darwin-arm64', 'linux-arm64', 'linux-arm64-musl', 'linux-x64', 'linux-x64-musl', 'win32-x64'];

const INSTALL_URL = 'https://erden.sh/install';

/** 'musl' on a musl Linux (Alpine and others), else undefined: the test release/lib/platforms.mjs uses. */
function hostLibc() {
    if (process.platform !== 'linux') {
        return undefined;
    }
    const report = process.report.getReport();
    if (typeof report.header?.glibcVersionRuntime === 'string') {
        return undefined;
    }
    return (report.sharedObjects ?? []).some((path) => /(?:^|\/)(?:ld-musl-|libc\.musl-)[^/]*$/u.test(path))
        ? 'musl'
        : undefined;
}

/** The release platform name of a host: `<os>-<cpu>`, with `-musl` on a musl Linux. */
function platformName(platform, arch, libc) {
    return `${platform}-${arch}${libc === 'musl' ? '-musl' : ''}`;
}

function fail(message) {
    process.stderr.write(`erden: ${message}\n`);
    process.exit(1);
}

function executable() {
    const name = platformName(process.platform, process.arch, hostLibc());
    const description = `${process.platform} ${process.arch}${name.endsWith('-musl') ? ' (musl)' : ''}`;
    if (!PLATFORMS.includes(name)) {
        fail(
            `Erden has no build for ${description}. Its builds are for ${PLATFORMS.join(', ')}; ` +
                `see ${INSTALL_URL} for the other ways to install it.`,
        );
    }
    const packageName = `@erden-sh/cli-${name}`;
    let manifest;
    try {
        manifest = require.resolve(`${packageName}/package.json`);
    } catch {
        fail(
            `the Erden executable for ${description} is in the package ${packageName}, which is not installed. ` +
                '@erden-sh/cli installs it as an optional dependency: reinstall without --no-optional or ' +
                '--omit=optional, and make sure your package manager installs optional dependencies for this ' +
                `platform (pnpm: supportedArchitectures; Yarn: supportedArchitectures). Or install Erden another ` +
                `way: ${INSTALL_URL}`,
        );
    }
    return join(manifest, '..', 'bin', process.platform === 'win32' ? 'erden.exe' : 'erden');
}

function run() {
    const path = executable();
    const child = spawn(path, process.argv.slice(2), { stdio: 'inherit' });
    // A terminal's Ctrl-C (SIGINT) reaches the whole foreground process group, Erden included, which handles it; this
    // process waits for Erden to exit. A signal sent to this process alone is passed on.
    function forward(signal) {
        if (signal !== 'SIGINT' && child.exitCode === null && child.signalCode === null) {
            child.kill(signal);
        }
    }
    const signals = process.platform === 'win32' ? ['SIGINT'] : ['SIGINT', 'SIGTERM', 'SIGHUP'];
    for (const signal of signals) {
        process.on(signal, forward);
    }
    child.on('error', (error) => {
        fail(`could not run ${path}: ${error.message}. Reinstall @erden-sh/cli, or see ${INSTALL_URL}`);
    });
    child.on('exit', (code, signal) => {
        for (const name of signals) {
            process.removeListener(name, forward);
        }
        if (signal !== null) {
            // Ends as Erden did, so the caller sees the same signal.
            process.kill(process.pid, signal);
            return;
        }
        process.exit(code ?? 1);
    });
}

if (require.main === module) {
    run();
}

module.exports = { PLATFORMS, platformName };
