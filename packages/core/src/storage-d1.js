// packages/core/src/storage-d1.js
import { createLeaseStore, LEASE_STORE_SCHEMA_STATEMENTS } from "./storage-contract.js";

function wrapD1(db) {
  if (!db || typeof db.prepare !== "function") {
    throw new Error("d1_store_missing_db");
  }
  return {
    exec: {
      first: async (sql, ...args) => db.prepare(sql).bind(...args).first(),
      all:   async (sql, ...args) => (await db.prepare(sql).bind(...args).all())?.results ?? [],
      run:   async (sql, ...args) => db.prepare(sql).bind(...args).run(),
    },
  };
}

export function createD1LeaseStore({ db }) {
  return createLeaseStore(wrapD1(db));
}

// Eagerly run schema DDL — useful for migrations and CI.
// Production usage relies on the lazy ensureReady inside createLeaseStore.
export async function ensureD1Schema(db) {
  const { exec } = wrapD1(db);
  for (const statement of LEASE_STORE_SCHEMA_STATEMENTS) {
    await exec.run(statement);
  }
}
