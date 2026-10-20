import { readFile, readdir } from "node:fs/promises";
import type { Pool } from "pg";
import { transaction } from "./database";

export async function migrate(pool: Pool) {
  const directory = new URL("../migrations/", import.meta.url);
  const files = (await readdir(directory))
    .filter((name) => /^\d+_[a-z0-9_]+\.sql$/.test(name))
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  const migrations = await Promise.all(files.map(async (file) => ({
    version: file.slice(0, -4),
    sql: await readFile(new URL(file, directory), "utf8"),
  })));
  await transaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(713906421)");
    await client.query("CREATE TABLE IF NOT EXISTS lab_migrations (version text PRIMARY KEY)");
    const applied = await client.query<{ version: string }>("SELECT version FROM lab_migrations");
    const versions = new Set(applied.rows.map((row) => row.version));
    for (const { version, sql } of migrations) {
      if (versions.has(version)) continue;
      await client.query(sql);
      await client.query("INSERT INTO lab_migrations (version) VALUES ($1)", [version]);
    }
  });
}
