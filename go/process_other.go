//go:build !unix

package verify

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"time"
)

const processGroupsSupported = false

func setProcessGroup(*exec.Cmd) {}

func stopProcessGroup(int, time.Duration, string) error {
	return errors.New("process groups are not supported on this operating system")
}

func exitStatus(state *os.ProcessState) int { return state.ExitCode() }

func exitDescription(state *os.ProcessState) string { return fmt.Sprint(state.ExitCode()) }

func errnoName(error) (string, bool) { return "", false }
