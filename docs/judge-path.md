# The two-minute judge path

Five commands and four pages. At the end of it you will have checked, yourself, that the record
Kaaval publishes was not edited, that every trade in it could really have happened on the order
book it names, and that a brain told to break the rules gets refused.

Kaaval holds no real money. Every fill is simulated against a Bitget order book that was read at
that instant and stored beside the fill, and the word simulated is on every screen that shows a
number.

## Before you start

```bash
npm install
```

The first two commands below need nothing else: no API key, no network, no record. The three
record checks read `data/state`, which is the live record on the machine that runs the engine and
is deliberately not in git. The same output is published at `/proof` on the site and stored in
`data/state/proof/latest.json`.

## 1. The test suite

No network, no keys.

```bash
npm test
```

```
 Test Files  36 passed | 2 skipped (38)
      Tests  307 passed | 6 skipped (313)
```

The two skipped files are the live Bitget reads. They run with `LIVE=1 npm test`.

## 2. Try to break the risk layer

No network, no model, no keys. Sixteen hostile scenarios go to a brain that does whatever the
headline tells it. The risk layer is the only thing in the way. Four of the sixteen are controls:
risk that must still be allowed to leave the book, because a layer that refuses everything is a
wall, not a risk layer.

```bash
npm run attack
```

```
16 scenarios: 10 refused, 2 cut down, 4 allowed.
Every attack landed where the rulebook says it should, and every control still passed.
```

## 3. Check that nobody edited the record

Every ledger entry hashes its content and the previous hash, and every hash is signed with an
Ed25519 key whose private half lives outside the repo. This command checks the chain and every
signature, and names the first entry that breaks.

```bash
npm run verify:ledger -- data/state/ledger
```

```
ledger:     data/state/ledger
public key: 41804536815325110d0feda7c57c9728730464b29a6b8637a458a71b95713a19
chain:      ok, 135 entries verified
replay:     5 of 5 fills reproduce from the recorded books
```

## 4. Re-run every trade against the book it hit

Each fill references the hash of the order book it filled against, and that book is stored in the
ledger as a snapshot. This recomputes every fill from the snapshot, with the fee and slippage model
that was recorded before it.

```bash
npx tsx scripts/replay.ts
```

```
chain:      ok, 135 entries verified
replay:     5 of 5 fills reproduce from the recorded books
replay:     ok
```

## 5. See where the paper accounts stand right now

Realised comes before unrealised on every line, because an unrealised number in a thin book is
partly our own footprint.

```bash
npx tsx scripts/status.ts
```

```
KAAVAL STATUS. Every fill below is simulated against a recorded Bitget order book.
state:      D:\Projects\Bitget\kaaval\data\state\engine.json
ledger:     D:\Projects\Bitget\kaaval\data\state\ledger
last tick:  2026-09-12T07:43:39.807Z, 8 minutes ago
kill switch: off

claude
  equity      9,996.05 usdt, realised -1.27, unrealised -2.68
```

## Then the site, in this order

1. **`/`, scrolled to `#record`.** The scoreboard: for each brain, equity now, the equity curve,
   realised before unrealised, drawdown from the peak, open positions, refusals, and the last
   decision it wrote. Every figure comes from the ledger.
2. **`/timeline?day=2026-09-11`.** One night drawn as time, a lane per brain. The kill switch being
   pulled at 08:42:20Z, the two orders refused under the rule `safety.kill` while it was on, and
   the release at 08:59:09Z all sit where they happened.
3. **Any decision, which opens `/decisions/<seq>`.** The targets the brain proposed and why, the
   world state it saw, the verdict the rulebook gave each target, the Agent Hub dry-run request
   that was built from the survivors, and the fill.
4. **`/proof`, then the `try to break it` button.** On the machine that holds the ledger the button
   re-runs the three checks above and shows you the fresh output. On any other host it shows the
   stored run and says on the page that this host does not run the engine.

## What this path does not show you

It does not prove the fill model is right, only that every fill follows from it and from a real
recorded book. A resting limit order is assumed filled at its own price, which flatters a thin
book. It does not explain why a model chose a number, only that the number was inside the rules.
The threat model at [`security/threat-model.md`](security/threat-model.md) lists the rest.
