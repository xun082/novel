/**
 * 公共 no-cache 响应头：用于所有需要禁用 CDN / 浏览器缓存的接口
 * （流式 SSE、上游 RWKV 透传、任务进度推送等）。
 *
 * 注意：此处不带 Content-Type；调用方按需追加（JSON / SSE / text-stream）。
 */
export const NO_CACHE_HEADERS = {
  "Cache-Control": "no-store, no-cache, must-revalidate, private, max-age=0",
  Pragma: "no-cache",
  Expires: "0",
  "X-Accel-Buffering": "no",
} as const;
