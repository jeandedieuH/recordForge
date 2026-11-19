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
    // Canvas frame border (#11): x = rim width px, y = style id (0 solid,
    // 1 gradient, 2 double, 3 glass), z = opacity, w = gradient angle (radians).
    border: vec4<f32>,
    border_from: vec4<f32>,
    border_to: vec4<f32>,
    // Size of the decoded screen planes in px. Equal to the canvas unless a
    // zoom detail plane is active (#3), in which case the whole screen chain
    // decodes at detail resolution while the output stays canvas-sized.
    plane_size: vec4<f32>,
    // Motion blur (M2 #1): the zoom crop at the shutter's start, normalized
    // exactly like `crop`.
    blur_a: vec4<f32>,
    // The zoom crop at the shutter's end, normalized like `crop`.
    blur_b: vec4<f32>,
    // Zoom clarity (M2 #3): x = blur tap count (1 = off), y = RCAS sharpening
    // strength 0..1, z = 1 when `plane_size` is the source-resolution detail
    // plane (the frame is then upscaled from real source detail).
    detail: vec4<f32>,
    // Glass Loupe (#2): xy = lens centre in canvas px, z = radius px, w =
    // corner radius px (z <= 0.5 disables the lens).
    loupe_lens: vec4<f32>,
    // Magnified region in normalized content uv (same space as `crop`).
    loupe_target: vec4<f32>,
    // x = ring width px, y = ring opacity, rgb = ring colour.
    loupe_ring: vec4<f32>,
    loupe_ring_b: vec4<f32>,
    // x = presence 0..1, y = shadow blur px, z = shadow opacity, w = 1 when
    // the glass rim (refraction + inner highlight) is on.
    loupe_style: vec4<f32>,
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

// Coverage of the band `[lo, hi]` px inward from the frame edge, for a frame
// whose signed distance is `distance` (negative inside). Both edges are
// anti-aliased over one pixel.
fn border_band(distance: f32, lo: f32, hi: f32) -> f32 {
    let depth = -distance;
    return clamp(0.5 + depth - lo, 0.0, 1.0) * clamp(0.5 + hi - depth, 0.0, 1.0);
}

// Gradient ramp across the current screen rect. The angle runs clockwise from
// the top of the frame, matching the preview's SVG gradient and the compat
// plate painter.
fn border_ramp(canvas_px: vec2<f32>) -> vec3<f32> {
    let dir = vec2<f32>(sin(frame.border.w), -cos(frame.border.w));
    let local = (canvas_px - frame.dest_rect.xy) / max(frame.dest_rect.zw, vec2<f32>(1.0, 1.0));
    let t = clamp(dot(local - vec2<f32>(0.5, 0.5), dir) + 0.5, 0.0, 1.0);
    return mix(frame.border_from.rgb, frame.border_to.rgb, t);
}

// --- Zoom clarity: detail-plane sampling and RCAS-style sharpening ----------

// Normalized uv of the decoded plane for one crop and a content-local uv. The
// planes are `plane_size` px (the canvas, or the zoom detail plane when #3 is
// active) with the picture already fitted at `source_rect`.
fn plane_uv(crop: vec4<f32>, content_uv: vec2<f32>) -> vec2<f32> {
    let crop_uv = clamp(
        crop.xy + content_uv * crop.zw,
        vec2<f32>(0.0, 0.0),
        vec2<f32>(1.0, 1.0),
    );
    return (frame.source_rect.xy + crop_uv * frame.source_rect.zw) / frame.plane_size.xy;
}

fn read_uv(uv: vec2<f32>) -> vec2<f32> {
    let dims = vec2<i32>(textureDimensions(src_uv));
    return sample_bicubic(src_uv, uv, dims).rg * 255.0;
}

fn read_y(uv: vec2<f32>) -> f32 {
    let dims = vec2<i32>(textureDimensions(src_y));
    return sample_bicubic(src_y, uv, dims).r * 255.0;
}

