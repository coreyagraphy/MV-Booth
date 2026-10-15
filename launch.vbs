' MV Booth launcher: starts the local engine silently and opens the app window.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
If sh.Run("cmd /c where node >nul 2>nul", 0, True) <> 0 Then
  MsgBox "MV Booth needs Node.js (free, one-time install)." & vbCrLf & "The download page will open now. Install the LTS version, then launch MV Booth again.", 48, "MV Booth"
  sh.Run "https://nodejs.org/en/download"
  WScript.Quit
End If
If fso.FileExists(dir & "\backend\.venv\Scripts\python.exe") Then
  ' Tuning backend (localhost:8765), started hidden if it has been set up.
  sh.Run """" & dir & "\backend\.venv\Scripts\pythonw.exe"" """ & dir & "\backend\server.py"" --idle-exit", 0, False
End If
sh.Run "node """ & dir & "\serve.mjs""", 0, False
