#!/bin/sh
# Installs the Erden CLI for this user, with no administrator rights. Written by release/write-install-scripts.mjs from
# release/pins/0.2.1.json. Do not edit by hand.
#
# Everything runs from the call to `main` on the last line, so a download cut short installs nothing.
set -eu

version='0.2.1'
darwin_arm64_file='erden-0.2.1-darwin-arm64.tar.gz'
darwin_arm64_sha256='4adc59bbf16139914e3b07df1134e44e32c8200f0c23eac91b96c0ee68d3be99'
darwin_arm64_bytes='44813905'
darwin_arm64_xz_file='erden-0.2.1-darwin-arm64.tar.xz'
darwin_arm64_xz_sha256='417fb56087d16ec6d5761555daa03338085bae3fd8cf5cb89dfe13e5f9a76e2d'
darwin_arm64_xz_bytes='27638676'
linux_arm64_file='erden-0.2.1-linux-arm64.tar.gz'
linux_arm64_sha256='4fa89912f92ff2f043927f451a4c3eea6170de1cf0fb614bc78e3ad882477791'
linux_arm64_bytes='48864532'
linux_arm64_xz_file='erden-0.2.1-linux-arm64.tar.xz'
linux_arm64_xz_sha256='6134dff5487e60997de208cdbc94e4723c5c713b3afa45bcd35188153689d2ee'
linux_arm64_xz_bytes='30476384'
linux_arm64_musl_file='erden-0.2.1-linux-arm64-musl.tar.gz'
linux_arm64_musl_sha256='c22a1eb6b16311dd7c0a59541a5ffa5d57fa1812ced53ab8ad7bfc66702fba5b'
linux_arm64_musl_bytes='51616788'
linux_arm64_musl_xz_file='erden-0.2.1-linux-arm64-musl.tar.xz'
linux_arm64_musl_xz_sha256='3ba9f20a71aa3915b5289c9a9bd073bb10be05eac6f535a5b3411f154e8f06a7'
linux_arm64_musl_xz_bytes='31980424'
linux_x64_file='erden-0.2.1-linux-x64.tar.gz'
linux_x64_sha256='8d0ee6b1ff93635e4b4cfdb12379100952c64e4568d8a99a948f7f52860ee6a2'
linux_x64_bytes='49574512'
linux_x64_xz_file='erden-0.2.1-linux-x64.tar.xz'
linux_x64_xz_sha256='9b9eb15dc414f4a4800d7d9998ab31d9d789c96db5b48fb780738031855aa136'
linux_x64_xz_bytes='32289148'
linux_x64_musl_file='erden-0.2.1-linux-x64-musl.tar.gz'
linux_x64_musl_sha256='f0b975a7bf0e3421994bdae7c0c07cdc07fe7ec3db954897e69b0c94e4ecd0c2'
linux_x64_musl_bytes='51319124'
linux_x64_musl_xz_file='erden-0.2.1-linux-x64-musl.tar.xz'
linux_x64_musl_xz_sha256='154303ca2b95a2724c433a397dceb5590e5727a6edfef9d9e40b16ef6e8c7bc2'
linux_x64_musl_xz_bytes='33396988'

