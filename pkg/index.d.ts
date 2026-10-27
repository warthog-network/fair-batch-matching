import type { MainModule } from "./index.raw";

/* ---------- Configuration ---------- */

export interface FbmConfig {
    /**
     * Initial base token decimals, 0..18. Default `8`. Fixed at
     * construction; immutable for the lifetime of the instance. To use a
     * different decimal count, construct a new `FbmEngine`.
     */
    baseDecimals?: number;
    /**
     * Initial pool trading fee in 1/10000 units, 0..9999. Default `50`
     * (0.50%), the same fee the Warthog node applies to pool swaps.
     */
    feeE4?: number;
}

/* ---------- Order type ---------- */

/**
 * A free-form label for an order.
 *
 * The caption is metadata only: it never influences the matching in any
 * way, and it is **not unique**, several orders may carry the same one.
 * It is set when the order is added and stays with it for its whole life.
 */
export type Caption = string;

/**
 * A single order in the book. Same shape for buys and sells, same shape
 * whether passed to `addBuy` / `addSell` or returned by `getBuyAt` /
 * `getSellAt` / `deleteBuyAt` / `deleteSellAt`. The `amount` is formatted
 * in the order's own decimals: WART (8 dp) for buys, `baseDecimals` for
 * sells.
 *
 * The `limit` is the decimal rendering of the order's price, produced by
 * the shortest string that parses back to the same value.
 */
export interface Order {
    amount: string;
    limit: string;
    /**
     * The limit as raw price-grid bits: `mantissa | exponent << 16`.
     *
     * This is the exact form. The engine snaps every limit onto a
     * 16-bit mantissa grid, and the decimal `limit` string is a
     * rendering of that grid point, so re-parsing it can land on a
     * neighbouring cell. Passing `limitBits` back to `addBuy` /
     * `addSell` restores the order bit for bit, with no decimal round
     * trip in between.
     */
    limitBits: number;
    /** The order's caption, an empty string when it has none. */
    caption: Caption;
}

/**
 * Input for `addBuy` / `addSell`.
 *
 * Provide either `limit` (decimal string, snapped onto the price grid)
 * or `limitBits` (exact grid value). `limitBits` takes precedence when
 * both are given.
 */
export interface OrderInput {
    amount: string;
    limit?: string;
    limitBits?: number;
    /**
     * A free-form label for the order. It never influences the matching
     * and it is not unique, several orders may share one. Missing = no
     * caption. At most 256 bytes.
     */
    caption?: Caption;
}

/* ---------- Input interfaces ---------- */

export interface SetPoolInput {
    /** Base token amount (decimals = `baseDecimals`). Missing = preserve current. */
    base?: string;
    /** WART amount (8 decimals). Missing = preserve current. */
    quote?: string;
}

/* ---------- Mutator responses ---------- */

export interface OkResponse {
    ok: true;
}

export interface ErrorResponse {
    error: string;
}

export type MutatorResult = OkResponse | ErrorResponse;

/**
 * The result of a mutator that removes orders. It reports how many orders
 * were actually removed.
 */
export type DeleteResult = (OkResponse & { deleted: number }) | ErrorResponse;

/* ---------- Match result ---------- */

/**
 * A single order in the book, together with what a match did to it.
 *
 * `filled` is the amount filled on the **input** side: base for a sell
 * order, quote (WART) for a buy order.
 *
 * `proceeds` is the amount received on the **output** side: quote (WART)
 * for a sell order, base for a buy order. It is the floor-rounded
 * proportional share of the matched amount, so the sum of all proceeds is
 * slightly less than the matched total. The remainder is the rounding
 * dust, reported as `pool.dust`.
 *
 * The price is not repeated here, the price level carries it.
 */
export interface MatchedOrder {
    /** The order's own size. */
    amount: string;
    filled: string;
    proceeds: string;
    /** The order's caption, an empty string when it has none. */
    caption: Caption;
}

/**
 * One price level of the book: the orders sharing a limit price, with
 * their amounts summed.
 *
 * The price levels are the units the Fair Batch Matching actually matches
 * on: the book is aggregated by price level before the matching runs, and
 * the result is distributed back to the individual orders afterwards.
 *
 * `filled` and `proceeds` are the sums over the orders at the level. The
 * proceeds of a level are what those orders actually received, which is
 * deliberately not the same as the floor-rounded share of the level total:
 * the difference is part of the rounding dust.
 */
