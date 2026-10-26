// Privacy-mask pass.
//
// Reads the composed canvas stage, writes the same raster with one mask applied
// inside its rect. The compatibility renderer implements the same modes with
// FFmpeg filters: `redact` fills a box, `blur` downsamples + averages + upsamples,
// and `pixelate` downsamples with nearest-neighbour. The shader reproduces each
// result from the stage texture so no extra copy is needed.
//
// A mask pass writes every pixel (outside the rect it passes the source
// through), so the destination stage never needs a clear.

struct MaskParams {
    // xy = rect origin, zw = rect size, canvas px.
    rect: vec4<f32>,
    // rgb = redact colour.
    color: vec4<f32>,
    // x = mode (0 redact, 1 blur, 2 pixelate), y = blur factor / pixel size.
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

    let factor = max(mask.params.y, 1.0);
    if (mode < 1.5) {
        // Blur approximation of downscale → 3×3 average → bilinear upscale:
        // nine bilinear taps spaced `factor` apart cover the same support.
        var sum = vec3<f32>(0.0, 0.0, 0.0);
        for (var j = -1; j <= 1; j = j + 1) {
            for (var i = -1; i <= 1; i = i + 1) {
                var tap = px + vec2<f32>(f32(i), f32(j)) * factor;
                tap = clamp(
                    tap,
                    rect.xy + vec2<f32>(0.5, 0.5),
                    rect.xy + rect.zw - vec2<f32>(0.5, 0.5),
                );
                sum = sum + textureSampleLevel(src, src_sampler, tap / dims, 0.0).rgb;
            }
        }
        return vec4<f32>(sum / 9.0, 1.0);
    }

    // Pixelate: nearest sample at the centre of the block.
    let rel = (px - rect.xy) / factor;
    let centre = rect.xy + (floor(rel) + vec2<f32>(0.5, 0.5)) * factor;
    return vec4<f32>(load_px(centre), 1.0);
}
