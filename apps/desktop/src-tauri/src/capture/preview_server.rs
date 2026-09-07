//! Lightweight Local Loopback HTTP MJPEG Preview Server
//!
//! Exposes a zero-overhead multipart MJPEG stream (`GET /preview.mjpg`) on `127.0.0.1:<ephemeral-port>`.
//! Live camera frames captured by FFmpeg are parsed from stdout and broadcast directly
//! to connected HTTP clients (the WebView's `<img>` tag).
//!
//! This completely avoids Windows DirectShow device lock contention between FFmpeg and
//! WebView2 `getUserMedia`, ensuring zero dropped frames and true WYSIWYG camera preview.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;
use tracing::{debug, info, warn};

/// Thread-safe broadcaster to distribute JPEG frames to all connected HTTP clients.
#[derive(Clone, Debug)]
pub struct FrameBroadcaster {
    clients: Arc<Mutex<Vec<TcpStream>>>,
    latest_frame: Arc<Mutex<Option<Vec<u8>>>>,
}

impl FrameBroadcaster {
    /// Broadcast a single JPEG frame to all connected clients.
    pub fn broadcast(&self, frame: &[u8]) {
        if frame.is_empty() {
            return;
        }

        // Cache the latest frame so any newly connecting window immediately receives an image
        if let Ok(mut latest) = self.latest_frame.lock() {
            *latest = Some(frame.to_vec());
        }

        let mut clients = match self.clients.lock() {
            Ok(guard) => guard,
            Err(_) => return,
        };

        if clients.is_empty() {
            return;
        }

        let header = format!(
            "--frame\r\nContent-Type: image/jpeg\r\nContent-Length: {}\r\n\r\n",
            frame.len()
        );
        let header_bytes = header.as_bytes();
        let footer_bytes = b"\r\n";

        // Retain only clients that successfully receive the frame. Disconnected windows are dropped.
        clients.retain_mut(|client| {
            if client.write_all(header_bytes).is_err() {
                return false;
            }
            if client.write_all(frame).is_err() {
                return false;
            }
            if client.write_all(footer_bytes).is_err() {
                return false;
            }
            let _ = client.flush();
            true
        });
    }

    /// Retrieve a clone of the most recent frame if available.
    pub fn latest_frame(&self) -> Option<Vec<u8>> {
        self.latest_frame.lock().ok().and_then(|f| f.clone())
    }
}

/// Local HTTP MJPEG server bound to an ephemeral loopback port.
pub struct WebcamPreviewServer {
    port: u16,
    broadcaster: FrameBroadcaster,
    stop_flag: Arc<AtomicBool>,
    server_handle: Option<JoinHandle<()>>,
}

impl std::fmt::Debug for WebcamPreviewServer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WebcamPreviewServer")
            .field("port", &self.port)
            .field("url", &self.preview_url())
            .finish()
    }
}

