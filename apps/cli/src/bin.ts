#!/usr/bin/env node

import { setRegistryUserAgent } from '@erden/client';

import { cliUserAgent, cliVersion, nodeInstallation, stateDirectory } from './installation.js';
import { CLI_EXIT, nodeCliRuntime, runCli } from './main.js';
import { beginSession, spawnNodeBackground, type Session } from './session.js';

const arguments_ = process.argv.slice(2);
let session: Session | undefined;
const started = performance.now();
let exitCode: number | undefined;
try {
    const version = cliVersion();
    const userAgent = cliUserAgent(version);
    setRegistryUserAgent(userAgent);
    session = beginSession(arguments_, {
        environment: process.env,
        platform: process.platform,
        arch: process.arch,
        version,
        userAgent,
        installation: nodeInstallation(version),
        stateDirectory: stateDirectory(process.env, process.platform),
        stdoutIsTty: process.stdout.isTTY,
        stderrIsTty: process.stderr.isTTY,
        stderr: (text) => process.stderr.write(text),
        now: () => Date.now(),
        spawnBackground: spawnNodeBackground,
    });
} catch {
    session = undefined;
}
try {
    exitCode = await runCli(arguments_, nodeCliRuntime);
    process.exitCode = exitCode;
} catch {
    process.stderr.write('Erden could not start [CLI_OPERATIONAL_FAILURE]\n');
    process.exitCode = CLI_EXIT.operational;
}
session?.finish(exitCode, performance.now() - started);
