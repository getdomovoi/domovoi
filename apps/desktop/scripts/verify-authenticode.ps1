param(
  [Parameter(Mandatory = $true)][string]$Artifact,
  [Parameter(Mandatory = $true)][string]$Publisher
)
$ErrorActionPreference = 'Stop'
$signature = Get-AuthenticodeSignature -LiteralPath $Artifact
if ($signature.Status -ne 'Valid') {
  throw "Authenticode verification failed for ${Artifact}: $($signature.Status)"
}
if ($null -eq $signature.SignerCertificate -or $null -eq $signature.TimeStamperCertificate) {
  throw "Authenticode signature or timestamp missing from ${Artifact}"
}
$actualPublisher = $signature.SignerCertificate.GetNameInfo(
  [System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false
)
if (-not [string]::Equals($actualPublisher, $Publisher, [System.StringComparison]::Ordinal)) {
  throw "Authenticode publisher does not match DOMOVOI_WIN_PUBLISHER_NAME for ${Artifact}"
}
Write-Output "DOMOVOI_AUTHENTICODE_OK ${Artifact}"
