// @ts-expect-error - fbm.js is emitted by `meson compile` into this directory
// alongside this source file; TypeScript cannot resolve it before the wasm
// build has run. After `npm run build`, the file is present and the runtime
// import below works as expected.
import initRaw from "../fbm.js";
import type { MainModule } from "../index.raw";

export interface InitOptions {
    /** Override wasm URL resolution. Default keeps the wasm next to fbm.js. */
    locateFile?: (path: string, scriptDirectory: string) => string;
}

let cachedModule: MainModule | undefined;

/*
 * `FbmEngine` is callable both as `await FbmEngine.init()` (static) and
 * as `new FbmEngine(config)` (instance factory). JavaScript's `new`
 * operator on a function uses the explicit return value when it's an
 * object, so we return the wasm-bound FbmEngine instance here.
 */
function FbmEngineLoader(this: void, config?: object): unknown {
    if (!cachedModule) {
        throw new Error(
            "FbmEngine.init() must be awaited before constructing instances",
        );
    }
    return new (cachedModule.FbmEngine as new (cfg?: object) => unknown)(
        config ?? {},
    );
}

FbmEngineLoader.init = async (options?: InitOptions): Promise<void> => {
    if (cachedModule) return;
    const locateFile =
        options?.locateFile ?? ((path: string, prefix: string) => `${prefix}${path}`);
    cachedModule = await initRaw({ locateFile } as never);
};

export default FbmEngineLoader;