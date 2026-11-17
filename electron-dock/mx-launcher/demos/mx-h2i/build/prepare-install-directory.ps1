# Embedded into the signed installer as an encoded command. The selected path
# is data passed through the installer environment, never PowerShell source.
$ErrorActionPreference = 'Stop'
$trusted = @('S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
$directoryDacl = 'D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;BU)'

function Assert-InstallAcl([string]$Path, [bool]$Parent) {
    $item = Get-Item -LiteralPath $Path -Force
    # Windows PowerShell 5.1 can fail to bind enum -band enum. Keep both
    # operands numeric for the installer and for the real FileInfo attributes.
    if (([int]$item.Attributes -band [int][IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Links and junctions are not supported.' }
    $acl = Get-Acl -LiteralPath $Path
    $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    if ($trusted -notcontains $owner) { throw 'A parent or existing installation is owned by an ordinary user. Choose a machine-managed folder.' }
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
            throw 'A parent or existing installation is writable by ordinary users. Choose a protected folder.'
        }
    }
}

function Assert-InstallTree([string]$Path) {
    Assert-InstallAcl $Path $false
    if ((Get-Item -LiteralPath $Path -Force).PSIsContainer) {
        foreach ($child in Get-ChildItem -LiteralPath $Path -Force) { Assert-InstallTree $child.FullName }
    }
}

function Prepare-MinCaveDirectory([string]$Selected) {
    if ($Selected -notmatch '^[A-Za-z]:\\' -or $Selected.Substring(2) -match '[:<>"|?*\x00-\x1f]') { throw 'Choose an absolute local installation directory.' }
    foreach ($part in $Selected.Substring(3).Split('\')) {
        if (-not $part -or $part -match '[. ]$' -or $part -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)') { throw 'The installation directory contains an unsupported path component.' }
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
    if ($missing.Count -eq 0) {
        $contents = @(Get-ChildItem -LiteralPath $target -Force)
        if ($contents.Count -gt 0 -and -not (Test-Path -LiteralPath (Join-Path $target 'mx-h2i.exe') -PathType Leaf)) { throw 'Choose an empty folder or the existing MinCave installation.' }
        Assert-InstallTree $target
        $current = [IO.Path]::GetDirectoryName($target)
    }
    while ($current) {
        Assert-InstallAcl $current $true
        $current = [IO.Path]::GetDirectoryName($current)
    }

    $security = [Security.AccessControl.DirectorySecurity]::new()
    $security.SetSecurityDescriptorSddlForm('O:BAG:BA' + $directoryDacl)
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
        Prepare-MinCaveDirectory $env:MINCAVE_INSTALL_DIRECTORY
        exit 0
    } catch {
        [Console]::Error.WriteLine($_.Exception.Message)
        exit 1
    }
}
