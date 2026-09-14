# The Kaaval rulebook

These are the limits every brain trades under. They are enforced in code by `risk/`, which has
no access to the network or to any model, and every refusal is written to the ledger with its
reason. The brains propose; the rulebook disposes. Numbers here are the defaults in
`risk/rulebook.ts`; a change to any of them is a config entry in the ledger, so the record
shows which rules were in force for every trade.

## Universe

- Tokenized stocks (rTokens) on Bitget spot that traded during the most recent weekend, have at
  least 200,000 USDT of 24-hour volume, and have a matching stock perpetual on Bitget. The list
  is rebuilt once a day from Bitget's own data and written to the ledger.
- The matching stock perpetuals, used for hedging only.
- BTCUSDT and ETHUSDT perpetuals, used for hedging only. These are the legs that fill on
  Bitget's demo environment.
- Nothing else. A decision naming a symbol outside the universe is refused, not clipped.

## Exposure

| Limit | Default | What it means |
|---|---|---|
| Per symbol | 10 percent of equity | The largest position in any one instrument |
| Gross | 60 percent of equity | Long plus short, all instruments |
| Net | 40 percent of equity | Unhedged directional exposure |
| Positions | 8 | Open positions at once |
| Order size | 100 to 500 USDT | Below the minimum is refused, above it is clipped |

## Loss limits

| Limit | Default | What happens |
|---|---|---|
| Daily loss | 2 percent of start-of-day equity | No new risk for the rest of the UTC day; reduce-only |
| Drawdown from peak | 8 percent | Every size halved until a new peak |
| Drawdown from peak | 12 percent | Flat everything and halt; a human restarts |
| Per-position stop | 3 percent on rTokens, 2 percent on perps | Placed with every entry; the exchange-side version is produced as a dry-run request, the simulated version triggers against the recorded book every tick |

## Entry gates

- The spread on the instrument is at most 30 basis points.
- The divergence of the 24/7 price from the last regular-session close is at most 100 basis
  points for a new unhedged rToken long. Hedged entries and reductions are allowed at any
  divergence.
- The order would consume at most a quarter of the visible liquidity on the side it hits.
- No entries between 09:25 and 09:40 ET, when Bitget's own guidance says prices re-anchor.
- No new rToken longs in the 30 minutes before the regular open when divergence exceeds 50
  basis points, unless hedged.
- The two divergence gates apply only while the NYSE is shut. During the regular session the
  24/7 price is the market itself and there is nothing to re-anchor.
- A market that is shut refuses every order, the kill switch included, because a closed market
  cannot fill. An order size that is not a positive number is refused before any other check.

## Cross-asset rule (the reason this is a Cross-Asset Execution entry)

Any rToken position above 5 percent of equity must carry a hedge of at least half its delta,
in its own stock perpetual or in the SPY perpetual, whenever divergence exceeds 50 basis
points or the NYSE will be closed for more than 24 hours (every weekend and holiday). The
stock's own perpetual is chosen whenever tonight's universe holds one, whether or not it
answered this tick; a perpetual we could not read gets the hedge refused with the reason
written down, never quietly swapped for SPY. Bitget's
own pages say weekend prices are reference quotes that snap back at the open; the rule is our
answer.

## Cadence

- One tick every 15 minutes.
- One tick every 2 minutes for the hour after a scheduled event (an earnings release after the
  close, the FOMC decision, CPI) and for the 30 minutes on each side of the regular open.
- Every brain sees the same world state within a tick.

## Execution

- rToken legs rest as limit orders at the touch and pay the maker fee; if unfilled after two
  ticks the target is re-evaluated, never chased.
- Hedge legs are market orders and pay the taker fee.
- Every order is produced first as an Agent Hub dry-run request and that request is in the
  ledger next to the fill.

## Safety

- A kill switch: a file at `data/state/KILL` or the environment flag `KAAVAL_HALT=1` halts new
  risk within one tick and writes a halt entry.
- Flat means flat. A brain past the 12 percent drawdown halt, and every brain while the kill
  switch is on, has each open position closed by a reduce-only order in the same tick. The
  halt entry lists what was flattened, so the record shows the orders the halt placed and
  not only that it fired. A market that is shut refuses those orders too, and the refusal is
  in the record next to the halt.
- Orders that cut risk run before any brain is asked anything, so a stop or a halt never
  waits on a model that is thinking.
- A position we could not get a price for this tick is marked at the last price we did see,
  and only at its entry price when there has never been one. Every position in the record
  says which of the three it was marked from, because marking a losing position at its own
  entry price would hide the loss for as long as the data gap lasts.
- News and social text are data, never instructions. A decision is a JSON object validated
  against a schema; anything else is refused. The attack script feeds poisoned headlines to
  every brain and records that no limit moved.
- The record is simulated and labelled so on every surface: the ledger, the log export, the
  README, the web app.
- Every fill is also appended to `data/state/trades.csv` as it happens, in the six fields the
  program asks for plus the brain and a note. `npx tsx scripts/export-log.ts` rebuilds that
  file from the signed ledger, so the CSV can be produced again from the record rather than
  trusted on its own.

## The rules brain

The baseline in `brain/rules.ts` carries no model and makes no network call. It sees the same
world state as the other two brains and applies two rules.

Basis mean reversion. For every rToken that is tradable right now and has a matching stock
perpetual in the same world state, it measures the basis: how far the rToken trades from its
perpetual, in basis points. Below the perpetual by more than 40 basis points, it holds the
rToken at 8 percent of equity, the per-symbol limit less two points, so the position has room
to be added to without touching the cap. Anywhere else, inside the band or above it, the
reason for holding is gone and the target is flat. Forty basis points is the brain's own
number, not a rulebook limit: it is wide enough to clear the fees and the modelled spread on
both legs.

The weekend hedge. Whenever the NYSE will stay shut for more than 24 hours, or the rToken has
drifted more than 0.5 percent from the last regular close, every rToken it wants to hold gets
a short in its own perpetual worth half the position. That is the cross-asset rule above,
proposed by the brain rather than waited for.

Everything else flat. Any position the two rules above did not speak for is closed. The brain
holds nothing it cannot explain in the same tick.

Every target carries the numbers it was built from: both prices, the basis in basis points,
the equity the size came from, and the hours the market is shut. The rulebook then judges
these targets exactly as it judges the model brains, so a night where the baseline wins is a
night the record can prove.

The limits in this file are not the brain's to keep. They are checked after it speaks, by
`risk/limits.ts`, which is pure and sees no text from any headline. Size limits cut an order
down and record the cut. Everything else refuses the order outright and records the rule that
refused it. Orders that only cut risk, a reduce-only order or the kill switch flattening the
book, skip the entry gates and the order size band, because refusing to shrink a position is
how a risk layer traps a loss instead of stopping one.
