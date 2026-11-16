//! Camera colour grade (#4a) — the single source of truth for LUT composition.
//!
//! Adjustments, an optional 3D LUT and the LUT intensity are baked into one
//! 33³ table. Export writes that table as a `.cube` and feeds it to FFmpeg's
//! `lut3d=interp=tetrahedral` in the camera decode chain; the preview asks the
//! same code (compiled to WASM) for the same table and uploads it as a WebGL2
//! 3D texture. There is no second implementation to drift.
//!
//! Bundled looks are procedural: generating them avoids shipping 7 binary
//! `.cube` files while keeping every look reproducible and testable.

use std::fmt::Write as _;

use serde::{Deserialize, Serialize};

pub const LUT_SIZE: u32 = 33;
/// FFmpeg's camera chain accepts at most 65³; imported cubes larger than this
/// are resampled to 33³ so export cost stays bounded.
pub const MAX_CUBE_SIZE: u32 = 65;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraColorRequest {
    #[serde(default)]
    pub exposure: f32,
    #[serde(default)]
    pub contrast: f32,
    #[serde(default)]
    pub saturation: f32,
    #[serde(default)]
    pub temperature: f32,
    #[serde(default)]
    pub tint: f32,
    /// Bundled `look:*` id. Ignored when `cube_text` is present.
    #[serde(default)]
    pub lut_id: Option<String>,
    #[serde(default = "default_intensity")]
    pub lut_intensity: f32,
    /// Raw `.cube` text for a user-imported LUT (already validated once at
    /// import time; parsed again here for the composed table).
    #[serde(default)]
    pub cube_text: Option<String>,
}

fn default_intensity() -> f32 {
    1.0
}

