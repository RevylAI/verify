//go:build unix

package verify

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"syscall"
	"time"
)

const processGroupsSupported = true

func setProcessGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

// stopProcessGroup signals a child's process group, then waits for every process in it to exit.
func stopProcessGroup(pgid int, grace time.Duration, label string) error {
	for _, step := range []struct {
		signal syscall.Signal
		wait   time.Duration
	}{{syscall.SIGTERM, grace}, {syscall.SIGKILL, 2 * time.Second}} {
		if !processGroupAlive(pgid) {
			return nil
		}
		if err := syscall.Kill(-pgid, step.signal); err != nil {
			if errors.Is(err, syscall.ESRCH) {
				return nil
			}
			return err
		}
		until := time.Now().Add(step.wait)
		for time.Now().Before(until) && processGroupAlive(pgid) {
			time.Sleep(100 * time.Millisecond)
		}
	}
	if processGroupAlive(pgid) {
		return fmt.Errorf("%s (process group %d) was still running after SIGKILL", label, pgid)
	}
	return nil
}

func processGroupAlive(pgid int) bool {
	err := syscall.Kill(-pgid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}

// exitStatus returns a command's exit code, or 128 plus the signal that killed it.
func exitStatus(state *os.ProcessState) int {
	if status, ok := state.Sys().(syscall.WaitStatus); ok && status.Signaled() {
		return 128 + int(status.Signal())
	}
	return state.ExitCode()
}

func exitDescription(state *os.ProcessState) string {
	if status, ok := state.Sys().(syscall.WaitStatus); ok && status.Signaled() {
		return fmt.Sprintf("signal %d, %s", int(status.Signal()), status.Signal())
	}
	return fmt.Sprint(state.ExitCode())
}

func errnoName(err error) (string, bool) {
	var errno syscall.Errno
	if !errors.As(err, &errno) {
		return "", false
	}
	name, ok := map[syscall.Errno]string{
		syscall.ECONNREFUSED: "ECONNREFUSED",
		syscall.ECONNRESET:   "ECONNRESET",
		syscall.ECONNABORTED: "ECONNABORTED",
		syscall.EHOSTUNREACH: "EHOSTUNREACH",
		syscall.ENETUNREACH:  "ENETUNREACH",
		syscall.EPIPE:        "EPIPE",
	}[errno]
	if !ok {
		return errno.Error(), true
	}
	return name, true
}
