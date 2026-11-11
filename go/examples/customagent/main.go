// Command customagent runs Verify's steps on a LocalAgent you configure: your own OpenAI-compatible endpoint,
// a turn cap, and screen coordinates from the model, so Revyl receives only taps, typing and swipes.
//
//	ollama pull qwen3-vl:8b && cd go && go run ./examples/customagent
//
// MODEL_BASE_URL defaults to Ollama on this machine (http://localhost:11434/v1) and MODEL to qwen3-vl:8b.
// It needs REVYL_API_KEY (or a saved Revyl login) and starts a real, billable session.
package main

import (
	"context"
	"errors"
	"log"
	"os"
	"time"

	verify "github.com/RevylAI/verify/go"
)

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func env(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func run() (err error) {
	ctx := context.Background()
	model, err := verify.OpenAICompatible(verify.OpenAICompatibleOptions{
		BaseURL: env("MODEL_BASE_URL", "http://localhost:11434/v1"),
		Model:   env("MODEL", "qwen3-vl:8b"),
	})
	if err != nil {
		return err
	}
	agent := verify.LocalAgent{Model: model, Grounding: verify.GroundingModel, MaxTurns: 10}
	s, err := verify.Open(ctx, verify.Target{Platform: verify.IOS, BundleID: "com.apple.Preferences"}, verify.WithAgent(agent))
	if err != nil {
		return err
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		err = errors.Join(err, s.Close(cleanup))
	}()
	log.Println("Watch:", s.ViewerURL())
	if _, err := s.Instruction(ctx, "Open General, then About"); err != nil {
		return err
	}
	_, err = s.Validation(ctx, "The screen shows the iOS version")
	return err
}
