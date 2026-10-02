#include "defi/uint64/orderbook.hpp"
#include "general/funds.hpp"
#include <emscripten.h>
#include <emscripten/bind.h>
#include <emscripten/val.h>
#include <optional>
#include <stdio.h>
using namespace std;

using emval = emscripten::val;

/*
 * FBM wasm bindings.
 *
 * Exposes a single `FbmEngine` class via `EMSCRIPTEN_BINDINGS(fbm)`.
 * Each JS-side `new Module.FbmEngine(config)` call constructs an
 * independent instance with its own order book, pool, `baseDecimals`,
 * and `feeE4`. The wasm module is shared; the state is not.
 *
 * Mutators are atomic: input is parsed before any state mutation, and
 * a parse failure returns `{ error: ... }` with **no** state change.
 * Applies to `setPoolBase`, `setPoolQuote`, `setFee`, and `reset({...})`.
 *
 * `match()` is the only state-reading operation and is always safe to
 * call — it returns a full result even with a `(0, 0)` pool.
 *
 * See the `### fair-batch-matching` section in `AGENTS.md` for
 * cross-repo conventions (rename history, two-file TS declaration,
 * `from_string_adjusted` vs `from_string` rationale).
 */

/*
 * Invariant — pool reserves + order amounts are integers that were parsed
 * with the current `baseDecimals` setting. Changing `baseDecimals`
 * silently re-interprets those integers under a different decimal count,
 * producing values that mean something different from what was originally
 * entered. To prevent this, the engine deliberately omits a
 * `setBaseDecimals` method. The only way to change `baseDecimals` is
 * `reset({ baseDecimals })`, which also clears the book + zeros the pool.
 */

namespace {

emval make_error(const char* msg)
{
    emval obj = emval::object();
    obj.set("error", emval(std::string(msg)));
    return obj;
}

emval make_error(std::string msg)
{
    emval obj = emval::object();
    obj.set("error", emval(std::move(msg)));
    return obj;
}

emval make_ok()
{
    emval obj = emval::object();
    obj.set("ok", emval(true));
    return obj;
}

/*
 * Strict-range int parser used by baseDecimals / feeE4 / setFee.
 * Returns:
 *   - emval::null() if the field is missing or null (caller decides default).
 *   - emval { error } if the field is present but malformed / out of range.
 *   - emval::null() with *out set on success.
 *
 * Coerces via isNumber()/isString() + double/stod because Embind's
 * toWireType<int>/toWireType<std::string> throw JS TypeErrors on
 * non-matching types that C++ try/catch can't unwind.
 */
emval parse_strict_int_field(emval v, const char* key, long minVal, long maxVal, long* out)
{
    if (!v.call<bool>("hasOwnProperty", std::string(key))
        || v[key].isUndefined()
        || v[key].isNull()) {
        return emval::null();
    }
    emval field { v[key] };
    auto rangeStr = std::string("'") + key + "' must be an integer in "
        + std::to_string(minVal) + ".." + std::to_string(maxVal);
    if (field.isNumber()) {
        double n = field.as<double>();
        long rounded = static_cast<long>(n);
        if (n != n || n < static_cast<double>(minVal)
            || n > static_cast<double>(maxVal)
            || static_cast<double>(rounded) != n) {
            return make_error(rangeStr + ", got " + std::to_string(rounded));
        }
        *out = rounded;
        return emval::null();
    }
    if (field.isString()) {
        std::string raw;
        try {
            raw = field.as<std::string>();
        } catch (...) {
            return make_error(rangeStr + ", got non-string value");
        }
        try {
            size_t pos = 0;
            long parsed = std::stol(raw, &pos);
            if (pos != raw.size() || parsed < minVal || parsed > maxVal) {
                return make_error(rangeStr + ", got \"" + raw + "\"");
            }
            *out = parsed;
            return emval::null();
        } catch (...) {
            return make_error(rangeStr + ", got \"" + raw + "\"");
        }
    }
    return make_error(rangeStr + ", got non-numeric value");
}

} // anonymous namespace

