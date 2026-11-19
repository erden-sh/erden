// Written by shacl/qualification/finalize-artifacts.mjs from the shacl-build run recorded in
// shacl/qualification/binary-reproducibility.json. Do not edit by hand. A platform whose pins are null has no
// released binary.
export const PACKAGE_VERSION = '0.1.0+purrdf.3.0.1';
export const ENGINE_DIGEST = 'sha256:026b0ef70f4bd68cbe0fff535b8287eb804825c057f46cc116ae1f2087b427cc';
export const KNOWN_ANSWER_FIXTURE_DIGEST = 'sha256:998bf25c3ec295a5dc8e8863846ca335ac636f2b1edf8abfb95b57ec88c883d8';
export const QUALIFIED_ARTIFACTS = Object.freeze({
    'linux:x64:glibc': Object.freeze({
        packageName: '@erden/shacl-linux-x64-gnu',
        description: 'Qualified Erden SHACL engine for Linux x64 (glibc)',
        runtime: Object.freeze({ 'os': 'linux', 'cpu': 'x64', 'libc': 'glibc' }),
        target: 'x86_64-unknown-linux-gnu',
        binaryPath: 'bin/erden-shacl',
        bytes: 11754488,
        sha256: 'sha256:844b8a8035c4ee280e41dd430a3a20c27f9cced6963a59831bef1ecbbe4db33b',
        responseBytes: 2202,
        responseSha256: 'sha256:04a17cebb45a8fc52cc8b6e911f297d96f9bb978d971baeec50781293975a234',
    }),
    'linux:arm64:glibc': Object.freeze({
        packageName: '@erden/shacl-linux-arm64-gnu',
        description: 'Qualified Erden SHACL engine for Linux arm64 (glibc)',
        runtime: Object.freeze({ 'os': 'linux', 'cpu': 'arm64', 'libc': 'glibc' }),
        target: 'aarch64-unknown-linux-gnu',
        binaryPath: 'bin/erden-shacl',
        bytes: 9639384,
        sha256: 'sha256:2e39dedbf173f4cf45235fd0d93313a70c48421211d0e1284fd709ba98554ad0',
        responseBytes: 2202,
        responseSha256: 'sha256:7c4a0eb621b7c55454b947e863814e61612613f7a3278acdc09062e16be41378',
    }),
    'darwin:arm64': Object.freeze({
        packageName: '@erden/shacl-darwin-arm64',
        description: 'Qualified Erden SHACL engine for macOS arm64 (Apple silicon)',
        runtime: Object.freeze({ 'os': 'darwin', 'cpu': 'arm64' }),
        target: 'aarch64-apple-darwin',
        binaryPath: 'bin/erden-shacl',
        bytes: 9616432,
        sha256: 'sha256:9fee0ac3954afe1732a515a1d047024c62924fc7951efb66c9b7c7239c5bfd27',
        responseBytes: 2202,
        responseSha256: 'sha256:88488f5562a0207f46c8bfffaab0f03c1c5a5612107ec62eb00562279daa5331',
    }),
    'win32:x64': Object.freeze({
        packageName: '@erden/shacl-win32-x64-msvc',
        description: 'Qualified Erden SHACL engine for Windows x64 (MSVC)',
        runtime: Object.freeze({ 'os': 'win32', 'cpu': 'x64' }),
        target: 'x86_64-pc-windows-msvc',
        binaryPath: 'bin/erden-shacl.exe',
        bytes: 13997056,
        sha256: 'sha256:ebbbf784b6051b69d2f20a1205073c1a289911985b795ff4c14bea0e955952a9',
        responseBytes: 2202,
        responseSha256: 'sha256:18c84780833bcb127234238d9444f1b734de40f1a731bffb6f781b79487715e6',
    }),
    'linux:x64:musl': Object.freeze({
        packageName: '@erden/shacl-linux-x64-musl',
        description: 'Qualified Erden SHACL engine for Linux x64 (musl)',
        runtime: Object.freeze({ 'os': 'linux', 'cpu': 'x64', 'libc': 'musl' }),
        target: 'x86_64-unknown-linux-musl',
        binaryPath: 'bin/erden-shacl',
        bytes: 11855280,
        sha256: 'sha256:36ea6981e84ce2f83dd356723884988278ebf45e1cb9ec53dbd935663453a300',
        responseBytes: 2202,
        responseSha256: 'sha256:f3adfc69d2c7ff094200309891ad74a5570c51e362d494207665ffd67825ace1',
    }),
    'linux:arm64:musl': Object.freeze({
        packageName: '@erden/shacl-linux-arm64-musl',
        description: 'Qualified Erden SHACL engine for Linux arm64 (musl)',
        runtime: Object.freeze({ 'os': 'linux', 'cpu': 'arm64', 'libc': 'musl' }),
        target: 'aarch64-unknown-linux-musl',
        binaryPath: 'bin/erden-shacl',
        bytes: 9507736,
        sha256: 'sha256:592dc6a3d8c5b08000159d773a1fccfe7e4756b96250115f1d5e3c05df792d6e',
        responseBytes: 2202,
        responseSha256: 'sha256:4b62ca762ab86656290649db7d792426ee1188abbdf2a4a4a55e90f1f2b27c30',
    }),
});
