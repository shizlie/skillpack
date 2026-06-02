// packages/core/src/storage.js
import { Database } from "bun:sqlite";
import { createLeaseStore } from "./storage-contract.js";

export function createInMemoryLeaseStore() {
  const db = new Database(":memory:");
  const exec = {
    first: (sql, ...args) => db.query(sql).get(...args),
    all:   (sql, ...args) => db.query(sql).all(...args),
    run:   (sql, ...args) => db.query(sql).run(...args),
  };
  return createLeaseStore({ exec, runInTransaction: (fn) => db.transaction(fn)() });
}