export interface MatchedLevel {
    /** The level's limit price (quote per base), the same rendering as an order's. */
    limit: string;
    /** The level's limit as raw price-grid bits: `mantissa | exponent << 16`. */
    limitBits: number;
    /** Sum of the amounts of the orders at this level. */
    amount: string;
    /** Sum of the amounts filled at this level. */
    filled: string;
    /** Sum of the amounts received at this level. */
    proceeds: string;
    /** The individual orders at this level, oldest first. */
    orders: MatchedOrder[];
}

export interface PoolSnapshot {
    base: string;
    quote: string;
    price: number;
}

/**
 * The real part of the pool flow: the amounts a match exchanged with the
 * pool reserves.
 *
 * The match pushes one currency into the reserves and takes the other out
 * of them (the excess that found no counterparty in the order book).
 * `isQuote` tells which way round it went: `true` means quote went in and
 * base came out, `false` means base went in and quote came out.
 */
export interface PoolSwap {
    isQuote: boolean;
    /** Amount pushed into the pool reserves. */
    in: string;
    /** Amount taken out of the pool reserves. */
    out: string;
    /** Price of the swap, quote per base. */
    price: number;
}

/**
 * The rounding dust a match credited back to the pool reserves.
 *
 * When a match is distributed back to the individual orders, the output
 * side is split proportionally with a *floor* division, so a few units are
 * lost. The node credits that remainder to the pool reserves; the engine
 * reports it here and includes it in `pool.after`.
 *
 * The dust exists in both currencies independently and it also arises when
 * the pool is not traded with at all.
 */
export interface PoolDust {
    /** Base dust credited to the pool reserves. */
    base: string;
    /** Quote dust credited to the pool reserves. */
    quote: string;
}

/** Everything a match did to the pool reserves. */
export interface MatchPool {
    /** Reserves before the match. */
    before: PoolSnapshot;
    /** Reserves after the match: `before` + `swap` + `dust`. */
    after: PoolSnapshot;
    /** The real exchange with the reserves, `null` if the pool was not traded with. */
    swap: PoolSwap | null;
    /** The rounding dust credited back to the reserves. */
    dust: PoolDust;
}

export interface Filled {
    /** Base the sellers gave, gross (includes the part that went into the pool). */
    outBaseSeller: string;
    /** Quote the sellers received, i.e. the sum of the sell orders' proceeds. */
    inQuoteSeller: string;
    /** Price the sellers got, quote per base. */
    priceSeller: number;
    /** Quote the buyers paid, gross (includes the part that went into the pool). */
    outQuoteBuyer: string;
    /** Base the buyers received, i.e. the sum of the buy orders' proceeds. */
    inBaseBuyer: string;
    /** Price the buyers paid, base per quote. */
    priceBuyer: number;
}

export interface Matched {
    /**
     * Base that changed hands between the orders, counting what the pool
     * contributed.
     */
    base: string;
    /**
     * Quote that changed hands between the orders, counting what the pool
     * contributed.
     */
    quote: string;
    price: number | null;
}

