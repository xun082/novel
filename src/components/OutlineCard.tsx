/**
 * 大纲卡片组件
 */

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { MarkdownContent } from "./MarkdownContent";
import { processContent } from "./ContentProcessor";

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
}

export function OutlineCard({ outline, isGenerating, onSelect }: OutlineCardProps) {
  const { thinking } = processContent(outline.rawContent);
  
  // 显示章节数量
  const chapterCount = outline.chapters?.length || 0;

  return (
    <Card 
      className={`transition-colors ${!isGenerating ? 'cursor-pointer hover:border-primary' : ''}`}
      onClick={() => !isGenerating && outline.rawContent && onSelect(outline)}
    >
      <CardHeader>
        <CardTitle className="text-xl flex items-center gap-2">
          {outline.title}
          <div className="flex gap-1.5">
            {chapterCount > 0 && (
              <Badge variant="secondary" className="text-xs">
                {chapterCount}章
              </Badge>
            )}
            {isGenerating && outline.rawContent && (
              <Badge variant="outline" className="text-xs animate-pulse">
                生成中
              </Badge>
            )}
          </div>
        </CardTitle>
        {outline.summary && (
          <CardDescription className="text-base leading-relaxed">
            {outline.summary}
          </CardDescription>
        )}
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {outline.rawContent ? (
            <>
              {/* 显示章节列表 */}
              {chapterCount > 0 ? (
                <div className="max-h-80 overflow-y-auto border rounded-lg p-4 bg-slate-50 dark:bg-slate-900">
                  <div className="text-sm font-semibold mb-3 text-slate-700 dark:text-slate-300">
                    📖 章节大纲 ({chapterCount}章)
                  </div>
                  <div className="space-y-2.5">
                    {outline.chapters.map((chapter) => (
                      <div 
                        key={chapter.id} 
                        className="p-2.5 bg-white dark:bg-slate-950 rounded border border-slate-200 dark:border-slate-800"
                      >
                        <div className="font-medium text-sm text-slate-900 dark:text-slate-100 mb-1">
                          {chapter.title}
                        </div>
                        <div className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
                          {chapter.outline}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                // 如果没有解析出章节，显示原始内容（用于调试）
                <div className="text-sm max-h-96 overflow-y-auto border-2 border-amber-300 rounded-lg p-4 bg-amber-50 dark:bg-amber-950/20">
                  <div className="text-sm font-semibold text-amber-700 dark:text-amber-300 mb-3">
                    ⚠️ JSON解析失败 - 调试信息
                  </div>
                  <div className="space-y-2">
                    <div className="text-xs">
                      <span className="font-semibold">内容长度：</span>
                      <span className="text-amber-600 dark:text-amber-400">{outline.rawContent.length} 字</span>
                    </div>
                    <div className="text-xs">
                      <span className="font-semibold">原始内容：</span>
                    </div>
                    <div className="whitespace-pre-wrap text-xs font-mono bg-white dark:bg-slate-900 p-3 rounded border max-h-64 overflow-y-auto">
                      {outline.rawContent}
                    </div>
                    <div className="text-xs text-amber-600 dark:text-amber-400 mt-2">
                      💡 提示：请查看浏览器控制台了解详细的解析错误信息
                    </div>
                  </div>
                </div>
              )}
              
              {/* 可选：显示深度思考部分（折叠） */}
              {thinking && (
                <details className="text-xs">
                  <summary className="cursor-pointer text-blue-600 dark:text-blue-400 hover:underline">
                    💭 查看模型思考过程
                  </summary>
                  <div className="mt-2 p-2 bg-blue-50 dark:bg-blue-950/30 rounded border border-blue-200 dark:border-blue-800 whitespace-pre-wrap font-mono text-xs">
                    {thinking}
                  </div>
                </details>
              )}
            </>
          ) : (
            <div className="min-h-32 flex flex-col items-center justify-center gap-3">
              <div className="animate-spin h-8 w-8 border-4 border-blue-500 border-t-transparent rounded-full"></div>
              <div className="text-sm text-muted-foreground animate-pulse">
                正在生成大纲，请稍候...
              </div>
            </div>
          )}
        </div>
        <Button 
          className="w-full mt-4" 
          disabled={isGenerating || !outline.rawContent || chapterCount === 0}
        >
          {!outline.rawContent ? "生成中..." : (chapterCount > 0 ? "选择此大纲" : "解析中...")}
        </Button>
      </CardContent>
    </Card>
  );
}
