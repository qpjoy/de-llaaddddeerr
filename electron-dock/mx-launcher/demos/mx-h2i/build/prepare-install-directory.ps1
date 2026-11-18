# Embedded into the signed installer as an encoded command. The selected path
# is data passed through the installer environment, never PowerShell source.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$trusted = @('S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
$directoryDacl = 'D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;BU)'

function Assert-InstallAcl([string]$Path, [bool]$Parent) {
    $item = Get-Item -LiteralPath $Path -Force
    # Windows PowerShell 5.1 can fail to bind enum -band enum. Keep both
    # operands numeric for the installer and for the real FileInfo attributes.
    if (([int]$item.Attributes -band [int][IO.FileAttributes]::ReparsePoint) -ne 0) { throw ('Links and junctions are not supported: ' + $Path) }
    $acl = Get-Acl -LiteralPath $Path
    $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    if ($trusted -notcontains $owner) { throw ('Owned by an ordinary user: ' + $Path) }
    if (-not $acl.AreAccessRulesCanonical) { throw 'The installation directory has a noncanonical ACL.' }
    # Parent directories may allow creating children, but must not let a user
    # rename/delete the protected child or change the parent's security/attrs.
    $forbidden = [long]0x500d0150
    if (-not $Parent) { $forbidden = $forbidden -bor 6 }
    $raw = [Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::All))
    if ($null -eq $raw.DiscretionaryAcl) { throw 'A directory has an unrestricted ACL.' }
    foreach ($ace in $raw.DiscretionaryAcl) {
        if (([int]$ace.AceFlags -band [int][Security.AccessControl.AceFlags]::InheritOnly) -ne 0) { continue }
        if ($ace.AceType -eq [Security.AccessControl.AceType]::AccessDenied) { continue }
        if ($ace.AceType -ne [Security.AccessControl.AceType]::AccessAllowed) { throw 'An unsupported directory ACL was found.' }
        if (($trusted -notcontains $ace.SecurityIdentifier.Value) -and (([long]$ace.AccessMask -band $forbidden) -ne 0)) {
            throw ('Writable or replaceable by ordinary users: ' + $Path)
        }
    }
}

function Assert-InstallTree([string]$Path) {
    Assert-InstallAcl $Path $false
    if ((Get-Item -LiteralPath $Path -Force).PSIsContainer) {
        foreach ($child in Get-ChildItem -LiteralPath $Path -Force) { Assert-InstallTree $child.FullName }
    }
}

function Test-EmptyUnownedInstallDirectory([string]$Path) {
    $item = Get-Item -LiteralPath $Path -Force
    if (-not $item.PSIsContainer -or (([int]$item.Attributes -band [int][IO.FileAttributes]::ReparsePoint) -ne 0)) { return $false }
    $owner = (Get-Acl -LiteralPath $Path).GetOwner([Security.Principal.SecurityIdentifier]).Value
    return ($trusted -notcontains $owner -and @(Get-ChildItem -LiteralPath $Path -Force).Count -eq 0)
}

function Replace-EmptyInstallDirectory([string]$Path, [Security.AccessControl.DirectorySecurity]$Security) {
    $parent = [IO.Path]::GetDirectoryName($Path)
    $staged = Join-Path $parent ('.mincave-install-' + [Guid]::NewGuid().ToString('N'))
    [void][IO.Directory]::CreateDirectory($staged, $Security)
    Assert-InstallAcl $staged $false
    $moved = $false
    try {
        if (-not (Test-EmptyUnownedInstallDirectory $Path)) { throw ('The empty directory changed after confirmation: ' + $Path) }
        # Nonrecursive removal refuses a directory that has acquired content.
        # Move never overwrites a replacement created by another process.
        [IO.Directory]::Delete($Path, $false)
        [IO.Directory]::Move($staged, $Path)
        $moved = $true
    } finally {
        if (-not $moved) { [IO.Directory]::Delete($staged, $false) }
    }
    Assert-InstallAcl $Path $false
}

