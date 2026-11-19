//go:build windows

package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"

	winio "github.com/Microsoft/go-winio"
	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

type installedIdentity struct {
	Protocol  int               `json:"protocol"`
	Version   string            `json:"version"`
	PublicKey string            `json:"publicKey"`
	Hashes    map[string]string `json:"hashes,omitempty"`
}

type networkService struct {
	root       string
	stateDir   string
	identity   installedIdentity
	signingKey ed25519.PrivateKey
	operations sync.Mutex
	workers    sync.WaitGroup
	listener   net.Listener
	verified   map[string]os.FileInfo
	poisoned   bool
}

func main() {
	executable, err := os.Executable()
	if err != nil {
		fatal(err)
	}
	args := os.Args[1:]
	preparingUpgrade := len(args) == 2 && args[0] == "prepare-upgrade"
	root := filepath.Clean(filepath.Join(filepath.Dir(executable), "..", ".."))
	if preparingUpgrade {
		err = verifyInstallationDirectory(filepath.Dir(executable))
		root = filepath.Clean(args[1])
	} else {
		err = verifyInstallRoot(root, executable)
	}
	if err != nil {
		fatal(fmt.Errorf("verify-installation: %w", err))
	}
	programData, err := windows.KnownFolderPath(windows.FOLDERID_ProgramData, 0)
	if err != nil {
		fatal(fmt.Errorf("resolve-program-data: %w", err))
	}
	service := &networkService{root: root, stateDir: filepath.Join(programData, "MinCave", "network-service")}
	if preparingUpgrade {
		err = service.prepareUpgrade()
	} else if len(os.Args) == 2 && os.Args[1] == "install" {
		err = service.install(executable)
	} else if len(os.Args) == 2 && os.Args[1] == "uninstall" {
		err = service.uninstall()
	} else if len(os.Args) == 2 && os.Args[1] == "stop" {
		err = service.stop()
	} else if len(os.Args) != 1 {
		err = errors.New("unsupported service command")
	} else {
		var isService bool
		isService, err = svc.IsWindowsService()
		if err == nil && !isService {
			err = errors.New("start MinCave Network Service through Windows Service Control Manager")
		}
		if err == nil {
			err = service.loadIdentity()
		}
		if err == nil {
			err = svc.Run(serviceName, service)
		}
	}
	if err != nil {
		fatal(err)
	}
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "MinCave Network Service:", err)
	os.Exit(1)
}

func rejectReparse(path string) error {
	for current := filepath.Clean(path); ; current = filepath.Dir(current) {
		p, err := windows.UTF16PtrFromString(current)
		if err != nil {
			return err
		}
		attributes, err := windows.GetFileAttributes(p)
		if err != nil {
			return err
		}
		if attributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
			return errors.New("service paths must not contain reparse points")
		}
		if filepath.Dir(current) == current {
			return nil
		}
	}
}

func verifyInstallRoot(root, executable string) error {
	if !strings.EqualFold(executable, filepath.Join(root, "resources", "network-service", "MinCaveNetworkService.exe")) {
		return errors.New("unexpected network service installation path")
	}
	return verifyInstallationDirectory(root)
}

func protectDirectory(path string) error {
	if err := os.MkdirAll(path, 0700); err != nil {
		return err
	}
	if err := rejectReparse(path); err != nil {
		return err
	}
	return protectStatePath(path)
}

func protectStatePath(path string) error {
	if err := rejectReparse(path); err != nil {
		return err
	}
	descriptor, err := windows.SecurityDescriptorFromString("O:SYG:BA" + protectedStateDACL)
	if err != nil {
		return err
	}
	acl, _, err := descriptor.DACL()
	if err != nil {
		return err
	}
	owner, _, err := descriptor.Owner()
	if err != nil {
		return err
	}
	return windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION|windows.OWNER_SECURITY_INFORMATION, owner, nil, acl, nil)
}

