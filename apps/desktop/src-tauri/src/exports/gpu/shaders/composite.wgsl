// Canvas frame + screen plane → RGBA for one composited export frame.
//
// The screen plane arrives as NV12 (Y full resolution, interleaved UV at half
// resolution) — the format the FFmpeg decode sidecar emits — already scaled into
// the full content rect and padded out to the canvas. This shader paints the
// canvas background (a plate texture or a solid colour), then composites the
// *current* screen rect on top with an analytically anti-aliased rounded-corner
// mask. The current rect equals the full content rect except inside side-by-side
// layout windows, where the same decoded picture is drawn into the smaller slot
// (the compatibility graph's per-frame `eval=frame` scale).
//
// Colour conversion is BT.601 limited range, which is what swscale assumes for
// the untagged screen chain the compatibility renderer builds, so a GPU frame
// and an FFmpeg frame start from the same numbers.
//
// Sampling is Catmull-Rom bicubic over an *integer* crop rect supplied from
// `camera::zoompan_integer_crop`, matching the piecewise `crop`+`scale` path
// the compatibility renderer uses for held zoom.

struct FrameParams {
    // xy = canvas size in px.
    canvas_size: vec4<f32>,
    // xy = content-rect origin in canvas px, zw = content-rect size in px.
    dest_rect: vec4<f32>,
    // Zoom crop in normalized content uv (identity zoom is (0, 0, 1, 1)).
    crop: vec4<f32>,
    // rgb = solid background colour; a = 1 solid, 0 sample `background`.
    background: vec4<f32>,
    // x = corner radius in canvas px.
    corner: vec4<f32>,
    // xy = decoded source-rect origin in canvas px, zw = its size in px. The
    // decode pass always fits the screen into this rect; `dest_rect` is where
    // the current frame draws it.
    source_rect: vec4<f32>,
};

@group(0) @binding(0) var src_y: texture_2d<f32>;
@group(0) @binding(1) var src_uv: texture_2d<f32>;
@group(0) @binding(2) var src_sampler: sampler;
@group(0) @binding(3) var<uniform> frame: FrameParams;
@group(0) @binding(4) var background: texture_2d<f32>;

