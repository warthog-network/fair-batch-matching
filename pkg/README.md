# warthog-fbm

TypeScript bindings for the **Fair Batch Matching (FBM)** engine, the
MEV-proof DeFi matching algorithm at the heart of
[Warthog Network](https://www.warthog.network/).

The package wraps the WASM build produced by the
[`fair-batch-matching`](https://github.com/warthog-network/fair-batch-matching)
repo. It exposes a strict, hand-typed class surface built on top of
Embind's auto-generated (imprecise) types via a two-file declaration
architecture.

## Install

```sh
npm install warthog-fbm
```

## Usage

```ts
import FbmEngine, { type FbmEngine as Engine } from "warthog-fbm";

// Load the wasm module once.
await FbmEngine.init();

// Create an engine instance. Multiple instances are supported — each
// owns its own order book and pool, all backed by the same wasm module.
// Pool reserves default to (0, 0) until you call setPoolBase / setPoolQuote.
const e: Engine = new FbmEngine({ baseDecimals: 8, feeE4: 5 });

// Configure the pool. Each mutator returns { ok } or { error }.
e.setPoolBase({ value: "100" });
e.setPoolQuote({ value: "200" });

// Insert orders.
e.addSell({ price: "1", amount: "10" });
e.addBuy({ price: "1", amount: "5" });

// Match explicitly. The engine never auto-resets match, the results, so
// the consumer (or demo) is in charge of when to compute.
const m = e.match();
console.log(m.matched.price, m.buys);

// Reset the book + pool. Missing keys (here: feeE4) keep their current
// value rather than reverting to defaults.
e.reset({ baseDecimals: 3 });
console.log(e.getConfig());   // { baseDecimals: 3, feeE4: 5 }

// Both forms work — empty config (no changes) vs. explicit:
//   e.reset();              // clears book + pool, keeps config
//   e.reset({});            // same as above
//   e.reset({ baseDecimals: 3 });  // clears + updates baseDecimals, feeE4 preserved
//   e.reset({ baseDecimals: 'oops' });  // atomic failure — nothing changes

// Getters for the current config and pool reserves.
console.log(e.getPoolBase());    // "0.000"
console.log(e.getPoolQuote());   // "0.00000000"
```

## API

`FbmEngine` is a class (exposed as the default export) with a static
`init()` for one-time wasm loading and a constructor for creating
matches. Each instance has 10 mutator/match methods and 3 getters.

### Mutators (return `{ ok }` or `{ error }`)

| Method | Input | Atomic semantics |
|---|---|---|
| `setPoolBase` | `{ value: string }` | updates `poolToken` only on parse success; failure leaves prior value |
| `setPoolQuote` | `{ value: string }` | updates `poolWart` only on parse success; failure leaves prior value |
| `setFee` | `{ E4: number }` (0–9999) | updates `feeE4` only on parse success; failure leaves prior value |
| `addBuy` | `{ price: string, amount: string }` (WART) | inserts buy order |
| `addSell` | `{ price: string, amount: string }` (TOKEN) | inserts sell order |
| `deleteOrder` | `{ base: boolean, index: number }` | removes one order |
| `validatePrice` | `{ price: string }` | parses `price` only, **no state change**. Returns `{ ok }` or `{ error }`. Use for live field validation. |
| `validateBaseAmount` | `{ amount: string }` (WART, 8 dp) | parses buy order's quote-side amount, **no state change**. Use for live field validation. |
| `validateQuoteAmount` | `{ amount: string }` (TOKEN) | parses sell order's base-side amount with current `baseDecimals`, **no state change**. Use for live field validation. |
| `reset` | no arg, or `{ baseDecimals?, feeE4? }` (both optional) | clears book + zeros pool, optionally updates config. **Missing keys preserve current value**, they do not revert to defaults. **No-arg form clears without changing config** — same as `reset({})`. **Atomic**: if any provided field is invalid, the whole call is rejected and book / pool / config are left untouched. |

**Atomicity invariant** (every mutator above): the engine parses the input **before** mutating any state. If parsing throws or returns `nullopt`, the engine returns `{ error: ... }` and the corresponding instance field is unchanged. There is no "half-applied" state — a successful `{ ok: true }` means the full input was accepted and applied; a failed `{ error: ... }` means **no** state was touched. This holds for `setPoolBase`, `setPoolQuote`, `setFee`, and `reset({...})`. (`addBuy` / `addSell` / `deleteOrder` also follow it but their error envelope is "rejected", not "preserved prior" — they only fail when the book can't accept the operation.)

### Match (separate from mutators)

| Method | Return |
|---|---|
| `match()` | full `MatchResult` object — never null, even with a `(0, 0)` pool |

### Getters

| Method | Return |
|---|---|
| `getConfig()` | `{ baseDecimals: number, feeE4: number }` |
| `getPoolBase()` | `string` formatted with current `baseDecimals` (defaults to `"0"` formatted with `baseDecimals=8` when the pool is unconfigured) |
| `getPoolQuote()` | `string` (WART, 8 decimals; defaults to `"0.00000000"`) |

> **`getPoolBase()` returns `"0"` (not `"0.00000000"`) for an unconfigured pool.** The underlying `FundsDecimal::to_string` short-circuits to `"0"` regardless of decimal count. Same for `getPoolQuote()`. Don't pad zero output to compare with `"0.00000000"` — those are different.

### Multiple instances

Each `new FbmEngine(config)` creates an independent engine with its own order book, pool, `baseDecimals`, and `feeE4`. The wasm module is shared; the state is not.

```ts
const Fbm = await import("warthog-fbm").then(m => m.default);
await Fbm.init();

const a = new Fbm({ baseDecimals: 3, feeE4: 5 });
const b = new Fbm({ baseDecimals: 8, feeE4: 10 });

a.setPoolBase({ value: "100" });
b.setPoolBase({ value: "999" });
console.log(a.getPoolBase()); // "100.000"
console.log(b.getPoolBase()); // "999.00000000"  — independent
```

### Match result shape

```ts
interface MatchResult {
  buys:        Array<{ amount: string; filled: string; limit: number }>;
  sells:       Array<{ amount: string; filled: string; limit: number }>;
  poolBefore:  { base: string; quote: string; price: number };
  poolAfter:   { base: string; quote: string; price: number };
  toPool:      { isQuote: boolean; base: string; quote: string; price: number } | null;
  filled: {
    outBaseSeller: string; inQuoteSeller: string; priceSeller: number;
    outQuoteBuyer:  string; inBaseBuyer:    string; priceBuyer:  number;
  };
  matched:     { base: string; quote: string; price: number | null };
}
```

## Invariant — no mid-flight `baseDecimals` change

Pool reserves and order amounts are stored as integers parsed with
the current `baseDecimals` setting. Changing `baseDecimals` mid-flight
would silently re-interpret those integers under a different decimal
count, e.g. `100` parsed as `"1.000"` (3 dp) would suddenly display as
`"100"` (0 dp) or `"100.000000"` (6 dp). The numbers are well-formed
but no longer mean what they meant when entered. To prevent this:

- **No `setBaseDecimals` method exists.** The only path that changes
  `baseDecimals` is `reset({ baseDecimals })`, which atomically clears
  the book + zeros both pool reserves — so no pre-existing value can
  be misread under the new decimal count.

```ts
// Worked example: why this matters
const e = new FbmEngine({ baseDecimals: 3 });
// pool is (0, 0) by default until you call setPoolBase / setPoolQuote.
e.setPoolBase({ value: "100" });
console.log(e.getPoolBase());   // "100.000"  — meaning 100 base tokens at 3 decimals

// If we naively added setBaseDecimals(6), the same integer 100_000
// would now display as "100.000000" — meaning 100 base tokens at 6
// decimals, i.e. 0.1 tokens. Wrong silently. Hence the reset-only
// invariant.
```

## Demo state model

The demo tracks `poolBase.valid` and `poolQuote.valid` on the JS side
and gates the live match on `valid && valid`. The engine itself is
permissive — `engine.match()` always returns a full result, even with a
`(0, 0)` pool. Validity is a UI concern, not an engine concern.

### Live field validation pattern

The recommended pattern for form fields that drive mutators is to call
the corresponding `validate*` method on every input event and gate the
submit button on all of them:

```ts
function updateBuyButton() {
    addBuyButton.disabled = !(state.poolBase.valid && state.poolQuote.valid
        && state.buyPrice.valid && state.buyAmount.valid);
}

buyPriceEl.addEventListener("input", () => {
    const r = engine.validatePrice({ price: buyPriceEl.value });
    state.buyPrice.valid = "ok" in r;
    buyPriceError.textContent = "error" in r ? r.error : "";
    buyPriceEl.classList.toggle("invalid", !state.buyPrice.valid);
    updateBuyButton();
});
```

The `validate*` methods are pure-parse — they don't touch any engine state, just parse and return `{ ok }` / `{ error }`. Calling them on every keystroke is safe.

### Rendering the order book from `match()` output

The order book tables in the demo are populated from `engine.match()`'s `buys` and `sells` arrays — not from a parallel JS-side order list. Each row carries `{ amount, filled, limit }` directly from the engine, and the engine's sorted order (buys DESC, sells ASC) is what the delete buttons index into:

```ts
state.lastMatch.buys.forEach((row, i) => {
    const tr = ...;
    btn.dataset.buyIndex = String(i);   // ← index into engine's book
    tr.insertCell().textContent = row.amount;
    tr.insertCell().textContent = row.filled;
    tr.insertCell().textContent = String(row.limit);
});
```

This avoids drift between JS state and engine state — there's nothing to keep in sync.

## How the types are built

This package uses a **two-file declaration architecture**:

1. `index.raw.d.ts` — auto-generated by `emcc --emit-tsd`. Reflects
   the Embind bindings verbatim; class method signatures are all
   `(_0: any) => any`.
2. `index.d.ts` — handwritten public types. Imports `MainModule` from
   `index.raw`, uses `InstanceType<MainModule["FbmEngine"]>` + `Omit<>`
   to slice away the imprecise method signatures, and re-adds them
   with strict interfaces.

The package's `tsconfig.build.json` does not emit declarations from
`.ts` files (`declaration: false`); the handwritten `index.d.ts` is
copied verbatim into `dist/` by the `publish:assets` step. So
`tsc` never overwrites the hand-curated public surface, while
type-level drift between C++ Embind and the TS wrapper is caught at
compile time.

## Wasm loading

`fbm.wasm` is fetched relative to the loader module. The default
`locateFile` keeps it next to `fbm.js`, which is where bundlers
(Vite, webpack, esbuild, Bun) and plain `<script type="module">`
setups both expect it. To override the URL, pass `locateFile` to
`init()`:

```ts
await FbmEngine.init({
    locateFile: (path, prefix) => `https://cdn.example.com/${path}`,
});
```

## License

MIT — same as the parent `fair-batch-matching` repo.