import initRaw from "./src/loader.js";

export type {
    FbmEngine,
    FbmEngineClass,
    FbmEngineConfig,
    FbmConfig,
    InitOptions,
    Order,
    OrderInput,
    Caption,
    SetPoolInput,
    OkResponse,
    ErrorResponse,
    MutatorResult,
    DeleteResult,
    MatchResult,
    Matched,
    Matched as MatchedSnapshot,
    MatchedOrder,
    MatchedLevel,
    PoolSnapshot,
    PoolSwap,
    PoolDust,
    MatchPool,
    Filled,
} from "./index.d";

export default initRaw;
