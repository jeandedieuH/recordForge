// Privacy-mask pass.
//
// Reads the composed canvas stage, writes the same raster with one mask applied
// inside its rect. The compatibility renderer implements the same modes with
// FFmpeg filters: `redact` fills a box, `blur` downsamples + averages +
// upsamples, and `pixelate` downsamples with nearest-neighbour. The shader
// reproduces each result from the stage texture so no extra copy is needed.
//
// A mask pass writes every pixel (outside the rect it passes the source
// through), so the destination stage never needs a clear.

struct MaskParams {
    // xy = rect origin, zw = rect size, canvas px.
    rect: vec4<f32>,
    // rgb = redact colour.
    color: vec4<f32>,
    // x = mode (0 redact, 1 blur, 2 pixelate), y = blur factor / pixel size,
    // z = 1 when the blur is the multi-scale approximation (radius > 3), 0 when
    // it is a direct avgblur window like the compatibility graph's small-radius
    // branch.
    params: vec4<f32>,
};

@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var src_sampler: sampler;
@group(0) @binding(2) var<uniform> mask: MaskParams;

struct VsOut {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32) -> VsOut {
    var positions = array<vec2<f32>, 3>(
        vec2<f32>(-1.0, 1.0),
        vec2<f32>(3.0, 1.0),
        vec2<f32>(-1.0, -3.0),
    );
    var uvs = array<vec2<f32>, 3>(
        vec2<f32>(0.0, 0.0),
        vec2<f32>(2.0, 0.0),
        vec2<f32>(0.0, 2.0),
    );
    var out: VsOut;
    out.position = vec4<f32>(positions[vertex_index], 0.0, 1.0);
    out.uv = uvs[vertex_index];
    return out;
}

fn load_px(px: vec2<f32>) -> vec3<f32> {
    let dims = vec2<i32>(textureDimensions(src));
    let coord = clamp(vec2<i32>(px), vec2<i32>(0, 0), dims - vec2<i32>(1, 1));
    return textureLoad(src, coord, 0).rgb;
}

// Small-grid dimensions for the multi-scale blur / pixelate chains: the
// compatibility graph rounds the factor, then truncates each side to an even
// number (`((w / factor) / 2 * 2)`), minimum 2.
fn small_grid() -> vec2<f32> {
    let factor = max(mask.params.y, 1.0);
    let sw = max(2u, u32(round(mask.rect.z / factor)) / 2u * 2u);
    let sh = max(2u, u32(round(mask.rect.w / factor)) / 2u * 2u);
    return vec2<f32>(f32(sw), f32(sh));
}

// One small-grid pixel's colour. The compatibility graph reaches the small
// image through swscale's bilinear *downscale*, whose support widens with the
// scale factor (≈ an area average over the cell), so one centre tap is far too
// sharp. Nine integer taps spread over the cell approximate that average.
// `textureLoad` (not a filtered sample) keeps each tap an exact texel, so the
// cell average is deterministic across adapters.
fn cell_value(cell: vec2<f32>, grid: vec2<f32>) -> vec3<f32> {
    let clamped = clamp(cell, vec2<f32>(0.0, 0.0), grid - vec2<f32>(1.0, 1.0));
    let cell_size = mask.rect.zw / grid;
    let centre = mask.rect.xy + (clamped + vec2<f32>(0.5, 0.5)) * cell_size;
    let step = cell_size / 3.0;
    var sum = vec3<f32>(0.0, 0.0, 0.0);
    for (var j = -1; j <= 1; j = j + 1) {
        for (var i = -1; i <= 1; i = i + 1) {
            sum = sum + load_px(centre + vec2<f32>(f32(i), f32(j)) * step);
        }
    }
    return sum / 9.0;
}

// Multi-scale blur: `scale(bilinear, small) → avgblur(3×3) → scale(bilinear)`.
// The blurred small image is reconstructed per cell (9 taps) and then sampled
// bilinearly at the fragment's own small-grid position, so neighbouring pixels
// inside one cell agree instead of each sampling the full-res canvas at its own
// phase.
fn multi_scale_blur(px: vec2<f32>, grid: vec2<f32>) -> vec3<f32> {
    let cell = mask.rect.zw / grid;
    // `px` is the fragment centre (i + 0.5); small-grid coordinates put each
    // cell centre at k + 0.5.
    let rel = (px - mask.rect.xy) / cell - vec2<f32>(0.5, 0.5);
    let base = floor(rel);
    let frac = rel - base;

    var sum = vec3<f32>(0.0, 0.0, 0.0);
    for (var j = 0; j < 2; j = j + 1) {
        for (var i = 0; i < 2; i = i + 1) {
            let index = base + vec2<f32>(f32(i), f32(j));
            var blurred = vec3<f32>(0.0, 0.0, 0.0);
            for (var by = -1; by <= 1; by = by + 1) {
                for (var bx = -1; bx <= 1; bx = bx + 1) {
                    blurred = blurred + cell_value(index + vec2<f32>(f32(bx), f32(by)), grid);
                }
            }
            blurred = blurred / 9.0;
            let wx = select(1.0 - frac.x, frac.x, i == 1);
            let wy = select(1.0 - frac.y, frac.y, j == 1);
            sum = sum + blurred * wx * wy;
        }
    }
    return sum;
}

// Small-radius blur (`avgblur=sizeX=r` directly on the region). Taps are exact
// texel loads for the same reason as `cell_value`.
fn direct_blur(px: vec2<f32>) -> vec3<f32> {
    let window = max(mask.params.y, 1.0);
    let step = max((window - 1.0) * 0.5, 0.0);
    var sum = vec3<f32>(0.0, 0.0, 0.0);
    for (var j = -1; j <= 1; j = j + 1) {
        for (var i = -1; i <= 1; i = i + 1) {
            let tap = clamp(
                px + vec2<f32>(f32(i), f32(j)) * step,
                mask.rect.xy + vec2<f32>(0.5, 0.5),
                mask.rect.xy + mask.rect.zw - vec2<f32>(0.5, 0.5),
            );
            sum = sum + load_px(tap);
        }
    }
    return sum / 9.0;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
    let dims = vec2<f32>(textureDimensions(src));
    let px = in.uv * dims;
    let rect = mask.rect;
    let inside =
        px.x >= rect.x && px.y >= rect.y && px.x < rect.x + rect.z && px.y < rect.y + rect.w;
    if (!inside) {
        return vec4<f32>(load_px(px), 1.0);
    }

    let mode = mask.params.x;
    if (mode < 0.5) {
        // Redact: the compatibility path paints an opaque box with the
        // configured colour.
        return vec4<f32>(mask.color.rgb, 1.0);
    }

    if (mode < 1.5) {
        if (mask.params.z > 0.5) {
            return vec4<f32>(multi_scale_blur(px, small_grid()), 1.0);
        }
        return vec4<f32>(direct_blur(px), 1.0);
    }

    // Pixelate: reproduce the compatibility chain's nearest-neighbour downscale
    // and upscale so block boundaries fall on the same source pixels. Point
    // scaling samples the block's first column/row (`floor(k * W / Ws)`), not its
    // centre.
    let grid = small_grid();
    let cell = mask.rect.zw / grid;
    let small = floor((px - mask.rect.xy - vec2<f32>(0.5, 0.5)) * grid / mask.rect.zw);
    let clamped = clamp(small, vec2<f32>(0.0, 0.0), grid - vec2<f32>(1.0, 1.0));
    let centre = mask.rect.xy + clamped * cell;
    return vec4<f32>(load_px(centre), 1.0);
}
