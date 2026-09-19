import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type Allocation = {
  name: string;
  intent: string;
  phase: 'creating' | 'bootstrapping' | 'active' | 'destroying' | 'destroyed';
};

export class AllocationJournal {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS allocations (
        name TEXT PRIMARY KEY, intent TEXT NOT NULL,
        phase TEXT NOT NULL CHECK (phase IN ('creating','bootstrapping','active','destroying','destroyed'))
      ) STRICT;
    `);
  }

  get(name: string): Allocation | undefined {
    const row = this.db.prepare('SELECT name, intent, phase FROM allocations WHERE name = ?').get(name);
    if (!row) return undefined;
    return { name: String(row.name), intent: String(row.intent), phase: String(row.phase) as Allocation['phase'] };
  }

  reserve(name: string, intent: string): { allocation: Allocation; created: boolean } {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.get(name);
      if (current && current.intent !== intent) throw new Error('Worker allocation intent changed; reclaim the original placement.');
      if (!current) {
        const count = this.db.prepare('SELECT count(*) AS count FROM allocations').get();
        if (Number(count?.count) >= 10_000) throw new Error('Worker allocation journal is full; ownership records are never evicted.');
        this.db.prepare('INSERT INTO allocations VALUES (?, ?, ?)').run(name, intent, 'creating');
      }
      this.db.exec('COMMIT');
      return { allocation: current ?? { name, intent, phase: 'creating' }, created: !current };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  transition(name: string, from: Allocation['phase'][], phase: Allocation['phase']): void {
    const result = this.db.prepare(`UPDATE allocations SET phase = ? WHERE name = ? AND phase IN (${from.map(() => '?').join(',')})`).run(phase, name, ...from);
    if (result.changes !== 1) throw new Error('Worker allocation authority changed; retry cleanup.');
  }

  close(): void { this.db.close(); }
}
