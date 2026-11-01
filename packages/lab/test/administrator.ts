import type { Pool } from "pg";

/**
 * Runs `change` with one table's own triggers disabled, as a database
 * administrator could. Migration 010 protects ordinary writes only; tests use
 * this to show that verification still detects such a change afterward.
 */
export async function bypassingTriggers<T>(pool: Pool, table: string, change: () => Promise<T>) {
  await pool.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
  try {
    return await change();
  } finally {
    await pool.query(`ALTER TABLE ${table} ENABLE TRIGGER USER`);
  }
}
