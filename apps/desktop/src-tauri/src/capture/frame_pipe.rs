//! OS pipe between a native frame producer and the FFmpeg child.
//!
//! ScreenCaptureKit (macOS) and PipeWire (Linux) feed identical packed
//! `rawvideo` pipes into the child's fd 3. The write end is non-blocking by
//! contract: a single 1080p BGRA frame (~8 MiB) dwarfs the ~64 KiB pipe
//! buffer, so a reader that stops draining — a failed spawn, or an FFmpeg
//! that died or stalled mid-capture — turns a blocking `write` into a
//! sleep `stop()` can never join out of. `write_frame` waits on `poll`
//! with a stop flag instead, so teardown always gets the writer thread
//! back within `PIPE_FULL_POLL_MS`.

use std::io::Write;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::sync::atomic::{AtomicBool, Ordering};

use crate::errors::{InternalError, Result};

/// Poll cadence while the pipe is full: fast enough that `stop()` joins the
/// writer promptly, slow enough to be free while a stalled reader recovers.
const PIPE_FULL_POLL_MS: i32 = 50;

/// Create `(read, write)` for a frame pipe. Both ends are CLOEXEC — the
/// FFmpeg child keeps only the `dup2`'d fd 3 — and the write end is
/// O_NONBLOCK so a full pipe reports `WouldBlock` instead of sleeping (see
/// module docs for why teardown depends on that).
pub fn create() -> Result<(OwnedFd, OwnedFd)> {
    let mut fds = [0 as RawFd; 2];
    // SAFETY: `fds` is a valid two-element buffer pipe() fills on success.
    // pipe() + fcntl works everywhere unix; Linux's pipe2 has no macOS twin.
    let rc = unsafe { libc::pipe(fds.as_mut_ptr()) };
    if rc == -1 {
        return Err(InternalError::Capture(format!(
            "create frame pipe: {}",
            std::io::Error::last_os_error()
        ))
        .into());
    }
    // SAFETY: pipe() just returned both fds, so from_raw_fd is sound; on a
    // later fcntl failure the OwnedFds close themselves on drop.
    let (read_fd, write_fd) =
        unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) };
    // SAFETY: fcntl on live pipe fds. Evaluated left-to-right; the first
    // failure stops the chain so errno still names it.
    let configured = unsafe {
        libc::fcntl(read_fd.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) != -1
            && libc::fcntl(write_fd.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) != -1
            && libc::fcntl(write_fd.as_raw_fd(), libc::F_SETFL, libc::O_NONBLOCK) != -1
    };
    if !configured {
        return Err(InternalError::Capture(format!(
            "configure frame pipe: {}",
            std::io::Error::last_os_error()
        ))
        .into());
    }
    Ok((read_fd, write_fd))
}

/// Write all of `frame` to the non-blocking pipe end, giving up on `stop`
/// or pipe death (EPIPE/EBADF surface through `write`). Returns `false`
/// when the writer thread should exit.
///
/// `stop` is consulted only while the pipe is full: a healthy FFmpeg keeps
/// draining the queue through teardown, so the recording keeps its tail,
/// while a missing or stalled reader releases the writer promptly.
pub fn write_frame(file: &mut std::fs::File, frame: &[u8], stop: &AtomicBool) -> bool {
    let mut written = 0;
    while written < frame.len() {
        match file.write(&frame[written..]) {
            Ok(0) => return false,
            Ok(n) => written += n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                if !wait_writable(file, stop) {
                    return false;
                }
            }
            Err(_) => return false,
        }
    }
    true
}

/// Wait for pipe space, re-checking `stop` each round. Errors and hangups
/// report `true` — the next `write` surfaces them properly; `false` is
/// reserved for "stop requested" and a genuinely failed poll.
fn wait_writable(file: &std::fs::File, stop: &AtomicBool) -> bool {
    let mut pfd = libc::pollfd {
        fd: file.as_raw_fd(),
        events: libc::POLLOUT,
        revents: 0,
    };
    loop {
        if stop.load(Ordering::Acquire) {
            return false;
        }
        // SAFETY: `pfd` is a valid pollfd and `file`'s fd outlives the call.
        let rc = unsafe { libc::poll(&mut pfd, 1, PIPE_FULL_POLL_MS) };
        if rc > 0 {
            return true;
        }
        if rc == 0 {
            continue;
        }
        if std::io::Error::last_os_error().kind() != std::io::ErrorKind::Interrupted {
            return false;
        }
    }
}
