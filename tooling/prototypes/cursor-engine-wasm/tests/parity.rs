//! Native parity test runner for the cursor evaluator prototype.
//!
//! Run from `tooling/prototypes/cursor-engine-wasm`:
//!   cargo run --bin parity_test

use std::fs;

use cursor_engine_wasm_proto::{load_telemetry, Canvas, Evaluator};

fn project_root() -> std::path::PathBuf {
    let manifest = std::env!("CARGO_MANIFEST_DIR");
    std::path::PathBuf::from(manifest)
}

fn fixture_dir() -> std::path::PathBuf {
    project_root()
        .join("..")
        .join("..")
        .join("fixtures")
        .join("cursor-fixtures")
}

fn evaluate_fixture(name: &str, canvas: Canvas, times: &[f64]) -> Result<(), String> {
    let path = fixture_dir().join(name);
    let json = fs::read_to_string(&path)
        .map_err(|e| format!("failed to read {}: {}", path.display(), e))?;
    let telemetry = load_telemetry(&json)?;
    let evaluator = Evaluator::new(telemetry, canvas)?;

    println!("{}:", name);
    for &t in times {
        let result = evaluator.evaluate(t);
        println!(
            "  t={:>6.0} ms -> ({:.2}, {:.2}) visible={} click={:?}",
            t, result.x, result.y, result.visible, result.click_progress
        );
    }
    Ok(())
}

fn main() -> Result<(), String> {
    let canvas = Canvas {
        width: 1920.0,
        height: 1080.0,
        padding: 0.0,
    };

    let fixtures = [
        "cursor-v1-100dpi-10s.json",
        "cursor-v1-125dpi-10s.json",
        "cursor-v1-left-clicks-10s.json",
        "cursor-v1-idle-intervals-10s.json",
        "cursor-v2-topology-multi-10s.json",
        "cursor-v2-button-edges-10s.json",
    ];

    let times = [0.0, 1000.0, 2500.0, 5000.0, 7500.0, 9999.0];

    for fixture in fixtures {
        if let Err(e) = evaluate_fixture(fixture, canvas, &times) {
            eprintln!("{} failed: {}", fixture, e);
        }
    }

    println!("Parity smoke test complete.");
    Ok(())
}
