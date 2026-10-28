// Blur-mask resampling passes.
//
// The compatibility renderer's multi-scale blur is
//
//   crop → scale(small, bilinear) → avgblur(sizeX=3, sizeY=3) → scale(back, bilinear)
//
// and it runs on the Y and chroma planes independently. Reproducing it needs
// swscale's *downscale* kernel, not point or bilinear taps: for
// `flags=bilinear` swscale widens its triangle to the scale factor, so a
// destination pixel averages a `2 × scale`-wide support in source pixels.
//
// This module keeps Y and chroma separate. Luma is full-resolution; chroma is
// half-resolution, so its triangle radius is the same in chroma texels but
// covers twice as many luma pixels. The mask pass reconstructs RGB from the two
// blurred planes.
//
// `avgblur`'s `sizeX`/`sizeY` options are *radii*: sizeX=3 is a 7×7 window with
// a fixed divisor of 49 and edge-replicated samples.

struct BlurParams {
    // xy = mask-rect origin in canvas px, zw = mask-rect size in px.
    rect: vec4<f32>,
    // xy = destination plane size, zw = source plane size (for edge clamps).
    grid: vec4<f32>,
    // y = passthrough axis (0 horizontal, 1 vertical).
    opts: vec4<f32>,
};

@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var<uniform> params: BlurParams;

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

fn load(coord: vec2<i32>) -> vec3<f32> {
    let dims = vec2<i32>(textureDimensions(src));
    let clamped = clamp(coord, vec2<i32>(0, 0), dims - vec2<i32>(1, 1));
    return textureLoad(src, clamped, 0).rgb;
}

// BT.601 full-range normalized Y/Cb/Cr, the same basis the NV12 pack uses.
fn rgb_to_yuv(rgb: vec3<f32>) -> vec3<f32> {
    let y = 0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b;
    let cb = (rgb.b - y) / 1.772;
    let cr = (rgb.r - y) / 1.402;
    return vec3<f32>(y, cb, cr);
}

fn triangle_weight(sample: i32, pos: f32, radius: f32) -> f32 {
    return max(0.0, 1.0 - abs(f32(sample) - pos) / radius);
}

const MAX_TAPS: i32 = 40;

// --- luma -----------------------------------------------------------------

@fragment
fn fs_downscale_y(in: VsOut) -> @location(0) vec4<f32> {
    let out = vec2<i32>(in.position.xy);
    let horizontal = params.opts.y < 0.5;
    var sum = 0.0;
    var weight_sum = 0.0;

    if (horizontal) {
        let scale = max(params.rect.z / params.grid.x, 1.0);
        let pos = params.rect.x + (f32(out.x) + 0.5) * scale - 0.5;
        let row = i32(params.rect.y) + out.y;
        let first = i32(floor(pos - scale));
        let last = i32(ceil(pos + scale));
        for (var k = 0; k < MAX_TAPS; k = k + 1) {
            let j = first + k;
            if (j > last) {
                break;
            }
            let weight = triangle_weight(j, pos, scale);
            let column = clamp(j, i32(params.rect.x), i32(params.rect.x + params.rect.z) - 1);
            sum = sum + rgb_to_yuv(load(vec2<i32>(column, row))).x * weight;
            weight_sum = weight_sum + weight;
        }
    } else {
        let scale = max(params.rect.w / params.grid.y, 1.0);
        let pos = params.rect.y + (f32(out.y) + 0.5) * scale - 0.5;
        let first = i32(floor(pos - scale));
        let last = i32(ceil(pos + scale));
        for (var k = 0; k < MAX_TAPS; k = k + 1) {
            let j = first + k;
            if (j > last) {
                break;
            }
            let weight = triangle_weight(j, pos, scale);
            let row = clamp(j, 0, i32(params.grid.w) - 1);
            sum = sum + load(vec2<i32>(out.x, row)).x * weight;
            weight_sum = weight_sum + weight;
        }
    }

    return vec4<f32>(sum / max(weight_sum, 1e-6), 0.0, 0.0, 1.0);
}

@fragment
fn fs_avgblur_y(in: VsOut) -> @location(0) vec4<f32> {
    let out = vec2<i32>(in.position.xy);
    var sum = 0.0;
    for (var dy = -3; dy <= 3; dy = dy + 1) {
        for (var dx = -3; dx <= 3; dx = dx + 1) {
            sum = sum + load(out + vec2<i32>(dx, dy)).x;
        }
    }
    return vec4<f32>(sum / 49.0, 0.0, 0.0, 1.0);
}

// --- chroma ---------------------------------------------------------------

// One chroma texel is the average of a 2×2 luma block. The crop rect is even,
// so the block never crosses its edge.
fn chroma_block(canvas_x: i32, canvas_y: i32) -> vec2<f32> {
    let p = vec2<i32>(canvas_x, canvas_y);
    let c = rgb_to_yuv(load(p)).yz
        + rgb_to_yuv(load(p + vec2<i32>(1, 0))).yz
        + rgb_to_yuv(load(p + vec2<i32>(0, 1))).yz
        + rgb_to_yuv(load(p + vec2<i32>(1, 1))).yz;
    return c * 0.25;
}

@fragment
fn fs_downscale_uv(in: VsOut) -> @location(0) vec4<f32> {
    let out = vec2<i32>(in.position.xy);
    let horizontal = params.opts.y < 0.5;
    var sum = vec2<f32>(0.0, 0.0);
    var weight_sum = 0.0;

    if (horizontal) {
        // Destination and source are chroma-resolution; the source is the
        // full-res stage, read through the 2×2 block average.
        let scale = max(params.grid.z / params.grid.x, 1.0);
        let pos = (f32(out.x) + 0.5) * scale - 0.5;
        let first = i32(floor(pos - scale));
        let last = i32(ceil(pos + scale));
        let row = i32(params.rect.y) + out.y * 2;
        for (var k = 0; k < MAX_TAPS; k = k + 1) {
            let j = first + k;
            if (j > last) {
                break;
            }
            let weight = triangle_weight(j, pos, scale);
            let column = clamp(j, 0, i32(params.grid.z) - 1);
            sum = sum + chroma_block(i32(params.rect.x) + column * 2, row) * weight;
            weight_sum = weight_sum + weight;
        }
    } else {
        let scale = max(params.grid.w / params.grid.y, 1.0);
        let pos = (f32(out.y) + 0.5) * scale - 0.5;
        let first = i32(floor(pos - scale));
        let last = i32(ceil(pos + scale));
        for (var k = 0; k < MAX_TAPS; k = k + 1) {
            let j = first + k;
            if (j > last) {
                break;
            }
            let weight = triangle_weight(j, pos, scale);
            let row = clamp(j, 0, i32(params.grid.w) - 1);
            sum = sum + load(vec2<i32>(out.x, row)).xy * weight;
            weight_sum = weight_sum + weight;
        }
    }

    let uv = sum / max(weight_sum, 1e-6);
    return vec4<f32>(uv.x, uv.y, 0.0, 1.0);
}

@fragment
fn fs_avgblur_uv(in: VsOut) -> @location(0) vec4<f32> {
    let out = vec2<i32>(in.position.xy);
    var sum = vec2<f32>(0.0, 0.0);
    for (var dy = -3; dy <= 3; dy = dy + 1) {
        for (var dx = -3; dx <= 3; dx = dx + 1) {
            sum = sum + load(out + vec2<i32>(dx, dy)).xy;
        }
    }
    return vec4<f32>(sum.x / 49.0, sum.y / 49.0, 0.0, 1.0);
}