func verifyStateTree(root string) error {
	return filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) (err error) {
		defer func() {
			if err != nil {
				err = fmt.Errorf("verify-state-path %q: %w", path, err)
			}
		}()
		if walkErr != nil {
			return walkErr
		}
		if err := rejectReparse(path); err != nil {
			return err
		}
		descriptor, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
		if err != nil {
			return err
		}
		if err := trustedACL(path, false); err != nil {
			return err
		}
		owner, _, err := descriptor.Owner()
		if err != nil {
			return err
		}
		if !owner.IsWellKnown(windows.WinLocalSystemSid) && !owner.IsWellKnown(windows.WinBuiltinAdministratorsSid) {
			return errors.New("untrusted pre-existing network service state; administrator repair is required")
		}
		// Reapply a protected ACL to every existing entry: explicit inherited/user
		// write ACEs must not survive an installation repair.
		aclSD, err := windows.SecurityDescriptorFromString(protectedStateDACL)
		if err != nil {
			return err
		}
		acl, _, err := aclSD.DACL()
		if err != nil {
			return err
		}
		return windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, acl, nil)
	})
}

func enableInstallPrivilege(name string) error {
	var token windows.Token
	if err := windows.OpenProcessToken(windows.CurrentProcess(), windows.TOKEN_ADJUST_PRIVILEGES|windows.TOKEN_QUERY, &token); err != nil {
		return err
	}
	defer token.Close()
	var id windows.LUID
	if err := windows.LookupPrivilegeValue(nil, windows.StringToUTF16Ptr(name), &id); err != nil {
		return err
	}
	privileges := windows.Tokenprivileges{PrivilegeCount: 1}
	privileges.Privileges[0] = windows.LUIDAndAttributes{Luid: id, Attributes: windows.SE_PRIVILEGE_ENABLED}
	return windows.AdjustTokenPrivileges(token, false, &privileges, 0, nil, nil)
}

func networkServiceConfig() mgr.Config {
	// mgr.CreateService fills a zero ServiceType, but mgr.Service.UpdateConfig
	// passes it straight to ChangeServiceConfig, where zero is invalid.
	return mgr.Config{
		ServiceType:      windows.SERVICE_WIN32_OWN_PROCESS,
		DisplayName:      "MinCave Network Service",
		Description:      "MinCave office network and tunnel operations",
		StartType:        mgr.StartAutomatic,
		ServiceStartName: "LocalSystem",
		Dependencies:     []string{"Tcpip", "Nsi"},
	}
}

