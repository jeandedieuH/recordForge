//! Lightweight Local Loopback HTTP MJPEG Preview Server
//!
//! Exposes a best-effort multipart MJPEG stream (`GET /preview.mjpg`) on `127.0.0.1:<ephemeral-port>`.
//! Live camera frames captured by FFmpeg are parsed from stdout and broadcast
//! to connected HTTP clients (the WebView's `<img>` tag).
//!
//! Design: the broadcaster is deliberately LOSSY and nonblocking. `broadcast`
//! only swaps the latest-frame slot and wakes writers — it performs no socket
//! IO, so a stalled or slow HTTP client can never backpressure the FFmpeg
//! reader thread or the recording pipeline. Each client gets a dedicated
//! writer thread that waits on the shared condvar, clones the current frame
//! `Arc`, and writes without holding the lock. Clients that fall behind simply
//! skip overwritten frames (latest-only, never a queue); clients that stall
//! are disconnected by the write timeout. This avoids DirectShow device lock
//! contention between FFmpeg and WebView2 `getUserMedia` while keeping the
//! preview strictly isolated from capture correctness — preview frames may be
//! skipped under load, never the recorded ones.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;
use tracing::{debug, info, warn};

/// Maximum simultaneous MJPEG preview clients. The preview is consumed by at
/// most a couple of webviews; the cap keeps reconnect storms from accumulating
/// unbounded writer threads.
const MAX_PREVIEW_CLIENTS: usize = 4;

/// How long a client writer blocks waiting for a newer frame before rechecking
/// the stop flag, and how long a stalled client write may take before the
/// client is disconnected.
const CLIENT_WAIT_TIMEOUT: Duration = Duration::from_millis(100);

/// Slot holding the newest published frame. Writers compare `sequence` to
/// detect a new frame; `frame` is `None` before the first broadcast.
#[derive(Debug, Default)]
struct PublishedFrame {
    sequence: u64,
    frame: Option<Arc<[u8]>>,
}

/// Thread-safe latest-frame slot shared by the FFmpeg reader thread and the
/// per-client writer threads. `broadcast` only touches this slot — never a
/// socket — so preview backpressure cannot stall the capture pipeline.
#[derive(Clone, Debug)]
pub struct FrameBroadcaster {
    latest: Arc<(Mutex<PublishedFrame>, Condvar)>,
    stopped: Arc<AtomicBool>,
    clients: Arc<AtomicUsize>,
}

impl FrameBroadcaster {
    /// Publish a single JPEG frame: swap the latest slot, bump the sequence,
    /// and wake writers. No network IO happens here — writers that are too
    /// slow simply never see the overwritten frame.
    pub fn broadcast(&self, frame: &[u8]) {
        if frame.is_empty() {
            return;
        }

        let frame: Arc<[u8]> = Arc::from(frame);
        if let Ok(mut latest) = self.latest.0.lock() {
            latest.sequence = latest.sequence.wrapping_add(1);
            latest.frame = Some(frame);
        }
        // Wake writers AFTER releasing the lock so they do not pile up on the
        // mutex we are still holding.
        self.latest.1.notify_all();
    }

    /// Retrieve a clone of the most recent frame if available.
    pub fn latest_frame(&self) -> Option<Vec<u8>> {
        self.latest
            .0
            .lock()
            .ok()
            .and_then(|latest| latest.frame.as_deref().map(|f| f.to_vec()))
    }
}

/// Decrements the shared client counter when a writer thread exits, however it
/// exits — the acceptor's cap therefore tracks live clients only.
struct ClientCountGuard(Arc<AtomicUsize>);

impl ClientCountGuard {
    fn new(clients: Arc<AtomicUsize>) -> Self {
        clients.fetch_add(1, Ordering::SeqCst);
        Self(clients)
    }
}

