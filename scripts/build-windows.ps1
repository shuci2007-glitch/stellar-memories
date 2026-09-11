param([switch]$TestOnly)
$ErrorActionPreference = 'Stop'
$sourceRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Push-Location $sourceRoot
try {
    # Prevent compiler panic paths from disclosing the packager's Windows account.
    $mapping = @("--remap-path-prefix=$sourceRoot=/source", "--remap-path-prefix=$env:USERPROFILE=/user")
    $env:CARGO_ENCODED_RUSTFLAGS = $mapping -join [char]31
    if ($TestOnly) {
        cargo test --release --manifest-path src-tauri/Cargo.toml
    } else {
        npm run tauri build -- --bundles nsis
    }
    if ($LASTEXITCODE -ne 0) { throw "Build failed: $LASTEXITCODE" }
} finally { Pop-Location }
