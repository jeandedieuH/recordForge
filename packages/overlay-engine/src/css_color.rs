//! Canonical CSS color parsing shared by every native export consumer.
//!
//! The editor preview renders user-facing color strings through the browser,
//! so any value CSS accepts is "valid" there. Export used to re-implement a
//! narrow subset per consumer (hex-only, comma-only `rgb()`, a few named
//! colors), which silently remapped valid preview colors to black/blue
//! fallbacks. This module parses the CSS Color 4 surface the preview accepts
//! so both paths resolve the same value.
//!
//! Context-dependent forms (`var()`, `currentColor`, `color-mix()`,
//! `light-dark()`, system colors, relative color syntax) cannot be resolved
//! without DOM state and return `None` — callers apply their own fallback.

// The conversion matrices below carry the published f64 precision of the
// color-science references (OKLab, CIE XYZ, Bradford); f32 narrows them on
// parse regardless.
#![allow(clippy::excessive_precision)]

/// sRGB color with un-premultiplied channels in `0.0..=1.0` (gamma-encoded,
/// not linear).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CssColor {
    pub r: f32,
    pub g: f32,
    pub b: f32,
    pub a: f32,
}

impl CssColor {
    /// `#rrggbb` when opaque, `#rrggbbaa` when the value carries alpha. Both
    /// are accepted by FFmpeg color options, tiny-skia and svgtypes, so every
    /// consumer can share this serialization.
    pub fn to_hex_string(&self) -> String {
        let [r, g, b, a] = self.to_rgba8();
        if a == 255 {
            format!("#{r:02x}{g:02x}{b:02x}")
        } else {
            format!("#{r:02x}{g:02x}{b:02x}{a:02x}")
        }
    }

    pub fn to_rgba8(&self) -> [u8; 4] {
        [to_u8(self.r), to_u8(self.g), to_u8(self.b), to_u8(self.a)]
    }
}

/// Parse a CSS color string. Returns `None` for values that need DOM context
/// (`var()`, `currentColor`, `color-mix()`, `light-dark()`) or are not colors.
pub fn parse_css_color(value: &str) -> Option<CssColor> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Some(hex) = trimmed.strip_prefix('#') {
        return parse_hex(hex);
    }
    if let Some(open) = trimmed.find('(') {
        if !trimmed.ends_with(')') {
            return None;
        }
        let name = &trimmed[..open];
        // `rgb (` is not a function token in CSS; the paren must be adjacent.
        if name.is_empty() || name.trim() != name {
            return None;
        }
        return parse_function(
            &name.to_ascii_lowercase(),
            &trimmed[open + 1..trimmed.len() - 1],
        );
    }
    named_color(&trimmed.to_ascii_lowercase())
}

fn parse_hex(hex: &str) -> Option<CssColor> {
    let nibble = |i: usize| u8::from_str_radix(&hex[i..i + 1], 16).ok();
    match hex.len() {
        3 | 4 => {
            let r = nibble(0)? * 17;
            let g = nibble(1)? * 17;
            let b = nibble(2)? * 17;
            let a = if hex.len() == 4 { nibble(3)? * 17 } else { 255 };
            Some(from_u8(r, g, b, a))
        }
        6 | 8 => {
            let r = u8::from_str_radix(&hex[0..2], 16).ok()?;
            let g = u8::from_str_radix(&hex[2..4], 16).ok()?;
            let b = u8::from_str_radix(&hex[4..6], 16).ok()?;
            let a = if hex.len() == 8 {
                u8::from_str_radix(&hex[6..8], 16).ok()?
            } else {
                255
            };
            Some(from_u8(r, g, b, a))
        }
        _ => None,
    }
}

fn from_u8(r: u8, g: u8, b: u8, a: u8) -> CssColor {
    CssColor {
        r: r as f32 / 255.0,
        g: g as f32 / 255.0,
        b: b as f32 / 255.0,
        a: a as f32 / 255.0,
    }
}

fn to_u8(v: f32) -> u8 {
    (v.clamp(0.0, 1.0) * 255.0).round() as u8
}