impl WebcamPreviewServer {
    /// Bind to a random free loopback port on `127.0.0.1` and start listening.
    pub fn start() -> crate::errors::Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| {
            crate::errors::InternalError::Capture(format!(
                "failed to bind webcam preview server on 127.0.0.1: {e}"
            ))
        })?;

        let port = listener
            .local_addr()
            .map_err(|e| {
                crate::errors::InternalError::Capture(format!(
                    "failed to get preview server port: {e}"
                ))
            })?
            .port();

        // Use non-blocking mode so the accept loop can periodically check the stop flag.
        listener.set_nonblocking(true).map_err(|e| {
            crate::errors::InternalError::Capture(format!(
                "failed to set preview server non-blocking: {e}"
            ))
        })?;

        let clients = Arc::new(Mutex::new(Vec::new()));
        let latest_frame = Arc::new(Mutex::new(None));
        let broadcaster = FrameBroadcaster {
            clients: Arc::clone(&clients),
            latest_frame: Arc::clone(&latest_frame),
        };

        let stop_flag = Arc::new(AtomicBool::new(false));
        let stop_clone = Arc::clone(&stop_flag);
        let broadcaster_clone = broadcaster.clone();

        let server_handle = thread::Builder::new()
            .name("webcam-preview-http".into())
            .spawn(move || {
                run_http_server(listener, broadcaster_clone, stop_clone);
            })
            .map_err(|e| {
                crate::errors::InternalError::Capture(format!(
                    "failed to spawn webcam preview server thread: {e}"
                ))
            })?;

        info!(port, url = %format!("http://127.0.0.1:{port}/preview.mjpg"), "webcam preview server started");

        Ok(Self {
            port,
            broadcaster,
            stop_flag,
            server_handle: Some(server_handle),
        })
    }

    /// Port on which the server is listening.
    pub fn port(&self) -> u16 {
        self.port
    }

    /// Full HTTP URL for the MJPEG stream.
    pub fn preview_url(&self) -> String {
        format!("http://127.0.0.1:{}/preview.mjpg", self.port)
    }

    /// Handle for broadcasting frames to connected clients.
    pub fn broadcaster(&self) -> FrameBroadcaster {
        self.broadcaster.clone()
    }

    /// Stop the server and unbind the port.
    pub fn stop(&mut self) {
        self.stop_flag.store(true, Ordering::Relaxed);
        if let Some(handle) = self.server_handle.take() {
            let _ = handle.join();
        }
        if let Ok(mut clients) = self.broadcaster.clients.lock() {
            clients.clear();
        }
        debug!(port = self.port, "webcam preview server stopped");
    }
}

