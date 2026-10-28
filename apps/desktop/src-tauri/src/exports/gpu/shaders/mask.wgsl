// Privacy-mask composite pass.
//
// Reads the composed canvas stage, writes the same raster with one mask applied
// inside its rect. The compatibility renderer implements the same modes with
// FFmpeg filters: `redact` fills a box, `blur` downsamples + averages +
// upsamples, and `pixelate` downsamples with nearest-neighbour. The shader
// reproduces each result from the stage texture so no extra copy is needed.
//
// Multi-scale blur is pre-rendered into a small texture by `blur.wgsl`
// (`fs_downscale` + `fs_avgblur`); this pass only samples that result with the
// compatibility graph's final bilinear upscale.
//
// A mask pass writes every pixel (outside the rect it passes the source
// through), so the destination stage never needs a clear.

struct MaskParams {
    // xy = rect origin, zw = rect size, canvas px.
    rect: vec4<f32>,
    // rgb = redact colour.
    color: vec4<f32>,
    // x = mode (0 redact, 1 blur, 2 pixelate), y = blur radius / pixel size,
    // z = 1 when the blur reads a pre-rendered multi-scale texture, 0 when it
    // is a direct avgblur window like the compatibility graph's small-radius
    // branch.
    params: vec4<f32>,
};

@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var src_sampler: sampler;
@group(0) @binding(2) var<uniform> mask: MaskParams;
@group(0) @binding(3) var blurred_y: texture_2d<f32>;
@group(0) @binding(4) var blurred_uv: texture_2d<f32>;

fn yuv_to_rgb(yuv: vec3<f32>) -> vec3<f32> {
    let r = yuv.x + 1.402 * yuv.z;
    let b = yuv.x + 1.772 * yuv.y;
    let g = yuv.x - 0.344136 * yuv.y - 0.714136 * yuv.z;
    return vec3<f32>(r, g, b);
}

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

// Small-grid dimensions for the pixelate chain: the compatibility graph rounds
// the factor, then truncates each side to an even number
// (`((w / factor) / 2 * 2)`), minimum 2.
fn small_grid() -> vec2<f32> {
    let factor = max(mask.params.y, 1.0);
    let sw = max(2u, u32(round(mask.rect.z / factor)) / 2u * 2u);
    let sh = max(2u, u32(round(mask.rect.w / factor)) / 2u * 2u);
    return vec2<f32>(f32(sw), f32(sh));
}

// Small-radius blur (`avgblur=sizeX=r` directly on the region). `sizeX` is a
// radius, so the window is (2r+1)² with edge-replicated samples and a fixed
// divisor — exactly libavfilter's sliding window. The loop is fixed at the
// maximum direct radius (3) so FXC can unroll it; the uniform radius gates the
// taps that count.
fn direct_blur(px: vec2<f32>) -> vec3<f32> {
    let radius = i32(max(mask.params.y, 1.0));
    let lo = vec2<i32>(i32(mask.rect.x), i32(mask.rect.y));
    let hi = lo + vec2<i32>(i32(mask.rect.z), i32(mask.rect.w)) - vec2<i32>(1, 1);
    let centre = vec2<i32>(px);
    var sum = vec3<f32>(0.0, 0.0, 0.0);
    for (var dy = -3; dy <= 3; dy = dy + 1) {
        for (var dx = -3; dx <= 3; dx = dx + 1) {
            if (abs(dx) > radius || abs(dy) > radius) {
                continue;
            }
            let coord = clamp(centre + vec2<i32>(dx, dy), lo, hi);
            sum = sum + textureLoad(src, coord, 0).rgb;
        }
    }
    let area = f32((2 * radius + 1) * (2 * radius + 1));
    return sum / max(area, 1.0);
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
            // The small grids span exactly the mask rect, so the full-res
            // pixel's relative position is the normalized sample coordinate
            // for both planes.
            let uv = (px - rect.xy) / rect.zw;
            let y = textureSample(blurred_y, src_sampler, uv).r;
            let uv_plane = textureSample(blurred_uv, src_sampler, uv).rg;
            return vec4<f32>(yuv_to_rgb(vec3<f32>(y, uv_plane)), 1.0);
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
