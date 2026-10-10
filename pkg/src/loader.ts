// @ts-expect-error - fbm.js is emitted by `meson compile` into this directory
// alongside this source file; TypeScript cannot resolve it before the wasm
// build has run. After `npm run build`, the file is present and the runtime
// import below works as expected.
import initRaw from "../fbm.js";
import type { MainModule } from "../index.raw";

export interface InitOptions {
    /**
     * Override wasm URL resolution. The package resolves the wasm URL
     * itself (`?url` in Vite/Webpack/Parcel/Bun, or a sibling-file
     * fallback for raw ESM) — most consumers won't need this. If you
     * pass a `locateFile` here it handles non-wasm paths; the wasm
     * path is always routed through the package's own resolution.
     */
    locateFile?: (path: string, scriptDirectory: string) => string;
}

let cachedModule: MainModule | undefined;

/*
 * Resolve the URL of the bundled `fbm.wasm`.
 *
 * The package ships `fbm.wasm` alongside `fbm.js` (one directory up from
 * this source, at `dist/fbm.wasm`). The auto-generated `fbm.js` asks
 * Emscripten for the wasm via `new URL('fbm.wasm', import.meta.url)`,
 * which only works when `fbm.js` and `fbm.wasm` are served from the
 * same literal path. That assumption breaks when a bundler moves
 * `fbm.js` (Vite pre-bundles it into `node_modules/.vite/deps/`,
 * production builds hash the filename, etc.).
 *
 * We try the `?url` form first because it lets Vite / Webpack 5 /
 * Parcel / Bun emit a stable hashed URL for the wasm in production
 * and serve it directly from `node_modules/` in dev. If the bundler
 * doesn't understand `?url` (raw ESM, e.g. the standalone demo's
 * import map, or a CDN with no bundler), we fall back to resolving
 * relative to this module's URL — which works as long as `fbm.wasm`
 * is co-located with `fbm.js`, the original Emscripten assumption.
 *
 * Note: bundlers that parse-fail on `?url` (e.g. raw Rollup without
 * a URL plugin) won't reach the fallback — they'll error at module
 * load. Consumers in that situation can pass an explicit `locateFile`
 * via `FbmEngine.init({ locateFile })` that returns the wasm URL
 * directly.
 */
async function resolveWasmUrl(): Promise<string> {
    try {
        // Vite/Webpack/Parcel/Bun understand `?url` and return the served URL.
        // The `@vite-ignore` hint is harmless for non-Vite bundlers.
        // @ts-expect-error - `?url` is a bundler-specific suffix
        const mod = (await import("../fbm.wasm?url")) as { default?: string };
        if (mod && typeof mod.default === "string") return mod.default;
    } catch {
        // fall through to the raw-ESM fallback
    }
    // Raw ESM: fbm.wasm lives one directory up from this file
    // (sibling of fbm.js, which is at `dist/fbm.js`).
    return new URL("../fbm.wasm", import.meta.url).href;
}

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
    const wasmUrl = await resolveWasmUrl();
    const userLocateFile = options?.locateFile;
    // Always route the wasm path through our resolved URL. Non-wasm
    // paths go through the consumer's locateFile if provided, otherwise
    // fall back to import.meta.url (Emscripten's default).
    const locateFile = (path: string, scriptDirectory: string): string => {
        if (path === "fbm.wasm") return wasmUrl;
        return userLocateFile
            ? userLocateFile(path, scriptDirectory)
            : new URL(path, scriptDirectory).href;
    };
    cachedModule = await initRaw({ locateFile } as never);
};

export default FbmEngineLoader;