class FbmEngine {
private:
    // Parses a buy/sell order. `decimals` selects the token-decimal count
    // for the amount field: WART (8 dp) for buy orders, baseDecimals_
    // for sell orders. The price is parsed with `from_string_adjusted`
    // (not `from_string`) so the stored mantissa+exponent accounts for
    // the WART-vs-baseToken precision difference. Without `_adjusted`,
    // the stored value would round-trip through `to_double_adjusted`
    // as a tiny number (~0.00005) instead of the user-entered value (5).
    defi::Order_uint64 parse_order(emval v, TokenDecimals decimals)
    {
        if (v["price"].isUndefined())
            throw std::runtime_error("Missing 'price' field");
        if (v["amount"].isUndefined())
            throw std::runtime_error("Missing 'amount' field");
        Funds_uint64 amount { [&]() {
            try {
                std::string s { v["amount"].as<std::string>() };
                if (auto o { Funds_uint64::parse(s, decimals) })
                    return *o;
            } catch (...) {
            }
            throw std::runtime_error("Cannot parse amount");
        }() };
        Price_uint64 price { [&]() {
            try {
                return Price_uint64::from_string_adjusted(v["price"].as<std::string>(), baseDecimals_).value();
            } catch (...) {
                throw std::runtime_error("Cannot get price");
            }
        }() };
        return { amount, price };
    }

public:
    // Default constructor: applies member-initializer defaults
    // (baseDecimals=8, feeE4=5, pool=0/0, empty book).
    FbmEngine() = default;

    // Config constructor: accepts an emval (possibly undefined/null/{}).
    // Missing fields use member-initializer defaults.
    // Bad fields throw std::runtime_error, surfaced to JS as a BindingError.
    explicit FbmEngine(emval config)
    {
        if (config.isUndefined() || config.isNull()) {
            return;
        }

        long bd { 8 };
        if (auto err = parse_strict_int_field(config, "baseDecimals", 0, 18, &bd);
            !err.isNull()) {
            throw std::runtime_error(err["error"].as<std::string>());
        }
        baseDecimals_ = TokenDecimals { static_cast<uint8_t>(bd) };

        long fee { 5 };
        if (auto err = parse_strict_int_field(config, "feeE4", 0, 9999, &fee);
            !err.isNull()) {
            throw std::runtime_error(err["error"].as<std::string>());
        }
        feeE4_ = static_cast<uint32_t>(fee);
    }

    // ─── Mutators ────────────────────────────────────────────────────────
    //
    // Each returns { ok } on success or { error } on failure. They never
    // return a match result — that's `match()`'s job.

    // No-arg reset: same as reset({}). The Embind binding requires this
    // overload so callers can write `engine.reset()` without tripping the
    // argument-count check. Both forms go through the same body.
    emval reset() { return reset(emval::object()); }

    emval reset(emval opts)
    {
        // Validate first, mutate last. If any field is invalid, return
        // { error } without touching book / pool / config — consistent
        // with the atomicity of setPoolBase / setPoolQuote / setFee.

        std::optional<TokenDecimals> newBaseDecimals;
        std::optional<uint32_t> newFeeE4;

        // baseDecimals: missing/null → PRESERVE current value (no defaults here).
        if (opts.call<bool>("hasOwnProperty", std::string("baseDecimals"))
            && !opts["baseDecimals"].isUndefined()
            && !opts["baseDecimals"].isNull()) {
            long bd { 0 };
            if (auto err = parse_strict_int_field(opts, "baseDecimals", 0, 18, &bd);
                !err.isNull()) {
                return err;
            }
            newBaseDecimals = TokenDecimals { static_cast<uint8_t>(bd) };
        }

        // feeE4: missing/null → PRESERVE current value.
        if (opts.call<bool>("hasOwnProperty", std::string("feeE4"))
            && !opts["feeE4"].isUndefined()
            && !opts["feeE4"].isNull()) {
            long fee { 0 };
            if (auto err = parse_strict_int_field(opts, "feeE4", 0, 9999, &fee);
                !err.isNull()) {
                return err;
            }
            newFeeE4 = static_cast<uint32_t>(fee);
        }

        // All validations passed — commit the changes.
        if (newBaseDecimals) {
            baseDecimals_ = *newBaseDecimals;
        }
        if (newFeeE4) {
            feeE4_ = *newFeeE4;
        }
        bso_.clear();
        poolToken_ = Funds_uint64::zero();
        poolWart_ = Wart::zero();

        return make_ok();
    }

