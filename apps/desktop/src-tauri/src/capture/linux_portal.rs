//! Linux XDG Desktop Portal ScreenCast session negotiator.
//!
//! Mediates access to `org.freedesktop.portal.ScreenCast` over D-Bus when running
//! under Wayland. Explicitly requests `cursor_mode: 4` (`Metadata`) during
//! `SelectSources` so that the compositor delivers cursor positions and shapes as
//! `SPA_META_Cursor` stream metadata on the PipeWire video stream.

use serde::{Deserialize, Serialize};

/// Cursor modes supported by `org.freedesktop.portal.ScreenCast`.
#[repr(u32)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PortalCursorMode {
    /// Do not include the cursor in the stream.
    Hidden = 1,
    /// The cursor is rendered directly into the video buffer frames.
    Embedded = 2,
    /// The cursor is delivered as metadata on the PipeWire buffer (`SPA_META_Cursor`).
    Metadata = 4,
}

impl PortalCursorMode {
    pub fn from_u32(val: u32) -> Option<Self> {
        match val {
            1 => Some(Self::Hidden),
            2 => Some(Self::Embedded),
            4 => Some(Self::Metadata),
            _ => None,
        }
    }

    pub fn as_u32(&self) -> u32 {
        *self as u32
    }
}

/// Source types selectable in `SelectSources`.
#[repr(u32)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PortalSourceType {
    Monitor = 1,
    Window = 2,
    Any = 3,
}

/// Configuration options for a ScreenCast portal session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PortalScreenCastOptions {
    pub session_handle_token: String,
    pub source_type: PortalSourceType,
    pub multiple: bool,
    pub cursor_mode: PortalCursorMode,
    pub persist_mode: u32,
}

impl Default for PortalScreenCastOptions {
    fn default() -> Self {
        Self {
            session_handle_token: format!("rf_{}", uuid::Uuid::new_v4().simple()),
            source_type: PortalSourceType::Any,
            multiple: false,
            cursor_mode: PortalCursorMode::Metadata, // Explicitly default to mode 4 (Metadata)
            persist_mode: 0,
        }
    }
}

/// Information about a single PipeWire stream returned by the portal.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PortalStreamInfo {
    pub pipewire_node_id: u32,
    pub source_type: u32,
    pub position: Option<(i32, i32)>,
    pub size: Option<(u32, u32)>,
}

/// Active negotiated state of a Wayland ScreenCast portal session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PortalSessionState {
    pub session_handle: String,
    pub negotiated_cursor_mode: PortalCursorMode,
    pub streams: Vec<PortalStreamInfo>,
}

/// Negotiates a Wayland `org.freedesktop.portal.ScreenCast` session.
#[derive(Debug, Clone)]
pub struct PortalSessionNegotiator {
    pub options: PortalScreenCastOptions,
}

impl Default for PortalSessionNegotiator {
    fn default() -> Self {
        Self::new()
    }
}

impl PortalSessionNegotiator {
    pub fn new() -> Self {
        Self {
            options: PortalScreenCastOptions::default(),
        }
    }

    /// Override the requested cursor mode.
    pub fn with_cursor_mode(mut self, mode: PortalCursorMode) -> Self {
        self.options.cursor_mode = mode;
        self
    }

    /// Override the requested source type (monitor vs window vs any).
    pub fn with_source_type(mut self, source_type: PortalSourceType) -> Self {
        self.options.source_type = source_type;
        self
    }

    /// Returns the currently configured cursor mode (defaults to `PortalCursorMode::Metadata`).
    pub fn cursor_mode(&self) -> PortalCursorMode {
        self.options.cursor_mode
    }

    /// Build parameters for `org.freedesktop.portal.ScreenCast.CreateSession`.
    pub fn build_create_session_args(&self) -> serde_json::Value {
        serde_json::json!({
            "session_handle_token": self.options.session_handle_token,
            "handle_token": format!("req_{}", self.options.session_handle_token),
        })
    }

    /// Build parameters for `org.freedesktop.portal.ScreenCast.SelectSources`.
    /// Explicitly sets `cursor_mode: 4` (`Metadata`).
    pub fn build_select_sources_args(&self, session_handle: &str) -> serde_json::Value {
        serde_json::json!({
            "session_handle": session_handle,
            "types": self.options.source_type as u32,
            "multiple": self.options.multiple,
            "cursor_mode": self.options.cursor_mode.as_u32(), // mode 4 (Metadata)
            "persist_mode": self.options.persist_mode,
        })
    }

