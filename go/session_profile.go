package verify

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"maps"
	"net/url"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf16"
	"unicode/utf8"

	"gopkg.in/yaml.v3"
)

const (
	profileNone           = "none"
	profileNoneHint       = `Profile: "none"`
	profileScriptMaxBytes = 64 * 1024
	profileGitTimeout     = 5 * time.Second
)

var (
	profileNamePattern    = regexp.MustCompile(`^[a-z0-9-]{1,64}$`)
	profileBareCode       = regexp.MustCompile(`^[a-z0-9_]+$`)
	profileYAMLLine       = regexp.MustCompile(`line (\d+)`)
	profileScriptSuffixes = []string{".js", ".py", ".sh", ".ts"}
	profileRetryDelays    = []time.Duration{time.Second, 2 * time.Second}
)

type profileInstruction struct {
	Instruction string `json:"instruction"`
	Name        string `json:"name,omitempty"`
}

type profileSource struct {
	ProjectID     string `json:"project_id"`
	GitBranchName string `json:"git_branch_name,omitempty"`
}

type profileScriptFile struct {
	ProjectRelativePath string `json:"project_relative_path"`
	Content             string `json:"content"`
}

type profileFiles struct {
	Script                     string             `json:"script"`
	RequiresRepositoryCheckout bool               `json:"requires_repository_checkout,omitempty"`
	ScriptFile                 *profileScriptFile `json:"script_file,omitempty"`
}

// sessionProfilePlan is what Open sends for a session profile, and the name it waits on. implicit marks the project's default,
// which the caller didn't ask for.
type sessionProfilePlan struct {
	name       string
	implicit   bool
	configPath string
	source     *profileSource
	files      *profileFiles
}

func (p *sessionProfilePlan) addTo(request map[string]any) {
	if p == nil {
		return
	}
	request["session_profile"] = profileInstruction{Instruction: "named", Name: p.name}
	request["session_profile_source"] = p.source
	request["session_profile_files"] = p.files
}

// reportedProfile is the session_profile object a start response or session report carries.
type reportedProfile struct {
	name                 string
	status               string
	outcome              string
	failureReason        string
	missingGitBranchName string
}

// planSessionProfile plans the session profile Open sends: an explicit name, or the project's session.default_profile when
// profile is empty. Nil when nothing is sent, which is always the case for profile "none". Reads .revyl/config.yaml at or above cwd.
func planSessionProfile(profile string, platform Platform, cwd string) (*sessionProfilePlan, error) {
	if profile != "" && profile != profileNone && !profileNamePattern.MatchString(profile) {
		return nil, failure(ErrInvalidArgument, "open(): profile must be a session profile name from session.profiles in .revyl/config.yaml (1-64 lowercase letters, digits or hyphens), or 'none'.")
	}
	if profile == profileNone {
		return nil, nil
	}
	if platform != Web && platform != IOS && platform != Android && platform != Mac {
		if profile == "" {
			return nil, nil
		}
		return nil, failure(ErrNotAvailableOnPlatform, fmt.Sprintf("open(): session profiles run on web, iOS, Android and Mac sessions, not %s. Leave out profile.", platform))
	}
	if absolute, err := filepath.Abs(cwd); err == nil {
		cwd = absolute
	}
	configPath := findProfileConfig(cwd)
	if configPath == "" {
		if profile == "" {
			return nil, nil
		}
		return nil, failure(ErrConfigNotFound, fmt.Sprintf("open(): profile '%s' needs .revyl/config.yaml, but none was found in %s or any folder above it. Run open() from your app's checkout, or pass %s.", profile, cwd, profileNoneHint))
	}
	project, session, err := readProfileConfig(configPath)
	if err != nil {
		return nil, err
	}
	invalid := func(message string) error { return failure(ErrConfigInvalid, configPath+": "+message) }
	name := profile
	if name == "" {
		fallback, ok := session["default_profile"]
		if !ok || fallback == nil || fallback == profileNone {
			return nil, nil
		}
		text, isText := fallback.(string)
		if !isText {
			return nil, invalid("session.default_profile must be a profile name, or none.")
		}
		name = text
	}
	projectID, _ := project["id"].(string)
	if !uuidPattern.MatchString(projectID) {
		return nil, invalid(fmt.Sprintf("project.id must be your Revyl project's UUID, which session profile %q needs. Run open() from your app's checkout, whose .revyl/config.yaml has project.id, or pass %s.", name, profileNoneHint))
	}
	var profiles map[string]any
	if raw := session["profiles"]; raw != nil {
		var isMapping bool
		if profiles, isMapping = yamlMapping(raw); !isMapping {
			return nil, invalid("session.profiles must be a mapping of profile names.")
		}
	}
	entry, defined := profiles[name]
	if !defined {
		names := slices.Sorted(maps.Keys(profiles))
		list := "none"
		if len(names) > 0 {
			list = strings.Join(names, ", ")
		}
		return nil, invalid(fmt.Sprintf("session.profiles doesn't define %q. Defined: %s. Pass one of those, or %s.", name, list, profileNoneHint))
	}
	definition, isMapping := yamlMapping(entry)
	script, isText := definition["script"].(string)
	if !isMapping || !isText || jsTrim(script) == "" {
		return nil, invalid(fmt.Sprintf("session.profiles.%s.script must be a non-empty string.", name))
	}
	requiresCheckout := definition["requires_repository_checkout"]
	if _, isBool := requiresCheckout.(bool); requiresCheckout != nil && !isBool {
		return nil, invalid(fmt.Sprintf("session.profiles.%s.requires_repository_checkout must be true or false.", name))
	}
	projectRoot := filepath.Dir(filepath.Dir(configPath))
	files, err := checkoutFiles(name, script, requiresCheckout == true, projectRoot, configPath)
	if err != nil {
		return nil, err
	}
	return &sessionProfilePlan{name: name, implicit: profile == "", configPath: configPath, source: &profileSource{ProjectID: projectID, GitBranchName: gitBranch(projectRoot)}, files: files}, nil
}

