//! Compatibility layer for PipeWire headers older than 1.0.
//!
//! `spa_meta_first` and `spa_meta_region_is_valid` were plain `#define` macros
//! there — invisible to bindgen — and only became `static inline` functions in
//! PipeWire 1.0. When `build.rs` detects macro-only headers it compiles
//! `compat.c` (real symbols wrapping the macros) and sets `spa_meta_macros`.
use std::ffi::c_void;

#[cfg(spa_meta_macros)]
extern "C" {
    fn pwrs_spa_meta_first(m: *const spa_sys::spa_meta) -> *mut c_void;
    fn pwrs_spa_meta_region_is_valid(m: *const spa_sys::spa_meta_region) -> bool;
}

pub unsafe fn meta_first(m: *const spa_sys::spa_meta) -> *mut c_void {
    #[cfg(spa_meta_macros)]
    {
        pwrs_spa_meta_first(m)
    }
    #[cfg(not(spa_meta_macros))]
    {
        spa_sys::spa_meta_first(m)
    }
}

pub unsafe fn meta_region_is_valid(m: *const spa_sys::spa_meta_region) -> bool {
    #[cfg(spa_meta_macros)]
    {
        pwrs_spa_meta_region_is_valid(m)
    }
    #[cfg(not(spa_meta_macros))]
    {
        spa_sys::spa_meta_region_is_valid(m)
    }
}
