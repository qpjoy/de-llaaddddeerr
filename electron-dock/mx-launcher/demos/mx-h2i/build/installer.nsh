; This runs only inside the elevated full installer/uninstaller. The Electron
; application remains asInvoker and never starts this helper with RunAs.
!ifndef BUILD_UNINSTALLER
  !include "${PROJECT_DIR}\out\windows-network-service\install-directory.nsh"
  !include "nsDialogs.nsh"
  Var MinCaveApprovedEmptyDirectory

  ; Only normalize separators. The PowerShell check still rejects relative
  ; components and special names before Windows can reinterpret them.
  !macro MinCaveNormalizeDirectory
    Push $5
    Push $6
    Push $7
    Push $8
    StrCpy $5 ""
    StrCpy $6 0
    StrLen $8 $9
    ${While} $6 < $8
      StrCpy $7 $9 1 $6
      ${If} $7 == "/"
        StrCpy $7 "\"
      ${EndIf}
      StrCpy $5 "$5$7"
      IntOp $6 $6 + 1
    ${EndWhile}
    StrCpy $9 $5
    ${While} $8 > 3
      StrCpy $7 $9 1 -1
      ${If} $7 != "\"
        ${Break}
      ${EndIf}
      StrCpy $9 $9 -1
      IntOp $8 $8 - 1
    ${EndWhile}
    Pop $8
    Pop $7
    Pop $6
    Pop $5
  !macroend

  ; Use the standard directory page with our own leave callback. The
  ; electron-builder page has no hook for validating the edited path.
  !macro customWelcomePage
    !ifdef allowToChangeInstallationDirectory
      !undef allowToChangeInstallationDirectory
      !define MINCAVE_INSTALL_DIRECTORY_PAGE
    !endif
  !macroend

  !macro customPageAfterChangeDir
    !ifdef MINCAVE_INSTALL_DIRECTORY_PAGE
      !insertmacro skipPageIfUpdated
      !define MUI_PAGE_CUSTOMFUNCTION_LEAVE MinCaveDirectoryLeave
      !define MUI_DIRECTORYPAGE_TEXT_TOP "请选择由系统或管理员管理的本地 NTFS/ReFS 目录。可以使用默认目录，或选择其他符合要求的磁盘子目录。"
      !insertmacro MUI_PAGE_DIRECTORY
      !define allowToChangeInstallationDirectory

      Function MinCaveDirectoryLeave
        ; MUI stores the final edit into $INSTDIR after the leave callback.
        StrCpy $MinCaveApprovedEmptyDirectory ""
        Push $9
        ${NSD_GetText} $mui.DirectoryPage.Directory $9
        !insertmacro MinCaveNormalizeDirectory
        !insertmacro MinCaveValidateDirectory "$9" "preview"
        ${If} $0 == 2
          MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "所选空目录由普通用户拥有。是否修正权限并继续？$\r$\n$\r$\n安装器会在原路径重新创建一个由管理员组管理的空目录。$\r$\n$\r$\n$9" IDYES approveEmptyDirectory
          Pop $9
          Abort
          approveEmptyDirectory:
          StrCpy $MinCaveApprovedEmptyDirectory $9
          StrCpy $0 0
        ${EndIf}
        ${If} $0 == 0
          ${NSD_SetText} $mui.DirectoryPage.Directory "$9"
        ${EndIf}
        Pop $9
        ${If} $0 != 0
          !insertmacro MinCaveDirectoryError
          Abort
        ${EndIf}
      FunctionEnd
    !endif
  !macroend

  !macro MinCaveDirectoryError
    MessageBox MB_OK|MB_ICONSTOP "无法安装到所选目录。请选择默认目录，或由系统或管理员管理的本地 NTFS/ReFS 磁盘子目录。$\r$\n$\r$\n$1"
  !macroend

  !macro MinCaveValidateDirectory TARGET MODE
      ; Pass the selected path as a register value, never System plugin source.
      Push $9
      Push $2
      StrCpy $9 ${TARGET}
      System::Call 'kernel32::SetEnvironmentVariableW(w "MINCAVE_INSTALL_DIRECTORY", w r9) i.r0'
      ${If} $0 == 0
        SetErrorLevel 1
        Quit
      ${EndIf}
      System::Call 'kernel32::SetEnvironmentVariableW(w "MINCAVE_INSTALL_DIRECTORY_MODE", w "${MODE}") i.r0'
      ${If} $0 == 0
        SetErrorLevel 1
        Quit
      ${EndIf}
      StrCpy $2 "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
      ${If} ${FileExists} "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
        StrCpy $2 "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
      ${EndIf}
      StrCpy $9 "$SYSDIR\WindowsPowerShell\v1.0\Modules"
      System::Call 'kernel32::SetEnvironmentVariableW(w "PSModulePath", w r9) i.r0'
      ${If} $0 == 0
        SetErrorLevel 1
        Quit
      ${EndIf}
      System::Call 'kernel32::SetEnvironmentVariableW(w "MINCAVE_INSTALL_DIRECTORY_SCRIPT", w "${MINCAVE_INSTALL_DIRECTORY_SCRIPT}") i.r0'
      ${If} $0 == 0
        SetErrorLevel 1
        Quit
      ${EndIf}
      nsExec::ExecToStack /TIMEOUT=120000 '"$2" -NoProfile -NonInteractive -OutputFormat Text -ExecutionPolicy Bypass -EncodedCommand ${MINCAVE_INSTALL_DIRECTORY_COMMAND}'
      Pop $0
      Pop $1
      System::Call 'kernel32::SetEnvironmentVariableW(w "MINCAVE_INSTALL_DIRECTORY", p 0)'
      System::Call 'kernel32::SetEnvironmentVariableW(w "MINCAVE_INSTALL_DIRECTORY_SCRIPT", p 0)'
      System::Call 'kernel32::SetEnvironmentVariableW(w "MINCAVE_INSTALL_DIRECTORY_MODE", p 0)'
      Pop $2
      Pop $9
  !macroend
