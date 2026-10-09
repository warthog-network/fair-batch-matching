import initRaw from "./src/loader.js";

export type {
    FbmEngine,
    FbmEngineClass,
    FbmEngineConfig,
    FbmConfig,
    InitOptions,
    Order,
    SetPoolInput,
    OkResponse,
    ErrorResponse,
    MutatorResult,
    MatchResult,
    Matched,
    Matched as MatchedSnapshot,
    MatchedOrder,
    PoolSnapshot,
    ToPool,
    Filled,
} from "./index.d";

export default initRaw;
