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
  isGenerating: boolean;
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

  return rawList.slice(0, 4).map((item, index) => {
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

export function OutlineCard({
  outline,
  isGenerating,
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

  return (
    <Card
      className={[
        "h-[540px] border border-border/80 bg-white transition-all duration-200",
        isSelected ? "border-primary shadow-lg ring-2 ring-primary/20" : "hover:shadow-md",
        !isGenerating && hasContent ? "cursor-pointer" : "",
      ].join(" ")}
      onClick={() => {
        if (!isGenerating && hasContent) {
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
            <p className="text-xs text-muted-foreground">大纲 {outline.id}</p>
            <p className="mt-1 text-base font-semibold leading-6 text-foreground">{displayTitle}</p>
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
                  return (
                    <div
                      key={chapter.id}
                      className={[
                        "rounded-md px-2 py-1.5 transition-colors",
                        nodeStyle.wrap,
                      ].join(" ")}
                    >
                      <p className={["line-clamp-1 text-sm font-semibold", nodeStyle.title].join(" ")}>{chapter.title}</p>
                    {chapter.outline && (
                      <p className="mt-0.5 whitespace-pre-wrap text-sm leading-5 text-foreground/85">
                        {chapter.outline}
                      </p>
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
