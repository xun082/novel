"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { setLaunchPrompt } from "@/lib/novel-data";

interface PromptPreset {
  label: string;
  tagline: string;
  prompt: string;
  accent: string;
}

const PROMPT_PRESETS: PromptPreset[] = [
  {
    label: "玄幻修仙",
    tagline: "升级流 · 宗门秘境",
    prompt: "玄幻修仙，升级流，主角资质平平却另辟蹊径，含宗门、秘境、古神血脉。",
    accent: "from-sky-500/90 to-cyan-500/90",
  },
  {
    label: "都市职场",
    tagline: "商战 · 逆袭",
    prompt: "都市现代，职场商战，主角从底层实习生起步，步步为营直面家族企业博弈。",
    accent: "from-emerald-500/90 to-teal-500/90",
  },
  {
    label: "末世生存",
    tagline: "丧尸 · 硬核",
    prompt: "末世丧尸题材，资源稀缺、人性博弈，主角带领小队穿越废土寻找避难所。",
    accent: "from-rose-500/90 to-orange-500/90",
  },
  {
    label: "硬核科幻",
    tagline: "星海 · 指挥官",
    prompt: "硬科幻，星际舰队指挥官视角，跨星系战争，含外星文明与高维武器设定。",
    accent: "from-indigo-500/90 to-purple-500/90",
  },
  {
    label: "悬疑推理",
    tagline: "连环案 · 烧脑反转",
    prompt: "现代悬疑推理，连环凶杀案，主角是天才犯罪心理学家，双线叙事层层反转。",
    accent: "from-slate-600/90 to-zinc-600/90",
  },
  {
    label: "古代权谋",
    tagline: "朝堂 · 党争",
    prompt: "古代宫廷权谋，寒门状元入局朝堂，党争、夺嫡、边疆战事交织推进。",
    accent: "from-amber-500/90 to-yellow-600/90",
  },
  {
    label: "仙侠武侠",
    tagline: "江湖 · 血海深仇",
    prompt: "传统仙侠武侠，江湖恩怨，主角背负灭门之仇，拜师习武逐步揭开身世谜团。",
    accent: "from-fuchsia-500/90 to-pink-500/90",
  },
  {
    label: "异世冒险",
    tagline: "穿越 · 魔法职业",
    prompt: "异世界穿越，奇幻大陆含职业与魔法系统，主角组队探索迷宫秘境并揭露神祇阴谋。",
    accent: "from-lime-500/90 to-green-600/90",
  },
];

export default function HomePage() {
  const router = useRouter();
  const [novelInput, setNovelInput] = useState("玄幻，升级流，主角成长线清晰，含宗门与秘境线。");
  const [navigating, setNavigating] = useState(false);

  const openOutlinesWorkspace = (promptOverride?: string) => {
    if (navigating) return;
    const promptText = (promptOverride ?? novelInput).trim();
    if (!promptText) return;

    setNavigating(true);
    setLaunchPrompt(promptText);
    router.push("/outlines");
  };

  return (
    <div className="min-h-screen w-screen overflow-x-hidden bg-[radial-gradient(circle_at_10%_20%,rgba(56,189,248,0.14),transparent_45%),radial-gradient(circle_at_90%_10%,rgba(236,72,153,0.12),transparent_45%),linear-gradient(180deg,#020617,#030712_48%,#0b1120)]">
      <main className="flex min-h-[calc(100vh-76px)] w-full items-center justify-center px-4 pb-16">
        <div className="w-full max-w-3xl">
          <div className="mb-6 text-center">
            <h1 className="text-3xl font-semibold tracking-tight text-foreground">
              选一种风格，开始写你的小说
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              首页只用于输入题材；进入大纲工作台后才会开始并发生成与续写。
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {PROMPT_PRESETS.map((preset) => (
              <button
                key={preset.label}
                type="button"
                onClick={() => openOutlinesWorkspace(preset.prompt)}
                className="group relative overflow-hidden rounded-xl border border-border/70 bg-card/80 p-4 text-left shadow-sm backdrop-blur-sm transition-all hover:-translate-y-0.5 hover:shadow-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
              >
                <div
                  className={`absolute inset-x-0 top-0 h-1 bg-linear-to-r ${preset.accent}`}
                  aria-hidden
                />
                <div className="flex items-center justify-between">
                  <span className="text-base font-semibold text-foreground">{preset.label}</span>
                  <Sparkles className="h-3.5 w-3.5 text-muted-foreground transition-colors group-hover:text-primary" />
                </div>
                <p className="mt-0.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/80">
                  {preset.tagline}
                </p>
                <p className="mt-2 line-clamp-3 text-xs leading-5 text-muted-foreground">
                  {preset.prompt}
                </p>
              </button>
            ))}
          </div>
        </div>
      </main>

      <div className="pointer-events-none fixed bottom-2 left-1/2 z-30 w-[min(720px,calc(100vw-24px))] -translate-x-1/2">
        <div className="pointer-events-auto rounded-xl border border-border/70 bg-card/85 px-2 py-1.5 shadow-[0_14px_45px_-24px_rgba(2,6,23,0.95)] backdrop-blur-xl">
          <div className="flex items-center gap-1.5">
            <Textarea
              value={novelInput}
              onChange={(e) => setNovelInput(e.target.value)}
              placeholder="题材、世界观、主角设定..."
              rows={1}
              className="min-h-[32px] max-h-[72px] flex-1 resize-none overflow-y-auto rounded-md border border-border/60 bg-background/80 px-2 py-1 text-xs leading-5 shadow-none focus-visible:ring-0"
            />
            <Button
              onClick={() => openOutlinesWorkspace()}
              disabled={navigating || !novelInput.trim()}
              className="h-7 rounded-full px-3 text-xs"
            >
              <Sparkles className="mr-1 h-3.5 w-3.5" />
              {navigating ? "进入中" : "进入大纲工作台"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
