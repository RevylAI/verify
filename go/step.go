package verify

import (
	"context"
	"encoding/json"
	"net/url"
	"strings"
	"time"
)

type liveStep struct {
	Success *bool `json:"success"`
	Output  struct {
		Status     string `json:"status"`
		Reason     string `json:"status_reason"`
		Reasoning  string `json:"reasoning"`
		Validation *bool  `json:"validation_result"`
	} `json:"step_output"`
}

func (s *Session) Instruction(ctx context.Context, text string, options ...StepOptions) (StepResult, error) {
	if s.platform.computer() {
		return StepResult{}, s.computerAgentUnavailable("instruction")
	}
	if len(options) > 1 {
		return StepResult{}, failure(ErrInvalidArgument, "Instruction accepts at most one options value.")
	}
	var timeout time.Duration
	if len(options) == 1 {
		timeout = options[0].Timeout
	}
	result, err := s.step(ctx, "instruction", text, timeout)
	if err == nil && !result.Passed {
		err = failure(ErrInstructionFailed, "Instruction failed. See "+s.viewer)
	}
	return result, err
}

func (s *Session) Validation(ctx context.Context, text string, options ...ValidationOptions) (StepResult, error) {
	if s.platform.computer() {
		return StepResult{}, s.computerAgentUnavailable("validation")
	}
	if len(options) > 1 {
		return StepResult{}, failure(ErrInvalidArgument, "Validation accepts at most one options value.")
	}
	var opt ValidationOptions
	if len(options) == 1 {
		opt = options[0]
	}
	result, err := s.step(ctx, "validation", text, opt.Timeout)
	if err == nil && !result.Passed && !opt.Soft {
		err = failure(ErrValidationFailed, "Validation failed. See "+s.viewer)
	}
	return result, err
}

func (s *Session) step(ctx context.Context, kind, text string, timeout time.Duration) (StepResult, error) {
	if strings.TrimSpace(text) == "" || textLength(text) > 4000 {
		return StepResult{}, failure(ErrInvalidArgument, "Step description must contain 1–4000 characters.")
	}
	if timeout == 0 {
		timeout = s.stepTimeout
	}
	if timeout < time.Second {
		return StepResult{}, failure(ErrInvalidArgument, "Step timeout must be at least one second.")
	}
	s.mu.Lock()
	if s.stepRunning {
		s.mu.Unlock()
		return StepResult{}, failure(ErrInvalidArgument, "Run one instruction or validation at a time on a session.")
	}
	s.stepRunning = true
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		s.stepRunning = false
		s.mu.Unlock()
	}()
	started := time.Now()
	text = strings.TrimSpace(text)
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	outcome, err := s.runStep(ctx, kind, text, timeout)
	if err != nil {
		return StepResult{}, err
	}
	reason := outcome.Output.Reason
	if reason == "" {
		reason = outcome.Output.Reasoning
	}
	success := outcome.Success != nil && *outcome.Success
	if kind == "validation" && (!success || outcome.Output.Validation == nil) {
		return StepResult{}, failure(ErrStepFailed, "Validation did not reach a verdict. See "+s.viewer)
	}
	passed := success && outcome.Output.Status != "failed"
	if kind == "validation" {
		passed = *outcome.Output.Validation
	}
	return StepResult{Type: kind, Text: text, Passed: passed, Reason: reason, Duration: time.Since(started)}, nil
}

func (s *Session) runStep(ctx context.Context, kind, text string, timeout time.Duration) (out liveStep, err error) {
	var stepID string
	defer func() {
		if err != nil && ctx.Err() != nil {
			if stepID != "" {
				cancelCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
				defer cancel()
				_, _ = s.client.send(cancelCtx, "POST", s.workerPath("step_cancel/"+url.PathEscape(stepID)), map[string]any{}, false, 5*time.Second, true)
			}
			err = contextError(ctx)
		}
	}()
	body := map[string]string{"step_type": kind, "step_description": text, "workflow_run_id": s.runID}
	if s.id != "" {
		body["session_id"] = s.id
	}
	r, err := s.worker(ctx, "POST", "execute_step", body, false, timeout)
	if err != nil {
		return out, err
	}
	if err := decode(r, &out); err != nil {
		return out, err
	}
	if out.Success != nil {
		return out, nil
	}
	var accepted struct {
		Status string `json:"status"`
		ID     string `json:"step_id"`
	}
	if err := decode(r, &accepted); err != nil {
		return out, err
	}
	if accepted.Status != "accepted" || accepted.ID == "" {
		return out, failure(ErrAPI, "Revyl returned neither a step result nor an accepted step ID.")
	}
	stepID = accepted.ID
	for wait := 500 * time.Millisecond; ; wait = min(wait*2, 5*time.Second) {
		if err := pause(ctx, wait); err != nil {
			return out, err
		}
		r, err := s.worker(ctx, "GET", "step_status/"+url.PathEscape(stepID), nil, true, 30*time.Second)
		if err != nil {
			return out, err
		}
		var status struct {
			Status string          `json:"status"`
			Result json.RawMessage `json:"result"`
		}
		if err := decode(r, &status); err != nil {
			return out, err
		}
		if status.Status == "running" {
			continue
		}
		if status.Status == "cancelled" {
			return out, failure(ErrStepFailed, "Step was cancelled before finishing. See "+s.viewer)
		}
		if status.Status != "completed" && status.Status != "failed" {
			return out, failure(ErrAPI, "Revyl returned an unknown step status.")
		}
		if len(status.Result) == 0 || string(status.Result) == "null" || json.Unmarshal(status.Result, &out) != nil || out.Success == nil {
			return out, failure(ErrAPI, "Terminal step status has no readable result.")
		}
		return out, nil
	}
}
