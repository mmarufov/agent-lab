import "server-only";
import { headers } from "next/headers";
import { createPool } from "@agent-lab/lab/database";
import { createWebStore } from "@agent-lab/lab/web";
const state = globalThis as typeof globalThis & {
  webPool?: ReturnType<typeof createPool>;
};
export const pool = () => (state.webPool ??= createPool());
export const webStore = () => createWebStore(pool());
export function localHost(host: string | null) {
  if (!host) return false;
  try {
    return ["127.0.0.1", "localhost", "[::1]"].includes(
      new URL(`http://${host}`).hostname,
    );
  } catch {
    return false;
  }
}
export async function requireLocalPage() {
  if (process.env.VERCEL || !localHost((await headers()).get("host")))
    throw new Error("This workbench is available only on the local machine.");
}
