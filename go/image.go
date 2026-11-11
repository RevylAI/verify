package verify

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
)

// fitPNG shrinks a PNG by the smallest whole factor that keeps its longer side within maxSide, averaging each block of pixels.
func fitPNG(data []byte, maxSide int) (ModelImage, error) {
	source, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		return ModelImage{}, &Error{Code: ErrActionFailed, Message: "Revyl returned a screenshot that is not a PNG image.", Cause: err}
	}
	bounds := source.Bounds()
	factor := (max(bounds.Dx(), bounds.Dy()) + maxSide - 1) / maxSide
	if factor <= 1 {
		return ModelImage{PNG: data, Width: bounds.Dx(), Height: bounds.Dy()}, nil
	}
	pixels, ok := source.(*image.NRGBA)
	if rgba, opaque := source.(*image.RGBA); opaque && rgba.Opaque() {
		pixels, ok = &image.NRGBA{Pix: rgba.Pix, Stride: rgba.Stride, Rect: rgba.Rect}, true
	}
	if !ok {
		pixels = image.NewNRGBA(bounds)
		for y := bounds.Min.Y; y < bounds.Max.Y; y++ {
			for x := bounds.Min.X; x < bounds.Max.X; x++ {
				pixels.Set(x, y, color.NRGBAModel.Convert(source.At(x, y)))
			}
		}
	}
	width, height := bounds.Dx()/factor, bounds.Dy()/factor
	target := image.NewNRGBA(image.Rect(0, 0, width, height))
	area := factor * factor
	for y := range height {
		for x := range width {
			var sums [4]int
			for dy := range factor {
				row := pixels.PixOffset(bounds.Min.X+x*factor, bounds.Min.Y+y*factor+dy)
				for i := range factor * 4 {
					sums[i%4] += int(pixels.Pix[row+i])
				}
			}
			out := target.PixOffset(x, y)
			for channel, sum := range sums {
				target.Pix[out+channel] = uint8((2*sum + area) / (2 * area))
			}
		}
	}
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, target); err != nil {
		return ModelImage{}, &Error{Code: ErrActionFailed, Message: "Could not encode the screenshot for the model.", Cause: err}
	}
	return ModelImage{PNG: encoded.Bytes(), Width: width, Height: height}, nil
}
