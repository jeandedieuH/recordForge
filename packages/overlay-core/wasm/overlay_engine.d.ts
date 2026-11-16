/* tslint:disable */
/* eslint-disable */

export class WasmOverlayEngine {
    free(): void;
    [Symbol.dispose](): void;
    evaluate(time_ms: number): string;
    constructor(plan_json: string);
    /**
     * Patch item transforms/endpoints in place for interactive drags. The
     * caller must keep every non-geometry field identical (item set, timing,
     * animation, z-order); the export path still validates the full plan.
     */
    update_geometry(patches_json: string): void;
}

/**
 * Size of the composed camera LUT texture (33).
 */
export function camera_lut_size(): number;

/**
 * Composed camera LUT as an RGBA8 3D texture (size³ × 4 bytes, red fastest).
 * Same table the export writes as a `.cube`, so preview and render agree.
 */
export function camera_lut_texture(request_json: string): Uint8Array;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_wasmoverlayengine_free: (a: number, b: number) => void;
    readonly camera_lut_size: () => number;
    readonly camera_lut_texture: (a: number, b: number) => [number, number, number, number];
    readonly wasmoverlayengine_evaluate: (a: number, b: number) => [number, number];
    readonly wasmoverlayengine_new: (a: number, b: number) => [number, number, number];
    readonly wasmoverlayengine_update_geometry: (a: number, b: number, c: number) => [number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
