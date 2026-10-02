import type { MainModule } from "./index.raw";

/* ---------- Input interfaces (one per Embind function) ---------- */

export interface AddBuyInput {
    price: string;
    amount: string;
}

export interface AddSellInput {
    price: string;
    amount: string;
}

export interface EditPoolInput {
    token: string;
    wart: string;
}

export interface DeleteOrderInput {
    base: boolean;
    index: number;
}

export interface SetFeeInput {
    E4: number;
}

/*
 * The only function with a truly optional input field. We pull the
 * imprecise raw signature off the auto-generated Embind types and
 * intersect it with the strict shape so the optional `baseDecimals?`
 * is enforced at compile time.
 */
type RawClearAndSetBaseDecimals = MainModule["clearAndSetBaseDecimals"];
export type ClearAndSetBaseDecimalsInput =
    Parameters<RawClearAndSetBaseDecimals>[0] & {
        baseDecimals?: number;
    };

/* ---------- Output shapes (mirror src/wasm_callbacks.cpp) ---------- */

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

export type MatchResponse =
    | { match: MatchResult }
    | { error: string }
    | null;

/* ---------- Strongly-typed module ---------- */

export type WarthogFbm = Omit<
    MainModule,
    | "addBuy"
    | "addSell"
    | "editPool"
    | "deleteOrder"
    | "setFee"
    | "clearAndSetBaseDecimals"
> & {
    addBuy(input: AddBuyInput): MatchResponse;
    addSell(input: AddSellInput): MatchResponse;
    editPool(input: EditPoolInput): MatchResponse;
    deleteOrder(input: DeleteOrderInput): MatchResponse;
    setFee(input: SetFeeInput): MatchResponse;
    clearAndSetBaseDecimals(input?: ClearAndSetBaseDecimalsInput): MatchResponse;
};

/* ---------- Init factory ---------- */

export interface InitOptions {
    /**
     * Override wasm URL resolution. Default keeps `fbm.wasm` next to
     * `fbm.js`, matching the convention used by the demo bundle.
     */
    locateFile?: (path: string, scriptDirectory: string) => string;
}

export default function init(options?: InitOptions): Promise<WarthogFbm>;