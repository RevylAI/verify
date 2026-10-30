package verify

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"strings"
)

type Code string

type RefusalReason string

const (
	ReasonWebRuntimeUnavailable      RefusalReason = "web_runtime_unavailable"
	ReasonWebRuntimeNotConfigured    RefusalReason = "web_runtime_not_configured"
	ReasonComputerLimit              RefusalReason = "computer_limit"
	ReasonRuntimeUnavailable         RefusalReason = "runtime_unavailable"
	ReasonComputerRuntimeUnavailable RefusalReason = "computer_runtime_unavailable"
	ReasonComputerAtCapacity         RefusalReason = "computer_at_capacity"
	ReasonComputerNotRunning         RefusalReason = "computer_not_running"
	ReasonComputerCannotHostPlatform RefusalReason = "computer_cannot_host_platform"
	ReasonComputerNotFound           RefusalReason = "computer_not_found"
	ReasonWebBuildRequired           RefusalReason = "web_build_required"
	ReasonWebBuildNotSupported       RefusalReason = "web_build_not_supported"
	ReasonIOSBuildRequired           RefusalReason = "ios_build_required"
	ReasonIOSBuildNotSupported       RefusalReason = "ios_build_not_supported"
	ReasonAndroidBuildRequired       RefusalReason = "android_build_required"
	ReasonAndroidBuildNotSupported   RefusalReason = "android_build_not_supported"
	ReasonWebSessionConflict         RefusalReason = "web_session_conflict"
	ReasonIOSSessionConflict         RefusalReason = "ios_session_conflict"
	ReasonAndroidSessionConflict     RefusalReason = "android_session_conflict"
	ReasonNotAvailableOnPlatform     RefusalReason = "not_available_on_platform"
	ReasonRequestTimeout             RefusalReason = "request_timeout"
	ReasonProtocolError              RefusalReason = "protocol_error"
)

func (c Code) Error() string { return string(c) }

const (
	ErrInvalidArgument        Code = "INVALID_ARGUMENT"
	ErrConfigNotFound         Code = "CONFIG_NOT_FOUND"
	ErrConfigInvalid          Code = "CONFIG_INVALID"
	ErrAuthMissing            Code = "AUTH_MISSING"
	ErrComputerIDMissing      Code = "COMPUTER_ID_MISSING"
	ErrAuthRejected           Code = "AUTH_REJECTED"
	ErrEdgeBlocked            Code = "EDGE_BLOCKED"
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
	Reason     RefusalReason
	HTTPStatus int
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

func refusalReason(r response) RefusalReason {
	var raw struct {
		Detail json.RawMessage `json:"detail"`
		Error  json.RawMessage `json:"error"`
	}
	if json.Unmarshal(r.body, &raw) != nil {
		return ""
	}
	var detail string
	if json.Unmarshal(raw.Detail, &detail) != nil {
		var nested struct {
			Error string `json:"error"`
		}
		if json.Unmarshal(raw.Detail, &nested) == nil {
			detail = nested.Error
		}
	}
	var topLevel string
	_ = json.Unmarshal(raw.Error, &topLevel)
	for _, reason := range []RefusalReason{RefusalReason(detail), RefusalReason(topLevel)} {
		switch reason {
		case ReasonWebRuntimeUnavailable, ReasonWebRuntimeNotConfigured, ReasonComputerLimit, ReasonRuntimeUnavailable, ReasonComputerRuntimeUnavailable,
			ReasonComputerAtCapacity, ReasonComputerNotRunning, ReasonComputerCannotHostPlatform, ReasonComputerNotFound,
			ReasonWebBuildRequired, ReasonWebBuildNotSupported, ReasonIOSBuildRequired, ReasonIOSBuildNotSupported,
			ReasonAndroidBuildRequired, ReasonAndroidBuildNotSupported, ReasonWebSessionConflict, ReasonIOSSessionConflict,
			ReasonAndroidSessionConflict, ReasonNotAvailableOnPlatform, ReasonRequestTimeout, ReasonProtocolError:
			return reason
		}
	}
	return ""
}

func isJSONBody(body []byte) bool {
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	depth := 0
	seen := false
	for {
		token, err := decoder.Token()
		if err != nil {
			return err == io.EOF && seen && depth == 0
		}
		if depth == 0 && seen {
			return false
		}
		seen = true
		if delimiter, ok := token.(json.Delim); ok {
			switch delimiter {
			case '{', '[':
				depth++
			case '}', ']':
				depth--
			}
		}
	}
}

func responseFailure(r response, code Code, message string) error {
	if r.status == 403 && strings.EqualFold(strings.TrimSpace(strings.SplitN(r.contentType, ";", 2)[0]), "text/html") && strings.TrimSpace(r.cfRay) != "" && !isJSONBody(r.body) {
		return &Error{Code: ErrEdgeBlocked, HTTPStatus: r.status, Message: "Revyl request was blocked at the network edge (HTTP 403). Check network access or contact support. Verify will not retry this request."}
	}
	return &Error{Code: code, Reason: refusalReason(r), HTTPStatus: r.status, Message: message}
}
