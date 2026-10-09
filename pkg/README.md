# warthog-fbm

TypeScript bindings for [**Fair Batch Matching (FBM)**](https://warthog.network/paper-viewer?pdf=https%3A%2F%2Fraw.githubusercontent.com%2FCoinFuMasterShifu%2FFairBatchMatching%2Fmain%2FFairBatchMatching.pdf&title=Fair%20Batch%20Matching), a MEV-proof DeFi matching engine developed for [Warthog Network](https://www.warthog.network/).
This package is based on a WASM Emscripten build of [`fair-batch-matching`](https://github.com/warthog-network/fair-batch-matching).

Installation:
```sh
npm install warthog-fbm
```

## Usage

### Example
```ts
import FbmEngine, { type FbmEngine as Engine } from "warthog-fbm";

await FbmEngine.init();

const e: Engine = new FbmEngine({ baseDecimals: 8, feeE4: 5 });

// Set the liquidity pool's reserves, default is (0, 0) i.e. empty pool.
e.setPool({ base: "100", quote: "200" });

// Add swap orders, amount always specifies refers the swap's input currency
e.addSell({ limit: "1", amount: "10" }); // Swap 10 units of base for quote (sell base) 
e.addBuy({ limit: "1", amount: "5" });   // Swap 5 units of quote for base (buy base)

// Match liquidity pool and orders using Fair Batch Matching
console.log(e.match()); 
//=> { buys: [...], sells: [...], matched: { base: "0", quote: "0", price: null } }
```

### Setting up the Engine

Before using the Engine we have to import and initialize it as follows:
```ts
import FbmEngine, { type FbmEngine as Engine } from "warthog-fbm";

await FbmEngine.init();
```
The `init()` method asynchroniously fetches the precompiled WASM build and initializes the engine.

### Creating an Instance
All operations are performed on an instance of the imported engine. 
```ts
const e: Engine = new FbmEngine({ baseDecimals: 8, feeE4: 5 });
```
- The `baseDecimals` parameter specifies the number of decimal places for the base currency and accepts integers: `0-18`. The default value is `8` if omitted. `baseDecimals` is fixed at construction and cannot be changed for the lifetime of the instance; to use a different decimal count, construct a new `FbmEngine`.
- The `feeE4` parameter specifies the pool fee that takers pay when interacting with the liquidity pool and accepts integers `0-9999` with default value `5` if omitted. The fee corresponds to this value multiplied by `0.0001%`. In particular, the default value corresponds to `0.05%`. The fee can be changed later using `e.setFeeE4(30);`.

There is no `quoteDecimals` property because we tailored this library to its use case within the Warthog project such that the quote currency is always WART which has hard coded `8` decimal digits.

The configuration can be queried:
```ts
e.getConfig();   //=> { baseDecimals: 8, feeE4: 5 }
```

There is no global state such that multiple instances can coexist if needed.


### Configuring the Pool

Each instance has an associated liquidity pool. The base and quote currency reserves of this pool are empty by default but can be configured as follows:
```ts
// Set both reserves at once.
e.setPool({ base: "100", quote: "200" });

// Or just one, preserving the other.
e.setPool({ base: "100" });
e.setPool({ quote: "200" });
```
The method returns `{ ok: true }` on success, `{ error: "..." }` on failure. The whole call is atomic: if either provided field is invalid, neither reserve changes.

Pool can be retrieved:
```ts
e.getPool();     //=> { base: "100.00000000", quote: "200.00000000" }
```

### Configuring the Order Book
The order book consists of swap orders with a specific limit and amount to be swapped, i.e. the swap's input amount. Note that this is an important difference to traditional order books on centralized exchanges where the amount of a buy order specifies the amount of base currency to be purchased, i.e. the trade's output amount.

#### Add Orders
New orders are added as follows:
```ts
// Add swap orders, amount always specifies refers the swap's input currency
e.addSell({ limit: "1", amount: "10" }); // Swap 10 units of base for quote (sell base) 
e.addBuy({ limit: "1", amount: "5" });   // Swap 5 units of quote for base (buy base)
```
Adding multiple orders at the same limit results in a single aggregated order with the total amount.

The methods return `{ ok: true }` on success, `{ error: "..." }` on failure. 

#### Delete and Lookup Orders

Orders are internally sorted descending by limit, same as returned in the `match()` output below. Delete and look up orders by index:
```ts
e.getBuyAt(0);     // get first buy (highest limit in buys)
e.deleteBuyAt(0);  // get and delete first buy 
e.getSellAt(0);    // get first sell (highest limit in sells)
e.deleteSellAt(0); // get and delete first sell
```

These methods return the deleted order `Order` (`{ amount, limit }`) on success, or `null` if no order exists at that index. The order's limit is returned as a string.

### Pre-Validating Input

To pre-validate the string parameters used above, the following validation methods can be used:

```ts
e.validateLimit("1.0");           // for `limit` in `addBuy` and `addSell`
e.validateBaseAmount("5");       // WART amount (8 decimals) — for setPool and addBuy
e.validateQuoteAmount("5");      // base-token amount (current baseDecimals) — for setPool and addSell
```

Each call returns `{ ok: true }` on success or `{ error: "..." }` on failure. The amount validators account for the currency's respective number of allowed decimal digits (8 for WART, `baseDecimals` for the base token).



### Running the Matching Engine

The `match()` method computes the Fair Batch Matching based on the previously configured pool and order book.
```ts
const m = e.match();
```
Its output has the following structure:

```ts
const m: MatchResult = {
  // Book after matching, sorted descending by limit.
  // The array index is what you pass to `deleteBuyAt` (for buys) or
  // `deleteSellAt` (for sells). Properties:
  //   amount = swap's original input amount
  //   filled = how much was consumed by the match
  //   limit  = the order's limit (quote per base); same field as the add input
  buys:  [{ amount: "5.00000000",  filled: "0",           limit: "1.000000" }],
  sells: [{ amount: "10.00000000", filled: "10.00000000", limit: "1.000000" }],

  // Pool reserves before the match. `price` is the spot price quote/base or nil.
  poolBefore: { base: "100.00000000", quote: "200.00000000", price: 2 },

  // Pool reserves after the match.
  poolAfter:  { base: "110.00000000", quote: "181.82727273", price: 1.6529752066363637 },

  // The pool's side of the swap, or null if no swap happened.
  //   isQuote == true : buyer spent quote on pool to swap into base
  //   isQuote == false: seller spent base on pool to swap into quote
  toPool: { isQuote: false, base: "10.00000000", quote: "18.17272727", price: 1.817272727 },

  // The buyers' and sellers' total swap's input and output
  filled: {
    outBaseSeller: "10.00000000", inQuoteSeller: "18.17272727", priceSeller: 1.817272727,
    outQuoteBuyer: "0",           inBaseBuyer:   "0",           priceBuyer:  null,
  },

  // The matched direct interaction between buyers and sellers in the 
  // order book (without the part that goes to the pool)
  matched: { base: "0", quote: "0", price: null },
};
```
Matching with an empty pool is supported.

## License

MIT.