fn parse_function(name: &str, args: &str) -> Option<CssColor> {
    match name {
        "rgb" | "rgba" => {
            let (channels, alpha_arg) = split_channels(args, 3, true)?;
            Some(CssColor {
                r: rgb_channel(&channels[0])?,
                g: rgb_channel(&channels[1])?,
                b: rgb_channel(&channels[2])?,
                a: alpha(alpha_arg.as_deref())?,
            })
        }
        "hsl" | "hsla" => {
            let (channels, alpha_arg) = split_channels(args, 3, true)?;
            let (r, g, b) = hsl_to_rgb(
                hue(&channels[0])?,
                percent(&channels[1])?,
                percent(&channels[2])?,
            );
            Some(CssColor {
                r,
                g,
                b,
                a: alpha(alpha_arg.as_deref())?,
            })
        }
        // hwb()/lab()/lch()/oklab()/oklch() have no legacy comma syntax.
        "hwb" => {
            let (channels, alpha_arg) = split_channels(args, 3, false)?;
            let (r, g, b) = hwb_to_rgb(
                hue(&channels[0])?,
                percent(&channels[1])?,
                percent(&channels[2])?,
            );
            Some(CssColor {
                r,
                g,
                b,
                a: alpha(alpha_arg.as_deref())?,
            })
        }
        "lab" => {
            let (channels, alpha_arg) = split_channels(args, 3, false)?;
            let (r, g, b) = lab_to_srgb(
                scaled_component(&channels[0], 100.0)?.clamp(0.0, 100.0),
                scaled_component(&channels[1], 125.0)?,
                scaled_component(&channels[2], 125.0)?,
            );
            Some(CssColor {
                r,
                g,
                b,
                a: alpha(alpha_arg.as_deref())?,
            })
        }
        "lch" => {
            let (channels, alpha_arg) = split_channels(args, 3, false)?;
            let l = scaled_component(&channels[0], 100.0)?.clamp(0.0, 100.0);
            let c = scaled_component(&channels[1], 150.0)?.max(0.0);
            let h = hue(&channels[2])?.to_radians();
            let (r, g, b) = lab_to_srgb(l, c * h.cos(), c * h.sin());
            Some(CssColor {
                r,
                g,
                b,
                a: alpha(alpha_arg.as_deref())?,
            })
        }
        "oklab" => {
            let (channels, alpha_arg) = split_channels(args, 3, false)?;
            let (r, g, b) = oklab_to_srgb(
                scaled_component(&channels[0], 1.0)?.clamp(0.0, 1.0),
                scaled_component(&channels[1], 0.4)?,
                scaled_component(&channels[2], 0.4)?,
            );
            Some(CssColor {
                r,
                g,
                b,
                a: alpha(alpha_arg.as_deref())?,
            })
        }
        "oklch" => {
            let (channels, alpha_arg) = split_channels(args, 3, false)?;
            let l = scaled_component(&channels[0], 1.0)?.clamp(0.0, 1.0);
            let c = scaled_component(&channels[1], 0.4)?.max(0.0);
            let h = hue(&channels[2])?.to_radians();
            let (r, g, b) = oklab_to_srgb(l, c * h.cos(), c * h.sin());
            Some(CssColor {
                r,
                g,
                b,
                a: alpha(alpha_arg.as_deref())?,
            })
        }
        "color" => parse_color_function(args),
        _ => None,
    }
}

/// Split `rgb(...)`-style arguments into exactly `count` channels plus an
/// optional alpha. Accepts the legacy comma form `a,b,c[,d]` and the modern
/// space form `a b c [/ d]`; mixed forms are rejected.
fn split_channels(
    args: &str,
    count: usize,
    allow_comma: bool,
) -> Option<(Vec<String>, Option<String>)> {
    if allow_comma && args.contains(',') {
        let parts: Vec<&str> = args.split(',').map(str::trim).collect();
        return match parts.len() {
            n if n == count => Some((parts.iter().map(|s| (*s).to_string()).collect(), None)),
            n if n == count + 1 => Some((
                parts[..count].iter().map(|s| (*s).to_string()).collect(),
                Some(parts[count].to_string()),
            )),
            _ => None,
        };
    }
    let (channel_str, alpha) = match args.split_once('/') {
        Some((channels, alpha)) => (channels.trim(), Some(alpha.trim().to_string())),
        None => (args, None),
    };
    let parts: Vec<String> = channel_str.split_whitespace().map(str::to_string).collect();
    if parts.len() != count {
        return None;
    }
    Some((parts, alpha))
}