func findProfileConfig(cwd string) string {
	for current := cwd; ; current = filepath.Dir(current) {
		candidate := filepath.Join(current, ".revyl", "config.yaml")
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}
		if filepath.Dir(current) == current {
			return ""
		}
	}
}

func yamlMapping(value any) (map[string]any, bool) {
	switch mapping := value.(type) {
	case map[string]any:
		return mapping, true
	case map[any]any:
		converted := make(map[string]any, len(mapping))
		for key, item := range mapping {
			converted[fmt.Sprint(key)] = item
		}
		return converted, true
	default:
		return nil, false
	}
}

func readProfileConfig(configPath string) (project, session map[string]any, err error) {
	var parsed any
	data, err := os.ReadFile(configPath)
	if err == nil {
		err = yaml.Unmarshal(data, &parsed)
	}
	if err != nil {
		line := ""
		if match := profileYAMLLine.FindStringSubmatch(err.Error()); match != nil {
			line = " line " + match[1]
		}
		return nil, nil, failure(ErrConfigInvalid, configPath+line+": is not valid YAML.")
	}
	root, isMapping := yamlMapping(parsed)
	if !isMapping {
		return nil, nil, failure(ErrConfigInvalid, configPath+": must be a YAML mapping.")
	}
	if raw := root["project"]; raw != nil {
		if project, isMapping = yamlMapping(raw); !isMapping {
			return nil, nil, failure(ErrConfigInvalid, configPath+": project must be a mapping.")
		}
	}
	if raw := root["session"]; raw != nil {
		if session, isMapping = yamlMapping(raw); !isMapping {
			return nil, nil, failure(ErrConfigInvalid, configPath+": session must be a mapping.")
		}
	}
	return project, session, nil
}

