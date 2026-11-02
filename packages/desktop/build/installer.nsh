; NullHost installer hooks (included by electron-builder's NSIS script).

!macro customUnInstall
  ; On a real uninstall (not an upgrade, which runs the old uninstaller too):
  ; remove NullHost's region from the hosts file and delete its scheduled tasks.
  ; Everything else in the hosts file, the config and the snapshots stay.
  ${ifNot} ${isUpdated}
    ExecWait '"$INSTDIR\NullHost.exe" --uninstall-cleanup' $0
    DetailPrint "NullHost clean-up finished (exit $0)"
  ${endIf}
!macroend
