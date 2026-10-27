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

const e: Engine = new FbmEngine({ baseDecimals: 8, feeE4: 50 });

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
const e: Engine = new FbmEngine({ baseDecimals: 8, feeE4: 50 });
```
- The `baseDecimals` parameter specifies the number of decimal places for the base currency and accepts integers: `0-18`. The default value is `8` if omitted. `baseDecimals` is fixed at construction and cannot be changed for the lifetime of the instance; to use a different decimal count, construct a new `FbmEngine`.
- The `feeE4` parameter specifies the pool fee that takers pay when interacting with the liquidity pool and accepts integers `0-9999` with default value `50` if omitted. The fee corresponds to this value multiplied by `0.0001%`. In particular, the default value corresponds to `0.50%`, which is the fee the Warthog node applies to pool swaps. The fee can be changed later using `e.setFeeE4(30);`.

There is no `quoteDecimals` property because we tailored this library to its use case within the Warthog project such that the quote currency is always WART which has hard coded `8` decimal digits.

The configuration can be queried:
```ts
e.getConfig();   //=> { baseDecimals: 8, feeE4: 50 }
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
Adding multiple orders at the same limit results in a single aggregated price level in the `match()` output, holding the individual orders.

The methods return `{ ok: true }` on success, `{ error: "..." }` on failure. 

#### Captions
An order can carry a caption, a free-form label:
```ts
e.addSell({ limit: "1", amount: "10", caption: "alice" });
```
The caption is metadata only: it never influences the matching, and it is **not unique**, several orders may carry the same one. It is set when the order is added and stays with it. At most 256 bytes.

#### Delete and Lookup Orders

Orders are internally sorted descending by limit, same as returned in the `match()` output below. Delete and look up orders by index:
```ts
e.getBuyAt(0);     // get first buy (highest limit in buys)
e.deleteBuyAt(0);  // get and delete first buy 
e.getSellAt(0);    // get first sell (highest limit in sells)
e.deleteSellAt(0); // get and delete first sell
```

These methods return the deleted order `Order` (`{ amount, limit, limitBits, caption }`) on success, or `null` if no order exists at that index. The order's limit is returned as a string, and its exact price-grid value as `limitBits` (see below).

To remove a whole price level at once, use `deleteBuysAtPrice` / `deleteSellsAtPrice`. They take the level's `limitBits` and remove every order at that price:

```ts
// Remove every buy order at the first price level of the last match.
const level = e.match().buys[0];
e.deleteBuysAtPrice(level.limitBits);   //=> { ok: true, deleted: 3 }
```

#### Exporting and Restoring a Book

Every limit lives on a 16-bit mantissa price grid, so a limit that goes through a decimal string can land on a neighbouring grid cell when it is parsed back. The `limitBits` field carries the grid value itself (`mantissa | exponent << 16`), which makes an export/restore cycle lossless:

```ts
// Export: keep limitBits, not the limit string. The book is reported as
// price levels, each holding its individual orders, so export the orders.
const exported = e.match().buys.flatMap((l) =>
    l.orders.map((o) => ({ limitBits: l.limitBits, amount: o.amount, caption: o.caption })));

// Restore: pass limitBits back.
const restored = new FbmEngine({ baseDecimals: 8, feeE4: 50 });
for (const o of exported) restored.addBuy(o);
```

`addBuy` and `addSell` accept either `limit` (a decimal string, snapped onto the grid) or `limitBits` (the exact grid value). `limitBits` wins when both are given.

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
  // The book after matching, aggregated by price level and sorted
  // descending by limit.
  //
  // The price levels are the units the matching actually runs on: the
  // orders sharing a limit price are aggregated into one entry before the
  // FBM runs, and the result is distributed back to the individual orders
  // afterwards. Properties:
  //   amount = the summed amount of the orders at the level
  //   filled = the summed amount filled at the level
  //   proceeds = the summed amount received at the level
  //   limit  = the level's limit (quote per base)
  //   limitBits = the level's exact price-grid value
  //   orders = the level's individual orders
  //
  // The level's `limitBits` is what you pass to `deleteBuysAtPrice` (for
  // buys) or `deleteSellsAtPrice` (for sells).
  buys:  [],
  sells: [{
    amount: "10.00000000", filled: "10.00000000", proceeds: "18.09090908",
    limit: "1", limitBits: 4227072,
    orders: [
      // The individual orders of the level. The price is not repeated
      // here, the level carries it. Properties:
      //   amount = the order's own size
      //   filled = how much was consumed by the match (input side: base
      //            for sells, quote for buys)
      //   proceeds = how much was received (output side: quote for sells,
      //              base for buys); the floor-rounded proportional share
      //   caption = the order's label, an empty string when it has none
      { amount: "10.00000000", filled: "10.00000000", proceeds: "18.09090908", caption: "" },
    ],
  }],

  // Everything the match did to the pool.
  pool: {
    // Pool reserves before the match. `price` is the spot price quote/base or nil.
    before: { base: "100.00000000", quote: "200.00000000", price: 2 },

    // Pool reserves after the match: `before` + `swap` + `dust`.
    after:  { base: "110.00000000", quote: "181.90909092", price: 1.6537190083636364 },

    // The pool's side of the swap, or null if no swap happened.
    //   isQuote == true : buyer spent quote on pool to swap into base
    //   isQuote == false: seller spent base on pool to swap into quote
    //   in  = amount pushed into the reserves
    //   out = amount taken out of the reserves
    swap: { isQuote: false, in: "10.00000000", out: "18.09090908", price: 1.809090908 },

    // The rounding dust credited back to the reserves. The output side of
    // a match is split between the individual orders with a floor
    // division, so a few units are lost; the node credits them to the
    // pool. The dust exists in both currencies independently and it also
    // arises when the pool is not traded with at all.
    dust: { base: "0", quote: "0" },
  },

  // The buyers' and sellers' total swap's input and output
  filled: {
    outBaseSeller: "10.00000000", inQuoteSeller: "18.09090908", priceSeller: 1.809090908,
    outQuoteBuyer: "0",           inBaseBuyer:   "0",           priceBuyer:  0,
  },

  // The amounts that changed hands between the orders, counting what the
  // pool contributed.
  matched: { base: "0", quote: "18.09090908", price: null },
};
```
Matching with an empty pool is supported.

`match()` does not mutate any state: the pool reserves and the order book
are unchanged after the call.

## License

MIT.
