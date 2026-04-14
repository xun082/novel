"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Loader2, BookOpen, Sparkles, ChevronRight } from "lucide-react";
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

export default function Home() {
  // 配置
  const [genre, setGenre] = useState("玄幻");
  const [chapterCount, setChapterCount] = useState(15);
  const [outlineCount, setOutlineCount] = useState(3);
  
  // 流程状态
  const [stage, setStage] = useState<Stage>("config");
  const [isGenerating, setIsGenerating] = useState(false);
  const [currentStep, setCurrentStep] = useState("");
  
  // 数据
  const [outlines, setOutlines] = useState<Outline[]>([]);
  const [selectedOutline, setSelectedOutline] = useState<Outline | null>(null);

  // 从JSON字符串中提取JSON对象（仅在流式输出完成后调用）
  const extractJSON = (text: string): Record<string, unknown> | null => {
    if (!text || text.trim().length === 0) {
      return null;
    }

    try {
      let cleaned = text.trim();
      
      // 移除 <think></think> 标签及其内容
      cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/g, '');
      
      // 移除开头的 markdown 代码块标记
      cleaned = cleaned.replace(/^```(?:json)?\s*/gi, '');
      
      // 移除结尾的 ```
      cleaned = cleaned.replace(/\s*```\s*$/g, '');
      
      // 尝试找到第一个 { 和最后一个 }
      const firstBrace = cleaned.indexOf('{');
      const lastBrace = cleaned.lastIndexOf('}');
      
      if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
        return null;
      }
      
      cleaned = cleaned.substring(firstBrace, lastBrace + 1);
      
      // 解析JSON
      const parsed = JSON.parse(cleaned);
      return parsed;
    } catch (error) {
      // 尝试备用解析方法
      try {
        let fixed = text.trim();
        fixed = fixed.replace(/<think>[\s\S]*?<\/think>/g, '');
        fixed = fixed.replace(/^```(?:json)?\s*/gi, '');
        fixed = fixed.replace(/\s*```\s*$/g, '');
        
        // 查找第一个完整的JSON对象
        const matches = fixed.match(/\{[\s\S]*\}/);
        if (matches) {
          const parsed = JSON.parse(matches[0]);
          console.log('  ℹ️ 使用备用方法解析成功');
          return parsed;
        }
      } catch {
        // 静默失败
      }
      
      // 只在最终解析失败时输出详细错误
      console.error('  ❌ JSON解析失败:', error);
      console.log('  📄 原始内容前100字:', text.substring(0, 100));
      console.log('  📄 原始内容后100字:', text.substring(Math.max(0, text.length - 100)));
      
      return null;
    }
  };

  // 阶段1: 并发生成多个大纲供用户选择
  const generateOutlines = async () => {
    setIsGenerating(true);
    setStage("outlines"); // 立即切换到大纲阶段
    setCurrentStep(`正在并发生成 ${outlineCount} 个小说大纲...`);
    
    // 初始化临时大纲数组
    const tempOutlines: Outline[] = Array.from({ length: outlineCount }, (_, index) => ({
      id: index + 1,
      title: `生成中 ${index + 1}...`,
      summary: "",
      chapters: [],
      rawContent: ""
    }));
    setOutlines(tempOutlines);
    
    try {
      console.log('开始生成大纲，数量:', outlineCount);
      
      // 一次API调用，并发生成多个大纲（带流式更新）
      const rawOutlines = await rwkvService.generateMultipleOutlines(
        genre, 
        chapterCount, 
        outlineCount,
        (index, content) => {
          // 流式更新回调 - 只保存原始内容，不解析JSON（因为JSON可能还没闭合）
          console.log(`[流式更新] 大纲 ${index + 1}: ${content.length} 字`);
          
          setOutlines(prev => {
            const updated = [...prev];
            if (updated[index]) {
              updated[index] = {
                ...updated[index],
                rawContent: content,
                title: `大纲 ${index + 1} (生成中 ${content.length}字)`,
                summary: "正在生成中，请稍候...",
                chapters: [] // 等流式结束后再解析
              };
            }
            return updated;
          });
        }
      );
      
      console.log('\n========== 【流式输出完成，开始最终解析】 ==========');
      console.log(`收到 ${rawOutlines.length} 个完整的大纲`);
      
      // 等待流式输出完全结束后，统一解析所有大纲的JSON
      const parsedOutlines: Outline[] = rawOutlines.map((rawContent, index) => {
        console.log(`\n--- 【大纲 ${index + 1}】最终解析 ---`);
        console.log(`  原始长度: ${rawContent.length} 字`);
        
        const jsonData = extractJSON(rawContent);
        
        if (jsonData) {
          console.log(`  ✅ JSON解析成功`);
          
          const title = (jsonData.title as string) || (jsonData.标题 as string) || (jsonData.小说标题 as string) || `大纲 ${index + 1}`;
          const summary = (jsonData.summary as string) || (jsonData.核心梗概 as string) || (jsonData.梗概 as string) || "";
          
          console.log(`  - 标题: ${title}`);
          console.log(`  - 简介: ${summary.substring(0, 30)}...`);
          
          // 提取章节信息
          const chapters: Chapter[] = [];
          const chaptersData = (jsonData.chapters || jsonData.章节 || []) as Record<string, unknown>[];
          
          console.log(`  - 章节数: ${chaptersData.length}`);
          
          chaptersData.forEach((chapterData: Record<string, unknown>, chapterIndex: number) => {
            if (chapterIndex < chapterCount) {
              const chapterTitle = (chapterData.title as string) || (chapterData.标题 as string) || (chapterData.chapter as string) || `第${chapterIndex + 1}章`;
              const chapterOutline = (chapterData.outline as string) || (chapterData.梗概 as string) || (chapterData.内容梗概 as string) || "待生成";
              
              chapters.push({
                id: chapterIndex + 1,
                title: chapterTitle,
                outline: chapterOutline,
                content: ""
              });
            }
          });
          
          console.log(`  ✅ 解析出 ${chapters.length} 个章节`);
          
          return {
            id: index + 1,
            title: title,
            summary: summary,
            chapters: chapters,
            rawContent: rawContent
          };
        } else {
          console.error(`  ❌ JSON解析失败`);
          
          return {
            id: index + 1,
            title: `大纲 ${index + 1} (解析失败)`,
            summary: "JSON解析失败，请查看调试信息",
            chapters: [],
            rawContent: rawContent
          };
        }
      });
      
      console.log('\n========== 【所有大纲解析完成，开始渲染】 ==========');
      console.log(`成功解析: ${parsedOutlines.filter(o => o.chapters.length > 0).length}/${parsedOutlines.length}`);
      console.log('========== 【准备更新UI】 ==========\n');
      
      // 一次性更新UI
      setOutlines(parsedOutlines);
      setCurrentStep(`大纲生成完成！成功生成 ${parsedOutlines.filter(o => o.chapters.length > 0).length} 个大纲`);
    } catch (error) {
      console.error("生成大纲失败:", error);
      setCurrentStep(`生成失败: ${error instanceof Error ? error.message : '未知错误'}`);
      setStage("config");
      setOutlines([]);
    } finally {
      setIsGenerating(false);
    }
  };

  // 阶段2: 选择大纲后，并发生成所有章节内容
  const selectOutlineAndGenerateChapters = async (outline: Outline) => {
    // 使用已解析的章节信息，如果没有则创建默认章节
    const chapters: Chapter[] = [...outline.chapters];
    
    // 如果没有章节信息，尝试从原始内容重新解析JSON
    if (chapters.length === 0) {
      console.log('没有找到章节信息，尝试重新解析JSON...');
      const jsonData = extractJSON(outline.rawContent);
      
      if (jsonData && (jsonData.chapters || jsonData.章节)) {
        const chaptersData = (jsonData.chapters || jsonData.章节 || []) as Record<string, unknown>[];
        chaptersData.forEach((chapterData: Record<string, unknown>, index: number) => {
          if (index < chapterCount) {
            chapters.push({
              id: index + 1,
              title: (chapterData.title as string) || (chapterData.标题 as string) || (chapterData.chapter as string) || `第${index + 1}章`,
              outline: (chapterData.outline as string) || (chapterData.梗概 as string) || (chapterData.内容梗概 as string) || "待生成",
              content: ""
            });
          }
        });
      }
    }
    
    // 如果还是没有章节，创建默认章节
    if (chapters.length === 0) {
      console.log('创建默认章节...');
      for (let i = 0; i < chapterCount; i++) {
        chapters.push({
          id: i + 1,
          title: `第${i + 1}章`,
          outline: "待生成",
          content: ""
        });
      }
    }
    
    console.log(`准备生成 ${chapters.length} 个章节的内容`);
    chapters.forEach((ch, i) => {
      console.log(`  [${i + 1}] ${ch.title}: ${ch.outline}`);
    });
    
    const initialOutline = {
      ...outline,
      chapters
    };
    setSelectedOutline(initialOutline);
    setIsGenerating(true);
    setStage("chapters");
    setCurrentStep(`正在并发生成所有 ${chapters.length} 个章节内容...`);
    
    try {
      // 构建小说上下文
      const novelContext = {
        title: outline.title,
        summary: outline.summary
      };
      
      // 并发生成所有章节内容（JSON格式，带流式更新）
      const rawContents = await rwkvService.generateChapters(
        novelContext,
        chapters.map(ch => ({ title: ch.title, outline: ch.outline })),
        (index, content) => {
          // 流式更新回调 - 只保存原始内容，不解析
          console.log(`[流式更新] 章节 ${index + 1}: ${content.length} 字`);
          
          setSelectedOutline(prev => {
            if (!prev) return prev;
            return {
              ...prev,
              chapters: prev.chapters.map((chapter, i) => 
                i === index ? { ...chapter, content: `生成中... ${content.length}字` } : chapter
              )
            };
          });
        }
      );
      
      console.log('\n========== 【章节流式输出完成，开始解析】 ==========');
      
      // 流式结束后，统一解析JSON并提取content
      const parsedChapters = chapters.map((chapter, index) => {
        const rawContent = rawContents[index] || "";
        console.log(`\n--- 【章节 ${index + 1}】解析 ---`);
        console.log(`  原始长度: ${rawContent.length} 字`);
        
        const jsonData = extractJSON(rawContent);
        let content = "";
        
        if (jsonData && jsonData.content) {
          content = jsonData.content as string;
          console.log(`  ✅ JSON解析成功，内容长度: ${content.length} 字`);
        } else {
          // 降级：如果JSON解析失败，使用原始内容
          content = rawContent;
          console.log(`  ⚠️ JSON解析失败，使用原始内容`);
        }
        
        return {
          ...chapter,
          content: content
        };
      });
      
      console.log('========== 【所有章节解析完成】 ==========\n');
      
      const updatedOutline = {
        ...initialOutline,
        chapters: parsedChapters
      };
      
      // 打印统计信息
      console.log('\n========== 【章节生成完成】 ==========');
      updatedOutline.chapters.forEach((chapter, index) => {
        console.log(`  章节 ${index + 1}: ${chapter.title} - ${chapter.content.length} 字`);
      });
      console.log('========== 【完成】 ==========\n');
      
      setSelectedOutline(updatedOutline);
      setCurrentStep("所有章节生成完成！你可以选择扩写某些章节");
    } catch (error) {
      console.error("生成章节失败:", error);
      setCurrentStep("生成失败，请重试");
    } finally {
      setIsGenerating(false);
    }
  };

  // 阶段3: 并发扩写所有章节（自动化）
  const expandAllChapters = async () => {
    if (!selectedOutline) return;
    
    setIsGenerating(true);
    setStage("expand");
    setCurrentStep(`正在并发扩写所有 ${selectedOutline.chapters.length} 个章节...`);
    
    try {
      console.log('\n========== 【开始扩写所有章节】 ==========');
      console.log(`大纲: ${selectedOutline.title}`);
      console.log(`章节数: ${selectedOutline.chapters.length}`);
      
      // 构建扩写章节信息（包含大纲和梗概上下文）
      const chaptersToExpand = selectedOutline.chapters.map(chapter => ({
        id: chapter.id,
        title: chapter.title,
        outline: chapter.outline,
        currentContent: chapter.content
      }));
      
      // 并发扩写所有章节（JSON格式，带流式更新）
      const rawContents = await rwkvService.expandChapters(
        chaptersToExpand,
        (index, content) => {
          // 流式更新回调 - 只显示进度
          console.log(`[流式更新] 扩写章节 ${index + 1}/${chaptersToExpand.length}: ${content.length} 字`);
          
          setSelectedOutline(prev => {
            if (!prev) return prev;
            return {
              ...prev,
              chapters: prev.chapters.map((chapter, i) => 
                i === index
                  ? { ...chapter, content: `扩写中... ${content.length}字` }
                  : chapter
              )
            };
          });
        }
      );
      
      console.log('\n========== 【扩写流式输出完成，开始解析】 ==========');
      
      // 流式结束后，统一解析JSON并提取content
      const parsedChapters = selectedOutline.chapters.map((chapter, index) => {
        const rawContent = rawContents[index] || "";
        console.log(`\n--- 【扩写章节 ${index + 1}】解析 ---`);
        console.log(`  章节: ${chapter.title}`);
        console.log(`  原始长度: ${rawContent.length} 字`);
        
        const jsonData = extractJSON(rawContent);
        let content = "";
        
        if (jsonData && jsonData.content) {
          content = jsonData.content as string;
          console.log(`  ✅ JSON解析成功，扩写后: ${content.length} 字`);
        } else {
          // 降级：如果JSON解析失败，使用原始内容
          content = rawContent || chapter.content;
          console.log(`  ⚠️ JSON解析失败，保持原内容`);
        }
        
        return {
          ...chapter,
          content: content
        };
      });
      
      console.log('========== 【所有扩写解析完成】 ==========\n');
      
      const updatedOutline = {
        ...selectedOutline,
        chapters: parsedChapters
      };
      
      // 打印统计信息
      console.log('\n========== 【章节扩写完成】 ==========');
      updatedOutline.chapters.forEach((chapter, index) => {
        const original = selectedOutline.chapters[index].content.length;
        const expanded = chapter.content.length;
        console.log(`  章节 ${index + 1}: ${chapter.title}`);
        console.log(`    扩写前: ${original} 字 → 扩写后: ${expanded} 字 (${expanded > original ? '+' : ''}${expanded - original})`);
      });
      console.log('========== 【完成】 ==========\n');
      
      setSelectedOutline(updatedOutline);
      setCurrentStep("所有章节扩写完成！");
    } catch (error) {
      console.error("扩写失败:", error);
      setCurrentStep("扩写失败，请重试");
    } finally {
      setIsGenerating(false);
    }
  };
  
  // 重置流程
  const resetFlow = () => {
    setStage("config");
    setOutlines([]);
    setSelectedOutline(null);
    setCurrentStep("");
  };

  return (
    <div className="min-h-screen bg-linear-to-br from-slate-50 via-blue-50 to-slate-100 dark:from-slate-950 dark:via-slate-900 dark:to-slate-950">
      {/* 顶部导航栏 */}
      <div className="sticky top-0 z-50 w-full border-b bg-white/80 backdrop-blur-sm dark:bg-slate-950/80 shadow-sm">
        <div className="container mx-auto px-6 py-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-linear-to-br from-blue-600 to-purple-600 shadow-lg">
                <BookOpen className="h-8 w-8 text-white" />
              </div>
              <div>
                <h1 className="text-2xl font-bold tracking-tight">并行小说生成系统</h1>
                <p className="text-sm text-muted-foreground mt-0.5">基于 RWKV 模型的智能创作平台</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <Badge variant={stage === "config" ? "default" : "outline"} className="gap-1.5 px-4 py-2 text-sm">
                1. 配置
              </Badge>
              <ChevronRight className="h-5 w-5 text-muted-foreground" />
              <Badge variant={stage === "outlines" ? "default" : "outline"} className="gap-1.5 px-4 py-2 text-sm">
                2. 选择大纲
              </Badge>
              <ChevronRight className="h-5 w-5 text-muted-foreground" />
              <Badge variant={stage === "chapters" ? "default" : "outline"} className="gap-1.5 px-4 py-2 text-sm">
                3. 生成章节
              </Badge>
              <ChevronRight className="h-5 w-5 text-muted-foreground" />
              <Badge variant={stage === "expand" ? "default" : "outline"} className="gap-1.5 px-4 py-2 text-sm">
                4. 扩写
              </Badge>
            </div>
          </div>
        </div>
      </div>

      {/* 主内容区域 */}
      <div className="container mx-auto px-6 py-10 max-w-[1600px]">

        {/* 阶段1: 配置 */}
        {stage === "config" && (
          <div className="mx-auto max-w-[1400px] space-y-8">
            <Card className="border-2 shadow-lg">
              <CardHeader className="space-y-3 pb-6">
                <div className="flex items-center gap-3">
                  <Sparkles className="h-8 w-8 text-blue-600" />
                  <CardTitle className="text-4xl font-bold">创作配置</CardTitle>
                </div>
                <CardDescription className="text-lg">设置小说参数，开启您的创作之旅</CardDescription>
              </CardHeader>
              <CardContent className="space-y-10 px-10 py-8">
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-10">
                  <div className="space-y-5">
                    <div className="space-y-2">
                      <Label htmlFor="genre" className="text-xl font-bold block">小说类型</Label>
                      <Input
                        id="genre"
                        value={genre}
                        onChange={(e) => setGenre(e.target.value)}
                        placeholder="例如: 玄幻、仙侠、科幻"
                        className="h-16 text-xl px-5 w-full"
                      />
                    </div>
                    <p className="text-base text-muted-foreground">选择您想创作的小说类型</p>
                  </div>
                  <div className="space-y-5">
                    <div className="space-y-2">
                      <Label htmlFor="chapters" className="text-xl font-bold block">章节数量</Label>
                      <Input
                        id="chapters"
                        type="number"
                        value={chapterCount}
                        onChange={(e) => setChapterCount(parseInt(e.target.value) || 15)}
                        min={5}
                        max={50}
                        className="h-16 text-xl px-5 w-full"
                      />
                    </div>
                    <p className="text-base text-muted-foreground">设置小说包含的章节数量</p>
                  </div>
                  <div className="space-y-5">
                    <div className="space-y-2">
                      <Label htmlFor="outlines" className="text-xl font-bold block">大纲数量（并发生成）</Label>
                      <Input
                        id="outlines"
                        type="number"
                        value={outlineCount}
                        onChange={(e) => setOutlineCount(parseInt(e.target.value) || 3)}
                        min={1}
                        max={8}
                        className="h-16 text-xl px-5 w-full"
                      />
                    </div>
                    <p className="text-base text-muted-foreground">并发生成多个大纲供选择</p>
                  </div>
                </div>
                
                <Separator className="my-10" />
                
                <Alert className="border-blue-200 bg-blue-50/50 dark:bg-blue-950/20 p-8">
                  <Sparkles className="h-7 w-7 text-blue-600" />
                  <AlertDescription className="ml-4">
                    <div className="space-y-5">
                      <p className="text-xl font-bold text-blue-900 dark:text-blue-100">🚀 并发生成流程</p>
                      <ul className="text-lg text-blue-800 dark:text-blue-200 space-y-4">
                        <li className="flex items-start gap-4">
                          <span className="font-bold min-w-fit text-xl">第1步：</span>
                          <span>并发生成 <strong className="text-xl">{outlineCount}</strong> 个不同风格的小说大纲供您选择</span>
                        </li>
                        <li className="flex items-start gap-4">
                          <span className="font-bold min-w-fit text-xl">第2步：</span>
                          <span>选择大纲后，并发生成该大纲的所有 <strong className="text-xl">{chapterCount}</strong> 个章节内容</span>
                        </li>
                        <li className="flex items-start gap-4">
                          <span className="font-bold min-w-fit text-xl">第3步：</span>
                          <span>选择章节后，并发扩写选中章节的详细内容</span>
                        </li>
                      </ul>
                      <p className="text-lg font-bold text-blue-900 dark:text-blue-100 mt-5">
                        ✨ 充分利用模型的并发能力，高效生成优质内容！
                      </p>
                    </div>
                  </AlertDescription>
                </Alert>
                 
                <Button 
                  onClick={generateOutlines} 
                  className="w-full h-20 text-2xl font-bold"
                  size="lg"
                >
                  <Sparkles className="mr-3 h-7 w-7" />
                  开始生成大纲
                </Button>
              </CardContent>
            </Card>
          </div>
        )}

        {/* 阶段2: 选择大纲 */}
        {stage === "outlines" && (
          <div className="space-y-8">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-4xl font-bold tracking-tight">选择小说大纲</h2>
                <p className="text-muted-foreground mt-2 text-lg">从 {outlineCount} 个生成的大纲中选择最符合您创意的一个</p>
              </div>
              <Button variant="outline" size="lg" onClick={resetFlow} disabled={isGenerating} className="h-12 px-6 text-base">
                重新开始
              </Button>
            </div>
            
            {isGenerating && (
              <Alert className="border-green-200 bg-green-50/50 dark:bg-green-950/20 p-5">
                <Loader2 className="h-5 w-5 animate-spin text-green-600" />
                <AlertDescription className="ml-3 text-green-900 dark:text-green-100 text-base">
                  {currentStep} - 内容正在实时生成中，请稍候...
                </AlertDescription>
              </Alert>
            )}
            
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-8">
              {outlines.map((outline) => (
                <OutlineCard
                  key={outline.id}
                  outline={outline}
                  isGenerating={isGenerating}
                  onSelect={selectOutlineAndGenerateChapters}
                />
              ))}
            </div>
          </div>
        )}

        {/* 阶段3: 查看章节并选择扩写 */}
        {(stage === "chapters" || stage === "expand") && selectedOutline && (
          <div className="space-y-8">
            <Card className="border-2 shadow-lg">
              <CardHeader className="p-8">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1">
                    <CardTitle className="text-4xl font-bold">{selectedOutline.title}</CardTitle>
                    <CardDescription className="mt-3 text-lg leading-relaxed">
                      {selectedOutline.summary}
                    </CardDescription>
                  </div>
                  <div className="flex gap-3">
                    {stage === "chapters" && !isGenerating && (
                      <Button onClick={expandAllChapters} disabled={isGenerating} size="lg" className="h-12 px-6 text-base bg-linear-to-r from-purple-600 to-blue-600 hover:from-purple-700 hover:to-blue-700" title="并发扩写所有章节，严格遵循各章节梗概">
                        <Sparkles className="mr-2 h-5 w-5" />
                        并发扩写所有章节
                      </Button>
                    )}
                    <Button variant="outline" onClick={resetFlow} disabled={isGenerating} size="lg" className="h-12 px-6 text-base">
                      重新开始
                    </Button>
                  </div>
                </div>
              </CardHeader>
            </Card>
            
            {isGenerating && (
              <Alert className="border-green-200 bg-green-50/50 dark:bg-green-950/20 p-5">
                <Loader2 className="h-5 w-5 animate-spin text-green-600" />
                <AlertDescription className="ml-3 text-green-900 dark:text-green-100 text-base">
                  {currentStep} - 内容正在实时更新中，请稍候...
                </AlertDescription>
              </Alert>
            )}
            
            {stage === "chapters" && !isGenerating && (
              <Alert className="border-purple-200 bg-purple-50/50 dark:bg-purple-950/20 p-5">
                <Sparkles className="h-5 w-5 text-purple-600" />
                <AlertDescription className="ml-3 text-purple-900 dark:text-purple-100 text-base">
                  <div className="space-y-2">
                    <p className="font-semibold">🚀 自动化并发扩写</p>
                    <ul className="list-disc list-inside space-y-1 text-sm ml-2">
                      <li>点击&ldquo;并发扩写所有章节&rdquo;按钮，<strong>自动扩写全部章节</strong></li>
                      <li>每个章节<strong>严格遵循其梗概</strong>，推进梗概中的剧情</li>
                      <li>利用大纲和章节上下文，智能扩写细节、对话、情节</li>
                      <li>扩写后字数约1200-1500字，全程并发处理</li>
                    </ul>
                  </div>
                </AlertDescription>
              </Alert>
            )}
            
            <ScrollArea className="h-[calc(100vh-450px)]">
              <div className="space-y-6 pr-4">
                {selectedOutline.chapters.map((chapter) => (
                  <ChapterCard
                    key={chapter.id}
                    chapter={chapter}
                    isGenerating={isGenerating}
                    stage={stage}
                  />
                ))}
              </div>
            </ScrollArea>
          </div>
        )}
      </div>
    </div>
  );
}