func (s *networkService) install(executable string) (err error) {
	stage := "connect-service-manager"
	defer func() {
		if err != nil {
			err = fmt.Errorf("install/%s: %w", stage, err)
		}
	}()
	manager, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer manager.Disconnect()
	stage = "stop-existing-service"
	existing, openErr := manager.OpenService(serviceName)
	if openErr == nil {
		stopErr := stopService(existing)
		existing.Close()
		if stopErr != nil {
			return stopErr
		}
	} else if !errors.Is(openErr, windows.ERROR_SERVICE_DOES_NOT_EXIST) {
		return openErr
	}
	stage = "enable-restore-privilege"
	if err = enableInstallPrivilege("SeRestorePrivilege"); err != nil {
		return err
	}
	stage = "prepare-service-state"
	if err = s.prepareServiceState(openErr == nil); err != nil {
		return err
	}
	stage = "prepare-shared-endpoint-registry"
	if err = s.prepareEndpointRegistry(); err != nil {
		return err
	}
	stage = "prepare-service-identity"
	keyPath := filepath.Join(s.stateDir, "identity.key")
	key, err := os.ReadFile(keyPath)
	if errors.Is(err, os.ErrNotExist) {
		_, key, err = ed25519.GenerateKey(rand.Reader)
		if err == nil {
			err = os.WriteFile(keyPath, key, 0600)
		}
	}
	if err != nil || len(key) != ed25519.PrivateKeySize {
		return errors.New("network service identity could not be installed")
	}
	if err = protectStatePath(keyPath); err != nil {
		return err
	}
	stage = "record-installed-resources"
	s.identity = installedIdentity{Protocol: protocolVersion, Version: serviceVersion, PublicKey: base64.StdEncoding.EncodeToString(ed25519.PrivateKey(key).Public().(ed25519.PublicKey)), Hashes: map[string]string{}}
	for _, name := range []string{"mx-h2i.exe", `resources\network-service\worker.cjs`, `resources\wireguard\win32-x64\wireguard.exe`, `resources\wireguard\win32-x64\wg.exe`, `resources\network-service\mihomo.exe`} {
		hash, hashError := fileHash(filepath.Join(s.root, name))
		if hashError != nil {
			return fmt.Errorf("required service resource %q: %w", name, hashError)
		}
		s.identity.Hashes[name] = hash
	}
	identity, _ := json.Marshal(s.identity)
	if err = os.WriteFile(filepath.Join(s.stateDir, "installation.json"), identity, 0600); err != nil {
		return err
	}
	if err = protectStatePath(filepath.Join(s.stateDir, "installation.json")); err != nil {
		return err
	}
	publicIdentity, _ := json.Marshal(installedIdentity{Protocol: protocolVersion, Version: serviceVersion, PublicKey: s.identity.PublicKey})
	if err = os.WriteFile(filepath.Join(s.root, "resources", "network-service", "identity.json"), publicIdentity, 0644); err != nil {
		return err
	}
	stage = "register-service"
	config := networkServiceConfig()
	installed, err := manager.OpenService(serviceName)
	if err == nil {
		defer installed.Close()
		if err = stopService(installed); err != nil {
			return err
		}
		config.BinaryPathName = `"` + executable + `"`
		err = installed.UpdateConfig(config)
	} else if errors.Is(err, windows.ERROR_SERVICE_DOES_NOT_EXIST) {
		installed, err = manager.CreateService(serviceName, executable, config)
		if err == nil {
			defer installed.Close()
		}
	}
	if err != nil {
		return err
	}
	stage = "configure-recovery"
	if err = installed.SetRecoveryActions([]mgr.RecoveryAction{{Type: mgr.ServiceRestart, Delay: 5 * time.Second}}, 86400); err != nil {
		return err
	}
	stage = "start-service"
	if err = installed.Start(); err != nil {
		return err
	}
	stage = "wait-for-running"
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		status, queryErr := installed.Query()
		if queryErr != nil {
			return queryErr
		}
		if status.State == svc.Running {
			return nil
		}
		if status.State == svc.Stopped {
			return fmt.Errorf("network service stopped during installation (win32=%d, service=%d)", status.Win32ExitCode, status.ServiceSpecificExitCode)
		}
		time.Sleep(100 * time.Millisecond)
	}
	return errors.New("network service did not become ready; repair the installation")
}

func stopService(service *mgr.Service) error {
	status, err := service.Query()
	if err != nil || status.State == svc.Stopped {
		return err
	}
	if status.State != svc.StopPending {
		if _, err = service.Control(svc.Stop); err != nil && !errors.Is(err, windows.ERROR_SERVICE_NOT_ACTIVE) {
			return err
		}
	}
	deadline := time.Now().Add(3 * time.Minute)
	for time.Now().Before(deadline) {
		status, err = service.Query()
		if err != nil || status.State == svc.Stopped {
			return err
		}
		time.Sleep(200 * time.Millisecond)
	}
	return errors.New("network service is still stopping; installation was not changed")
}

func (s *networkService) stop() error {
	manager, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer manager.Disconnect()
	installed, err := manager.OpenService(serviceName)
	if errors.Is(err, windows.ERROR_SERVICE_DOES_NOT_EXIST) {
		return nil
	}
	if err != nil {
		return err
	}
	defer installed.Close()
	return s.stopAndClean(installed)
}

func (s *networkService) prepareUpgrade() error {
	manager, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("upgrade/connect-service-manager: %w", err)
	}
	defer manager.Disconnect()
	installed, err := manager.OpenService(serviceName)
	if errors.Is(err, windows.ERROR_SERVICE_DOES_NOT_EXIST) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("upgrade/open-service: %w", err)
	}
	defer installed.Close()
	config, err := installed.Config()
	if err != nil {
		return fmt.Errorf("upgrade/query-service: %w", err)
	}
	executable := filepath.Join(s.root, "resources", "network-service", "MinCaveNetworkService.exe")
	command, err := windows.DecomposeCommandLine(config.BinaryPathName)
	if err != nil || len(command) != 1 || !strings.EqualFold(filepath.Clean(command[0]), executable) {
		return errors.New("upgrade/verify-service: registered service does not match the previous MinCave installation")
	}
	if err := verifyInstallRoot(s.root, executable); err != nil {
		return fmt.Errorf("upgrade/verify-previous-installation: %w", err)
	}
	return s.stopAndClean(installed)
}