impl Drop for ClientCountGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
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

        let stop_flag = Arc::new(AtomicBool::new(false));
        let broadcaster = FrameBroadcaster {
            latest: Arc::new((Mutex::new(PublishedFrame::default()), Condvar::new())),
            stopped: Arc::clone(&stop_flag),
            clients: Arc::new(AtomicUsize::new(0)),
        };
        let broadcaster_clone = broadcaster.clone();

        let server_handle = thread::Builder::new()
            .name("webcam-preview-http".into())
            .spawn(move || {
                run_http_server(listener, broadcaster_clone);
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
    ///
    /// Sets the shared stop flag and wakes every parked writer so shutdown
    /// completes within roughly one client wait/write timeout (~200 ms) — no
    /// lock is held while threads are joined, so there is no lock inversion
    /// between the acceptor and its writers.
    pub fn stop(&mut self) {
        self.stop_flag.store(true, Ordering::Relaxed);
        // Wake any writer parked in wait_timeout so it sees `stopped` now.
        self.broadcaster.latest.1.notify_all();
        if let Some(handle) = self.server_handle.take() {
            let _ = handle.join();
        }
        debug!(port = self.port, "webcam preview server stopped");
    }
}

impl Drop for WebcamPreviewServer {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Drop finished writer threads so reconnects do not accumulate handles, then
/// bound how many retained (still-running) writers the loop tracks — the
/// client cap already bounds live writers at `MAX_PREVIEW_CLIENTS`.
fn reap_finished_writers(writers: &mut Vec<JoinHandle<()>>) {
    let mut index = 0;
    while index < writers.len() {
        if writers[index].is_finished() {
            let _ = writers.swap_remove(index).join();
        } else {
            index += 1;
        }
    }
}

/// Accept incoming HTTP client requests.
fn run_http_server(listener: TcpListener, broadcaster: FrameBroadcaster) {
    let mut writers: Vec<JoinHandle<()>> = Vec::new();

    while !broadcaster.stopped.load(Ordering::Relaxed) {
        match listener.accept() {
            Ok((mut stream, _addr)) => {
                // Reap finished writers first so the client cap reflects live
                // connections rather than historical ones.
                reap_finished_writers(&mut writers);

                // Set stream timeout so slow clients or read hangs don't freeze the acceptor
                if stream
                    .set_read_timeout(Some(Duration::from_millis(300)))
                    .is_err()
                    || stream.set_write_timeout(Some(CLIENT_WAIT_TIMEOUT)).is_err()
                {
                    continue;
                }

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
                    // Default /preview.mjpg stream — reject beyond the client
                    // cap so reconnect storms cannot accumulate writers.
                    if broadcaster.clients.load(Ordering::SeqCst) >= MAX_PREVIEW_CLIENTS {
                        let resp = "HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n";
                        let _ = stream.write_all(resp.as_bytes());
                        continue;
                    }

                    let header = "HTTP/1.1 200 OK\r\n\
                                  Content-Type: multipart/x-mixed-replace; boundary=frame\r\n\
                                  Cache-Control: no-cache, no-store, must-revalidate\r\n\
                                  Pragma: no-cache\r\n\
                                  Access-Control-Allow-Origin: *\r\n\
                                  Connection: close\r\n\r\n";

                    if stream.write_all(header.as_bytes()).is_err() {
                        continue;
                    }

                    // Send the latest frame immediately so the client has an
                    // image right away, and record its sequence so the writer
                    // only forwards frames published after this point.
                    // Sequence zero lets the writer deliver the initial frame
                    // through the same unlocked path as subsequent frames.
                    let last_sequence = 0;

                    // The client slot is claimed here in the accept loop (not
                    // inside the writer) so the cap cannot be raced by a burst
                    // of accepts before the threads' increments land. If the
                    // spawn fails the guard drops and frees the slot.
                    let guard = ClientCountGuard::new(Arc::clone(&broadcaster.clients));
                    let writer_broadcaster = broadcaster.clone();
                    match thread::Builder::new()
                        .name("webcam-preview-writer".into())
                        .spawn(move || {
                            stream_webcam_preview(stream, writer_broadcaster, last_sequence, guard);
                        }) {
                        Ok(handle) => writers.push(handle),
                        Err(e) => warn!(%e, "failed to spawn preview writer thread"),
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

    // Shutdown: the stop flag and a notify_all have already been broadcast;
    // each writer wakes within CLIENT_WAIT_TIMEOUT and writes are bounded by
    // the socket write timeout, so these joins are bounded-time. The latest
    // lock is never held while joining, so writers cannot deadlock shutdown.
    for handle in writers {
        let _ = handle.join();
    }
}

/// One client's MJPEG writer loop. Owns the socket; waits on the shared
/// condvar for a newer frame sequence, clones the `Arc` under the lock, then
/// releases it BEFORE writing so socket latency never blocks `broadcast`.
fn stream_webcam_preview(
    mut stream: TcpStream,
    broadcaster: FrameBroadcaster,
    mut last_sequence: u64,
    // Tracks the connection against the acceptor cap for the whole lifetime
    // of this writer, including panic paths.
    _guard: ClientCountGuard,
) {
    // Stalled clients are dropped after one write timeout instead of being
    // allowed to hold a writer thread forever.
    let _ = stream.set_write_timeout(Some(CLIENT_WAIT_TIMEOUT));

    loop {
        if broadcaster.stopped.load(Ordering::Relaxed) {
            return;
        }

        // Wait for a frame newer than the last one this client received.
        let frame = {
            let (lock, condvar) = &*broadcaster.latest;
            let mut latest = match lock.lock() {
                Ok(latest) => latest,
                Err(_) => return,
            };
            while latest.sequence == last_sequence && !broadcaster.stopped.load(Ordering::Relaxed) {
                let (guard, _) = match condvar.wait_timeout(latest, CLIENT_WAIT_TIMEOUT) {
                    Ok(result) => result,
                    Err(_) => return,
                };
                latest = guard;
            }
            if latest.sequence == last_sequence {
                None
            } else {
                last_sequence = latest.sequence;
                latest.frame.clone()
            }
        };

        let Some(frame) = frame else {
            continue;
        };

        // All socket writes happen AFTER the lock is released. A slow client
        // therefore only delays itself; the next broadcast may overwrite this
        // frame before it is sent, which is the intended lossy behavior.
        let header = format!(
            "--frame\r\nContent-Type: image/jpeg\r\nContent-Length: {}\r\n\r\n",
            frame.len()
        );
        if stream.write_all(header.as_bytes()).is_err()
            || stream.write_all(&frame).is_err()
            || stream.write_all(b"\r\n").is_err()
        {
            return;
        }
        let _ = stream.flush();
    }
}

/// Cap on bytes retained while scanning for the next complete JPEG. A corrupt
/// stream (or an encoder emitting a never-terminated frame) must not grow the
/// FFmpeg stdout buffer without bound — beyond this size the pending prefix is
/// dropped and parsing resumes at the next SOI.
const MAX_PENDING_JPEG_BYTES: usize = 4 * 1024 * 1024;

/// Parse and slice contiguous JPEG frames from a streaming byte buffer.
///
/// Looks for JPEG delimiters: SOI (`0xFF 0xD8`) and EOI (`0xFF 0xD9`).
/// Returns complete frames and leaves any incomplete trailing frame in
/// `buffer`, bounded to [`MAX_PENDING_JPEG_BYTES`].
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
            // Incomplete frame. If the pending bytes exceed the bound the
            // frame is corrupt or oversized — drop it (keeping a trailing
            // 0xFF that may begin the next SOI) so the buffer stays bounded.
            if buffer.len() > MAX_PENDING_JPEG_BYTES {
                if buffer.last() == Some(&0xFF) {
                    buffer.drain(0..buffer.len() - 1);
                } else {
                    buffer.clear();
                }
            }
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

    fn broadcaster() -> FrameBroadcaster {
        FrameBroadcaster {
            latest: Arc::new((Mutex::new(PublishedFrame::default()), Condvar::new())),
            stopped: Arc::new(AtomicBool::new(false)),
            clients: Arc::new(AtomicUsize::new(0)),
        }
    }

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
    fn extract_bounds_incomplete_frame_accumulation() {
        // An SOI with no EOI that never terminates would grow without bound;
        // beyond 4 MiB the pending prefix is dropped.
        let mut buffer = Vec::with_capacity(MAX_PENDING_JPEG_BYTES + 8);
        buffer.extend_from_slice(&[0xFF, 0xD8]);
        buffer.resize(MAX_PENDING_JPEG_BYTES + 4, 0x42);

        assert!(extract_jpeg_frames(&mut buffer).is_empty());
        assert!(buffer.len() <= MAX_PENDING_JPEG_BYTES);

        // Parsing resumes at the next SOI after a dropped corrupt prefix.
        buffer.extend_from_slice(&[0xFF, 0xD8, 0x99, 0xFF, 0xD9]);
        let frames = extract_jpeg_frames(&mut buffer);
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0], vec![0xFF, 0xD8, 0x99, 0xFF, 0xD9]);
    }

    #[test]
    fn broadcast_keeps_only_the_latest_frame() {
        let broadcaster = broadcaster();
        let first = vec![0xFF, 0xD8, 0x01, 0xFF, 0xD9];
        let second = vec![0xFF, 0xD8, 0x02, 0xFF, 0xD9];

        broadcaster.broadcast(&first);
        broadcaster.broadcast(&second);

        // Latest-only: the overwritten first frame is gone — there is no
        // history queue a slow client could drain.
        assert_eq!(broadcaster.latest_frame(), Some(second));
    }

    #[test]
    fn broadcast_ignores_empty_frames() {
        let broadcaster = broadcaster();
        broadcaster.broadcast(&[]);
        assert_eq!(broadcaster.latest_frame(), None);
    }

    #[test]
    fn stop_flag_wakes_parked_writers() {
        let broadcaster = broadcaster();
        let waiter = {
            let broadcaster = broadcaster.clone();
            thread::spawn(move || {
                let (lock, condvar) = &*broadcaster.latest;
                let mut latest = lock.lock().unwrap();
                // Park like a client writer waiting for a new frame.
                while latest.sequence == 0 && !broadcaster.stopped.load(Ordering::Relaxed) {
                    let (guard, _) = condvar
                        .wait_timeout(latest, Duration::from_millis(100))
                        .unwrap();
                    latest = guard;
                }
                broadcaster.stopped.load(Ordering::Relaxed)
            })
        };

        thread::sleep(Duration::from_millis(50));
        broadcaster.stopped.store(true, Ordering::Relaxed);
        broadcaster.latest.1.notify_all();

        assert!(waiter.join().expect("writer thread panicked"));
    }

    #[test]
    fn unread_client_does_not_block_broadcast_or_shutdown() {
        let mut server = WebcamPreviewServer::start().unwrap();
        let broadcaster = server.broadcaster();
        broadcaster.broadcast(&vec![1; 4 * 1024 * 1024]);
        let mut client = TcpStream::connect(("127.0.0.1", server.port())).unwrap();
        client
            .write_all(b"GET /preview.mjpg HTTP/1.1\r\nHost: localhost\r\n\r\n")
            .unwrap();
        thread::sleep(Duration::from_millis(100));
        let started = std::time::Instant::now();
        for _ in 0..20 {
            broadcaster.broadcast(&[0xff, 0xd8, 0xff, 0xd9]);
        }
        server.stop();
        assert!(started.elapsed() < Duration::from_secs(2));
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
