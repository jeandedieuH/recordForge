//! macOS-only CoreGraphics/AVFoundation helpers shared by the capture layer:
//! display + window enumeration, AVFoundation `Capture screen N` resolution,
//! and TCC permission preflights.
//!
//! Every unsafe FFI boundary for macOS lives in this one module so the rest
//! of the crate stays portable and the unsafe surface is easy to review.

#![cfg(target_os = "macos")]

use std::ffi::{c_char, c_void};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use core_foundation::array::CFArray;
use core_foundation::base::TCFType;
use core_foundation::boolean::CFBoolean;
use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
use core_foundation::number::CFNumber;
use core_foundation::runloop::kCFRunLoopDefaultMode;
use core_foundation::string::{CFString, CFStringRef};
use core_graphics::display::{CGDirectDisplayID, CGDisplay};
use core_graphics::geometry::CGRect;
use core_graphics::window::{
    kCGNullWindowID, kCGWindowBounds, kCGWindowIsOnscreen, kCGWindowLayer,
    kCGWindowListExcludeDesktopElements, kCGWindowListOptionOnScreenOnly, kCGWindowName,
    kCGWindowNumber, kCGWindowOwnerName, kCGWindowOwnerPID, CGWindowListCopyWindowInfo,
};

use super::screencapturekit::{SckDisplay, SckShareableContent, SckWindow};
use super::source::{Bounds, CaptureSource};

// ---------------------------------------------------------------------------
// Displays
// ---------------------------------------------------------------------------

/// One physical display, in `CGGetActiveDisplayList` order — the same order
/// FFmpeg's AVFoundation backend uses for its `Capture screen N` devices.
#[derive(Debug, Clone)]
pub struct MacosDisplay {
    /// Index into the CG display list == the N in `Capture screen N`.
    pub index: usize,
    pub display_id: CGDirectDisplayID,
    /// Global desktop bounds in physical pixels — the same space Tauri
    /// `Monitor::position()`/`size()` report and the region picker emits.
    pub bounds: Bounds,
    /// Logical (point-space) bounds; `CGWindowListCopyWindowInfo` reports
    /// window rects in points, so window→display matching happens here.
    point_bounds: CGRect,
    /// Backing scale factor (points → pixels).
    pub scale: f64,
    pub is_main: bool,
}

/// Enumerate every active display. An empty result means the window server
/// refused the query (headless/SSH session) — callers should fall back to a
/// single synthetic display rather than erroring the whole source list.
pub fn enumerate_displays() -> Vec<MacosDisplay> {
    CGDisplay::active_displays()
        .unwrap_or_default()
        .iter()
        .enumerate()
        .map(|(index, &display_id)| {
            let display = CGDisplay::new(display_id);
            // CGDisplayBounds is in points; physical pixels are what the
            // recorder, region picker, and Tauri monitors all speak.
            let point_bounds = display.bounds();
            let scale_x = points_to_pixels(display.pixels_wide() as f64, point_bounds.size.width);
            let scale_y = points_to_pixels(display.pixels_high() as f64, point_bounds.size.height);
            MacosDisplay {
                index,
                display_id,
                bounds: Bounds {
                    x: (point_bounds.origin.x * scale_x).round() as i32,
                    y: (point_bounds.origin.y * scale_y).round() as i32,
                    width: display.pixels_wide() as i32,
                    height: display.pixels_high() as i32,
                },
                point_bounds,
                scale: scale_x.max(scale_y).max(1.0),
                is_main: display.is_main(),
            }
        })
        .collect()
}

fn points_to_pixels(pixels: f64, points: f64) -> f64 {
    if points > 0.0 {
        pixels / points
    } else {
        1.0
    }
}

// ---------------------------------------------------------------------------
// Windows (CGWindowListCopyWindowInfo)
// ---------------------------------------------------------------------------

/// Enumerate on-screen, normal-layer application windows. Returns an empty
/// vec when the window server refuses the list — e.g. headless sessions —
/// mirroring the display-side degrade.
pub fn enumerate_windows() -> Vec<SckWindow> {
    let displays = enumerate_displays();
    enumerate_windows_for_displays(&displays)
}

