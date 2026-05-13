import { extractParseableJsonObject, stripLlmJsonNoise } from "@/lib/extract-parseable-json";

export interface NovelChapter {
  id: number;
  title: string;
  outline: string;
  content: string;
}

export interface NovelOutline {
  id: number;
  title: string;
  summary: string;
  chapters: NovelChapter[];
  rawContent: string;
}

export const NOVEL_OUTLINES_STORAGE_KEY = "novel.outlines.v1";
export const NOVEL_LAUNCH_PROMPT_KEY = "novel.launch.prompt.v1";
export const NOVEL_LAUNCH_SESSION_KEY = "novel.launch.session.v1";

export type LaunchSession = {
  prompt: string;
  /** 为 true 时进入 /outlines 后立即开跑大纲（默认 false：先落到底栏可改，再点「生成大纲」） */
  autoGenerate: boolean;
};

const EMPTY_OUTLINES: NovelOutline[] = [];
let cachedOutlinesRaw: string | null | undefined;
let cachedOutlinesValue: NovelOutline[] = EMPTY_OUTLINES;

const cleanRawText = (value: string): string => stripLlmJsonNoise(value);

const decodeEscaped = (value: string): string =>
  value
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, "\"")
    .replace(/\\\\/g, "\\")
    .trim();

const pickTextField = (source: Record<string, unknown> | null, keys: string[]): string => {
  if (!source) return "";
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
};

const extractQuotedField = (raw: string, key: string): string => {
  const keyRegex = new RegExp(`"${key}"\\s*:\\s*"`);
  const keyMatch = raw.match(keyRegex);
  if (!keyMatch || keyMatch.index === undefined) {
    return "";
  }

  const start = keyMatch.index + keyMatch[0].length;
  let escaped = false;
  let result = "";

  for (let i = start; i < raw.length; i++) {
    const char = raw[i];
    if (escaped) {
      escaped = false;
      result += char;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      result += char;
      continue;
    }

    if (char === "\"") {
      break;
    }

    result += char;
  }

  return decodeEscaped(result);
};

const parseRecord = (raw: string): Record<string, unknown> | null => extractParseableJsonObject(raw);

export const isChapterOutputComplete = (value: string): boolean => {
  const text = value.trim();
  if (!text) return false;
  if (text.includes("生成中...") || text.includes("扩写中...") || text.includes("生成失败")) {
    return false;
  }
  if (text.startsWith("续写中")) return false;
  return true;
};

export const isOutlineOutputComplete = (outline: Pick<NovelOutline, "rawContent" | "chapters">): boolean => {
  if (!outline.rawContent.trim()) return false;
  if (!outline.chapters.length) return false;
  return outline.chapters.every((chapter) => {
    const title = chapter.title?.trim();
    const chapterOutline = chapter.outline?.trim();
    return Boolean(title) && Boolean(chapterOutline) && chapterOutline !== "待生成";
  });
};

export const normalizeChapterContent = (raw: string): string => {
  const cleaned = cleanRawText(raw);
  if (!cleaned) return "";

  const parsed = parseRecord(cleaned);
  const fromJSON = pickTextField(parsed, ["content", "正文", "章节内容", "text", "内容"]);
  if (fromJSON) return fromJSON;

  const fromQuoted =
    extractQuotedField(cleaned, "content") ||
    extractQuotedField(cleaned, "正文") ||
    extractQuotedField(cleaned, "章节内容") ||
    extractQuotedField(cleaned, "text");
  if (fromQuoted) return fromQuoted;

  return decodeEscaped(cleaned);
};

export const persistOutlines = (outlines: NovelOutline[]): void => {
  if (typeof window === "undefined") return;
  try {
    const serialized = JSON.stringify(outlines);
    localStorage.setItem(NOVEL_OUTLINES_STORAGE_KEY, serialized);
    cachedOutlinesRaw = serialized;
    cachedOutlinesValue = outlines;
  } catch {
    // ignore storage errors to avoid blocking generation flow
  }
};

export const readPersistedOutlines = (): NovelOutline[] => {
  if (typeof window === "undefined") return EMPTY_OUTLINES;
  try {
    const raw = localStorage.getItem(NOVEL_OUTLINES_STORAGE_KEY);

    if (raw === cachedOutlinesRaw) {
      return cachedOutlinesValue;
    }

    cachedOutlinesRaw = raw;
    if (!raw) {
      cachedOutlinesValue = EMPTY_OUTLINES;
      return cachedOutlinesValue;
    }

    const parsed = JSON.parse(raw) as unknown;
    cachedOutlinesValue = Array.isArray(parsed) ? (parsed as NovelOutline[]) : EMPTY_OUTLINES;
    return cachedOutlinesValue;
  } catch {
    cachedOutlinesRaw = null;
    cachedOutlinesValue = EMPTY_OUTLINES;
    return cachedOutlinesValue;
  }
};

export const subscribePersistedOutlines = (onStoreChange: () => void): (() => void) => {
  if (typeof window === "undefined") return () => {};

  const handleStorage = (event: StorageEvent) => {
    if (event.storageArea !== window.localStorage) return;
    if (event.key !== NOVEL_OUTLINES_STORAGE_KEY) return;
    onStoreChange();
  };

  window.addEventListener("storage", handleStorage);
  // Fallback polling helps when the page is opened in the same tab.
  const interval = window.setInterval(onStoreChange, 1000);

  return () => {
    window.removeEventListener("storage", handleStorage);
    window.clearInterval(interval);
  };
};

export const clearPersistedOutlines = (): void => {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(NOVEL_OUTLINES_STORAGE_KEY);
    cachedOutlinesRaw = null;
    cachedOutlinesValue = EMPTY_OUTLINES;
  } catch {
    // ignore
  }
};

export const peekLaunchSession = (): LaunchSession | null => {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(NOVEL_LAUNCH_SESSION_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<LaunchSession>;
      const p = typeof parsed.prompt === "string" ? parsed.prompt : "";
      if (!p.trim()) return null;
      return {
        prompt: p.trim(),
        autoGenerate: parsed.autoGenerate === true,
      };
    }

    const legacy = localStorage.getItem(NOVEL_LAUNCH_PROMPT_KEY) || "";
    if (!legacy.trim()) return null;
    return { prompt: legacy.trim(), autoGenerate: false };
  } catch {
    return null;
  }
};

export const clearLaunchSessionStorage = (): void => {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(NOVEL_LAUNCH_SESSION_KEY);
    localStorage.removeItem(NOVEL_LAUNCH_PROMPT_KEY);
  } catch {
    // ignore
  }
};

export const setLaunchPrompt = (prompt: string, autoGenerate = false): void => {
  if (typeof window === "undefined") return;
  try {
    const session: LaunchSession = { prompt, autoGenerate };
    localStorage.setItem(NOVEL_LAUNCH_SESSION_KEY, JSON.stringify(session));
    localStorage.removeItem(NOVEL_LAUNCH_PROMPT_KEY);
  } catch {
    // ignore storage errors
  }
};

export const consumeLaunchSession = (): LaunchSession | null => {
  const session = peekLaunchSession();
  if (session) clearLaunchSessionStorage();
  return session;
};

export const getServerPersistedOutlinesSnapshot = (): NovelOutline[] => EMPTY_OUTLINES;