func (s *networkService) stopAndClean(installed *mgr.Service) error {
	if err := stopService(installed); err != nil {
		return fmt.Errorf("stop-service: %w", err)
	}
	if err := s.loadIdentity(); err != nil {
		return fmt.Errorf("load-service-identity: %w", err)
	}
	result := s.runWorker(serviceRequest{Operation: "uninstall"}, "SYSTEM")
	if !result.OK {
		return fmt.Errorf("cleanup-network (%s): %s", result.Code, result.Message)
	}
	if s.poisoned {
		return errors.New("cleanup-network: could not verify worker shutdown")
	}
	return nil
}

func (s *networkService) uninstall() error {
	manager, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer manager.Disconnect()
	installed, err := manager.OpenService(serviceName)
	if errors.Is(err, windows.ERROR_SERVICE_DOES_NOT_EXIST) {
		return nil
	}
	if err != nil {
		return err
	}
	defer installed.Close()
	if err = stopService(installed); err != nil {
		return err
	}
	if err = s.loadIdentity(); err != nil {
		return err
	}
	response := s.runWorker(serviceRequest{Operation: "uninstall"}, "SYSTEM")
	if !response.OK {
		return errors.New(response.Message)
	}
	if err = installed.Delete(); err != nil {
		return err
	}
	return os.RemoveAll(s.stateDir)
}

func (s *networkService) loadIdentity() error {
	if err := verifyStateTree(s.stateDir); err != nil {
		return err
	}
	data, err := os.ReadFile(filepath.Join(s.stateDir, "installation.json"))
	if err != nil {
		return err
	}
	if err = json.Unmarshal(data, &s.identity); err != nil || s.identity.Protocol != protocolVersion {
		return errors.New("network service installation must be repaired")
	}
	key, err := os.ReadFile(filepath.Join(s.stateDir, "identity.key"))
	if err != nil || len(key) != ed25519.PrivateKeySize {
		return errors.New("network service identity must be repaired")
	}
	s.signingKey = ed25519.PrivateKey(key)
	if base64.StdEncoding.EncodeToString(s.signingKey.Public().(ed25519.PublicKey)) != s.identity.PublicKey {
		return errors.New("service identity does not match installation")
	}
	return s.verifyResources()
}

func fileHash(path string) (string, error) {
	if err := rejectReparse(path); err != nil {
		return "", err
	}
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	hash := sha256.New()
	_, err = io.Copy(hash, file)
	return hex.EncodeToString(hash.Sum(nil)), err
}

func (s *networkService) verifyResources() error {
	if len(s.identity.Hashes) != 5 {
		return errors.New("network service installation has an invalid resource manifest")
	}
	if s.verified == nil {
		s.verified = make(map[string]os.FileInfo)
	}
	for name, expected := range s.identity.Hashes {
		if filepath.IsAbs(name) || strings.Contains(name, "..") {
			return errors.New("invalid installed resource path")
		}
		resource := filepath.Join(s.root, name)
		info, statErr := os.Stat(resource)
		if statErr != nil {
			return errors.New("service resource missing")
		}
		if previous := s.verified[name]; previous != nil && os.SameFile(previous, info) && previous.Size() == info.Size() && previous.ModTime() == info.ModTime() {
			continue
		}
		actual, err := fileHash(resource)
		if err != nil || actual != expected {
			return errors.New("network service resources changed; repair the full installation")
		}
		s.verified[name] = info
	}
	return nil
}

