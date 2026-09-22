// Dev-only driver for the export spec harness in exports/mod.rs.
// Usage: devin_harness.exe <spec.json>
// Renders the spec through the real export path and exits with its status code.

fn main() {
    let spec_path = std::env::args()
        .nth(1)
        .expect("usage: devin_harness <spec.json>");
    let spec = std::fs::read(&spec_path).expect("failed to read spec file");
    std::process::exit(recordforge_desktop_lib::exports::devin_render_spec(&spec));
}
