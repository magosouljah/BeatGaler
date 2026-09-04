; Task 21.2 — compatibility bridge for the published 0.7.4 NSIS identity.
;
; Tauri's NSIS updater keys previous-install discovery by PRODUCTNAME. 0.7.4
; shipped as "Beat Galer" while the final visible product name is "Galer".
; Without this hook, /UPDATE can choose a new install directory and leave the
; old installation beside it. The hook reuses the legacy install location,
; then retires only the legacy registry/shortcut names after the new install
; has been written successfully.

!define GALER_LEGACY_PRODUCTNAME "Beat Galer"
!define GALER_LEGACY_MANUPRODUCTKEY "Software\beatgaler\Beat Galer"
!define GALER_LEGACY_UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\Beat Galer"

Var GalerLegacyUpgrade
Var GalerLegacyHadDesktopShortcut
Var GalerLegacyHadStartMenuShortcut
Var GalerPreHookInstallDir

!macro NSIS_HOOK_PREINSTALL
  StrCpy $GalerLegacyUpgrade 0
  StrCpy $GalerLegacyHadDesktopShortcut 0
  StrCpy $GalerLegacyHadStartMenuShortcut 0
  StrCpy $GalerPreHookInstallDir $INSTDIR

  ; The manufacturer segment is "beatgaler" in both the old and final bundle
  ; identifiers, so this key contains the exact 0.7.4 install directory without
  ; relying on the quoted InstallLocation value.
  ReadRegStr $R8 SHCTX "${GALER_LEGACY_MANUPRODUCTKEY}" ""
  StrCmp $R8 "" galer_legacy_pre_done

  ; Require the old uninstall registration too; a stray directory alone is not
  ; enough evidence that this machine has a managed 0.7.4 installation.
  ReadRegStr $R9 SHCTX "${GALER_LEGACY_UNINSTKEY}" "DisplayVersion"
  StrCmp $R9 "" galer_legacy_pre_done

  StrCpy $GalerLegacyUpgrade 1
  StrCpy $INSTDIR $R8

  ; Tauri executes `SetOutPath $INSTDIR` immediately before PREINSTALL. Merely
  ; changing $INSTDIR here does not retarget NSIS File extraction, so explicitly
  ; select the legacy directory again before any application/resource files are
  ; copied. Remove only the now-empty candidate directory Tauri selected first;
  ; RMDir is deliberately non-recursive and therefore refuses to delete a real
  ; pre-existing Galer installation or any directory containing user data.
  SetOutPath $INSTDIR
  StrCmp $GalerPreHookInstallDir $INSTDIR galer_legacy_output_ready
  RMDir "$GalerPreHookInstallDir"

galer_legacy_output_ready:
  DetailPrint "Galer upgrade: reusing Beat Galer install location $INSTDIR"

  IfFileExists "$DESKTOP\${GALER_LEGACY_PRODUCTNAME}.lnk" 0 +2
    StrCpy $GalerLegacyHadDesktopShortcut 1
  IfFileExists "$SMPROGRAMS\${GALER_LEGACY_PRODUCTNAME}.lnk" 0 +2
    StrCpy $GalerLegacyHadStartMenuShortcut 1

galer_legacy_pre_done:
!macroend

!macro NSIS_HOOK_POSTINSTALL
  StrCmp $GalerLegacyUpgrade 1 0 galer_legacy_post_done

  ; The new Galer registration/uninstaller has already been written by Tauri at
  ; this point. Remove only the stale old-name registrations now, never before
  ; the new installation is durable.
  DeleteRegKey SHCTX "${GALER_LEGACY_UNINSTKEY}"
  DeleteRegKey SHCTX "${GALER_LEGACY_MANUPRODUCTKEY}"

  ; /UPDATE intentionally skips normal shortcut creation. Preserve the user's
  ; previous shortcut choices while renaming visible shortcuts to Galer.
  StrCmp $GalerLegacyHadStartMenuShortcut 1 0 +4
    Delete "$SMPROGRAMS\${GALER_LEGACY_PRODUCTNAME}.lnk"
    CreateShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\${PRODUCTNAME}.lnk"

  StrCmp $GalerLegacyHadDesktopShortcut 1 0 +4
    Delete "$DESKTOP\${GALER_LEGACY_PRODUCTNAME}.lnk"
    CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    !insertmacro SetLnkAppUserModelId "$DESKTOP\${PRODUCTNAME}.lnk"

  ; Clean the pre-2.0 start-menu folder form if an older installer happened to
  ; create it; only the known Beat Galer shortcut/folder is touched.
  Delete "$SMPROGRAMS\${GALER_LEGACY_PRODUCTNAME}\${GALER_LEGACY_PRODUCTNAME}.lnk"
  RMDir "$SMPROGRAMS\${GALER_LEGACY_PRODUCTNAME}"

galer_legacy_post_done:
!macroend