/// `none` marks a missing component and computes to zero (CSS Color 4 §4.4).
fn none_or(s: &str, parse: impl Fn(&str) -> Option<f32>) -> Option<f32> {
    if s.eq_ignore_ascii_case("none") {
        Some(0.0)
    } else {
        parse(s)
    }
}

/// sRGB channel: `0`–`255` number or percentage of 255.
fn rgb_channel(s: &str) -> Option<f32> {
    none_or(s, |s| {
        if let Some(pct) = s.strip_suffix('%') {
            pct.parse::<f32>().ok().map(|v| (v / 100.0).clamp(0.0, 1.0))
        } else {
            s.parse::<f32>().ok().map(|v| (v / 255.0).clamp(0.0, 1.0))
        }
    })
}

/// Percentage token → `0.0..=1.0`. Bare numbers are treated as the percent
/// value so `hsl(120, 50, 50)`-style legacy input still resolves.
fn percent(s: &str) -> Option<f32> {
    none_or(s, |s| {
        let value = s.strip_suffix('%').unwrap_or(s);
        value.parse::<f32>().ok().map(|v| v / 100.0)
    })
}

/// Number-or-percentage where `pct_max` is what `100%` refers to for that
/// channel (e.g. ±125 for `lab()` a/b, 0.4 for `oklab()` a/b).
fn scaled_component(s: &str, pct_max: f32) -> Option<f32> {
    none_or(s, |s| {
        if let Some(pct) = s.strip_suffix('%') {
            pct.parse::<f32>().ok().map(|v| v / 100.0 * pct_max)
        } else {
            s.parse::<f32>().ok()
        }
    })
}

/// CSS `<hue>`: bare numbers are degrees; `deg`, `grad`, `rad` and `turn`
/// units convert to degrees. Out-of-range values wrap at use site.
fn hue(s: &str) -> Option<f32> {
    none_or(s, |s| {
        let lower = s.to_ascii_lowercase();
        for (suffix, factor) in [
            ("turn", 360.0),
            ("grad", 0.9),
            ("deg", 1.0),
            ("rad", 180.0 / std::f32::consts::PI),
        ] {
            if let Some(v) = lower.strip_suffix(suffix) {
                return v.parse::<f32>().ok().map(|v| v * factor);
            }
        }
        lower.parse::<f32>().ok()
    })
}

fn alpha(s: Option<&str>) -> Option<f32> {
    match s {
        None => Some(1.0),
        Some(s) => none_or(s, |s| {
            if let Some(pct) = s.strip_suffix('%') {
                pct.parse::<f32>().ok().map(|v| (v / 100.0).clamp(0.0, 1.0))
            } else {
                s.parse::<f32>().ok().map(|v| v.clamp(0.0, 1.0))
            }
        }),
    }
}

/// CSS Color 4 sample-code HSL→RGB: `s`/`l` in `0..=1`, `h` in degrees.
fn hsl_to_rgb(h: f32, s: f32, l: f32) -> (f32, f32, f32) {
    let h = h.rem_euclid(360.0);
    let s = s.clamp(0.0, 1.0);
    let l = l.clamp(0.0, 1.0);
    let a = s * l.min(1.0 - l);
    let f = |n: f32| {
        let k = (n + h / 30.0) % 12.0;
        l - a * (k - 3.0).min(9.0 - k).clamp(-1.0, 1.0)
    };
    (f(0.0), f(8.0), f(4.0))
}

/// hwb: pure hue at (h, 100%, 50%) whitened/blackened; w+b ≥ 1 collapses to gray.
fn hwb_to_rgb(h: f32, w: f32, black: f32) -> (f32, f32, f32) {
    let (r, g, b) = hsl_to_rgb(h, 1.0, 0.5);
    let w = w.clamp(0.0, 1.0);
    let black = black.clamp(0.0, 1.0);
    if w + black >= 1.0 {
        let gray = w / (w + black);
        return (gray, gray, gray);
    }
    let scale = 1.0 - w - black;
    (r * scale + w, g * scale + w, b * scale + w)
}

fn srgb_encode(v: f32) -> f32 {
    let encoded = if v <= 0.0031308 {
        v * 12.92
    } else {
        1.055 * v.powf(1.0 / 2.4) - 0.055
    };
    encoded.clamp(0.0, 1.0)
}

