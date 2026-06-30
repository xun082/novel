import * as fs from "node:fs";
import * as path from "node:path";
import type { RwkvCallKind } from "./rwkv-config";

/**
 * 调试 dump：每次上游请求把原始 SSE 流落盘到 `<repo>/.rwkv-dumps/`。
 *
 * - 设置 `RWKV_DUMP_DISABLED=1` 可完全关闭（影响为 0：不开文件、不写盘）。
 * - 每次请求生成两份文件：`*.raw.txt`（原始字节流）与 `*.meta.json`（请求/结束元数据）。
 */
const DUMP_ENABLED = process.env.RWKV_DUMP_DISABLED !== "1";
const DUMP_DIR = path.join(process.cwd(), ".rwkv-dumps");

export interface DumpHandle {
  kind: RwkvCallKind;
  requestId: string;
  startedAt: number;
  rawPath: string;
  metaPath: string;
  rawStream: fs.WriteStream | null;
  chunks: number;
  bytes: number;
}

export function openDump(
  kind: RwkvCallKind,
  requestId: string,
  startedAt: number,
  meta: Record<string, unknown>,
): DumpHandle {
  const handle: DumpHandle = {
    kind,
    requestId,
    startedAt,
    rawPath: "",
    metaPath: "",
    rawStream: null,
    chunks: 0,
    bytes: 0,
  };
  if (!DUMP_ENABLED) return handle;
  try {
    fs.mkdirSync(DUMP_DIR, { recursive: true });
    const ts = new Date(startedAt)
      .toISOString()
      .replace(/[:.]/g, "-")
      .replace("T", "_")
      .replace("Z", "");
    const base = `${kind}-${ts}-${requestId}`;
    handle.rawPath = path.join(DUMP_DIR, `${base}.raw.txt`);
    handle.metaPath = path.join(DUMP_DIR, `${base}.meta.json`);
    handle.rawStream = fs.createWriteStream(handle.rawPath, { flags: "w" });
    fs.writeFileSync(
      handle.metaPath,
      JSON.stringify({ phase: "start", ...meta }, null, 2),
    );
    console.log(`[rwkv:${requestId}] dump → ${handle.rawPath}`);
  } catch (e) {
    console.error(`[rwkv:${requestId}] dump open failed`, e);
    handle.rawStream = null;
  }
  return handle;
}

export function dumpChunk(handle: DumpHandle, value: Uint8Array): void {
  if (!handle.rawStream) return;
  handle.chunks += 1;
  handle.bytes += value.length;
  try {
    handle.rawStream.write(Buffer.from(value));
  } catch (e) {
    console.error(`[rwkv:${handle.requestId}] dump write failed`, e);
  }
}

export function closeDump(
  handle: DumpHandle,
  finalMeta: Record<string, unknown>,
): void {
  if (!handle.rawStream) return;
  try {
    handle.rawStream.end();
  } catch {
    // ignore
  }
  try {
    fs.writeFileSync(
      handle.metaPath,
      JSON.stringify(
        {
          phase: "end",
          chunks: handle.chunks,
          bytes: handle.bytes,
          durationMs: Date.now() - handle.startedAt,
          ...finalMeta,
        },
        null,
        2,
      ),
    );
  } catch (e) {
    console.error(`[rwkv:${handle.requestId}] dump close failed`, e);
  }
}
