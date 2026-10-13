Option Explicit
Dim shell, fso, project, node, candidate, pathEntry, runtime, resultFile, command, code, stream, message, extra
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
project = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
node = ""
candidate = shell.ExpandEnvironmentStrings("%USERPROFILE%") & "\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
If fso.FileExists(candidate) Then node = candidate
If node = "" Then
  For Each pathEntry In Split(shell.ExpandEnvironmentStrings("%PATH%"), ";")
    pathEntry = Replace(pathEntry, """", "")
    If Len(pathEntry) > 0 Then
      candidate = fso.BuildPath(pathEntry, "node.exe")
      If fso.FileExists(candidate) Then
        node = candidate
        Exit For
      End If
    End If
  Next
End If
If node = "" Then
  candidate = shell.ExpandEnvironmentStrings("%ProgramFiles%") & "\nodejs\node.exe"
  If fso.FileExists(candidate) Then node = candidate
End If
If node = "" Then
  MsgBox "Node.js 24+ is required. Install Node.js, then double-click again.", vbExclamation, "Japanese Study"
  WScript.Quit 1
End If
EnsureFolder project & "\.local"
runtime = project & "\.local\runtime"
EnsureFolder runtime
resultFile = runtime & "\" & fso.GetTempName
extra = ""
If WScript.Arguments.Count > 1 Then
  If WScript.Arguments(1) = "--no-browser" Then extra = " --no-browser"
End If
command = """" & node & """ """ & project & "\scripts\desktop-launcher.mjs"" " & WScript.Arguments(0) & extra & " ""--result-file=" & resultFile & """"
shell.CurrentDirectory = project
code = shell.Run(command, 0, True)
If code <> 0 Then
  message = "Launch failed. See .local/runtime/server.log."
  If fso.FileExists(resultFile) Then
    Set stream = CreateObject("ADODB.Stream")
    stream.Type = 2
    stream.Charset = "utf-8"
    stream.Open
    stream.LoadFromFile resultFile
    message = stream.ReadText
    stream.Close
  End If
  MsgBox message, vbExclamation, "Japanese Study"
End If
If fso.FileExists(resultFile) Then fso.DeleteFile resultFile
WScript.Quit code

Sub EnsureFolder(folder)
  On Error Resume Next
  If Not fso.FolderExists(folder) Then fso.CreateFolder folder
  On Error GoTo 0
  If Not fso.FolderExists(folder) Then
    MsgBox "Cannot create the runtime folder. Check folder permissions.", vbExclamation, "Japanese Study"
    WScript.Quit 1
  End If
End Sub
