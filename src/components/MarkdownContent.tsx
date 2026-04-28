import type { ReactNode } from "react";

/**
 * Markdown 内容渲染组件
 * 支持基本的 markdown 格式
 */

interface MarkdownContentProps {
  content: string;
}

// 解析内联格式（加粗、斜体）
function parseInlineFormats(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let currentIndex = 0;
  let keyCounter = 0;

  // 匹配加粗 **text** 和斜体 *text*
  const regex = /(\*\*(.+?)\*\*|\*(.+?)\*)/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    // 添加前面的普通文本
    if (match.index > currentIndex) {
      parts.push(text.substring(currentIndex, match.index));
    }

    // 判断是加粗还是斜体
    if (match[0].startsWith('**')) {
      // 加粗
      parts.push(
        <strong key={`bold-${keyCounter++}`} className="font-semibold">
          {match[2]}
        </strong>
      );
    } else {
      // 斜体
      parts.push(
        <em key={`italic-${keyCounter++}`} className="italic">
          {match[3]}
        </em>
      );
    }

    currentIndex = match.index + match[0].length;
  }

  // 添加剩余的文本
  if (currentIndex < text.length) {
    parts.push(text.substring(currentIndex));
  }

  return parts.length > 0 ? parts : [text];
}

export function MarkdownContent({ content }: MarkdownContentProps) {
  if (!content) return null;

  // 解析 markdown 内容
  const lines = content.split('\n');
  const elements: ReactNode[] = [];
  let listItems: ReactNode[] = [];
  let listType: 'ul' | 'ol' | null = null;

  const flushList = (index: number) => {
    if (listItems.length > 0 && listType) {
      const ListTag = listType;
      elements.push(
        <ListTag key={`list-${index}`} className="ml-6 mb-4 space-y-2">
          {listItems}
        </ListTag>
      );
      listItems = [];
      listType = null;
    }
  };

  lines.forEach((line, index) => {
    const trimmedLine = line.trim();

    // 标题
    if (trimmedLine.startsWith('### ')) {
      flushList(index);
      const text = trimmedLine.substring(4);
      elements.push(
        <h3 key={index} className="text-lg font-semibold mt-6 mb-3">
          {parseInlineFormats(text)}
        </h3>
      );
    } else if (trimmedLine.startsWith('## ')) {
      flushList(index);
      const text = trimmedLine.substring(3);
      elements.push(
        <h2 key={index} className="text-xl font-semibold mt-6 mb-3 border-b pb-2">
          {parseInlineFormats(text)}
        </h2>
      );
    } else if (trimmedLine.startsWith('# ')) {
      flushList(index);
      const text = trimmedLine.substring(2);
      elements.push(
        <h1 key={index} className="text-2xl font-bold mt-6 mb-4 border-b-2 pb-2">
          {parseInlineFormats(text)}
        </h1>
      );
    }
    // 无序列表
    else if (trimmedLine.startsWith('* ') || trimmedLine.startsWith('- ')) {
      if (listType !== 'ul') {
        flushList(index);
        listType = 'ul';
      }
      const text = trimmedLine.substring(2);
      listItems.push(
        <li key={index} className="text-sm">
          {parseInlineFormats(text)}
        </li>
      );
    }
    // 有序列表
    else if (/^\d+\.\s/.test(trimmedLine)) {
      if (listType !== 'ol') {
        flushList(index);
        listType = 'ol';
      }
      const text = trimmedLine.replace(/^\d+\.\s/, '');
      listItems.push(
        <li key={index} className="text-sm">
          {parseInlineFormats(text)}
        </li>
      );
    }
    // 空行
    else if (!trimmedLine) {
      flushList(index);
      elements.push(<div key={index} className="h-3" />);
    }
    // 普通段落
    else {
      flushList(index);
      elements.push(
        <p key={index} className="mb-3 leading-relaxed">
          {parseInlineFormats(trimmedLine)}
        </p>
      );
    }
  });

  // 清理剩余的列表
  flushList(lines.length);

  return <div className="prose prose-sm dark:prose-invert max-w-none">{elements}</div>;
}
