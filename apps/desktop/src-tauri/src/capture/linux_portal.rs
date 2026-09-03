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
                .map(|v| v as u32)
                .unwrap_or(1);

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
