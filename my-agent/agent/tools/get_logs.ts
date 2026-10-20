import { defineTool } from "eve/tools";
import { getLogsInputSchema, getLogsOutputSchema } from "@agent-lab/contracts";
import { getLogs } from "../lib/get-logs";

export default defineTool({
  description: "Read all saved logs for a simulated deployment in the configured Agent Lab trial. Returns info, warn, and error records in their recorded order.",
  inputSchema: getLogsInputSchema,
  outputSchema: getLogsOutputSchema,
  async execute(input) {
    // The model chooses only the deployment ID. Credentials come from the
    // runtime, not from model arguments or generated code.
    const baseUrl = process.env.LAB_BASE_URL;
    const trialToken = process.env.LAB_TRIAL_TOKEN;
    if (!baseUrl || !trialToken) {
      throw new Error("Configure LAB_BASE_URL and LAB_TRIAL_TOKEN before running get_logs.");
    }
    return { logs: await getLogs(input, { baseUrl, trialToken }) };
  },
});