func (s *networkService) Execute(_ []string, requests <-chan svc.ChangeRequest, changes chan<- svc.Status) (bool, uint32) {
	changes <- svc.Status{State: svc.StartPending}
	// Node/libuv opens duplex pipes with GENERIC_READ|GENERIC_WRITE. Its
	// required write mapping includes FILE_CREATE_PIPE_INSTANCE, so endpoint
	// authenticity is enforced by the pinned, encrypted handshake as well.
	listener, err := winio.ListenPipe(pipeName, &winio.PipeConfig{SecurityDescriptor: "D:P(D;;GA;;;NU)(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGW;;;AU)", InputBufferSize: 65536, OutputBufferSize: 65536})
	if err != nil {
		return false, 1
	}
	s.listener = listener
	acceptDone := make(chan struct{})
	go func() { defer close(acceptDone); s.acceptConnections(listener) }()
	changes <- svc.Status{State: svc.Running, Accepts: svc.AcceptStop | svc.AcceptShutdown}
	for request := range requests {
		switch request.Cmd {
		case svc.Interrogate:
			changes <- request.CurrentStatus
		case svc.Stop, svc.Shutdown:
			changes <- svc.Status{State: svc.StopPending, WaitHint: 180000}
			listener.Close()
			<-acceptDone
			s.workers.Wait()
			return false, 0
		}
	}
	return false, 0
}

func (s *networkService) acceptConnections(listener net.Listener) {
	limit := make(chan struct{}, 8)
	for {
		connection, err := listener.Accept()
		if err != nil {
			return
		}
		select {
		case limit <- struct{}{}:
			s.workers.Add(1)
			go func() {
				defer s.workers.Done()
				defer func() { <-limit }()
				defer connection.Close()
				s.handleConnection(connection)
			}()
		default:
			connection.Close()
		}
	}
}

func (s *networkService) callerSID(connection net.Conn) (string, error) {
	file, ok := connection.(interface{ Fd() uintptr })
	if !ok {
		return "", errors.New("pipe handle unavailable")
	}
	var pid uint32
	if err := windows.GetNamedPipeClientProcessId(windows.Handle(file.Fd()), &pid); err != nil {
		return "", err
	}
	process, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		return "", err
	}
	defer windows.CloseHandle(process)
	var name [32768]uint16
	size := uint32(len(name))
	if err = windows.QueryFullProcessImageName(process, 0, &name[0], &size); err != nil {
		return "", err
	}
	if !strings.EqualFold(filepath.Clean(windows.UTF16ToString(name[:size])), filepath.Join(s.root, "mx-h2i.exe")) {
		return "", errors.New("only the installed MinCave client may use this service")
	}
	var token windows.Token
	if err = windows.OpenProcessToken(process, windows.TOKEN_QUERY, &token); err != nil {
		return "", err
	}
	defer token.Close()
	user, err := token.GetTokenUser()
	if err != nil {
		return "", err
	}
	var session uint32
	var length uint32
	if err = windows.GetTokenInformation(token, windows.TokenSessionId, (*byte)(unsafe.Pointer(&session)), uint32(unsafe.Sizeof(session)), &length); err != nil || session == 0 {
		return "", errors.New("an interactive Windows session is required")
	}
	return user.User.Sid.String(), nil
}

func readLine(reader *bufio.Reader) ([]byte, error) {
	line, err := reader.ReadSlice('\n')
	if err != nil || len(line) > maxFrameBytes {
		return nil, errors.New("invalid or oversized pipe frame")
	}
	return line, nil
}

func (s *networkService) handleConnection(connection net.Conn) {
	connection.SetDeadline(time.Now().Add(8 * time.Second))
	sid, err := s.callerSID(connection)
	if err != nil {
		return
	}
	reader := bufio.NewReaderSize(connection, maxFrameBytes+1)
	line, err := readLine(reader)
	if err != nil {
		return
	}
	var hello helloRequest
	if json.Unmarshal(line, &hello) != nil {
		return
	}
	response, encryption, err := acceptHello(hello, sid, s.signingKey)
	if err != nil || json.NewEncoder(connection).Encode(response) != nil {
		return
	}
	line, err = readLine(reader)
	if err != nil {
		return
	}
	var frame sealedFrame
	if json.Unmarshal(line, &frame) != nil {
		return
	}
	request, err := openRequest(encryption, frame)
	if err != nil {
		return
	}
	deadline := time.Now().Add(3 * time.Minute)
	connection.SetDeadline(deadline)
	s.operations.Lock()
	result := serviceResponse{OK: true, Value: json.RawMessage(`{"protocol":1,"version":"1.0.0","capabilities":["wireguard","mihomo-tun","legacy-hdo-cleanup"]}`)}
	if time.Now().After(deadline.Add(-150 * time.Second)) {
		result = serviceResponse{Code: "service_busy", Message: "MinCave 网络服务正忙，请确认连接状态后重试。"}
	} else if s.poisoned {
		result = serviceResponse{Code: "service_requires_restart", Message: "网络操作尚未停止，请重启电脑后重试。"}
	} else if request.Operation != "capabilities" {
		result = s.runWorker(request, sid)
	} else if err := s.verifyResources(); err != nil {
		result = serviceResponse{Code: "installation_changed", Message: "请修复 MinCave 完整安装包以恢复网络服务。"}
	}
	s.operations.Unlock()
	sealed, err := seal(encryption, result)
	if err == nil {
		json.NewEncoder(connection).Encode(sealed)
	}
}

