#!/usr/bin/env node
/**
 * 直连 rwkv 上游 /big_batch/completions 的压测 / 调试脚本。
 *
 * 用法：
 *   node scripts/test-big-batch.mjs                # 默认 N=135，章节 prompt，max_tokens=7000
 *   N=10 node scripts/test-big-batch.mjs           # 只测 10 个并发
 *   N=135 MAX_TOKENS=1200 node scripts/test-big-batch.mjs
 *   PROMPT=hello node scripts/test-big-batch.mjs   # 用简单 prompt 代替章节 prompt
 *   UPSTREAM=http://154.37.222.49:8193/big_batch/completions node scripts/test-big-batch.mjs
 */

const UPSTREAM =
  process.env.UPSTREAM || "http://154.37.222.49:8193/big_batch/completions";
const PASSWORD = process.env.PASSWORD || "rwkv-7b13b-fyrik-13b";
const N = Number(process.env.N || 135);
// 注意：上游对 N × max_tokens 有一个软上限（实测约 150k-200k），
// 超过会返回 200 + 空 body。默认给 1000，N=150 时总预算 150k 刚好可行。
const MAX_TOKENS = Number(process.env.MAX_TOKENS || 1000);
const TEMPERATURE = Number(process.env.TEMPERATURE || 0.9);
const CHUNK_SIZE = Number(process.env.CHUNK_SIZE || 8);
const REPORT_INTERVAL_MS = Number(process.env.REPORT_INTERVAL_MS || 3000);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 10 * 60 * 1000);
const SIMPLE_PROMPT = process.env.PROMPT;

function buildChapterPrompt(i) {
  return (
    `User: 写小说章节正文，严格按照章节梗概展开剧情。\n\n` +
    `【小说背景】\n标题：灵陨纪元\n整体梗概：少年在灵气复苏时代从废柴逆袭的成长故事\n\n` +
    `【当前章节】\n章节：第 ${i + 1} 章（第 ${i + 1}/${N} 章）\n` +
    `本章梗概：主角偶得神秘灵石，初步觉醒体内异血，开启修炼之路\n\n` +
    `【写作任务】\n1. 600-800 字\n2. 有对话、动作、环境描写\n3. 严格贴合梗概\n\n` +
    `【输出格式】\n{"content": "章节正文内容"}\n\n` +
    `Assistant: \`\`\`json\n`
  );
}

function buildSimplePrompt(i) {
  return `User: ${SIMPLE_PROMPT}（编号 ${i + 1}）\n\nAssistant:`;
}

const buildPrompt = SIMPLE_PROMPT ? buildSimplePrompt : buildChapterPrompt;
const contents = Array.from({ length: N }, (_, i) => buildPrompt(i));

const body = JSON.stringify({
  contents,
  max_tokens: MAX_TOKENS,
  stop_tokens: [0],
  temperature: TEMPERATURE,
  chunk_size: CHUNK_SIZE,
  stream: true,
  password: PASSWORD,
});