fn enumerate_windows_for_displays(displays: &[MacosDisplay]) -> Vec<SckWindow> {
    let options = kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements;
    // SAFETY: returns a +1 CFArrayRef we immediately wrap under create rule.
    let raw = unsafe { CGWindowListCopyWindowInfo(options, kCGNullWindowID) };
    if raw.is_null() {
        tracing::warn!("CGWindowListCopyWindowInfo returned null");
        return Vec::new();
    }
    let list: CFArray<CFDictionary> = unsafe { CFArray::wrap_under_create_rule(raw) };

    let own_pid = i64::from(std::process::id());
    let mut windows = Vec::new();
    for dict in list.iter() {
        let Some(window) = window_from_dict(&dict, own_pid, displays) else {
            continue;
        };
        windows.push(window);
    }
    windows
}

fn window_from_dict(
    dict: &CFDictionary,
    own_pid: i64,
    displays: &[MacosDisplay],
) -> Option<SckWindow> {
    // Our own overlay/floating windows must never appear as capture sources.
    let pid = dict_i64(dict, unsafe { kCGWindowOwnerPID })?;
    if pid == own_pid {
        return None;
    }
    // Layer 0 is the normal application window layer; the menu bar, Dock,
    // status items, and overlays live on other layers.
    if dict_i64(dict, unsafe { kCGWindowLayer }) != Some(0) {
        return None;
    }
    // kCGWindowIsOnscreen is omitted rather than written for on-screen
    // windows under OptionOnScreenOnly — only an explicit `false` rejects.
    if dict_bool(dict, unsafe { kCGWindowIsOnscreen }) == Some(false) {
        return None;
    }
    let rect = dict_rect(dict, unsafe { kCGWindowBounds })?;
    if rect.size.width < 10.0 || rect.size.height < 10.0 {
        return None;
    }

    let owner = dict_string(dict, unsafe { kCGWindowOwnerName }).unwrap_or_default();
    let title = dict_string(dict, unsafe { kCGWindowName }).unwrap_or_default();
    if owner.is_empty() && title.is_empty() {
        return None;
    }

    // Point-space rect → physical pixels via the containing display's scale
    // (approximate for windows straddling displays with different scales).
    let scale = containing_display(displays, &rect)
        .map(|d| d.scale)
        .unwrap_or(1.0);

    Some(SckWindow {
        window_id: dict_i64(dict, unsafe { kCGWindowNumber })? as u32,
        title,
        owning_app_name: owner,
        owning_app_bundle_id: None,
        owning_app_pid: pid as i32,
        bounds: Bounds {
            x: (rect.origin.x * scale).round() as i32,
            y: (rect.origin.y * scale).round() as i32,
            width: (rect.size.width * scale).round() as i32,
            height: (rect.size.height * scale).round() as i32,
        },
        window_layer: 0,
        is_on_screen: true,
        is_active: true,
    })
}

/// The display whose point-space bounds contain the rect's center.
fn containing_display<'a>(displays: &'a [MacosDisplay], rect: &CGRect) -> Option<&'a MacosDisplay> {
    let cx = rect.origin.x + rect.size.width / 2.0;
    let cy = rect.origin.y + rect.size.height / 2.0;
    displays.iter().find(|d| {
        let b = d.point_bounds;
        cx >= b.origin.x
            && cx < b.origin.x + b.size.width
            && cy >= b.origin.y
            && cy < b.origin.y + b.size.height
    })
}

// ---------------------------------------------------------------------------
// Shareable content (feeds the existing SCK → CaptureSource mapping)
// ---------------------------------------------------------------------------

