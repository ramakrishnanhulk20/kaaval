import { createReadStream, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { dataDir } from "@/lib/record";
import { fetchTradesCsv, recordUrl } from "@/lib/record-http";

export const dynamic = "force-dynamic";

const HEADERS = {
  "content-type": "text/csv; charset=utf-8",
  "content-disposition": 'attachment; filename="kaaval-trades-simulated.csv"',
  "cache-control": "no-store",
};

const MISSING = "No trade log has been written yet.\n";

/**
 * The six field trade log the program asks for, streamed straight off disk. The engine
 * appends to this file as fills happen and scripts/export-log.ts rebuilds it from the
 * signed ledger, so what downloads here can always be produced again from the record.
 *
 * A host reading the published record has no disk to stream from, so it passes the
 * published file through byte for byte.
 */
export async function GET(): Promise<Response> {
  if (recordUrl() !== null) {
    const published = await fetchTradesCsv();
    if (!published?.body) {
      return new Response(MISSING, {
        status: 404,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    return new Response(published.body, { headers: HEADERS });
  }

  const file = join(dataDir(), "trades.csv");
  if (!existsSync(file)) {
    return new Response(MISSING, {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  const stream = Readable.toWeb(createReadStream(file)) as ReadableStream<Uint8Array>;
  return new Response(stream, {
    headers: { ...HEADERS, "content-length": String(statSync(file).size) },
  });
}
