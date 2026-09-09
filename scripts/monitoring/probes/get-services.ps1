# Read-only F02 probe: query two frozen Windows service names.
# Query only. Do not change service state. Do not hide errors.
$names = @('beian-server-8787', 'cloudflared')
$rows = New-Object System.Collections.ArrayList
foreach ($name in $names) {
  $row = $null
  try {
    $svc = Get-Service -Name $name -ErrorAction Stop
    $row = [pscustomobject]@{ name = [string]$name; status = [string]$svc.Status }
  } catch [System.UnauthorizedAccessException] {
    $row = [pscustomobject]@{ name = [string]$name; status = 'permission' }
  } catch {
    $msg = [string]$_.Exception.Message
    $fqid = [string]$_.FullyQualifiedErrorId
    if ($fqid -match 'NoServiceFoundForGivenName' -or $msg -match 'Cannot find any service') {
      $row = [pscustomobject]@{ name = [string]$name; status = 'missing' }
    } elseif ($msg -match 'Access is denied' -or $fqid -match 'UnauthorizedAccess' -or $msg -match 'Permission') {
      $row = [pscustomobject]@{ name = [string]$name; status = 'permission' }
    } else {
      $row = [pscustomobject]@{ name = [string]$name; status = 'unknown' }
    }
  }
  [void]$rows.Add($row)
}
ConvertTo-Json -Compress -InputObject @($rows.ToArray())
