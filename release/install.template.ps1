# Installs the Erden CLI for this user, with no administrator rights: the archive goes to
# %LOCALAPPDATA%\Programs\Erden\<version>\, `erden` and `den` go to %LOCALAPPDATA%\Programs\Erden\bin, and that folder
# is added to your user PATH. The archive is checked against its SHA-256 digest before anything is extracted.
#
#   irm https://erden.sh/install.ps1 | iex
#   powershell -ExecutionPolicy Bypass -File install.ps1 [-Version <v>] [-Archive <file>] [-NoModifyPath] [-Uninstall]
#
# The same settings as environment variables, for the `irm | iex` form: ERDEN_VERSION, ERDEN_NO_MODIFY_PATH=1.
#
# Written by release/write-install-scripts.mjs from release/pins/@@VERSION@@.json. Do not edit by hand. Everything runs
# from the call on the last line, so a download cut short installs nothing; nothing changes the caller's session
# settings, and a failure never closes the PowerShell window it runs in.
param(
    [string]$Version = '',
    [string]$Archive = '',
    [switch]$NoModifyPath,
    [switch]$Uninstall
)

function Install-Erden {
    param(
        [string]$Version,
        [string]$Archive,
        [bool]$ModifyPath,
        [bool]$Uninstall
    )
    $ErrorActionPreference = 'Stop'
    Set-StrictMode -Version 3
    $ProgressPreference = 'SilentlyContinue'

    $pinnedVersion = '@@VERSION@@'
@@ARCHIVES@@

    function Fail([string]$message) {
        throw "erden install: $message"
    }

    # The user PATH as stored, with %VARIABLES% unexpanded, so writing it back changes only Erden's entry.
    function Get-UserPath {
        $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')
        try {
            $value = $key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
            return [string]$value
        } finally {
            $key.Close()
        }
    }

    # Writes the user PATH to the registry (setx would cut it at 1024 characters) and tells running programs.
    function Set-UserPath([string]$value) {
        $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
        try {
            $key.SetValue('Path', $value, [Microsoft.Win32.RegistryValueKind]::ExpandString)
        } finally {
            $key.Close()
        }
        Send-EnvironmentChange
    }

    # WM_SETTINGCHANGE with "Environment", so Explorer and new terminals read the new PATH without a sign-out.
    function Send-EnvironmentChange {
        if (-not ('Erden.Installer.Environment' -as [type])) {
            Add-Type -Namespace Erden.Installer -Name Environment -MemberDefinition @'
[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
public static extern System.IntPtr SendMessageTimeout(System.IntPtr hWnd, uint Msg, System.UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out System.UIntPtr lpdwResult);
'@
        }
        $result = [UIntPtr]::Zero
        # HWND_BROADCAST, WM_SETTINGCHANGE, SMTO_ABORTIFHUNG, 5 seconds.
        [void][Erden.Installer.Environment]::SendMessageTimeout([IntPtr]0xffff, 0x1a, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)
    }

    function Test-SamePath([string]$left, [string]$right) {
        return [string]::Equals($left.TrimEnd('\'), $right.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)
    }

    function Add-ToUserPath([string]$directory) {
        $entries = @((Get-UserPath) -split ';' | Where-Object { $_ -ne '' })
        if ($entries | Where-Object { Test-SamePath ([Environment]::ExpandEnvironmentVariables($_)) $directory }) {
            return $false
        }
        Set-UserPath ((@($directory) + $entries) -join ';')
        return $true
    }

    function Remove-FromUserPath([string]$directory) {
        $entries = @((Get-UserPath) -split ';' | Where-Object { $_ -ne '' })
        $kept = @($entries | Where-Object { -not (Test-SamePath ([Environment]::ExpandEnvironmentVariables($_)) $directory) })
        if ($kept.Count -eq $entries.Count) {
            return $false
        }
        Set-UserPath ($kept -join ';')
        return $true
    }

    function Save-Url([string]$url, [string]$path) {
        # Windows PowerShell 5.1 on older Windows may not offer TLS 1.2, which GitHub requires.
        if (-not ([Net.ServicePointManager]::SecurityProtocol -band [Net.SecurityProtocolType]::Tls12) -and
            [Net.ServicePointManager]::SecurityProtocol -ne [Net.SecurityProtocolType]::SystemDefault) {
            [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        }
        try {
            Invoke-WebRequest -UseBasicParsing -UserAgent 'erden-install/1' -Uri $url -OutFile $path
        } catch {
            Fail "could not download ${url}: $($_.Exception.Message)"
        }
    }

    $localData = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { [Environment]::GetFolderPath('LocalApplicationData') }
    $programs = Join-Path (Join-Path $localData 'Programs') 'Erden'
    $bin = Join-Path $programs 'bin'

    if ($Uninstall) {
        if (Remove-FromUserPath $bin) { Write-Output "Removed $bin from your user PATH" }
        $env:Path = (($env:Path -split ';') | Where-Object { $_ -ne '' -and -not (Test-SamePath $_ $bin) }) -join ';'
        if (Test-Path -LiteralPath $programs) {
            Remove-Item -LiteralPath $programs -Recurse -Force
            Write-Output "Removed $programs"
        }
        Write-Output 'Erden is uninstalled. Your projects, its package store and its settings are left as they were.'
        return
    }

    $isWindowsHost = [System.Runtime.InteropServices.RuntimeInformation]::IsOSPlatform(
        [System.Runtime.InteropServices.OSPlatform]::Windows)
    $architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
    if (-not $isWindowsHost -or $architecture -ne 'X64') {
        Fail "unsupported platform: $([System.Runtime.InteropServices.RuntimeInformation]::OSDescription) $architecture; install.ps1 installs win32-x64 (use install.sh on Linux and macOS)"
    }

    if ($Version -eq '') { $Version = $pinnedVersion }
    $Version = $Version -replace '^v', ''
    if ($Version -notmatch '^[0-9A-Za-z][0-9A-Za-z.-]*$') { Fail "not a version: $Version" }
    $releaseUrl = "https://github.com/erden-sh/erden/releases/download/v$Version"

    New-Item -ItemType Directory -Force -Path $programs | Out-Null
    # Short staging names: the archive's deepest entry is extracted below them, and Windows PowerShell 5.1's
    # Expand-Archive may stop at the 260-character path limit.
    $work = Join-Path $programs ('.install.' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
    New-Item -ItemType Directory -Path $work | Out-Null
    try {
        if ($Version -eq $pinnedVersion) {
            if ($win32X64File -eq '') { Fail "Erden $Version has no archive for win32-x64" }
            $file = $win32X64File
            $sha = $win32X64Sha256
            $bytes = $win32X64Bytes
        } else {
            # Another version's archive, checked against that release's SHA256SUMS (over HTTPS, from the same release).
            if ($Archive -ne '') { Fail "-Archive installs only $pinnedVersion, the version this script carries digests for" }
            $file = "erden-$Version-win32-x64.zip"
            $bytes = $null
            $sums = Join-Path $work 'SHA256SUMS'
            Save-Url "$releaseUrl/SHA256SUMS" $sums
            $line = Get-Content -LiteralPath $sums | Where-Object { $_ -match "^([0-9a-f]{64})  $([regex]::Escape($file))$" } | Select-Object -First 1
            if ($null -eq $line) { Fail "Erden $Version has no archive for win32-x64" }
            $sha = $line.Substring(0, 64)
        }

        $download = Join-Path $work $file
        if ($Archive -ne '') {
            if (-not (Test-Path -LiteralPath $Archive -PathType Leaf)) { Fail "no such archive: $Archive" }
            Copy-Item -LiteralPath $Archive -Destination $download
        } else {
            Save-Url "$releaseUrl/$file" $download
        }
        $size = (Get-Item -LiteralPath $download).Length
        if ($null -ne $bytes -and $size -ne $bytes) {
            Fail "the archive is $size bytes, not the $bytes bytes of $file (a partial or different download); nothing was installed"
        }
        $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $download).Hash.ToLowerInvariant()
        if ($hash -ne $sha) {
            Fail "the archive's SHA-256 is not the one $file was released with; nothing was installed"
        }
        $extract = Join-Path $work 'x'
        Expand-Archive -LiteralPath $download -DestinationPath $extract
        $unpacked = Join-Path $extract "erden-$Version-win32-x64"
        foreach ($name in 'erden', 'den') {
            if (-not (Test-Path -LiteralPath (Join-Path (Join-Path $unpacked 'bin') "$name.cmd") -PathType Leaf)) {
                Fail "$file does not hold bin\$name.cmd; nothing was installed"
            }
        }
        $target = Join-Path $programs $Version
        if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
        Move-Item -LiteralPath $unpacked -Destination $target
    } finally {
        if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force }
    }

    # One folder on the PATH for every version, never a versioned one: its launchers run the version installed last.
    # Each is written under a temporary name and then renamed over the old one, so it is never half written.
    New-Item -ItemType Directory -Force -Path $bin | Out-Null
    foreach ($name in 'erden', 'den') {
        $launcher = "@echo off`r`nrem Runs Erden $Version. Written by the Erden installer.`r`n`"%~dp0..\$Version\bin\$name.cmd`" %*`r`n"
        $path = Join-Path $bin "$name.cmd"
        $temporary = Join-Path $bin ".$name.cmd.erden-install"
        [IO.File]::WriteAllText($temporary, $launcher, [Text.Encoding]::ASCII)
        if (Test-Path -LiteralPath $path) {
            [IO.File]::Replace($temporary, $path, [NullString]::Value)
        } else {
            [IO.File]::Move($temporary, $path)
        }
    }
    Write-Output "Installed Erden $Version to $target, with erden and den in $bin"

    if ($env:ERDEN_NO_MODIFY_PATH -and $env:ERDEN_NO_MODIFY_PATH -ne '0') { $ModifyPath = $false }
    if (-not $ModifyPath) {
        Write-Output "Add $bin to your PATH to run erden (your PATH was left as it is)."
        return
    }
    if (Add-ToUserPath $bin) {
        Write-Output "Added $bin to your user PATH. New terminals will find erden."
    }
    if (-not (($env:Path -split ';') | Where-Object { Test-SamePath $_ $bin })) {
        $env:Path = "$bin;$env:Path"
    }
}

$erdenInstallArguments = @{
    Version    = if ($Version -ne '') { $Version } elseif ($env:ERDEN_VERSION) { $env:ERDEN_VERSION } else { '' }
    Archive    = $Archive
    ModifyPath = -not $NoModifyPath
    Uninstall  = [bool]$Uninstall
}
try {
    Install-Erden @erdenInstallArguments
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    # A script run with -File exits with a status; `irm | iex` runs in the caller's session, which must stay open.
    if ($PSCommandPath) { exit 1 }
}
