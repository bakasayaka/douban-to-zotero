[CmdletBinding()]
param(
  [switch]$ConfirmLive,
  [switch]$ContinueOnError,
  [int]$Limit = 50,
  [int]$Concurrency = 1,
  [string]$OutDir = ".cache\live\openai-cleaning-comparison"
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = "Stop"

# EDIT THESE VALUES for your OpenAI-compatible provider.
# Plaintext API keys are intentional here: this wrapper is the lightweight user-facing
# configuration surface. The comparison worker must not persist this key into
# summary JSON, request logs, or artifacts.
$BaseUrl = "PASTE_YOUR_OPENAI_COMPATIBLE_BASE_URL_HERE"
$Model = "PASTE_YOUR_MODEL_HERE"
$ApiKey = "PASTE_YOUR_API_KEY_HERE"
$Temperature = 0
$TimeoutMs = 60000
$MaxRawChars = 12000

if (-not $ConfirmLive) {
  throw "Refusing to call a model API without -ConfirmLive."
}

if (-not $BaseUrl -or $BaseUrl -eq "PASTE_YOUR_OPENAI_COMPATIBLE_BASE_URL_HERE") {
  throw "Set `$BaseUrl at the top of scripts\run-openai-compatible-cleaning-comparison.ps1 before running."
}

if (-not $Model -or $Model -eq "PASTE_YOUR_MODEL_HERE") {
  throw "Set `$Model at the top of scripts\run-openai-compatible-cleaning-comparison.ps1 before running."
}

if (-not $ApiKey -or $ApiKey -eq "PASTE_YOUR_API_KEY_HERE") {
  throw "Set `$ApiKey at the top of scripts\run-openai-compatible-cleaning-comparison.ps1 before running."
}

$previousExecutionMode = $env:DOUBAN_TO_ZOTERO_EXECUTION_MODE
$previousBaseUrl = $env:OPENAI_COMPATIBLE_BASE_URL
$previousApiKey = $env:OPENAI_COMPATIBLE_API_KEY
$previousModel = $env:OPENAI_COMPATIBLE_MODEL

try {
  $env:DOUBAN_TO_ZOTERO_EXECUTION_MODE = "live"
  $env:OPENAI_COMPATIBLE_BASE_URL = $BaseUrl
  $env:OPENAI_COMPATIBLE_API_KEY = $ApiKey
  $env:OPENAI_COMPATIBLE_MODEL = $Model

  $args = @(
    "run",
    "reference:cleaning:compare",
    "--",
    "--out-dir", $OutDir,
    "--limit", [string]$Limit,
    "--concurrency", [string]$Concurrency,
    "--temperature", [string]$Temperature,
    "--timeout-ms", [string]$TimeoutMs,
    "--max-raw-chars", [string]$MaxRawChars,
    "--confirm-live"
  )

  if ($ContinueOnError) { $args += "--continue-on-error" }

  npm @args
  exit $LASTEXITCODE
} finally {
  if ($null -eq $previousExecutionMode) {
    Remove-Item Env:\DOUBAN_TO_ZOTERO_EXECUTION_MODE -ErrorAction SilentlyContinue
  } else {
    $env:DOUBAN_TO_ZOTERO_EXECUTION_MODE = $previousExecutionMode
  }

  if ($null -eq $previousBaseUrl) {
    Remove-Item Env:\OPENAI_COMPATIBLE_BASE_URL -ErrorAction SilentlyContinue
  } else {
    $env:OPENAI_COMPATIBLE_BASE_URL = $previousBaseUrl
  }

  if ($null -eq $previousApiKey) {
    Remove-Item Env:\OPENAI_COMPATIBLE_API_KEY -ErrorAction SilentlyContinue
  } else {
    $env:OPENAI_COMPATIBLE_API_KEY = $previousApiKey
  }

  if ($null -eq $previousModel) {
    Remove-Item Env:\OPENAI_COMPATIBLE_MODEL -ErrorAction SilentlyContinue
  } else {
    $env:OPENAI_COMPATIBLE_MODEL = $previousModel
  }
}
