import { Card, CardContent } from "@/components/ui/card";

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
}

const cleanRaw = (value: string): string =>
  value
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/^```(?:json)?\s*/gi, "")
    .replace(/\s*```$/g, "")
    .trim();

const pickString = (source: Record<string, unknown> | null, keys: string[]): string => {
  for (const key of keys) {
    const value = source?.[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
};

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

const parseJSON = (raw: string): Record<string, unknown> | null => {
  const cleaned = cleanRaw(raw);
  try {
    const firstBrace = cleaned.indexOf("{");
    const lastBrace = cleaned.lastIndexOf("}");
    if (firstBrace === -1 || lastBrace === -1 || firstBrace >= lastBrace) {
      return null;
    }
    const jsonText = cleaned.slice(firstBrace, lastBrace + 1);
    return JSON.parse(jsonText) as Record<string, unknown>;
  } catch {
    return null;
  }
};

const getChapterPreviewFromJSON = (source: Record<string, unknown> | null): Chapter[] => {
  const rawList = source?.chapters ?? source?.章节;
  if (!Array.isArray(rawList)) {
    return [];
  }

  return rawList.map((item, index) => {
    const row = typeof item === "object" && item !== null ? (item as Record<string, unknown>) : {};
    const title =
      (typeof row.title === "string" && row.title.trim()) ||
      (typeof row.标题 === "string" && row.标题.trim()) ||
      (typeof row.chapter === "string" && row.chapter.trim()) ||
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
  });
};

const NODE_STYLES = [
  {
    wrap: "border-l-2 border-l-sky-500/70 bg-sky-50/55",
    title: "text-sky-900",
  },
  {
    wrap: "border-l-2 border-l-emerald-500/70 bg-emerald-50/55",
    title: "text-emerald-900",
  },
  {
    wrap: "border-l-2 border-l-amber-500/70 bg-amber-50/55",
    title: "text-amber-900",
  },
  {
    wrap: "border-l-2 border-l-violet-500/70 bg-violet-50/55",
    title: "text-violet-900",
  },
];

const isChapterDone = (content: string): boolean => {
  const text = content.trim();
  if (!text) return false;
  return !text.includes("生成中...") && !text.includes("扩写中...") && !text.includes("生成失败");
};

const getChapterContentPreview = (raw: string): { text: string; pending: boolean } => {
  const trimmed = (raw || "").trim();
  if (!trimmed) return { text: "", pending: false };

  const pendingMatch = trimmed.match(/^(生成中|扩写中)\.\.\.\s*(?:\d+字)?\s*/);
  const pending = Boolean(pendingMatch);
  const body = pending ? trimmed.slice(pendingMatch![0].length).trim() : trimmed;

  const noFence = body
    .replace(/^```(?:json)?\s*/gi, "")
    .replace(/\s*```\s*$/g, "");

  let content = noFence;
  const contentKey = noFence.match(/"content"\s*:\s*"/);
  if (contentKey && contentKey.index !== undefined) {
    const start = contentKey.index + contentKey[0].length;
    let escaped = false;
    let collected = "";
    for (let i = start; i < noFence.length; i++) {
      const ch = noFence[i];
      if (escaped) {
        escaped = false;
        collected += ch;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === "\"") break;
      collected += ch;
    }
    content = collected
      .replace(/\\n/g, "\n")
      .replace(/\\"/g, "\"")
      .replace(/\\\\/g, "\\");
  } else if (noFence.startsWith("{")) {
    try {
      const parsed = JSON.parse(noFence) as { content?: string };
      if (parsed.content) content = parsed.content;
    } catch {
      content = noFence;
    }
  }

  return { text: content.trim(), pending };
};

export function OutlineCard({
  outline,
  onSelect,
  isSelected = false,
}: OutlineCardProps) {
  const hasContent = Boolean(outline.rawContent);

  const streamingPreview = cleanRaw(outline.rawContent);
  const parsed = parseJSON(outline.rawContent);
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
    outline.chapters.length > 0 ? outline.chapters : getChapterPreviewFromJSON(parsed);
  const totalChapters = outline.chapters.length;
  const completedChapters = outline.chapters.filter((chapter) => isChapterDone(chapter.content)).length;

  return (
    <Card
      className={[
        "h-full border border-border/80 bg-white transition-all duration-200",
        isSelected ? "border-primary shadow-lg ring-2 ring-primary/20" : "hover:shadow-md",
        hasContent ? "cursor-pointer" : "",
      ].join(" ")}
      onClick={() => {
        if (hasContent) {
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
          <div className="flex-1 overflow-y-auto rounded-xl border border-border/70 bg-white p-3">
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
              <pre className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-foreground/90">
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
                            "break-words text-sm font-semibold",
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
                                : "bg-emerald-100 text-emerald-700",
                            ].join(" ")}
                          >
                            {pending ? "生成中" : `${contentPreview.length}字`}
                          </span>
                        )}
                      </div>
                      {contentPreview ? (
                        <p className="mt-1 whitespace-pre-wrap break-words text-[13px] leading-6 text-foreground/85">
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
