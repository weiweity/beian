param(
  [Parameter(Mandatory = $true)][string]$Sha256,
  [string]$SourceDir = "C:\supply\data\a02-samples",
  [string]$OutDir = "C:\supply\data\a02-samples\runs\one",
  # Same outer wait as unattended_wait.OUTER_SECONDS.
  [int]$Timeout = 1260,
  [string]$PrintLayers = "",
  [string]$ProposalLayers = ""
)

$ErrorActionPreference = "Stop"
# Does not stop beian-server-8787 or cloudflared and does not change Illustrator Session 0.
# Layer defaults use [char] codepoints so Windows PowerShell 5.1 (GBK) does not mojibake UTF-8 source.
if (-not $PrintLayers) { $PrintLayers = [string]([char]0x5370) + [char]0x5237 }
if (-not $ProposalLayers) { $ProposalLayers = [string]([char]0x5200) + [char]0x7EBF }
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
Set-Location $Root
$py = $env:WB_PYTHON
if (-not $py) { $py = Join-Path $Root "apps\web\backend\.venv\Scripts\python.exe" }
$tool = Join-Path $Root "workers\packaging\tools\export_one_structure.py"
if (-not (Test-Path -LiteralPath $py -PathType Leaf)) { throw "python missing: $py" }
if (-not (Test-Path -LiteralPath $tool -PathType Leaf)) { throw "export_one_structure.py missing" }
& $py $tool --source-dir $SourceDir --sha256 $Sha256 --out-dir $OutDir --timeout $Timeout --print-layers $PrintLayers --proposal-layers $ProposalLayers
exit $LASTEXITCODE
