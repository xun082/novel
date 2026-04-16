"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, Sparkles, Wand2 } from "lucide-react";
import rwkvService from "@/services";
import { OutlineCard } from "@/components/OutlineCard";
import { ChapterCard } from "@/components/ChapterCard";

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

type Stage = "config" | "outlines" | "chapters" | "expand";
type WritingView = "chapters" | "outline";

const OUTLINE_TOTAL = 35;
const DEFAULT_CHAPTER_COUNT = 15;

const STAGES: Array<{ key: Stage; label: string; desc: string }> = [
  { key: "config", label: "配置参数", desc: "输入题材与需求" },
  { key: "outlines", label: "选择大纲", desc: "并发生成并筛选 35 份" },
  { key: "chapters", label: "生成章节", desc: "基于选中大纲批量生成" },
  { key: "expand", label: "扩写优化", desc: "统一扩写全部章节" },
];

const isStableContent = (value: string): boolean => {
  const text = value.trim();
  if (!text) return false;
  return !text.includes("生成中...") && !text.includes("扩写中...");
};

const normalizeStage = (value: string | null): Stage => {
  if (value === "config" || value === "outlines" || value === "chapters" || value === "expand") {
    return value;
  }
  return "outlines";
};

const normalizeWritingView = (value: string | null): WritingView => {
  return value === "outline" ? "outline" : "chapters";
};

const createOutlinePlaceholders = (count: number): Outline[] =>
  Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    title: `大纲 ${index + 1}`,
    summary: "",
    chapters: [],
    rawContent: "",
  }));

