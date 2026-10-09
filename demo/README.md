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
    // Pool reserves default to (0, 0) until you call setPool.
    const engine = new Module.FbmEngine({ baseDecimals: 8, feeE4: 5 });
    engine.setPool({ base: "100", quote: "200" });
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

| Method | Input | Side effects / return |
|---|---|---|
| `setPool` | `{ base?: string, quote?: string }` (both optional) | updates pool reserves. **Missing keys preserve current value**. **Atomic**: if any provided field is invalid, the whole call is rejected and neither reserve changes. |
| `setFeeE4` | `number` (0–9999, basis points) | updates `feeE4` only on range check; failure leaves prior value |
| `addBuy` | `Order` (`{ limit, amount }`, amount in WART) | inserts buy order |
| `addSell` | `Order` (`{ limit, amount }`, amount in base token) | inserts sell order |
| `deleteBuyAt` | `number` (index) | returns the deleted `Order`, or `null` if not found |
| `deleteSellAt` | `number` (index) | returns the deleted `Order`, or `null` if not found |
| `getBuyAt` | `number` (index) | returns the `Order`, or `null` if not found. Does not mutate. |
| `getSellAt` | `number` (index) | returns the `Order`, or `null` if not found. Does not mutate. |
| `validateLimit` | `string` | parses limit only, **no state change**; use for live field validation |
| `validateBaseAmount` | `string` (WART, 8 dp) | parses buy amount only, **no state change** |
| `validateQuoteAmount` | `string` (TOKEN) | parses sell amount with current `baseDecimals`, **no state change** |

### Match — explicit

| Method | Return |
|---|---|
| `match()` | full `MatchResult` object — never null. `match().buys` / `match().sells` carry `{ amount, filled, limit }` per row (same shape as the add input plus the matched fill). |

### Getters

| Method | Return |
|---|---|
| `getConfig()` | `{ baseDecimals: number, feeE4: number }` |
| `getPool()` | `{ base: string, quote: string }` (formatted with current decimals; defaults to `{ base: "0", quote: "0" }` for an unconfigured pool) |

## Demo state model

The demo tracks field validity on the JS side (not the engine side).
For each input — pool base, pool quote, fee, buy/sell limit, buy/sell
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

Live field validation: as the user types in `buyLimit` /
`buyAmount` / `sellLimit` / `sellAmount`, the demo calls
`engine.validateLimit` / `validateBaseAmount` / `validateQuoteAmount`
on every input event. Each method returns `{ ok }` / `{ error }`
without touching engine state. The "Add buy" / "Add sell" buttons are
disabled until their two respective fields and the pool reserves are
all valid.

For details on the FBM algorithm itself, see
[the FBM paper](https://warthog.network/FairBatchMatching.pdf).