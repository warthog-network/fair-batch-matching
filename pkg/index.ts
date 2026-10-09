import initRaw from "./src/loader.js";

export type {
    FbmEngine,
    FbmEngineClass,
    FbmEngineConfig,
    FbmConfig,
    InitOptions,
    AddBuyInput,
    AddSellInput,
    SetPoolInput,
    SetFeeInput,
    DeleteBuyInput,
    DeleteSellInput,
    ValidatePriceInput,
    ValidateBaseAmountInput,
    ValidateQuoteAmountInput,
    OkResponse,
    ErrorResponse,
    MutatorResult,
    MatchResult,
    Matched,
    Matched as MatchedSnapshot,
    BuyResult,
    SellResult,
    PoolSnapshot,
    ToPool,
    Filled,
} from "./index.d";

export default initRaw;