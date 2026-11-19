// The entry of the single executable application each release archive ships as bin/erden (release/lib/bundle.mjs
// bundles it with Node.js). It runs the CLI, as bin.ts does, or, when session.ts started this executable to send the
// queued telemetry and refresh the update check, that background job: in a single executable `process.execPath` is
// the CLI itself, so it cannot be handed background.js as a script.
import { isSea } from 'node:sea';

import { runBackgroundJob } from './background.js';
import { CLI_EXIT, nodeCliRuntime, runCli } from './main.js';
import { BACKGROUND_JOB_ARGUMENT } from './session.js';

export async function runSingleExecutable(argv: readonly string[], sea: boolean = isSea()): Promise<void> {
    if (sea && argv[0] === BACKGROUND_JOB_ARGUMENT) {
        try {
            await runBackgroundJob(argv[1]);
        } catch {
            // Nothing to report to: the command this follows has exited.
        }
        return;
    }
    try {
        process.exitCode = await runCli([...argv], nodeCliRuntime);
    } catch {
        process.stderr.write('Erden could not start [CLI_OPERATIONAL_FAILURE]\n');
        process.exitCode = CLI_EXIT.operational;
    }
}

if (isSea()) {
    void runSingleExecutable(process.argv.slice(2));
}