/// Real shareable content backed by CoreGraphics enumeration. Reuses the
/// `Sck*` shapes so `sck_content_to_capture_sources` (already unit-tested)
/// stays the single mapping point.
pub fn enumerate_shareable_content() -> SckShareableContent {
    let displays = enumerate_displays();
    let windows = enumerate_windows_for_displays(&displays);
    SckShareableContent {
        displays: displays
            .iter()
            .map(|d| SckDisplay {
                display_id: d.display_id,
                width: d.bounds.width.max(0) as u32,
                height: d.bounds.height.max(0) as u32,
                point_width: d.point_bounds.size.width,
                point_height: d.point_bounds.size.height,
                scale_factor: d.scale,
                bounds: d.bounds,
            })
            .collect(),
        windows,
        applications: Vec::new(),
    }
}

// ---------------------------------------------------------------------------
// Screen-input resolution for the FFmpeg AVFoundation backend
// ---------------------------------------------------------------------------

/// The FFmpeg `-i` video-side spec plus an optional display-relative crop
/// for region/window sources (avfoundation can only ingest whole displays —
/// cropping happens in the shared video filter).
pub struct MacosScreenInput {
    pub device_spec: String,
    pub crop: Option<Bounds>,
    /// The resolved CG display — the SCK path needs `display_id` to match an
    /// `SCDisplay`, so it rides along even when only `device_spec` is used.
    pub display: Option<MacosDisplay>,
}

/// Map a capture source to its AVFoundation screen device and crop rect.
///
/// `Capture screen N` devices follow `CGGetActiveDisplayList` order, so the
/// display index resolved here is the N in the device name. The parsed
/// device-list index is preferred for `-i` (it is unambiguous even when the
/// camera list shifts); the device name is the fallback when enumeration
/// fails (missing binary, exotic ffmpeg build).
pub fn resolve_screen_input(ffmpeg_path: &str, source: &CaptureSource) -> MacosScreenInput {
    let displays = enumerate_displays();
    let display_index = target_display_index(&displays, source).unwrap_or(0);
    let (display, crop) = resolve_display_crop_from(&displays, display_index, source);

    let device_spec = super::devices::list_avfoundation_screen_devices(ffmpeg_path)
        .ok()
        .and_then(|screens| {
            screens
                .iter()
                .find(|screen| screen.display_index == display_index)
                .map(|screen| screen.device_index.to_string())
        })
        .unwrap_or_else(|| format!("Capture screen {display_index}"));

    MacosScreenInput {
        device_spec,
        crop,
        display,
    }
}

/// Display + display-relative crop resolution without the AVFoundation
/// device query — the SCK path needs no ffmpeg device spec.
pub fn resolve_display_crop(source: &CaptureSource) -> (Option<MacosDisplay>, Option<Bounds>) {
    let displays = enumerate_displays();
    let display_index = target_display_index(&displays, source).unwrap_or(0);
    resolve_display_crop_from(&displays, display_index, source)
}

fn resolve_display_crop_from(
    displays: &[MacosDisplay],
    display_index: usize,
    source: &CaptureSource,
) -> (Option<MacosDisplay>, Option<Bounds>) {
    let display = displays.get(display_index).or(displays.first()).cloned();
    let crop = match source.kind.as_str() {
        "region" | "window" => Some(match &display {
            Some(display) => display_relative_crop(display, &source.bounds),
            // No display info at all: assume the primary display at (0,0),
            // which is the common single-monitor case.
            None => source.bounds,
        }),
        _ => None,
    };
    (display, crop)
}

/// `display-N` ids pin the display explicitly; region/window sources resolve
/// to the display containing their center point.
fn target_display_index(displays: &[MacosDisplay], source: &CaptureSource) -> Option<usize> {
    if source.kind == "display" {
        if let Some(index) = source
            .id
            .strip_prefix("display-")
            .and_then(|n| n.parse::<usize>().ok())
        {
            return Some(index.min(displays.len().saturating_sub(1)));
        }
    }
    let cx = source.bounds.x + source.bounds.width / 2;
    let cy = source.bounds.y + source.bounds.height / 2;
    displays.iter().position(|d| {
        cx >= d.bounds.x
            && cx < d.bounds.x + d.bounds.width
            && cy >= d.bounds.y
            && cy < d.bounds.y + d.bounds.height
    })
}