usage() {
    cat << 'EOF'
Installs the Erden CLI for this user, with no administrator rights: the archive for this platform goes to
~/.local/share/erden/<version>/, `erden` and `den` are linked into ~/.local/bin, and ~/.local/bin is added to the PATH
in your shell profiles. The archive is checked against its SHA-256 digest before anything is extracted. The
.tar.xz archive is used when xz (or a tar that reads xz, as macOS's does) is here, the .tar.gz otherwise.

  curl -fsSL https://erden.sh/install | sh
  curl -fsSL https://erden.sh/install | sh -s -- --no-modify-path

Options:
  --version <version>   install this version instead of the one the script carries digests for (also ERDEN_VERSION)
  --archive <file>      install a local archive (.tar.xz or .tar.gz), with no network request
  --no-modify-path      leave the shell profiles alone (also ERDEN_NO_MODIFY_PATH=1)
  --uninstall           remove Erden, its links and the PATH lines this script added
  -h, --help            print this help
EOF
}

fail() {
    printf 'erden install: %s\n' "$1" >&2
    exit 1
}

say() {
    printf '%s\n' "$1"
}

# Writes `name` as $HOME-relative where it is under the home directory, for messages.
tildify() {
    # shellcheck disable=SC2088 # a literal ~ for the reader, never expanded
    case $1 in
        "$home"/*) printf '~/%s' "${1#"$home"/}" ;;
        *) printf '%s' "$1" ;;
    esac
}

has() {
    command -v "$1" > /dev/null 2>&1
}

download() {
    if has curl; then
        curl -fsSL --proto '=https' --tlsv1.2 -A 'erden-install/1' -o "$2" "$1"
    elif has wget; then
        wget -q -U 'erden-install/1' -O "$2" "$1"
    else
        fail 'neither curl nor wget is available; download the archive and run with --archive <file>'
    fi
}

digest() {
    if has sha256sum; then
        sha256sum "$1" | cut -d ' ' -f 1
    elif has shasum; then
        shasum -a 256 "$1" | cut -d ' ' -f 1
    else
        fail 'neither sha256sum nor shasum is available to check the archive'
    fi
}

# musl when ldd says so; glibc when it names GNU libc (a glibc system may also have a musl loader installed); otherwise
# when a musl loader is installed.
is_musl() {
    libc=$(ldd --version 2>&1 || true)
    case $libc in
        *musl*) return 0 ;;
        *GNU* | *GLIBC* | *glibc*) return 1 ;;
    esac
    for loader in /lib/ld-musl-*.so.1; do
        [ -e "$loader" ] && return 0
    done
    return 1
}

detect_platform() {
    case $(uname -s) in
        Linux) os=linux ;;
        Darwin) os=darwin ;;
        *) fail "unsupported platform: $(uname -s) $(uname -m); Erden supports linux-x64, linux-arm64 (glibc or musl), darwin-arm64 and win32-x64" ;;
    esac
    case $(uname -m) in
        x86_64 | amd64) cpu=x64 ;;
        aarch64 | arm64) cpu=arm64 ;;
        *) cpu=$(uname -m) ;;
    esac
    # A shell under Rosetta 2 reports x86_64 on Apple silicon; the arm64 build runs natively there.
    if [ "$os-$cpu" = darwin-x64 ] && [ "$(sysctl -n sysctl.proc_translated 2> /dev/null || true)" = 1 ]; then
        cpu=arm64
    fi
    platform="$os-$cpu"
    if [ "$os" = linux ] && is_musl; then
        platform="$platform-musl"
    fi
    case $platform in
        linux-x64 | linux-arm64 | linux-x64-musl | linux-arm64-musl | darwin-arm64) ;;
        *) fail "unsupported platform: $platform; Erden supports linux-x64, linux-arm64 (glibc or musl), darwin-arm64 and win32-x64" ;;
    esac
}

# The Node.js runtime of a musl archive links the C++ runtime dynamically, as Node.js on Alpine does.
check_musl_runtime() {
    case $platform in
        *-musl) ;;
        *) return 0 ;;
    esac
    for name in libstdc++.so.6 libgcc_s.so.1; do
        found=''
        for directory in /usr/lib /lib /usr/local/lib; do
            [ -e "$directory/$name" ] && found=1
        done
        [ -n "$found" ] || fail "Erden on $platform needs $name; install it first (Alpine: apk add libstdc++ libgcc)"
    done
}

# How this machine extracts a .tar.xz: with xz, or with a tar that reads xz itself (macOS's bsdtar); empty if neither.
detect_unxz() {
    unxz=''
    if has xz; then
        unxz=xz
    elif tar --version 2> /dev/null | grep -q liblzma; then
        unxz=tar
    fi
}

# The file name, SHA-256 and size of this platform's archives in the pins this script carries: the .tar.gz, and the
# .tar.xz (xz_*), which releases from before it do not have.
pinned_archive() {
    case $platform in
        linux-x64)
            file=$linux_x64_file sha=$linux_x64_sha256 bytes=$linux_x64_bytes
            xz_file=$linux_x64_xz_file xz_sha=$linux_x64_xz_sha256 xz_bytes=$linux_x64_xz_bytes
            ;;
        linux-arm64)
            file=$linux_arm64_file sha=$linux_arm64_sha256 bytes=$linux_arm64_bytes
            xz_file=$linux_arm64_xz_file xz_sha=$linux_arm64_xz_sha256 xz_bytes=$linux_arm64_xz_bytes
            ;;
        linux-x64-musl)
            file=$linux_x64_musl_file sha=$linux_x64_musl_sha256 bytes=$linux_x64_musl_bytes
            xz_file=$linux_x64_musl_xz_file xz_sha=$linux_x64_musl_xz_sha256 xz_bytes=$linux_x64_musl_xz_bytes
            ;;
        linux-arm64-musl)
            file=$linux_arm64_musl_file sha=$linux_arm64_musl_sha256 bytes=$linux_arm64_musl_bytes
            xz_file=$linux_arm64_musl_xz_file xz_sha=$linux_arm64_musl_xz_sha256 xz_bytes=$linux_arm64_musl_xz_bytes
            ;;
        darwin-arm64)
            file=$darwin_arm64_file sha=$darwin_arm64_sha256 bytes=$darwin_arm64_bytes
            xz_file=$darwin_arm64_xz_file xz_sha=$darwin_arm64_xz_sha256 xz_bytes=$darwin_arm64_xz_bytes
            ;;
    esac
    [ -n "$file" ] || fail "Erden $version has no archive for $platform"
    # The .tar.xz is smaller: use it when there is one and this machine can extract it. A local archive is the format
    # its name says.
    case $archive in
        *.tar.xz)
            [ -n "$xz_file" ] || fail "Erden $version has no .tar.xz archive for $platform; use $file"
            [ -n "$unxz" ] || fail "extracting $xz_file needs xz; install xz or use $file"
            file=$xz_file sha=$xz_sha bytes=$xz_bytes
            ;;
        '') if [ -n "$xz_file" ] && [ -n "$unxz" ]; then file=$xz_file sha=$xz_sha bytes=$xz_bytes; fi ;;
    esac
}

# Another version's archive, checked against that release's SHA256SUMS (fetched over HTTPS from the same release): its
# .tar.xz when it lists one and xz is here, its .tar.gz otherwise.
listed_archive() {
    bytes=''
    download "$release_url/SHA256SUMS" "$work/SHA256SUMS" || fail "could not download $release_url/SHA256SUMS; is $version an Erden release?"
    file="erden-$version-$platform.tar.gz"
    if [ -n "$unxz" ] && awk -v name="erden-$version-$platform.tar.xz" '$2 == name { found = 1 } END { exit !found }' "$work/SHA256SUMS"; then
        file="erden-$version-$platform.tar.xz"
    fi
    sha=$(awk -v name="$file" '$2 == name { print $1 }' "$work/SHA256SUMS")
    case $sha in
        '') fail "Erden $version has no archive for $platform" ;;
        *[!0-9a-f]*) fail "SHA256SUMS of $version does not give a SHA-256 for $file" ;;
    esac
    [ ${#sha} -eq 64 ] || fail "SHA256SUMS of $version does not give a SHA-256 for $file"
}

# The line every edited profile gets, and the comment above it that marks it as this script's.
marker='# Added by the Erden installer; its --uninstall removes it'

# Writes `path` with a leading home directory as a literal $HOME, for files that profiles source.
home_relative() {
    # shellcheck disable=SC2016 # a literal $HOME, expanded by the shell that sources the file
    case $1 in
        "$home"/*) printf '$HOME/%s' "${1#"$home"/}" ;;
        *) printf '%s' "$1" ;;
    esac
}

profile_line() {
    printf '. "%s"' "$(home_relative "$data/env")"
}

# The shell profiles to edit, one per line: ~/.profile always, the bash files that exist, zsh's .zshenv when zsh is
# installed or the login shell (as rustup does), and fish's conf.d file.
profiles() {
    printf '%s\n' "$home/.profile"
    for name in .bash_profile .bash_login .bashrc; do
        [ -f "$home/$name" ] && printf '%s\n' "$home/$name"
    done
    case ${SHELL:-} in
        *zsh) zsh=1 ;;
        *) if has zsh; then zsh=1; else zsh=''; fi ;;
    esac
    if [ -n "$zsh" ]; then
        printf '%s\n' "${ZDOTDIR:-$home}/.zshenv"
    fi
}

fish_conf() {
    printf '%s' "${XDG_CONFIG_HOME:-$home/.config}/fish/conf.d/erden.fish"
}

has_fish() {
    case ${SHELL:-} in
        *fish) return 0 ;;
    esac
    has fish || [ -d "${XDG_CONFIG_HOME:-$home/.config}/fish" ]
}

# Writes a file through its link, keeping its owner and mode, so dotfiles managed as links stay links.
rewrite() {
    cat "$2" > "$1"
    rm -f "$2"
}

add_to_path() {
    case ${ERDEN_NO_MODIFY_PATH:-} in
        '' | 0) ;;
        *) modify_path='' ;;
    esac
    case ":${PATH:-}:" in
        *":$bin:"*) return 0 ;;
    esac
    if [ -z "$modify_path" ]; then
        say "Add $(tildify "$bin") to your PATH to run erden (your shell profiles were left as they are)."
        return 0
    fi
    # The env script the profiles source: it adds the bin directory once, however often it is sourced.
    path_entry=$(home_relative "$bin")
    cat > "$data/env" << EOF
# Puts Erden's bin directory on the PATH. Written by the Erden installer; its --uninstall removes it.
case ":\${PATH}:" in
    *":$path_entry:"*) ;;
    *) export PATH="$path_entry:\$PATH" ;;
esac
EOF
    line=$(profile_line)
    changed=''
    while IFS= read -r profile; do
        if [ -f "$profile" ] && grep -qxF "$line" "$profile"; then
            continue
        fi
        mkdir -p "$(dirname "$profile")"
        if [ -s "$profile" ] && [ -n "$(tail -c 1 "$profile")" ]; then
            printf '\n' >> "$profile"
        fi
        printf '%s\n%s\n' "$marker" "$line" >> "$profile"
        changed="$changed $(tildify "$profile")"
    done << EOF
$(profiles)
EOF
    if has_fish; then
        conf=$(fish_conf)
        if [ ! -f "$conf" ]; then
            mkdir -p "$(dirname "$conf")"
            cat > "$conf" << EOF
# Puts Erden's bin directory on the PATH. Written by the Erden installer; its --uninstall removes it.
if not contains -- "$path_entry" \$PATH
    set -gx PATH "$path_entry" \$PATH
end
EOF
            changed="$changed $(tildify "$conf")"
        fi
    fi
    if [ -n "$changed" ]; then
        say "Added $(tildify "$bin") to your PATH in:$changed"
    fi
    say 'New shells will find erden. To use it in this shell now, run:'
    say "    . \"$data/env\""
    if has_fish; then
        say "or, in fish: source \"$(fish_conf)\""
    fi
}

remove_from_profiles() {
    line=$(profile_line)
    while IFS= read -r profile; do
        [ -f "$profile" ] || continue
        grep -qxF "$line" "$profile" || continue
        grep -vxF -e "$line" -e "$marker" "$profile" > "$profile.erden-uninstall" || true
        rewrite "$profile" "$profile.erden-uninstall"
        say "Removed the Erden PATH line from $(tildify "$profile")"
    done << EOF
$home/.profile
$home/.bash_profile
$home/.bash_login
$home/.bashrc
$home/.zshenv
${ZDOTDIR:-$home}/.zshenv
EOF
    conf=$(fish_conf)
    if [ -f "$conf" ]; then
        rm -f "$conf"
        say "Removed $(tildify "$conf")"
    fi
}

uninstall() {
    for name in erden den; do
        link="$bin/$name"
        if [ -L "$link" ]; then
            case $(readlink "$link") in
                "$data"/*) rm -f "$link" && say "Removed $(tildify "$link")" ;;
            esac
        fi
    done
    remove_from_profiles
    # The installed versions and the env script only: the package store (store/) and anything else Erden keeps in
    # this directory stay.
    if [ -d "$data" ]; then
        for entry in "$data"/*; do
            if [ -f "$entry/bin/erden" ]; then
                rm -rf "$entry"
                say "Removed $(tildify "$entry")"
            fi
        done
        rm -rf "$data"/.install.*
        rm -f "$data/env"
        if rmdir "$data" 2> /dev/null; then
            say "Removed $(tildify "$data")"
        fi
    fi
    say 'Erden is uninstalled. Your projects, its package store and its settings are left as they were.'
}

install_erden() {
    detect_platform
    check_musl_runtime
    detect_unxz
    mkdir -p "$data"
    work=$(mktemp -d "$data/.install.XXXXXX")
    trap 'rm -rf "$work"' EXIT
    trap 'rm -rf "$work"; exit 1' INT TERM
    if [ "$version" = "$pinned_version" ]; then
        pinned_archive
    else
        [ -z "$archive" ] || fail "--archive installs only $pinned_version, the version this script carries digests for"
        listed_archive
    fi

    if [ -n "$archive" ]; then
        [ -f "$archive" ] || fail "no such archive: $archive"
        cp "$archive" "$work/$file"
    else
        download "$release_url/$file" "$work/$file" || fail "could not download $release_url/$file"
    fi

    if [ -n "$bytes" ]; then
        size=$(wc -c < "$work/$file" | tr -d ' ')
        [ "$size" = "$bytes" ] || fail "the archive is $size bytes, not the $bytes bytes of $file (a partial or different download); nothing was installed"
    fi
    [ "$(digest "$work/$file")" = "$sha" ] || fail "the archive's SHA-256 is not the one $file was released with; nothing was installed"

    mkdir "$work/extract"
    case $file in
        *.tar.xz)
            if [ "$unxz" = xz ]; then
                (cd "$work/extract" && xz -dc "../$file" | tar -xf -)
            else
                (cd "$work/extract" && tar -xJf "../$file")
            fi
            ;;
        *) (cd "$work/extract" && gzip -dc "../$file" | tar -xf -) ;;
    esac || fail "could not extract $file; nothing was installed"
    unpacked="$work/extract/erden-$version-$platform"
    [ -x "$unpacked/bin/erden" ] || fail "$file does not hold bin/erden; nothing was installed"
    [ -x "$unpacked/bin/den" ] || fail "$file does not hold bin/den; nothing was installed"

    target="$data/$version"
    rm -rf "$target"
    mv "$unpacked" "$target"
    # Each link is made under a temporary name and renamed over the old one (rename is atomic), both made before
    # either is renamed, so erden and den never point at a half-installed version and switch together.
    mkdir -p "$bin"
    for name in erden den; do
        ln -sfn "$target/bin/$name" "$bin/.$name.erden-install"
    done
    for name in erden den; do
        mv -f "$bin/.$name.erden-install" "$bin/$name"
    done

    say "Installed Erden $version to $(tildify "$target"), with erden and den in $(tildify "$bin")"
    add_to_path
}

main() {
    pinned_version=$version
    archive=''
    action=install_erden
    modify_path=1
    requested=${ERDEN_VERSION:-}
    while [ "$#" -gt 0 ]; do
        case $1 in
            --archive)
                [ "$#" -ge 2 ] || fail '--archive needs a file'
                archive=$2
                shift 2
                ;;
            --version)
                [ "$#" -ge 2 ] || fail '--version needs a version'
                requested=$2
                shift 2
                ;;
            --no-modify-path)
                modify_path=''
                shift
                ;;
            --uninstall)
                action=uninstall
                shift
                ;;
            -h | --help)
                usage
                exit 0
                ;;
            *) fail "unknown argument: $1 (see --help)" ;;
        esac
    done
    if [ -n "$requested" ]; then
        version=${requested#v}
        case $version in
            *[!0-9A-Za-z.-]* | '' | .* | -*) fail "not a version: $requested" ;;
        esac
    fi
    release_url="https://github.com/erden-sh/erden/releases/download/v$version"

    home=${HOME:?HOME is not set}
    data="$home/.local/share/erden"
    bin="$home/.local/bin"
    "$action"
}

main "$@"
