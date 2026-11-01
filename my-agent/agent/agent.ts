import { defineAgent } from "eve";

// One investigator for both evidence sources. LAB_TOOL_MODE, set only by the
// runner that starts Eve, selects its tools (tools/) and instructions
// (instructions/); see lib/tool-mode.ts.
export default defineAgent({
  model: "openai/gpt-6-luna-fast",
  reasoning: "high",
  // Evidence only: none of Eve's optional shell, file, web, or skill tools,
  // and no delegation to a copy of this agent. The files in tools/ are the
  // whole tool set.
  defaultTools: false,
  tool: false,
  // Eve checks these between model calls, so the call that crosses a limit
  // finishes and can exceed it. The runners never approve more.
  limits: {
    maxInputTokensPerSession: 500_000,
    maxOutputTokensPerSession: 20_000,
    maxTokenCostUsdPerSession: 0.1,
  },
});
