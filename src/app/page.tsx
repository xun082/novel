"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  BookOpen,
  Loader2,
  Sparkles,
  Wand2,
} from "lucide-react";
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

const STAGES: Array<{ key: Stage; label: string; desc: string }> = [
  { key: "config", label: "配置参数", desc: "设置题材和规模" },
  { key: "outlines", label: "选择大纲", desc: "并发生成并筛选" },
  { key: "chapters", label: "生成章节", desc: "批量生成正文" },
  { key: "expand", label: "扩写优化", desc: "统一扩写强化" },
];

const isStableContent = (value: string): boolean => {
  const text = value.trim();
  if (!text) return false;
  return !text.includes("生成中...") && !text.includes("扩写中...");
};

export default function Home() {
  const [genre, setGenre] = useState("玄幻");
  const [chapterCount, setChapterCount] = useState(15);
  const [outlineCount, setOutlineCount] = useState(3);

  const [stage, setStage] = useState<Stage>("config");
  const [isGenerating, setIsGenerating] = useState(false);
  const [currentStep, setCurrentStep] = useState("");

  const [outlines, setOutlines] = useState<Outline[]>([]);
  const [selectedOutline, setSelectedOutline] = useState<Outline | null>(null);
  const [activeOutlineId, setActiveOutlineId] = useState<number | null>(null);

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
      chapters: buildChapters(jsonData, chapterCount, false),
      rawContent,
    };
  };

  const generateOutlines = async () => {
    setIsGenerating(true);
    setStage("outlines");
    setActiveOutlineId(null);
    setSelectedOutline(null);
    setCurrentStep(`正在并发生成 ${outlineCount} 个小说大纲...`);

    const placeholders: Outline[] = Array.from({ length: outlineCount }, (_, index) => ({
      id: index + 1,
      title: `大纲 ${index + 1}`,
      summary: "",
      chapters: [],
      rawContent: "",
    }));
    setOutlines(placeholders);

    try {
      const rawOutlines = await rwkvService.generateMultipleOutlines(
        genre,
        chapterCount,
        outlineCount,
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
      setStage("config");
      setOutlines([]);
    } finally {
      setIsGenerating(false);
    }
  };

  const selectOutlineAndGenerateChapters = async (outline: Outline) => {
    const baseChapters =
      outline.chapters.length > 0
        ? outline.chapters
        : buildChapters(extractJSON(outline.rawContent), chapterCount, true);

    const initialOutline: Outline = {
      ...outline,
      chapters: baseChapters,
    };

    setActiveOutlineId(outline.id);
    setSelectedOutline(initialOutline);
    setIsGenerating(true);
    setStage("chapters");
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
          const pendingContent = streamText
            ? `生成中...\n${streamText}`
            : `生成中... ${content.length}字`;

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
    setStage("expand");
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
          const pendingContent = streamText
            ? `扩写中...\n${streamText}`
            : `扩写中... ${content.length}字`;

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
    setStage("config");
    setIsGenerating(false);
    setCurrentStep("");
    setOutlines([]);
    setSelectedOutline(null);
    setActiveOutlineId(null);
  };

  const currentStageIndex = STAGES.findIndex((item) => item.key === stage);
  const validOutlineCount = outlines.filter((item) => item.chapters.length > 0).length;
  const totalChapters = selectedOutline?.chapters.length || 0;
  const completedChapters =
    selectedOutline?.chapters.filter((chapter) => isStableContent(chapter.content)).length || 0;

  const progressValue = useMemo(() => {
    if (stage === "config") return 8;

    if (stage === "outlines") {
      const base = 20;
      if (outlines.length === 0) return base;
      return base + Math.round((validOutlineCount / outlines.length) * 22);
    }

    if (stage === "chapters") {
      const base = 48;
      if (totalChapters === 0) return base;
      return base + Math.round((completedChapters / totalChapters) * 28);
    }

    const base = 80;
    if (totalChapters === 0) return base;
    return base + Math.round((completedChapters / totalChapters) * 20);
  }, [stage, outlines.length, validOutlineCount, totalChapters, completedChapters]);

  const inWritingStage = stage === "chapters" || stage === "expand";
  const canExpand = inWritingStage && Boolean(selectedOutline);
  const primaryButtonLabel = isGenerating
    ? "处理中"
    : canExpand
      ? "一键扩写全部章节"
      : stage === "config"
        ? "开始生成大纲"
        : "重新生成大纲";

  const handlePrimaryAction = () => {
    if (canExpand) {
      void expandAllChapters();
      return;
    }
    void generateOutlines();
  };

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_10%_20%,rgba(14,165,233,0.08),transparent_40%),radial-gradient(circle_at_90%_10%,rgba(244,114,182,0.08),transparent_45%),linear-gradient(180deg,#f8fafc,white)]">
      <div className="mx-auto grid w-full gap-6 px-3 py-6 sm:px-4 md:px-5 xl:grid-cols-[340px_minmax(0,1fr)]">
        <aside className="space-y-4 xl:sticky xl:top-6 xl:self-start">
          <Card className="shadow-sm">
            <CardHeader className="pb-4">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary text-primary-foreground">
                  <BookOpen className="h-5 w-5" />
                </div>
                <div>
                  <CardTitle className="text-lg">并行小说生成系统</CardTitle>
                  <CardDescription>精简流程，专注创作</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="genre">小说类型</Label>
                <Input
                  id="genre"
                  value={genre}
                  onChange={(e) => setGenre(e.target.value)}
                  placeholder="例如：玄幻、悬疑、科幻"
                  disabled={isGenerating}
                />
              </div>

              <div className="space-y-5">
                <div className="space-y-2.5">
                  <div className="flex items-center justify-between">
                    <Label>章节数</Label>
                    <Badge variant="secondary">{chapterCount} 章</Badge>
                  </div>
                  <Slider
                    value={[chapterCount]}
                    min={5}
                    max={50}
                    step={1}
                    disabled={isGenerating}
                    onValueChange={(value) => {
                      if (value[0] !== undefined) {
                        setChapterCount(value[0]);
                      }
                    }}
                    aria-label="章节数"
                  />
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>5</span>
                    <span>50</span>
                  </div>
                </div>

                <div className="space-y-2.5">
                  <div className="flex items-center justify-between">
                    <Label>大纲数</Label>
                    <Badge variant="secondary">{outlineCount} 份</Badge>
                  </div>
                  <Slider
                    value={[outlineCount]}
                    min={1}
                    max={30}
                    step={1}
                    disabled={isGenerating}
                    onValueChange={(value) => {
                      if (value[0] !== undefined) {
                        setOutlineCount(value[0]);
                      }
                    }}
                    aria-label="大纲数"
                  />
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>1</span>
                    <span>30</span>
                  </div>
                </div>
              </div>

              <Separator />

              <Button
                onClick={handlePrimaryAction}
                disabled={isGenerating || (!canExpand && !genre.trim())}
                className="w-full"
              >
                {isGenerating ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    处理中
                  </>
                ) : canExpand ? (
                  <>
                    <Wand2 className="mr-2 h-4 w-4" />
                    {primaryButtonLabel}
                  </>
                ) : (
                  <>
                    <Sparkles className="mr-2 h-4 w-4" />
                    {primaryButtonLabel}
                  </>
                )}
              </Button>

              {(stage !== "config" || outlines.length > 0 || Boolean(selectedOutline)) && (
                <Button variant="ghost" disabled={isGenerating} onClick={resetFlow} className="w-full">
                  开始新任务
                </Button>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="space-y-2 pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">创作流程</CardTitle>
                <Badge variant="secondary" className="px-2 py-0.5 text-xs">
                  {progressValue}%
                </Badge>
              </div>
              <Progress value={progressValue} className="h-1.5" />
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-1.5">
                {STAGES.map((item, index) => {
                  const isActive = stage === item.key;
                  const isDone = currentStageIndex > index;
                  return (
                    <div
                      key={item.key}
                      className={[
                        "flex items-center justify-between rounded-md border px-2 py-1 text-xs",
                        isActive && "border-primary bg-primary/5",
                        isDone && "border-emerald-500/40 bg-emerald-50/60",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                    >
                      <span className="text-muted-foreground">步骤 {index + 1}</span>
                      <span className="font-medium">{item.label}</span>
                    </div>
                  );
                })}
              </div>

              <Separator />

              <div className="space-y-2 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">当前阶段</span>
                  <Badge>{STAGES[currentStageIndex]?.label || "配置参数"}</Badge>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">成功大纲</span>
                  <span className="font-medium">
                    {validOutlineCount}/{Math.max(outlines.length, outlineCount)}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">完成章节</span>
                  <span className="font-medium">
                    {completedChapters}/{totalChapters || chapterCount}
                  </span>
                </div>
              </div>

              {currentStep && (
                <p className="text-xs leading-relaxed text-muted-foreground">{currentStep}</p>
              )}
            </CardContent>
          </Card>
        </aside>

        <main className="space-y-5">
          {stage === "config" && (
            <div className="grid gap-4">
              <Card>
                <CardHeader>
                  <CardTitle>开始创作</CardTitle>
                  <CardDescription>只需三步即可完成从大纲到章节的整套内容</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3 text-sm text-muted-foreground">
                  <p>1. 先并发生成多份大纲，直接在列表里挑选最满意的一份。</p>
                  <p>2. 选择后自动批量生成全部章节正文。</p>
                  <p>3. 章节生成完成后可一键扩写全部章节。</p>
                </CardContent>
              </Card>
            </div>
          )}

          {stage === "outlines" && (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-4">
              {outlines.map((outline) => (
                <OutlineCard
                  key={outline.id}
                  outline={outline}
                  isGenerating={isGenerating}
                  onSelect={selectOutlineAndGenerateChapters}
                  isSelected={activeOutlineId === outline.id}
                />
              ))}
            </div>
          )}

          {(stage === "chapters" || stage === "expand") && selectedOutline && (
            <>
              <Card>
                <CardHeader className="space-y-4">
                  <div className="space-y-2">
                    <CardTitle className="text-2xl">{selectedOutline.title}</CardTitle>
                    <CardDescription className="max-w-3xl leading-relaxed">
                      {selectedOutline.summary || "该大纲暂无摘要，已按结构继续生成章节。"}
                    </CardDescription>
                    <Badge variant="secondary" className="w-fit">
                      已选择此大纲并开始正文生成
                    </Badge>
                  </div>
                </CardHeader>
              </Card>

              <Tabs defaultValue="chapters" className="space-y-3">
                <TabsList>
                  <TabsTrigger value="chapters">章节内容</TabsTrigger>
                  <TabsTrigger value="outline">大纲总览</TabsTrigger>
                </TabsList>

                <TabsContent value="chapters">
                  <Card>
                    <CardHeader>
                      <CardTitle>章节列表</CardTitle>
                      <CardDescription>
                        共 {selectedOutline.chapters.length} 章，已完成 {completedChapters} 章
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      <ScrollArea className="h-[68vh] pr-4">
                        <div className="space-y-4">
                          {selectedOutline.chapters.map((chapter) => (
                            <ChapterCard key={chapter.id} chapter={chapter} isGenerating={isGenerating} />
                          ))}
                        </div>
                      </ScrollArea>
                    </CardContent>
                  </Card>
                </TabsContent>

                <TabsContent value="outline">
                  <Card>
                    <CardHeader>
                      <CardTitle>章节梗概总览</CardTitle>
                      <CardDescription>可在此快速核对剧情结构</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      {selectedOutline.chapters.map((chapter) => (
                        <div key={chapter.id} className="rounded-xl border bg-muted/20 p-3">
                          <p className="font-medium">{chapter.title}</p>
                          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                            {chapter.outline}
                          </p>
                        </div>
                      ))}
                    </CardContent>
                  </Card>
                </TabsContent>
              </Tabs>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
