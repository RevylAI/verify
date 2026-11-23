// Package experimental holds Verify APIs that are internal previews: not covered by semver, not in the public docs,
// and subject to change.
//
// Persistent Mac computers keep their disk between runs. OpenPersistent(ctx, "name") opens the computer with that
// name, creating it if needed; Close stops it and keeps the disk; opening the same name again boots from that disk.
// SaveSnapshot pins a stopped computer's disk under a name, and OpenPersistent with FromSnapshot starts a new
// computer from it.
//
// Credentials and environment work as for verify.Open: REVYL_API_KEY or a "verify login", and BackendURL/AppURL
// (for example https://backend-staging.revyl.ai and https://staging.revyl.ai) to use another Revyl environment.
//
// Every function returns a *verify.Error; test it with errors.Is(err, verify.ErrNotFound) and read its Message for
// what to do: verify.ErrNotFound (no computer or snapshot by that name or ID), verify.ErrSessionBusy (the computer is
// running, or its last stop hasn't finished), verify.ErrTimeout (a wait ran out; the call can be repeated),
// verify.ErrComputerLimit (the organization keeps its maximum number of computers or snapshots, or can't start
// another computer now), verify.ErrNotAvailableOnPlatform (persistent computers aren't enabled for this API key's
// organization), verify.ErrInvalidArgument, verify.ErrAuthRejected, verify.ErrSessionStartFailed and verify.ErrAPI.
package experimental

import (
	"context"
	"net/http"
	"time"

	verify "github.com/RevylAI/verify/go"
	"github.com/RevylAI/verify/go/internal/persistent"
)

// Options apply to every persistent-computer call. Leave them empty for Revyl's defaults.
type Options struct {
	BackendURL string
	AppURL     string
	HTTPClient *http.Client
	// Log receives progress lines. Nil means no progress output.
	Log func(string)
}

// OpenOptions configure OpenPersistent.
type OpenOptions struct {
	Options
	// FromSnapshot is used only when this call creates the computer: its disk starts as this snapshot's (a name or
	// ID from ListSnapshots). If the computer already exists it opens as it is; check Computer.Created.
	FromSnapshot string
	// Timeout is how long this run may last before the computer stops itself (keeping its disk): whole seconds
	// from 1 minute to 24 hours, otherwise ErrInvalidArgument. Zero means 2 hours. Not applied when the computer
	// was already running. Same as Target.Timeout for verify.Open.
	Timeout time.Duration
	// StartTimeout is how long OpenPersistent waits for the computer to be ready, from 10 seconds to 30 minutes.
	// Zero means 15 minutes. It covers waiting for an earlier stop to finish saving, and a start from a snapshot,
	// which takes about 3 minutes.
	StartTimeout time.Duration
}

// SaveOptions configure SaveSnapshot.
type SaveOptions struct {
	Options
	// WaitTimeout is how long SaveSnapshot waits for the disk to be ready to snapshot, from 1 second to 1 hour.
	// Zero means 15 minutes. A disk is ready about 5-6 minutes after Close returns.
	WaitTimeout time.Duration
}

// Computer is a running persistent Mac. It has every method of the *verify.Session that verify.Open returns for a
// Mac, such as Exec, ReadFile, WriteFile, Screenshot and Extend; relative file paths are inside the computer's
// workspace folder, as on verify.Open. ID() is the persistent computer's ID: it stays the same across stops and
// starts and matches the ID ListPersistent reports.
type Computer struct {
	*verify.Session
	// Name is the name (or ID) you passed to OpenPersistent.
	Name string
	// Created is true when this OpenPersistent call created the computer, false when it already existed.
	Created bool
}

// Close stops the computer and keeps its disk: files, installed tools and settings are there the next time you
// OpenPersistent it. Memory and running processes are not kept. It returns once the disk is saved on its Mac, which
// can take a few minutes; a cancelled ctx stops the wait, not the save. A snapshot of this disk can be saved about
// 5-6 minutes after Close returns; SaveSnapshot waits for that. Unlike TypeScript and Python, Go does not stop it
// when the program exits, so always Close it.
func (c *Computer) Close(ctx context.Context) error {
	return c.Session.Close(ctx)
}

// PersistentComputer is one of your organization's persistent computers, as ListPersistent reports it.
type PersistentComputer struct {
	// ID stays the same across every stop and start, and works wherever a name does.
	ID string
	// State is "starting", "running", "stopping" or "stopped".
	State string
	// SavedAt is when its disk was last saved; zero until its first stop finishes saving.
	SavedAt time.Time
	// SavedOffHost is whether that save has been copied off the Mac that made it. SaveSnapshot needs this and
	// waits for it.
	SavedOffHost bool
	CreatedAt    time.Time
}

// Snapshot is a saved disk that OpenPersistent can start a new computer from.
type Snapshot struct {
	ID   string
	Name string
	// ComputerID is the persistent computer whose disk it saved.
	ComputerID string
	SavedAt    time.Time
	// ExpiresAt is when the save stops being usable; zero when it has no end.
	ExpiresAt time.Time
}

