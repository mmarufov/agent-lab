import type { Metadata } from "next";
import "./globals.css";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { Theme } from "@/components/theme";
import { Shell } from "@/components/shell";

export const metadata: Metadata = {
  title: "Agent Lab",
  description: "A workbench for testing operational AI agents.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${GeistSans.variable} ${GeistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <Theme>
          <Shell>{children}</Shell>
        </Theme>
      </body>
    </html>
  );
}
