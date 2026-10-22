import { Skeleton } from "@/components/ui/skeleton";
export default function Loading() {
  return (
    <main id="main" aria-label="Loading investigations" className="space-y-5">
      <Skeleton className="h-4 w-28" />
      <Skeleton className="h-9 w-64" />
      <Skeleton className="h-4 w-80 max-w-full" />
      <Skeleton className="mt-12 h-64 w-full" />
    </main>
  );
}
