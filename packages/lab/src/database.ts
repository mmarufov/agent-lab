import { Pool, type PoolClient } from "pg";

export function createPool(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) {
    throw new Error("DATABASE_URL is required. Copy .env.example to .env.local first.");
  }
  return new Pool({ connectionString, max: 5, connectionTimeoutMillis: 5_000 });
}

export async function transaction<T>(pool: Pool, run: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    // Preserve the original error if the connection was lost during COMMIT.
    // Do not automatically replay a possibly committed operation.
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