function fmtBytes(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(2)}MB`;
}

function stats(arr) {
  if (arr.length === 0) return { min: 0, avg: 0, max: 0 };
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const v of arr) {
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  return { min, avg: Math.round(sum / arr.length), max };
}

async function main() {
  console.log(
    `[test] upstream=${UPSTREAM}\n[test] N=${N} max_tokens=${MAX_TOKENS} body=${fmtBytes(
      body.length,
    )}`,
  );

  const controller = new AbortController();
  const timeoutTimer = setTimeout(() => {
    console.error(`[test] TIMEOUT after ${TIMEOUT_MS}ms, aborting`);
    controller.abort();
  }, TIMEOUT_MS);

  const start = Date.now();

  let res;
  try {
    res = await fetch(UPSTREAM, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
      body,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeoutTimer);
    console.error(`[test] fetch failed after ${Date.now() - start}ms`, err);
    process.exit(1);
  }

  console.log(
    `[test] status=${res.status} ctype=${res.headers.get("content-type")} t=${Date.now() - start}ms`,
  );

  if (!res.ok) {
    const text = await res.text();
    console.error(`[test] upstream error body: ${text.slice(0, 1000)}`);
    clearTimeout(timeoutTimer);
    process.exit(1);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const acc = new Map(); // index -> string
  const finished = new Set(); // index that received finish_reason
  const firstByteAtIdx = new Map(); // index -> ms

  let buf = "";
  let chunks = 0;
  let bytes = 0;
  let firstByteAt = null;
  let lastReport = start;

  const reportProgress = () => {
    const now = Date.now();
    const sizes = Array.from(acc.values(), (v) => v.length);
    const s = stats(sizes);
    console.log(
      `[test] t+${((now - start) / 1000).toFixed(1)}s chunks=${chunks} bytes=${fmtBytes(
        bytes,
      )} indices=${acc.size}/${N} finished=${finished.size}/${N} char min/avg/max=${s.min}/${s.avg}/${s.max}`,
    );
    lastReport = now;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (firstByteAt === null) {
        firstByteAt = Date.now() - start;
        console.log(`[test] first byte at ${firstByteAt}ms`);
      }
      chunks++;
      bytes += value.length;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;
        let data = line;
        if (line.startsWith("data:")) {
          data = line.slice(5).trim();
          if (data === "[DONE]") continue;
        } else if (!line.startsWith("{")) {
          continue;
        }
        let payload;
        try {
          payload = JSON.parse(data);
        } catch {
          continue;
        }
        if (!payload || !Array.isArray(payload.choices)) continue;
        for (const choice of payload.choices) {
          const idx = typeof choice.index === "number" ? choice.index : 0;
          const delta = choice.delta?.content || choice.text || "";
          if (!firstByteAtIdx.has(idx) && delta) {
            firstByteAtIdx.set(idx, Date.now() - start);
          }
          if (delta) {
            acc.set(idx, (acc.get(idx) || "") + delta);
          }
          if (choice.finish_reason) {
            finished.add(idx);
          }
        }
      }
      if (Date.now() - lastReport >= REPORT_INTERVAL_MS) {
        reportProgress();
      }
    }
  } catch (err) {
    console.error(`[test] read error after ${Date.now() - start}ms`, err);
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
    clearTimeout(timeoutTimer);
  }

  const totalMs = Date.now() - start;
  reportProgress();
  const firstByteStats = stats(Array.from(firstByteAtIdx.values()));
  console.log(
    `[test] DONE total=${(totalMs / 1000).toFixed(1)}s connection_first_byte=${firstByteAt}ms per_prompt_first_byte min/avg/max=${firstByteStats.min}/${firstByteStats.avg}/${firstByteStats.max}ms`,
  );
  console.log(
    `[test] coverage: indices_seen=${acc.size}/${N} finished=${finished.size}/${N} missing=${N - acc.size}`,
  );

  const sizes = Array.from(acc.values(), (v) => v.length);
  const cs = stats(sizes);
  console.log(`[test] char per prompt min/avg/max=${cs.min}/${cs.avg}/${cs.max}`);

  const missing = [];
  for (let i = 0; i < N; i++) {
    if (!acc.has(i)) missing.push(i);
  }
  if (missing.length > 0) {
    console.log(
      `[test] missing indices (${missing.length}): ${missing.slice(0, 30).join(",")}${missing.length > 30 ? "..." : ""}`,
    );
  }

  console.log("\n[test] sample outputs:");
  for (const idx of [0, Math.floor(N / 2), N - 1]) {
    const text = acc.get(idx) || "(empty)";
    const preview = text.slice(0, 300).replace(/\n/g, "\\n");
    console.log(`  [#${idx}] len=${text.length} finished=${finished.has(idx)}\n    ${preview}`);
  }
}

main().catch((err) => {
  console.error("[test] FATAL", err);
  process.exit(1);
});
