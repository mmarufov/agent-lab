import { recordIdSchema } from "@agent-lab/contracts";
import { UnsupportedRunSourceError } from "@agent-lab/lab/runs";
import Link from "next/link";
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
    if (error instanceof UnsupportedRunSourceError)
      return (
        <main id="main" className="service-error">
          <p className="eyebrow">NOT SHOWN HERE</p>
          <h1>Recorded Daily investigation.</h1>
          <p>{error.message}</p>
          <Link href="/runs" className="text-link">
            Back to investigations
          </Link>
        </main>
      );
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