impl CameraColorRequest {
    pub fn is_neutral(&self) -> bool {
        self.cube_text.is_none()
            && self.lut_id.is_none()
            && self.exposure.abs() < 1e-4
            && self.contrast.abs() < 1e-4
            && self.saturation.abs() < 1e-4
            && self.temperature.abs() < 1e-4
            && self.tint.abs() < 1e-4
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Lut3d {
    size: u32,
    /// Indexed `b * size² + g * size + r`.
    data: Vec<[f32; 3]>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CubeError(pub String);

impl std::fmt::Display for CubeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for CubeError {}

impl Lut3d {
    pub fn identity(size: u32) -> Self {
        let size = size.clamp(2, MAX_CUBE_SIZE);
        let mut data = Vec::with_capacity((size * size * size) as usize);
        let denom = (size - 1) as f32;
        for b in 0..size {
            for g in 0..size {
                for r in 0..size {
                    data.push([r as f32 / denom, g as f32 / denom, b as f32 / denom]);
                }
            }
        }
        Self { size, data }
    }

    pub fn from_fn(size: u32, mut f: impl FnMut([f32; 3]) -> [f32; 3]) -> Self {
        let identity = Self::identity(size);
        let data = identity.data.iter().map(|rgb| clamp_rgb(f(*rgb))).collect();
        Self {
            size: identity.size,
            data,
        }
    }

    pub fn size(&self) -> u32 {
        self.size
    }

    pub fn data(&self) -> &[[f32; 3]] {
        &self.data
    }

    fn index(&self, r: u32, g: u32, b: u32) -> usize {
        ((b * self.size + g) * self.size + r) as usize
    }

    /// Trilinear sample (matches what `lut3d` does with `interp=trilinear`).
    pub fn sample(&self, rgb: [f32; 3]) -> [f32; 3] {
        let max = (self.size - 1) as f32;
        let coord = |v: f32| (v.clamp(0.0, 1.0) * max).min(max);
        let (rf, gf, bf) = (coord(rgb[0]), coord(rgb[1]), coord(rgb[2]));
        let r0 = rf.floor() as u32;
        let g0 = gf.floor() as u32;
        let b0 = bf.floor() as u32;
        let r1 = (r0 + 1).min(self.size - 1);
        let g1 = (g0 + 1).min(self.size - 1);
        let b1 = (b0 + 1).min(self.size - 1);
        let (dr, dg, db) = (rf - r0 as f32, gf - g0 as f32, bf - b0 as f32);

        let at = |r: u32, g: u32, b: u32| self.data[self.index(r, g, b)];
        let lerp = |a: [f32; 3], b: [f32; 3], t: f32| {
            [
                a[0] + (b[0] - a[0]) * t,
                a[1] + (b[1] - a[1]) * t,
                a[2] + (b[2] - a[2]) * t,
            ]
        };
        let c00 = lerp(at(r0, g0, b0), at(r1, g0, b0), dr);
        let c10 = lerp(at(r0, g1, b0), at(r1, g1, b0), dr);
        let c01 = lerp(at(r0, g0, b1), at(r1, g0, b1), dr);
        let c11 = lerp(at(r0, g1, b1), at(r1, g1, b1), dr);
        let c0 = lerp(c00, c10, dg);
        let c1 = lerp(c01, c11, dg);
        clamp_rgb(lerp(c0, c1, db))
    }

    /// Standard Resolve-style `.cube` body (`LUT_3D_SIZE` + one RGB triple per
    /// line, red varying fastest).
    pub fn to_cube_string(&self, title: &str) -> String {
        let mut out = String::with_capacity((self.data.len() * 22) + 80);
        let _ = writeln!(out, "TITLE \"{}\"", title.replace('"', "'"));
        let _ = writeln!(out, "LUT_3D_SIZE {}", self.size);
        for rgb in &self.data {
            let _ = writeln!(
                out,
                "{:.6} {:.6} {:.6}",
                rgb[0].clamp(0.0, 1.0),
                rgb[1].clamp(0.0, 1.0),
                rgb[2].clamp(0.0, 1.0)
            );
        }
        out
    }

    /// RGBA8 texture bytes for WebGL2 (`RGB` is not universally filterable).
    pub fn to_rgba8(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(self.data.len() * 4);
        for rgb in &self.data {
            out.push((rgb[0].clamp(0.0, 1.0) * 255.0).round() as u8);
            out.push((rgb[1].clamp(0.0, 1.0) * 255.0).round() as u8);
            out.push((rgb[2].clamp(0.0, 1.0) * 255.0).round() as u8);
            out.push(255);
        }
        out
    }

    /// Parse a `.cube` file. Values must be finite; out-of-range values are
    /// rejected rather than silently clamped so a broken LUT never ships.
    pub fn parse_cube(text: &str) -> Result<Self, CubeError> {
        let mut size: Option<u32> = None;
        let mut values: Vec<[f32; 3]> = Vec::new();
        let mut in_data = false;

        for (line_no, raw) in text.lines().enumerate() {
            let line = raw.split('#').next().unwrap_or("").trim();
            if line.is_empty() {
                continue;
            }
            let upper = line.to_ascii_uppercase();
            if upper.starts_with("TITLE") || upper.starts_with("LUT_1D") {
                if upper.starts_with("LUT_1D") {
                    return Err(CubeError(format!(
                        "line {}: 1D LUTs are not supported",
                        line_no + 1
                    )));
                }
                continue;
            }
            if upper.starts_with("LUT_3D_SIZE") {
                let value = line.split_whitespace().nth(1).ok_or_else(|| {
                    CubeError(format!("line {}: missing LUT_3D_SIZE", line_no + 1))
                })?;
                let parsed: u32 = value
                    .parse()
                    .map_err(|_| CubeError(format!("line {}: invalid LUT_3D_SIZE", line_no + 1)))?;
                if !(2..=MAX_CUBE_SIZE).contains(&parsed) {
                    return Err(CubeError(format!(
                        "line {}: LUT_3D_SIZE must be 2..={MAX_CUBE_SIZE}",
                        line_no + 1
                    )));
                }
                if size.is_some() {
                    return Err(CubeError(format!(
                        "line {}: duplicate LUT_3D_SIZE",
                        line_no + 1
                    )));
                }
                size = Some(parsed);
                in_data = true;
                continue;
            }
            if upper.starts_with("DOMAIN_MIN")
                || upper.starts_with("DOMAIN_MAX")
                || upper.starts_with("LUT_3D_INPUT_RANGE")
            {
                // Accepted and ignored: values are already normalised to 0..1.
                continue;
            }
            if !in_data {
                continue;
            }
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() != 3 {
                return Err(CubeError(format!(
                    "line {}: expected 3 values, found {}",
                    line_no + 1,
                    parts.len()
                )));
            }
            let mut rgb = [0.0_f32; 3];
            for (index, part) in parts.iter().enumerate() {
                let value: f32 = part
                    .parse()
                    .map_err(|_| CubeError(format!("line {}: invalid number", line_no + 1)))?;
                if !value.is_finite() || !(0.0..=1.0).contains(&value) {
                    return Err(CubeError(format!(
                        "line {}: values must be finite and within 0..1",
                        line_no + 1
                    )));
                }
                rgb[index] = value;
            }
            values.push(rgb);
        }

        let size = size.ok_or_else(|| CubeError("missing LUT_3D_SIZE".into()))?;
        let expected = (size * size * size) as usize;
        if values.len() != expected {
            return Err(CubeError(format!(
                "expected {expected} entries for size {size}, found {}",
                values.len()
            )));
        }
        let lut = Self { size, data: values };
        if size == LUT_SIZE {
            Ok(lut)
        } else {
            // Bake imported sizes into the fixed 33³ table so the export path
            // has one code path and one texture size.
            let mut resampled = Vec::with_capacity((LUT_SIZE * LUT_SIZE * LUT_SIZE) as usize);
            let denom = (LUT_SIZE - 1) as f32;
            for b in 0..LUT_SIZE {
                for g in 0..LUT_SIZE {
                    for r in 0..LUT_SIZE {
                        resampled.push(lut.sample([
                            r as f32 / denom,
                            g as f32 / denom,
                            b as f32 / denom,
                        ]));
                    }
                }
            }
            Ok(Self {
                size: LUT_SIZE,
                data: resampled,
            })
        }
    }
}

fn clamp_rgb(rgb: [f32; 3]) -> [f32; 3] {
    [
        rgb[0].clamp(0.0, 1.0),
        rgb[1].clamp(0.0, 1.0),
        rgb[2].clamp(0.0, 1.0),
    ]
}

fn luma(rgb: [f32; 3]) -> f32 {
    0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]
}

fn smoothstep(edge0: f32, edge1: f32, x: f32) -> f32 {
    let t = ((x - edge0) / (edge1 - edge0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// A procedural bundled look evaluated per grid point. All looks are
/// deterministic and licence-free (no photographic LUT was copied).
pub fn bundled_look(id: &str) -> Option<Lut3d> {
    let id = id.strip_prefix("look:").unwrap_or(id);
    let lut = match id {
        "warm" => Lut3d::from_fn(LUT_SIZE, |[r, g, b]| {
            let l = luma([r, g, b]);
            [
                r * 1.08 + 0.03 * l,
                g * 1.015 + 0.008 * l,
                b * 0.9 + 0.01 * l,
            ]
        }),
        "cool" => Lut3d::from_fn(LUT_SIZE, |[r, g, b]| {
            let l = luma([r, g, b]);
            [r * 0.9 + 0.01 * l, g * 1.0, b * 1.1 + 0.03 * l]
        }),
        "film" => Lut3d::from_fn(LUT_SIZE, |[r, g, b]| {
            let l = luma([r, g, b]);
            let curve = |v: f32| {
                // Lifted blacks + rolled highlights.
                let s = v * v * (3.0 - 2.0 * v);
                0.035 + s * 0.93
            };
            let desat = 0.82;
            let mapped = [curve(r), curve(g), curve(b)];
            let m = luma(mapped);
            [
                m + (mapped[0] - m) * desat + 0.012,
                m + (mapped[1] - m) * desat + 0.018 * l,
                m + (mapped[2] - m) * desat,
            ]
        }),
        "teal-orange" => Lut3d::from_fn(LUT_SIZE, |[r, g, b]| {
            let l = luma([r, g, b]);
            let shadows = 1.0 - smoothstep(0.0, 0.55, l);
            let highlights = smoothstep(0.45, 1.0, l);
            [
                r + highlights * 0.08 - shadows * 0.02,
                g + shadows * 0.035 - highlights * 0.015,
                b + shadows * 0.10 - highlights * 0.055,
            ]
        }),
        "mono" => Lut3d::from_fn(LUT_SIZE, |[r, g, b]| {
            let l = luma([r, g, b]);
            let curved = (l - 0.5) * 1.08 + 0.5;
            [curved, curved, curved]
        }),
        "vivid" => Lut3d::from_fn(LUT_SIZE, |[r, g, b]| {
            let l = luma([r, g, b]);
            let sat = 1.38;
            let mut out = [l + (r - l) * sat, l + (g - l) * sat, l + (b - l) * sat];
            for value in &mut out {
                *value = (*value - 0.5) * 1.12 + 0.5;
            }
            out
        }),
        "matte" => Lut3d::from_fn(LUT_SIZE, |[r, g, b]| {
            let l = luma([r, g, b]);
            let sat = 0.82;
            let lift = 0.06;
            let roll = 0.92;
            let map = |v: f32| lift + (l + (v - l) * sat) * roll;
            [map(r), map(g), map(b)]
        }),
        _ => return None,
    };
    Some(lut)
}

/// Apply the slider adjustments in display space (sRGB); applied after the LUT
/// is sampled so "LUT strength" never changes the adjustment response.
pub fn apply_adjustments(rgb: [f32; 3], request: &CameraColorRequest) -> [f32; 3] {
    let exposure = (2.0_f32).powf(request.exposure.clamp(-2.0, 2.0));
    let mut out = [rgb[0] * exposure, rgb[1] * exposure, rgb[2] * exposure];

    let contrast = 1.0 + request.contrast.clamp(-1.0, 1.0);
    for value in &mut out {
        *value = (*value - 0.5) * contrast + 0.5;
    }

    let l = luma(out);
    let saturation = 1.0 + request.saturation.clamp(-1.0, 1.0);
    for value in &mut out {
        *value = l + (*value - l) * saturation;
    }

    let temperature = request.temperature.clamp(-1.0, 1.0);
    let tint = request.tint.clamp(-1.0, 1.0);
    out[0] += temperature * 0.12 + tint * 0.04;
    out[1] -= tint * 0.10;
    out[2] -= temperature * 0.12 - tint * 0.04;
    clamp_rgb(out)
}

/// Compose adjustments + base LUT + intensity into the final 33³ table.
pub fn compose_camera_lut(request: &CameraColorRequest) -> Result<Lut3d, CubeError> {
    let base = if let Some(text) = request.cube_text.as_deref() {
        Lut3d::parse_cube(text)?
    } else if let Some(id) = request.lut_id.as_deref() {
        bundled_look(id).unwrap_or_else(|| Lut3d::identity(LUT_SIZE))
    } else {
        Lut3d::identity(LUT_SIZE)
    };
    let intensity = request.lut_intensity.clamp(0.0, 1.0);
    let identity = Lut3d::identity(LUT_SIZE);
    let mut data = Vec::with_capacity((LUT_SIZE * LUT_SIZE * LUT_SIZE) as usize);
    for (index, input) in identity.data().iter().enumerate() {
        let lut_rgb = base.data().get(index).copied().unwrap_or(*input);
        let mixed = [
            input[0] + (lut_rgb[0] - input[0]) * intensity,
            input[1] + (lut_rgb[1] - input[1]) * intensity,
            input[2] + (lut_rgb[2] - input[2]) * intensity,
        ];
        data.push(clamp_rgb(apply_adjustments(mixed, request)));
    }
    Ok(Lut3d {
        size: LUT_SIZE,
        data,
    })
}

/// The `.cube` FFmpeg consumes. Title is bounded and quote-safe.
pub fn camera_lut_cube(request: &CameraColorRequest) -> Result<String, CubeError> {
    Ok(compose_camera_lut(request)?.to_cube_string("RecordForge Camera"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn neutral() -> CameraColorRequest {
        CameraColorRequest {
            exposure: 0.0,
            contrast: 0.0,
            saturation: 0.0,
            temperature: 0.0,
            tint: 0.0,
            lut_id: None,
            lut_intensity: 1.0,
            cube_text: None,
        }
    }

    #[test]
    fn neutral_composition_is_identity() {
        let lut = compose_camera_lut(&neutral()).unwrap();
        let identity = Lut3d::identity(LUT_SIZE);
        for (a, b) in lut.data().iter().zip(identity.data()) {
            assert!((a[0] - b[0]).abs() < 1e-6);
            assert!((a[1] - b[1]).abs() < 1e-6);
            assert!((a[2] - b[2]).abs() < 1e-6);
        }
        assert!(neutral().is_neutral());
    }

    #[test]
    fn exposure_scales_and_intensity_blends_the_lut() {
        let mut request = neutral();
        request.exposure = 1.0;
        let lut = compose_camera_lut(&request).unwrap();
        assert!(lut.sample([0.25, 0.25, 0.25])[0] > 0.45);
        request.exposure = 0.0;
        request.lut_id = Some("look:mono".into());
        request.lut_intensity = 0.0;
        let neutral_lut = compose_camera_lut(&request).unwrap();
        let sampled = neutral_lut.sample([0.9, 0.15, 0.2]);
        assert!((sampled[0] - 0.9).abs() < 0.03);
        assert!((sampled[1] - 0.15).abs() < 0.03);
    }

    #[test]
    fn every_bundled_look_is_procedural_and_stable() {
        for id in [
            "look:warm",
            "look:cool",
            "look:film",
            "look:teal-orange",
            "look:mono",
            "look:vivid",
            "look:matte",
        ] {
            let lut = bundled_look(id).expect("bundled look");
            assert_eq!(lut.size(), LUT_SIZE);
            assert!(lut
                .data()
                .iter()
                .all(|rgb| rgb.iter().all(|v| v.is_finite() && (0.0..=1.0).contains(v))));
        }
        assert!(bundled_look("look:missing").is_none());
    }

    #[test]
    fn cube_round_trips_through_parser() {
        let mut request = neutral();
        request.lut_id = Some("look:vivid".into());
        let cube = camera_lut_cube(&request).unwrap();
        let parsed = Lut3d::parse_cube(&cube).unwrap();
        assert_eq!(parsed.size(), LUT_SIZE);
        let original = compose_camera_lut(&request).unwrap();
        for (a, b) in parsed.data().iter().zip(original.data()) {
            assert!((a[0] - b[0]).abs() < 1e-5);
            assert!((a[1] - b[1]).abs() < 1e-5);
            assert!((a[2] - b[2]).abs() < 1e-5);
        }
    }

    #[test]
    fn cube_parser_rejects_bad_input() {
        assert!(Lut3d::parse_cube("LUT_3D_SIZE 2\n0 0\n").is_err());
        assert!(Lut3d::parse_cube("LUT_3D_SIZE 1\n0 0 0\n").is_err());
        assert!(Lut3d::parse_cube("LUT_3D_SIZE 2\n0 0 NaN\n").is_err());
        assert!(Lut3d::parse_cube("LUT_3D_SIZE 2\n0 0 2\n").is_err());
        assert!(Lut3d::parse_cube("LUT_1D_SIZE 2\n0\n").is_err());
        // Size 2 needs 8 entries.
        assert!(Lut3d::parse_cube(
            "LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n"
        )
        .is_ok());
    }

    #[test]
    fn imported_size_is_resampled_to_33() {
        let mut lines = String::from("LUT_3D_SIZE 3\n");
        for b in 0..3 {
            for g in 0..3 {
                for r in 0..3 {
                    lines.push_str(&format!(
                        "{} {} {}\n",
                        r as f32 / 2.0,
                        g as f32 / 2.0,
                        b as f32 / 2.0
                    ));
                }
            }
        }
        let lut = Lut3d::parse_cube(&lines).unwrap();
        assert_eq!(lut.size(), LUT_SIZE);
        assert!((lut.sample([0.5, 0.5, 0.5])[0] - 0.5).abs() < 0.02);
    }

    #[test]
    fn rgba_texture_has_alpha() {
        let bytes = Lut3d::identity(LUT_SIZE).to_rgba8();
        assert_eq!(bytes.len(), (LUT_SIZE * LUT_SIZE * LUT_SIZE * 4) as usize);
        assert!(bytes.iter().skip(3).step_by(4).all(|a| *a == 255));
    }
}
