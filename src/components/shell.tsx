import Link from "next/link";
import { ScanLine, ArrowUpRight } from "lucide-react";
import { ThemeSwitch } from "./theme";
export function Shell({ children }: { children: React.ReactNode }) {
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="app-header">
        <div className="header-inner">
          <Link href="/runs" className="wordmark">
            <ScanLine size={21} strokeWidth={1.7} aria-hidden="true" />
            Agent Lab
            <span className="wordmark-divider" />
            <span className="workspace-name">Workbench</span>
          </Link>
          <div className="header-actions">
            <span className="local-label">
              <span className="status-dot" />
              Local workspace
            </span>
            <ThemeSwitch />
          </div>
        </div>
      </header>
      <div className="page-wrap">{children}</div>
      <footer className="app-footer">
        <span>
          Agent Lab <span className="footer-separator">/</span> Inspect the
          evidence.
        </span>
        <a
          href="https://github.com/mmarufov/agent-lab"
          target="_blank"
          rel="noreferrer"
        >
          Source <ArrowUpRight size={13} aria-hidden="true" />
        </a>
      </footer>
    </>
  );
}