impl Drop for WebcamPreviewServer {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Accept incoming HTTP client requests.
fn run_http_server(
    listener: TcpListener,
    broadcaster: FrameBroadcaster,
    stop_flag: Arc<AtomicBool>,
) {
    while !stop_flag.load(Ordering::Relaxed) {
        match listener.accept() {
            Ok((mut stream, _addr)) => {
                // Set stream timeout so slow clients or read hangs don't freeze the acceptor
                let _ = stream.set_read_timeout(Some(Duration::from_millis(300)));
                let _ = stream.set_write_timeout(Some(Duration::from_millis(500)));

                let mut req_buf = [0u8; 1024];
                let bytes_read = stream.read(&mut req_buf).unwrap_or(0);
                let request = String::from_utf8_lossy(&req_buf[..bytes_read]);

                if request.starts_with("GET /snapshot.jpg") {
                    // Serve single snapshot
                    if let Some(frame) = broadcaster.latest_frame() {
                        let resp = format!(
                            "HTTP/1.1 200 OK\r\n\
                             Content-Type: image/jpeg\r\n\
                             Content-Length: {}\r\n\
                             Access-Control-Allow-Origin: *\r\n\
                             Connection: close\r\n\r\n",
                            frame.len()
                        );
                        let _ = stream.write_all(resp.as_bytes());
                        let _ = stream.write_all(&frame);
                    } else {
                        let resp = "HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n";
                        let _ = stream.write_all(resp.as_bytes());
                    }
                } else if request.starts_with("GET /health") {
                    let resp = "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nok";
                    let _ = stream.write_all(resp.as_bytes());
                } else {
                    // Default /preview.mjpg stream
                    let header = "HTTP/1.1 200 OK\r\n\
                                  Content-Type: multipart/x-mixed-replace; boundary=frame\r\n\
                                  Cache-Control: no-cache, no-store, must-revalidate\r\n\
                                  Pragma: no-cache\r\n\
                                  Access-Control-Allow-Origin: *\r\n\
                                  Connection: close\r\n\r\n";

                    if stream.write_all(header.as_bytes()).is_ok() {
                        // Immediately send the latest frame so the client has an image right away
                        if let Some(frame) = broadcaster.latest_frame() {
                            let initial_chunk = format!(
                                "--frame\r\nContent-Type: image/jpeg\r\nContent-Length: {}\r\n\r\n",
                                frame.len()
                            );
                            let _ = stream.write_all(initial_chunk.as_bytes());
                            let _ = stream.write_all(&frame);
                            let _ = stream.write_all(b"\r\n");
                            let _ = stream.flush();
                        }

                        if let Ok(mut clients) = broadcaster.clients.lock() {
                            clients.push(stream);
                        }
                    }
                }
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                // Non-blocking wait slice
                thread::sleep(Duration::from_millis(30));
            }
            Err(e) => {
                warn!(%e, "webcam preview listener accept error");
                thread::sleep(Duration::from_millis(50));
            }
        }
    }
}

/// Parse and slice contiguous JPEG frames from a streaming byte buffer.
///
/// Looks for JPEG delimiters: SOI (`0xFF 0xD8`) and EOI (`0xFF 0xD9`).
/// Returns complete frames and leaves any incomplete trailing frame in `buffer`.
pub fn extract_jpeg_frames(buffer: &mut Vec<u8>) -> Vec<Vec<u8>> {
    let mut frames = Vec::new();

    loop {
        // Find SOI (Start of Image): 0xFF, 0xD8
        let soi_pos = buffer.windows(2).position(|w| w == [0xFF, 0xD8]);
        let Some(start) = soi_pos else {
            // No SOI found in buffer. Any byte before the last 0xFF can never be part of SOI.
            if let Some(last_ff) = buffer.iter().rposition(|&b| b == 0xFF) {
                buffer.drain(0..last_ff);
            } else {
                buffer.clear();
            }
            break;
        };

        // Discard any garbage before the first SOI
        if start > 0 {
            buffer.drain(0..start);
        }

        // Now SOI is at buffer[0..2]
        // Find EOI: 0xFF, 0xD9 after SOI (from index 2)
        let eoi_offset = buffer[2..].windows(2).position(|w| w == [0xFF, 0xD9]);
        let Some(rel_eoi) = eoi_offset else {
            // Incomplete frame; wait for more data
            break;
        };

        let end = 2 + rel_eoi + 2; // includes 0xFF, 0xD9
        let frame = buffer[..end].to_vec();
        frames.push(frame);
        buffer.drain(0..end);
    }

    frames
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_single_jpeg_frame() {
        let mut buffer = vec![0x12, 0x34, 0xFF, 0xD8, 0x01, 0x02, 0x03, 0xFF, 0xD9, 0xFF];
        let frames = extract_jpeg_frames(&mut buffer);

        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0], vec![0xFF, 0xD8, 0x01, 0x02, 0x03, 0xFF, 0xD9]);
        assert_eq!(buffer, vec![0xFF]);
    }

    #[test]
    fn extract_multiple_contiguous_frames() {
        let mut buffer = vec![
            0xFF, 0xD8, 0xAA, 0xFF, 0xD9, // Frame 1
            0xFF, 0xD8, 0xBB, 0xCC, 0xFF, 0xD9, // Frame 2
            0xFF, 0xD8, // Partial Frame 3
        ];
        let frames = extract_jpeg_frames(&mut buffer);

        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0], vec![0xFF, 0xD8, 0xAA, 0xFF, 0xD9]);
        assert_eq!(frames[1], vec![0xFF, 0xD8, 0xBB, 0xCC, 0xFF, 0xD9]);
        assert_eq!(buffer, vec![0xFF, 0xD8]);
    }

    #[test]
    fn extract_empty_or_invalid_buffer() {
        let mut empty = Vec::new();
        assert!(extract_jpeg_frames(&mut empty).is_empty());

        let mut junk = vec![1, 2, 3, 4, 5];
        assert!(extract_jpeg_frames(&mut junk).is_empty());
        assert!(junk.is_empty());
    }

    #[test]
    fn preview_server_starts_and_stops() {
        let mut server = WebcamPreviewServer::start().expect("server should start");
        assert!(server.port() > 0);
        assert!(server.preview_url().contains(&server.port().to_string()));

        let broadcaster = server.broadcaster();
        let dummy_jpeg = vec![0xFF, 0xD8, 0x00, 0xFF, 0xD9];
        broadcaster.broadcast(&dummy_jpeg);
        assert_eq!(broadcaster.latest_frame(), Some(dummy_jpeg));

        server.stop();
    }
}
