import { extractParseableJsonObject, stripLlmJsonNoise } from "@/lib/extract-parseable-json";

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

const PENDING_MARKERS = ["生成中...", "扩写中...", "续写中", "写段中..."];

const isStableText = (value: string): boolean => {
  const text = value.trim();
  if (!text) return false;
  return !PENDING_MARKERS.some((marker) => text.includes(marker) || text.startsWith(marker));
};

export const isChapterOutputComplete = (chapter: Pick<NovelChapter, "content" | "paragraphs">): boolean => {
  if (chapter.paragraphs?.length) {
    return chapter.paragraphs.every(
      (paragraph) => isStableText(paragraph.content) && paragraph.content.trim().length >= 120,
    );
  }
  return isStableText(chapter.content);
};
const migrateChapter = (chapter: Partial<NovelChapter> & Record<string, unknown>): NovelChapter => {
  const id = typeof chapter.id === "number" ? chapter.id : 1;
  const title = typeof chapter.title === "string" ? chapter.title : `第${id}章`;
  const outline = typeof chapter.outline === "string" ? chapter.outline : "";
  const content = typeof chapter.content === "string" ? chapter.content : "";

  if (Array.isArray(chapter.paragraphs) && chapter.paragraphs.length > 0) {
    return {
      id,
      title,
      outline,
      content,
      paragraphs: chapter.paragraphs as NovelParagraph[],
    };
  }

  return {
    id,
    title,
    outline,
    content,
    paragraphs: [
      {
        id: 1,
        outline: outline || "待生成",
        draft: "",
        content,
      },
    ],
  };
};

const migrateOutline = (outline: Partial<NovelOutline> & Record<string, unknown>): NovelOutline => {
  const chaptersRaw = Array.isArray(outline.chapters) ? outline.chapters : [];
  const worldbuildingRaw = outline.worldbuilding;

  return {
    id: typeof outline.id === "number" ? outline.id : 1,
    title: typeof outline.title === "string" ? outline.title : "大纲",
    summary: typeof outline.summary === "string" ? outline.summary : "",
    worldbuilding:
      worldbuildingRaw && typeof worldbuildingRaw === "object"
        ? (worldbuildingRaw as NovelWorldbuilding)
        : { setting: "", rules: "", themes: "", characters: [] },
    chapters: chaptersRaw.map((chapter, index) =>
      migrateChapter({
        ...((chapter ?? {}) as unknown as Record<string, unknown>),
        id: (chapter as Partial<NovelChapter>).id ?? index + 1,
      }),
    ),
    rawContent: typeof outline.rawContent === "string" ? outline.rawContent : "",
  };
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
  // Leading: drop `{` and any `"key":"` opener fragment.
  out = out.replace(/^\s*\{?\s*"(?:content|正文|章节内容|text|内容)"\s*:\s*"?/, "");
  // Trailing: drop unbalanced `"`, `}`, and a final stray `{` (partial 2nd obj).
  out = out.replace(/["}\s]*\{?\s*$/, "");
  return out.trim();
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

  return stripJsonEnvelopeNoise(decodeEscaped(cleaned));
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
    cachedOutlinesValue = Array.isArray(parsed)
      ? parsed.map((item) =>
          migrateOutline((item ?? {}) as Partial<NovelOutline> & Record<string, unknown>),
        )
      : EMPTY_OUTLINES;
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
