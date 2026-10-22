import Link from "next/link";
export default function NotFound() {
  return (
    <main id="main" className="service-error">
      <p className="eyebrow">NOT FOUND</p>
      <h1>Investigation unavailable.</h1>
      <p>This ID does not match a saved investigation.</p>
      <Link href="/runs" className="text-link">
        Back to investigations
      </Link>
    </main>
  );
}
