import { getFourOClock, getPlan, getWatch, vidiyalUrl } from "../lib/story";

function iso(ts: number | null): string {
  return ts === null || ts === 0 ? "none" : new Date(ts).toISOString();
}

async function main(): Promise<void> {
  const four = await getFourOClock();
  console.log("BEAT 2  four o'clock in New York");
  console.log("  et now       ", four.clock.nowEt, four.clock.regularSessionOpen ? "(session open)" : "(session shut)");
  console.log("  last close   ", iso(four.clock.lastRegularClose));
  console.log("  next open    ", iso(four.clock.nextRegularOpen));
  console.log("  ticker as of ", iso(four.asOf), four.tickerError ?? "");
  console.log(
    "  headline     ",
    four.headline === null
      ? "no ticker"
      : `${four.headline.name} ${four.headline.symbol} ${four.headline.last} ${
          four.headline.changePct === null ? "n/a" : `${four.headline.changePct.toFixed(2)}%`
        } ${four.headlineIsTsla ? "(rTSLA)" : "(rTSLA absent, first rToken in the universe)"}`,
  );
  for (const row of four.rows) {
    console.log(
      `  stretch ${row.name.padEnd(7)} ${row.last.toFixed(2).padStart(10)} vs close ${row.anchorClose
        .toFixed(2)
        .padStart(10)} at ${iso(row.anchorTs)}  ${row.pct >= 0 ? "+" : ""}${row.pct.toFixed(2)}%`,
    );
  }
  console.log("  most stretched", four.most === null ? four.note : `${four.most.name} ${four.most.pct.toFixed(2)}%`);

  const watch = await getWatch();
  console.log("");
  console.log("BEAT 3  what the watch does");
  console.log("  SEES symbols ", watch.sees.symbols.join(", "), "| hedges", watch.sees.hedges.join(", "));
  console.log("  SEES book    ", watch.sees.book === null ? "none" : `${watch.sees.book.symbol} bid ${watch.sees.book.bid} ask ${watch.sees.book.ask} spread ${watch.sees.book.spreadBps.toFixed(2)} bps, ${watch.sees.book.levels} levels, ${watch.sees.book.bookHash.slice(0, 12)} at ${iso(watch.sees.book.ts)}`);
  console.log("  SEES news    ", watch.sees.news === null ? "not published with the record" : `${watch.sees.news.items} items gathered ${iso(watch.sees.news.gatheredTs)}`);
  console.log("  SEES clock   ", watch.sees.clock.nowEt, "last entry", iso(watch.sees.lastEntryTs));
  console.log(
    "  DECIDES      ",
    watch.decides === null
      ? "none"
      : `seq ${watch.decides.seq} ${watch.decides.brain} ${iso(watch.decides.ts)} ${watch.decides.targets} targets`,
  );
  if (watch.decides) {
    console.log("    summary    ", watch.decides.summary);
    console.log("    rationale  ", `${watch.decides.symbol}: ${watch.decides.rationale}`);
  }
  console.log(
    "  REFUSES      ",
    watch.refuses === null
      ? "none"
      : `seq ${watch.refuses.seq} ${watch.refuses.brain} rule ${watch.refuses.rule} ${iso(watch.refuses.ts)}`,
  );
  if (watch.refuses) console.log("    reason     ", watch.refuses.reason);
  for (const link of watch.signs.links) {
    console.log(
      `  SIGNS seq ${String(link.seq).padStart(4)} ${link.kind.padEnd(9)} ${link.account.padEnd(7)} hash ${(link.hash ?? "none").slice(0, 12)} prev ${(link.prevHash ?? "none").slice(0, 12)} ${link.signed ? "signed" : "unsigned"}`,
    );
  }
  console.log("  SIGNS key    ", watch.signs.publicKeyHex ?? "none", `(${watch.signs.keySource})`, watch.signs.entries, "entries");

  const plan = await getPlan();
  console.log("");
  console.log("BEAT 5  try before you trust");
  if (plan === null) {
    console.log("  no plan and no decision in the record");
  } else {
    console.log("  path         ", plan.source, "|", plan.caption);
    console.log("  account      ", plan.accountId, plan.id, iso(plan.ts), plan.window ?? "");
    console.log(
      "  before       ",
      plan.before === null
        ? "not in this shape"
        : `equity ${String(plan.before.equity)} balance ${String(plan.before.balanceUsdt)} positions ${String(plan.before.positions)}`,
    );
    for (const brain of plan.brains) {
      console.log(`  brain ${brain.brain}: ${String(brain.targets.length)} targets, ${String(brain.verdicts.length)} verdicts, ${String(brain.orders.length)} orders`);
      for (const verdict of brain.verdicts) {
        console.log(`    verdict ${verdict.allowed ? "allowed" : "refused"} ${verdict.symbol} ${verdict.side} ${String(verdict.notionalUsdt)} rule ${String(verdict.rule)}`);
      }
      for (const order of brain.orders) {
        console.log(`    order ${order.side} ${order.symbol} ${String(order.notionalUsdt)} USDT ${order.dryRun ? "dry run" : "recorded"} ${order.path ?? ""} fill ${order.fill === null ? "none" : order.fill.avgPrice.toFixed(4)}`);
      }
      console.log(`    shadow mark ${brain.shadowMark === null ? "none" : String(brain.shadowMark.equityAfter)}`);
    }
  }

  console.log("");
  console.log("BEAT 7  sister link", vidiyalUrl());
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
