// Writes the Homebrew formula (Formula/erden.rb, for the erden-sh/homebrew-tap repository) and the Scoop manifest
// (bucket/erden.json, for erden-sh/scoop-bucket) of a version from its pins (release/pins/<version>.json): each names
// the release's archives by URL and SHA-256, so Homebrew and Scoop refuse any other file. The release workflow runs it
// after a release is published and verified, and pushes the two files to their repositories.
//
// Usage: node release/write-package-manifests.mjs --version <version> --out <directory>
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { readPins } from './pins.mjs';

const REPOSITORY = 'https://github.com/erden-sh/erden';
const DESCRIPTION = 'Check, package and publish ontologies with the Erden registry';

function hex(pin) {
    return pin.sha256.slice('sha256:'.length);
}

function download(version, file) {
    return `${REPOSITORY}/releases/download/v${version}/${file}`;
}

/** The archive pin of `platform`, refusing pins that lack it. */
function archive(pins, platform) {
    const pin = pins.archives[platform];
    if (pin === undefined) {
        throw new Error(`release/pins/${pins.version}.json has no ${platform} archive`);
    }
    return pin;
}

/**
 * The Homebrew formula: the macOS arm64 and the Linux x64 and arm64 (glibc) archives. Each holds its own Node.js and
 * engines, so the formula has no dependencies; it links `erden` and `den` and installs the shell completions where the
 * archive's CLI has `erden completions`.
 */
export function homebrewFormula(pins) {
    const macos = archive(pins, 'darwin-arm64');
    const linuxArm = archive(pins, 'linux-arm64');
    const linuxIntel = archive(pins, 'linux-x64');
    return `# Written by release/write-package-manifests.mjs in erden-sh/erden from release/pins/${pins.version}.json, and updated
# by its release workflow. Do not edit by hand.
class Erden < Formula
  desc "${DESCRIPTION}"
  homepage "https://erden.sh"
  license "Apache-2.0"

  livecheck do
    url :stable
    strategy :github_latest
  end

  on_macos do
    on_arm do
      url "${download(pins.version, macos.file)}"
      sha256 "${hex(macos)}"
    end
  end

  on_linux do
    on_arm do
      url "${download(pins.version, linuxArm.file)}"
      sha256 "${hex(linuxArm)}"
    end
    on_intel do
      url "${download(pins.version, linuxIntel.file)}"
      sha256 "${hex(linuxIntel)}"
    end
  end

  depends_on arch: :arm64 if OS.mac?

  # The engines check their own SHA-256 before every run, so nothing in the archive may be rewritten.
  skip_clean "libexec"

  def install
    libexec.install Dir["*"]
    bin.install_symlink libexec/"bin/erden", libexec/"bin/den"
    if (libexec/"lib/dist/completions.js").exist?
      generate_completions_from_executable(bin/"erden", "completions")
    end
  end

  test do
    assert_equal version.to_s, shell_output("#{bin}/erden --version").strip
    assert_equal shell_output("#{bin}/erden help"), shell_output("#{bin}/den help")
    doctor = JSON.parse(shell_output("#{bin}/erden doctor --json"))
    assert_equal "passed", doctor["outcome"]
    system bin/"erden", "init", testpath/"project", "--json"
    assert_path_exists testpath/"project/erden.config.json"
  end
end
`;
}

/** The Scoop manifest: the Windows x64 archive, with checkver and autoupdate from the release's SHA256SUMS. */
export function scoopManifest(pins) {
    const windows = archive(pins, 'win32-x64');
    const manifest = {
        $schema: 'https://raw.githubusercontent.com/ScoopInstaller/Scoop/master/schema.json',
        '##': 'Written by release/write-package-manifests.mjs in erden-sh/erden and updated by its release workflow.',
        version: pins.version,
        description: DESCRIPTION,
        homepage: 'https://erden.sh',
        license: 'Apache-2.0',
        architecture: {
            '64bit': {
                url: download(pins.version, windows.file),
                hash: hex(windows),
                extract_dir: windows.file.replace(/\.zip$/u, ''),
            },
        },
        bin: ['bin\\erden.cmd', 'bin\\den.cmd'],
        checkver: { github: REPOSITORY },
        autoupdate: {
            architecture: {
                '64bit': {
                    url: `${REPOSITORY}/releases/download/v$version/erden-$version-win32-x64.zip`,
                    hash: { url: '$baseurl/SHA256SUMS' },
                    extract_dir: 'erden-$version-win32-x64',
                },
            },
        },
    };
    return `${JSON.stringify(manifest, null, 4)}\n`;
}

function main() {
    const { values } = parseArgs({ options: { version: { type: 'string' }, out: { type: 'string' } } });
    if (values.version === undefined || values.out === undefined) {
        throw new Error('Usage: write-package-manifests.mjs --version <version> --out <directory>');
    }
    const pins = readPins(values.version);
    if (pins.complete !== true) {
        throw new Error(`release/pins/${pins.version}.json was minted for fewer than every platform`);
    }
    const out = resolve(values.out);
    mkdirSync(join(out, 'Formula'), { recursive: true });
    mkdirSync(join(out, 'bucket'), { recursive: true });
    writeFileSync(join(out, 'Formula', 'erden.rb'), homebrewFormula(pins));
    writeFileSync(join(out, 'bucket', 'erden.json'), scoopManifest(pins));
    process.stdout.write(`Wrote Formula/erden.rb and bucket/erden.json for ${pins.version} in ${out}\n`);
}

if (import.meta.main) {
    main();
}
