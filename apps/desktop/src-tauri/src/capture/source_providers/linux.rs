//! Linux capture source enumeration.
//!
//! X11: monitors come from `xrandr --listmonitors` (falling back to a single
//! `xdpyinfo` full-screen entry when xrandr is missing), and windows from the
//! root window's `_NET_CLIENT_LIST` + `xwininfo` geometry. Wayland exposes no
//! protocol-level window/monitor listing — the compositor's portal picker
//! performs the actual selection at recording start, so the entries are
//! honest placeholders that tell the user what will happen.

use std::process::Command;

use crate::capture::source::{Bounds, CaptureSource};
use crate::capture::traits::SourceProvider;
use crate::errors::Result;

/// Cap on enumerated windows — `_NET_CLIENT_LIST` can carry dozens of helper
/// surfaces nobody wants to record.
const MAX_WINDOWS: usize = 32;

#[derive(Debug, Default)]
pub struct LinuxSourceProvider;

impl SourceProvider for LinuxSourceProvider {
    fn enumerate_sources(&self) -> Result<Vec<CaptureSource>> {
        let mut sources = Vec::new();

        if crate::capture::linux_portal::is_wayland_session() {
            // Wayland: the portal shows its own source picker; these entries
            // describe intent, not a pre-enumerated list.
            sources.push(CaptureSource {
                kind: "display".into(),
                id: "wayland-portal-screen".into(),
                name: "Screen (choose in system dialog)".into(),
                bounds: Bounds {
                    x: 0,
                    y: 0,
                    width: 1920,
                    height: 1080,
                },
            });
            sources.push(CaptureSource {
                kind: "window".into(),
                id: "wayland-portal-window".into(),
                name: "Window (choose in system dialog)".into(),
                bounds: Bounds {
                    x: 0,
                    y: 0,
                    width: 1280,
                    height: 720,
                },
            });
        } else {
            let monitors = enumerate_x11_monitors();
            if monitors.is_empty() {
                sources.push(CaptureSource {
                    kind: "display".into(),
                    id: "display-0".into(),
                    name: "Entire screen".into(),
                    bounds: x11_screen_bounds().unwrap_or(Bounds {
                        x: 0,
                        y: 0,
                        width: 1920,
                        height: 1080,
                    }),
                });
            } else {
                for (i, mon) in monitors.iter().enumerate() {
                    sources.push(CaptureSource {
                        kind: "display".into(),
                        id: format!("display-{i}"),
                        name: if mon.primary {
                            format!("{} (primary)", mon.name)
                        } else {
                            mon.name.clone()
                        },
                        bounds: mon.bounds,
                    });
                }
            }

            for window in enumerate_x11_windows() {
                sources.push(CaptureSource {
                    kind: "window".into(),
                    // Decimal id so `parse_window_handle` (usize) can read it back.
                    id: format!("win-{}", window.id),
                    name: window.title,
                    bounds: window.bounds,
                });
            }
        }

        tracing::info!(
            count = sources.len(),
            wayland = crate::capture::linux_portal::is_wayland_session(),
            "enumerated Linux capture sources"
        );
        Ok(sources)
    }

    fn refresh_window_bounds(&self, source: &CaptureSource) -> Option<Bounds> {
        if crate::capture::linux_portal::is_wayland_session() {
            return None;
        }
        let window_id = source.id.strip_prefix("win-")?.parse::<u64>().ok()?;
        x11_window_geometry(window_id)
    }
}

// ---------------------------------------------------------------------------
// X11 enumeration
// ---------------------------------------------------------------------------

#[derive(Debug, PartialEq)]
struct X11Monitor {
    name: String,
    primary: bool,
    bounds: Bounds,
}

/// `xrandr --listmonitors` output:
/// ```text
/// Monitors: 2
///  0: +*eDP-1 1920/344x1080/194+0+0  eDP-1
///  1: +HDMI-1 2560/597x1440/336+1920+0  HDMI-1
/// ```
fn enumerate_x11_monitors() -> Vec<X11Monitor> {
    let output = Command::new("xrandr")
        .arg("--listmonitors")
        .env("LC_ALL", "C")
        .output();
    let Ok(output) = output else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    parse_xrandr_listmonitors(&String::from_utf8_lossy(&output.stdout))
}

fn parse_xrandr_listmonitors(text: &str) -> Vec<X11Monitor> {
    let mut monitors = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        // Monitor rows start with "<index>:" — the header is "Monitors: N".
        if !line
            .chars()
            .next()
            .map(|c| c.is_ascii_digit())
            .unwrap_or(false)
        {
            continue;
        }
        let mut tokens = line.split_whitespace();
        // Row: "<idx>: +*name W/mmxH/mm+X+Y  outputs" — the primary flag ('+*'
        // or '+') rides on the monitor name token; geometry is token 2.
        let index = tokens.next();
        let name_token = tokens.next();
        let geom = tokens.next();
        let (Some(_), Some(name_token), Some(geom)) = (index, name_token, geom) else {
            continue;
        };
        let primary = name_token.starts_with("+*");
        let name = name_token.trim_start_matches('+').trim_start_matches('*');
        let Some((w, h, x, y)) = parse_monitor_geometry(geom) else {
            continue;
        };
        monitors.push(X11Monitor {
            name: name.to_string(),
            primary,
            bounds: Bounds {
                x,
                y,
                width: w,
                height: h,
            },
        });
    }
    monitors
}