export interface MatchResult {
    /**
     * The buy side, aggregated by price level and descending by limit.
     * These are the units the matching actually ran on, and each level
     * carries its individual orders.
     */
    buys: MatchedLevel[];
    /**
     * The sell side, aggregated by price level and descending by limit.
     * These are the units the matching actually ran on, and each level
     * carries its individual orders.
     */
    sells: MatchedLevel[];
    pool: MatchPool;
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
 * **Mutators** (`setPool`, `setFeeE4`, `addBuy`, `addSell`,
 * `deleteBuyAt`, `deleteSellAt`) return `{ ok }` or `{ error }` and
 * never trigger a match. **Matching is explicit** — call
 * `engine.match()` whenever you want a fresh `MatchResult`. The
 * engine itself never returns null from `match()`; a `(0, 0)` pool
 * is treated as a valid (if degenerate) input.
 *
 * **Node parity.** `match()` reproduces the Warthog node's matching
 * pipeline: the book is aggregated by price level, the FBM runs on the
 * levels, and the matched amounts are distributed back to the individual
 * orders. The output side of that distribution is split proportionally
 * with a floor division, so a few units are lost; the node credits that
 * rounding dust back to the pool reserves and the engine reports it as
 * `pool.dust` and includes it in `pool.after`.
 *
 * The result carries the book aggregated by price level: `buys` and
 * `sells` hold one entry per price level, and each level carries its
 * individual orders in `orders`.
 *
 * `match()` does not mutate any state: the pool reserves and the book
 * are unchanged after the call.
 */
export type FbmEngine = Omit<
    RawFbmEngineInstance,
    | "setPool"
    | "setFeeE4"
    | "addBuy"
    | "addSell"
    | "deleteBuyAt"
    | "deleteSellAt"
    | "deleteBuysAtPrice"
    | "deleteSellsAtPrice"
    | "validateLimit"
    | "validateBaseAmount"
    | "validateQuoteAmount"
    | "getConfig"
    | "getPool"
    | "getBuyAt"
    | "getSellAt"
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
    /** Sets the pool fee in 1/10000 units (basis points), 0..9999. */
    setFeeE4(e4: number): MutatorResult;
    addBuy(input: OrderInput): MutatorResult;
    addSell(input: OrderInput): MutatorResult;
    /**
     * Removes the buy order at the given `index` (from the most recent
     * `match().buys`). Returns the deleted `Order` (the same shape as
     * the add input) or `null` if no order is found at that index.
     */
    deleteBuyAt(index: number): Order | null;
    /**
     * Removes the sell order at the given `index` (from the most recent
     * `match().sells`). Returns the deleted `Order` (the same shape as
     * the add input) or `null` if no order is found at that index.
     */
    deleteSellAt(index: number): Order | null;
    /**
     * Removes every buy order at the given price level. `limitBits` is the
     * exact price-grid value of the level, as reported by `limitBits` on
     * an order or on a level row of `match().buys`.
     *
     * Returns how many orders were removed, or `{ error }` if the limit
     * is not a valid price-grid value.
     */
    deleteBuysAtPrice(limitBits: number): DeleteResult;
    /**
     * Removes every sell order at the given price level. `limitBits` is
     * the exact price-grid value of the level, as reported by `limitBits`
     * on an order or on a level row of `match().sells`.
     *
     * Returns how many orders were removed, or `{ error }` if the limit
     * is not a valid price-grid value.
     */
    deleteSellsAtPrice(limitBits: number): DeleteResult;
    /**
     * Pure-parse validators. Return `{ ok }` if the input is valid, or
     * `{ error }` describing why not. **No state is mutated** — these
     * are safe to call from `oninput` listeners for live feedback.
     */
    validateLimit(limit: string): MutatorResult;
    /** Validates a WART amount (8 decimals). Used by `addBuy` and `setPool`. */
    validateBaseAmount(amount: string): MutatorResult;
    /** Validates a base-token amount (current `baseDecimals`). Used by `addSell` and `setPool`. */
    validateQuoteAmount(amount: string): MutatorResult;
    getConfig(): FbmEngineConfig;
    getPool(): { base: string; quote: string };
    /**
     * Returns the buy order at the given `index` (from the most recent
     * `match().buys`). The returned `Order` has `filled: "0"` because
     * no match has been run (or the last match state is not retained).
     * Returns `null` if no order is found at that index.
     */
    getBuyAt(index: number): Order | null;
    /**
     * Returns the sell order at the given `index` (from the most recent
     * `match().sells`). The returned `Order` has `filled: "0"` because
     * no match has been run (or the last match state is not retained).
     * Returns `null` if no order is found at that index.
     */
    getSellAt(index: number): Order | null;
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
     * Override resolution for non-wasm asset paths. The package routes
     * the `fbm.wasm` path through its own resolution (`?url` in
     * Vite/Webpack/Parcel/Bun, sibling-file fallback for raw ESM) —
     * most consumers won't need this. If you pass a `locateFile` it
     * handles non-wasm paths; the wasm path is always routed through
     * the package's own resolution.
     */
    locateFile?: (path: string, scriptDirectory: string) => string;
}

declare const FbmEngine: FbmEngineClass;
export default FbmEngine;
