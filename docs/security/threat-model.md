# Kaaval threat model

Kaaval's own record holds no real money: every fill is simulated and labelled so. Theft of our
funds is off the list. Since 14 September 2026 the product also holds signed-in traders'
read-only Bitget keys, and that layer has its own rows below. The record's threats are the ones
judges are asked to weigh: someone
steering the brains, someone editing the record, our own code lying to us, and the operator
losing control of a process that runs while nobody watches. This page names each one, what
stops it, and what we did not fix.

There is now a second thing to guard. A trader can sign in and connect their own read-only
Bitget key to get tonight's plan for their own account, so Kaaval stores a credential that
belongs to somebody else. It still moves no money and still sends no order, but a stored key
is worth stealing, and the tables below carry that half of the product too.

## Who the attackers are

| Attacker | What they want | Where they get in |
|---|---|---|
| A poisoned news source | Make a brain buy or sell what the headline says | Every headline, filing title and article body is text the model reads |
| A misbehaving model | Propose a size, a symbol or a hedge the rulebook forbids, or reply with prose instead of a decision | The decision reply |
| A reader of the record who suspects it was tidied | Prove or disprove that a fill or a loss was edited after the fact | The ledger files |
| Our own code | A fill that could not have happened on that book, a balance that drifts from the fills, a stop that never fired | The simulator, the account math, the stop tracker |
| Bitget's API | Rate limits, stale data, a shape change, an outage in the middle of a tick | Every read |
| The operator | Stop a runaway process, restart after a crash without losing the chain | pm2, the kill file, the state file |
| Someone holding a trader's stolen sign-in | Act as that trader: list their keys, run a plan, read their positions | The access token every server action takes as an argument |
| Someone holding a copy of the database | The connected Bitget keys | The `connections` table, where the sealed credential sits |
| Someone holding the server's environment | The seal key, and with it any database copy already taken | `KAAVAL_KEY_SEAL_HEX`, which lives only in the host's environment |
| A trader who pastes a key that can trade | Nothing. This is a mistake rather than an attack, and the damage would be ours to allow | The connect form |
| A signed-in trader hammering the plan action | Our model spend and our room inside Bitget's rate limits | The plan action |
| An account Bitget will not read | Nothing, but it fails at the worst moment, right after a trader pastes a key | The connection check, against an account still in Classic mode |

## What stops each one

| Threat | Control | Where it is proven |
|---|---|---|
| Headline injection | Every headline is placed inside a fenced block prefixed `data:`, the system prompt says such blocks are evidence and never instructions, and the reply is validated as JSON against a schema that only admits symbols present in the world and sizes inside a quarter of equity | `test/brain/schema.test.ts`, `test/brain/ensemble.test.ts`, the injection cases |
| A brain proposing outside the rulebook | Brains produce targets, never orders. `risk/limits.ts` is pure, sees no headline text, clips size caps and refuses everything else with the rule named, and `scripts/attack.ts` runs sixteen hostile scenarios on every change | `npm run attack` |
| Editing the record | Each ledger entry hashes its content and the previous hash and is signed with an Ed25519 key kept outside the repo; `npm run verify:ledger` names the first entry that breaks | `test/ledger/ledger.test.ts`, the tamper demo in `scripts/ledger-demo.ts` |
| A fill that could not have happened | Every fill references the hash of the order book it hit, that book is stored as a snapshot entry, and `npm run replay` recomputes every fill from the snapshot with the fees and slippage model recorded before it | `test/ledger/ledger.test.ts`, `scripts/replay.ts` |
| Balance drift | The paper account is pure and returns a new account per fill; a 2,000-case fuzz test holds the identity equity equals starting balance plus realised plus unrealised | `test/sim/invariants.test.ts` |
| Consuming liquidity that was not there | The fill model refuses any order over a quarter of the visible size on the side it hits and adds a pessimism of a few basis points to every fill | `test/sim/fill.test.ts` |
| A stop that never fires | Stops are recomputed every tick against the recorded quotes and executed before any brain speaks, a position that flipped side gets a new stop rather than keeping the old one, and the exchange-side version is written as a dry-run request in the order entry that arms it | `test/risk/stops.test.ts`, `test/engine` |
| A loss hidden by a missing price | A position with no quote this tick is marked at the last price we saw, never at its entry price, and every position records which of the two it was marked from | `test/engine/state.test.ts` |
| Bitget rate limits and outages | Three requests in flight at most, backoff on 429, a tick that fails to perceive writes nothing and tries again at the next cadence | `src/bitget/client.ts`, `src/news/pace.ts` |
| A runaway process | A file at `data/state/KILL` or `KAAVAL_HALT=1` closes every open position with reduce-only orders and halts new risk within one tick, and the halt entry lists what was flattened; a brain past the drawdown halt is flattened the same way; pm2 restarts a crashed process and the state file resumes it; the ledger chains across restarts | the KILL tests in `test/engine/tick.test.ts` |
| One brain, or one tick, taking the run down with it | A brain whose tick throws is recorded and the next brain still runs, the state is saved after every brain, and a tick that throws is logged and slept off rather than ending the process or inventing a halt entry that is not true | `test/engine/tick.test.ts`, `test/engine/run-engine.test.ts` |
| Secrets in the repo | `.env` is ignored, `.env.example` lists every variable, the pre-commit hook rejects anything that looks like a key, and the ledger's private key lives under `data/secrets` with owner-only permissions | `.gitignore`, `.git/hooks/pre-commit`, `src/ledger/keys.ts` |
| A stolen or forged sign-in | Every server action verifies the access token on the server against this app's own Privy id and secret before it does anything, and the user id it then works with is the one that came out of that check. Nothing is keyed on an id the browser sent. A string that is not shaped like a token is refused before any network call, and no token is ever written to a log or an error | `web/lib/tenant/auth.ts`, `web/test/tenant/auth.test.ts` |
| Reaching another trader's key or plan by guessing an id | The verified user id is part of every select, update and delete rather than a check made before one, so there is no window between the check and the write. A user id is a Privy DID and a connection id is a database uuid, so knowing an id is never the same as being a user | `web/test/tenant/connections.test.ts`, `web/test/tenant/plans.test.ts` |
| A copy of the database | The three credential strings are sealed together with AES-256-GCM under a 32 byte key that exists only in the host's environment, with a fresh random IV per seal, so two rows holding the same key do not even look alike. A copy of the rows is ciphertext and nothing else | `src/tenant/seal.ts`, `test/tenant/seal.test.ts` |
| A copy of the environment | The seal key on its own opens nothing, because the sealed rows are in the database. Either half alone is useless; it takes both | `src/tenant/seal.ts`, `web/lib/tenant/connections.ts` |
| The key leaking while it is in use | A credential is opened on the server for the seconds a plan runs and by nothing else. It is never returned through a server action, never logged, never put in an error message, and the connection list names its columns one by one so a widened table cannot push the sealed value onto a page | `web/lib/tenant/connections.ts`, the listing test in `web/test/tenant/connections.test.ts` |
| A key that is allowed to trade | The surface built for a trader's credential sets the SDK's `readOnly` on, with no argument that can turn it off, so every write action is refused at the SDK's safety check before it reaches a credential or the network. No Bitget operation reports what a key is allowed to do, so we never claim to have checked the key's own permissions. We say what our code does with it | `test/tenant/credentials.test.ts`, the order that is refused and then previewed |
| Hammering the plan action | Six plans an hour per trader, counted in the database against the verified user id rather than a cookie or anything else a browser chooses, so a second tab buys no allowance. Asking twice for the same connection inside five minutes gives back the plan that already exists, and that check runs again inside the write, so two requests that started together still end as one plan | `web/test/tenant/plans.test.ts` |
| Not being able to say what was done to an account | Every connect, reconnect, removal and plan writes a row to `audit` against the user id, in the same transaction as the thing it describes, so there is no case where one lands without the other | `web/lib/tenant/connections.ts`, `web/lib/tenant/plans.ts` |
| A key Bitget will not read at all | Nothing is stored until the check read has come back, so a wrong passphrase leaves no row behind. An account still in Classic mode answers with HTTP 400 and no error code; that case is recognised by its sentence and answered with the one step that fixes it, rather than a stack trace | `src/tenant/credentials.ts`, `test/tenant/credentials.test.ts` |

