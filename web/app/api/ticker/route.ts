import { getTickerBoard } from "@/lib/bitget";

/**
 * The strip refreshes itself against this route, not against Bitget, so the only thing
 * the browser talks to is this site. The edge keeps one answer for thirty seconds, so a
 * hundred open tabs cost Bitget and this host one call in that time, not a hundred.
 */
export const revalidate = 30;
export async function GET(): Promise<Response> {
  const board = await getTickerBoard();
  return Response.json(board, {
    headers: { "cache-control": "public, s-maxage=30, stale-while-revalidate=60" },
  });
}
