# Novel - 并行小说生成工作台

一个基于 Next.js + RWKV 的 AI 小说创作应用，主打「大纲到正文」的两轮并发生成体验：  
第一轮快速产出多份完整大纲，第二轮对全部章节进行流式续写或扩写，适合用来快速探索创意方向并落地成长文内容。

## 项目亮点

- **双轮并发生成**：先并发生成 10 份大纲，再并发处理所有章节正文。
- **流式实时反馈**：前端边生成边展示，能看到章节逐步成文。
- **一键扩写全书**：已有正文后可直接进入“扩写全部”，统一提升篇幅和细节。
- **多风格预设 + 自定义提示词**：内置玄幻、职场、悬疑、科幻等预设，支持自定义世界观与主线设定。
- **容量与稳定性保护**：针对上游 `big_batch` 接口做了 `contents.length` 和 token 预算保护，减少空响应与截断。

## 工作流（当前实现）

1. **输入创作需求**  
   选择风格预设，或手动输入题材、世界观、主角设定等提示词。

2. **第一轮：生成大纲**  
   一次并发生成 10 份小说方案；每份方案包含标题、摘要和章节梗概（默认 8 章）。

3. **挑选方案并查看章节**  
   可打开任一大纲查看章节列表，也可切换到“大纲总览”快速比对结构。

4. **第二轮：续写或扩写全部章节**  
   系统将所有章节任务打平后并发提交，流式回填内容，最终得到可阅读的完整章节正文。

## 技术栈

- **前端**：Next.js 16、React 19、TypeScript、Tailwind CSS 4、shadcn/ui
- **服务端**：Next.js Route Handlers（`/api/outlines`、`/api/chapters`、`/api/expand`）
- **模型接入**：RWKV 上游 `big_batch/completions` 流式代理

## 本地运行

```bash
pnpm install
pnpm dev
```

项目默认运行在 [http://localhost:3001](http://localhost:3001)。

## 目录说明（核心）

- `src/app/page.tsx`：主界面与两轮生成流程编排
- `src/app/api/_lib/rwkv.ts`：上游请求、流式透传、token/并发预算控制
- `src/app/api/outlines/route.ts`：大纲生成接口
- `src/app/api/chapters/route.ts`：章节正文续写接口
- `src/app/api/expand/route.ts`：章节扩写接口
- `src/services/index.ts`：前端请求封装

## 项目截图

> 下图为当前项目界面截图（多卡片并行大纲视图）：

![20260427192647](https://raw.githubusercontent.com/xun082/md/main/blogs.images20260427192647.png)