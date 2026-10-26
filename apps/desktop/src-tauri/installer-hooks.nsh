; RecordForge NSIS installer hooks.
;
; Tauri's NSIS template refuses to install when the Windows Restart Manager
; reports any process using the main executable and the follow-up RmShutdown
; fails (tauri-apps/tauri#16277). Security software can hold such a handle: on
; affected machines McAfee Framework Host is reported as an RmCritical process
; using recordforge-desktop.exe, so RmShutdown returns
; ERROR_FAIL_NOACTION_REBOOT (350) even though RecordForge is not running. The
; installer then aborts with "Failed to kill RecordForge" and only a reboot
; releases the handle.
;
; This hook closes a current-user RecordForge (killing an already-exited
; process counts as success), waits for it to go away, then moves the old
; executable aside so the template's Restart Manager probe has nothing to
; register. The installer writes the new binary to the normal path and the
; post-install hook removes the backup.

Var RFBackupExe

!macro RF_FindRunningApp
  nsis_tauri_utils::FindProcessCurrentUser "${MAINBINARYNAME}.exe"
  Pop $R9
  ; 0 = found, 1 = not found
!macroend

!macro RF_KillRunningApp
  nsis_tauri_utils::KillProcessCurrentUser "${MAINBINARYNAME}.exe"
  Pop $R9
!macroend

!macro RF_WaitForAppExit
  StrCpy $R8 0
  ${Do}
    !insertmacro RF_FindRunningApp
    ${If} $R9 = 1
      ${ExitDo}
    ${EndIf}
    IntOp $R8 $R8 + 1
    ${If} $R8 >= 10
      ${ExitDo}
    ${EndIf}
    Sleep 500
  ${Loop}
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro RF_FindRunningApp

  ${If} $R9 = 0
    ; Interactive installs keep the template's courtesy prompt. Passive and
    ; silent runs (the updater) proceed directly, as before.
    ${IfNot} ${Silent}
      ${If} $PassiveMode != 1
        MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "RecordForge is still running and must be closed before installing. Continue?" IDOK rf_continue_preinstall
        Abort
        rf_continue_preinstall:
      ${EndIf}
    ${EndIf}

    !insertmacro RF_KillRunningApp
    !insertmacro RF_WaitForAppExit
  ${EndIf}

  ; If RecordForge is still alive (for example elevated, or owned by another
  ; user), leave the executable in place and let the template report it.
  !insertmacro RF_FindRunningApp
  ${If} $R9 = 1
    System::Call 'kernel32::GetTickCount() i .R7'
    StrCpy $RFBackupExe "$INSTDIR\${MAINBINARYNAME}.exe.rf-$R7"
    ClearErrors
    Rename "$INSTDIR\${MAINBINARYNAME}.exe" "$RFBackupExe"
    ${If} ${Errors}
      StrCpy $RFBackupExe ""
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ${If} $RFBackupExe != ""
    Delete "$RFBackupExe"
    StrCpy $RFBackupExe ""
  ${EndIf}
!macroend
