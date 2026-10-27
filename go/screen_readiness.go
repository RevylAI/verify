package verify

import (
	"bytes"
	"context"
	"fmt"
	"image/color"
	"image/png"
	"time"
)

func (s *Session) waitFirstScreen(ctx context.Context) error {
	waitCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	for {
		r, err := s.client.send(waitCtx, "GET", s.workerPath("screenshot"), nil, false, 10*time.Second, true)
		if ctx.Err() != nil {
			return contextError(ctx)
		}
		if waitCtx.Err() != nil {
			break
		}
		if err != nil {
			if s.log != nil {
				s.log("debug: Best-effort first-screen wait skipped: screenshot request failed.")
			}
			return nil
		}
		if r.status == 200 {
			ready, err := nonBlankPNG(r.body)
			if ctx.Err() != nil {
				return contextError(ctx)
			}
			if waitCtx.Err() != nil {
				break
			}
			if err != nil {
				if s.log != nil {
					s.log("debug: Best-effort first-screen wait skipped: screenshot PNG could not be inspected.")
				}
				return nil
			}
			if ready {
				return nil
			}
		} else if r.status != 409 && r.status != 503 {
			if s.log != nil {
				s.log("debug: Best-effort first-screen wait skipped: screenshot is unavailable.")
			}
			return nil
		}
		if err := pause(waitCtx, 500*time.Millisecond); err != nil {
			break
		}
	}
	if ctx.Err() != nil {
		return contextError(ctx)
	}
	if s.log != nil {
		s.log("debug: Best-effort first-screen wait timed out; continuing without a non-blank screenshot.")
	}
	return nil
}

func nonBlankPNG(data []byte) (bool, error) {
	if len(data) > 16*1024*1024 {
		return false, fmt.Errorf("screenshot exceeds PNG byte limit")
	}
	config, err := png.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return false, err
	}
	if config.Width <= 0 || config.Height <= 0 || int64(config.Width)*int64(config.Height) > 16_000_000 {
		return false, fmt.Errorf("screenshot exceeds PNG pixel limit")
	}
	img, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		return false, err
	}
	left, top := config.Width/10, config.Height/10
	right, bottom := config.Width-left, config.Height-top
	first := pngRGB(img.At(left, top))
	for y := top; y < bottom; y++ {
		for x := left; x < right; x++ {
			if pngRGB(img.At(x, y)) != first {
				return true, nil
			}
		}
	}
	return false, nil
}

func pngRGB(c color.Color) [3]uint16 {
	switch pixel := c.(type) {
	case color.NRGBA:
		return [3]uint16{uint16(pixel.R) * 257, uint16(pixel.G) * 257, uint16(pixel.B) * 257}
	case color.NRGBA64:
		return [3]uint16{pixel.R, pixel.G, pixel.B}
	default:
		rgb := color.NRGBA64Model.Convert(c).(color.NRGBA64)
		return [3]uint16{rgb.R, rgb.G, rgb.B}
	}
}
