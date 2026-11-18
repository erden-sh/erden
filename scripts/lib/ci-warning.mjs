// A warning that must not stop the job: printed as a GitHub Actions annotation, added to the job summary when there is
// one, and otherwise just printed. The engines' Windows and macOS builds use the runner image's linker and system
// libraries, which no pin covers, so a mismatch there is reported this way instead of failing a mint.
import { appendFileSync } from 'node:fs';

export function warnInJobSummary(message) {
    const line = message.replaceAll(/\r?\n/gu, ' ');
    process.stdout.write(`::warning::${line}\n`);
    if (process.env.GITHUB_STEP_SUMMARY !== undefined && process.env.GITHUB_STEP_SUMMARY !== '') {
        appendFileSync(process.env.GITHUB_STEP_SUMMARY, `> [!WARNING]\n> ${line}\n\n`);
    }
}