    emval setPoolBase(emval v)
    {
        std::string raw;
        try {
            raw = v["value"].as<std::string>();
        } catch (...) {
            return make_error("setPoolBase: 'value' must be a string");
        }
        auto parsed = Funds_uint64::parse(raw, baseDecimals_);
        if (!parsed) {
            return make_error(
                "setPoolBase: cannot parse \"" + raw + "\" as base token amount");
        }
        poolToken_ = *parsed; // atomic — failure leaves value alone
        return make_ok();
    }

    emval setPoolQuote(emval v)
    {
        std::string raw;
        try {
            raw = v["value"].as<std::string>();
        } catch (...) {
            return make_error("setPoolQuote: 'value' must be a string");
        }
        Result<Wart> parsed = Wart::try_parse(raw);
        if (!parsed.has_value()) {
            return make_error(
                "setPoolQuote: cannot parse \"" + raw + "\" as WART amount");
        }
        poolWart_ = parsed.value(); // atomic — failure leaves value alone
        return make_ok();
    }

    emval setFee(emval v)
    {
        if (v["E4"].isUndefined()) {
            return make_error("setFee: missing 'E4' field");
        }
        long fee { 0 };
        if (auto err = parse_strict_int_field(v, "E4", 0, 9999, &fee);
            !err.isNull()) {
            return err;
        }
        feeE4_ = static_cast<uint32_t>(fee);
        return make_ok();
    }

    emval addBuy(emval v)
    {
        try {
            auto order { parse_order(v, TokenDecimals::WART) };
            bso_.insert_quote(order);
        } catch (std::runtime_error& e) {
            return make_error(e.what());
        } catch (...) {
            return make_error("Failed to add buy order.");
        }
        return make_ok();
    }

    emval addSell(emval v)
    {
        try {
            auto order { parse_order(v, baseDecimals_) };
            bso_.insert_base(order);
        } catch (std::runtime_error& e) {
            return make_error(e.what());
        } catch (...) {
            return make_error("Failed to add sell order.");
        }
        return make_ok();
    }

    emval deleteOrder(emval v)
    {
        if (v["base"].isUndefined() || v["index"].isUndefined()) {
            return make_error("deleteOrder: missing 'base' or 'index'");
        }
        try {
            bool base = v["base"].as<bool>();
            auto i = v["index"].as<size_t>();
            if (base) {
                bso_.delete_base(i);
            } else {
                bso_.delete_quote(i);
            }
        } catch (...) {
            return make_error("deleteOrder: 'index' must be a non-negative integer");
        }
        return make_ok();
    }

    // ─── Pure-parse validators (no state change) ──────────────────────

    emval validatePrice(emval v)
    {
        if (v["price"].isUndefined())
            return make_error("Missing 'price' field");
        try {
            std::string s { v["price"].as<std::string>() };
            if (!Price_uint64::from_string_adjusted(s, baseDecimals_).has_value())
                return make_error("Cannot parse price");
        } catch (...) {
            return make_error("Cannot parse price");
        }
        return make_ok();
    }

    emval validateBaseAmount(emval v)
    {
        if (v["amount"].isUndefined())
            return make_error("Missing 'amount' field");
        try {
            std::string s { v["amount"].as<std::string>() };
            if (!Funds_uint64::parse(s, TokenDecimals::WART).has_value())
                return make_error("Cannot parse amount");
        } catch (...) {
            return make_error("Cannot parse amount");
        }
        return make_ok();
    }