/// Global physical-space bounds → crop rect in the captured display's own
/// pixel space, clamped so an offscreen or minimized window yields the
/// visible portion rather than an invalid ffmpeg `crop=` argument.
fn display_relative_crop(display: &MacosDisplay, bounds: &Bounds) -> Bounds {
    let rel_x = bounds.x - display.bounds.x;
    let rel_y = bounds.y - display.bounds.y;
    let x0 = rel_x.clamp(0, display.bounds.width);
    let y0 = rel_y.clamp(0, display.bounds.height);
    let x1 = (rel_x + bounds.width).clamp(x0, display.bounds.width);
    let y1 = (rel_y + bounds.height).clamp(y0, display.bounds.height);
    Bounds {
        x: x0,
        y: y0,
        width: (x1 - x0).max(2),
        height: (y1 - y0).max(2),
    }
}

// ---------------------------------------------------------------------------
// Cursor telemetry (CGEvent / CoreGraphics)
// ---------------------------------------------------------------------------

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventCreate(source: *const c_void) -> *mut c_void;
    fn CGEventGetLocation(event: *const c_void) -> core_graphics::geometry::CGPoint;
    fn CGEventSourceButtonState(state_id: i32, button: u32) -> bool;
    fn CGCursorIsVisible() -> bool;
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFRelease(cf: *const c_void);
}

/// `kCGEventSourceStateHIDSystemState` — the physical-input event source.
const K_CG_EVENT_SOURCE_STATE_HID: i32 = 1;

/// Current cursor position in the global *physical pixel* space the recorder
/// uses everywhere (Tauri monitor space, `Bounds`). `CGEvent` reports Quartz
/// point coordinates — Retina displays map 2 px per point, so the point is
/// re-scaled through the containing display's factor. `None` when the event
/// could not be created (headless).
pub fn cursor_position_physical() -> Option<(i32, i32)> {
    let event = unsafe { CGEventCreate(std::ptr::null()) };
    if event.is_null() {
        return None;
    }
    // SAFETY: `event` is a +1 CGEventRef we own; CFRelease drops it exactly once.
    let point = unsafe { CGEventGetLocation(event) };
    unsafe { CFRelease(event) };

    let displays = enumerate_displays();
    Some(point_to_physical(point, &displays))
}

/// Convert a Quartz point-space position to global physical pixels using the
/// display that contains the point (fallback: the primary display's scale).
fn point_to_physical(
    point: core_graphics::geometry::CGPoint,
    displays: &[MacosDisplay],
) -> (i32, i32) {
    let display = containing_display(
        displays,
        &CGRect::new(&point, &core_graphics::geometry::CGSize::new(0.0, 0.0)),
    )
    .or(displays.first());
    match display {
        Some(d) => {
            let rel_x = point.x - d.point_bounds.origin.x;
            let rel_y = point.y - d.point_bounds.origin.y;
            (
                (d.bounds.x as f64 + rel_x * d.scale).round() as i32,
                (d.bounds.y as f64 + rel_y * d.scale).round() as i32,
            )
        }
        // Headless: report the point value unchanged (1:1 scale assumption).
        None => (point.x.round() as i32, point.y.round() as i32),
    }
}

/// Whether the system cursor is currently drawn.
pub fn cursor_visible() -> bool {
    unsafe { CGCursorIsVisible() }
}

/// Current mouse-button pressed state: (left, right, middle, x1, x2) —
/// `CGEventSourceButtonState` uses the same button ordinals as CGMouseButton.
pub fn mouse_button_state() -> (bool, bool, bool, bool, bool) {
    let down =
        |button: u32| unsafe { CGEventSourceButtonState(K_CG_EVENT_SOURCE_STATE_HID, button) };
    (down(0), down(1), down(2), down(3), down(4))
}

// ---------------------------------------------------------------------------
// TCC permissions
// ---------------------------------------------------------------------------

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
}

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> bool;
    fn AXIsProcessTrustedWithOptions(options: CFDictionaryRef) -> bool;
    static kAXTrustedCheckOptionPrompt: CFStringRef;
}

