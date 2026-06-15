/**
 * 从模型 rawText 中提取 ```json 块内容；若不存在 fence 直接返回原文。
 */
export function extractJsonText(rawText: string): string {
  if (!rawText) return "";
  let text = rawText.replace(/<think>[\s\S]*?<\/think>/gi, "");

  const fenceMatch = text.match(/```json\s*([\s\S]*?)(?:```|$)/i);
  if (fenceMatch) {
    return fenceMatch[1].trim();
  }
  const closing = text.indexOf("```");
  if (closing !== -1) {
    text = text.slice(0, closing);
  }
  return text.trim();
}

/**
 * 找到从 openIdx 处 `{` 配对的 `}` 索引，找不到则返回 -1。
 * 字符串内 `{}` 不计入深度。
 */
function findBalanced(text: string, openIdx: number): number {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (c === "\\") escape = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

export interface ParsedJsonResult<T = unknown> {
  parsed: T | null;
  rawText: string;
  jsonText: string;
  error?: string;
}

export function parseJsonFromRaw<T = unknown>(
  rawText: string,
): ParsedJsonResult<T> {
  const jsonText = extractJsonText(rawText);
  if (!jsonText) {
    return {
      parsed: null,
      rawText,
      jsonText,
      error: "empty_json_text",
    };
  }

  try {
    return { parsed: JSON.parse(jsonText) as T, rawText, jsonText };
  } catch {
    // 尝试截取第一个平衡的 JSON 对象后再 parse
    const open = jsonText.indexOf("{");
    if (open !== -1) {
      const end = findBalanced(jsonText, open);
      if (end !== -1) {
        const slice = jsonText.slice(open, end + 1);
        try {
          return { parsed: JSON.parse(slice) as T, rawText, jsonText: slice };
        } catch (innerErr) {
          return {
            parsed: null,
            rawText,
            jsonText: slice,
            error: (innerErr as Error).message,
          };
        }
      }
    }
    return {
      parsed: null,
      rawText,
      jsonText,
      error: "json_parse_failed",
    };
  }
}