function Prepare-MinCaveDirectory([string]$Selected, [switch]$CheckOnly, [switch]$RepairEmpty) {
    $Selected = $Selected.Replace('/', '\')
    if ($Selected -notmatch '^[A-Za-z]:\\' -or $Selected.Substring(2) -match '[:<>"|?*\x00-\x1f]') { throw 'Choose an absolute local installation directory.' }
    $Selected = $Selected.TrimEnd([char]'\')
    if ($Selected.Length -le 2) { throw 'Choose an application subdirectory, not a drive root.' }
    foreach ($part in $Selected.Substring(3).Split('\')) {
        if (-not $part -or $part -match '[. ]$' -or $part -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)') {
            throw ('Unsupported path component [{0}] in [{1}].' -f $part, $Selected)
        }
    }
    $target = [IO.Path]::GetFullPath($Selected)
    $volume = [IO.Path]::GetPathRoot($target)
    if ($target -eq $volume) { throw 'Choose an application subdirectory, not a drive root.' }
    $drive = [IO.DriveInfo]::new($volume)
    if ($drive.DriveType -ne [IO.DriveType]::Fixed -or $drive.DriveFormat -notin @('NTFS', 'ReFS')) { throw 'Choose a fixed local NTFS or ReFS drive.' }

    # Validate everything before altering permissions or creating directories.
    $current = $target
    $missing = [Collections.Generic.List[string]]::new()
    while (-not (Test-Path -LiteralPath $current)) {
        $missing.Add($current)
        $current = [IO.Path]::GetDirectoryName($current)
    }
    if ($missing.Count -eq 0) { $current = [IO.Path]::GetDirectoryName($target) }
    while ($current) {
        Assert-InstallAcl $current $true
        $current = [IO.Path]::GetDirectoryName($current)
    }

    $canRepair = $missing.Count -eq 0 -and (Test-EmptyUnownedInstallDirectory $target)
    if ($RepairEmpty -and -not $canRepair) { throw ('The empty directory changed after confirmation: ' + $target) }
    if ($CheckOnly -and $canRepair) { return 'repair-available' }
    if ($missing.Count -eq 0 -and -not $RepairEmpty) {
        # Validate the target before enumerating it, including reparse points.
        Assert-InstallTree $target
        $contents = @(Get-ChildItem -LiteralPath $target -Force)
        if ($contents.Count -gt 0 -and -not (Test-Path -LiteralPath (Join-Path $target 'mx-h2i.exe') -PathType Leaf)) { throw 'Choose an empty folder or the existing MinCave installation.' }
    }
    if ($CheckOnly) { return }

    $security = [Security.AccessControl.DirectorySecurity]::new()
    $security.SetSecurityDescriptorSddlForm('O:BAG:BA' + $directoryDacl)
    if ($RepairEmpty) {
        Replace-EmptyInstallDirectory $target $security
        return
    }
    for ($index = $missing.Count - 1; $index -ge 0; $index--) {
        # CreateDirectory with an explicit descriptor protects each new path
        # component at creation, without inheriting an unsafe write grant.
        [void][IO.Directory]::CreateDirectory($missing[$index], $security)
        Assert-InstallAcl $missing[$index] $false
    }
    $acl = Get-Acl -LiteralPath $target
    $acl.SetSecurityDescriptorSddlForm($directoryDacl, [Security.AccessControl.AccessControlSections]::Access)
    Set-Acl -LiteralPath $target -AclObject $acl
    Assert-InstallAcl $target $false
}

if ($env:MINCAVE_INSTALL_DIRECTORY) {
    try {
        $mode = $env:MINCAVE_INSTALL_DIRECTORY_MODE
        $result = Prepare-MinCaveDirectory $env:MINCAVE_INSTALL_DIRECTORY -CheckOnly:($mode -eq 'preview') -RepairEmpty:($mode -eq 'repair-empty')
        if ($result -eq 'repair-available') { exit 2 }
        exit 0
    } catch {
        [Console]::Out.WriteLine($_.Exception.Message)
        exit 1
    }
}
