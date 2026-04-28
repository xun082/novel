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
    label: "寒门医女",
    tagline: "出身卑微 · 医术觉醒",
    prompt: "女主出身寒门药铺学徒，长期被轻视，意外觉醒古医传承后在救人中成长逆袭；每2-3场出现一次局势反转，突出仁心与责任。",
    accent: "from-sky-500/90 to-cyan-500/90",
  },
  {
    label: "底层店员",
    tagline: "小人物 · 商业天赋觉醒",
    prompt: "主角是普通商场店员，屡遭压制，意外激活超强经营洞察力后带队逆袭；反转围绕职场公平与团队成长展开，节奏紧凑。",
    accent: "from-emerald-500/90 to-teal-500/90",
  },
  {
    label: "草根觉醒",
    tagline: "出身低微 · 能力觉醒",
    prompt: "主角出身普通、长期被轻视，意外觉醒稀有能力后在规则中成长逆袭；能力越强责任越大，要求每2-3场出现一次局势反转，突出努力、守护与自我成长。",
    accent: "from-rose-500/90 to-orange-500/90",
  },
  {
    label: "街头少年",
    tagline: "被看不起 · 战术觉醒",
    prompt: "主角来自普通街区，因一次意外觉醒战术预判能力，从替补一路成长为核心；每集有挑战与反转，强调奋斗与团队协作。",
    accent: "from-indigo-500/90 to-purple-500/90",
  },
  {
    label: "外卖骑手",
    tagline: "平凡生活 · 感知觉醒",
    prompt: "主角是城市外卖骑手，偶然获得短时风险感知能力，在一次次危机中守护他人并提升自己；反转密集但导向温暖正向。",
    accent: "from-slate-600/90 to-zinc-600/90",
  },
  {
    label: "工地学徒",
    tagline: "基层起步 · 技能开挂",
    prompt: "主角从工地学徒做起，被各方质疑，后觉醒工程推演天赋并解决连环难题；每2-3场有一次能力兑现，突出实干与担当。",
    accent: "from-amber-500/90 to-yellow-600/90",
  },
  {
    label: "边城庶子",
    tagline: "出身普通 · 谋略觉醒",
    prompt: "古装短剧，边城小吏之子长期被忽视，意外觉醒谋略天赋后在家国危机中崭露头角；反转围绕守城、护民与成长推进。",
    accent: "from-fuchsia-500/90 to-pink-500/90",
  },
  {
    label: "乡镇教师",
    tagline: "默默无闻 · 教学天赋觉醒",
    prompt: "主角是乡镇新教师，资源匮乏且不被看好，觉醒因材施教能力后带学生逆风成长；每集结尾留希望型悬念，持续吸引追更。",
    accent: "from-lime-500/90 to-green-600/90",
  },
];

export default function HomePage() {
  const router = useRouter();
  const [novelInput, setNovelInput] = useState("主角出身普通被轻视，意外觉醒独特能力后一路成长逆袭；开场有冲突，3场内有反转，结尾留悬念，价值观正向。");
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
              选一个爆点，直接开写短剧
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              首页先定题材和钩子；进大纲工作台后再并发生成剧情与续写。
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