// One nearest luma tap, offset from `uv` by whole texels.
fn luma_tap(uv: vec2<f32>, offset: vec2<i32>) -> f32 {
    let dims = vec2<i32>(textureDimensions(src_y));
    let coord = clamp(
        vec2<i32>(uv * vec2<f32>(dims)) + offset,
        vec2<i32>(0, 0),
        dims - vec2<i32>(1, 1),
    );
    return textureLoad(src_y, coord, 0).r * 255.0;
}

// RCAS-style contrast-adaptive sharpening (#3). The correction is limited by
// the local 4-neighbour contrast, so flat areas stay flat while text edges gain
// acutance when the zoom still has to upscale past the source (`m > r`).
// Strength 0 costs nothing.
fn sharpen_luma(y_byte: f32, uv: vec2<f32>, strength: f32) -> f32 {
    if (strength <= 0.0) {
        return y_byte;
    }
    let left = luma_tap(uv, vec2<i32>(-1, 0));
    let right = luma_tap(uv, vec2<i32>(1, 0));
    let up = luma_tap(uv, vec2<i32>(0, -1));
    let down = luma_tap(uv, vec2<i32>(0, 1));
    let average = (left + right + up + down) * 0.25;
    let delta = clamp((y_byte - average) * strength * 0.8, -14.0, 14.0);
    return clamp(y_byte + delta, 0.0, 255.0);
}

// One screen sample (BT.601 limited luma + chroma) for a crop rect.
fn sample_screen(crop: vec4<f32>, content_uv: vec2<f32>) -> vec4<f32> {
    let uv = plane_uv(crop, content_uv);
    return vec4<f32>(read_y(uv), read_uv(uv), 0.0);
}

// Hardware bilinear screen sample used by motion-blur shutter taps. Clamps UV
// to the interior texel centres of `source_rect` so padded canvases never
// bleed canvas padding into the edges of the blurred screen.
fn sample_screen_linear(crop: vec4<f32>, content_uv: vec2<f32>) -> vec4<f32> {
    let uv = plane_uv(crop, content_uv);
    let y_half = vec2<f32>(0.5, 0.5) / frame.plane_size.xy;
    let uv_half = vec2<f32>(1.0, 1.0) / frame.plane_size.xy;
    let rect_min = frame.source_rect.xy / frame.plane_size.xy;
    let rect_max = (frame.source_rect.xy + frame.source_rect.zw) / frame.plane_size.xy;
    let y_uv = clamp(uv, rect_min + y_half, max(rect_min + y_half, rect_max - y_half));
    let c_uv = clamp(uv, rect_min + uv_half, max(rect_min + uv_half, rect_max - uv_half));
    let y_byte = textureSampleLevel(src_y, src_sampler, y_uv, 0.0).r * 255.0;
    let uv_byte = textureSampleLevel(src_uv, src_sampler, c_uv, 0.0).rg * 255.0;
    return vec4<f32>(y_byte, uv_byte, 0.0);
}

