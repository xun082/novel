# 组件结构说明

## 📁 项目结构

```
src/
├── app/
│   └── page.tsx                    # 主页面（简化后 ~330 行）
├── components/
│   ├── ContentProcessor.tsx         # 内容处理工具
│   ├── MarkdownContent.tsx          # Markdown 渲染组件
│   ├── OutlineCard.tsx              # 大纲卡片组件
│   └── ChapterCard.tsx              # 章节卡片组件
└── services/
    └── index.ts                     # API 服务
```

## 🔧 组件功能

### 1. ContentProcessor（内容处理器）

**功能**：
- 移除 `<think>...</think>` 深度思考标签
- 提取深度思考内容
- 返回清理后的内容

**使用**：
```typescript
import { processContent } from "@/components/ContentProcessor";

const { thinking, cleanContent } = processContent(rawContent);
```

### 2. MarkdownContent（Markdown 渲染器）

**功能**：
- 渲染 Markdown 格式内容
- 支持标题（#, ##, ###）
- 支持列表（*, -, 数字）
- 支持加粗、斜体
- 使用 Tailwind CSS 样式

**使用**：
```tsx
<MarkdownContent content={cleanContent} />
```

### 3. OutlineCard（大纲卡片）

**功能**：
- 显示大纲内容
- 自动处理深度思考部分
- 支持折叠显示思考过程
- 点击选择大纲

**Props**：
- `outline`: 大纲数据
- `isGenerating`: 是否正在生成
- `onSelect`: 选择回调

### 4. ChapterCard（章节卡片）

**功能**：
- 显示章节内容
- 自动处理深度思考部分
- 支持扩写选择
- 实时显示字数

**Props**：
- `chapter`: 章节数据
- `isGenerating`: 是否正在生成
- `stage`: 当前阶段
- `isExpanding`: 是否选中扩写
- `onToggleExpand`: 切换扩写回调

## ✨ 主要优化

### 代码优化
- ✅ 主页面从 ~700 行精简到 ~330 行
- ✅ 组件化拆分，职责清晰
- ✅ 类型安全，完整的 TypeScript 支持
- ✅ 代码复用，减少重复

### 渲染优化
- ✅ 使用 Tailwind CSS 替代 styled-jsx
- ✅ Markdown 正确渲染（标题、列表、格式）
- ✅ 深度思考内容折叠显示
- ✅ 响应式设计，移动端友好

### 性能优化
- ✅ 按需加载组件
- ✅ 优化渲染逻辑
- ✅ 减少不必要的重渲染

## 🎯 使用示例

### 主页面使用组件

```tsx
// 大纲展示
<OutlineCard
  outline={outline}
  isGenerating={isGenerating}
  onSelect={selectOutlineAndGenerateChapters}
/>

// 章节展示
<ChapterCard
  chapter={chapter}
  isGenerating={isGenerating}
  stage={stage}
  isExpanding={expandingChapters.has(chapter.id)}
  onToggleExpand={toggleChapterExpand}
/>
```

## 📊 代码统计

| 文件 | 行数 | 说明 |
|------|------|------|
| page.tsx | ~330 | 主页面逻辑 |
| ContentProcessor.tsx | ~40 | 内容处理 |
| MarkdownContent.tsx | ~120 | Markdown 渲染 |
| OutlineCard.tsx | ~80 | 大纲卡片 |
| ChapterCard.tsx | ~90 | 章节卡片 |
| **总计** | **~660** | **比原来减少 ~40 行，但更清晰** |

## 🚀 下一步优化建议

1. 添加单元测试
2. 使用 React.memo 优化性能
3. 添加骨架屏加载状态
4. 支持更多 Markdown 语法
5. 添加内容导出功能
