# Creates "MV Booth" shortcuts on the Desktop and in the Start menu.
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ws = New-Object -ComObject WScript.Shell
foreach ($folder in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {
  $lnk = $ws.CreateShortcut((Join-Path $folder 'MV Booth.lnk'))
  $lnk.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
  $lnk.Arguments = '"' + (Join-Path $dir 'launch.vbs') + '"'
  $lnk.WorkingDirectory = $dir
  $lnk.IconLocation = (Join-Path $dir 'icons\mvbooth.ico') + ',0'
  $lnk.Description = 'MV Booth - Mental Vision vocal engine'
  $lnk.Save()
}
Write-Host ''
Write-Host '  MV Booth is installed: Desktop + Start menu shortcuts created.' -ForegroundColor Cyan
Write-Host '  Tip: right-click it in the Start menu > Pin to taskbar.'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host ''
  Write-Host '  Node.js is not installed yet. Opening the download page...' -ForegroundColor Yellow
  Start-Process 'https://nodejs.org/en/download'
}
