import FbmEngine, { type FbmEngine as Engine } from "../dist/index.js";
import type { FbmConfig } from "../index.d.js";

let loaded = false;

/**
 * Loads the wasm module on first use and constructs a fresh FbmEngine.
 * Subsequent calls skip the wasm load (cached) and just construct.
 */
export async function freshEngine(config?: FbmConfig): Promise<Engine> {
    if (!loaded) {
        await FbmEngine.init();
        loaded = true;
    }
    return new (FbmEngine as unknown as new (cfg?: FbmConfig) => Engine)(
        config ?? {},
    );
}