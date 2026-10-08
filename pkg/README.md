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
e.addSell({ price: "1", amount: "10" }); // Swap 10 units of base for quote (sell base) 
e.addBuy({ price: "1", amount: "5" });   // Swap 5 units of quote for base (buy base)

// Match liquidity pool and orders using Fair Batch Matching
console.log(e.match()); 
//=> { buys: [...], sells: [...], matched: { base: "5", quote: "5", price: 1 } }
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
- The `feeE4` parameter specifies the pool fee that takers pay when interacting with the liquidity pool and accepts integers `0-9999` with default value `5` if omitted. The fee corresponds to this value multiplied by `0.0001%`. In particular, the default value corresponds to `0.05%`. The fee can be changed later using `e.setFee({ E4: 30 });`.

There is no global state such that multiple instances can coexist if needed.

### Configuring the Pool

Each instance has an associated liquidity pool. The base and quote currency reserves of this pool are empty by default but can be configured as follows:
```ts
// Set both reserves at once.
e.setPool({ base: "100", quote: "200" });

// Or just one — the other is preserved.
e.setPool({ base: "100" });
e.setPool({ quote: "200" });
```
The method returns `{ ok: true }` on success, `{ error: "..." }` on failure. The whole call is atomic: if either provided field is invalid, neither reserve changes.

### Configuring the Order Book
The order book consists of swap orders with a specific price and amount to be swapped, i.e. the swap's input amount. Note that this is different  is an important difference to traditional order books on centralized exchanges where the amount of a buy order specifies the amount of base currency to be purchased, i.e. the trade's output amount.

#### Adding Orders
New orders are added as follows:
```ts
// Add swap orders, amount always specifies refers the swap's input currency
e.addSell({ price: "1", amount: "10" }); // Swap 10 units of base for quote (sell base) 
e.addBuy({ price: "1", amount: "5" });   // Swap 5 units of quote for base (buy base)
```
Adding multiple orders at the same price results in a single aggregated order with the total amount.

The methods return `{ ok: true }` on success, `{ error: "..." }` on failure. 
#### Deleting Orders

```ts
e.deleteOrder({ base: true,  index: 0 });     // first sell order
e.deleteOrder({ base: false, index: 0 });     // first buy order
```

### Pre-Validating Input
To pre-validate the string parameters used above, the following validation methods can be used:

```ts
e.validatePrice({ price: "1.0" });        // for `price` in `addBuy` and `addSell`
e.validateBaseAmount({ amount: "5" });    // for `quote` in `setPool` and `amount` in `addBuy`
e.validateQuoteAmount({ amount: "5" });   // for `base` in `setPool` and `amount` in `addSell`
```
The amount validation functions account for the currency's respective number allowed decimal digits.



### Running the Matching Engine

The `match()` method computes the Fair Batch Matching based on the previously configured pool and order book.
```ts
const m = e.match();
```
Its output has the following structure:

```ts
const m: MatchResult = {
  // Book after matching, sorted (buys DESC, sells ASC).
  // The array index is what you pass to `deleteOrder`.
  //   amount = original order size
  //   filled = how much was consumed
  //   limit  = the order's limit price (quote per base)
  buys:  [{ amount: "5.00000000",  filled: "5.00000000",  limit: 1 }],
  sells: [{ amount: "10.00000000", filled: "5.00000000",  limit: 1 }],

  // Pool reserves at match time. `price` is the spot price quote/base.
  poolBefore: { base: "100.00000000", quote: "200.00000000", price: 2 },
  poolAfter:  { base: "100.00000000", quote: "100.00000000", price: 1 },

  // The pool's side of the swap, or null if no swap happened.
  //   isQuote: true  → pool bought quote (WART) from a seller
  //                    (base left, quote entered the pool)
  //   isQuote: false → pool sold quote to a buyer
  //                    (base entered, quote left the pool)
  toPool: { isQuote: true, base: "0.00000000", quote: "100.00000000", price: 1 },

  // Executed legs. `out*` is what that side released, `in*` what it
  // received, `price*` the executed price. Seller row, then buyer row.
  filled: {
    outBaseSeller: "5.00000000", inQuoteSeller: "5.00000000", priceSeller: 1,
    outQuoteBuyer: "5.00000000", inBaseBuyer:   "5.00000000", priceBuyer:  1,
  },

  // The cleared trade, or null if no orders crossed.
  matched: { base: "5.00000000", quote: "5.00000000", price: 1 },
};
```
Matching with an empty pool is supported.

## Getters

```ts
e.getConfig();   //=> { baseDecimals: 3, feeE4: 30 }
e.getPool();     //=> { base: "100.00000000", quote: "200.00000000" }
```

`getPool()` returns `{ base: "0", quote: "0" }` (not `"0.00000000"`) for
an unconfigured pool.


## License

MIT.