// checkoutFiles is the profile's definition and script file as the checkout has them, uncommitted changes included, as the Revyl
// CLI's CheckoutFiles builds them.
func checkoutFiles(name, script string, requiresCheckout bool, projectRoot, configPath string) (*profileFiles, error) {
	files := &profileFiles{Script: script, RequiresRepositoryCheckout: requiresCheckout}
	unavailable := func(reason string) error {
		return &Error{Code: ErrSessionProfileFailed, Message: fmt.Sprintf("session profile %q: %s. Fix session.profiles.%s.script in %s, or pass %s.", name, reason, name, configPath, profileNoneHint), Outcome: "script_unavailable", FailureReason: reason}
	}
	var filePath, relativePath string
	if strings.Contains(script, "/") {
		var err error
		if filePath, err = resolveRepositoryPath(projectRoot, script, unavailable); err != nil {
			return nil, err
		}
		relativePath = path.Clean(script)
	} else {
		if jsTrim(script) != script || strings.Contains(script, "\\") {
			return files, nil
		}
		found, err := findRepositoryScript(filepath.Join(filepath.Dir(configPath), "scripts"), script, unavailable)
		if err != nil || found == "" {
			return files, err
		}
		filePath, relativePath = found, ".revyl/scripts/"+filepath.Base(found)
	}
	content, err := os.ReadFile(filePath)
	if err != nil {
		return nil, unavailable("could not read script " + relativePath)
	}
	if len(content) > profileScriptMaxBytes {
		return nil, unavailable(fmt.Sprintf("script %s is %d bytes, over the %d Revyl takes", relativePath, len(content), profileScriptMaxBytes))
	}
	if !utf8.Valid(content) {
		return nil, unavailable("script " + relativePath + " isn't UTF-8 text")
	}
	files.ScriptFile = &profileScriptFile{ProjectRelativePath: relativePath, Content: string(content)}
	return files, nil
}

func resolveRepositoryPath(projectRoot, ref string, unavailable func(string) error) (string, error) {
	realRoot, err := filepath.EvalSymlinks(projectRoot)
	if err == nil {
		realRoot, err = filepath.Abs(realRoot)
	}
	if err != nil {
		return "", unavailable("could not resolve the project root for script " + ref)
	}
	repositoryRoot := realRoot
	for current := realRoot; ; current = filepath.Dir(current) {
		if _, err := os.Stat(filepath.Join(current, ".git")); err == nil {
			repositoryRoot = current
			break
		}
		if filepath.Dir(current) == current {
			break
		}
	}
	realScript, err := filepath.EvalSymlinks(filepath.Join(append([]string{realRoot}, strings.Split(ref, "/")...)...))
	if err != nil {
		return "", unavailable("script " + ref + " was not found in the repository")
	}
	if realScript != repositoryRoot && !strings.HasPrefix(realScript, repositoryRoot+string(filepath.Separator)) {
		return "", unavailable("script " + ref + " resolves outside the repository")
	}
	info, err := os.Stat(realScript)
	if err != nil {
		return "", unavailable("script " + ref + " could not be read")
	}
	if !info.Mode().IsRegular() {
		return "", unavailable("script " + ref + " is not a regular file")
	}
	if runtime.GOOS != "windows" && info.Mode().Perm()&0o111 == 0 {
		return "", unavailable("script " + ref + " is not executable (chmod +x it)")
	}
	return realScript, nil
}

func findRepositoryScript(scriptsDir, name string, unavailable func(string) error) (string, error) {
	var matches []string
	for _, suffix := range profileScriptSuffixes {
		candidate := filepath.Join(scriptsDir, name+suffix)
		info, err := os.Lstat(candidate)
		if errors.Is(err, fs.ErrNotExist) {
			continue
		}
		if err != nil || !info.Mode().IsRegular() {
			return "", unavailable(".revyl/scripts/" + name + suffix + " is not a readable regular file")
		}
		matches = append(matches, candidate)
	}
	if len(matches) > 1 {
		return "", unavailable(".revyl/scripts holds more than one file named " + name + "; keep one")
	}
	if len(matches) == 0 {
		return "", nil
	}
	return matches[0], nil
}

// gitBranch is the branch the Revyl CLI's DetectGitBranch finds for a project folder: the branch checked out there, or on GitHub
// Actions and Buildkite the branch CI built when the checkout is that code. Empty when it finds none.
func gitBranch(projectRoot string) string {
	ctx, cancel := context.WithTimeout(context.Background(), profileGitTimeout)
	defer cancel()
	checkout, ok := readCheckout(ctx, projectRoot)
	var name string
	if ok {
		var found bool
		name, found = detectCIBranch(&checkout)
		if !found && checkout.branch != "" && !syntheticGitHubBranch(checkout.branch) {
			name = branchCandidate(checkout.branch)
		}
	} else if ctx.Err() == nil {
		name, _ = detectCIBranch(nil)
	}
	return name
}