// OpenPersistent opens the persistent Mac with this name, creating it if it doesn't exist, starting it if it is
// stopped, and waiting until it is ready. Its disk outlives every stop: Close keeps it, and the next OpenPersistent
// with the same name boots from it. Names are 1-64 letters, digits, '.', '_' or '-', starting with a letter or
// digit; the same name opens the same computer from Go, TypeScript and Python. Pass an ID from ListPersistent to
// open an existing computer without creating one. If it is already running, OpenPersistent connects to it.
//
//	mac, err := experimental.OpenPersistent(ctx, "build-cache")
//	if err != nil {
//		return err
//	}
//	if mac.Created {
//		_, err = mac.Exec(ctx, []string{"brew", "install", "jq"})
//	}
//	err = errors.Join(err, mac.Close(ctx)) // stops it and keeps the disk
func OpenPersistent(ctx context.Context, name string, options ...OpenOptions) (*Computer, error) {
	opt, err := single(options)
	if err != nil {
		return nil, err
	}
	session, created, err := persistent.Open(ctx, name, persistent.OpenOptions{Connection: connection(opt.Options), FromSnapshot: opt.FromSnapshot, Timeout: opt.Timeout, StartTimeout: opt.StartTimeout})
	if err != nil {
		return nil, err
	}
	return &Computer{Session: session.(*verify.Session), Name: name, Created: created}, nil
}

// SaveSnapshot saves a stopped persistent computer's disk (by name or ID) as a named snapshot, which OpenPersistent
// with FromSnapshot can start a new computer from. The computer must be stopped: Close it first, or SaveSnapshot
// returns ErrSessionBusy. A disk is ready to snapshot about 5-6 minutes after Close returns, once it is copied off
// its Mac; SaveSnapshot waits for that (and for a stop still in progress) up to WaitTimeout, then returns
// ErrTimeout. Snapshot names follow the computer-name rule and are unique in your organization: a name already used
// for a different save returns ErrInvalidArgument, while calling it again for the same computer and save returns
// the snapshot it already saved. A snapshot lasts until you delete it.
func SaveSnapshot(ctx context.Context, computer, snapshot string, options ...SaveOptions) (Snapshot, error) {
	opt, err := single(options)
	if err != nil {
		return Snapshot{}, err
	}
	saved, err := persistent.SaveSnapshot(ctx, computer, snapshot, persistent.SaveOptions{Connection: connection(opt.Options), Timeout: opt.WaitTimeout})
	return Snapshot(saved), err
}

// ListPersistent lists your organization's persistent computers, stopped ones included, other people's too. Revyl
// stores no names, so each one is shown by its ID; compare with the ID() of a Computer OpenPersistent returned.
func ListPersistent(ctx context.Context, options ...Options) ([]PersistentComputer, error) {
	opt, err := single(options)
	if err != nil {
		return nil, err
	}
	computers, err := persistent.ListComputers(ctx, connection(opt))
	result := make([]PersistentComputer, 0, len(computers))
	for _, computer := range computers {
		result = append(result, PersistentComputer(computer))
	}
	return result, err
}

// ListSnapshots lists your organization's snapshots.
func ListSnapshots(ctx context.Context, options ...Options) ([]Snapshot, error) {
	opt, err := single(options)
	if err != nil {
		return nil, err
	}
	snapshots, err := persistent.ListSnapshots(ctx, connection(opt))
	result := make([]Snapshot, 0, len(snapshots))
	for _, snapshot := range snapshots {
		result = append(result, Snapshot(snapshot))
	}
	return result, err
}

// DeletePersistent deletes a persistent computer (by name or ID) and its saved disk for good. A running computer
// stops first, without saving. Snapshots of it are kept until you DeleteSnapshot them. It returns ErrNotFound when
// there is no such computer, including one already deleted.
func DeletePersistent(ctx context.Context, computer string, options ...Options) error {
	opt, err := single(options)
	if err != nil {
		return err
	}
	return persistent.DeleteComputer(ctx, computer, connection(opt))
}

// DeleteSnapshot deletes a snapshot by name or ID. Computers already started from it keep their disks. It returns
// ErrNotFound when there is no such snapshot.
func DeleteSnapshot(ctx context.Context, snapshot string, options ...Options) error {
	opt, err := single(options)
	if err != nil {
		return err
	}
	return persistent.DeleteSnapshot(ctx, snapshot, connection(opt))
}

func single[T any](options []T) (T, error) {
	var zero T
	if len(options) > 1 {
		return zero, &verify.Error{Code: verify.ErrInvalidArgument, Message: "Pass at most one options value."}
	}
	if len(options) == 1 {
		return options[0], nil
	}
	return zero, nil
}

func connection(options Options) persistent.Connection {
	return persistent.Connection{BackendURL: options.BackendURL, AppURL: options.AppURL, HTTPClient: options.HTTPClient, Log: options.Log}
}
