#!/usr/bin/env node
/**
 * 专测「长 input prompt」对 /big_batch/completions 的影响。
 * 每条 prompt 塞一个可调长度的"假 summary"，模拟真实章节请求里会把
 * novelContext.summary 反复拼接的场景。
 *
 * 用法：
 *   node scripts/test-big-input.mjs
 *   N=120 SUMMARY_LEN=300 MAX_TOKENS=1000 node scripts/test-big-input.mjs
 *   N=120 SUMMARY_LEN=1500 MAX_TOKENS=1000 node scripts/test-big-input.mjs
 */

const UPSTREAM =
  process.env.UPSTREAM || "http://154.37.222.49:8193/big_batch/completions";
const PASSWORD = process.env.PASSWORD || "rwkv-7b13b-fyrik-13b";
const N = Number(process.env.N || 120);
const MAX_TOKENS = Number(process.env.MAX_TOKENS || 1000);
const SUMMARY_LEN = Number(process.env.SUMMARY_LEN || 300);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 6 * 60 * 1000);

const FILLER =
  "这是一个宏大的故事背景，主角从废柴逆袭，经过无数磨难逐渐崛起，" +
  "对抗邪恶势力，最终守护一方苍生。世界观设定包含宗门、秘境、灵脉、" +
  "古神遗迹，修炼体系分为炼气、筑基、金丹、元婴、化神、合体、大乘等境界。";
function makeSummary(len) {
  let s = "";
  while (s.length < len) s += FILLER;
  return s.slice(0, len);
}
const FAKE_SUMMARY = makeSummary(SUMMARY_LEN);

function buildPrompt(i) {
  return (
    `User: 写小说章节正文，严格按照章节梗概展开剧情。\n\n` +
    `【小说背景】\n标题：灵陨纪元\n整体梗概：${FAKE_SUMMARY}\n\n` +
    `【当前章节】\n章节：第 ${i + 1} 章（第 ${i + 1}/${N} 章）\n` +
    `本章梗概：主角偶得神秘灵石，觉醒体内异血，开启修炼之路。\n\n` +
    `【写作任务】\n600-800 字，有对话、动作、环境描写\n\n` +
    `【输出格式】\n{"content": "章节正文内容"}\n\n` +
    `Assistant: \`\`\`json\n`
  );
}
const contents = Array.from({ length: N }, (_, i) => buildPrompt(i));

const charStats = (() => {
  let min = Infinity,
    max = 0,
    sum = 0;
  for (const c of contents) {
    if (c.length < min) min = c.length;
    if (c.length > max) max = c.length;
    sum += c.length;
  }
  return {
    min,
    max,
    avg: Math.round(sum / contents.length),
    total: sum,
  };
})();

const body = JSON.stringify({
  contents,
  max_tokens: MAX_TOKENS,
  stop_tokens: [0],
  temperature: 0.9,
  chunk_size: 8,
  stream: true,
  password: PASSWORD,
});

console.log(
  `[test] N=${N} MAX_TOKENS=${MAX_TOKENS} SUMMARY_LEN=${SUMMARY_LEN}`,
);
console.log(
  `[test] prompt_chars min/avg/max=${charStats.min}/${charStats.avg}/${charStats.max} total_input=${charStats.total} body_bytes=${body.length}`,
);

const start = Date.now();
const ac = new AbortController();
const timer = setTimeout(() => {
  console.error("[test] TIMEOUT");
  ac.abort();
}, TIMEOUT_MS);

try {
  const res = await fetch(UPSTREAM, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    signal: ac.signal,
  });
  const headers = {};
  res.headers.forEach((v, k) => (headers[k] = v));
  console.log(
    `[test] status=${res.status} t=${Date.now() - start}ms headers=${JSON.stringify(headers)}`,
  );
  if (!res.ok || !res.body) {
    console.error("[test] body:", (await res.text()).slice(0, 500));
    process.exit(1);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let chunks = 0,
    bytes = 0,
    idxSeen = new Set(),
    firstAt = null;
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (firstAt === null) firstAt = Date.now() - start;
    chunks++;
    bytes += value.length;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() || "";
    for (const l of lines) {
      const t = l.trim();
      if (!t.startsWith("data:")) continue;
      const d = t.slice(5).trim();
      if (d === "[DONE]") continue;
      try {
        const p = JSON.parse(d);
        if (Array.isArray(p.choices))
          for (const c of p.choices) idxSeen.add(c.index ?? 0);
      } catch {}
    }
  }
  const ms = Date.now() - start;
  console.log(
    `[test] DONE chunks=${chunks} bytes=${bytes} total=${(ms / 1000).toFixed(
      1,
    )}s first_byte=${firstAt}ms indices=${idxSeen.size}/${N}`,
  );
} catch (e) {
  console.error("[test] ERR", e);
} finally {
  clearTimeout(timer);
}