## What we did not fix, and say so

- **The resting-limit assumption.** A limit order that does not cross the spread is treated
  as filled at its own price. On a thin rToken book that is optimistic. The quarter-of-book
  cap keeps it small; it does not make it true.
- **The simulator is ours.** A judge can replay every fill, but the fill model is still a
  model. Bitget's own demo environment has no stock symbols, so there was no other way to
  paper trade stocks. Crypto hedge legs can run on the demo environment when a demo key is
  present; the stock legs cannot.
- **Divergence is measured against Bitget's own last regular close**, not against the NYSE
  print, because Kaaval reads only Bitget. The two are usually the same number at the bell
  and can differ by a few basis points.
- **Four of the five research Skills Bitget ships proxy a third-party server.** Kaaval does
  not depend on them; its perception is Bitget's own market data plus SEC filings, GDELT and
  Finnhub. If those Skills are added later they will be labelled as enrichment.
- **The model is a black box.** The ensemble, the schema and the rulebook bound what a
  decision can do; they do not explain why a model chose a number. The rationale it writes is
  its own account of itself, and Vidiyal grades that account after the fact.
- **One machine.** The engine ran on a home PC until 18 September 2026 and on one small cloud server since. The PC slept and rebooted, which is every gap in the record; the server restarts the engine by itself after a reboot, and a gap there would show the same way.
  The ledger resumes without a gap in the chain, but with a gap in time, and that gap is
  visible in the timestamps rather than hidden.
- **Both halves together lose the keys.** Somebody who takes the database and the server's
  environment can open every stored credential. Two things blunt that and neither removes it:
  the key a trader gives us is read-only, so whoever opened it could look and not touch, and a
  Bitget key can be revoked in the Bitget app in seconds, which is the first thing we would
  tell every connected trader to do.
- **The seal key is not rotated.** The sealed format carries a version field so a rotation
  could be told apart from a corrupt row, but the script that reads every row, opens it under
  the old key and seals it under a new one does not exist yet. Changing the key today locks
  every trader out of their own connection until they paste the key again.
- **Sign-in belongs to somebody else.** Privy proves who a trader is. If Privy is down, nobody
  signs in and nobody gets a plan, and there is no second way in. Nothing already stored is at
  risk in that hour; it is simply out of reach.
- **A plan shows a trader's positions to the model provider.** On a host with a model key, the
  plan runs the model brain, and the prompt carries the account's equity, its open positions
  and the symbols in front of it. No credential ever goes into a prompt, but that position data
  does leave for the model provider. A host with no model key runs the rules brain alone, and
  nothing about the account leaves.
- **No live unified account has ever been read.** As of 14 September 2026 the only Bitget
  account we hold is in Classic mode, so the account path is proven against recorded responses
  and a stand-in exchange, never against a real UTA key. The reader matches equity, uid, asset
  and position fields across several spellings because Bitget's own shapes vary; those
  spellings stay candidates until a live UTA key settles them, and the screens say so rather
  than showing a number nobody has seen.