type gitCheckout struct {
	branch, head, repository string
	parents                  []string
}

// branchCandidate bounds a detected name as the CLI does; Revyl validates it.
func branchCandidate(name string) string {
	if !utf8.ValidString(name) {
		return strings.Repeat("invalid-utf8", 24)
	}
	if utf8.RuneCountInString(name) <= 4096 {
		return name
	}
	return string([]rune(name)[:4096])
}

func readCheckout(ctx context.Context, dir string) (gitCheckout, bool) {
	inside, ok := runDetectionGit(ctx, dir, "rev-parse", "--is-inside-work-tree")
	if !ok || strings.TrimSpace(inside) != "true" {
		return gitCheckout{}, false
	}
	checkout := gitCheckout{}
	if branchRef, ok := runDetectionGit(ctx, dir, "symbolic-ref", "--quiet", "HEAD"); ok && strings.HasPrefix(branchRef, "refs/heads/") {
		checkout.branch = strings.TrimRight(strings.TrimPrefix(branchRef, "refs/heads/"), "\r\n")
	}
	if checkout.branch != "" && os.Getenv("GITHUB_ACTIONS") != "true" && os.Getenv("BUILDKITE") != "true" {
		return checkout, true
	}
	head, _ := runDetectionGit(ctx, dir, "rev-parse", "--verify", "HEAD")
	checkout.head = strings.TrimSpace(head)
	remote, _ := runDetectionGit(ctx, dir, "remote", "get-url", "origin")
	checkout.repository = normalizeRepository(remote)
	if os.Getenv("GITHUB_ACTIONS") == "true" && strings.HasPrefix(os.Getenv("GITHUB_REF"), "refs/pull/") {
		commit, _ := runDetectionGit(ctx, dir, "cat-file", "-p", "HEAD")
		for _, line := range strings.Split(commit, "\n") {
			if line == "" {
				break
			}
			if parent, isParent := strings.CutPrefix(line, "parent "); isParent {
				checkout.parents = append(checkout.parents, parent)
			}
		}
	}
	return checkout, true
}

func syntheticGitHubBranch(branch string) bool {
	if os.Getenv("GITHUB_ACTIONS") != "true" || !strings.HasPrefix(os.Getenv("GITHUB_REF"), "refs/pull/") {
		return false
	}
	return branch == os.Getenv("GITHUB_REF_NAME") || branch == os.Getenv("GITHUB_REF")
}

// detectCIBranch accepts the CI's branch only when the checkout, if any, is the code CI built. found is true when a CI context
// decided the branch, even when it has no usable name, which keeps the local branch from standing in for it.
func detectCIBranch(checkout *gitCheckout) (name string, found bool) {
	if os.Getenv("GITHUB_ACTIONS") == "true" {
		return detectGitHubBranch(checkout)
	}
	if os.Getenv("BUILDKITE") == "true" {
		return detectBuildkiteBranch(checkout)
	}
	return "", false
}

type githubBranchEvent struct {
	Number     int    `json:"number"`
	Ref        string `json:"ref"`
	After      string `json:"after"`
	Repository struct {
		FullName string `json:"full_name"`
	} `json:"repository"`
	PullRequest struct {
		Number int `json:"number"`
		Head   struct {
			SHA  string `json:"sha"`
			Ref  string `json:"ref"`
			Repo struct {
				FullName string `json:"full_name"`
			} `json:"repo"`
		} `json:"head"`
		Base struct {
			Repo struct {
				FullName string `json:"full_name"`
			} `json:"repo"`
		} `json:"base"`
	} `json:"pull_request"`
}