#[link(name = "AVFoundation", kind = "framework")]
extern "C" {
    static AVMediaTypeVideo: *const c_void;
    static AVMediaTypeAudio: *const c_void;
}

extern "C" {
    fn objc_getClass(name: *const c_char) -> *mut c_void;
    fn sel_registerName(name: *const c_char) -> *mut c_void;
    fn objc_msgSend(receiver: *mut c_void, op: *mut c_void, ...) -> *mut c_void;
}

/// AVAuthorizationStatus values relevant to mapping onto PermissionStatus.
/// 0 = notDetermined, 1 = restricted, 2 = denied, 3 = authorized.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AvAuthorization {
    NotDetermined,
    Restricted,
    Denied,
    Authorized,
    /// AVCaptureDevice/AVMediaType symbols could not be resolved.
    Unknown,
}

pub enum AvMediaKind {
    Video,
    Audio,
}

/// `+[AVCaptureDevice authorizationStatusForMediaType:]`.
pub fn av_authorization_status(media: AvMediaKind) -> AvAuthorization {
    type FnStatus = unsafe extern "C" fn(*mut c_void, *mut c_void, *const c_void) -> i64;
    unsafe {
        let class = objc_getClass(c"AVCaptureDevice".as_ptr());
        if class.is_null() {
            return AvAuthorization::Unknown;
        }
        let media_type = match media {
            AvMediaKind::Video => AVMediaTypeVideo,
            AvMediaKind::Audio => AVMediaTypeAudio,
        };
        if media_type.is_null() {
            return AvAuthorization::Unknown;
        }
        let msg_send: FnStatus = std::mem::transmute(objc_msgSend as *const ());
        let status = msg_send(
            class,
            sel_registerName(c"authorizationStatusForMediaType:".as_ptr()),
            media_type,
        );
        match status {
            0 => AvAuthorization::NotDetermined,
            1 => AvAuthorization::Restricted,
            2 => AvAuthorization::Denied,
            3 => AvAuthorization::Authorized,
            _ => AvAuthorization::Unknown,
        }
    }
}

/// `CGPreflightScreenCaptureAccess` — the truthful TCC preflight for screen
/// capture. Never prompts; use `request_screen_recording_access` for that.
pub fn screen_recording_granted() -> bool {
    unsafe { CGPreflightScreenCaptureAccess() }
}

/// `CGRequestScreenCaptureAccess` — triggers the system prompt when status
/// is undetermined. Returns the *current* authorization state: on first run
/// macOS reports false even while the prompt is showing, and the grant only
/// becomes effective after the app is relaunched.
pub fn request_screen_recording_access() -> bool {
    unsafe { CGRequestScreenCaptureAccess() }
}

/// `AXIsProcessTrusted` — accessibility trust needed for input monitoring.
pub fn accessibility_trusted() -> bool {
    unsafe { AXIsProcessTrusted() }
}

/// `AXIsProcessTrustedWithOptions(prompt: true)` — opens the assistive-
/// access prompt and returns the current trust state.
pub fn request_accessibility_access() -> bool {
    // SAFETY: kAXTrustedCheckOptionPrompt is a valid CFStringRef static; the
    // dictionary is a borrowed read within the FFI call.
    let key = unsafe { CFString::wrap_under_get_rule(kAXTrustedCheckOptionPrompt) };
    let options = CFDictionary::from_CFType_pairs(&[(key, CFBoolean::true_value())]);
    unsafe { AXIsProcessTrustedWithOptions(options.as_concrete_TypeRef()) }
}

// ---------------------------------------------------------------------------
// CFDictionary extraction helpers
// ---------------------------------------------------------------------------

fn dict_value(dict: &CFDictionary, key: CFStringRef) -> Option<*const c_void> {
    dict.find(key as *const c_void).map(|value| *value)
}

fn dict_string(dict: &CFDictionary, key: CFStringRef) -> Option<String> {
    let value = dict_value(dict, key)?;
    if value.is_null() {
        return None;
    }
    // SAFETY: window-info dictionary entries are live CFTypeRefs owned by
    // the parent array; wrap_under_get_rule borrows without retaining.
    Some(unsafe { CFString::wrap_under_get_rule(value as CFStringRef) }.to_string())
}

