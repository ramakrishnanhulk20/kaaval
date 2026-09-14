const WORDS = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight"];

/**
 * The count of brains in the line is the count the record holds, so this sentence and the
 * metadata row can never contradict each other.
 */
export function heroSentence(brains: number): string {
  const word = WORDS[brains] ?? String(brains);
  return `${word} brains trade tokenized US stocks on Bitget through the night under one rulebook. Every decision is written down and signed.`;
}
