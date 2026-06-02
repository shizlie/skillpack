// packages/core/src/storage-sqlite.js
import { Database } from "bun:sqlite";
import { createLeaseStore } from "./storage-contract.js";

export function createSqliteLeaseStore({ dbPath = ":memory:" } = {}) {
  const db = new Database(dbPath, { create: true });
  const exec = {
    first: (sql, ...args) => db.query(sql).get(...args),
    all:   (sql, ...args) => db.query(sql).all(...args),
    run:   (sql, ...args) => db.query(sql).run(...args),
  };
  const store = createLeaseStore({ exec, runInTransaction: (fn) => db.transaction(fn)() });
  return { ...store, close() { db.close(false); } };
}
