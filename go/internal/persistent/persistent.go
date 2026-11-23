// Package persistent connects the experimental package to Verify's client. It is not an API.
package persistent

import (
	"context"
	"net/http"
	"time"
)

type Connection struct {
	BackendURL string
	AppURL     string
	HTTPClient *http.Client
	Log        func(string)
}

type OpenOptions struct {
	Connection
	FromSnapshot string
	Timeout      time.Duration
	StartTimeout time.Duration
}

type SaveOptions struct {
	Connection
	Timeout time.Duration
}

type Computer struct {
	ID           string
	State        string
	SavedAt      time.Time
	SavedOffHost bool
	CreatedAt    time.Time
}

type Snapshot struct {
	ID         string
	Name       string
	ComputerID string
	SavedAt    time.Time
	ExpiresAt  time.Time
}

// Open returns the *verify.Session as any, because this package cannot import verify.
var (
	Open           func(ctx context.Context, name string, options OpenOptions) (session any, created bool, err error)
	SaveSnapshot   func(ctx context.Context, computer, snapshot string, options SaveOptions) (Snapshot, error)
	ListComputers  func(ctx context.Context, options Connection) ([]Computer, error)
	ListSnapshots  func(ctx context.Context, options Connection) ([]Snapshot, error)
	DeleteComputer func(ctx context.Context, computer string, options Connection) error
	DeleteSnapshot func(ctx context.Context, snapshot string, options Connection) error
)
