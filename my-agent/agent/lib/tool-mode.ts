export type LabToolMode = "simulated" | "daily_capture";

/**
 * Which evidence tools this Eve process exposes. The trusted runner that
 * starts Eve sets LAB_TOOL_MODE; nothing the model sends can change it. Unset
 * means the simulated deployment tools that existing investigations use.
 */
export function labToolMode(env: NodeJS.ProcessEnv = process.env): LabToolMode {
  const mode = env.LAB_TOOL_MODE || "simulated";
  if (mode === "simulated" || mode === "daily_capture") return mode;
  throw new Error(`LAB_TOOL_MODE must be "simulated" or "daily_capture", not "${mode}".`);
}