    /// Build parameters for `org.freedesktop.portal.ScreenCast.Start`.
    pub fn build_start_args(&self, session_handle: &str) -> serde_json::Value {
        serde_json::json!({
            "session_handle": session_handle,
            "handle_token": format!("start_{}", self.options.session_handle_token),
        })
    }

    /// Parse stream descriptors returned by `Start`, confirming granted cursor mode.
    pub fn parse_start_response(
        &self,
        session_handle: &str,
        streams_data: &[serde_json::Value],
        granted_cursor_mode: Option<u32>,
    ) -> Result<PortalSessionState, String> {
        let mut streams = Vec::new();
        for s in streams_data {
            let node_id = s
                .get("node_id")
                .and_then(|v| v.as_u64())
                .map(|v| v as u32)
                .ok_or_else(|| "missing node_id in portal stream descriptor".to_string())?;

            let source_type = s
                .get("source_type")
                .and_then(|v| v.as_u64())
                .map_or(1, |v| v as u32);

            let size = s.get("size").and_then(|v| {
                let w = v.get(0)?.as_u64()? as u32;
                let h = v.get(1)?.as_u64()? as u32;
                Some((w, h))
            });

            let position = s.get("position").and_then(|v| {
                let x = v.get(0)?.as_i64()? as i32;
                let y = v.get(1)?.as_i64()? as i32;
                Some((x, y))
            });

            streams.push(PortalStreamInfo {
                pipewire_node_id: node_id,
                source_type,
                position,
                size,
            });
        }

        if streams.is_empty() {
            return Err("no streams granted by portal".into());
        }

        // Detect if compositor granted requested mode (4) or downgraded (e.g. 2 for embedded)
        let negotiated_cursor_mode = granted_cursor_mode
            .and_then(PortalCursorMode::from_u32)
            .unwrap_or(self.options.cursor_mode);

        Ok(PortalSessionState {
            session_handle: session_handle.to_string(),
            negotiated_cursor_mode,
            streams,
        })
    }
}

/// Whether the current desktop session is Wayland (portal capture required)
/// or X11 (`x11grab` can be used directly). Wayland wins when both env vars
/// are present — `DISPLAY` exists on Wayland too via XWayland.
pub fn is_wayland_session() -> bool {
    #[cfg(target_os = "linux")]
    {
        if std::env::var_os("WAYLAND_DISPLAY").is_some() {
            return true;
        }
        std::env::var("XDG_SESSION_TYPE").is_ok_and(|v| v.eq_ignore_ascii_case("wayland"))
    }
    #[cfg(not(target_os = "linux"))]
    {
        false
    }
}

// ---------------------------------------------------------------------------
// Real D-Bus portal session (Linux only)
// ---------------------------------------------------------------------------

#[cfg(target_os = "linux")]
mod dbus_session {
    use super::*;
    use crate::errors::{InternalError, Result};
    use dbus::arg::{PropMap, RefArg, Variant};
    use dbus::blocking::Connection;
    use dbus::Path;
    use std::os::fd::{FromRawFd, IntoRawFd, OwnedFd};
    use std::time::Duration;
    use tracing::{debug, warn};

    const PORTAL_DEST: &str = "org.freedesktop.portal.Desktop";
    const PORTAL_PATH: &str = "/org/freedesktop/portal/desktop";
    const SCREENCAST_IFACE: &str = "org.freedesktop.portal.ScreenCast";
    const REQUEST_IFACE: &str = "org.freedesktop.portal.Request";
    const SESSION_IFACE: &str = "org.freedesktop.portal.Session";

    /// Method calls that trigger no user dialog get a bounded reply window.
    const METHOD_TIMEOUT: Duration = Duration::from_secs(30);
    /// Source-picker dialogs are human-paced; cap the total negotiation at
    /// ten minutes so a wedged portal can't wedge the recorder forever.
    const NEGOTIATION_TIMEOUT: Duration = Duration::from_secs(600);

    /// A live `org.freedesktop.portal.ScreenCast` session: sources selected,
    /// stream negotiated, PipeWire remote fd opened. Dropping it closes the
    /// portal session so the compositor's privacy indicator disappears.
    pub struct PortalScreenCastSession {
        conn: Connection,
        session_path: Path<'static>,
        state: PortalSessionState,
        pipewire_fd: Option<OwnedFd>,
    }

