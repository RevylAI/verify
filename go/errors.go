package verify

import "fmt"

type Code string

func (c Code) Error() string { return string(c) }

const (
	ErrInvalidArgument        Code = "INVALID_ARGUMENT"
	ErrConfigNotFound         Code = "CONFIG_NOT_FOUND"
	ErrConfigInvalid          Code = "CONFIG_INVALID"
	ErrAuthMissing            Code = "AUTH_MISSING"
	ErrAuthRejected           Code = "AUTH_REJECTED"
	ErrAPI                    Code = "API_ERROR"
	ErrSessionStartFailed     Code = "SESSION_START_FAILED"
	ErrSessionEnded           Code = "SESSION_ENDED"
	ErrSessionBusy            Code = "SESSION_BUSY"
	ErrComputerLimit          Code = "COMPUTER_LIMIT"
	ErrNotAvailableOnPlatform Code = "NOT_AVAILABLE_ON_PLATFORM"
	ErrActionFailed           Code = "ACTION_FAILED"
	ErrActionUncertain        Code = "ACTION_UNCERTAIN"
	ErrInstructionFailed      Code = "INSTRUCTION_FAILED"
	ErrValidationFailed       Code = "VALIDATION_FAILED"
	ErrStepFailed             Code = "STEP_FAILED"
	ErrCommandFailed          Code = "COMMAND_FAILED"
	ErrNotFound               Code = "NOT_FOUND"
	ErrAccessDenied           Code = "ACCESS_DENIED"
	ErrTimeout                Code = "TIMEOUT"
)

type Error struct {
	Code       Code
	Message    string
	Cause      error
	ExecResult *ExecResult
}

func (e *Error) Error() string { return fmt.Sprintf("%s: %s", e.Code, e.Message) }
func (e *Error) Unwrap() error { return e.Cause }
func (e *Error) Is(target error) bool {
	switch t := target.(type) {
	case Code:
		return e.Code == t
	case *Error:
		return t != nil && e.Code == t.Code
	default:
		return false
	}
}

func failure(code Code, message string) error { return &Error{Code: code, Message: message} }
