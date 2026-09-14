# Where these fixtures come from

These three files stand in for one real Bitget unified account. They are written by
hand, not recorded, because every account read needs a private API key and no read-only
tenant key exists yet. Here is exactly what each field is based on, so the next person
can check them against a real account the day a key arrives.

## What is pinned, and what is not

`vidiyal/docs/dev/account-schemas.md` was generated from the SDK itself and it pins the
request side: the tool names, the actions and every parameter name. It carries no
response bodies. So:

- The call shapes in the tenant code are copied from that document and are exact.
  `account_overview` takes `coin`, `category`, `symbol` and `view`, and has no `action`.
  `position` takes `action: "info"` with a required `category`. `order` takes
  `action: "place"` with `category`, `symbol`, `qty`, `side`, `orderType`.
- The response field names below are the Bitget UTA v3 names as far as we can see them,
  and the reader in `src/tenant/overview.ts` accepts a list of candidate names for every
  number rather than one, for exactly this reason. A name that is not found reads as
  null, never as zero.

## account-assets.json

The wrapper shape: account totals next to a list of coin rows. `src/tenant/account.ts`
also reads a bare array of coin rows, and a test covers both.

- `accountEquity`, `usdtEquity`, `unrealizedPL`: account level totals.
- Coin rows: `coin`, `equity` (the holding valued in USD), `available` and `balance`
  (the holding in coin units), `frozen`, `locked`.
- `rTSLA` is a tokenized stock. Bitget files it as a spot balance, and Kaaval reads it
  as a long SPOT position in `RTSLAUSDT`, which is how the rulebook and the brains
  already speak about it.

## positions.json

Field names anchored on the SDK's own composite test,
`reference/agent-hub/agent-sdk/tests/tools/composite.test.ts` line 240, which returns
`{ symbol, category, total, unrealizedPL }` from `getPositionInfo`. The rest
(`posSide`, `averageOpenPrice`, `markPrice`, `leverage`, `marginCoin`) are the Bitget
UTA v3 names, and the reader accepts alternatives for each.

## account-settings.json

From `getAccountInfo`, the `settings` section of the overview: the holding mode, the
margin mode and the account's own user id, which is what a tenant account is named
after.
