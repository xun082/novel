"use client";

import { useState } from "react";
import { Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  clearRwkvClientCredentials,
  readRwkvClientCredentials,
  writeRwkvClientCredentials,
} from "@/lib/storage/rwkv-client-settings";
import { cn } from "@/lib/utils";

export function RwkvProductionUpstreamSettings() {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [password, setPassword] = useState("");

  const openDialog = () => {
    const c = readRwkvClientCredentials();
    setUrl(c.upstreamUrl);
    setPassword(c.password);
    setOpen(true);
  };

  return (
    <>
      <div className="pointer-events-auto fixed right-3 top-3 z-40">
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="size-9 rounded-lg border-border/80 bg-card/90 shadow-md backdrop-blur-sm"
          aria-label="上游设置"
          onClick={() => openDialog()}
        >
          <Settings className="size-4" />
        </Button>
      </div>

      {open ? (
        <div
          className="fixed inset-0 z-100 flex items-center justify-center bg-black/55 p-4 backdrop-blur-[2px]"
          role="presentation"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="rwkv-upstream-title"
            className={cn(
              "w-full max-w-md rounded-xl border border-border/80 bg-card p-5 shadow-2xl",
            )}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <h2 id="rwkv-upstream-title" className="text-lg font-semibold text-foreground">
              上游设置
            </h2>
            <div className="mt-4 space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="rwkv-url" className="text-sm font-medium">
                  RWKV_UPSTREAM_URL
                </Label>
                <Input
                  id="rwkv-url"
                  type="url"
                  autoComplete="off"
                  placeholder="https://…/completions"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  className="font-mono text-xs"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="rwkv-pwd" className="text-sm font-medium">
                  RWKV_UPSTREAM_PASSWORD
                </Label>
                <Input
                  id="rwkv-pwd"
                  type="password"
                  autoComplete="new-password"
                  placeholder="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="font-mono text-xs"
                />
              </div>
            </div>
            <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
                取消
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  clearRwkvClientCredentials();
                  setUrl("");
                  setPassword("");
                  setOpen(false);
                }}
              >
                清除
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  writeRwkvClientCredentials({ upstreamUrl: url, password });
                  setOpen(false);
                }}
              >
                保存
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
