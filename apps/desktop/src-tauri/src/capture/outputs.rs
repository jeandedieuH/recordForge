use serde::{Deserialize, Serialize};
#[cfg(windows)]
use tracing::warn;

use super::source::Bounds;

/// A desktop-attached DXGI output with the global output index that FFmpeg's
/// `ddagrab=output_idx=N` filter expects.
///
/// FFmpeg counts outputs across adapters in enumeration order (adapter 0
/// outputs first), so the index here mirrors that ordering rather than using a
/// per-adapter pair.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DxgiOutputEntry {
    pub output_idx: u32,
    /// Desktop coordinates of the output in physical pixels.
    pub bounds: Bounds,
}

/// Resolve which DXGI output a capture rect belongs to.
///
/// Returns the output with the largest intersection area with `bounds`. This
/// both maps full-display rects (exact match) and clamps cross-monitor regions
/// onto the monitor that contains most of the selection.
pub fn resolve_output_target(
    outputs: &[DxgiOutputEntry],
    bounds: Bounds,
) -> Option<DxgiOutputEntry> {
    outputs
        .iter()
        .filter_map(|output| {
            let area = intersection_area(output.bounds, bounds);
            if area >= MIN_INTERSECTION_PX {
                Some((area, *output))
            } else {
                None
            }
        })
        .max_by_key(|(area, _)| *area)
        .map(|(_, output)| output)
}

/// Smallest intersection (in physical pixels) that still counts as "the region
/// is on this monitor". Below this the capture would be a sliver and the user
/// almost certainly picked the wrong monitor mapping.
const MIN_INTERSECTION_PX: i64 = 64 * 64;

fn intersection_area(a: Bounds, b: Bounds) -> i64 {
    let x0 = i64::from(a.x.max(b.x));
    let y0 = i64::from(a.y.max(b.y));
    let x1 = i64::from(a.x + a.width).min(i64::from(b.x + b.width));
    let y1 = i64::from(a.y + a.height).min(i64::from(b.y + b.height));
    (x1 - x0).max(0) * (y1 - y0).max(0)
}

/// Convert absolute virtual-screen bounds into coordinates relative to a DXGI
/// output, clamped to the output's desktop rect.
///
/// Returns `(offset_x, offset_y, width, height)` for `ddagrab`.
pub fn output_relative_region(output: DxgiOutputEntry, bounds: Bounds) -> (i32, i32, u32, u32) {
    let out = output.bounds;
    let x0 = bounds.x.max(out.x);
    let y0 = bounds.y.max(out.y);
    let x1 = (bounds.x + bounds.width).min(out.x + out.width);
    let y1 = (bounds.y + bounds.height).min(out.y + out.height);
    let width = (x1 - x0).max(1) as u32;
    let height = (y1 - y0).max(1) as u32;
    (x0 - out.x, y0 - out.y, width, height)
}

/// Enumerate all desktop-attached DXGI outputs in physical desktop coordinates.
///
/// Non-Windows platforms return an empty list; capture falls back to gdigrab.
#[cfg(windows)]
pub fn enumerate_dxgi_outputs() -> Vec<DxgiOutputEntry> {
    use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIFactory1};

    let factory: IDXGIFactory1 = match unsafe { CreateDXGIFactory1() } {
        Ok(factory) => factory,
        Err(error) => {
            warn!(error = %error, "failed to create DXGI factory; ddagrab mapping unavailable");
            return Vec::new();
        }
    };

    let mut outputs = Vec::new();
    let mut global_index: u32 = 0;
    let mut adapter_index: u32 = 0;
    loop {
        let adapter = match unsafe { factory.EnumAdapters1(adapter_index) } {
            Ok(adapter) => adapter,
            Err(_) => break,
        };
        adapter_index += 1;

        let mut output_index: u32 = 0;
        loop {
            let output = match unsafe { adapter.EnumOutputs(output_index) } {
                Ok(output) => output,
                Err(_) => break,
            };
            output_index += 1;

            let desc = match unsafe { output.GetDesc() } {
                Ok(desc) => desc,
                Err(error) => {
                    warn!(error = %error, "failed to read DXGI output descriptor");
                    continue;
                }
            };
            if !desc.AttachedToDesktop.as_bool() {
                continue;
            }

            let rect = desc.DesktopCoordinates;
            outputs.push(DxgiOutputEntry {
                output_idx: global_index,
                bounds: Bounds {
                    x: rect.left,
                    y: rect.top,
                    width: rect.right - rect.left,
                    height: rect.bottom - rect.top,
                },
            });
            global_index += 1;
        }
    }

    outputs
}

#[cfg(not(windows))]
pub fn enumerate_dxgi_outputs() -> Vec<DxgiOutputEntry> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn output(idx: u32, x: i32, y: i32, w: i32, h: i32) -> DxgiOutputEntry {
        DxgiOutputEntry {
            output_idx: idx,
            bounds: Bounds {
                x,
                y,
                width: w,
                height: h,
            },
        }
    }

    fn bounds(x: i32, y: i32, w: i32, h: i32) -> Bounds {
        Bounds {
            x,
            y,
            width: w,
            height: h,
        }
    }

    #[test]
    fn resolves_display_bounds_to_exact_output() {
        let outputs = vec![output(0, 0, 0, 1920, 1080), output(2, 1920, 0, 2560, 1440)];
        let target = resolve_output_target(&outputs, bounds(1920, 0, 2560, 1440))
            .expect("secondary display resolves");
        assert_eq!(target.output_idx, 2);
    }

    #[test]
    fn region_maps_to_output_with_largest_overlap() {
        let outputs = vec![output(0, 0, 0, 1920, 1080), output(2, 1920, 0, 2560, 1440)];
        // Region straddles both monitors but sits mostly on the second.
        let target =
            resolve_output_target(&outputs, bounds(1720, 200, 1200, 800)).expect("resolves");
        assert_eq!(target.output_idx, 2);
    }

    #[test]
    fn region_fully_outside_outputs_does_not_resolve() {
        let outputs = vec![output(0, 0, 0, 1920, 1080)];
        assert!(resolve_output_target(&outputs, bounds(-5000, -5000, 400, 400)).is_none());
    }

    #[test]
    fn relative_region_clamps_to_output_rect() {
        let output = output(3, 1920, 0, 2560, 1440);
        // A region that starts left of the output and extends past its bottom.
        let (x, y, w, h) = output_relative_region(output, bounds(1600, 1000, 2000, 2000));
        assert_eq!((x, y, w, h), (0, 1000, 1680, 440));
    }

    #[test]
    fn relative_region_inside_output_is_translated_not_clamped() {
        let output = output(0, 0, 0, 1920, 1080);
        let (x, y, w, h) = output_relative_region(output, bounds(100, 200, 800, 600));
        assert_eq!((x, y, w, h), (100, 200, 800, 600));
    }

    #[test]
    fn relative_region_on_offset_monitor_uses_output_origin() {
        let output = output(2, 1920, 0, 2560, 1440);
        let (x, y, w, h) = output_relative_region(output, bounds(2120, 120, 640, 480));
        assert_eq!((x, y, w, h), (200, 120, 640, 480));
    }
}