// Signed distance to a rounded square lens of half-size `half` and corner
// radius `corner` (all px). `corner == half` is a circle.
fn lens_distance(point: vec2<f32>, half: f32, corner: f32) -> f32 {
    let inner = max(half - corner, 0.0);
    let q = abs(point) - vec2<f32>(inner, inner);
    return length(max(q, vec2<f32>(0.0, 0.0))) + min(max(q.x, q.y), 0.0) - corner;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
    let canvas_px = in.uv * frame.canvas_size.xy;
    let bg = canvas_background(canvas_px);

    // Timeline gaps (F2): no screen media covers this frame (b-roll over a hole),
    // so the canvas shows its background plate only; layers draw after this pass.
    if (frame.detail.w < 0.5) {
        return vec4<f32>(bg, 1.0);
    }

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

    // Content-local uv drives both the zoom crop and the shutter strip.
    let content_uv = local / frame.dest_rect.zw;

    // 1:1 fast path: an identity crop on a full-canvas content rect makes every
    // luma fragment its own texel, which is exactly what the bicubic taps
    // produce at frac 0. Chroma stays on the bicubic path (it is subsampled, so
    // the fragment sits between chroma texels by design). The detail plane and
    // the motion-blur strip never take it.
    let identity =
        frame.detail.z < 0.5 && frame.detail.x < 1.5 &&
        frame.crop.x == 0.0 && frame.crop.y == 0.0 &&
        frame.crop.z == 1.0 && frame.crop.w == 1.0 &&
        abs(frame.dest_rect.x) < 0.5 && abs(frame.dest_rect.y) < 0.5 &&
        abs(frame.dest_rect.z - frame.canvas_size.x) < 0.5 &&
        abs(frame.dest_rect.w - frame.canvas_size.y) < 0.5 &&
        abs(frame.source_rect.x - frame.dest_rect.x) < 0.5 &&
        abs(frame.source_rect.y - frame.dest_rect.y) < 0.5 &&
        abs(frame.source_rect.z - frame.dest_rect.z) < 0.5 &&
        abs(frame.source_rect.w - frame.dest_rect.w) < 0.5;

    var y_byte: f32;
    var uv_byte: vec2<f32>;
    let taps = max(1u, u32(frame.detail.x + 0.5));
    if (taps > 1u) {
        // Motion blur (M2 #1): integrate the screen along the continuous
        // shutter strip between `blur_a` and `blur_b` with tapered shutter
        // weights and hardware bilinear fetches.
        var y_sum = 0.0;
        var uv_sum = vec2<f32>(0.0, 0.0);
        var w_sum = 0.0;
        for (var tap = 0u; tap < taps; tap++) {
            let t = (f32(tap) + 0.5) / f32(taps);
            let w = 0.45 + 0.55 * sin(t * 3.14159265);
            let sample = sample_screen_linear(mix(frame.blur_a, frame.blur_b, t), content_uv);
            y_sum += sample.x * w;
            uv_sum += sample.yz * w;
            w_sum += w;
        }
        y_byte = y_sum / w_sum;
        uv_byte = uv_sum / w_sum;
    } else if (identity) {
        y_byte = textureLoad(src_y, vec2<i32>(canvas_px), 0).r * 255.0;
        let uv_dims = vec2<i32>(textureDimensions(src_uv));
        uv_byte = sample_bicubic(src_uv, plane_uv(frame.crop, content_uv), uv_dims).rg * 255.0;
    } else {
        let sample = sample_screen(frame.crop, content_uv);
        y_byte = sample.x;
        uv_byte = sample.yz;
    }

    // Skip RCAS sharpening while motion blur is active: comparing blurred luma
    // against unblurred single-instant neighbours creates dark/bright halos.
    if (taps <= 1u) {
        y_byte = sharpen_luma(y_byte, plane_uv(frame.crop, content_uv), frame.detail.y);
    }
    let screen = yuv_to_rgb(y_byte, uv_byte);
    var color = mix(bg, screen, coverage);

    // Canvas frame border: an analytic ring just inside the screen rect, so it
    // follows the side-by-side slot without a per-frame plate.
    let border_width = min(frame.border.x, min(half.x, half.y));
    if (border_width > 0.0) {
        let style = frame.border.y;
        let opacity = clamp(frame.border.z, 0.0, 1.0);
        if (style > 2.5) {
            // glass: translucent tint plus a bright inner highlight.
            let rim = clamp(border_band(distance, 0.0, border_width) * 0.35, 0.0, 1.0);
            let highlight = clamp(
                border_band(distance, border_width * 0.72, border_width) * 0.55,
                0.0,
                1.0,
            );
            color = mix(color, frame.border_from.rgb, rim * opacity * coverage);
            color = mix(color, vec3<f32>(1.0), highlight * opacity * coverage);
        } else {
            var ring: f32;
            var ring_color = frame.border_from.rgb;
            if (style > 1.5) {
                // double: two strokes with a gap between them.
                ring = border_band(distance, 0.0, border_width * 0.55)
                    + border_band(distance, border_width * 0.72, border_width);
            } else {
                ring = border_band(distance, 0.0, border_width);
                if (style > 0.5) {
                    ring_color = border_ramp(canvas_px);
                }
            }
            color = mix(color, ring_color, clamp(ring, 0.0, 1.0) * opacity * coverage);
        }
    }

    // Glass Loupe (#2): a lens over the composited frame that magnifies the
    // segment's target. Drawn here so the cursor (the next pass) stays above it.
    // A zero radius costs one comparison.
    let lens_radius = frame.loupe_lens.z;
    if (lens_radius > 0.5) {
        let present = clamp(frame.loupe_style.x, 0.0, 1.0);
        let lens_local = canvas_px - frame.loupe_lens.xy;
        let lens_sdf = lens_distance(lens_local, lens_radius, frame.loupe_lens.w);
        let inside = clamp(0.5 - lens_sdf, 0.0, 1.0);
        // Soft SDF drop shadow underneath the lens.
        let shadow_falloff = max(frame.loupe_style.y, 1.0);
        let shadow = exp(-max(lens_sdf, 0.0) / shadow_falloff)
            * clamp(frame.loupe_style.z, 0.0, 1.0)
            * (1.0 - inside)
            * present;
        color = mix(color, vec3<f32>(0.0), clamp(shadow, 0.0, 0.85));

        if (inside > 0.0) {
            let lens_uv = clamp(
                lens_local / (2.0 * lens_radius) + vec2<f32>(0.5, 0.5),
                vec2<f32>(0.0, 0.0),
                vec2<f32>(1.0, 1.0),
            );
            // SDF-based normalized rim distance: equals `length(lens_local)/r`
            // on circles and hugs all four edges + rounded corners evenly on
            // rounded-rect lenses (avoiding bright corner triangles).
            let radial = clamp(1.0 + lens_sdf / max(lens_radius, 1.0), 0.0, 1.0);
            let rim = smoothstep(0.82, 1.0, radial);
            let glass = frame.loupe_style.w > 0.5;
            // Rim refraction: pull the sample slightly inward near the edge so
            // the lens edge reads as curved glass rather than a flat crop.
            let refract = select(0.0, rim * -0.014, glass);
            let magnify_uv = clamp(
                lens_uv + (lens_uv - vec2<f32>(0.5, 0.5)) * refract,
                vec2<f32>(0.0, 0.0),
                vec2<f32>(1.0, 1.0),
            );
            let magnified = sample_screen(frame.loupe_target, magnify_uv);
            var lens_color = yuv_to_rgb(magnified.x, magnified.yz);
            let highlight = select(0.0, rim * 0.35, glass);
            lens_color = mix(lens_color, vec3<f32>(1.0), highlight);
            color = mix(color, lens_color, inside * present);
        }

        // Ring: an anti-aliased annulus just inside the lens edge (`depth` in
        // `[0, ring_width]` inward from `lens_sdf == 0`, matching canvas border).
        if (frame.loupe_ring.x > 0.0 && present > 0.0) {
            let ring_width = min(frame.loupe_ring.x, lens_radius);
            let band = border_band(lens_sdf, 0.0, ring_width);
            let ring_color = vec3<f32>(
                frame.loupe_ring.z,
                frame.loupe_ring.w,
                frame.loupe_ring_b.x,
            );
            color = mix(
                color,
                ring_color,
                clamp(band, 0.0, 1.0) * clamp(frame.loupe_ring.y, 0.0, 1.0) * present,
            );
        }
    }
    return vec4<f32>(color, 1.0);
}