/// CIE Lab (D50) → sRGB via Bradford-adapted XYZ.
fn lab_to_srgb(l: f32, a: f32, b: f32) -> (f32, f32, f32) {
    const EPSILON: f32 = 216.0 / 24389.0;
    const KAPPA: f32 = 24389.0 / 27.0;
    const D50: (f32, f32, f32) = (0.96422, 1.0, 0.82521);
    let fy = (l + 16.0) / 116.0;
    let fx = fy + a / 500.0;
    let fz = fy - b / 200.0;
    let finv = |f: f32| {
        let f3 = f * f * f;
        if f3 > EPSILON {
            f3
        } else {
            (116.0 * f - 16.0) / KAPPA
        }
    };
    let x = finv(fx) * D50.0;
    let y = if l > KAPPA * EPSILON {
        fy * fy * fy
    } else {
        l / KAPPA
    };
    let z = finv(fz) * D50.2;
    let (x, y, z) = d50_to_d65(x, y, z);
    xyz_to_srgb(x, y, z)
}

/// Bradford chromatic adaptation, D50 → D65.
fn d50_to_d65(x: f32, y: f32, z: f32) -> (f32, f32, f32) {
    (
        0.9555766 * x - 0.0230393 * y + 0.0631636 * z,
        -0.0282895 * x + 1.0099416 * y + 0.0210077 * z,
        0.0122982 * x - 0.0204830 * y + 1.3299098 * z,
    )
}

/// CIE XYZ (D65) → gamma-encoded sRGB.
fn xyz_to_srgb(x: f32, y: f32, z: f32) -> (f32, f32, f32) {
    let r = 3.2404542 * x - 1.5371385 * y - 0.4985314 * z;
    let g = -0.9692660 * x + 1.8760108 * y + 0.0415560 * z;
    let b = 0.0556434 * x - 0.2040259 * y + 1.0572252 * z;
    (srgb_encode(r), srgb_encode(g), srgb_encode(b))
}

/// OKLab → sRGB (Ottosson's inverse transform).
fn oklab_to_srgb(l: f32, a: f32, b: f32) -> (f32, f32, f32) {
    let lp = l + 0.3963377774 * a + 0.2158037573 * b;
    let mp = l - 0.1055613458 * a - 0.0638541729 * b;
    let sp = l - 0.0894841775 * a - 1.2914855480 * b;
    let l3 = lp * lp * lp;
    let m3 = mp * mp * mp;
    let s3 = sp * sp * sp;
    let r = 4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3;
    let g = -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3;
    let b = -0.0041960863 * l3 - 0.7034186147 * m3 + 1.7076147010 * s3;
    (srgb_encode(r), srgb_encode(g), srgb_encode(b))
}

/// `color(<space> r g b [/ a])` — the profile spaces that can be converted to
/// sRGB without an ICC profile: srgb, srgb-linear and display-p3.
fn parse_color_function(args: &str) -> Option<CssColor> {
    let (head, alpha_str) = match args.split_once('/') {
        Some((channels, alpha)) => (channels.trim(), Some(alpha.trim())),
        None => (args, None),
    };
    let mut parts = head.split_whitespace();
    let space = parts.next()?.to_ascii_lowercase();
    let channels: Vec<&str> = parts.collect();
    if channels.len() != 3 {
        return None;
    }
    let parse_channel = |s: &str| {
        none_or(s, |s| {
            if let Some(pct) = s.strip_suffix('%') {
                pct.parse::<f32>().ok().map(|v| v / 100.0)
            } else {
                s.parse::<f32>().ok()
            }
        })
    };
    let r = parse_channel(channels[0])?;
    let g = parse_channel(channels[1])?;
    let b = parse_channel(channels[2])?;
    let (r, g, b) = match space.as_str() {
        "srgb" => (r.clamp(0.0, 1.0), g.clamp(0.0, 1.0), b.clamp(0.0, 1.0)),
        "srgb-linear" => (srgb_encode(r), srgb_encode(g), srgb_encode(b)),
        "display-p3" => {
            let x = 0.4865709 * r + 0.2656677 * g + 0.1982173 * b;
            let y = 0.2289746 * r + 0.6917385 * g + 0.0792869 * b;
            let z = 0.0451134 * g + 1.0439444 * b;
            xyz_to_srgb(x, y, z)
        }
        _ => return None,
    };
    Some(CssColor {
        r,
        g,
        b,
        a: alpha(alpha_str)?,
    })
}

