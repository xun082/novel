// In-memory hand-off between the home page and /outlines. We deliberately
// don't use URL params or sessionStorage anymore: in dev, React Strict Mode
// double-mounts /outlines, and a single-use signal (URL/session) gets eaten by
// the first mount, leaving the second mount to redirect back to /.
//
// Two flags here:
//   - pendingLaunch: a one-shot prompt that /outlines should consume and run.
//     Cleared as soon as someone consumes it.
//   - activeGeneration: stays `true` from the moment a launch is consumed until
//     the generation finally settles. When the Strict-Mode re-mount fires its
//     effect, it sees activeGeneration=true and stays on /outlines instead of
//     bouncing back to /.

let pendingLaunch: string | null = null;
let activeGeneration = false;
let generationGeneration = 0;

export function publishLaunch(prompt: string): void {
  pendingLaunch = prompt;
}

export function consumeLaunch(): string | null {
  const next = pendingLaunch;
  if (next == null) return null;
  pendingLaunch = null;
  activeGeneration = true;
  generationGeneration += 1;
  return next;
}

export function isGenerationActive(): boolean {
  return activeGeneration;
}

/** Caller should pass the generation number it received when it started. */
export function getCurrentGenerationToken(): number {
  return generationGeneration;
}

export function markGenerationFinished(token: number): void {
  // Only the call that owns the current generation may clear the flag —
  // otherwise a Strict-Mode-orphaned previous generation could clear a
  // freshly-started one.
  if (token === generationGeneration) {
    activeGeneration = false;
  }
}
