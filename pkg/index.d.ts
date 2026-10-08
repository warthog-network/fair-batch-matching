import type { MainModule } from "./index.raw";

/* ---------- Configuration ---------- */

export interface FbmConfig {
    /**
     * Initial base token decimals, 0..18. Default `8`. Fixed at
     * construction; immutable for the lifetime of the instance. To use a
     * different decimal count, construct a new `FbmEngine`.
     */
    baseDecimals?: number;
    /** Initial pool trading fee in 1/10000 units, 0..9999. Default `5`. */
    feeE4?: number;
}

/* ---------- Input interfaces ---------- */

export interface AddBuyInput {
    price: string;
    amount: string;
}

export interface AddSellInput {
    price: string;
    amount: string;
}

export interface SetPoolInput {
    /** Base token amount (decimals = `baseDecimals`). Missing = preserve current. */
    base?: string;
    /** WART amount (8 decimals). Missing = preserve current. */
    quote?: string;
}

export interface SetFeeInput {
    E4: number;
}

export interface DeleteOrderInput {
    base: boolean;
    index: number;
}

export interface ValidatePriceInput {
    price: string;
}

export interface ValidateBaseAmountInput {
    amount: string;
}

export interface ValidateQuoteAmountInput {
    amount: string;
}

/* ---------- Mutator responses ---------- */

export interface OkResponse {
    ok: true;
}

export interface ErrorResponse {
    error: string;
}

export type MutatorResult = OkResponse | ErrorResponse;

/* ---------- Match result ---------- */

export interface BuyResult {
    amount: string;
    filled: string;
    limit: number;
}

export interface SellResult {
    amount: string;
    filled: string;
    limit: number;
}

export interface PoolSnapshot {
    base: string;
    quote: string;
    price: number;
}

export interface ToPool {
    isQuote: boolean;
    base: string;
    quote: string;
    price: number;
}

export interface Filled {
    outBaseSeller: string;
    inQuoteSeller: string;
    priceSeller: number;
    outQuoteBuyer: string;
    inBaseBuyer: string;
    priceBuyer: number;
}

export interface Matched {
    base: string;
    quote: string;
    price: number | null;
}

export interface MatchResult {
    buys: BuyResult[];
    sells: SellResult[];
    poolBefore: PoolSnapshot;
    poolAfter: PoolSnapshot;
    toPool: ToPool | null;
    filled: Filled;
    matched: Matched;
}

/* ---------- Config / getters ---------- */

export interface FbmEngineConfig {
    baseDecimals: number;
    feeE4: number;
}

/* ---------- Strongly-typed class ---------- */

/*
 * Pull the imprecise instance type out of the auto-generated Embind class.
 * We `Omit<>` the method names so we can re-add them with strict
 * signatures (Embind emits every method as `(_0: any) => any`).
 */
type RawFbmEngineInstance = InstanceType<MainModule["FbmEngine"]>;

/**
 * Fair Batch Matching (FBM) engine instance.
 *
 * **Invariant:** pool reserves and order amounts are stored as integers
 * that were parsed with the current `baseDecimals` setting. Mid-flight
 * changes to `baseDecimals` would silently re-interpret those integers
 * under a different decimal count, producing values that mean something
 * different from what was originally entered. To prevent this, the
 * engine deliberately omits a `setBaseDecimals` method —
 * `baseDecimals` is fixed at construction.
 *
 * **Mutators** (`setPool`, `setFee`, `addBuy`, `addSell`,
 * `deleteOrder`) return `{ ok }` or `{ error }` and never trigger a
 * match. **Matching is explicit** — call `engine.match()` whenever
 * you want a fresh `MatchResult`. The engine itself never returns
 * null from `match()`; a `(0, 0)` pool is treated as a valid (if
 * degenerate) input.
 */
export type FbmEngine = Omit<
    RawFbmEngineInstance,
    | "setPool"
    | "setFee"
    | "addBuy"
    | "addSell"
    | "deleteOrder"
    | "validatePrice"
    | "validateBaseAmount"
    | "validateQuoteAmount"
    | "getConfig"
    | "getPool"
    | "match"
> & {
    /**
     * Sets one or both pool reserves. Both `base` and `quote` are
     * optional — missing fields preserve the current value rather than
     * reverting to defaults.
     *
     * **Atomic**: if any provided field fails validation, the whole
     * call is rejected and neither reserve changes.
     */
    setPool(input: SetPoolInput): MutatorResult;
    setFee(input: SetFeeInput): MutatorResult;
    addBuy(input: AddBuyInput): MutatorResult;
    addSell(input: AddSellInput): MutatorResult;
    deleteOrder(input: DeleteOrderInput): MutatorResult;
    /**
     * Pure-parse validators. Return `{ ok }` if the input is valid, or
     * `{ error }` describing why not. **No state is mutated** — these
     * are safe to call from `oninput` listeners for live feedback.
     */
    validatePrice(input: ValidatePriceInput): MutatorResult;
    validateBaseAmount(input: ValidateBaseAmountInput): MutatorResult;
    validateQuoteAmount(input: ValidateQuoteAmountInput): MutatorResult;
    getConfig(): FbmEngineConfig;
    getPool(): { base: string; quote: string };
    match(): MatchResult;
};

/* ---------- Loader class ---------- */

export interface FbmEngineClass {
    /**
     * Loads the wasm module once. Subsequent calls are idempotent.
     * Must be awaited before constructing the first FbmEngine instance.
     */
    init(options?: InitOptions): Promise<void>;
    /**
     * Constructs a new FbmEngine instance. Throws if `init()` has not
     * yet been awaited.
     */
    new (config?: FbmConfig): FbmEngine;
}

export interface InitOptions {
    /**
     * Override wasm URL resolution. Default keeps `fbm.wasm` next to
     * `fbm.js`, matching the convention used by the demo bundle.
     */
    locateFile?: (path: string, scriptDirectory: string) => string;
}

declare const FbmEngine: FbmEngineClass;
export default FbmEngine;