/// CSS Color 4 named colors plus `transparent`.
fn named_color(name: &str) -> Option<CssColor> {
    let rgba = match name {
        "aliceblue" => (0xf0, 0xf8, 0xff, 255),
        "antiquewhite" => (0xfa, 0xeb, 0xd7, 255),
        "aqua" => (0x00, 0xff, 0xff, 255),
        "aquamarine" => (0x7f, 0xff, 0xd4, 255),
        "azure" => (0xf0, 0xff, 0xff, 255),
        "beige" => (0xf5, 0xf5, 0xdc, 255),
        "bisque" => (0xff, 0xe4, 0xc4, 255),
        "black" => (0x00, 0x00, 0x00, 255),
        "blanchedalmond" => (0xff, 0xeb, 0xcd, 255),
        "blue" => (0x00, 0x00, 0xff, 255),
        "blueviolet" => (0x8a, 0x2b, 0xe2, 255),
        "brown" => (0xa5, 0x2a, 0x2a, 255),
        "burlywood" => (0xde, 0xb8, 0x87, 255),
        "cadetblue" => (0x5f, 0x9e, 0xa0, 255),
        "chartreuse" => (0x7f, 0xff, 0x00, 255),
        "chocolate" => (0xd2, 0x69, 0x1e, 255),
        "coral" => (0xff, 0x7f, 0x50, 255),
        "cornflowerblue" => (0x64, 0x95, 0xed, 255),
        "cornsilk" => (0xff, 0xf8, 0xdc, 255),
        "crimson" => (0xdc, 0x14, 0x3c, 255),
        "cyan" => (0x00, 0xff, 0xff, 255),
        "darkblue" => (0x00, 0x00, 0x8b, 255),
        "darkcyan" => (0x00, 0x8b, 0x8b, 255),
        "darkgoldenrod" => (0xb8, 0x86, 0x0b, 255),
        "darkgray" | "darkgrey" => (0xa9, 0xa9, 0xa9, 255),
        "darkgreen" => (0x00, 0x64, 0x00, 255),
        "darkkhaki" => (0xbd, 0xb7, 0x6b, 255),
        "darkmagenta" => (0x8b, 0x00, 0x8b, 255),
        "darkolivegreen" => (0x55, 0x6b, 0x2f, 255),
        "darkorange" => (0xff, 0x8c, 0x00, 255),
        "darkorchid" => (0x99, 0x32, 0xcc, 255),
        "darkred" => (0x8b, 0x00, 0x00, 255),
        "darksalmon" => (0xe9, 0x96, 0x7a, 255),
        "darkseagreen" => (0x8f, 0xbc, 0x8f, 255),
        "darkslateblue" => (0x48, 0x3d, 0x8b, 255),
        "darkslategray" | "darkslategrey" => (0x2f, 0x4f, 0x4f, 255),
        "darkturquoise" => (0x00, 0xce, 0xd1, 255),
        "darkviolet" => (0x94, 0x00, 0xd3, 255),
        "deeppink" => (0xff, 0x14, 0x93, 255),
        "deepskyblue" => (0x00, 0xbf, 0xff, 255),
        "dimgray" | "dimgrey" => (0x69, 0x69, 0x69, 255),
        "dodgerblue" => (0x1e, 0x90, 0xff, 255),
        "firebrick" => (0xb2, 0x22, 0x22, 255),
        "floralwhite" => (0xff, 0xfa, 0xf0, 255),
        "forestgreen" => (0x22, 0x8b, 0x22, 255),
        "fuchsia" => (0xff, 0x00, 0xff, 255),
        "gainsboro" => (0xdc, 0xdc, 0xdc, 255),
        "ghostwhite" => (0xf8, 0xf8, 0xff, 255),
        "gold" => (0xff, 0xd7, 0x00, 255),
        "goldenrod" => (0xda, 0xa5, 0x20, 255),
        "gray" | "grey" => (0x80, 0x80, 0x80, 255),
        "green" => (0x00, 0x80, 0x00, 255),
        "greenyellow" => (0xad, 0xff, 0x2f, 255),
        "honeydew" => (0xf0, 0xff, 0xf0, 255),
        "hotpink" => (0xff, 0x69, 0xb4, 255),
        "indianred" => (0xcd, 0x5c, 0x5c, 255),
        "indigo" => (0x4b, 0x00, 0x82, 255),
        "ivory" => (0xff, 0xff, 0xf0, 255),
        "khaki" => (0xf0, 0xe6, 0x8c, 255),
        "lavender" => (0xe6, 0xe6, 0xfa, 255),
        "lavenderblush" => (0xff, 0xf0, 0xf5, 255),
        "lawngreen" => (0x7c, 0xfc, 0x00, 255),
        "lemonchiffon" => (0xff, 0xfa, 0xcd, 255),
        "lightblue" => (0xad, 0xd8, 0xe6, 255),
        "lightcoral" => (0xf0, 0x80, 0x80, 255),
        "lightcyan" => (0xe0, 0xff, 0xff, 255),
        "lightgoldenrodyellow" => (0xfa, 0xfa, 0xd2, 255),
        "lightgray" | "lightgrey" => (0xd3, 0xd3, 0xd3, 255),
        "lightgreen" => (0x90, 0xee, 0x90, 255),
        "lightpink" => (0xff, 0xb6, 0xc1, 255),
        "lightsalmon" => (0xff, 0xa0, 0x7a, 255),
        "lightseagreen" => (0x20, 0xb2, 0xaa, 255),
        "lightskyblue" => (0x87, 0xce, 0xfa, 255),
        "lightslategray" | "lightslategrey" => (0x77, 0x88, 0x99, 255),
        "lightsteelblue" => (0xb0, 0xc4, 0xde, 255),
        "lightyellow" => (0xff, 0xff, 0xe0, 255),
        "lime" => (0x00, 0xff, 0x00, 255),
        "limegreen" => (0x32, 0xcd, 0x32, 255),
        "linen" => (0xfa, 0xf0, 0xe6, 255),
        "magenta" => (0xff, 0x00, 0xff, 255),
        "maroon" => (0x80, 0x00, 0x00, 255),
        "mediumaquamarine" => (0x66, 0xcd, 0xaa, 255),
        "mediumblue" => (0x00, 0x00, 0xcd, 255),
        "mediumorchid" => (0xba, 0x55, 0xd3, 255),
        "mediumpurple" => (0x93, 0x70, 0xdb, 255),
        "mediumseagreen" => (0x3c, 0xb3, 0x71, 255),
        "mediumslateblue" => (0x7b, 0x68, 0xee, 255),
        "mediumspringgreen" => (0x00, 0xfa, 0x9a, 255),
        "mediumturquoise" => (0x48, 0xd1, 0xcc, 255),
        "mediumvioletred" => (0xc7, 0x15, 0x85, 255),
        "midnightblue" => (0x19, 0x19, 0x70, 255),
        "mintcream" => (0xf5, 0xff, 0xfa, 255),
        "mistyrose" => (0xff, 0xe4, 0xe1, 255),
        "moccasin" => (0xff, 0xe4, 0xb5, 255),
        "navajowhite" => (0xff, 0xde, 0xad, 255),
        "navy" => (0x00, 0x00, 0x80, 255),
        "oldlace" => (0xfd, 0xf5, 0xe6, 255),
        "olive" => (0x80, 0x80, 0x00, 255),
        "olivedrab" => (0x6b, 0x8e, 0x23, 255),
        "orange" => (0xff, 0xa5, 0x00, 255),
        "orangered" => (0xff, 0x45, 0x00, 255),
        "orchid" => (0xda, 0x70, 0xd6, 255),
        "palegoldenrod" => (0xee, 0xe8, 0xaa, 255),
        "palegreen" => (0x98, 0xfb, 0x98, 255),
        "paleturquoise" => (0xaf, 0xee, 0xee, 255),
        "palevioletred" => (0xdb, 0x70, 0x93, 255),
        "papayawhip" => (0xff, 0xef, 0xd5, 255),
        "peachpuff" => (0xff, 0xda, 0xb9, 255),
        "peru" => (0xcd, 0x85, 0x3f, 255),
        "pink" => (0xff, 0xc0, 0xcb, 255),
        "plum" => (0xdd, 0xa0, 0xdd, 255),
        "powderblue" => (0xb0, 0xe0, 0xe6, 255),
        "purple" => (0x80, 0x00, 0x80, 255),
        "rebeccapurple" => (0x66, 0x33, 0x99, 255),
        "red" => (0xff, 0x00, 0x00, 255),
        "rosybrown" => (0xbc, 0x8f, 0x8f, 255),
        "royalblue" => (0x41, 0x69, 0xe1, 255),
        "saddlebrown" => (0x8b, 0x45, 0x13, 255),
        "salmon" => (0xfa, 0x80, 0x72, 255),
        "sandybrown" => (0xf4, 0xa4, 0x60, 255),
        "seagreen" => (0x2e, 0x8b, 0x57, 255),
        "seashell" => (0xff, 0xf5, 0xee, 255),
        "sienna" => (0xa0, 0x52, 0x2d, 255),
        "silver" => (0xc0, 0xc0, 0xc0, 255),
        "skyblue" => (0x87, 0xce, 0xeb, 255),
        "slateblue" => (0x6a, 0x5a, 0xcd, 255),
        "slategray" | "slategrey" => (0x70, 0x80, 0x90, 255),
        "snow" => (0xff, 0xfa, 0xfa, 255),
        "springgreen" => (0x00, 0xff, 0x7f, 255),
        "steelblue" => (0x46, 0x82, 0xb4, 255),
        "tan" => (0xd2, 0xb4, 0x8c, 255),
        "teal" => (0x00, 0x80, 0x80, 255),
        "thistle" => (0xd8, 0xbf, 0xd8, 255),
        "tomato" => (0xff, 0x63, 0x47, 255),
        "transparent" => (0x00, 0x00, 0x00, 0x00),
        "turquoise" => (0x40, 0xe0, 0xd0, 255),
        "violet" => (0xee, 0x82, 0xee, 255),
        "wheat" => (0xf5, 0xde, 0xb3, 255),
        "white" => (0xff, 0xff, 0xff, 255),
        "whitesmoke" => (0xf5, 0xf5, 0xf5, 255),
        "yellow" => (0xff, 0xff, 0x00, 255),
        "yellowgreen" => (0x9a, 0xcd, 0x32, 255),
        _ => return None,
    };
    Some(from_u8(rgba.0, rgba.1, rgba.2, rgba.3))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(value: &str) -> String {
        parse_css_color(value)
            .map(|color| color.to_hex_string())
            .unwrap_or_else(|| format!("UNPARSED({value})"))
    }

    fn assert_close(color: CssColor, expected: [u8; 4], tolerance: u8) {
        let actual = color.to_rgba8();
        for (channel, (a, e)) in actual.iter().zip(expected.iter()).enumerate() {
            assert!(
                a.abs_diff(*e) <= tolerance,
                "channel {channel}: expected {e}, got {a} ({actual:?} vs {expected:?})"
            );
        }
    }

    #[test]
    fn parses_all_hex_widths() {
        assert_eq!(hex("#bef264"), "#bef264");
        assert_eq!(hex("#BEF264"), "#bef264");
        assert_eq!(hex("#bef"), "#bbeeff");
        assert_eq!(hex("#bef2"), "#bbeeff22");
        assert_eq!(hex("#bef264e6"), "#bef264e6");
        assert!(parse_css_color("#12").is_none());
        assert!(parse_css_color("#12345").is_none());
        assert!(parse_css_color("#gggggg").is_none());
    }

    #[test]
    fn parses_comma_rgb_and_rgba() {
        // The "Neon Pop" look accent — the export bug's trigger value.
        assert_eq!(hex("rgb(190, 242, 100)"), "#bef264");
        assert_eq!(hex("rgb(190,242,100)"), "#bef264");
        assert_eq!(hex("rgba(255,255,255,0.85)"), "#ffffffd9");
        assert_eq!(hex("rgba(30,27,20,0.4)"), "#1e1b1466");
        assert_eq!(hex("rgba(255, 0, 0, 50%)"), "#ff000080");
        // rgb() with a 4th comma component is legal in modern CSS.
        assert_eq!(hex("rgb(52, 211, 153, 1)"), "#34d399");
        assert_eq!(hex("rgb(50% 50% 50%)"), "#808080");
    }

    #[test]
    fn parses_space_slash_rgb() {
        // Modern syntax emitted by CSS custom properties in the app theme.
        assert_eq!(hex("rgb(0 0 0 / 0.45)"), "#00000073");
        assert_eq!(hex("rgb(190 242 100)"), "#bef264");
        assert_eq!(hex("rgb(190 242 100 / 90%)"), "#bef264e6");
        assert_eq!(hex("rgb(255 255 255 / none)"), "#ffffff00");
    }

    #[test]
    fn parses_hsl_hsla() {
        assert_eq!(hex("hsl(120, 100%, 25%)"), "#008000");
        assert_eq!(hex("hsl(120 100% 25%)"), "#008000");
        assert_eq!(hex("hsla(120, 100%, 25%, 0.5)"), "#00800080");
        assert_eq!(hex("hsl(0.5turn 100% 50%)"), "#00ffff");
        assert_eq!(hex("hsl(480deg 100% 50%)"), "#00ff00");
        assert_eq!(hex("hsl(none 0% 0%)"), "#000000");
    }

    #[test]
    fn parses_hwb() {
        assert_eq!(hex("hwb(120 0% 0%)"), "#00ff00");
        assert_eq!(hex("hwb(120 50% 50%)"), "#808080");
        assert_eq!(hex("hwb(0 0% 0% / 0.5)"), "#ff000080");
    }

    #[test]
    fn parses_lab_lch_oklab_oklch() {
        // Known conversions (values verified against the reference math).
        assert_close(
            parse_css_color("oklch(70% 0.1 230)").unwrap(),
            [84, 170, 209, 255],
            4,
        );
        assert_close(
            parse_css_color("oklab(60% 0.1 -0.1)").unwrap(),
            [159, 99, 186, 255],
            4,
        );
        assert_close(
            parse_css_color("lab(50% 20 -30)").unwrap(),
            [133, 108, 170, 255],
            4,
        );
        assert_close(
            parse_css_color("lch(50% 40 240)").unwrap(),
            [0, 130, 177, 255],
            8,
        );
    }

    #[test]
    fn parses_color_function() {
        assert_eq!(hex("color(srgb 0.7451 0.949 0.3922)"), "#bef264");
        assert_eq!(hex("color(srgb 1 0 0 / 0.5)"), "#ff000080");
        assert_eq!(hex("color(srgb 50% 50% 50%)"), "#808080");
        assert_close(
            parse_css_color("color(srgb-linear 1 0 0)").unwrap(),
            [255, 0, 0, 255],
            1,
        );
        assert!(parse_css_color("color(rec2020 0 0 0)").is_none());
    }

    #[test]
    fn parses_named_colors_and_transparent() {
        assert_eq!(hex("black"), "#000000");
        assert_eq!(hex("WHITE"), "#ffffff");
        assert_eq!(hex("rebeccapurple"), "#663399");
        assert_eq!(hex("lime"), "#00ff00");
        assert_eq!(hex("transparent"), "#00000000");
        assert_eq!(hex("DarkSlateGray"), "#2f4f4f");
    }

    #[test]
    fn rejects_context_dependent_and_invalid() {
        assert!(parse_css_color("var(--color-pip-shadow)").is_none());
        assert!(parse_css_color("color-mix(in srgb, red, blue)").is_none());
        assert!(parse_css_color("light-dark(#fff, #000)").is_none());
        assert!(parse_css_color("currentColor").is_none());
        assert!(parse_css_color("linear-gradient(#10b981, #6366f1)").is_none());
        assert!(parse_css_color("unknown_color").is_none());
        assert!(parse_css_color("").is_none());
        assert!(parse_css_color("rgb(1 2)").is_none());
        assert!(parse_css_color("rgba(1,2,3,4,5)").is_none());
        assert!(parse_css_color("rgb (1 2 3)").is_none());
    }

    #[test]
    fn hex_serialization_roundtrips() {
        let c = parse_css_color("rgba(255,255,255,0.85)").unwrap();
        assert_eq!(c.to_hex_string(), "#ffffffd9");
        let c = parse_css_color("#ffffffd9").unwrap();
        assert_close(c, [255, 255, 255, 0xd9], 1);
    }
}
