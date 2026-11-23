; Installer hooks for Vimmi (Tauri, Windows).
;
; Vimmi up to 0.7 was an Electron app (electron-builder). When this installer arrives as its update,
; the old app is removed quietly first; notes and settings stay (its settings and keys are taken
; over by the new app on its first start). After a silent update the new app starts again.

!define VIMMI_ELECTRON_GUID "750d9110-42f7-5bf9-afcf-8d3ea3b5eaae"

!macro NSIS_HOOK_PREINSTALL
  ReadRegStr $R0 HKCU "Software\${VIMMI_ELECTRON_GUID}" "InstallLocation"
  ${If} $R0 != ""
  ${AndIf} ${FileExists} "$R0\Uninstall Vimmi.exe"
    DetailPrint "Odstraňuji předchozí verzi Vimmi…"
    ; _?= keeps the uninstaller in place, so ExecWait waits until it has finished.
    ExecWait '"$R0\Uninstall Vimmi.exe" /S /currentuser _?=$R0'
    Delete "$R0\Uninstall Vimmi.exe"
    RMDir "$R0"
    DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${VIMMI_ELECTRON_GUID}"
    DeleteRegKey HKCU "Software\${VIMMI_ELECTRON_GUID}"
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; electron-updater asks for a restart with --force-run. A visible install offers "run Vimmi" on its
  ; last page itself, so only a silent one starts the new app here.
  ${If} ${Silent}
    ${GetParameters} $R1
    ClearErrors
    ${GetOptions} $R1 "--force-run" $R2
    ${IfNot} ${Errors}
      Exec '"$INSTDIR\vimmi.exe"'
    ${EndIf}
  ${EndIf}
!macroend
