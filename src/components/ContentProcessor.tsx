/**
 * 内容处理工具
 * 处理模型输出中的深度思考标签
 */

export interface ProcessedContent {
  thinking: string;
  content: string;
  cleanContent: string;
}

/**
 * 处理内容：移除深度思考部分和无关文本，保留真实内容
 */
export function processContent(rawContent: string): ProcessedContent {
  if (!rawContent) {
    return { thinking: '', content: '', cleanContent: '' };
  }
  
  // 匹配 <think>...</think> 标签（支持多种格式）
  const thinkRegex = /<think>([\s\S]*?)<\/think>/gi;
  
  // 提取深度思考内容
  const thinkingMatches = rawContent.match(thinkRegex);
  const thinking = thinkingMatches 
    ? thinkingMatches.map(match => match.replace(/<\/?think>/gi, '')).join('\n\n')
    : '';
  
  // 移除深度思考部分
  let cleanContent = rawContent.replace(thinkRegex, '').trim();
  
  // 移除可能残留的标签
  cleanContent = cleanContent.replace(/^<\/think>\s*/gi, '').trim();
  cleanContent = cleanContent.replace(/^<think>\s*/gi, '').trim();
  
  // 移除常见的客套话和无关内容
  const unwantedPatterns = [
    /^好的[，,]\s*/gi,
    /^好[，,]\s*/gi,
    /^明白了[，,]\s*/gi,
    /^收到[，,]\s*/gi,
    /^了解[，,]\s*/gi,
    /^请看[这份]?为[您你][精心打磨的]*[的]?/gi,
    /^这[是就]为[您你][精心打磨的]*[的]?/gi,
    /^以下是/gi,
    /^---+\s*/gm,  // 分隔符
    /^={3,}\s*/gm,  // === 分隔符
    /^\*{3,}\s*/gm,  // *** 分隔符
  ];
  
  unwantedPatterns.forEach(pattern => {
    cleanContent = cleanContent.replace(pattern, '');
  });
  
  // 移除开头的空行
  cleanContent = cleanContent.replace(/^\s+/, '');
  
  // 如果有深度思考内容，记录日志
  if (thinking) {
    console.log(`[内容处理] 发现深度思考内容 ${thinking.length} 字，清理后内容 ${cleanContent.length} 字`);
  }
  
  return {
    thinking,
    content: rawContent,
    cleanContent
  };
}
