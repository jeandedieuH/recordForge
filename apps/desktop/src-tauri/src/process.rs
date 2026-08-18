use std::ffi::OsStr;
use std::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Windows creation flag `CREATE_NO_WINDOW` (0x08000000).
///
/// Prevents Windows from allocating/displaying a new console window (conhost / Windows Terminal)
/// when a console executable (such as FFmpeg or FFprobe) is spawned from a GUI application.
#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Create a `std::process::Command` configured with `CREATE_NO_WINDOW` on Windows
/// to ensure background tasks (like FFmpeg/FFprobe) run silently without flashing
/// console windows over the GUI in production desktop builds.
pub fn create_command<S: AsRef<OsStr>>(program: S) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Extension trait to easily apply `CREATE_NO_WINDOW` on existing `Command` instances.
pub trait CommandExtNoWindow {
    fn no_window(&mut self) -> &mut Self;
}

impl CommandExtNoWindow for Command {
    fn no_window(&mut self) -> &mut Self {
        #[cfg(windows)]
        {
            self.creation_flags(CREATE_NO_WINDOW);
        }
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_configured_command() {
        let cmd = create_command("ffmpeg");
        assert_eq!(cmd.get_program(), "ffmpeg");
    }
}
