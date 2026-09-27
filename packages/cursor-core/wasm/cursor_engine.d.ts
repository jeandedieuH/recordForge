/* tslint:disable */
/* eslint-disable */

export class WasmCursorEngine {
    free(): void;
    [Symbol.dispose](): void;
    evaluate_motion_plan(motion_plan_json: string, time_ms: number): string;
    /**
     * Per-frame evaluation without JSON. Returns the flat f64 layout
     * documented on `CursorEngine::evaluate_packed`.
     */
    evaluate_packed(time_ms: number): Float64Array;
    fit(source_x: number, source_y: number, target_width: number, target_height: number, padding: number): string;
    constructor(telemetry_json: string, options_json: string);
    /**
     * Store the settings used by `evaluate_packed`. The JS wrapper only
     * calls this when the serialized settings actually change.
     */
    set_settings(settings_json: string): void;
    /**
     * Ordered shape-id table evaluated once at construction; packed frames
     * reference entries by index. Serialized once, not per frame.
     */
    shape_ids(): string;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_wasmcursorengine_free: (a: number, b: number) => void;
    readonly wasmcursorengine_evaluate_motion_plan: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly wasmcursorengine_evaluate_packed: (a: number, b: number) => [number, number];
    readonly wasmcursorengine_fit: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
    readonly wasmcursorengine_new: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly wasmcursorengine_set_settings: (a: number, b: number, c: number) => [number, number];
    readonly wasmcursorengine_shape_ids: (a: number) => [number, number];
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