func detectGitHubBranch(checkout *gitCheckout) (string, bool) {
	event := readBranchEvent(os.Getenv("GITHUB_EVENT_PATH"))
	repository := normalizeRepository(os.Getenv("GITHUB_REPOSITORY"))
	if repository == "" {
		return "", false
	}
	pr := event.PullRequest
	if pr.Head.Ref != "" && pr.Head.SHA != "" {
		baseRepository := normalizeRepository(pr.Base.Repo.FullName)
		headRepository := normalizeRepository(pr.Head.Repo.FullName)
		if baseRepository != repository || headRepository == "" {
			return "", false
		}
		if checkout != nil {
			if checkout.branch != "" && checkout.branch != pr.Head.Ref && !syntheticGitHubBranch(checkout.branch) {
				return "", false
			}
			if checkout.repository != baseRepository && checkout.repository != headRepository {
				return "", false
			}
			mergeCheckout := strings.HasPrefix(os.Getenv("GITHUB_REF"), "refs/pull/") && strings.HasSuffix(os.Getenv("GITHUB_REF"), "/merge") &&
				sameCommit(checkout.head, os.Getenv("GITHUB_SHA")) && slices.ContainsFunc(checkout.parents, func(parent string) bool { return sameCommit(parent, pr.Head.SHA) })
			if !sameCommit(checkout.head, pr.Head.SHA) && !mergeCheckout {
				return "", false
			}
		}
		return pullRequestHeadBranch(pr.Head.Ref, pr.Head.Repo.FullName, headRepository != baseRepository)
	}
	if checkout != nil && checkout.branch != "" {
		return "", false
	}
	ref := os.Getenv("GITHUB_REF")
	if os.Getenv("GITHUB_HEAD_REF") != "" || os.Getenv("GITHUB_REF_TYPE") == "tag" || !strings.HasPrefix(ref, "refs/heads/") {
		return "", false
	}
	if checkout != nil && (checkout.repository != repository || !sameCommit(checkout.head, os.Getenv("GITHUB_SHA"))) {
		return "", false
	}
	name := branchCandidate(strings.TrimPrefix(ref, "refs/heads/"))
	return name, name != ""
}

type buildkiteSource struct {
	reviewNumber   int
	repositoryURL  string
	repository     string
	fork           bool
	commit, branch string
}

func readBuildkiteSource() (buildkiteSource, bool) {
	if os.Getenv("BUILDKITE_TAG") != "" {
		return buildkiteSource{}, false
	}
	source := buildkiteSource{repositoryURL: os.Getenv("BUILDKITE_REPO")}
	pipelineRepository := normalizeRepository(source.repositoryURL)
	if pipelineRepository == "" {
		return buildkiteSource{}, false
	}
	source.repository = pipelineRepository
	if review, err := strconv.Atoi(os.Getenv("BUILDKITE_PULL_REQUEST")); err == nil && review > 0 {
		source.reviewNumber = review
		if headRepositoryURL := os.Getenv("BUILDKITE_PULL_REQUEST_REPO"); headRepositoryURL != "" {
			source.repositoryURL, source.repository = headRepositoryURL, normalizeRepository(headRepositoryURL)
			if source.repository == "" {
				return buildkiteSource{}, false
			}
		}
	}
	source.fork = source.repository != pipelineRepository
	source.commit = os.Getenv("BUILDKITE_PULL_REQUEST_HEAD_COMMIT")
	if source.commit == "" {
		source.commit = os.Getenv("BUILDKITE_COMMIT")
	}
	source.branch = os.Getenv("BUILDKITE_BRANCH")
	if source.fork {
		if _, branch, prefixed := strings.Cut(source.branch, ":"); prefixed {
			source.branch = branch
		}
	}
	return source, true
}

func detectBuildkiteBranch(checkout *gitCheckout) (string, bool) {
	source, ok := readBuildkiteSource()
	if !ok {
		return "", false
	}
	if checkout != nil {
		if checkout.repository != source.repository || !sameCommit(checkout.head, source.commit) {
			return "", false
		}
		if checkout.branch != "" && checkout.branch != source.branch {
			return "", false
		}
	}
	if source.reviewNumber > 0 {
		return pullRequestHeadBranch(source.branch, source.repositoryURL, source.fork)
	}
	if checkout != nil && checkout.branch != "" {
		return "", false
	}
	name := branchCandidate(source.branch)
	return name, name != ""
}

// pullRequestHeadBranch names the pull request's own branch, owner:branch for a fork. A verified pull request without a usable
// name still counts as found.
func pullRequestHeadBranch(branch, headRepository string, fork bool) (string, bool) {
	if branch == "" {
		return "", true
	}
	if !fork {
		return branchCandidate(branch), true
	}
	owner := repositoryNamespace(headRepository)
	if owner == "" {
		return "", true
	}
	return branchCandidate(owner + ":" + branch), true
}