    emval validateQuoteAmount(emval v)
    {
        if (v["amount"].isUndefined())
            return make_error("Missing 'amount' field");
        try {
            std::string s { v["amount"].as<std::string>() };
            if (!Funds_uint64::parse(s, baseDecimals_).has_value())
                return make_error("Cannot parse amount");
        } catch (...) {
            return make_error("Cannot parse amount");
        }
        return make_ok();
    }

    // ─── Getters ──────────────────────────────────────────────────────────

    emval getConfig() const
    {
        emval obj = emval::object();
        obj.set("baseDecimals", emval(static_cast<int>(baseDecimals_.value())));
        obj.set("feeE4", emval(static_cast<int>(feeE4_)));
        return obj;
    }

    std::string getPoolBase() const
    {
        return poolToken_.to_decimal(baseDecimals_).to_string();
    }

    std::string getPoolQuote() const
    {
        return poolWart_.as_wart().to_string();
    }

    // ─── Match ────────────────────────────────────────────────────────────
    //
    // Always returns a full MatchResult. (0, 0) pool is valid; the result
    // simply has all-zero pool snapshots + no fills. The JS side is
    // responsible for gating when to call this (e.g. only when both pool
    // fields have been successfully set since the last reset).

    emval match() const
    {
        return compute_match();
    }

private:
    emval pool_val(const defi::PoolLiquidity_uint64& pool) const
    {
        auto baseTotal { pool.base.to_decimal(baseDecimals_) };
        auto quoteTotal { pool.quote.as_wart() };
        emval obj = emval::object();
        obj.set("base", emval(baseTotal.to_string()));
        obj.set("quote", emval(quoteTotal.to_string()));
        obj.set("price", emval(quoteTotal.to_double() / baseTotal.to_double()));
        return obj;
    }

