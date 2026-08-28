/**
 * Minimal structural shape of a Drizzle database handle that can transact.
 * Kept structural rather than importing a concrete driver type, so the helpers
 * work against the Neon client, a test double, or a nested transaction handle.
 */
export interface Transactable<TTx> {
  transaction<T>(fn: (tx: TTx) => Promise<T>): Promise<T>;
}

class Rollback<T> extends Error {
  readonly __adminiglooRollback = true as const;
  constructor(readonly value: T) {
    super("__adminigloo_rollback__");
  }
}

function isRollback<T>(err: unknown): err is Rollback<T> {
  return (
    err instanceof Error &&
    (err as Error & { __adminiglooRollback?: true }).__adminiglooRollback === true
  );
}

/**
 * Run a function inside a transaction that ALWAYS rolls back.
 *
 * The sandbox every integration test runs in: real SQL against a real database,
 * nothing committed. Escaping by throwing is the only way to make Drizzle roll
 * back while still returning a value, so the sentinel error carries the result.
 *
 *   const rows = await withRollback(db, async (tx) => {
 *     await tx.insert(users).values({ ... });
 *     return tx.select().from(users);
 *   });
 */
export async function withRollback<TTx, T>(
  db: Transactable<TTx>,
  fn: (tx: TTx) => Promise<T>,
): Promise<T> {
  try {
    await db.transaction(async (tx) => {
      throw new Rollback(await fn(tx));
    });
  } catch (err) {
    if (isRollback<T>(err)) return err.value;
    throw err;
  }
  // Reached only if the driver swallowed the throw, which would mean the work
  // was committed. Louder than returning undefined and leaking rows.
  throw new Error(
    "withRollback: the transaction did not roll back. Data may have been committed.",
  );
}