func readBranchEvent(path string) githubBranchEvent {
	var event githubBranchEvent
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() > 1024*1024 {
		return event
	}
	file, err := os.Open(path)
	if err != nil {
		return event
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, 1024*1024+1))
	if err != nil || len(data) > 1024*1024 || json.Unmarshal(data, &event) != nil {
		return githubBranchEvent{}
	}
	return event
}

// parseRepository splits a repository reference, such as owner/name, an HTTPS URL or an SSH remote, into its lowercase host and
// case-preserving path.
func parseRepository(value string) (host, repositoryPath string) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", ""
	}
	if strings.HasPrefix(value, "git@") && strings.Contains(value, ":") {
		value = "ssh://" + strings.Replace(value, ":", "/", 1)
	}
	if !strings.Contains(value, "://") {
		if strings.Count(value, "/") != 1 || strings.HasPrefix(value, ".") {
			return "", ""
		}
		value = "https://github.com/" + value
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.Hostname() == "" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", ""
	}
	repositoryPath = strings.TrimSuffix(strings.TrimSuffix(parsed.Path, "/"), ".git")
	if repositoryPath == "" {
		return "", ""
	}
	return strings.ToLower(parsed.Host), repositoryPath
}

func normalizeRepository(value string) string {
	host, repositoryPath := parseRepository(value)
	if repositoryPath == "" {
		return ""
	}
	if host == "github.com" {
		repositoryPath = strings.ToLower(repositoryPath)
	}
	return host + repositoryPath
}

func repositoryNamespace(value string) string {
	_, repositoryPath := parseRepository(value)
	segments := strings.Split(strings.TrimPrefix(repositoryPath, "/"), "/")
	if len(segments) < 2 || slices.Contains(segments, "") {
		return ""
	}
	return strings.Join(segments[:len(segments)-1], "/")
}

func sameCommit(a, b string) bool {
	if (len(a) != 40 && len(a) != 64) || len(a) != len(b) {
		return false
	}
	if _, err := hex.DecodeString(a); err != nil {
		return false
	}
	return strings.EqualFold(a, b)
}

type boundedGitOutput struct {
	bytes.Buffer
}

func (b *boundedGitOutput) Write(p []byte) (int, error) {
	n := len(p)
	_, _ = b.Buffer.Write(p[:min(len(p), 64*1024-b.Len())])
	return n, nil
}

// runDetectionGit runs git in dir with prompts, credential helpers and optional locks turned off, as the Revyl CLI does.
func runDetectionGit(ctx context.Context, dir string, args ...string) (string, bool) {
	command := exec.CommandContext(ctx, "git", append([]string{"-C", filepath.Clean(dir)}, args...)...)
	for _, value := range os.Environ() {
		key, _, _ := strings.Cut(value, "=")
		switch key {
		case "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_TERMINAL_PROMPT", "GCM_INTERACTIVE", "GIT_ASKPASS", "SSH_ASKPASS", "GIT_OPTIONAL_LOCKS", "GIT_SSH", "GIT_SSH_COMMAND":
			continue
		}
		command.Env = append(command.Env, value)
	}
	command.Env = append(command.Env, "GIT_TERMINAL_PROMPT=0", "GCM_INTERACTIVE=never", "GIT_ASKPASS=", "SSH_ASKPASS=", "GIT_OPTIONAL_LOCKS=0", "GIT_SSH_COMMAND=ssh -oBatchMode=yes -oConnectTimeout=3 -oConnectionAttempts=1")
	command.WaitDelay = 200 * time.Millisecond
	var output boundedGitOutput
	command.Stdout = &output
	err := command.Run()
	return output.String(), err == nil
}

// jsTrim trims what JavaScript's String.prototype.trim does, so names and scripts compare as the TypeScript SDK compares them.
func jsTrim(text string) string {
	return strings.TrimFunc(text, func(r rune) bool {
		return r == '\uFEFF' || r != '\u0085' && unicode.IsSpace(r)
	})
}

