Option Explicit
Dim shell, fso, project
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
project = fso.GetParentFolderName(WScript.ScriptFullName)
WScript.Quit shell.Run("wscript.exe """ & project & "\scripts\desktop-launcher.vbs"" stop", 0, True)
