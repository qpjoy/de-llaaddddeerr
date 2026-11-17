; This runs only inside the elevated full installer/uninstaller. The Electron
; application remains asInvoker and never starts this helper with RunAs.
!macro customInstall
  ExecWait '"$INSTDIR\resources\network-service\MinCaveNetworkService.exe" install' $0
  ${If} $0 != 0
    MessageBox MB_OK|MB_ICONSTOP "MinCave 网络服务安装失败（$0）。请重新运行完整安装包进行修复。"
    SetErrorLevel 1
    Abort
  ${EndIf}
!macroend

!macro customUnInstall
  ${If} ${FileExists} "$INSTDIR\resources\network-service\MinCaveNetworkService.exe"
    ${If} ${isUpdated}
      ; Preserve identity and registration, but drain owned tunnels and stop
      ; the service so no engine executable remains in use during replacement.
      ExecWait '"$INSTDIR\resources\network-service\MinCaveNetworkService.exe" stop' $0
    ${Else}
      ; Full uninstall first cleans only MinCave-owned routes, NRPT and TUN.
      ExecWait '"$INSTDIR\resources\network-service\MinCaveNetworkService.exe" uninstall' $0
    ${EndIf}
    ${If} $0 != 0
      MessageBox MB_OK|MB_ICONSTOP "MinCave 网络服务尚未停止或网络清理失败（$0），卸载已停止。请稍后重试。"
      SetErrorLevel 1
      Abort
    ${EndIf}
  ${EndIf}
!macroend
