import * as crypto from 'crypto';
import * as fs from 'fs';

export interface VerifyResult {
  ok: number;
  legacy: number;
  broken: number[];
}

/**
 * Walk the HMAC-SHA256 chain in a JSONL audit log and report integrity.
 * Each chained entry contains `prev_hash` and `entry_hash`.
 * Legacy entries (written before NF2-SEC-002) have neither field and are
 * skipped gracefully — they reset the chain anchor to GENESIS_HASH.
 *
 * @param logPath  Absolute path to the .jsonl audit log file.
 * @param hmacKey  Key used to compute HMAC — should be vscode.env.machineId.
 */
export function verifyAuditLog(logPath: string, hmacKey: string): VerifyResult {
  const GENESIS_HASH = '0'.repeat(64);

  if (!fs.existsSync(logPath)) {
    return { ok: 0, legacy: 0, broken: [] };
  }

  const raw = fs.readFileSync(logPath, 'utf8');
  const lines = raw.split('\n').filter(l => l.trim().length > 0);

  let prevHash = GENESIS_HASH;
  let ok = 0;
  let legacy = 0;
  const broken: number[] = [];

  for (let i = 0; i < lines.length; i++) {
    try {
      const obj = JSON.parse(lines[i]) as Record<string, unknown>;

      if (typeof obj.entry_hash !== 'string') {
        // Pre-chain entry — reset anchor so subsequent chained entries are
        // still verifiable relative to the last legacy boundary.
        legacy++;
        prevHash = GENESIS_HASH;
        continue;
      }

      const storedPrevHash = obj.prev_hash as string;
      const storedEntryHash = obj.entry_hash as string;

      const copy = { ...obj };
      delete copy.prev_hash;
      delete copy.entry_hash;

      const corePayload = JSON.stringify(copy);
      const expected = crypto.createHmac('sha256', hmacKey)
        .update(corePayload + prevHash)
        .digest('hex');

      if (storedEntryHash !== expected || storedPrevHash !== prevHash) {
        broken.push(i + 1); // 1-based line number for user messages
      } else {
        ok++;
      }

      prevHash = storedEntryHash;
    } catch {
      broken.push(i + 1);
    }
  }

  return { ok, legacy, broken };
}