fn dict_i64(dict: &CFDictionary, key: CFStringRef) -> Option<i64> {
    let value = dict_value(dict, key)?;
    if value.is_null() {
        return None;
    }
    unsafe { CFNumber::wrap_under_get_rule(value as _) }.to_i64()
}

fn dict_f64(dict: &CFDictionary, key: CFStringRef) -> Option<f64> {
    let value = dict_value(dict, key)?;
    if value.is_null() {
        return None;
    }
    unsafe { CFNumber::wrap_under_get_rule(value as _) }.to_f64()
}

fn dict_bool(dict: &CFDictionary, key: CFStringRef) -> Option<bool> {
    let value = dict_value(dict, key)?;
    if value.is_null() {
        return None;
    }
    Some(bool::from(unsafe {
        CFBoolean::wrap_under_get_rule(value as _)
    }))
}

/// `kCGWindowBounds` carries a nested CFDictionary keyed by the literal
/// strings X/Y/Width/Height — parse it into a CGRect (points).
fn dict_rect(dict: &CFDictionary, key: CFStringRef) -> Option<CGRect> {
    let value = dict_value(dict, key)?;
    if value.is_null() {
        return None;
    }
    let bounds_dict = unsafe { CFDictionary::wrap_under_get_rule(value as CFDictionaryRef) };
    let get = |name: &'static str| -> Option<f64> {
        let key = CFString::new(name);
        dict_f64(&bounds_dict, key.as_concrete_TypeRef())
    };
    Some(CGRect::new(
        &core_graphics::geometry::CGPoint::new(get("X")?, get("Y")?),
        &core_graphics::geometry::CGSize::new(get("Width")?, get("Height")?),
    ))
}

// ---------------------------------------------------------------------------
// Keystroke event tap (CGEventTap + CFRunLoop)
// ---------------------------------------------------------------------------

/// One modifier-combination press observed by the key tap — the caller maps
/// it into the shared `KeystrokeEvent` shape.
pub struct KeyTapPress {
    pub t_ms: u64,
    pub key: &'static str,
    pub modifiers: Vec<super::keystrokes::KeystrokeModifier>,
}

