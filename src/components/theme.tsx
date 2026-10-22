"use client";
import { ThemeProvider, useTheme } from "next-themes";
import { Sun, Moon } from "lucide-react";
import { Button } from "@/components/ui/button";
export function Theme({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="light"
      enableSystem={false}
      disableTransitionOnChange
    >
      {children}
    </ThemeProvider>
  );
}
export function ThemeSwitch() {
  const { setTheme } = useTheme();
  return (
    <>
      <Button
        className="dark:hidden"
        variant="ghost"
        size="icon"
        aria-label="Switch to dark theme"
        onClick={() => setTheme("dark")}
      >
        <Moon />
      </Button>
      <Button
        className="hidden dark:inline-flex"
        variant="ghost"
        size="icon"
        aria-label="Switch to light theme"
        onClick={() => setTheme("light")}
      >
        <Sun />
      </Button>
    </>
  );
}
