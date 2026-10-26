// One RGBA layer composited over the canvas stage.
//
// The same pipeline draws every generated overlay plane (cursor tile, overlay
// items, keystroke badges), the camera bubble and its border/shadow plates. A
// single fullscreen triangle evaluates the layer rect analytically: the
// fragment shader discards outside the rect, applies the shape coverage, then
// blends premultiplied src-over.
//
// Formats:
//   - 0: NV12 (camera) — separate Y and interleaved UV planes.
//   - 1: YUVA420p (generated plates) — Y, UV and full-resolution alpha, exactly
//     the layout `cursor::rgba_to_yuva420p` produces for the FFmpeg plate feed.
//   - 2: RGBA8 (border/shadow PNGs).

struct LayerParams {
    // xy = canvas size in px.
    canvas_size: vec4<f32>,
    // xy = layer origin in canvas px, zw = layer size in px.
    dest_rect: vec4<f32>,
    // x = shape kind (0 rectangle, 1 circle/ellipse, 2 rounded rect),
    // y = corner radius in px.
    shape: vec4<f32>,
    // x = opacity, y = format id.
    opacity: vec4<f32>,
};

@group(0) @binding(0) var layer0: texture_2d<f32>;
@group(0) @binding(1) var layer1: texture_2d<f32>;
@group(0) @binding(2) var layer2: texture_2d<f32>;
@group(0) @binding(3) var layer_sampler: sampler;
@group(0) @binding(4) var<uniform> params: LayerParams;

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

fn rounded_rect_distance(p: vec2<f32>, half: vec2<f32>, radius: f32) -> f32 {
    let r = clamp(radius, 0.0, min(half.x, half.y));
    let q = abs(p) - (half - vec2<f32>(r, r));
    return length(max(q, vec2<f32>(0.0, 0.0))) + min(max(q.x, q.y), 0.0) - r;
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

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
    let canvas_px = in.uv * params.canvas_size.xy;
    let local = canvas_px - params.dest_rect.xy;
    let half = params.dest_rect.zw * 0.5;
    let kind = params.shape.x;

    var coverage: f32;
    if (kind < 0.5) {
        // Hard-edged rectangle: the plate already carries anti-aliased alpha,
        // and the camera bubble's mask is produced by the shape kinds below.
        if (local.x < 0.0 || local.y < 0.0 || local.x > params.dest_rect.z || local.y > params.dest_rect.w) {
            discard;
        }
        coverage = 1.0;
    } else if (kind < 1.5) {
        // Ellipse inscribed in the rect (the camera "circle" shape).
        let p = (local - half) / max(half, vec2<f32>(0.5, 0.5));
        let distance = (length(p) - 1.0) * min(half.x, half.y);
        coverage = clamp(0.5 - distance, 0.0, 1.0);
        if (coverage <= 0.0) {
            discard;
        }
    } else {
        let distance = rounded_rect_distance(local - half, half, params.shape.y);
        coverage = clamp(0.5 - distance, 0.0, 1.0);
        if (coverage <= 0.0) {
            discard;
        }
    }

    let uv = vec2<f32>(local.x / params.dest_rect.z, local.y / params.dest_rect.w);
    let format_id = params.opacity.y;
    var color: vec3<f32>;
    var alpha: f32;
    if (format_id < 0.5) {
        let y_byte = textureSampleLevel(layer0, layer_sampler, uv, 0.0).r * 255.0;
        let uv_byte = textureSampleLevel(layer1, layer_sampler, uv, 0.0).rg * 255.0;
        color = yuv_to_rgb(y_byte, uv_byte);
        alpha = 1.0;
    } else if (format_id < 1.5) {
        let y_byte = textureSampleLevel(layer0, layer_sampler, uv, 0.0).r * 255.0;
        let uv_byte = textureSampleLevel(layer1, layer_sampler, uv, 0.0).rg * 255.0;
        color = yuv_to_rgb(y_byte, uv_byte);
        alpha = textureSampleLevel(layer2, layer_sampler, uv, 0.0).r;
    } else {
        let rgba = textureSampleLevel(layer0, layer_sampler, uv, 0.0);
        color = rgba.rgb;
        alpha = rgba.a;
    }

    alpha = alpha * coverage * params.opacity.x;
    if (alpha <= 0.0) {
        discard;
    }
    // Premultiplied source-over.
    return vec4<f32>(color * alpha, alpha);
}