// reportedSessionProfile reads the session_profile field of a start response or session report, in this one place.
func reportedSessionProfile(raw json.RawMessage) *reportedProfile {
	var profile map[string]any
	if json.Unmarshal(raw, &profile) != nil || profile == nil {
		return nil
	}
	text := func(key string) string {
		value, _ := profile[key].(string)
		return value
	}
	return &reportedProfile{name: text("name"), status: text("status"), outcome: text("outcome"), failureReason: text("failure_reason"), missingGitBranchName: text("missing_git_branch_name")}
}

// missingBranchNotice is the progress line for a branch Git doesn't have, from the start or create response.
func missingBranchNotice(profile *reportedProfile, plan *sessionProfilePlan) string {
	if profile == nil || profile.missingGitBranchName == "" {
		return ""
	}
	name := profile.name
	if name == "" {
		name = plan.name
	}
	return fmt.Sprintf("Git has no branch %q, so session profile %s reads the repository's default branch instead", profile.missingGitBranchName, name)
}

var profileOutcomeFixes = map[string]string{
	"script_failed":      "Its script exited with an error. Run the script yourself from the project root to see its output; Revyl doesn't show the output because setup scripts often print secrets.",
	"script_timed_out":   "Its script didn't finish within Revyl's 300-second limit. Make it finish sooner.",
	"script_unavailable": "Revyl could not find its script: commit it, or check session.profiles in .revyl/config.yaml. A script name with no .revyl/scripts file must be a Library Script in your Revyl organization.",
	"output_invalid":     "An output file the script wrote broke a rule, as the reason says. Fix what the script writes there.",
	"runner_failed":      "It failed on Revyl's side. Open the session again.",
}

// profileFailedError is SESSION_PROFILE_FAILED for a profile Revyl reported as failed. Revyl stops the session itself.
func profileFailedError(profile *reportedProfile, plan *sessionProfilePlan, viewer string) error {
	name := profile.name
	if name == "" {
		name = plan.name
	}
	outcome := profile.outcome
	if outcome == "" {
		outcome = "unknown"
	}
	reason := "."
	if profile.failureReason != "" {
		reason = ": " + profileSentence(profile.failureReason)
	}
	fix, known := profileOutcomeFixes[outcome]
	if !known {
		fix = "Check the session link for what happened."
	}
	return &Error{Code: ErrSessionProfileFailed, Message: fmt.Sprintf("Session profile %q failed (%s)%s %s Revyl stops the session. See %s", name, outcome, reason, fix, viewer), Outcome: profile.outcome, FailureReason: profile.failureReason}
}

// profileNotReportedError is NOT_AVAILABLE_ON_PLATFORM for a session that became active without reporting the profile Verify sent.
func profileNotReportedError(platform Platform, viewer string) error {
	return failure(ErrNotAvailableOnPlatform, fmt.Sprintf("This Revyl backend doesn't run session profiles on %s yet, so Verify stopped the session. Pass %s to start without one. See %s", platform, profileNoneHint, viewer))
}

func profileConfigPath(plan *sessionProfilePlan) string {
	if plan.configPath == "" {
		return ".revyl/config.yaml"
	}
	return plan.configPath
}

var profileRefusals = map[string]struct {
	code Code
	fix  func(*sessionProfilePlan) string
}{
	"session_profile_undefined": {ErrConfigInvalid, func(plan *sessionProfilePlan) string {
		return "Check that session.profiles in " + profileConfigPath(plan) + " defines it and that project.id names the project that holds it."
	}},
	"session_profile_source_required": {ErrInvalidArgument, func(*sessionProfilePlan) string {
		return "Update Verify to the latest version; it sends the project with every named profile."
	}},
	"session_profile_files_need_named": {ErrInvalidArgument, func(*sessionProfilePlan) string {
		return "Update Verify to the latest version; it sends checkout files only with a named profile."
	}},
	"session_profile_script_unavailable": {ErrSessionProfileFailed, func(*sessionProfilePlan) string {
		return "Commit the script or add it to .revyl/scripts, or create the Library Script with that name in your Revyl organization."
	}},
	"repository_connection_missing": {ErrConfigInvalid, func(*sessionProfilePlan) string {
		return "Connect the repository's GitHub or GitLab app to the project in Revyl, then open the session again."
	}},
	"project_not_found": {ErrConfigInvalid, func(plan *sessionProfilePlan) string {
		return "project.id in " + profileConfigPath(plan) + " must name a project that already exists in Revyl, in this API key's organization. 'revyl init' writes a new id that Revyl doesn't know until the project is published: connect the repository to Revyl ('revyl github connect'), then run 'revyl config push' from the checkout. Or put an existing project's id in project.id, or open with " + profileNoneHint + " to start without a session profile."
	}},
	"repository_unavailable": {ErrAPI, func(*sessionProfilePlan) string {
		return "Revyl couldn't read the repository after 3 attempts. Try again in a few minutes."
	}},
}

