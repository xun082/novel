/**
 * Recovers a single JSON object from model output that may contain:
 * - Multiple concatenated top-level objects (`}{`)
 * - Markdown fences (` ``` ` / ` ```json `) mid-stream
 * - Trailing junk after a valid object
 *
 * Uses brace matching with string/escape awareness (not a full JSON tokenizer).
 *
 * Key contract: the prompt (see `rwkv-prompts.ts`) asks the model for English
 * JSON keys (`"chapter"`, `"title"`, `"outline"`, …). Extraction here trusts
 * that contract — no Chinese-key 兜底.
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
 * Walk `slice` looking for the `"paragraphs": [` array opener, then pull
 * every paragraph outline out of it — handles both element shapes the model
 * actually emits: `["text", ...]` (plain strings) and `[{"outline":"text"}]`.
 * Stops at the array's closing `]` (or the slice end, for streaming-truncated
 * input). Returns up to 8 entries — chapter paragraphs are short, this is just
 * a runaway guard.
 */
const extractParagraphOutlines = (slice: string): string[] => {
  const anchor = slice.search(/"paragraphs"\s*:\s*\[/);
  if (anchor === -1) return [];
  const arrayStart = slice.indexOf("[", anchor);
  if (arrayStart === -1) return [];

  const out: string[] = [];
  let i = arrayStart + 1;
  while (i < slice.length && out.length < 8) {
    while (i < slice.length && /[\s,]/.test(slice[i])) i++;
    if (i >= slice.length) break;
    const c = slice[i];
    if (c === "]") break;

    if (c === '"') {
      // Plain string element: `"段落要点"`
      const text = readQuotedString(slice, i + 1);
      if (text === null) break;
      if (text.value) out.push(text.value);
      i = text.endIndex + 1;
    } else if (c === "{") {
      // Object element: `{"outline": "段落要点"}` — pull the outline field.
      const objEnd = findBalancedJsonEnd(slice, i);
      const objSlice = slice.slice(i, objEnd === -1 ? slice.length : objEnd + 1);
      const text = extractQuotedField(objSlice, "outline");
      if (text) out.push(text);
      if (objEnd === -1) break;
      i = objEnd + 1;
    } else {
      // Unknown shape — bail rather than spin.
      break;
    }
  }
  return out;
};

const readQuotedString = (
  s: string,
  start: number,
): { value: string; endIndex: number } | null => {
  let out = "";
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (esc) {
      out += c;
      esc = false;
      continue;
    }
    if (c === "\\") {
      esc = true;
      continue;
    }
    if (c === '"') {
      return {
        value: out
          .replace(/\\n/g, "\n")
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, "\\")
          .trim(),
        endIndex: i,
      };
    }
    out += c;
  }
  return null;
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

  const arrayAnchor = cleaned.match(/"chapters"\s*:\s*\[/);
  const scanStart =
    arrayAnchor && arrayAnchor.index !== undefined
      ? arrayAnchor.index + arrayAnchor[0].length
      : 0;

  const chapterKeyRe = /"chapter"\s*:/g;
  chapterKeyRe.lastIndex = scanStart;

  const anchors: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = chapterKeyRe.exec(cleaned)) !== null) {
    let j = m.index - 1;
    while (j >= 0 && /\s/.test(cleaned[j])) j--;
    const prev = j >= 0 ? cleaned[j] : "";
    if (prev !== "{" && prev !== "," && prev !== "[" && prev !== "") continue;
    anchors.push(prev === "{" ? j : m.index);
  }
  if (anchors.length === 0) return [];

  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < anchors.length; i++) {
    const start = anchors[i];
    const nextAnchor = i + 1 < anchors.length ? anchors[i + 1] : cleaned.length;
    const balancedEnd = findBalancedJsonEnd(cleaned, start);
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
        // streaming JSON is regularly malformed; fall through to regex extraction.
      }
    }
    if (!recorded) {
      const row: Record<string, unknown> = {};
      const chapter = extractQuotedField(slice, "chapter");
      const title = extractQuotedField(slice, "title");
      const outline = extractQuotedField(slice, "outline");
      if (chapter) row.chapter = chapter;
      if (title) row.title = title;
      if (outline) row.outline = outline;
      const paragraphs = extractParagraphOutlines(slice);
      if (paragraphs.length > 0) row.paragraphs = paragraphs;
      if (Object.keys(row).length > 0) rows.push(row);
    }
  }

  return rows;
};

/**
 * Returns the best-effort single object from noisy LLM text, or null.
 */
export const extractParseableJsonObject = (
  raw: string,
): Record<string, unknown> | null => {
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
    // The whole blob isn't valid JSON; scan for any balanced object inside it.
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
      // This particular slice's braces didn't form valid JSON; move on.
    }
  }

  return best;
};
