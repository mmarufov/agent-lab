"use client";
import { Button } from "@/components/ui/button";
export default function ErrorPage({ retry }: { retry: () => void }) {
  return (
    <main id="main" className="service-error">
      <p className="eyebrow">CONNECTION INTERRUPTED</p>
      <h1>Saved investigation data could not be loaded.</h1>
      <p>
        Check the local database connection. Saved records have not been
        changed.
      </p>
      <Button onClick={retry}>Try again</Button>
    </main>
  );
}
