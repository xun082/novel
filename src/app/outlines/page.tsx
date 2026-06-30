"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, RefreshCw, Sparkles, Wand2 } from "lucide-react";
import rwkvService from "@/services";
import { OutlineCard } from "@/components/OutlineCard";
import {
  clearLaunchSessionStorage,
  clearPersistedOutlines,
  peekLaunchSession,
  persistOutlines,
  readPersistedOutlines,
  type NovelChapter,
  type NovelOutline,
} from "@/lib/novel/novel-data";
import {
  buildParagraphExpandTask,
  buildParagraphGenerationTask,
  emptyWorldbuilding,
  getGenerationStage,
  isParagraphDraftComplete,
  isParagraphExpandComplete,
  joinChapterParagraphs,
  MAX_PARAGRAPH_EXPAND_ROUNDS,
  parseParagraphRows,
  parseWorldbuilding,
  type GenerationStage,
} from "@/lib/novel/novel-generation";
import { cn } from "@/lib/utils";
import {
  extractChapterRecords,
  extractParseableJsonObject,
  stripLlmJsonNoise,
} from "@/lib/parsing/extract-parseable-json";
import { RwkvProductionUpstreamSettings } from "@/components/RwkvProductionUpstreamSettings";
import { usePromptStore } from "@/components/PromptStoreProvider";
import {
  consumeLaunch,
  getCurrentGenerationToken,
  isGenerationActive,
  markGenerationFinished,
} from "@/lib/storage/launch-store";

type Outline = NovelOutline;
type Chapter = NovelChapter;

const STAGE_LABELS: Record<GenerationStage, string> = {
  worldbuilding: "生成世界观",
  paragraphs: "写段落草稿",
  expand: "扩写段落",
  complete: "重新生成",
};

const OUTLINE_TOTAL = 10;
// 上游 /big_batch/completions 对「单请求 N (contents.length)」有硬上限（实测 N≥135 必空 body，
// N=120 稳定可用）。10 × 8 = 80 有充裕余量，同时也给每条 prompt 更多 max_tokens 空间，
// 章节正文不容易因 token 用尽而被截断。
const DEFAULT_CHAPTER_COUNT = 8;

const createOutlinePlaceholders = (count: number): Outline[] =>
  Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    title: `大纲 ${index + 1}`,
    summary: "",
    worldbuilding: emptyWorldbuilding(),
    chapters: [],
    rawContent: "",
  }));

const stripLaunchQueryFromUrl = (): void => {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  let changed = false;
  for (const key of ["seed", "go"]) {
    if (url.searchParams.has(key)) {
      url.searchParams.delete(key);
      changed = true;
    }
  }
  if (!changed) return;
  const q = url.searchParams.toString();
  window.history.replaceState(null, "", `${url.pathname}${q ? `?${q}` : ""}${url.hash}`);
};

