import { useEffect, useMemo, useRef } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { normalizeChapterContent } from "@/lib/novel-data";
import { extractParseableJsonObject, stripLlmJsonNoise } from "@/lib/extract-parseable-json";

interface Chapter {
  id: number;
  title: string;
  outline: string;
  content: string;
}

interface Outline {
  id: number;
  title: string;
  summary: string;
  chapters: Chapter[];
  rawContent: string;
}

interface OutlineCardProps {
  outline: Outline;
  onSelect: (outline: Outline) => void;
  isSelected?: boolean;
  isGenerating?: boolean;
}

const pickString = (source: Record<string, unknown> | null, keys: string[]): string => {
  for (const key of keys) {
    const value = source?.[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
};

const parseJSON = (raw: string): Record<string, unknown> | null => extractParseableJsonObject(raw);

const decodeEscaped = (value: string): string =>
  value
    .replace(/\\n/g, "\n")
    .replace(/\\"/g, "\"")
    .replace(/\\\\/g, "\\")
    .trim();

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

const toChapterPreview = (row: Record<string, unknown>, index: number): Chapter => {
  const chapterLabel =
    (typeof row.chapter === "string" && row.chapter.trim()) ||
    (typeof row.章节 === "string" && row.章节.trim()) ||
    (typeof row.chapter === "number" && Number.isFinite(row.chapter) ? `第${row.chapter}章` : "");

  const title =
    (typeof row.title === "string" && row.title.trim()) ||
    (typeof row.标题 === "string" && row.标题.trim()) ||
    chapterLabel ||
    `第${index + 1}章`;

  const outline =
    (typeof row.outline === "string" && row.outline.trim()) ||
    (typeof row.梗概 === "string" && row.梗概.trim()) ||
    (typeof row.内容梗概 === "string" && row.内容梗概.trim()) ||
    "";

  return {
    id: index + 1,
    title,
    outline,
    content: "",
  };
};

const isChapterLikeRow = (row: Record<string, unknown>): boolean => {
  const chapter = row.chapter ?? row.章节;
  const outline = row.outline ?? row.梗概 ?? row.内容梗概;

  if (typeof chapter === "string" && chapter.trim()) return true;
  if (typeof chapter === "number" && Number.isFinite(chapter)) return true;
  if (typeof outline === "string" && outline.trim()) return true;
  return false;
};

const getChapterPreviewFromJSON = (source: Record<string, unknown> | null): Chapter[] => {
  const rawList = source?.chapters ?? source?.章节;
  if (!Array.isArray(rawList)) {
    return [];
  }

  return rawList.map((item, index) => {
    const row = typeof item === "object" && item !== null ? (item as Record<string, unknown>) : {};
    return toChapterPreview(row, index);
  });
};

const getChapterPreviewFromStreamingRaw = (raw: string): Chapter[] => {
  if (!raw.trim()) return [];
  const match = raw.match(/"(chapters|章节)"\s*:\s*\[/);
  if (!match || match.index === undefined) return [];

  const bracketOffset = match[0].lastIndexOf("[");
  if (bracketOffset < 0) return [];
  const arrayStart = match.index + bracketOffset;

  const rows: Record<string, unknown>[] = [];
  let inString = false;
  let escaped = false;
  let depth = 0;
  let objStart = -1;

  for (let i = arrayStart + 1; i < raw.length; i++) {
    const char = raw[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{") {
      if (depth === 0) objStart = i;
      depth += 1;
      continue;
    }

    if (char === "}") {
      if (depth === 0) continue;
      depth -= 1;
      if (depth === 0 && objStart >= 0) {
        const slice = raw.slice(objStart, i + 1);
        try {
          const row = JSON.parse(slice) as Record<string, unknown>;
          rows.push(row);
        } catch {
          // ignore malformed partial object
        }
        objStart = -1;
      }
      continue;
    }

    if (char === "]" && depth === 0) break;
  }

  if (depth > 0 && objStart >= 0) {
    const partial = raw.slice(objStart);
    const row: Record<string, unknown> = {};
    const chapterLabel = extractQuotedField(partial, "chapter") || extractQuotedField(partial, "章节");
    const title = extractQuotedField(partial, "title") || extractQuotedField(partial, "标题");
    const outline = extractQuotedField(partial, "outline") ||
      extractQuotedField(partial, "梗概") ||
      extractQuotedField(partial, "内容梗概");

    if (chapterLabel) row.chapter = chapterLabel;
    if (title) row.title = title;
    if (outline) row.outline = outline;

    if (Object.keys(row).length > 0) {
      rows.push(row);
    }
  }

  return rows.map((row, index) => toChapterPreview(row, index));
};

const getChapterPreviewFromLooseObjects = (raw: string): Chapter[] => {
  if (!raw.trim()) return [];
  const rows: Record<string, unknown>[] = [];
  let inString = false;
  let escaped = false;
  let depth = 0;
  let objStart = -1;

  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{") {
      if (depth === 0) objStart = i;
      depth += 1;
      continue;
    }

    if (char === "}") {
      if (depth === 0) continue;
      depth -= 1;
      if (depth === 0 && objStart >= 0) {
        const slice = raw.slice(objStart, i + 1);
        try {
          const row = JSON.parse(slice) as Record<string, unknown>;
          if (isChapterLikeRow(row)) rows.push(row);
        } catch {
          // ignore malformed object
        }
        objStart = -1;
      }
    }
  }

  if (depth > 0 && objStart >= 0) {
    const partial = raw.slice(objStart);
    const row: Record<string, unknown> = {};
    const chapter =
      extractQuotedField(partial, "chapter") || extractQuotedField(partial, "章节");
    const title = extractQuotedField(partial, "title") || extractQuotedField(partial, "标题");
    const outline =
      extractQuotedField(partial, "outline") ||
      extractQuotedField(partial, "梗概") ||
      extractQuotedField(partial, "内容梗概");

    if (chapter) row.chapter = chapter;
    if (title) row.title = title;
    if (outline) row.outline = outline;
    if (isChapterLikeRow(row)) rows.push(row);
  }

  return rows.map((row, index) => toChapterPreview(row, index));
};

const NODE_STYLES = [
  {
    wrap: "border-l-2 border-l-sky-400/75 bg-sky-500/12",
    title: "text-sky-200",
  },
  {
    wrap: "border-l-2 border-l-emerald-400/75 bg-emerald-500/12",
    title: "text-emerald-200",
  },
  {
    wrap: "border-l-2 border-l-amber-400/80 bg-amber-500/12",
    title: "text-amber-200",
  },
  {
    wrap: "border-l-2 border-l-violet-400/80 bg-violet-500/12",
    title: "text-violet-200",
  },
];

const isChapterDone = (content: string): boolean => {
  const text = content.trim();
  if (!text) return false;
  return (
    !text.includes("生成中...") &&
    !text.includes("扩写中...") &&
    !text.startsWith("续写中") &&
    !text.includes("生成失败")
  );
};

const getChapterContentPreview = (raw: string): { text: string; pending: boolean } => {
  const trimmed = (raw || "").trim();
  if (!trimmed) return { text: "", pending: false };

  const pendingMatch = trimmed.match(/^(生成中|扩写中|续写中)\.\.\.\s*(?:\d+字)?\s*/);
  const pending = Boolean(pendingMatch);
  const body = pending ? trimmed.slice(pendingMatch![0].length).trim() : trimmed;
  return { text: normalizeChapterContent(body), pending };
};

export function OutlineCard({
  outline,
  onSelect,
  isSelected = false,
  isGenerating = false,
}: OutlineCardProps) {
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const hasContent = Boolean(outline.rawContent);

  const streamingPreview = useMemo(
    () => stripLlmJsonNoise(outline.rawContent),
    [outline.rawContent],
  );
  const parsed = useMemo(() => parseJSON(outline.rawContent), [outline.rawContent]);
  const parsedChapterPreview = useMemo(() => getChapterPreviewFromJSON(parsed), [parsed]);
  const streamingChapterPreviewFromArray = useMemo(
    () => getChapterPreviewFromStreamingRaw(streamingPreview),
    [streamingPreview],
  );
  const streamingChapterPreviewFromLooseObjects = useMemo(
    () => getChapterPreviewFromLooseObjects(streamingPreview),
    [streamingPreview],
  );
  const previewTitle = pickString(parsed, ["title", "标题", "小说标题"]) ||
    extractQuotedField(streamingPreview, "title") ||
    extractQuotedField(streamingPreview, "标题");
  const previewSummary = pickString(parsed, ["summary", "梗概", "核心梗概"]) ||
    extractQuotedField(streamingPreview, "summary") ||
    extractQuotedField(streamingPreview, "梗概");
  const displayTitle =
    (outline.title && !outline.title.startsWith("大纲 ") ? outline.title : "") ||
    previewTitle ||
    `大纲 ${outline.id}`;
  const displaySummary =
    (outline.summary && outline.summary !== "正在生成中..." ? outline.summary : "") || previewSummary;
  const chapterPreview =
    outline.chapters.length > 0
      ? outline.chapters
      : (parsedChapterPreview.length > 0
        ? parsedChapterPreview
        : (streamingChapterPreviewFromArray.length > 0
          ? streamingChapterPreviewFromArray
          : streamingChapterPreviewFromLooseObjects));
  const totalChapters = outline.chapters.length;
  const completedChapters = outline.chapters.filter((chapter) => isChapterDone(chapter.content)).length;
  const canOpenDetails = hasContent;

  useEffect(() => {
    if (!isGenerating) return;
    const el = scrollContainerRef.current;
    if (!el) return;
    // 生成中自动滚动到最新内容，避免用户误判为无输出
    el.scrollTop = el.scrollHeight;
  }, [isGenerating, outline.rawContent, outline.chapters]);

  return (
    <Card
      className={[
        "h-full border border-border/80 bg-card/80 backdrop-blur-sm transition-all duration-200",
        isSelected && canOpenDetails ? "border-primary shadow-lg ring-2 ring-primary/20" : "",
        canOpenDetails ? "cursor-pointer hover:shadow-md" : "",
      ].join(" ")}
      onClick={() => {
        if (canOpenDetails) {
          onSelect(outline);
        }
      }}
    >
      <CardContent className="flex h-full flex-col p-3">
        {!hasContent && (
          <div className="flex-1 space-y-2 rounded-xl border bg-muted/40 p-3">
            <p className="text-xs text-muted-foreground">大纲 {outline.id}</p>
            <div className="h-3 w-4/5 animate-pulse rounded bg-muted" />
            <div className="h-3 w-3/5 animate-pulse rounded bg-muted" />
            <div className="h-3 w-4/6 animate-pulse rounded bg-muted" />
          </div>
        )}

        {hasContent && (
          <div
            ref={scrollContainerRef}
            className="flex-1 overflow-y-auto rounded-xl border border-border/70 bg-card/70 p-3"
          >
            <div className="flex items-center justify-between gap-2 text-[11px] leading-4 text-muted-foreground">
              <span>大纲 {outline.id}</span>
              {totalChapters > 0 && (
                <span>
                  {completedChapters}/{totalChapters}
                </span>
              )}
            </div>
            <p className="mt-0.5 text-base font-semibold leading-6 text-foreground">{displayTitle}</p>
            {displaySummary ? (
              <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-foreground/90">
                {displaySummary}
              </p>
            ) : (
              <pre className="mt-2 whitespace-pre-wrap wrap-break-word text-sm leading-6 text-foreground/90">
                {streamingPreview || "正在生成中..."}
              </pre>
            )}

            {chapterPreview.length > 0 && (
              <div className="mt-3 space-y-1.5 rounded-lg bg-muted/20 p-2.5">
                {chapterPreview.map((chapter, index) => {
                  const nodeStyle = NODE_STYLES[index % NODE_STYLES.length];
                  const { text: contentPreview, pending } = getChapterContentPreview(
                    chapter.content,
                  );
                  return (
                    <div
                      key={chapter.id}
                      className={[
                        "rounded-md px-2 py-1.5 transition-colors",
                        nodeStyle.wrap,
                      ].join(" ")}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <p
                          className={[
                            "wrap-break-word text-sm font-semibold",
                            nodeStyle.title,
                          ].join(" ")}
                        >
                          {chapter.title}
                        </p>
                        {contentPreview && (
                          <span
                            className={[
                              "shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium",
                              pending
                                ? "bg-primary/10 text-primary"
                                : "bg-emerald-500/15 text-emerald-300",
                            ].join(" ")}
                          >
                            {pending ? "生成中" : `${contentPreview.length}字`}
                          </span>
                        )}
                      </div>
                      {contentPreview ? (
                        <p className="mt-1 whitespace-pre-wrap wrap-break-word text-[13px] leading-6 text-foreground/85">
                          {contentPreview}
                        </p>
                      ) : (
                        chapter.outline && (
                          <p className="mt-0.5 whitespace-pre-wrap text-sm leading-5 text-foreground/85">
                            {chapter.outline}
                          </p>
                        )
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
