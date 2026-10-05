import { appendFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { join } from 'node:path';
import { redact } from './config.js';

export function digest(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export class Receipt {
  readonly directory: string;
  private secrets: string[];
  constructor(root: string, secrets: string[]) {
    this.directory = join(root, `${new Date().toISOString().replaceAll(':','-')}-${randomUUID().slice(0,8)}`);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.secrets = [...secrets];
  }
  addSecret(secret: string): void { this.secrets.push(secret); }
  event(kind: string, details: Record<string, unknown> = {}): void {
    appendFileSync(join(this.directory, 'events.jsonl'),
      redact(JSON.stringify({ at: new Date().toISOString(), kind, ...details }), this.secrets) + '\n', { mode: 0o600 });
  }
  finish(status: 'passed' | 'failed', details: Record<string, unknown>): void {
    const file = join(this.directory, 'receipt.json');
    const temporary = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temporary, redact(JSON.stringify({ at: new Date().toISOString(), status, ...details }, null, 2), this.secrets) + '\n', { mode: 0o600 });
    renameSync(temporary, file);
  }
}
