use std::path::{Path, PathBuf};

fn main() {
    println!("cargo::rustc-check-cfg=cfg(spa_meta_macros)");
    println!("cargo::rustc-check-cfg=cfg(spa_raw_no_flags)");

    // FIXME: It would be nice to run this only when tests are run.
    println!("cargo:rerun-if-changed=tests/pod.c");
    println!("cargo:rerun-if-changed=compat.c");

    let libs = system_deps::Config::new()
        .probe()
        .expect("Cannot find libspa");
    let libspa = libs.get_by_name("libspa").unwrap();

    cc::Build::new()
        .file("tests/pod.c")
        .flag("-Wno-missing-field-initializers")
        .includes(&libspa.include_paths)
        .compile("pod");

    let compiler = cc::Build::new().get_compiler();

    // PipeWire < 1.0 headers have no `flags` field in `spa_video_info_raw` and
    // use `int64_t` for `modifier` (it became `uint64_t` in 1.0).
    if !syntax_check(
        &compiler,
        &libspa.include_paths,
        r#"
            #include <spa/param/video/raw.h>
            int main(void) {
                struct spa_video_info_raw v = {0};
                return (int)v.flags;
            }
        "#,
    ) {
        println!("cargo:rustc-cfg=spa_raw_no_flags");
        println!(
            "cargo:warning=libspa compat: system PipeWire headers lack spa_video_info_raw.flags (PipeWire < 1.0); building with the compatibility layer"
        );
    }

    // PipeWire < 1.0 headers expose the meta iterators as plain #define
    // macros, so libspa-sys's bindgen emits no `spa_meta_first` /
    // `spa_meta_region_is_valid` symbols. Taking the address compiles only
    // when they are real (static inline) functions.
    let meta_macros = !syntax_check(
        &compiler,
        &libspa.include_paths,
        r#"
            #include <spa/buffer/meta.h>
            int main(void) {
                void *p = (void *)&spa_meta_first;
                void *q = (void *)&spa_meta_region_is_valid;
                (void)p; (void)q;
                return 0;
            }
        "#,
    );
    if meta_macros {
        println!("cargo:rustc-cfg=spa_meta_macros");
        cc::Build::new()
            .file("compat.c")
            .includes(&libspa.include_paths)
            .compile("pwrs_spa_compat");
    }
}

fn syntax_check(compiler: &cc::Tool, include_paths: &[PathBuf], code: &str) -> bool {
    let out_dir = std::env::var("OUT_DIR").expect("OUT_DIR");
    let src = Path::new(&out_dir).join("compat_probe.c");
    std::fs::write(&src, code).expect("write probe source");

    let mut cmd = compiler.to_command();
    for dir in include_paths {
        cmd.arg("-I").arg(dir);
    }
    let status = cmd.arg("-fsyntax-only").arg(&src).status();
    matches!(status, Ok(s) if s.success())
}
