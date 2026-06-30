import {
  extractParseableJsonObject,
  stripLlmJsonNoise,
} from "@/lib/parsing/extract-parseable-json";

export interface NovelCharacter {
  name: string;
  role: string;
  personality: string;
  background: string;
}

export interface NovelWorldbuilding {
  setting: string;
  rules: string;
  themes: string;
  characters: NovelCharacter[];
}

export interface NovelParagraph {
  id: number;
  outline: string;
  draft: string;
  content: string;
}

export interface NovelChapter {
  id: number;
  title: string;
  outline: string;
  paragraphs: NovelParagraph[];
  content: string;
}

export interface NovelOutline {
  id: number;
  title: string;
  summary: string;
  worldbuilding: NovelWorldbuilding;
  chapters: NovelChapter[];
  rawContent: string;
}

export const NOVEL_OUTLINES_STORAGE_KEY = "novel.outlines.v2";
export const NOVEL_LAUNCH_SESSION_KEY = "novel.launch.session.v1";

export type LaunchSession = {
  prompt: string;
  /** 为 true 时进入 /outlines 后立即开跑大纲（默认 false：先落到底栏可改，再点「生成大纲」） */
  autoGenerate: boolean;
};

const EMPTY_OUTLINES: NovelOutline[] = [];
let cachedOutlinesRaw: string | null | undefined;
let cachedOutlinesValue: NovelOutline[] = EMPTY_OUTLINES;

const decodeEscaped = (value: string): string =>
  value
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, "\"")
    .replace(/\\\\/g, "\\")
    .trim();

const pickTextField = (
  source: Record<string, unknown> | null,
  keys: string[],
): string => {
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

const PENDING_MARKERS = ["生成中...", "扩写中...", "续写中", "写段中..."];

const isStableText = (value: string): boolean => {
  const text = value.trim();
  if (!text) return false;
  return !PENDING_MARKERS.some(
    (marker) => text.includes(marker) || text.startsWith(marker),
  );
};

export const isChapterOutputComplete = (
  chapter: Pick<NovelChapter, "content" | "paragraphs">,
): boolean => {
  if (chapter.paragraphs?.length) {
    return chapter.paragraphs.every(
      (paragraph) =>
        isStableText(paragraph.content) && paragraph.content.trim().length >= 120,
    );
  }
  return isStableText(chapter.content);
};

export const isOutlineOutputComplete = (
  outline: Pick<NovelOutline, "rawContent" | "chapters">,
): boolean => {
  if (!outline.rawContent.trim()) return false;
  if (!outline.chapters.length) return false;
  return outline.chapters.every((chapter) => {
    const title = chapter.title?.trim();
    const chapterOutline = chapter.outline?.trim();
    return Boolean(title) && Boolean(chapterOutline);
  });
};

/**
 * Strip JSON envelope leftovers that leak into rendered text when the model's
 * output never properly closes (`{"content":"…prose…` truncated mid-stream):
 *   - leading `{` / `["content":"`
 *   - trailing `"`, `}`, or a stray opening `{` from a partial second object
 * Conservative: only nibbles obvious JSON-syntax chars at boundaries, never
 * touches the middle of the prose.
 */
const stripJsonEnvelopeNoise = (text: string): string => {
  let out = text;
  out = out.replace(/^\s*\{?\s*"(?:content|text)"\s*:\s*"?/, "");
  out = out.replace(/["}\s]*\{?\s*$/, "");
  return out.trim();
};

export const normalizeChapterContent = (raw: string): string => {
  const cleaned = stripLlmJsonNoise(raw);
  if (!cleaned) return "";

  const parsed = extractParseableJsonObject(cleaned);
  const fromJSON = pickTextField(parsed, ["content", "text"]);
  if (fromJSON) return fromJSON;

  const fromQuoted = extractQuotedField(cleaned, "content");
  if (fromQuoted) return fromQuoted;

  return stripJsonEnvelopeNoise(decodeEscaped(cleaned));
};

export const persistOutlines = (outlines: NovelOutline[]): void => {
  if (typeof window === "undefined") return;
  const serialized = JSON.stringify(outlines);
  localStorage.setItem(NOVEL_OUTLINES_STORAGE_KEY, serialized);
  cachedOutlinesRaw = serialized;
  cachedOutlinesValue = outlines;
};

export const readPersistedOutlines = (): NovelOutline[] => {
  if (typeof window === "undefined") return EMPTY_OUTLINES;

  const raw = localStorage.getItem(NOVEL_OUTLINES_STORAGE_KEY);
  if (raw === cachedOutlinesRaw) return cachedOutlinesValue;

  cachedOutlinesRaw = raw;
  if (!raw) {
    cachedOutlinesValue = EMPTY_OUTLINES;
    return cachedOutlinesValue;
  }

  const parsed = JSON.parse(raw) as unknown;
  cachedOutlinesValue = Array.isArray(parsed) ? (parsed as NovelOutline[]) : EMPTY_OUTLINES;
  return cachedOutlinesValue;
};

export const subscribePersistedOutlines = (
  onStoreChange: () => void,
): (() => void) => {
  if (typeof window === "undefined") return () => {};

  const handleStorage = (event: StorageEvent) => {
    if (event.storageArea !== window.localStorage) return;
    if (event.key !== NOVEL_OUTLINES_STORAGE_KEY) return;
    onStoreChange();
  };

  window.addEventListener("storage", handleStorage);
  const interval = window.setInterval(onStoreChange, 1000);

  return () => {
    window.removeEventListener("storage", handleStorage);
    window.clearInterval(interval);
  };
};

export const clearPersistedOutlines = (): void => {
  if (typeof window === "undefined") return;
  localStorage.removeItem(NOVEL_OUTLINES_STORAGE_KEY);
  cachedOutlinesRaw = null;
  cachedOutlinesValue = EMPTY_OUTLINES;
};

export const peekLaunchSession = (): LaunchSession | null => {
  if (typeof window === "undefined") return null;

  const raw = localStorage.getItem(NOVEL_LAUNCH_SESSION_KEY);
  if (!raw) return null;

  const parsed = JSON.parse(raw) as Partial<LaunchSession>;
  const prompt = typeof parsed.prompt === "string" ? parsed.prompt.trim() : "";
  if (!prompt) return null;
  return { prompt, autoGenerate: parsed.autoGenerate === true };
};

export const clearLaunchSessionStorage = (): void => {
  if (typeof window === "undefined") return;
  localStorage.removeItem(NOVEL_LAUNCH_SESSION_KEY);
};

export const setLaunchPrompt = (prompt: string, autoGenerate = false): void => {
  if (typeof window === "undefined") return;
  const session: LaunchSession = { prompt, autoGenerate };
  localStorage.setItem(NOVEL_LAUNCH_SESSION_KEY, JSON.stringify(session));
};

export const consumeLaunchSession = (): LaunchSession | null => {
  const session = peekLaunchSession();
  if (session) clearLaunchSessionStorage();
  return session;
};

/** Stable empty snapshot for useSyncExternalStore's server-snapshot argument. */
export const getServerPersistedOutlinesSnapshot = (): NovelOutline[] =>
  EMPTY_OUTLINES;