!endif

; Check again and protect the destination before old files are removed or
; new files are written, including installs that skip the directory page.
!macro customHeader
  !ifndef BUILD_UNINSTALLER
    Section "-MinCave installation directory"
      Push $9
      StrCpy $9 $INSTDIR
      !insertmacro MinCaveNormalizeDirectory
      StrCpy $INSTDIR $9
      Pop $9
      ${If} $MinCaveApprovedEmptyDirectory S== $INSTDIR
      ${AndIf} $MinCaveApprovedEmptyDirectory != ""
        ; Release the install directory as the current working directory.
        SetOutPath $SYSDIR
        !insertmacro MinCaveValidateDirectory "$INSTDIR" "repair-empty"
      ${Else}
        !insertmacro MinCaveValidateDirectory "$INSTDIR" "prepare"
      ${EndIf}
      ${If} $0 != 0
        !insertmacro MinCaveDirectoryError
        SetErrorLevel 1
        Quit
      ${EndIf}
    SectionEnd

    ; The registered uninstaller still runs the old service helper. Drain
    ; its tunnel first with the new helper, using the verified old resources.
    Section "-MinCave network upgrade preparation"
      ReadRegStr $4 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
      ${If} $4 != ""
      ${AndIf} ${FileExists} "$4\resources\network-service\MinCaveNetworkService.exe"
        ClearErrors
        GetTempFileName $3 "$INSTDIR"
        ${If} ${Errors}
          MessageBox MB_OK|MB_ICONSTOP "无法在安装目录中准备 MinCave 升级。"
          SetErrorLevel 1
          Quit
        ${EndIf}
        ; Extract to the protected destination validated by the first section.
        File /oname=$3 "${PROJECT_DIR}\out\windows-network-service\MinCaveNetworkService.exe"
        ${If} ${Errors}
          Delete "$3"
          MessageBox MB_OK|MB_ICONSTOP "无法解压 MinCave 升级程序。"
          SetErrorLevel 1
          Quit
        ${EndIf}
        nsExec::ExecToStack '"$3" prepare-upgrade "$4"'
        Pop $0
        Pop $1
        Delete "$3"
        ${If} $0 != 0
          DetailPrint "MinCave network upgrade preparation failed ($0): $1"
          MessageBox MB_OK|MB_ICONSTOP "MinCave 升级准备失败（$0），安装已停止。$\r$\n$\r$\n$1"
          SetErrorLevel 1
          Quit
        ${EndIf}
      ${EndIf}
    SectionEnd
  !endif
!macroend

; Updates must preserve the destination directory and its protected ACL.
; Keep electron-builder's transactional removal of contents and its rollback.
!macro customRemoveFiles
  ${If} ${isUpdated}
    CreateDirectory "$PLUGINSDIR\old-install"
    Push ""
    Call un.atomicRMDir
    Pop $R0
    ${If} $R0 != 0
      Push ""
      Call un.restoreFiles
      Pop $R0
      Abort "MinCave 文件仍在使用，已恢复原安装。请退出客户端后重试。"
    ${EndIf}
    ; atomicRMDir moves files and leaves only empty shallow directories.
    FindFirst $R0 $R1 "$INSTDIR\*"
    ${DoWhile} $R1 != ""
      ${If} $R1 != "."
      ${AndIf} $R1 != ".."
        RMDir /r "$INSTDIR\$R1"
        Delete "$INSTDIR\$R1"
      ${EndIf}
      FindNext $R0 $R1
    ${Loop}
    FindClose $R0
  ${Else}
    SetOutPath $TEMP
    RMDir /r $INSTDIR
  ${EndIf}
!macroend

!macro customInstall
  ; Capture stderr as well as the exit code so ACL/resource/SCM failures
  ; include their actual reason. No command shell or elevation fallback.
  nsExec::ExecToStack '"$INSTDIR\resources\network-service\MinCaveNetworkService.exe" install'
  Pop $0
  Pop $1
  ${If} $0 != 0
    ${If} $1 == ""
      StrCpy $1 "服务程序没有返回错误详情。请检查 Windows 应用程序事件日志。"
    ${EndIf}
    DetailPrint "MinCave network service installation failed ($0): $1"
    MessageBox MB_OK|MB_ICONSTOP "MinCave 网络服务安装失败（$0）。$\r$\n$\r$\n$1"
    SetErrorLevel 1
    Abort
  ${EndIf}
!macroend

!macro customUnInstall
  ${If} ${FileExists} "$INSTDIR\resources\network-service\MinCaveNetworkService.exe"
    ${If} ${isUpdated}
      ; Preserve identity and registration, but drain owned tunnels and stop
      ; the service so no engine executable remains in use during replacement.
      nsExec::ExecToStack '"$INSTDIR\resources\network-service\MinCaveNetworkService.exe" stop'
    ${Else}
      ; Full uninstall first cleans only MinCave-owned routes, NRPT and TUN.
      nsExec::ExecToStack '"$INSTDIR\resources\network-service\MinCaveNetworkService.exe" uninstall'
    ${EndIf}
    Pop $0
    Pop $1
    ${If} $0 != 0
      DetailPrint "MinCave network service cleanup failed ($0): $1"
      MessageBox MB_OK|MB_ICONSTOP "MinCave 网络服务清理失败（$0），卸载已停止。$\r$\n$\r$\n$1"
      SetErrorLevel 1
      Abort
    ${EndIf}
  ${EndIf}
!macroend
