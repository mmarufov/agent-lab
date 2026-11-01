import { readFile } from "node:fs/promises";
import type { LabToolMode } from "../agent/lib/tool-mode";

// The file agent/instructions/investigator.ts gives the model in each mode.
// Runners save this text with every run; a runtime test checks that it is
// exactly what the model receives.
const files: Record<LabToolMode, string> = { simulated: "simulated.md", daily_capture: "daily-capture.md" };

export function investigatorInstructions(mode: LabToolMode) {
  return readFile(new URL(`../prompts/${files[mode]}`, import.meta.url), "utf8");
}