    emval compute_match() const
    {
        const defi::PoolLiquidity_uint64 p { poolToken_, poolWart_ };
        auto pTmp { p };
        auto match_res { bso_.match(p) };
        emval buys = emval::array();

        auto fquote { match_res.filled.quote };
        for (size_t i = 0; i < bso_.quote_desc_buy().size(); ++i) {
            auto order { bso_.quote_desc_buy()[i] };
            auto filled { std::min(order.amount, fquote) };
            fquote.subtract_assert(filled);
            emval row = emval::object();
            row.set("amount", emval(order.amount.as_wart().to_string()));
            row.set("filled", emval(filled.as_wart().to_string()));
            row.set("limit", emval(order.limit.to_double_adjusted(baseDecimals_)));
            buys.call<void>("push", row);
        }

        emval sells = emval::array();
        auto J { bso_.base_asc_sell().size() };
        auto fbase { match_res.filled.base };
        for (size_t j = 0; j < J; ++j) {
            auto order { bso_.base_asc_sell()[j] };
            auto filled { std::min(fbase, order.amount) };
            fbase.subtract_assert(filled);
            emval row = emval::object();
            row.set("amount", emval(order.amount.to_decimal(baseDecimals_).to_string()));
            row.set("filled", emval(filled.to_decimal(baseDecimals_).to_string()));
            row.set("limit", emval(order.limit.to_double_adjusted(baseDecimals_)));
            sells.call<void>("push", row);
        }
        sells.call<void>("reverse");

        auto price_val = [&](const defi::BaseQuote_uint64& bq) -> emval {
            return emval(bq.price_double(baseDecimals_, TokenDecimals::WART.value()));
        };

        const auto& toPool { match_res.toPool };
        auto poolBaseQuote { [&]() -> defi::BaseQuote_uint64 {
            if (toPool) {
                if (toPool->is_quote())
                    return {
                        pTmp.buy(toPool->amount(), feeE4_),
                        toPool->amount()
                    };
                else {
                    return {
                        toPool->amount(),
                        pTmp.sell(toPool->amount(), feeE4_),
                    };
                }
            }
            return { 0, 0 };
        }() };

        auto matched { match_res.filled };
        if (auto& toPool { match_res.toPool }) {
            if (toPool->is_quote()) {
                matched.quote.subtract_assert(toPool->amount());
            } else {
                matched.base.subtract_assert(toPool->amount());
            }
        }

        auto toPoolVal = [&]() -> emval {
            if (toPool) {
                emval obj = emval::object();
                obj.set("isQuote", emval(toPool->is_quote()));
                obj.set("base", emval(poolBaseQuote.base.to_decimal(baseDecimals_).to_string()));
                obj.set("quote", emval(poolBaseQuote.quote.as_wart().to_string()));
                obj.set("price", price_val(poolBaseQuote));
                return obj;
            }
            return emval::null();
        };

        auto filledBuyer { matched };
        auto filledSeller { matched };
        if (toPool) {
            if (toPool->is_quote()) {
                filledBuyer.add_assert(poolBaseQuote);
            } else {
                filledSeller.add_assert(poolBaseQuote);
            }
        }

        emval filledObj = emval::object();
        filledObj.set("outBaseSeller", emval(filledSeller.base.to_decimal(baseDecimals_).to_string()));
        filledObj.set("inQuoteSeller", emval(filledSeller.quote.as_wart().to_string()));
        filledObj.set("priceSeller", price_val(filledSeller));
        filledObj.set("outQuoteBuyer", emval(filledBuyer.quote.as_wart().to_string()));
        filledObj.set("inBaseBuyer", emval(filledBuyer.base.to_decimal(baseDecimals_).to_string()));
        filledObj.set("priceBuyer", price_val(filledBuyer));

        emval matchedObj = emval::object();
        matchedObj.set("base", emval(matched.base.to_decimal(baseDecimals_).to_string()));
        matchedObj.set("quote", emval(matched.quote.as_wart().to_string()));
        matchedObj.set("price", matched.quote.is_zero() ? emval::null() : price_val(matched));

        emval matchObj = emval::object();
        matchObj.set("buys", buys);
        matchObj.set("sells", sells);
        matchObj.set("poolBefore", pool_val(p));
        matchObj.set("toPool", toPoolVal());
        matchObj.set("filled", filledObj);
        matchObj.set("matched", matchedObj);
        matchObj.set("poolAfter", pool_val(pTmp));
        return matchObj;
    }

    defi::Orderbook_uint64 bso_;
    Funds_uint64 poolToken_ { 0 };
    Funds_uint64 poolWart_ { 0 };
    uint32_t feeE4_ { 5 };
    TokenDecimals baseDecimals_ { TokenDecimals { 8 } };
};

EMSCRIPTEN_BINDINGS(fbm)
{
    emscripten::class_<FbmEngine>("FbmEngine")
        .constructor<emscripten::val>()
        // Two `reset` overloads bound to the same JS name. The no-arg form
        // makes `engine.reset()` callable; both go through validate-first
        // semantics, so partial-update failures leave book / pool / config
        // untouched.
        .function("reset",
            emscripten::select_overload<emscripten::val()>(&FbmEngine::reset))
        .function("reset",
            emscripten::select_overload<emscripten::val(emscripten::val)>(&FbmEngine::reset))
        .function("setPoolBase", &FbmEngine::setPoolBase)
        .function("setPoolQuote", &FbmEngine::setPoolQuote)
        .function("setFee", &FbmEngine::setFee)
        .function("addBuy", &FbmEngine::addBuy)
        .function("addSell", &FbmEngine::addSell)
        .function("deleteOrder", &FbmEngine::deleteOrder)
        .function("validatePrice", &FbmEngine::validatePrice)
        .function("validateBaseAmount", &FbmEngine::validateBaseAmount)
        .function("validateQuoteAmount", &FbmEngine::validateQuoteAmount)
        .function("getConfig", &FbmEngine::getConfig)
        .function("getPoolBase", &FbmEngine::getPoolBase)
        .function("getPoolQuote", &FbmEngine::getPoolQuote)
        .function("match", &FbmEngine::match);
}
