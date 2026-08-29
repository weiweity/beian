Option Explicit

Const aiDoNotSaveChanges = 2

If WScript.Arguments.Count < 1 Then
    WScript.StdErr.WriteLine "usage: run_export.vbs probe|run|close-owned [path]"
    WScript.Quit 64
End If

Dim mode
mode = LCase(WScript.Arguments(0))

Dim appRef
On Error Resume Next
Set appRef = GetObject(, "Illustrator.Application")
If Err.Number <> 0 Then
    WScript.StdErr.WriteLine "Illustrator COM unavailable: " & Err.Description
    WScript.Quit 10
End If
On Error GoTo 0

Function SafeField(value)
    SafeField = Replace(Replace(Replace(CStr(value), vbTab, " "), vbCr, " "), vbLf, " ")
End Function

Sub WriteDocuments(stream)
    Dim index, docName, docPath
    For index = 1 To appRef.Documents.Count
        docName = ""
        docPath = ""
        On Error Resume Next
        docName = appRef.Documents(index).Name
        docPath = appRef.Documents(index).FullName
        Err.Clear
        On Error GoTo 0
        stream.WriteLine "DOCUMENT" & vbTab & SafeField(docName) & vbTab & SafeField(docPath)
    Next
End Sub

If mode = "probe" Then
    WScript.StdOut.WriteLine "VERSION" & vbTab & SafeField(appRef.Version)
    WScript.StdOut.WriteLine "DOCUMENT_COUNT" & vbTab & CStr(appRef.Documents.Count)
    Call WriteDocuments(WScript.StdOut)
    WScript.Quit 0
End If

If mode = "close-owned" Then
    If WScript.Arguments.Count <> 2 Then
        WScript.StdErr.WriteLine "usage: run_export.vbs close-owned source.ai"
        WScript.Quit 64
    End If
    Dim targetPath, closeIndex, candidatePath, closedCount
    targetPath = CStr(WScript.Arguments(1))
    closedCount = 0
    For closeIndex = appRef.Documents.Count To 1 Step -1
        candidatePath = ""
        On Error Resume Next
        candidatePath = CStr(appRef.Documents(closeIndex).FullName)
        Err.Clear
        On Error GoTo 0
        If StrComp(candidatePath, targetPath, vbTextCompare) = 0 Then
            On Error Resume Next
            appRef.Documents(closeIndex).Close aiDoNotSaveChanges
            If Err.Number = 0 Then closedCount = closedCount + 1
            Err.Clear
            On Error GoTo 0
        End If
    Next
    WScript.StdOut.WriteLine "CLOSED" & vbTab & CStr(closedCount)
    WScript.Quit 0
End If

If mode <> "run" Or WScript.Arguments.Count <> 2 Then
    WScript.StdErr.WriteLine "usage: run_export.vbs run worker.runtime.jsx"
    WScript.Quit 64
End If

If appRef.Documents.Count <> 0 Then
    WScript.StdErr.WriteLine "Illustrator semantic export requires no other open documents"
    Call WriteDocuments(WScript.StdErr)
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