func (s *networkService) runWorker(request serviceRequest, sid string) serviceResponse {
	if s.poisoned {
		return serviceResponse{Code: "service_requires_restart", Message: "网络操作尚未停止，请重启电脑后重试。"}
	}
	if err := s.verifyResources(); err != nil {
		return serviceResponse{Code: "installation_changed", Message: err.Error()}
	}
	if err := s.verifyEndpointRegistry(); err != nil {
		return serviceResponse{Code: "untrusted_route_state", Message: "共享路由状态权限异常，请由管理员修复完整安装。"}
	}
	payload, _ := json.Marshal(struct {
		Operation string          `json:"operation"`
		Input     json.RawMessage `json:"input,omitempty"`
		OwnerSID  string          `json:"ownerSID"`
		StateDir  string          `json:"stateDir"`
		Root      string          `json:"root"`
	}{request.Operation, request.Input, sid, s.stateDir, s.root})
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, filepath.Join(s.root, "mx-h2i.exe"), filepath.Join(s.root, "resources", "network-service", "worker.cjs"))
	command.Dir = filepath.Join(s.root, "resources", "network-service")
	systemRoot, err := windows.GetSystemWindowsDirectory()
	if err != nil {
		return serviceResponse{Code: "windows_unavailable", Message: "Windows system directory could not be resolved"}
	}
	command.Env = workerEnvironment(systemRoot, s.stateDir)
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_NO_WINDOW | windows.CREATE_SUSPENDED}
	command.Stdin = bytes.NewReader(payload)
	var output limitedOutput
	command.Stdout = &output
	command.Stderr = io.Discard // No user keys, YAML, or credentials enter service logs.
	job, jobErr := newWorkerJob()
	if jobErr != nil {
		return serviceResponse{Code: "worker_isolation_failed", Message: "无法隔离网络操作，请修复安装。"}
	}
	defer windows.CloseHandle(job)
	command.Cancel = func() error { return windows.TerminateJobObject(job, 1) }
	command.WaitDelay = 5 * time.Second
	if err = command.Start(); err == nil {
		if err = attachAndResume(job, uint32(command.Process.Pid)); err != nil {
			command.Process.Kill()
		}
		waitErr := command.Wait()
		if err == nil {
			err = waitErr
		}
	}
	if err != nil {
		if !terminateWorkerJob(job) {
			s.poisoned = true
		}
	}
	if err != nil {
		return serviceResponse{Code: "network_operation_failed", Message: "MinCave network operation failed; repair the installation if the problem persists"}
	}
	var result serviceResponse
	if json.Unmarshal(output.Bytes(), &result) != nil {
		if !terminateWorkerJob(job) {
			s.poisoned = true
		}
		return serviceResponse{Code: "invalid_worker_response", Message: "MinCave network service returned an invalid response"}
	}
	if result.OK && request.Operation == "mihomo.start" {
		// A successfully recorded TUN is intentionally persistent. Other operation
		// descendants never survive a worker. Crash/timeout always kills the job.
		if err = releaseWorkerJob(job); err != nil {
			terminateWorkerJob(job)
			return serviceResponse{Code: "worker_isolation_failed", Message: "无法保留代理进程，请重试。"}
		}
	} else if !terminateWorkerJob(job) {
		s.poisoned = true
	}
	return result
}

type limitedOutput struct{ bytes.Buffer }

func (b *limitedOutput) Write(value []byte) (int, error) {
	if b.Len()+len(value) > maxFrameBytes {
		return 0, errors.New("worker response exceeded the service limit")
	}
	return b.Buffer.Write(value)
}
