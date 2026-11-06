package verify

import (
	"context"
	"math"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// ProofHarness is the agent that runs a Proof of Changes run.
type ProofHarness string

const (
	HarnessRevyl  ProofHarness = "revyl"
	HarnessCursor ProofHarness = "cursor"
	HarnessCapy   ProofHarness = "capy"
	HarnessDevin  ProofHarness = "devin"
)

// EnvValue is one launch variable for a Proof of Changes run: a plain value from EnvPlain, or a reference to an
// organization launch variable from EnvSecretRef. Formatting it never prints a plain value.
type EnvValue struct {
	value     string
	secretRef string
	secret    bool
}

// EnvPlain is a plain launch value. Revyl stores it with the run and it may appear in reports, so it must not be a secret.
func EnvPlain(value string) EnvValue { return EnvValue{value: value} }

// EnvSecretRef names an organization launch variable that holds a secret.
func EnvSecretRef(name string) EnvValue { return EnvValue{secretRef: name, secret: true} }

func (v EnvValue) String() string {
	if v.secret {
		return "EnvSecretRef(" + v.secretRef + ")"
	}
	return "EnvPlain(<redacted>)"
}

func (v EnvValue) GoString() string { return v.String() }

// ProofOptions describes a pull request build to prove.
type ProofOptions struct {
	// Build is a debug .apk, a simulator .app bundle, or a .zip holding one.
	Build string
	// AppID is the Revyl app (UUID) the build belongs to.
	AppID string
	// Guidance is what the agent should focus on.
	Guidance string
	// Harness defaults to HarnessRevyl.
	Harness ProofHarness
	// Environment holds launch variables for this run, by name.
	Environment map[string]EnvValue
	// NoWait returns as soon as the run starts instead of waiting for its verdict.
	NoWait bool
	// Timeout bounds the wait for a verdict and defaults to 30 minutes. The run keeps going on Revyl after it.
	Timeout time.Duration
	// Version is a label unique within the app; empty uses the short head commit plus a UTC timestamp.
	Version string
	// Token defaults to REVYL_API_KEY or the Revyl CLI login.
	Token      string
	BackendURL string
	HTTPClient *http.Client
}

// PullRequestContext is the pull request a Proof of Changes run covers.
type PullRequestContext struct {
	Provider   string `json:"provider"`
	Repository string `json:"repository"`
	Number     int    `json:"number"`
	HeadSHA    string `json:"headSha"`
	BaseSHA    string `json:"baseSha,omitempty"`
}

// ProofRun is a Proof of Changes run.
type ProofRun struct {
	ID string `json:"id"`
	// Status is Revyl's run status, as reported.
	Status string `json:"status"`
	// Verdict is passed, failed, or inconclusive once the run settles with a verdict.
	Verdict string `json:"verdict,omitempty"`
	// Label is Revyl's display label, such as "Ready", "Ready with issues", or "Partial coverage".
	Label string `json:"label,omitempty"`
	// ReportURL is the pull request comment with the report.
	ReportURL string `json:"reportUrl,omitempty"`
	ReviewURL string `json:"reviewUrl,omitempty"`
	CreatedAt string `json:"createdAt,omitempty"`
	// SettledAt is set once the run is over.
	SettledAt   string             `json:"settledAt,omitempty"`
	PullRequest PullRequestContext `json:"pullRequest"`
	Build       *UploadResult      `json:"build"`
}

var environmentNamePattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

const defaultProofTimeout = 30 * time.Minute

var proofPollIntervals = []time.Duration{5 * time.Second, 10 * time.Second, 15 * time.Second}

// Proof uploads a pull request's CI build and starts a Revyl Proof of Changes run on it. Unless NoWait is set it
// polls until the run has a verdict, and cancels the run if ctx is cancelled while waiting.
// It needs a pull request on GitHub Actions.
func Proof(ctx context.Context, options ProofOptions) (*ProofRun, error) {
	harness := options.Harness
	if harness == "" {
		harness = HarnessRevyl
	}
	switch harness {
	case HarnessRevyl, HarnessCursor, HarnessCapy, HarnessDevin:
	default:
		return nil, failure(ErrInvalidArgument, "Harness must be one of revyl, cursor, capy, devin.")
	}
	for name, value := range options.Environment {
		if !environmentNamePattern.MatchString(name) {
			return nil, failure(ErrInvalidArgument, "Environment has an invalid variable name: use letters, digits, and underscores, not starting with a digit.")
		}
		if value.secret && strings.TrimSpace(value.secretRef) == "" {
			return nil, failure(ErrInvalidArgument, "Environment variable "+name+" has an empty EnvSecretRef; name the launch variable that holds the secret.")
		}
	}
	timeout := options.Timeout
	if timeout < 0 {
		return nil, failure(ErrInvalidArgument, "Timeout must be positive.")
	}
	if timeout == 0 {
		timeout = defaultProofTimeout
	}
	pullRequest, err := detectPullRequest()
	if err != nil {
		return nil, err
	}
	c, _, err := newTokenClient(OpenOptions{BackendURL: options.BackendURL, HTTPClient: options.HTTPClient}, options.Token)
	if err != nil {
		return nil, err
	}
	build, err := UploadBuild(ctx, UploadOptions{File: options.Build, AppID: options.AppID, Version: options.Version, Token: c.token, BackendURL: options.BackendURL, HTTPClient: options.HTTPClient})
	if err != nil {
		return nil, err
	}
	state, err := createProofRun(ctx, c, createProofRunRequest{
		appID:       options.AppID,
		buildID:     build.BuildID,
		pullRequest: pullRequest,
		harness:     harness,
		guidance:    strings.TrimSpace(options.Guidance),
		environment: options.Environment,
	})
	if err != nil {
		return nil, err
	}
	if !options.NoWait {
		if state, err = waitForVerdict(ctx, c, state, timeout); err != nil {
			return nil, err
		}
	}
	return &ProofRun{
		ID:          state.id,
		Status:      state.status,
		Verdict:     state.verdict,
		Label:       state.label,
		ReportURL:   state.reportURL,
		ReviewURL:   state.reviewURL,
		CreatedAt:   state.createdAt,
		SettledAt:   state.settledAt,
		PullRequest: pullRequest,
		Build:       build,
	}, nil
}

func waitForVerdict(ctx context.Context, c *client, started proofRunState, timeout time.Duration) (proofRunState, error) {
	deadline := time.Now().Add(timeout)
	state := started
	for poll := 0; ; poll++ {
		if state.settledAt != "" {
			if state.verdict != "" {
				return state, nil
			}
			return state, failure(ErrProofRunEnded, "Proof of Changes run "+state.id+" ended without a verdict ("+firstNonEmpty(state.label, state.status)+")."+proofRunLink(state))
		}
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return state, failure(ErrTimeout, "Proof of Changes run "+state.id+" had no verdict after "+strconv.Itoa(int(math.Round(timeout.Seconds())))+" s. It keeps running on Revyl."+proofRunLink(state))
		}
		var err error
		if err = pause(ctx, min(proofPollIntervals[min(poll, len(proofPollIntervals)-1)], remaining)); err == nil {
			state, err = getProofRun(ctx, c, state.id)
		}
		if ctx.Err() != nil {
			return state, cancelInterruptedProofRun(ctx, c, started.id)
		}
		if err != nil {
			return state, err
		}
	}
}

func cancelInterruptedProofRun(ctx context.Context, c *client, id string) error {
	cancelCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), proofRunCancelTimeout)
	defer cancel()
	if err := cancelProofRun(cancelCtx, c, id); err != nil {
		return &Error{Code: ErrAPI, Message: "Proof of Changes run " + id + " was interrupted, but cancelling it failed: " + err.Error(), Cause: err}
	}
	return ctx.Err()
}

func detectPullRequest() (PullRequestContext, error) {
	identity, err := detectScmIdentity(UploadOptions{}, os.Getenv)
	if err != nil {
		return PullRequestContext{}, err
	}
	if identity == nil || identity.CISystem != "github-actions" || identity.PR <= 0 {
		return PullRequestContext{}, failure(ErrPRContextMissing, "Proof needs a pull_request event on GitHub Actions to know the repository, pull request, and head commit.")
	}
	return PullRequestContext{Provider: "github", Repository: identity.Repository, Number: identity.PR, HeadSHA: identity.Commit, BaseSHA: identity.BaseCommit}, nil
}

func proofRunLink(state proofRunState) string {
	if link := firstNonEmpty(state.reportURL, state.reviewURL); link != "" {
		return " See " + link
	}
	return ""
}