/// Parse `1920/344x1080/194+0+0` → (w, h, x, y). The /MM suffixes are optional.
fn parse_monitor_geometry(spec: &str) -> Option<(i32, i32, i32, i32)> {
    // Format: W/mmxH/mm+X+Y — the first '+' separates the size from X+Y.
    let (size, offsets) = spec.split_once('+')?;
    let (x_part, y_part) = offsets.split_once('+')?;
    let (w_part, h_part) = size.split_once('x')?;

    let w = w_part.split('/').next()?.parse::<i32>().ok()?;
    let h = h_part.split('/').next()?.parse::<i32>().ok()?;
    let x = x_part.parse::<i32>().ok()?;
    let y = y_part.parse::<i32>().ok()?;
    Some((w, h, x, y))
}

/// Total screen size via `xdpyinfo` — used when xrandr is unavailable.
fn x11_screen_bounds() -> Option<Bounds> {
    let output = Command::new("xdpyinfo")
        .arg("-display")
        .arg(std::env::var("DISPLAY").unwrap_or_else(|_| ":0".into()))
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    for line in text.lines() {
        if let Some(dim) = line.split("dimensions:").nth(1) {
            let dim = dim.split_whitespace().next()?;
            let (w, h) = dim.split_once('x')?;
            let (w, h) = (w.parse::<i32>().ok()?, h.parse::<i32>().ok()?);
            return Some(Bounds {
                x: 0,
                y: 0,
                width: w,
                height: h,
            });
        }
    }
    None
}

#[derive(Debug)]
struct X11Window {
    id: u64,
    title: String,
    bounds: Bounds,
}

fn enumerate_x11_windows() -> Vec<X11Window> {
    let output = Command::new("xprop")
        .args(["-root", "_NET_CLIENT_LIST"])
        .env("LC_ALL", "C")
        .output();
    let Ok(output) = output else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let ids = parse_client_list(&text);

    let mut windows = Vec::new();
    for id in ids.into_iter().take(MAX_WINDOWS) {
        let Some((title, bounds)) = x11_window_info(id) else {
            continue;
        };
        if bounds.width <= 1 || bounds.height <= 1 {
            continue;
        }
        windows.push(X11Window { id, title, bounds });
    }
    windows
}

/// `_NET_CLIENT_LIST` is a comma-separated list of hex window ids.
fn parse_client_list(text: &str) -> Vec<u64> {
    text.split('#')
        .nth(1)
        .map(|list| {
            list.split(',')
                .filter_map(|tok| {
                    let tok = tok.trim().trim_end_matches('.');
                    u64::from_str_radix(tok.trim_start_matches("0x"), 16).ok()
                })
                .collect()
        })
        .unwrap_or_default()
}

/// `xwininfo -id <id> -stats` — name and geometry in one call.
fn x11_window_info(id: u64) -> Option<(String, Bounds)> {
    let output = Command::new("xwininfo")
        .args(["-id", &format!("{id:#x}"), "-stats"])
        .env("LC_ALL", "C")
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let mut title = String::new();
    let mut x = None;
    let mut y = None;
    let mut w = None;
    let mut h = None;
    for line in text.lines() {
        let line = line.trim();
        if line.contains("Window id:") && line.contains('"') {
            title = line.split('"').nth(1).unwrap_or("").to_string();
        } else if let Some(v) = line.strip_prefix("Absolute upper-left X:") {
            x = v.trim().parse::<i32>().ok();
        } else if let Some(v) = line.strip_prefix("Absolute upper-left Y:") {
            y = v.trim().parse::<i32>().ok();
        } else if let Some(v) = line.strip_prefix("Width:") {
            w = v.trim().parse::<i32>().ok();
        } else if let Some(v) = line.strip_prefix("Height:") {
            h = v.trim().parse::<i32>().ok();
        }
    }
    Some((
        if title.is_empty() {
            format!("Window {id:#x}")
        } else {
            title
        },
        Bounds {
            x: x?,
            y: y?,
            width: w?,
            height: h?,
        },
    ))
}

fn x11_window_geometry(id: u64) -> Option<Bounds> {
    x11_window_info(id).map(|(_, bounds)| bounds)
}

#[cfg(test)]
mod tests {
    use super::*;

    const XRANDR_FIXTURE: &str = "\
Monitors: 2
 0: +*eDP-1 1920/344x1080/194+0+0  eDP-1
 1: +HDMI-1 2560/597x1440/336+1920+0  HDMI-1
";

    #[test]
    fn parses_xrandr_listmonitors() {
        let monitors = parse_xrandr_listmonitors(XRANDR_FIXTURE);
        assert_eq!(monitors.len(), 2);
        assert!(monitors[0].primary);
        assert_eq!(monitors[0].name, "eDP-1");
        assert_eq!(
            monitors[0].bounds,
            Bounds {
                x: 0,
                y: 0,
                width: 1920,
                height: 1080
            }
        );
        assert!(!monitors[1].primary);
        assert_eq!(monitors[1].bounds.x, 1920);
        assert_eq!(monitors[1].bounds.width, 2560);
    }

    #[test]
    fn parses_client_list() {
        let text = "_NET_CLIENT_LIST(WINDOW): window id # 0x4600004, 0x480000a, 0x3c00001.";
        assert_eq!(
            parse_client_list(text),
            vec![0x4600004, 0x480000a, 0x3c00001]
        );
    }
}
