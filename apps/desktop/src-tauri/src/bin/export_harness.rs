// Dev-only driver for the export spec harness in exports/mod.rs.
// Build with: cargo build --release --features export-harness --bin export_harness
// Usage: export_harness.exe <spec.json> [more-specs.json ...]
// Renders each spec through the real export path in one process (so caches that
// live for the process lifetime, such as the GPU device, are exercised) and
// exits 1 if any render failed.

use std::process::ExitCode;

fn main() -> ExitCode {
    let specs: Vec<String> = std::env::args().skip(1).collect();
    if specs.is_empty() {
        eprintln!("usage: export_harness <spec.json> [more-specs.json ...]");
        return ExitCode::from(2);
    }
    for spec_path in &specs {
        let spec = std::fs::read(spec_path).expect("failed to read spec file");
        let status = recordforge_desktop_lib::exports::run_export_harness_spec(&spec);
        if status != 0 {
            eprintln!("export_harness: {spec_path} failed with status {status}");
            return ExitCode::from(1);
        }
    }
    ExitCode::SUCCESS
}
