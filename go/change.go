package verify

import (
	"context"
	"io"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

// ChangeFromGitOptions overrides what ChangeFromGit detects; an empty field is detected or defaulted.
type ChangeFromGitOptions struct {
	// Dir is the checkout to diff. It defaults to the current directory.
	Dir string
	// ReviewKey is detected on GitLab merge request pipelines and Bitrise pull request builds; required elsewhere.
	ReviewKey string
	// HeadSHA defaults to the CI's head commit, or the checkout's HEAD.
	HeadSHA string
	// BaseSHA is detected on GitLab merge request pipelines and Bitrise pull request builds; required elsewhere.
	BaseSHA string
	// Title defaults to the merge request title from CI, or the head commit's subject.
	Title       string
	Description string
	SourceURL   string
}

const gitTimeout = 60 * time.Second

var (
	repositoryURLHost = regexp.MustCompile(`(?i)^[a-z+]+://[^/]+/`)
	repositorySSHHost = regexp.MustCompile(`^[^@/]+@[^:]+:`)
	repositoryPath    = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._~/-]*$`)
)

// ChangeFromGit builds a Change for Proof from a local checkout: the diff from the base commit to the head, plus the
// review key, title, and link that GitLab merge request pipelines and Bitrise pull request builds expose. Explicit
// options win over what CI exposes. The base commit must be in the checkout, so fetch enough history in a shallow
// clone.
func ChangeFromGit(ctx context.Context, options ChangeFromGitOptions) (*ProofChange, error) {
	ci := ciChange(os.Getenv)
	dir := options.Dir
	if dir == "" {
		var err error
		if dir, err = os.Getwd(); err != nil {
			return nil, failure(ErrInvalidArgument, "ChangeFromGit couldn't read the current directory; set Dir.")
		}
	}
	head := firstNonEmpty(options.HeadSHA, ci.HeadSHA)
	if head == "" {
		var err error
		if head, err = runGit(ctx, dir, "rev-parse", "HEAD"); err != nil {
			return nil, err
		}
	}
	head = strings.ToLower(strings.TrimSpace(head))
	change := &ProofChange{
		ReviewKey:   firstNonEmpty(options.ReviewKey, ci.ReviewKey),
		HeadSHA:     head,
		BaseSHA:     firstNonEmpty(options.BaseSHA, ci.BaseSHA),
		Title:       firstNonEmpty(options.Title, ci.Title),
		Description: firstNonEmpty(options.Description, ci.Description),
		SourceURL:   firstNonEmpty(options.SourceURL, ci.SourceURL),
	}
	if change.ReviewKey == "" {
		return nil, failure(ErrInvalidArgument, "Set a review key (ReviewKey), such as gitlab:group/app!17. It is detected only on GitLab merge request pipelines and Bitrise pull request builds.")
	}
	if change.BaseSHA == "" && ci.baseBranch != "" {
		base, err := runGit(ctx, dir, "merge-base", head, "origin/"+ci.baseBranch)
		if err != nil {
			return nil, failure(ErrInvalidArgument, "Couldn't find the base of the change against origin/"+ci.baseBranch+". Fetch that branch and enough history, or set the base commit (BaseSHA).")
		}
		change.BaseSHA = base
	}
	if change.BaseSHA == "" {
		return nil, failure(ErrInvalidArgument, "Set the base commit (BaseSHA) the change is diffed from. It is detected only on GitLab merge request pipelines and Bitrise pull request builds.")
	}
	base := strings.TrimSpace(change.BaseSHA)
	change.BaseSHA = strings.ToLower(base)
	if change.Title == "" {
		subject, err := runGit(ctx, dir, "log", "-1", "--format=%s", head)
		if err != nil {
			return nil, err
		}
		change.Title = subject
	}
	diff, err := gitDiff(ctx, dir, base, head)
	if err != nil {
		return nil, err
	}
	change.Diff = diff
	return change, nil
}

type detectedChange struct {
	ProofChange
	baseBranch string
}

func ciChange(getenv func(string) string) detectedChange {
	value := func(name string) string { return strings.TrimSpace(getenv(name)) }
	if iid := value("CI_MERGE_REQUEST_IID"); getenv("GITLAB_CI") == "true" && iid != "" {
		found := detectedChange{ProofChange: ProofChange{
			HeadSHA:     firstNonEmpty(value("CI_MERGE_REQUEST_SOURCE_BRANCH_SHA"), value("CI_COMMIT_SHA")),
			BaseSHA:     value("CI_MERGE_REQUEST_DIFF_BASE_SHA"),
			Title:       value("CI_MERGE_REQUEST_TITLE"),
			Description: value("CI_MERGE_REQUEST_DESCRIPTION"),
		}}
		if project := firstNonEmpty(value("CI_MERGE_REQUEST_PROJECT_PATH"), value("CI_PROJECT_PATH")); project != "" {
			found.ReviewKey = "gitlab:" + project + "!" + iid
		}
		if projectURL := firstNonEmpty(value("CI_MERGE_REQUEST_PROJECT_URL"), value("CI_PROJECT_URL")); strings.HasPrefix(projectURL, "https://") {
			found.SourceURL = strings.TrimRight(projectURL, "/") + "/-/merge_requests/" + iid
		}
		return found
	}
	if pullRequest := value("BITRISE_PULL_REQUEST"); pullRequest != "" {
		title, _, _ := strings.Cut(value("BITRISE_GIT_MESSAGE"), "\n")
		found := detectedChange{ProofChange: ProofChange{HeadSHA: value("BITRISE_GIT_COMMIT"), Title: strings.TrimSpace(title)}, baseBranch: value("BITRISEIO_GIT_BRANCH_DEST")}
		if repository := repositoryPathOf(value("GIT_REPOSITORY_URL")); repository != "" {
			found.ReviewKey = "bitrise:" + repository + "#" + pullRequest
		}
		return found
	}
	return detectedChange{}
}

func repositoryPathOf(url string) string {
	path := repositoryURLHost.ReplaceAllString(url, "")
	path = repositorySSHHost.ReplaceAllString(path, "")
	path = strings.Trim(strings.TrimSuffix(path, ".git"), "/")
	if !repositoryPath.MatchString(path) {
		return ""
	}
	return path
}

func gitDiff(ctx context.Context, dir, base, head string) (string, error) {
	failed := failure(ErrInvalidArgument, "git couldn't diff the base commit against the head. Both commits must be in the checkout: in a shallow clone, fetch more history (on GitLab, set GIT_DEPTH: 0).")
	ctx, cancel := context.WithTimeout(ctx, gitTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", "diff", "--no-color", "--no-ext-diff", "--no-textconv", base+"..."+head)
	cmd.Dir = dir
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return "", failed
	}
	if cmd.Start() != nil {
		return "", failed
	}
	output, readErr := io.ReadAll(io.LimitReader(stdout, maxDiffBytes+1))
	if len(output) > maxDiffBytes {
		cancel()
		_ = cmd.Wait()
		return "", failure(ErrInvalidArgument, "The diff is over 5 MiB, the most a proof takes.")
	}
	if err := cmd.Wait(); err != nil || readErr != nil {
		return "", failed
	}
	if !utf8.Valid(output) {
		return "", failure(ErrInvalidArgument, "The diff isn't valid UTF-8.")
	}
	return string(output), nil
}

func runGit(ctx context.Context, dir string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, gitTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = dir
	output, err := cmd.Output()
	if err != nil {
		return "", failure(ErrInvalidArgument, "git "+args[0]+" failed in "+dir+"; ChangeFromGit needs a git checkout of the change.")
	}
	return strings.TrimSpace(string(output)), nil
}
