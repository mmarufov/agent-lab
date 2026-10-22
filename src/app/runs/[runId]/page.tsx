import { recordIdSchema } from "@agent-lab/contracts";
import { notFound } from "next/navigation";
import { RunDetail } from "@/components/runs/run-detail";
import { requireLocalPage, webStore } from "@/lib/server/data";
import { executionEnabled } from "@/lib/server/http";
export const dynamic = "force-dynamic";
export default async function Run({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  await requireLocalPage();
  const { runId } = await params;
  if (!recordIdSchema.safeParse(runId).success) notFound();
  let data;
  try {
    data = await webStore().get(runId);
  } catch (error) {
    if (error instanceof Error && /not found/i.test(error.message)) notFound();
    throw error;
  }
  return (
    <RunDetail
      initial={data}
      key={runId}
      executionEnabled={executionEnabled()}
    />
  );
}
