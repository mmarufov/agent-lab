import { recordIdSchema } from "@agent-lab/contracts";
import { requireLocalPage, webStore } from "@/lib/server/data";
import { RunsList } from "@/components/runs/runs-list";
export const dynamic = "force-dynamic";
export default async function Runs({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireLocalPage();
  const query = await searchParams;
  const deploymentId =
    typeof query.deployment === "string" &&
    ["A", "B", "C"].includes(query.deployment)
      ? query.deployment
      : undefined;
  const status =
    typeof query.status === "string" &&
    ["running", "completed", "failed", "cancelled"].includes(query.status)
      ? query.status
      : undefined;
  const cursor =
    typeof query.cursor === "string" &&
    recordIdSchema.safeParse(query.cursor).success
      ? query.cursor
      : undefined;
  const data = await webStore().list({ deploymentId, status, cursor });
  return (
    <RunsList
      initial={data}
      deployment={deploymentId ?? "all"}
      status={status ?? "all"}
    />
  );
}
