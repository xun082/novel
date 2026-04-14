/**
 * 章节卡片组件
 */

import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChevronDown, ChevronUp } from "lucide-react";

interface Chapter {
  id: number;
  title: string;
  outline: string;
  content: string;
}

interface ChapterCardProps {
  chapter: Chapter;
  isGenerating: boolean;
  stage: string;
}

export function ChapterCard({ 
  chapter, 
  isGenerating, 
  stage
}: ChapterCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  
  // 清理内容：移除可能的JSON标记和多余的换行
  const cleanContent = (text: string): string => {
    let cleaned = text.trim();
    
    // 移除可能的JSON标记
    cleaned = cleaned.replace(/^```(?:json)?\s*/gi, '');
    cleaned = cleaned.replace(/\s*```\s*$/g, '');
    
    // 如果内容被JSON包裹，尝试提取content字段
    if (cleaned.startsWith('{') && cleaned.includes('"content"')) {
      try {
        const parsed = JSON.parse(cleaned);
        if (parsed.content) {
          cleaned = parsed.content;
        }
      } catch {
        // 如果解析失败，使用原始内容
      }
    }
    
    return cleaned;
  };
  
  const displayContent = cleanContent(chapter.content);
  
  // 判断内容是否为"生成中"或"扩写中"的提示
  const isGeneratingText = displayContent.includes('生成中...') || displayContent.includes('扩写中...');
  
  // 限制预览长度（约200字）
  const previewContent = displayContent.length > 200 && !isExpanded
    ? displayContent.substring(0, 200) + '...'
    : displayContent;

  return (
    <Card className={isGenerating && chapter.content ? "border-green-200 dark:border-green-800" : ""}>
      <CardHeader>
        <div className="flex items-start justify-between">
          <div className="flex-1">
            <CardTitle className="text-lg flex items-center gap-2">
              {chapter.title}
              {isGenerating && !chapter.content && (
                <span className="text-xs text-muted-foreground animate-pulse">生成中...</span>
              )}
            </CardTitle>
            <CardDescription className="mt-3 p-3 bg-blue-50 dark:bg-blue-950/30 rounded-md border border-blue-200 dark:border-blue-800">
              <span className="text-xs font-semibold text-blue-700 dark:text-blue-300">📋 章节梗概：</span>
              <span className="text-sm text-blue-900 dark:text-blue-100">{chapter.outline}</span>
            </CardDescription>
          </div>
          <Badge variant={chapter.content.length > 0 && !isGeneratingText ? "default" : "secondary"}>
            {isGeneratingText ? "生成中" : `${displayContent.length} 字`}
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        {chapter.content ? (
          <div className="space-y-3">
            {/* 显示章节内容 */}
            <div className="relative">
              <div 
                className="p-5 border rounded-lg bg-linear-to-br from-slate-50 to-white dark:from-slate-900 dark:to-slate-950 overflow-hidden"
                style={{ 
                  maxHeight: isExpanded ? 'none' : '400px',
                  transition: 'max-height 0.3s ease'
                }}
              >
                <div 
                  className="prose prose-slate dark:prose-invert max-w-none text-base leading-relaxed whitespace-pre-wrap"
                  style={{ 
                    textIndent: '2em',
                    fontFamily: '"Noto Serif SC", "Source Han Serif SC", serif'
                  }}
                >
                  {isGeneratingText ? (
                    <div className="text-center text-muted-foreground animate-pulse py-8">
                      {displayContent}
                    </div>
                  ) : (
                    previewContent
                  )}
                </div>
                
                {/* 渐变遮罩（当内容折叠时） */}
                {!isExpanded && displayContent.length > 200 && !isGeneratingText && (
                  <div className="absolute bottom-0 left-0 right-0 h-20 bg-linear-to-t from-white dark:from-slate-950 to-transparent pointer-events-none" />
                )}
              </div>
              
              {/* 展开/收起按钮 */}
              {displayContent.length > 200 && !isGeneratingText && (
                <div className="flex justify-center mt-3">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setIsExpanded(!isExpanded)}
                    className="gap-2"
                  >
                    {isExpanded ? (
                      <>
                        <ChevronUp className="h-4 w-4" />
                        收起
                      </>
                    ) : (
                      <>
                        <ChevronDown className="h-4 w-4" />
                        展开全文 ({displayContent.length}字)
                      </>
                    )}
                  </Button>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="min-h-[200px] flex items-center justify-center text-sm text-muted-foreground">
            <div className="animate-pulse">等待生成...</div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
