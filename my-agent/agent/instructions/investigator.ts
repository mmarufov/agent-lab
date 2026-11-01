import { defineDynamic, defineInstructions } from "eve/instructions";
import dailyCapture from "../../prompts/daily-capture.md?raw";
import simulated from "../../prompts/simulated.md?raw";
import { labToolMode } from "../lib/tool-mode";

// System instructions for the evidence source LAB_TOOL_MODE selects, chosen
// like the tools when a session starts. The runner saves the same file's text
// (client/instructions.ts) with each run.
export default defineDynamic({
  events: {
    "session.started": () => defineInstructions({ content: labToolMode() === "daily_capture" ? dailyCapture : simulated }),
  },
});
