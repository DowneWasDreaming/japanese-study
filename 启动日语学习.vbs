Option Explicit
Dim shell, fso, project, args
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
project = fso.GetParentFolderName(WScript.ScriptFullName)
args = ""
If WScript.Arguments.Count > 0 Then
  If WScript.Arguments(0) = "--no-browser" Then args = " --no-browser"
End If
WScript.Quit shell.Run("wscript.exe """ & project & "\scripts\desktop-launcher.vbs"" start" & args, 0, True)
