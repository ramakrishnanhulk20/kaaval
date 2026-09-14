export interface RulebookBlock {
  label: string | null;
  paragraphs: string[];
  bullets: string[];
}

/**
 * The rulebook in the ledger is plain text: a heading on its own line, then bullets that
 * may wrap onto an indented continuation line. This turns it back into blocks so the page
 * can set the headings in mono and the rules in the body face, without editing a word of
 * what was signed.
 */
export function rulebookBlocks(text: string): RulebookBlock[] {
  const blocks: RulebookBlock[] = [];

  for (const chunk of text.split(/\n\s*\n/)) {
    const lines = chunk.split("\n").filter((line) => line.trim() !== "");
    if (lines.length === 0) continue;

    const block: RulebookBlock = { label: null, paragraphs: [], bullets: [] };
    let start = 0;
    const first = lines[0] ?? "";
    if (!first.trimStart().startsWith("-") && lines.length > 1 && first.trim().length < 40) {
      block.label = first.trim();
      start = 1;
    }

    for (let index = start; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      const trimmed = line.trim();
      if (trimmed.startsWith("- ")) {
        block.bullets.push(trimmed.slice(2).trim());
        continue;
      }
      if (block.bullets.length > 0 && line.startsWith("  ")) {
        const last = block.bullets.length - 1;
        block.bullets[last] = `${block.bullets[last] ?? ""} ${trimmed}`;
        continue;
      }
      const previous = block.paragraphs.length - 1;
      if (previous >= 0 && block.bullets.length === 0) {
        block.paragraphs[previous] = `${block.paragraphs[previous] ?? ""} ${trimmed}`;
        continue;
      }
      block.paragraphs.push(trimmed);
    }

    blocks.push(block);
  }

  return blocks;
}
