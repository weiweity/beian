Option Explicit

If WScript.Arguments.Count < 1 Then
    WScript.StdErr.WriteLine "usage: run_export.vbs probe|run [worker.runtime.jsx]"
    WScript.Quit 64
End If

Dim mode
mode = LCase(WScript.Arguments(0))

Dim appRef
On Error Resume Next
Set appRef = GetObject(, "Illustrator.Application")
If Err.Number <> 0 Then
    Err.Clear
    Set appRef = CreateObject("Illustrator.Application")
End If
If Err.Number <> 0 Then
    WScript.StdErr.WriteLine "Illustrator COM unavailable: " & Err.Description
    WScript.Quit 10
End If
On Error GoTo 0

If mode = "probe" Then
    WScript.StdOut.Write CStr(appRef.Version) & vbTab & CStr(appRef.Documents.Count)
    WScript.Quit 0
End If

If mode <> "run" Or WScript.Arguments.Count <> 2 Then
    WScript.StdErr.WriteLine "usage: run_export.vbs run worker.runtime.jsx"
    WScript.Quit 64
End If

If appRef.Documents.Count <> 0 Then
    WScript.StdErr.WriteLine "Illustrator semantic export requires no other open documents"
    WScript.Quit 12
End If

Dim result
On Error Resume Next
result = appRef.DoJavaScriptFile(WScript.Arguments(1))
If Err.Number <> 0 Then
    WScript.StdErr.WriteLine "Illustrator JSX failed: " & Err.Description
    WScript.Quit 11
End If
On Error GoTo 0

WScript.StdOut.Write CStr(result)
WScript.Quit 0
