fn main() {
    println!(
        "cargo:rustc-env=TARGET_TRIPLE={}",
        std::env::var("TARGET").unwrap_or_default()
    );

    // Swift-backed capture crates (screencapturekit, apple-*) emit objects
    // that reference the Swift runtime via @rpath — e.g.
    // `libswift_Concurrency.dylib` — but rustc-linked targets carry no
    // LC_RPATH for it, so test/dev binaries abort at launch with
    // "Library not loaded". A dependency's build script cannot fix this:
    // `cargo:rustc-link-arg` only applies to the package that emits it.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
        for dir in macos_swift_runtime_dirs() {
            println!("cargo:rustc-link-arg=-Wl,-rpath,{dir}");
        }
    }

    tauri_build::build()
}

/// Back-deployment copies of the Swift runtime ship inside the active Xcode
/// toolchain. They are required on macOS 26+, where several runtime dylibs
/// (e.g. `libswift_Concurrency.dylib`) no longer exist as standalone files
/// under `/usr/lib/swift`.
fn macos_swift_runtime_dirs() -> Vec<String> {
    let Ok(output) = std::process::Command::new("xcode-select")
        .arg("--print-path")
        .output()
    else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    let Ok(developer_dir) = String::from_utf8(output.stdout) else {
        return Vec::new();
    };
    let toolchain_libs = std::path::Path::new(developer_dir.trim())
        .join("Toolchains/XcodeDefault.xctoolchain/usr/lib");
    ["swift/macosx", "swift-5.5/macosx", "swift-5.0/macosx"]
        .iter()
        .map(|sub| toolchain_libs.join(sub))
        .filter(|dir| dir.is_dir())
        .map(|dir| dir.to_string_lossy().into_owned())
        .collect()
}