/// Run a CGEventTap on this thread's run loop until `stop` flips, returning
/// structured presses for every modifier-combination key press observed.
/// The tap needs Accessibility trust — when missing, `CGEventTap` fails to
/// install and we emit nothing rather than fake capture.
pub fn run_key_tap(origin: Instant, stop: Arc<AtomicBool>) -> Vec<KeyTapPress> {
    use core_foundation::runloop::CFRunLoop;
    use core_graphics::event::{
        CGEventFlags, CGEventTap, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement,
        CGEventType, CallbackResult, EventField,
    };

    if !accessibility_trusted() {
        tracing::warn!(
            "keystroke capture skipped: accessibility permission not granted (Privacy & Security → Accessibility)"
        );
        return Vec::new();
    }

    let events = Mutex::new(Vec::new());
    // `with_enabled` installs the tap on this thread's run loop, runs the
    // closure below, and tears the tap down when it returns — the borrow of
    // `events` stays scoped, no 'static boxing needed.
    let result = CGEventTap::with_enabled(
        CGEventTapLocation::Session,
        CGEventTapPlacement::HeadInsertEventTap,
        CGEventTapOptions::ListenOnly,
        vec![CGEventType::KeyDown],
        |_proxy, event_type, event| {
            if !matches!(event_type, CGEventType::KeyDown) {
                return CallbackResult::Keep;
            }
            // Auto-repeat repeats keyDown with the autorepeat field set —
            // edge-trigger only, matching the Windows sampler's behaviour.
            if event.get_integer_value_field(EventField::KEYBOARD_EVENT_AUTOREPEAT) != 0 {
                return CallbackResult::Keep;
            }
            let flags = event.get_flags();
            let ctrl = flags.contains(CGEventFlags::CGEventFlagControl);
            let alt = flags.contains(CGEventFlags::CGEventFlagAlternate);
            let shift = flags.contains(CGEventFlags::CGEventFlagShift);
            let cmd = flags.contains(CGEventFlags::CGEventFlagCommand);
            // Same privacy rule as the Windows sampler: plain typing never
            // produces an event — only presses with a held modifier do.
            if ctrl || alt || shift || cmd {
                let keycode = event.get_integer_value_field(EventField::KEYBOARD_EVENT_KEYCODE);
                if let Some(name) = macos_key_name(keycode) {
                    let t_ms = origin.elapsed().as_millis().min(u64::MAX as u128) as u64;
                    let mut modifiers = Vec::with_capacity(4);
                    if ctrl {
                        modifiers.push(super::keystrokes::KeystrokeModifier::Ctrl);
                    }
                    if alt {
                        modifiers.push(super::keystrokes::KeystrokeModifier::Alt);
                    }
                    if shift {
                        modifiers.push(super::keystrokes::KeystrokeModifier::Shift);
                    }
                    if cmd {
                        modifiers.push(super::keystrokes::KeystrokeModifier::Meta);
                    }
                    if let Ok(mut guard) = events.lock() {
                        guard.push(KeyTapPress {
                            t_ms,
                            key: name,
                            modifiers,
                        });
                    }
                }
            }
            CallbackResult::Keep
        },
        || {
            // Pump in bounded slices so the stop flag is polled even when the
            // session goes quiet — the tap otherwise only wakes on key input.
            while !stop.load(Ordering::Acquire) {
                CFRunLoop::run_in_mode(
                    unsafe { kCFRunLoopDefaultMode },
                    Duration::from_millis(100),
                    true,
                );
            }
        },
    );
    if result.is_err() {
        tracing::warn!("CGEventTap failed to install; keystroke capture disabled");
    }
    events.into_inner().unwrap_or_default()
}

/// macOS virtual keycode (`kVK_*`) → display name. Mirrors the Windows VK
/// table so export labels match across platforms.
fn macos_key_name(keycode: i64) -> Option<&'static str> {
    Some(match keycode {
        0x00 => "A",
        0x0B => "B",
        0x08 => "C",
        0x02 => "D",
        0x0E => "E",
        0x03 => "F",
        0x05 => "G",
        0x04 => "H",
        0x22 => "I",
        0x26 => "J",
        0x28 => "K",
        0x25 => "L",
        0x2E => "M",
        0x2D => "N",
        0x1F => "O",
        0x23 => "P",
        0x0C => "Q",
        0x0F => "R",
        0x01 => "S",
        0x11 => "T",
        0x20 => "U",
        0x09 => "V",
        0x0D => "W",
        0x07 => "X",
        0x10 => "Y",
        0x06 => "Z",
        0x1D => "0",
        0x12 => "1",
        0x13 => "2",
        0x14 => "3",
        0x15 => "4",
        0x17 => "5",
        0x16 => "6",
        0x1A => "7",
        0x1C => "8",
        0x19 => "9",
        0x7A => "F1",
        0x78 => "F2",
        0x63 => "F3",
        0x76 => "F4",
        0x60 => "F5",
        0x61 => "F6",
        0x62 => "F7",
        0x64 => "F8",
        0x65 => "F9",
        0x6D => "F10",
        0x67 => "F11",
        0x6F => "F12",
        0x24 => "Enter",
        0x35 => "Esc",
        0x30 => "Tab",
        0x31 => "Space",
        0x33 => "Backspace",
        0x75 => "Del",
        0x73 => "Home",
        0x77 => "End",
        0x74 => "PgUp",
        0x79 => "PgDn",
        0x7B => "Left",
        0x7E => "Up",
        0x7C => "Right",
        0x7D => "Down",
        0x29 => ";",
        0x18 => "=",
        0x2B => ",",
        0x1B => "-",
        0x2F => ".",
        0x2C => "/",
        0x32 => "`",
        0x21 => "[",
        0x2A => "\\",
        0x1E => "]",
        0x27 => "'",
        _ => return None,
    })
}
