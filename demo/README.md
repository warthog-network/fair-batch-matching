# FBM Demo

A self-contained demo of the Fair Batch Matching (FBM) engine.

Latest version: [github.com/warthog-network/fair-batch-matching/releases/latest](https://github.com/warthog-network/fair-batch-matching/releases/latest)

## Run

    python3 server.py

Then open http://localhost:8000/demo.html in a browser.

## Files

- `demo.html` — the demo UI (HTML + JS, with a state model for validity tracking)
- `fbm.js`    — Embind loader for the wasm
- `fbm.wasm`  — the matching engine
- `server.py` — tiny Python static server with permissive CORS headers

`fbm.js` and `fbm.wasm` always go together. `fbm.js` looks for `fbm.wasm`
next to itself; renaming either breaks the pairing.

## Embedding the engine (raw, no package)

Drop `fbm.js` and `fbm.wasm` next to your html, then use the raw-loader
pattern. `fbm.js` is the Embind loader; its default export is a factory
that returns the wasm `Module` object. The `FbmEngine` class lives on
`Module.FbmEngine`.

```html
<script type="module">
    import init from "./fbm.js";
    const Module = await init();
    // Pool reserves default to (0, 0) until you call setPoolBase / setPoolQuote.
    const engine = new Module.FbmEngine({ baseDecimals: 8, feeE4: 5 });
    engine.setPoolBase({ value: "100" });
    engine.setPoolQuote({ value: "200" });
    const m = engine.match();
    console.log(m.matched.price);
</script>
```

(If you depend on the npm package `warthog-fbm` instead, the equivalent
is `import FbmEngine from "warthog-fbm"; await FbmEngine.init(); const
engine = new FbmEngine({...})` — same shape, no manual Module.)

`fbm.js` looks for `fbm.wasm` next to itself; rename neither.

## API

`FbmEngine` is a class. Each instance owns its own order book, pool,
fee, and baseDecimals. Multiple instances share the same wasm module.

### Mutators — return `{ ok }` or `{ error }`

| Method | Input | Side effects |
|---|---|---|
| `setPoolBase` | `{ value: string }` | updates `poolToken` only on parse success; failure leaves prior value |
| `setPoolQuote` | `{ value: string }` | updates `poolWart` only on parse success; failure leaves prior value |
| `setFee` | `{ E4: number }` (0–9999) | updates `feeE4` only on parse success; failure leaves prior value |
| `addBuy` | `{ price: string, amount: string }` (WART) | inserts buy order |
| `addSell` | `{ price: string, amount: string }` (TOKEN) | inserts sell order |
| `deleteOrder` | `{ base: boolean, index: number }` | removes one order |
| `validatePrice` | `{ price: string }` | parses price only, **no state change**; use for live field validation |
| `validateBaseAmount` | `{ amount: string }` (WART, 8 dp) | parses buy amount only, **no state change** |
| `validateQuoteAmount` | `{ amount: string }` (TOKEN) | parses sell amount with current `baseDecimals`, **no state change** |
| `reset` | no arg, or `{ baseDecimals?, feeE4? }` (both optional) | clears book + zeros pool, optionally updates config. **Missing keys preserve current value**, they do not revert to defaults. **No-arg form clears without changing config**. **Atomic**: if any provided field is invalid, the whole call is rejected and book / pool / config are left untouched. |

### Match — explicit

| Method | Return |
|---|---|
| `match()` | full `MatchResult` object — never null. `match().buys` / `match().sells` carry `{ amount, filled, limit }` per row. |

### Getters

| Method | Return |
|---|---|
| `getConfig()` | `{ baseDecimals: number, feeE4: number }` |
| `getPoolBase()` | `string` formatted with current `baseDecimals` (defaults to `"0"` formatted with `baseDecimals=8`) |
| `getPoolQuote()` | `string` (WART, 8 decimals; defaults to `"0.00000000"`) |

> Note: `getPoolBase()` / `getPoolQuote()` return `"0"` (not `"0.00000000"`) for an unconfigured pool. The underlying `FundsDecimal::to_string` short-circuits zero values.

## Demo state model

The demo tracks field validity on the JS side (not the engine side).
For each input — pool base, pool quote, fee, buy/sell price, buy/sell
amount — the demo tracks:

- the current `value` the user typed
- a `valid: boolean` reflecting the most recent engine response
- an `error: string` (only when `!valid`)

Two important invariants in the demo:

1. **`engine.match()` is called from exactly one place** — `tryMatch()`.
   Every mutator handler triggers `tryMatch()` after updating state.
   `tryMatch()` calls `engine.match()` only when `poolBase.valid && poolQuote.valid`,
   and renders the result. If invalid, `lastMatch` is set to `null`.
2. **The order book tables render from `engine.match()` output, not from
   a parallel JS-side order list.** `state.lastMatch.buys` and
   `state.lastMatch.sells` carry the engine's sorted order (buys DESC,
   sells ASC) with `{ amount, filled, limit }` per row. Delete buttons
   index directly into the engine's book — there's no parallel state to
   keep in sync.

Live field validation: as the user types in `buyPrice` /
`buyAmount` / `sellPrice` / `sellAmount`, the demo calls
`engine.validatePrice` / `validateBaseAmount` / `validateQuoteAmount`
on every input event. Each method returns `{ ok }` / `{ error }`
without touching engine state. The "Add buy" / "Add sell" buttons are
disabled until their two respective fields and the pool reserves are
all valid.

For details on the FBM algorithm itself, see
[the FBM paper](https://warthog.network/FairBatchMatching.pdf).