import shared from "../config/eslint.config.js"

// This package contains generated wasm-bindgen artifacts in `wasm/` that are
// produced by `build:wasm` and should not be linted.
export default [{ ignores: ["wasm/**"] }, ...shared]
