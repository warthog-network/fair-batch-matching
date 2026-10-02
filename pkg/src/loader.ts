// @ts-expect-error - fbm.js is emitted by `meson compile` into this directory
// alongside this source file; TypeScript cannot resolve it before the wasm
// build has run. After `npm run build`, the file is present and the runtime
// import below works as expected.
import initRaw from "../fbm.js";
import type { MainModule } from "../index.raw";

export interface FbmLoaderOptions {
    /** Override wasm URL resolution. Default keeps the wasm next to fbm.js. */
    locateFile?: (path: string, scriptDirectory: string) => string;
}

function withDefaultArg<T>(fn: (arg: T) => unknown): (arg?: T) => unknown {
    return (arg?: T) => fn(arg ?? ({} as T));
}

export default async function init(options: FbmLoaderOptions = {}): Promise<MainModule> {
    const locateFile =
        options.locateFile ?? ((path: string, prefix: string) => `${prefix}${path}`);
    const module = await initRaw({ locateFile } as never);

    // Embind's generated JS wrapper checks argument count strictly. The typed
    // surface allows `clearAndSetBaseDecimals()` with no argument; the
    // runtime wrapper here fills in an empty object when the caller omits it.
    const rawClear = module.clearAndSetBaseDecimals as (arg: unknown) => unknown;
    (module as unknown as { clearAndSetBaseDecimals: typeof rawClear }).clearAndSetBaseDecimals =
        withDefaultArg(rawClear);

    return module;
}