export default function Home() {
  const router = useRouter();
  const { novelInput, setNovelInput } = usePromptStore();
  const [isGenerating, setIsGenerating] = useState(false);
  const [storageReady, setStorageReady] = useState(false);
  const outlineGenerationLockRef = useRef(false);
  const chapterGenerationLockRef = useRef(false);

  const [outlines, setOutlines] = useState<Outline[]>(() =>
    createOutlinePlaceholders(OUTLINE_TOTAL),
  );

  useEffect(() => {
    // Backward compatibility: strip legacy query params from older shared links.
    const url = new URL(window.location.href);
    const hadLegacyQuery = url.searchParams.has("step") || url.searchParams.has("view");
    if (!hadLegacyQuery) return;

    url.searchParams.delete("step");
    url.searchParams.delete("view");

    const nextQuery = url.searchParams.toString();
    const nextURL = `${url.pathname}${nextQuery ? `?${nextQuery}` : ""}${url.hash}`;
    window.history.replaceState({}, "", nextURL);
  }, []);

  useEffect(() => {
    if (!storageReady) return;
    // 流式阶段高频更新 outlines 时，同步 stringify+localStorage 会卡主线程导致「像是一次性画完」
    if (isGenerating) {
      const t = window.setTimeout(() => {
        persistOutlines(outlines);
      }, 450);
      return () => window.clearTimeout(t);
    }
    persistOutlines(outlines);
  }, [outlines, storageReady, isGenerating]);

  const extractJSON = extractParseableJsonObject;

  const extractStreamingChapterText = (raw: string): string => {
    const parsed = extractJSON(raw);
    if (typeof parsed?.content === "string" && parsed.content.trim()) {
      return parsed.content.trim();
    }

    const cleaned = stripLlmJsonNoise(raw);

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
    const raw = jsonData?.chapters;
    const list = Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [];

    const parsed = list.slice(0, count).map((chapterData, index) => {
      const outline =
        typeof chapterData.outline === "string" ? chapterData.outline : "";
      const title =
        (typeof chapterData.title === "string" && chapterData.title) ||
        (typeof chapterData.chapter === "string" && chapterData.chapter) ||
        `第${index + 1}章`;
      return {
        id: index + 1,
        title,
        outline,
        paragraphs: parseParagraphRows(chapterData),
        content: "",
      };
    });

    if (parsed.length > 0 || !withFallback) return parsed;

    // Streaming placeholder rows so the UI shows skeletons until the model fills them.
    return Array.from({ length: count }, (_, i) => ({
      id: i + 1,
      title: `第${i + 1}章`,
      outline: "",
      paragraphs: [],
      content: "",
    }));
  };

  /**
   * Recover chapter rows even when the model output is structurally broken JSON.
   * Tried in order:
   *   1) strict-parsed root has `chapters` → use it;
   *   2) walk the raw for `"chapters":[` + balanced `{…}` (ignores premature `]`).
   * Returns empty array if neither finds anything — caller decides about placeholders.
   * Without #2 we'd overwrite the streaming preview with `第N章 / 待生成`.
   */
  const recoverChapters = (
    jsonData: Record<string, unknown> | null,
    rawContent: string,
    count: number,
  ): Chapter[] => {
    const fromJson = buildChapters(jsonData, count, false);
    if (fromJson.length > 0) return fromJson;
    const records = extractChapterRecords(rawContent);
    if (records.length === 0) return [];
    return buildChapters({ chapters: records }, count, false);
  };

  const parseOutline = (rawContent: string, index: number): Outline => {
    const jsonData = extractJSON(rawContent);
    const title =
      (typeof jsonData?.title === "string" && jsonData.title) ||
      `大纲 ${index + 1}`;
    const summary =
      typeof jsonData?.summary === "string" ? jsonData.summary : "";

    return {
      id: index + 1,
      title,
      summary,
      worldbuilding: parseWorldbuilding(jsonData),
      chapters: recoverChapters(jsonData, rawContent, DEFAULT_CHAPTER_COUNT),
      rawContent,
    };
  };

  const generateOutlinesAndChapters = async (overridePrompt?: string) => {
    if (outlineGenerationLockRef.current || chapterGenerationLockRef.current) return;

    const promptText = (overridePrompt ?? novelInput).trim();
    if (!promptText) return;
    stripLaunchQueryFromUrl();
    outlineGenerationLockRef.current = true;
    const launchToken = getCurrentGenerationToken();
    setIsGenerating(true);

    const placeholders = createOutlinePlaceholders(OUTLINE_TOTAL);
    setOutlines(placeholders);

    const pendingRaw = new Map<number, string>();
    let streamRaf: number | null = null;

    const flushPendingRawToState = () => {
      if (pendingRaw.size === 0) return;
      const batch = new Map(pendingRaw);
      pendingRaw.clear();
      setOutlines((prev) => {
        const next = prev.slice();
        let changed = false;
        for (const [idx, raw] of batch) {
          if (!prev[idx]) continue;
          next[idx] = { ...next[idx], rawContent: raw };
          changed = true;
        }
        return changed ? next : prev;
      });
    };

    const scheduleRawUpdate = (index: number, content: string) => {
      pendingRaw.set(index, content);
      if (streamRaf != null) return;
      streamRaf = requestAnimationFrame(() => {
        streamRaf = null;
        if (!outlineGenerationLockRef.current) return;
        flushPendingRawToState();
      });
    };

    try {
      const rawOutlines = await rwkvService.generateMultipleOutlines(
        promptText,
        DEFAULT_CHAPTER_COUNT,
        OUTLINE_TOTAL,
        (index, content) => {
          if (!outlineGenerationLockRef.current) return;
          scheduleRawUpdate(index, content);
        },
        (index, content) => {
          if (!outlineGenerationLockRef.current) return;
          if (streamRaf != null) {
            cancelAnimationFrame(streamRaf);
            streamRaf = null;
          }
          flushPendingRawToState();
          setOutlines((prev) => {
            if (!prev[index]) return prev;
            const parsed = parseOutline(content, index);
            const next = prev.slice();
            next[index] = {
              ...parsed,
              chapters:
                parsed.chapters.length > 0
                  ? parsed.chapters
                  : buildChapters(
                      extractJSON(parsed.rawContent),
                      DEFAULT_CHAPTER_COUNT,
                      true,
                    ),
            };
            return next;
          });
        },
      );

      if (streamRaf != null) {
        cancelAnimationFrame(streamRaf);
        streamRaf = null;
      }
      flushPendingRawToState();

      const finalizedOutlines = rawOutlines.map((raw, index) => {
        const parsed = parseOutline(raw, index);
        return {
          ...parsed,
          chapters:
            parsed.chapters.length > 0
              ? parsed.chapters
              : buildChapters(extractJSON(parsed.rawContent), DEFAULT_CHAPTER_COUNT, true),
        };
      });
      setOutlines(finalizedOutlines);
    } catch (error) {
      const message = error instanceof Error ? error.message : "未知错误";
      window.alert(`大纲生成失败：${message}`);
      setOutlines(createOutlinePlaceholders(OUTLINE_TOTAL));
    } finally {
      outlineGenerationLockRef.current = false;
      markGenerationFinished(launchToken);
      setIsGenerating(false);
    }
  };

  useEffect(() => {
    if (typeof window === "undefined") return;

    // 优先吃内存信号（首页 publishLaunch 投递的 prompt）；再退到 ?seed=... 历史链接；
    // 再退到 launch session。三者都没有时再看缓存，最后才考虑回首页。
    const launchPrompt = consumeLaunch();

    // 兼容老的 /outlines?seed=... 分享链接。
    const params = new URLSearchParams(window.location.search);
    const seed = params.get("seed");
    let seededPrompt = "";
    if (seed) {
      try {
        seededPrompt = decodeURIComponent(seed).trim();
      } catch {
        seededPrompt = "";
      }
    }
    stripLaunchQueryFromUrl();

    if (launchPrompt || seededPrompt) {
      const prompt = (launchPrompt || seededPrompt).trim();
      if (!prompt) {
        router.replace("/");
        return;
      }
      setNovelInput(prompt);
      setOutlines(createOutlinePlaceholders(OUTLINE_TOTAL));
      clearPersistedOutlines();
      clearLaunchSessionStorage();
      setStorageReady(true);
      void generateOutlinesAndChapters(prompt);
      return;
    }

    // 没消费到信号，但 generation 还在跑——说明这是 Strict Mode 的二次 mount，第一次
    // 已经把 launch 吃掉并开始生成了；这里什么都不做，直接复用上一次 mount 启动的流程。
    if (isGenerationActive()) {
      setStorageReady(true);
      return;
    }

    const session = peekLaunchSession();
    if (session?.prompt.trim()) {
      setNovelInput(session.prompt);
      setOutlines(createOutlinePlaceholders(OUTLINE_TOTAL));
      clearPersistedOutlines();
      clearLaunchSessionStorage();
      setStorageReady(true);
      if (session.autoGenerate) {
        void generateOutlinesAndChapters(session.prompt);
      }
      return;
    }

    const cached = readPersistedOutlines() as Outline[];
    if (cached.length > 0) {
      setOutlines(cached);
      setStorageReady(true);
      return;
    }

    // 没有发起信号 / session / 缓存——把用户送回首页继续挑题材或改文案。
    router.replace("/");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openOutlineDetails = (outline: Outline) => {
    if (!outline.rawContent.trim()) {
      window.alert(`《${outline.title}》仍在生成中，请稍后重试。`);
      return;
    }

    persistOutlines(outlines);
    const nextPath = `/outline/${outline.id}`;
    const popup = window.open(nextPath, "_blank", "noopener,noreferrer");
    if (!popup) {
      window.alert("浏览器拦截了新标签页，请允许弹窗后重试（当前生成页已保留）。");
      return;
    }
  };

  const applyParagraphUpdates = (
    updates: Array<{
      outlineId: number;
      chapterIndex: number;
      paragraphIndex: number;
      draft?: string;
      content?: string;
    }>,
  ) => {
    if (updates.length === 0) return;
    setOutlines((prev) => {
      const next = prev.slice();
      let changed = false;

      for (const update of updates) {
        const outlineIdx = next.findIndex((outline) => outline.id === update.outlineId);
        if (outlineIdx === -1) continue;

        const target = next[outlineIdx];
        const chapter = target.chapters[update.chapterIndex];
        const paragraph = chapter?.paragraphs[update.paragraphIndex];
        if (!chapter || !paragraph) continue;

        const nextParagraph = { ...paragraph };
        if (update.draft !== undefined) nextParagraph.draft = update.draft;
        if (update.content !== undefined) nextParagraph.content = update.content;

        const paragraphs = chapter.paragraphs.slice();
        paragraphs[update.paragraphIndex] = nextParagraph;
        const chapters = target.chapters.slice();
        chapters[update.chapterIndex] = {
          ...chapter,
          paragraphs,
          content: joinChapterParagraphs(paragraphs),
        };
        next[outlineIdx] = { ...target, chapters };
        changed = true;
      }

      return changed ? next : prev;
    });
  };

  // Same regex-based "content" walker as extractStreamingChapterText, which
  // tolerates the model's frequent failure mode: writing `{"content":"…prose…`
  // and then hitting max_tokens / emitting the closing ``` fence before the
  // trailing `"}`. The old implementation fell back to the raw text on parse
  // failure, which dumped the `{\n  "content":` wrapper into paragraph.content.
  const extractParagraphContent = extractStreamingChapterText;

  type ParagraphTask = {
    outline: Outline;
    chapterIndex: number;
    paragraphIndex: number;
  };

  const runParagraphDrafts = async (regenerateAll = false) => {
    if (chapterGenerationLockRef.current || outlineGenerationLockRef.current) return;

    const snapshot = outlines;
    const pendingTasks: ParagraphTask[] = snapshot.flatMap((outline) =>
      outline.chapters.flatMap((chapter, chapterIndex) =>
        chapter.paragraphs
          .map((paragraph, paragraphIndex) => ({
            outline,
            chapterIndex,
            paragraphIndex,
            paragraph,
          }))
          .filter(({ paragraph }) => {
            const outlineText = paragraph.outline?.trim();
            if (!outlineText || outlineText === "待生成") return false;
            if (regenerateAll) return true;
            return !isParagraphDraftComplete(paragraph.draft);
          }),
      ),
    );

    if (pendingTasks.length === 0) return;

    const workingDrafts = new Map<string, string>();
    const workingContents = new Map<string, string>();
    if (!regenerateAll) {
      for (const outline of snapshot) {
        outline.chapters.forEach((chapter, chapterIndex) => {
          chapter.paragraphs.forEach((paragraph, paragraphIndex) => {
            const key = `${outline.id}:${chapterIndex}:${paragraphIndex}`;
            if (isParagraphDraftComplete(paragraph.draft)) {
              workingDrafts.set(key, paragraph.draft);
            }
            if (isParagraphExpandComplete(paragraph.content)) {
              workingContents.set(key, paragraph.content);
            }
          });
        });
      }
    }

    const waveKeys = new Map<string, ParagraphTask[]>();
    for (const task of pendingTasks) {
      const waveKey = `${task.chapterIndex}:${task.paragraphIndex}`;
      const wave = waveKeys.get(waveKey) ?? [];
      wave.push(task);
      waveKeys.set(waveKey, wave);
    }

    const sortedWaveKeys = [...waveKeys.keys()].sort((a, b) => {
      const [aChapter, aParagraph] = a.split(":").map(Number);
      const [bChapter, bParagraph] = b.split(":").map(Number);
      return aChapter - bChapter || aParagraph - bParagraph;
    });

    const pendingLabel = "写段中";
    const pendingUpdates = new Map<
      string,
      {
        outlineId: number;
        chapterIndex: number;
        paragraphIndex: number;
        draft: string;
      }
    >();
    let streamRaf: number | null = null;

    const flushPending = () => {
      if (pendingUpdates.size === 0) return;
      applyParagraphUpdates(Array.from(pendingUpdates.values()).map((item) => ({
        outlineId: item.outlineId,
        chapterIndex: item.chapterIndex,
        paragraphIndex: item.paragraphIndex,
        draft: item.draft,
      })));
      pendingUpdates.clear();
    };

    const scheduleUpdate = (update: {
      outlineId: number;
      chapterIndex: number;
      paragraphIndex: number;
      draft: string;
    }) => {
      pendingUpdates.set(
        `${update.outlineId}:${update.chapterIndex}:${update.paragraphIndex}`,
        update,
      );
      if (streamRaf != null) return;
      streamRaf = requestAnimationFrame(() => {
        streamRaf = null;
        if (!chapterGenerationLockRef.current) return;
        flushPending();
      });
    };

    setIsGenerating(true);
    chapterGenerationLockRef.current = true;

    try {
      for (const waveKey of sortedWaveKeys) {
        const waveTasks = waveKeys.get(waveKey)!;
        const inputs = waveTasks.map(({ outline, chapterIndex, paragraphIndex }) => {
          const previousParagraphContent =
            paragraphIndex > 0
              ? workingContents.get(`${outline.id}:${chapterIndex}:${paragraphIndex - 1}`) ||
                workingDrafts.get(`${outline.id}:${chapterIndex}:${paragraphIndex - 1}`)
              : undefined;
          const previousChapterContent =
            chapterIndex > 0
              ? joinChapterParagraphs(
                  outline.chapters[chapterIndex - 1].paragraphs.map((paragraph, index) => ({
                    ...paragraph,
                    content:
                      workingContents.get(`${outline.id}:${chapterIndex - 1}:${index}`) ||
                      workingDrafts.get(`${outline.id}:${chapterIndex - 1}:${index}`) ||
                      paragraph.content ||
                      paragraph.draft,
                  })),
                ) || undefined
              : undefined;

          return buildParagraphGenerationTask(
            outline,
            chapterIndex,
            paragraphIndex,
            previousParagraphContent,
            previousChapterContent,
          );
        });

        const rawContents = await rwkvService.generateParagraphDrafts(
          inputs,
          (taskIndex, content) => {
            const task = waveTasks[taskIndex];
            if (!task) return;
            const streamText = extractStreamingChapterText(content);
            scheduleUpdate({
              outlineId: task.outline.id,
              chapterIndex: task.chapterIndex,
              paragraphIndex: task.paragraphIndex,
              draft: streamText
                ? `${pendingLabel}...\n${streamText}`
                : `${pendingLabel}... ${content.length}字`,
            });
          },
          (taskIndex, content) => {
            const task = waveTasks[taskIndex];
            if (!task) return;
            const finalDraft = extractParagraphContent(content);
            if (!finalDraft) return;
            workingDrafts.set(
              `${task.outline.id}:${task.chapterIndex}:${task.paragraphIndex}`,
              finalDraft,
            );
            if (streamRaf != null) {
              cancelAnimationFrame(streamRaf);
              streamRaf = null;
            }
            pendingUpdates.set(
              `${task.outline.id}:${task.chapterIndex}:${task.paragraphIndex}`,
              {
                outlineId: task.outline.id,
                chapterIndex: task.chapterIndex,
                paragraphIndex: task.paragraphIndex,
                draft: finalDraft,
              },
            );
            flushPending();
          },
        );

        if (streamRaf != null) {
          cancelAnimationFrame(streamRaf);
          streamRaf = null;
        }
        flushPending();

        waveTasks.forEach((task, taskIndex) => {
          const finalDraft = extractParagraphContent(rawContents[taskIndex] || "");
          if (!finalDraft) return;
          workingDrafts.set(
            `${task.outline.id}:${task.chapterIndex}:${task.paragraphIndex}`,
            finalDraft,
          );
          applyParagraphUpdates([
            {
              outlineId: task.outline.id,
              chapterIndex: task.chapterIndex,
              paragraphIndex: task.paragraphIndex,
              draft: finalDraft,
            },
          ]);
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "未知错误";
      window.alert(`段落草稿生成失败：${message}`);
    } finally {
      if (streamRaf != null) cancelAnimationFrame(streamRaf);
      pendingUpdates.clear();
      chapterGenerationLockRef.current = false;
      setIsGenerating(false);
    }
  };

  const runParagraphExpands = async (regenerateAll = false) => {
    if (chapterGenerationLockRef.current || outlineGenerationLockRef.current) return;

    let workingOutlines = structuredClone(outlines) as Outline[];

    const getParagraphContent = (
      outlineId: number,
      chapterIndex: number,
      paragraphIndex: number,
    ): string => {
      const outline = workingOutlines.find((item) => item.id === outlineId);
      const paragraph = outline?.chapters[chapterIndex]?.paragraphs[paragraphIndex];
      if (!paragraph) return "";
      if (isParagraphExpandComplete(paragraph.content)) return paragraph.content;
      if (isParagraphDraftComplete(paragraph.draft)) return paragraph.draft;
      return paragraph.content || paragraph.draft;
    };

    const updateWorkingParagraph = (
      outlineId: number,
      chapterIndex: number,
      paragraphIndex: number,
      content: string,
    ) => {
      const outlineIdx = workingOutlines.findIndex((item) => item.id === outlineId);
      if (outlineIdx === -1) return;
      const outline = workingOutlines[outlineIdx];
      const chapter = outline.chapters[chapterIndex];
      if (!chapter) return;
      const paragraphs = chapter.paragraphs.slice();
      paragraphs[paragraphIndex] = { ...paragraphs[paragraphIndex], content };
      const chapters = outline.chapters.slice();
      chapters[chapterIndex] = {
        ...chapter,
        paragraphs,
        content: joinChapterParagraphs(paragraphs),
      };
      workingOutlines = workingOutlines.slice();
      workingOutlines[outlineIdx] = { ...outline, chapters };
    };

    setIsGenerating(true);
    chapterGenerationLockRef.current = true;

    try {
      for (let round = 0; round < MAX_PARAGRAPH_EXPAND_ROUNDS; round += 1) {
        const pendingTasks: ParagraphTask[] = workingOutlines.flatMap((outline) =>
          outline.chapters.flatMap((chapter, chapterIndex) =>
            chapter.paragraphs
              .map((paragraph, paragraphIndex) => ({
                outline,
                chapterIndex,
                paragraphIndex,
                paragraph,
              }))
              .filter(({ paragraph }) => {
                if (!isParagraphDraftComplete(paragraph.draft)) return false;
                if (regenerateAll && round === 0) return true;
                return !isParagraphExpandComplete(paragraph.content);
              }),
          ),
        );

        if (pendingTasks.length === 0) break;

        const waveKeys = new Map<string, ParagraphTask[]>();
        for (const task of pendingTasks) {
          const waveKey = `${task.chapterIndex}:${task.paragraphIndex}`;
          const wave = waveKeys.get(waveKey) ?? [];
          wave.push(task);
          waveKeys.set(waveKey, wave);
        }

        const sortedWaveKeys = [...waveKeys.keys()].sort((a, b) => {
          const [aChapter, aParagraph] = a.split(":").map(Number);
          const [bChapter, bParagraph] = b.split(":").map(Number);
          return aChapter - bChapter || aParagraph - bParagraph;
        });

        for (const waveKey of sortedWaveKeys) {
          const waveTasks = waveKeys.get(waveKey)!;
          const inputs = waveTasks.map(({ outline, chapterIndex, paragraphIndex }) => {
            const currentContent = getParagraphContent(
              outline.id,
              chapterIndex,
              paragraphIndex,
            );
            const previousParagraphContent =
              paragraphIndex > 0
                ? getParagraphContent(outline.id, chapterIndex, paragraphIndex - 1)
                : undefined;
            const previousChapterContent =
              chapterIndex > 0
                ? joinChapterParagraphs(
                    outline.chapters[chapterIndex - 1].paragraphs.map((_, index) => ({
                      id: index + 1,
                      outline: "",
                      draft: "",
                      content: getParagraphContent(outline.id, chapterIndex - 1, index),
                    })),
                  ) || undefined
                : undefined;

            return buildParagraphExpandTask(
              outline,
              chapterIndex,
              paragraphIndex,
              currentContent,
              previousParagraphContent,
              previousChapterContent,
            );
          });

          const rawContents = await rwkvService.expandParagraphs(inputs);

          const batch = waveTasks.flatMap((task, taskIndex) => {
            const expanded = extractParagraphContent(rawContents[taskIndex] || "");
            if (!expanded) return [];
            updateWorkingParagraph(
              task.outline.id,
              task.chapterIndex,
              task.paragraphIndex,
              expanded,
            );
            return [
              {
                outlineId: task.outline.id,
                chapterIndex: task.chapterIndex,
                paragraphIndex: task.paragraphIndex,
                content: expanded,
              },
            ];
          });
          applyParagraphUpdates(batch);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "未知错误";
      window.alert(`段落扩写失败：${message}`);
    } finally {
      chapterGenerationLockRef.current = false;
      setIsGenerating(false);
    }
  };

  const runNextGenerationStage = async (regenerateAll = false) => {
    const stage = getGenerationStage(outlines);
    if (stage === "worldbuilding") {
      await generateOutlinesAndChapters();
      return;
    }
    if (stage === "paragraphs") {
      await runParagraphDrafts(regenerateAll);
      return;
    }
    if (stage === "expand") {
      await runParagraphExpands(regenerateAll);
      return;
    }
    await runParagraphDrafts(true);
    await runParagraphExpands(true);
  };

  const resetFlow = () => {
    outlineGenerationLockRef.current = false;
    chapterGenerationLockRef.current = false;
    setIsGenerating(false);
    stripLaunchQueryFromUrl();
    clearPersistedOutlines();
    setOutlines(createOutlinePlaceholders(OUTLINE_TOTAL));
    // 重置后送回首页选题材，避免停留在没有可操作内容的工作台。
    router.replace("/");
  };

  const generationStage = useMemo(() => getGenerationStage(outlines), [outlines]);

  const outlinesReady = useMemo(
    () => outlines.some((outline) => outline.chapters.length > 0),
    [outlines],
  );

  const primaryButtonLabel = isGenerating ? "处理中" : STAGE_LABELS[generationStage];
  const disablePrimaryButton =
    isGenerating || (generationStage === "worldbuilding" && !novelInput.trim());

  const handlePrimaryAction = () => {
    if (isGenerating) return;
    void runNextGenerationStage(generationStage === "complete");
  };

  return (
    <div className="min-h-screen w-full min-w-0 overflow-x-hidden bg-[radial-gradient(circle_at_10%_20%,rgba(56,189,248,0.14),transparent_45%),radial-gradient(circle_at_90%_10%,rgba(236,72,153,0.12),transparent_45%),linear-gradient(180deg,#020617,#030712_48%,#0b1120)]">
      <RwkvProductionUpstreamSettings />
      <main className="w-full pb-36">
        {/* 始终渲染同一张 10 卡网格——空 outline 的骨架就是 loading 占位，不再用 spinner→grid
            的二段切换，也就不会有上一版那种「一闪一闪」的过渡。 */}
        <section className="relative z-0 grid min-h-0 h-[calc(100vh-7.5rem)] grid-cols-5 grid-rows-2 items-stretch gap-3 p-3">
          {outlines.map((outline) => (
            <OutlineCard
              key={outline.id}
              outline={outline}
              onSelect={openOutlineDetails}
              isGenerating={isGenerating}
            />
          ))}
        </section>
      </main>

      <div className="pointer-events-none fixed bottom-[max(0.75rem,env(safe-area-inset-bottom,0px))] left-1/2 z-50 w-[min(720px,calc(100%-24px))] max-w-full -translate-x-1/2">
        <div className="pointer-events-auto max-w-full overflow-x-hidden rounded-xl border border-border/80 bg-card/95 px-3 py-2.5 shadow-[0_14px_45px_-24px_rgba(2,6,23,0.95)] ring-1 ring-border/30 backdrop-blur-xl">
          <div className="flex min-w-0 max-w-full items-end gap-2 overflow-x-hidden">
            <Textarea
              value={novelInput}
              onChange={(e) => setNovelInput(e.target.value)}
              readOnly={outlinesReady}
              placeholder={
                outlinesReady
                  ? "创建时的总设定（只读）；三轮流程：世界观 → 段落草稿 → 段落扩写"
                  : "题材、世界观、主角设定..."
              }
              rows={2}
              className={cn(
                "min-h-18 max-h-36 min-w-0 flex-1 basis-0 resize-none overflow-y-auto overflow-x-hidden rounded-lg border border-border/70 bg-background/90 px-3 py-2.5 text-sm leading-relaxed text-foreground shadow-none focus-visible:ring-1 focus-visible:ring-ring/40",
                outlinesReady &&
                  "cursor-not-allowed bg-muted/40 text-foreground/90 ring-1 ring-border/60 focus-visible:ring-0",
              )}
            />
            <Button
              variant="ghost"
              disabled={isGenerating}
              onClick={resetFlow}
              className="h-9 shrink-0 rounded-md px-3 text-sm"
            >
              重置
            </Button>
            <Button
              onClick={handlePrimaryAction}
              disabled={disablePrimaryButton}
              className="h-9 shrink-0 rounded-full px-4 text-sm"
            >
              {isGenerating ? (
                <>
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                  处理中
                </>
              ) : outlinesReady ? (
                <>
                  {generationStage === "complete" ? (
                    <RefreshCw className="mr-1.5 h-4 w-4" />
                  ) : (
                    <Wand2 className="mr-1.5 h-4 w-4" />
                  )}
                  {primaryButtonLabel}
                </>
              ) : (
                <>
                  <Sparkles className="mr-1.5 h-4 w-4" />
                  {primaryButtonLabel}
                </>
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
