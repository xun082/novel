"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

const DEFAULT_PROMPT =
  "主角出身普通被轻视，意外觉醒独特能力后一路成长逆袭；开场有冲突，3场内有反转，结尾留悬念，价值观正向。";

interface PromptStoreValue {
  novelInput: string;
  setNovelInput: (value: string) => void;
  selectedPresetLabel: string | null;
  selectPreset: (preset: { label: string; prompt: string }) => void;
}

const Ctx = createContext<PromptStoreValue | null>(null);

// 单实例的预设/草稿 store。在 RootLayout 挂一次，两个页面共用同一份 state，
// 这样 /outlines 不会因为重挂载而把 textarea 闪回默认值，也不再需要靠 URL ?seed= 传递选择。
export function PromptStoreProvider({ children }: { children: ReactNode }) {
  const [novelInput, setNovelInputState] = useState(DEFAULT_PROMPT);
  const [selectedPresetLabel, setSelectedPresetLabel] = useState<string | null>(null);

  const setNovelInput = useCallback((value: string) => {
    setNovelInputState(value);
    // 用户手动编辑后立即解除高亮，避免和卡片显示状态对不上。
    setSelectedPresetLabel((label) => (label == null ? label : null));
  }, []);

  const selectPreset = useCallback(
    (preset: { label: string; prompt: string }) => {
      setNovelInputState(preset.prompt);
      setSelectedPresetLabel(preset.label);
    },
    [],
  );

  const value = useMemo<PromptStoreValue>(
    () => ({ novelInput, setNovelInput, selectedPresetLabel, selectPreset }),
    [novelInput, setNovelInput, selectedPresetLabel, selectPreset],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function usePromptStore(): PromptStoreValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("usePromptStore must be used inside <PromptStoreProvider>");
  return v;
}