export default function Home() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [novelInput, setNovelInput] = useState("玄幻，升级流，主角成长线清晰，含宗门与秘境线。");
  const [isGenerating, setIsGenerating] = useState(false);
  const [currentStep, setCurrentStep] = useState("");

  const [outlines, setOutlines] = useState<Outline[]>(() => createOutlinePlaceholders(OUTLINE_TOTAL));
  const [selectedOutline, setSelectedOutline] = useState<Outline | null>(null);
  const [activeOutlineId, setActiveOutlineId] = useState<number | null>(null);

  const stage = normalizeStage(searchParams.get("step"));
  const writingView = normalizeWritingView(searchParams.get("view"));

  useEffect(() => {
    if (searchParams.get("step")) return;
    const params = new URLSearchParams(searchParams.toString());
    params.set("step", "outlines");
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }, [pathname, router, searchParams]);

  const buildStepHref = (nextStage: Stage, nextView?: WritingView): string => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("step", nextStage);

    if (nextView) {
      params.set("view", nextView);
    } else {
      params.delete("view");
    }

    return `${pathname}?${params.toString()}`;
  };

  const navigateStep = (nextStage: Stage, nextView?: WritingView) => {
    router.replace(buildStepHref(nextStage, nextView), { scroll: false });
  };

  const extractJSON = (text: string): Record<string, unknown> | null => {
    if (!text || text.trim().length === 0) return null;

    try {
      let cleaned = text.trim();
      cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/g, "");
      cleaned = cleaned.replace(/^```(?:json)?\s*/gi, "");
      cleaned = cleaned.replace(/\s*```\s*$/g, "");

      const firstBrace = cleaned.indexOf("{");
      const lastBrace = cleaned.lastIndexOf("}");
      if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) return null;

      cleaned = cleaned.substring(firstBrace, lastBrace + 1);
      return JSON.parse(cleaned) as Record<string, unknown>;
    } catch {
      try {
        const fixed = text
          .trim()
          .replace(/<think>[\s\S]*?<\/think>/g, "")
          .replace(/^```(?:json)?\s*/gi, "")
          .replace(/\s*```\s*$/g, "");
        const matches = fixed.match(/\{[\s\S]*\}/);
        if (!matches) return null;
        return JSON.parse(matches[0]) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
  };

  const extractStreamingChapterText = (raw: string): string => {
    const parsed = extractJSON(raw);
    if (typeof parsed?.content === "string" && parsed.content.trim()) {
      return parsed.content.trim();
    }

    const cleaned = raw
      .replace(/<think>[\s\S]*?<\/think>/g, "")
      .replace(/^```(?:json)?\s*/gi, "")
      .replace(/\s*```$/g, "")
      .trim();

    const key = cleaned.match(/"content"\s*:\s*"/);
    if (!key || key.index === undefined) {
      return "";
    }

    const start = key.index + key[0].length;
    const tail = cleaned.slice(start);

    let end = tail.length;
    let escaped = false;
    for (let i = 0; i < tail.length; i++) {
      const char = tail[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "\"") {
        end = i;
        break;
      }
    }

    return tail
      .slice(0, end)
      .replace(/\\n/g, "\n")
      .replace(/\\"/g, "\"")
      .replace(/\\\\/g, "\\")
      .trim();
  };

  const buildChapters = (
    jsonData: Record<string, unknown> | null,
    count: number,
    withFallback: boolean,
  ): Chapter[] => {
    const raw = (jsonData?.chapters || jsonData?.章节 || []) as unknown;
    const list = Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [];

    const parsed = list.slice(0, count).map((chapterData, index) => ({
      id: index + 1,
      title:
        (chapterData.title as string) ||
        (chapterData.标题 as string) ||
        (chapterData.chapter as string) ||
        `第${index + 1}章`,
      outline:
        (chapterData.outline as string) ||
        (chapterData.梗概 as string) ||
        (chapterData.内容梗概 as string) ||
        "待生成",
      content: "",
    }));

    if (parsed.length > 0 || !withFallback) return parsed;

    return Array.from({ length: count }, (_, i) => ({
      id: i + 1,
      title: `第${i + 1}章`,
      outline: "待生成",
      content: "",
    }));
  };

  const parseOutline = (rawContent: string, index: number): Outline => {
    const jsonData = extractJSON(rawContent);
    const title =
      (jsonData?.title as string) ||
      (jsonData?.标题 as string) ||
      (jsonData?.小说标题 as string) ||
      `大纲 ${index + 1}`;
    const summary =
      (jsonData?.summary as string) ||
      (jsonData?.核心梗概 as string) ||
      (jsonData?.梗概 as string) ||
      "";

    return {
      id: index + 1,
      title,
      summary,
      chapters: buildChapters(jsonData, DEFAULT_CHAPTER_COUNT, false),
      rawContent,
    };
  };

  const generateOutlines = async () => {
    setIsGenerating(true);
    navigateStep("outlines");
    setActiveOutlineId(null);
    setSelectedOutline(null);
    setCurrentStep(`正在并发生成 ${OUTLINE_TOTAL} 个小说大纲...`);

    const placeholders = createOutlinePlaceholders(OUTLINE_TOTAL);
    setOutlines(placeholders);

    try {
      const rawOutlines = await rwkvService.generateMultipleOutlines(
        novelInput,
        DEFAULT_CHAPTER_COUNT,
        OUTLINE_TOTAL,
        (index, content) => {
          setOutlines((prev) => {
            const updated = [...prev];
            if (updated[index]) {
              updated[index] = {
                ...updated[index],
                rawContent: content,
                title: `大纲 ${index + 1}`,
                summary: "正在生成中...",
                chapters: [],
              };
            }
            return updated;
          });
        },
      );

      const parsedOutlines = rawOutlines.map((raw, index) => parseOutline(raw, index));
      setOutlines(parsedOutlines);

      const successCount = parsedOutlines.filter((item) => item.chapters.length > 0).length;
      setCurrentStep(`大纲生成完成：${successCount}/${parsedOutlines.length}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "未知错误";
      setCurrentStep(`生成失败：${message}`);
      setOutlines(createOutlinePlaceholders(OUTLINE_TOTAL));
    } finally {
      setIsGenerating(false);
    }
  };

  const selectOutlineAndGenerateChapters = async (outline: Outline) => {
    const baseChapters =
      outline.chapters.length > 0
        ? outline.chapters
        : buildChapters(extractJSON(outline.rawContent), DEFAULT_CHAPTER_COUNT, true);

    const initialOutline: Outline = {
      ...outline,
      chapters: baseChapters,
    };

    setActiveOutlineId(outline.id);
    setSelectedOutline(initialOutline);
    setIsGenerating(true);
    navigateStep("chapters", "chapters");
    setCurrentStep(`正在并发生成 ${baseChapters.length} 个章节...`);

    try {
      const rawContents = await rwkvService.generateChapters(
        {
          title: outline.title,
          summary: outline.summary,
        },
        baseChapters.map((chapter) => ({ title: chapter.title, outline: chapter.outline })),
        (index, content) => {
          const streamText = extractStreamingChapterText(content);
          const pendingContent = streamText ? `生成中...\n${streamText}` : `生成中... ${content.length}字`;

          setSelectedOutline((prev) => {
            if (!prev) return prev;
            return {
              ...prev,
              chapters: prev.chapters.map((chapter, i) =>
                i === index ? { ...chapter, content: pendingContent } : chapter,
              ),
            };
          });
        },
      );

      const parsedChapters = baseChapters.map((chapter, index) => {
        const raw = rawContents[index] || "";
        const jsonData = extractJSON(raw);
        const content = (jsonData?.content as string) || raw;
        return {
          ...chapter,
          content,
        };
      });

      const updated: Outline = {
        ...initialOutline,
        chapters: parsedChapters,
      };

      setSelectedOutline(updated);
      setCurrentStep("章节生成完成，可以直接扩写全部章节。");
    } catch {
      setCurrentStep("章节生成失败，请重试。");
    } finally {
      setIsGenerating(false);
    }
  };

  const expandAllChapters = async () => {
    if (!selectedOutline) return;

    setIsGenerating(true);
    navigateStep("expand", writingView);
    setCurrentStep(`正在并发扩写 ${selectedOutline.chapters.length} 个章节...`);

    try {
      const rawContents = await rwkvService.expandChapters(
        selectedOutline.chapters.map((chapter) => ({
          title: chapter.title,
          outline: chapter.outline,
          currentContent: chapter.content,
        })),
        (index, content) => {
          const streamText = extractStreamingChapterText(content);
          const pendingContent = streamText ? `扩写中...\n${streamText}` : `扩写中... ${content.length}字`;

          setSelectedOutline((prev) => {
            if (!prev) return prev;
            return {
              ...prev,
              chapters: prev.chapters.map((chapter, i) =>
                i === index ? { ...chapter, content: pendingContent } : chapter,
              ),
            };
          });
        },
      );

      const parsedChapters = selectedOutline.chapters.map((chapter, index) => {
        const raw = rawContents[index] || "";
        const jsonData = extractJSON(raw);
        const content = (jsonData?.content as string) || raw || chapter.content;
        return {
          ...chapter,
          content,
        };
      });

      setSelectedOutline({
        ...selectedOutline,
        chapters: parsedChapters,
      });

      setCurrentStep("章节扩写完成。");
    } catch {
      setCurrentStep("扩写失败，请重试。");
    } finally {
      setIsGenerating(false);
    }
  };

  const resetFlow = () => {
    setIsGenerating(false);
    setCurrentStep("");
    setOutlines(createOutlinePlaceholders(OUTLINE_TOTAL));
    setSelectedOutline(null);
    setActiveOutlineId(null);
    navigateStep("outlines");
  };

  const totalChapters = selectedOutline?.chapters.length || 0;
  const completedChapters = useMemo(
    () => selectedOutline?.chapters.filter((chapter) => isStableContent(chapter.content)).length || 0,
    [selectedOutline],
  );

  const inWritingStage = stage === "chapters" || stage === "expand";
  const canExpand = inWritingStage && Boolean(selectedOutline);
  const primaryButtonLabel = isGenerating
    ? "处理中"
    : canExpand
      ? "扩写"
      : "生成";

  const handlePrimaryAction = () => {
    if (canExpand) {
      void expandAllChapters();
      return;
    }
    void generateOutlines();
  };

  const handleStageSelect = (value: string) => {
    const nextStage = normalizeStage(value);
    if (nextStage === "chapters" || nextStage === "expand") {
      navigateStep(nextStage, writingView);
      return;
    }
    navigateStep(nextStage);
  };

  return (
    <div className="min-h-screen w-screen overflow-x-hidden bg-[radial-gradient(circle_at_10%_20%,rgba(14,165,233,0.08),transparent_40%),radial-gradient(circle_at_90%_10%,rgba(244,114,182,0.08),transparent_45%),linear-gradient(180deg,#f8fafc,white)]">
      <main className="w-full pb-36">
        {(stage === "config" || stage === "outlines") && (
          <section className="grid items-stretch gap-3 p-0 grid-cols-[repeat(auto-fill,minmax(min(100%,420px),1fr))]">
            {outlines.map((outline) => (
              <OutlineCard
                key={outline.id}
                outline={outline}
                isGenerating={isGenerating}
                onSelect={selectOutlineAndGenerateChapters}
                isSelected={activeOutlineId === outline.id}
              />
            ))}
          </section>
        )}

        {(stage === "chapters" || stage === "expand") && selectedOutline && (
          <section className="space-y-3 p-0">
            <Card className="rounded-none border-x-0 border-t-0 border-white/60 bg-white/90 shadow-none backdrop-blur-sm">
              <CardHeader className="space-y-3">
                <CardTitle className="text-2xl">{selectedOutline.title}</CardTitle>
                <CardDescription className="max-w-4xl leading-relaxed">
                  {selectedOutline.summary || "该大纲暂无摘要，已按结构继续生成章节。"}
                </CardDescription>
                <Badge variant="secondary" className="w-fit">
                  已选择此大纲并开始正文生成
                </Badge>
              </CardHeader>
            </Card>

            {writingView === "chapters" ? (
              <Card className="rounded-none border-x-0 border-white/60 bg-white/90 shadow-none backdrop-blur-sm">
                <CardHeader>
                  <CardTitle>章节列表</CardTitle>
                  <CardDescription>
                    共 {selectedOutline.chapters.length} 章，已完成 {completedChapters} 章
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <ScrollArea className="h-[74vh] pr-4">
                    <div className="space-y-4">
                      {selectedOutline.chapters.map((chapter) => (
                        <ChapterCard key={chapter.id} chapter={chapter} isGenerating={isGenerating} />
                      ))}
                    </div>
                  </ScrollArea>
                </CardContent>
              </Card>
            ) : (
              <Card className="rounded-none border-x-0 border-white/60 bg-white/90 shadow-none backdrop-blur-sm">
                <CardHeader>
                  <CardTitle>章节梗概总览</CardTitle>
                  <CardDescription>通过路由切换，不再使用 Tab</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  {selectedOutline.chapters.map((chapter) => (
                    <div
                      key={chapter.id}
                      className="rounded-xl border border-border/80 bg-muted/25 p-3 transition-colors hover:bg-muted/35"
                    >
                      <p className="font-medium">{chapter.title}</p>
                      <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{chapter.outline}</p>
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}
          </section>
        )}

        {(stage === "chapters" || stage === "expand") && !selectedOutline && (
          <section className="grid min-h-[52vh] place-items-center px-0 text-center">
            <p className="text-sm text-muted-foreground">暂无已选大纲，请先回到“选择大纲”步骤。</p>
          </section>
        )}
      </main>

      <div className="pointer-events-none fixed bottom-3 left-1/2 z-30 w-[min(920px,calc(100vw-24px))] -translate-x-1/2">
        <div className="pointer-events-auto rounded-2xl border border-border/70 bg-white/90 p-2 shadow-[0_16px_45px_-20px_rgba(15,23,42,0.55)] backdrop-blur-xl">
          <div className="rounded-2xl border border-border/70 bg-background/95 px-2.5 py-1.5">
            <Textarea
              value={novelInput}
              onChange={(e) => setNovelInput(e.target.value)}
              placeholder="给我一个小说创作方向：题材、世界观、主角设定、剧情要求。"
              rows={2}
              className="min-h-[56px] max-h-[120px] resize-none overflow-y-auto border-0 bg-transparent px-1 py-1 text-sm leading-6 shadow-none focus-visible:ring-0"
            />
            <div className="mt-1.5 flex flex-wrap items-center justify-between gap-1.5 border-t border-border/60 pt-1.5">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-xs text-muted-foreground">
                  完成章节 {completedChapters}/{totalChapters || DEFAULT_CHAPTER_COUNT}
                </span>
                {currentStep && (
                  <span className="max-w-[280px] truncate text-xs text-muted-foreground">{currentStep}</span>
                )}

                {(stage === "chapters" || stage === "expand") && selectedOutline && (
                  <>
                    <Button
                      asChild
                      size="sm"
                      className="h-7 rounded-md px-2.5"
                      variant={writingView === "chapters" ? "default" : "outline"}
                    >
                      <Link href={buildStepHref(stage, "chapters")}>章节内容</Link>
                    </Button>
                    <Button
                      asChild
                      size="sm"
                      className="h-7 rounded-md px-2.5"
                      variant={writingView === "outline" ? "default" : "outline"}
                    >
                      <Link href={buildStepHref(stage, "outline")}>大纲总览</Link>
                    </Button>
                  </>
                )}

                <Select value={stage} onValueChange={handleStageSelect}>
                  <SelectTrigger className="h-8 min-w-[132px] rounded-md px-3 text-xs font-medium">
                    <SelectValue placeholder="阶段" />
                  </SelectTrigger>
                  <SelectContent align="start">
                    {STAGES.map((item) => (
                      <SelectItem key={item.key} value={item.key}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex items-center gap-1.5">
                <Button variant="ghost" disabled={isGenerating} onClick={resetFlow} className="h-8 rounded-md px-3 text-xs">
                  重置
                </Button>
                <Button
                  onClick={handlePrimaryAction}
                  disabled={isGenerating || (!canExpand && !novelInput.trim())}
                  className="h-8 rounded-full px-4 text-xs"
                >
                  {isGenerating ? (
                    <>
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                      处理中
                    </>
                  ) : canExpand ? (
                    <>
                      <Wand2 className="mr-1.5 h-3.5 w-3.5" />
                      {primaryButtonLabel}
                    </>
                  ) : (
                    <>
                      <Sparkles className="mr-1.5 h-3.5 w-3.5" />
                      {primaryButtonLabel}
                    </>
                  )}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
