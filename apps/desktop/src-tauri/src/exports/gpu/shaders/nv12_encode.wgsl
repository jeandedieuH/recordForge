// RGBA → NV12 compute pass.
//
// Each invocation owns four horizontally adjacent RGB pixels. Four luma bytes
// pack into one `u32` of the output storage buffer, and invocations on even
// rows/columns additionally own the 2×1 chroma pair that covers their 4×2 luma
// block. The buffer layout is therefore byte-for-byte NV12 (Y plane first, then
// interleaved UV at half resolution) and feeds the encode sidecar's stdin
// without a further copy or colour conversion.

struct Params {
    width: u32,
    height: u32,
    // Words per row of the Y plane (width / 4).
    y_words_per_row: u32,
    // First word of the UV plane (width * height / 4).
    uv_word_offset: u32,
};

@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> out: array<u32>;
@group(0) @binding(2) var<uniform> params: Params;

const KR: f32 = 0.299;
const KG: f32 = 0.587;
const KB: f32 = 0.114;

fn luma_byte(rgb: vec3<f32>) -> u32 {
    let y_prime = KR * rgb.x + KG * rgb.y + KB * rgb.z;
    let value = clamp(16.0 + 219.0 * y_prime, 16.0, 235.0);
    return u32(round(value));
}

fn chroma_bytes(sum: vec3<f32>, samples: f32) -> vec2<u32> {
    let rgb = sum / samples;
    let y_prime = KR * rgb.x + KG * rgb.y + KB * rgb.z;
    // Cb/Cr are the blue/red *colour differences* normalized by 2(1-Kb)/2(1-Kr).
    // Dropping the Kb/Kr term of the difference is a common hand-rolled-matrix
    // bug that leaves luma correct while shifting every chroma sample.
    let cb = (rgb.z - y_prime) / (2.0 * (1.0 - KB));
    let cr = (rgb.x - y_prime) / (2.0 * (1.0 - KR));
    let u = clamp(128.0 + 224.0 * cb, 16.0, 240.0);
    let v = clamp(128.0 + 224.0 * cr, 16.0, 240.0);
    return vec2<u32>(u32(round(u)), u32(round(v)));
}

fn load_rgb(x: u32, y: u32) -> vec3<f32> {
    return textureLoad(src, vec2<i32>(i32(x), i32(y)), 0).xyz;
}

@compute @workgroup_size(16, 16, 1)
fn cs_main(@builtin(global_invocation_id) id: vec3<u32>) {
    let px = id.x * 4u;
    if (px >= params.width || id.y >= params.height) {
        return;
    }

    let y0 = luma_byte(load_rgb(px, id.y));
    let y1 = luma_byte(load_rgb(px + 1u, id.y));
    let y2 = luma_byte(load_rgb(px + 2u, id.y));
    let y3 = luma_byte(load_rgb(px + 3u, id.y));
    out[id.y * params.y_words_per_row + id.x] = y0 | (y1 << 8u) | (y2 << 16u) | (y3 << 24u);

    // Chroma rows subsample 2×2 luma blocks. One invocation covers four luma
    // columns, which is exactly two chroma columns — i.e. one packed `u32` of
    // the UV plane — so every invocation on an even row owns one word, at the
    // same index as its luma word. Gating on `id.x` being even left half the
    // chroma row unwritten and stretched the rest over it.
    if ((id.y & 1u) == 0u) {
        let row = id.y + 1u;
        var left = load_rgb(px, id.y) + load_rgb(px + 1u, id.y);
        var right = load_rgb(px + 2u, id.y) + load_rgb(px + 3u, id.y);
        if (row < params.height) {
            left = left + load_rgb(px, row) + load_rgb(px + 1u, row);
            right = right + load_rgb(px + 2u, row) + load_rgb(px + 3u, row);
        }
        let uv0 = chroma_bytes(left, 4.0);
        let uv1 = chroma_bytes(right, 4.0);
        out[params.uv_word_offset + (id.y / 2u) * params.y_words_per_row + id.x] =
            uv0.x | (uv0.y << 8u) | (uv1.x << 16u) | (uv1.y << 24u);
    }
}