    impl PortalScreenCastSession {
        /// Run the full portal negotiation for `options`. Blocks while the
        /// source-picker dialog is on screen.
        pub fn open(options: &PortalScreenCastOptions) -> Result<Self> {
            let conn = Connection::new_session().map_err(|e| {
                InternalError::Capture(format!("portal: connect to session bus: {e}"))
            })?;
            let proxy = conn.with_proxy(PORTAL_DEST, PORTAL_PATH, METHOD_TIMEOUT);

            // CreateSession
            let mut options_map = PropMap::new();
            options_map.insert(
                "handle_token".into(),
                Variant(Box::new("req_create".to_string()) as Box<dyn RefArg>),
            );
            options_map.insert(
                "session_handle_token".into(),
                Variant(Box::new(options.session_handle_token.clone()) as Box<dyn RefArg>),
            );
            let (request_path,): (Path<'static>,) = proxy
                .method_call(SCREENCAST_IFACE, "CreateSession", (options_map,))
                .map_err(|e| map_portal_error("CreateSession", &e))?;
            let results = wait_for_response(&conn, &request_path, "CreateSession")?;
            let session_path = extract_path(&results, "session_handle").ok_or_else(|| {
                InternalError::Capture("portal CreateSession returned no session_handle".into())
            })?;
            debug!(%session_path, "portal session created");

            // SelectSources
            let mut select = PropMap::new();
            select.insert(
                "handle_token".into(),
                Variant(Box::new("req_select".to_string()) as Box<dyn RefArg>),
            );
            select.insert(
                "types".into(),
                Variant(Box::new(options.source_type as u32) as Box<dyn RefArg>),
            );
            select.insert(
                "multiple".into(),
                Variant(Box::new(options.multiple) as Box<dyn RefArg>),
            );
            select.insert(
                "cursor_mode".into(),
                Variant(Box::new(options.cursor_mode.as_u32()) as Box<dyn RefArg>),
            );
            select.insert(
                "persist_mode".into(),
                Variant(Box::new(options.persist_mode) as Box<dyn RefArg>),
            );
            let (request_path,): (Path<'static>,) = proxy
                .method_call(
                    SCREENCAST_IFACE,
                    "SelectSources",
                    (session_path.clone(), select),
                )
                .map_err(|e| map_portal_error("SelectSources", &e))?;
            wait_for_response(&conn, &request_path, "SelectSources")?;

            // Start — this is the call that shows the consent dialog.
            let (request_path,): (Path<'static>,) = proxy
                .method_call(
                    SCREENCAST_IFACE,
                    "Start",
                    (session_path.clone(), String::new(), PropMap::new()),
                )
                .map_err(|e| map_portal_error("Start", &e))?;
            let results = wait_for_response(&conn, &request_path, "Start")?;
            let streams = parse_portal_streams(&results)
                .ok_or_else(|| InternalError::Capture("portal Start returned no streams".into()))?;
            let session_handle = session_path.to_string();
            let cursor_mode = options.cursor_mode;
            let state = PortalSessionState {
                session_handle: session_handle.clone(),
                negotiated_cursor_mode: cursor_mode,
                streams,
            };
            debug!(?state.streams, "portal granted streams");

            // OpenPipeWireRemote hands us the remote fd for pw_context_connect_fd.
            let pipewire_fd = open_pipewire_remote(&conn, &session_path)?;
            debug!("portal PipeWire remote fd acquired");

            Ok(Self {
                conn,
                session_path,
                state,
                pipewire_fd: Some(pipewire_fd),
            })
        }

        pub fn state(&self) -> &PortalSessionState {
            &self.state
        }

        /// Steal the PipeWire remote fd; the session object keeps the portal
        /// grant alive until dropped.
        pub fn take_pipewire_fd(&mut self) -> OwnedFd {
            self.pipewire_fd
                .take()
                .expect("PipeWire remote fd already taken")
        }
    }

    impl Drop for PortalScreenCastSession {
        fn drop(&mut self) {
            // Best-effort session close — clears the compositor's recording
            // indicator immediately instead of waiting for the timeout.
            let proxy =
                self.conn
                    .with_proxy(PORTAL_DEST, self.session_path.clone(), METHOD_TIMEOUT);
            let res: std::result::Result<(), dbus::Error> =
                proxy.method_call(SESSION_IFACE, "Close", (PropMap::new(),));
            if let Err(e) = res {
                debug!(%e, "portal session close failed (already gone?)");
            }
        }
    }

    /// Wait for the `org.freedesktop.portal.Request::Response` signal emitted
    /// on `request_path`. `iter` returns every bus message; other signals are
    /// ignored. Response code 0 = success, 1 = user cancelled, 2 = error.
    fn wait_for_response(
        conn: &Connection,
        request_path: &Path<'static>,
        what: &str,
    ) -> Result<PropMap> {
        let deadline = std::time::Instant::now() + NEGOTIATION_TIMEOUT;
        loop {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() {
                break;
            }
            // blocking_pop drains already-queued messages first, then blocks;
            // unrelated signals are discarded and the wait resumes.
            let msg = match conn
                .channel()
                .blocking_pop_message(remaining.min(Duration::from_secs(30)))
            {
                Ok(Some(msg)) => msg,
                Ok(None) => continue,
                Err(e) => {
                    return Err(InternalError::Capture(format!(
                        "portal {what}: D-Bus error while waiting for a response: {e}"
                    ))
                    .into());
                }
            };
            let is_response = msg.msg_type() == dbus::MessageType::Signal
                && msg.path().is_some_and(|p| p == *request_path)
                && msg.interface().is_some_and(|i| i == REQUEST_IFACE)
                && msg.member().is_some_and(|m| m == "Response");
            if !is_response {
                continue;
            }
            let (code, results) = msg.get2::<u32, PropMap>();
            let code = code.unwrap_or(u32::MAX);
            return match code {
                0 => Ok(results.unwrap_or_default()),
                1 => Err(InternalError::Capture(format!(
                    "portal {what}: screen sharing cancelled by the user"
                ))
                .into()),
                _ => Err(InternalError::Capture(format!(
                    "portal {what}: portal returned error code {code}"
                ))
                .into()),
            };
        }
        Err(
            InternalError::Capture(format!("portal {what}: timed out waiting for a response"))
                .into(),
        )
    }

    /// Walk a `a{sv}` RefArg into a PropMap. Depending on how the iterator
    /// yields dicts, entries arrive either as `(key, value)` pair structs or
    /// as alternating key-then-value items — handle both shapes.
    fn propmap_from_iter(iter: &mut dyn Iterator<Item = &dyn RefArg>) -> PropMap {
        let mut map = PropMap::new();
        let mut pending_key: Option<String> = None;
        for item in iter {
            if let Some(k) = pending_key.take() {
                map.insert(k, Variant(item.box_clone()));
                continue;
            }
            if let Some(mut pair) = item.as_iter() {
                let key = pair.next().and_then(|k| k.as_str()).map(String::from);
                if let (Some(k), Some(v)) = (key, pair.next()) {
                    map.insert(k, Variant(v.box_clone()));
                    continue;
                }
            }
            pending_key = item.as_str().map(str::to_string);
        }
        map
    }

    fn extract_path(results: &PropMap, key: &str) -> Option<Path<'static>> {
        let variant = results.get(key)?;
        variant
            .0
            .as_str()
            .and_then(|s| Path::new(s.to_string()).ok())
    }

    /// Parse the `a(ua{sv})` `streams` result into `PortalStreamInfo`s.
    fn parse_portal_streams(results: &PropMap) -> Option<Vec<PortalStreamInfo>> {
        let streams_arg = results.get("streams")?.0.as_ref();
        let outer = streams_arg.as_iter()?;
        let mut streams = Vec::new();
        for entry in outer {
            let mut pair = match entry.as_iter() {
                Some(p) => p,
                None => continue,
            };
            let node_id = pair.next().and_then(|v| v.as_u64()).unwrap_or(0) as u32;
            let dict = match pair.next() {
                Some(d) => d,
                None => continue,
            };
            let mut info = PortalStreamInfo {
                pipewire_node_id: node_id,
                source_type: 1,
                position: None,
                size: None,
            };
            if let Some(mut dict_iter) = dict.as_iter() {
                let map = propmap_from_iter(&mut dict_iter);
                for (key, value) in &map {
                    match key.as_str() {
                        "source_type" => info.source_type = value.0.as_u64().unwrap_or(1) as u32,
                        "position" => {
                            info.position =
                                parse_point(value.0.as_ref()).map(|(x, y)| (x as i32, y as i32));
                        }
                        "size" => {
                            info.size =
                                parse_point(value.0.as_ref()).map(|(w, h)| (w as u32, h as u32));
                        }
                        _ => {}
                    }
                }
            }
            streams.push(info);
        }
        if streams.is_empty() {
            None
        } else {
            Some(streams)
        }
    }

    /// `(i,i)`/`(u,u)` tuples arrive as a two-element struct iterator.
    fn parse_point(arg: &dyn RefArg) -> Option<(i64, i64)> {
        let mut it = arg.as_iter()?;
        let x = it.next().and_then(|v| v.as_i64())?;
        let y = it.next().and_then(|v| v.as_i64())?;
        Some((x, y))
    }

    /// `OpenPipeWireRemote` returns signature `h` (Unix fd), decoded directly
    /// into `dbus::arg::OwnedFd` — the fd arrives already owned, no dup needed.
    fn open_pipewire_remote(conn: &Connection, session_path: &Path<'static>) -> Result<OwnedFd> {
        let proxy = conn.with_proxy(PORTAL_DEST, PORTAL_PATH, METHOD_TIMEOUT);
        let (fd,): (dbus::arg::OwnedFd,) = proxy
            .method_call(
                SCREENCAST_IFACE,
                "OpenPipeWireRemote",
                (session_path.clone(), PropMap::new()),
            )
            .map_err(|e| map_portal_error("OpenPipeWireRemote", &e))?;
        Ok(unsafe { OwnedFd::from_raw_fd(fd.into_raw_fd()) })
    }

    fn map_portal_error(op: &str, e: &dbus::Error) -> crate::errors::AppError {
        let msg = e.message().unwrap_or("dbus error");
        if msg.contains("org.freedesktop.DBus.Error.UnknownInterface")
            || msg.contains("org.freedesktop.DBus.Error.ServiceUnknown")
        {
            warn!(%e, "portal backend missing");
            InternalError::Capture(format!(
                "portal {op}: xdg-desktop-portal is not available — install a portal backend (xdg-desktop-portal-wlr/-gnome/-kde) to record under Wayland"
            ))
            .into()
        } else {
            InternalError::Capture(format!("portal {op}: {e}")).into()
        }
    }

    #[cfg(test)]
    mod session_tests {
        use super::*;

        #[test]
        fn propmap_extraction_handles_variants() {
            let mut results = PropMap::new();
            results.insert(
                "session_handle".into(),
                Variant(
                    Box::new("/org/freedesktop/portal/session/S42".to_string()) as Box<dyn RefArg>
                ),
            );
            let path = extract_path(&results, "session_handle").expect("path");
            assert_eq!(path.to_string(), "/org/freedesktop/portal/session/S42");
        }
    }
}

#[cfg(target_os = "linux")]
pub use dbus_session::PortalScreenCastSession;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn negotiates_cursor_mode_metadata() {
        let negotiator = PortalSessionNegotiator::new();
        // 1. Defaults to cursor_mode 4 (Metadata)
        assert_eq!(negotiator.cursor_mode(), PortalCursorMode::Metadata);
        assert_eq!(negotiator.cursor_mode().as_u32(), 4);

        // 2. Verified in SelectSources arguments
        let args = negotiator.build_select_sources_args("/org/freedesktop/portal/session/123");
        assert_eq!(args["cursor_mode"], 4);
        assert_eq!(
            args["session_handle"],
            "/org/freedesktop/portal/session/123"
        );

        // 3. Parse Start response confirming granted cursor mode 4
        let streams = vec![serde_json::json!({
            "node_id": 42,
            "source_type": 1,
            "size": [1920, 1080],
            "position": [0, 0],
        })];

        let state = negotiator
            .parse_start_response("/org/freedesktop/portal/session/123", &streams, Some(4))
            .expect("valid state");

        assert_eq!(state.negotiated_cursor_mode, PortalCursorMode::Metadata);
        assert_eq!(state.streams.len(), 1);
        assert_eq!(state.streams[0].pipewire_node_id, 42);
        assert_eq!(state.streams[0].size, Some((1920, 1080)));
    }

    #[test]
    fn detects_compositor_cursor_downgrade() {
        let negotiator = PortalSessionNegotiator::new();
        let streams = vec![serde_json::json!({
            "node_id": 99,
        })];

        // Compositor downgraded to embedded (mode 2)
        let state = negotiator
            .parse_start_response("/org/freedesktop/portal/session/456", &streams, Some(2))
            .expect("valid state");

        assert_eq!(state.negotiated_cursor_mode, PortalCursorMode::Embedded);
        assert_eq!(state.streams[0].pipewire_node_id, 99);
    }
}
