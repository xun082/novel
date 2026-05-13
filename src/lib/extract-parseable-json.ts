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
