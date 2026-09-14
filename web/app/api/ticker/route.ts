import { getTickerBoard } from "@/lib/bitget";

export const dynamic = "force-dynamic";

/** The strip refreshes itself against this route, not against Bitget, so the only thing
 * the browser talks to is this site. */
export async function GET(): Promise<Response> {
  const board = await getTickerBoard();
  return Response.json(board, { headers: { "cache-control": "no-store" } });
}
