/**
 * Recovers a single JSON object from model output that may contain:
 * - Multiple concatenated top-level objects (`}{`)
 * - Markdown fences (` ``` ` / ` ```json `) mid-stream
 * - Trailing junk after a valid object
 *
 * Uses brace matching with string/escape awareness (not a full JSON tokenizer).
 */

/** Strips thinking blocks and all ``` / ```json fences (models often reopen fences mid-stream). */
export const stripLlmJsonNoise = (value: string): string =>
  value
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/```(?:json)?/gi, "")
    .trim();

/** Index of the closing `}` that balances the `{` at `openIdx`, or -1 if incomplete. */
const findBalancedJsonEnd = (s: string, openIdx: number): number => {
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = openIdx; i < s.length; i++) {
    const c = s[i];

    if (inString) {
      if (escape) {
        escape = false;
      } else if (c === "\\") {
        escape = true;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }

    if (c === '"') {
      inString = true;
      continue;
    }

    if (c === "{") {
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }

  return -1;
};

const collectBalancedTopLevelSlices = (cleaned: string): string[] => {
  const slices: string[] = [];
  let pos = 0;

  while (pos < cleaned.length) {
    const open = cleaned.indexOf("{", pos);
    if (open === -1) {
      break;
    }
    const end = findBalancedJsonEnd(cleaned, open);
    if (end === -1) {
      break;
    }
    slices.push(cleaned.slice(open, end + 1));
    pos = end + 1;
  }

  return slices;
};

const recoveryScore = (obj: Record<string, unknown>): number => {
  let score = 0;
  if (typeof obj.title === "string" && obj.title.trim()) {
    score += 10;
  }
  if (typeof obj.summary === "string" && obj.summary.trim()) {
    score += 5;
  }
  if (Array.isArray(obj.chapters)) {
    score += Math.min(obj.chapters.length * 3, 60);
  }
  if (typeof obj.content === "string" && obj.content.trim()) {
    score += 8;
  }
  return score;
};

/**
 * Quote-extract a JSON string value for `key` from `raw`, honoring `\"` escapes.
 * Returns "" when not found.
 */
const extractQuotedField = (raw: string, key: string): string => {
  const re = new RegExp(`"${key}"\\s*:\\s*"`);
  const m = raw.match(re);
  if (!m || m.index === undefined) return "";
  const start = m.index + m[0].length;
  let out = "";
  let esc = false;
  for (let i = start; i < raw.length; i++) {
    const c = raw[i];
    if (esc) {
      out += c;
      esc = false;
      continue;
    }
    if (c === "\\") {
      out += c;
      esc = true;
      continue;
    }
    if (c === '"') break;
    out += c;
  }
  return out
    .replace(/\\n/g, "\n")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\")
    .trim();
};

/**
 * Recover chapter records from streaming/broken LLM JSON.
 *
 * Why not just JSON.parse? Outline output regularly arrives malformed in three
 * shapes we've observed in dumps:
 *   A) premature `]` closes `chapters` after one entry; siblings follow as orphans
 *   B) the `}` that ends a chapter is missing → chapter 2 opens inside chapter 1
 *      and every subsequent chapter nests one level deeper
 *   C) the final partial chapter is still streaming (depth > 0 at EOF)
 *
 * Anchor on `"chapter"` KEY occurrences, not brace balance — every chapter
 * boundary is one occurrence regardless of how the surrounding braces nest.
 * For each chunk between adjacent anchors we regex-extract chapter/title/outline
 * (and try strict JSON.parse of a balanced slice when one exists, for the
 * happy-path case where paragraphs are well-formed).
 */
export const extractChapterRecords = (
  raw: string,
): Record<string, unknown>[] => {
  if (!raw) return [];
  const cleaned = stripLlmJsonNoise(raw);
  if (!cleaned) return [];

  const arrayAnchor = cleaned.match(/"(chapters|章节)"\s*:\s*\[/);
  const scanStart =
    arrayAnchor && arrayAnchor.index !== undefined
      ? arrayAnchor.index + arrayAnchor[0].length
      : 0;

  // Match each chapter boundary. The model produces two shapes after a botched
  // close: (a) `{ "chapter": ...}` proper object, (b) bare `"chapter": "..."`
  // siblings without an opener. Match both. The key occurrence anchors a
  // chapter regardless of whether the `{` is present.
  //
  // Guard: the same key string appears inside outline text in some models. Skip
  // when the preceding non-space char is `:` (means we're inside a string
  // value) — JSON ascii structural chars before our key should be `{`, `,`, or `[`.
  const chapterKeyRe = /"(chapter|章节)"\s*:/g;
  chapterKeyRe.lastIndex = scanStart;

  const anchors: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = chapterKeyRe.exec(cleaned)) !== null) {
    let j = m.index - 1;
    while (j >= 0 && /\s/.test(cleaned[j])) j--;
    const prev = j >= 0 ? cleaned[j] : "";
    if (prev !== "{" && prev !== "," && prev !== "[" && prev !== "") continue;
    // Anchor at preceding `{` if present, else at the bare key (no opener).
    anchors.push(prev === "{" ? j : m.index);
  }
  if (anchors.length === 0) return [];

  const findBalanced = (start: number): number => findBalancedJsonEnd(cleaned, start);

  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < anchors.length; i++) {
    const start = anchors[i];
    const nextAnchor = i + 1 < anchors.length ? anchors[i + 1] : cleaned.length;
    const balancedEnd = findBalanced(start);
    const sliceEnd =
      balancedEnd !== -1 && balancedEnd < nextAnchor ? balancedEnd + 1 : nextAnchor;
    const slice = cleaned.slice(start, sliceEnd);

    let recorded = false;
    if (balancedEnd !== -1 && sliceEnd === balancedEnd + 1) {
      try {
        const obj = JSON.parse(slice) as Record<string, unknown>;
        if (!("rules" in obj || "setting" in obj || "characters" in obj)) {
          rows.push(obj);
          recorded = true;
        }
      } catch {
        // fall through
      }
    }
    if (!recorded) {
      const row: Record<string, unknown> = {};
      const chapter =
        extractQuotedField(slice, "chapter") || extractQuotedField(slice, "章节");
      const title =
        extractQuotedField(slice, "title") || extractQuotedField(slice, "标题");
      const outline =
        extractQuotedField(slice, "outline") ||
        extractQuotedField(slice, "梗概") ||
        extractQuotedField(slice, "内容梗概");
      if (chapter) row.chapter = chapter;
      if (title) row.title = title;
      if (outline) row.outline = outline;
      if (Object.keys(row).length > 0) rows.push(row);
    }
  }

  return rows;
};

/**
 * Returns the best-effort single object from noisy LLM text, or null.
 */
export const extractParseableJsonObject = (raw: string): Record<string, unknown> | null => {
  if (!raw || !raw.trim()) {
    return null;
  }

  const cleaned = stripLlmJsonNoise(raw);
  if (!cleaned) {
    return null;
  }

  try {
    return JSON.parse(cleaned) as Record<string, unknown>;
  } catch {
    // fall through
  }

  const slices = collectBalancedTopLevelSlices(cleaned);
  let best: Record<string, unknown> | null = null;
  let bestScore = -1;

  for (const slice of slices) {
    try {
      const obj = JSON.parse(slice) as Record<string, unknown>;
      const score = recoveryScore(obj);
      if (score > bestScore) {
        bestScore = score;
        best = obj;
      }
    } catch {
      // skip invalid slice
    }
  }

  return best;
};
