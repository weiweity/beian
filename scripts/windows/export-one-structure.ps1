param(
  [Parameter(Mandatory = $true)][string]$Sha256,
  [string]$SourceDir = "C:\supply\data\a02-samples",
  [string]$OutDir = "C:\supply\data\a02-samples\runs\one",
  [int]$Timeout = 1260
)

$ErrorActionPreference = "Stop"
# Does not stop beian-server-8787 or cloudflared and does not change Illustrator Session 0.
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
Set-Location $Root
$py = $env:WB_PYTHON
if (-not $py) { $py = Join-Path $Root "apps\web\backend\.venv\Scripts\python.exe" }
$tool = Join-Path $Root "workers\packaging\tools\export_one_structure.py"
if (-not (Test-Path -LiteralPath $py)) { throw "python missing: $py" }
if (-not (Test-Path -LiteralPath $tool)) { throw "export_one_structure.py missing" }
& $py $tool --source-dir $SourceDir --sha256 $Sha256 --out-dir $OutDir --timeout $Timeout
exit $LASTEXITCODE