// profileRefusalError is the error for a start or create Revyl refused because of the session profile fields, or nil when the
// refusal is about something else. Reads the top-level code, falling back to the sentence an older backend sends.
func profileRefusalError(r response, plan *sessionProfilePlan, platform Platform) error {
	var body map[string]any
	if json.Unmarshal(r.body, &body) != nil || body == nil {
		return nil
	}
	code, _ := body["code"].(string)
	raw := ""
	for _, key := range []string{"detail", "message"} {
		if text, ok := body[key].(string); ok && jsTrim(text) != "" && !profileBareCode.MatchString(jsTrim(text)) {
			raw = text
			break
		}
	}
	said := ""
	if raw != "" {
		said = profileSentence(utf16Prefix(jsTrim(raw), 500))
	}
	subject := "the session profile request"
	if plan.name != "" {
		subject = fmt.Sprintf("session profile %q", plan.name)
	}
	if refusal, known := profileRefusals[code]; known {
		detail := "."
		if said != "" {
			detail = ": " + said
		}
		failed := &Error{Code: refusal.code, Reason: RefusalReason(code), HTTPStatus: r.status, Message: fmt.Sprintf("Revyl refused %s (%s)%s %s", subject, code, detail, refusal.fix(plan))}
		if code == "session_profile_script_unavailable" {
			failed.Outcome, failed.FailureReason = "script_unavailable", said
		}
		return failed
	}
	if r.status != 422 {
		return nil
	}
	detail, _ := body["detail"].(string)
	nested, _ := body["detail"].(map[string]any)
	legacyDevice := platform != Mac && (detail == profileLegacyDeviceDetail || nested != nil && nested["error"] == "web_session_profile_start_unsupported" && nested["message"] == profileLegacyDeviceDetail)
	legacyComputer := platform == Mac && detail == "invalid_request" && len(body) == 1
	if !legacyDevice && !legacyComputer {
		return nil
	}
	return &Error{Code: ErrNotAvailableOnPlatform, HTTPStatus: r.status, Message: "Revyl doesn't run session profiles for API starts yet; open the session without Profile.", legacyProfileRefusal: true}
}

const profileLegacyDeviceDetail = "Session profiles on this start need a CLI start or Open preview in this release"

// isLegacyProfileRefusal reports whether Revyl refused the start the way a backend without hosted profiles does: the device and
// web 422 that needs a CLI start or Open preview, or the computer create's bare invalid_request, which its strict schema answers
// for the profile fields.
func isLegacyProfileRefusal(err error) bool {
	var typed *Error
	return errors.As(err, &typed) && typed.legacyProfileRefusal
}

// withRepositoryRetry runs a start or create, repeating it with the same body while Revyl answers repository_unavailable: 3
// attempts in all.
func withRepositoryRetry[T any](ctx context.Context, start func() (T, error)) (T, error) {
	for attempt := 0; ; attempt++ {
		result, err := start()
		var typed *Error
		if err == nil || !errors.As(err, &typed) || typed.Reason != ReasonRepositoryUnavailable || attempt >= len(profileRetryDelays) {
			return result, err
		}
		if err := pause(ctx, profileRetryDelays[attempt]); err != nil {
			return result, err
		}
	}
}

func profileSentence(text string) string {
	trimmed := jsTrim(text)
	if strings.HasSuffix(trimmed, ".") || strings.HasSuffix(trimmed, "!") || strings.HasSuffix(trimmed, "?") {
		return trimmed
	}
	return trimmed + "."
}

func utf16Prefix(text string, limit int) string {
	units := utf16.Encode([]rune(text))
	if len(units) <= limit {
		return text
	}
	return string(utf16.Decode(units[:limit]))
}