struct VsOut {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32) -> VsOut {
    // One oversized triangle covers the viewport with no vertex buffer.
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

// Catmull-Rom weights for the four taps around a fractional position.
fn cubic_weights(t: f32) -> vec4<f32> {
    let t2 = t * t;
    let t3 = t2 * t;
    return vec4<f32>(
        -0.5 * t3 + t2 - 0.5 * t,
        1.5 * t3 - 2.5 * t2 + 1.0,
        -1.5 * t3 + 2.0 * t2 + 0.5 * t,
        0.5 * t3 - 0.5 * t2,
    );
}

fn load_texel(tex: texture_2d<f32>, coord: vec2<i32>, dims: vec2<i32>) -> vec4<f32> {
    return textureLoad(tex, clamp(coord, vec2<i32>(0, 0), dims - vec2<i32>(1, 1)), 0);
}

fn bc_row(
    tex: texture_2d<f32>,
    row: i32,
    col: i32,
    weights: vec4<f32>,
    dims: vec2<i32>,
) -> vec4<f32> {
    let c0 = load_texel(tex, vec2<i32>(col, row), dims);
    let c1 = load_texel(tex, vec2<i32>(col + 1, row), dims);
    let c2 = load_texel(tex, vec2<i32>(col + 2, row), dims);
    let c3 = load_texel(tex, vec2<i32>(col + 3, row), dims);
    return c0 * weights.x + c1 * weights.y + c2 * weights.z + c3 * weights.w;
}

// Bicubic sample at normalized `uv`. `dims` is the plane's texel size, so the
// same `uv` addresses the same picture region on both NV12 planes.
fn sample_bicubic(tex: texture_2d<f32>, uv: vec2<f32>, dims: vec2<i32>) -> vec4<f32> {
    let pos = uv * vec2<f32>(f32(dims.x), f32(dims.y)) - vec2<f32>(0.5, 0.5);
    let base = floor(pos);
    let frac = pos - base;
    // Catmull-Rom taps sit at base-1 .. base+2, so the first tap is one texel
    // before the floor. Omitting the -1 shifts the whole picture by one texel.
    let col = i32(base.x) - 1;
    let row = i32(base.y) - 1;
    let wx = cubic_weights(frac.x);
    let wy = cubic_weights(frac.y);
    let r0 = bc_row(tex, row, col, wx, dims);
    let r1 = bc_row(tex, row + 1, col, wx, dims);
    let r2 = bc_row(tex, row + 2, col, wx, dims);
    let r3 = bc_row(tex, row + 3, col, wx, dims);
    return r0 * wy.x + r1 * wy.y + r2 * wy.z + r3 * wy.w;
}

fn yuv_to_rgb(y_byte: f32, uv_byte: vec2<f32>) -> vec3<f32> {
    let luma = (y_byte - 16.0) / 219.0;
    let cb = (uv_byte.x - 128.0) / 224.0;
    let cr = (uv_byte.y - 128.0) / 224.0;
    let r = luma + 1.402 * cr;
    let g = luma - 0.344136 * cb - 0.714136 * cr;
    let b = luma + 1.772 * cb;
    return clamp(vec3<f32>(r, g, b), vec3<f32>(0.0), vec3<f32>(1.0));
}

fn canvas_background(px: vec2<f32>) -> vec3<f32> {
    if (frame.background.a > 0.5) {
        return frame.background.rgb;
    }
    // The plate is generated at exactly canvas size, so a texel load is the
    // 1:1 sample: no filtering, no half-texel drift on gradients.
    return textureLoad(background, vec2<i32>(px), 0).rgb;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
    let canvas_px = in.uv * frame.canvas_size.xy;
    let bg = canvas_background(canvas_px);

    // Signed distance to the content rect, in canvas pixels. Pixel centres sit
    // at +0.5, so a rect that covers the whole canvas stays fully inside.
    let local = canvas_px - frame.dest_rect.xy;
    let half = frame.dest_rect.zw * 0.5;
    let radius = clamp(frame.corner.x, 0.0, min(half.x, half.y));
    let q = abs(local - half) - (half - vec2<f32>(radius, radius));
    let distance = length(max(q, vec2<f32>(0.0, 0.0))) + min(max(q.x, q.y), 0.0) - radius;
    let coverage = clamp(0.5 - distance, 0.0, 1.0);
    if (coverage <= 0.0) {
        return vec4<f32>(bg, 1.0);
    }

    // Content-local uv, then the zoom crop inside the *decoded* content rect,
    // mapped back into canvas uv. The decoded planes are canvas-sized with the
    // picture already fitted at `source_rect`, so the crop space is the source
    // rect — never the current (possibly smaller side-by-side) destination.
    let content_uv = local / frame.dest_rect.zw;
    let crop_uv = clamp(
        frame.crop.xy + content_uv * frame.crop.zw,
        vec2<f32>(0.0, 0.0),
        vec2<f32>(1.0, 1.0),
    );
    let sample_uv =
        (frame.source_rect.xy + crop_uv * frame.source_rect.zw) / frame.canvas_size.xy;

    // 1:1 fast path: an identity crop on a full-canvas content rect makes every
    // luma fragment its own texel, which is exactly what the bicubic taps
    // produce at frac 0. Chroma stays on the bicubic path (it is subsampled, so
    // the fragment sits between chroma texels by design).
    let identity =
        frame.crop.x == 0.0 && frame.crop.y == 0.0 &&
        frame.crop.z == 1.0 && frame.crop.w == 1.0 &&
        abs(frame.dest_rect.x) < 0.5 && abs(frame.dest_rect.y) < 0.5 &&
        abs(frame.dest_rect.z - frame.canvas_size.x) < 0.5 &&
        abs(frame.dest_rect.w - frame.canvas_size.y) < 0.5 &&
        abs(frame.source_rect.x - frame.dest_rect.x) < 0.5 &&
        abs(frame.source_rect.y - frame.dest_rect.y) < 0.5 &&
        abs(frame.source_rect.z - frame.dest_rect.z) < 0.5 &&
        abs(frame.source_rect.w - frame.dest_rect.w) < 0.5;

    let uv_dims = vec2<i32>(textureDimensions(src_uv));
    let uv_byte = sample_bicubic(src_uv, sample_uv, uv_dims).rg * 255.0;
    var y_byte: f32;
    if (identity) {
        y_byte = textureLoad(src_y, vec2<i32>(canvas_px), 0).r * 255.0;
    } else {
        let y_dims = vec2<i32>(textureDimensions(src_y));
        y_byte = sample_bicubic(src_y, sample_uv, y_dims).r * 255.0;
    }
    let screen = yuv_to_rgb(y_byte, uv_byte);
    return vec4<f32>(mix(bg, screen, coverage), 1.0);
}
