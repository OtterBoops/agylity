import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { readJsonColumn } from '../storage/json.js';
import type {
  RunnerRegistrationTokenResult,
  RunnerSystemInfo,
  SwarmRunnerRecord,
} from '../shared/contracts.js';

export class RegistrationTokenError extends Error {}

const hashRunnerToken = (token: string): string =>
  createHash('sha256').update(token.trim()).digest('hex');

const REGISTRATION_TOKEN_RETENTION = 50;

export interface CreateRegistrationTokenInput {
  nameHint?: string;
  labels?: string[];
  repositories?: string[];
  ttlMs?: number;
}

export interface ExchangeRegistrationTokenInput {
  registrationToken: string;
  runnerId?: string;
  runnerName?: string;
  labels?: string[];
  repositories?: string[];
  systemInfo?: RunnerSystemInfo;
}

/**
 * Owns every `swarm_runners` / `swarm_runner_registrations` row: enrolment, auth, heartbeat, pruning.
 * Revoking a runner also releases the tasks it held, which is the one write it makes outside that pair.
 */
export class RunnerRegistry {
  constructor(
    private readonly rawDb: DatabaseSync,
    private readonly runInTransaction: <T>(fn: () => T) => T
  ) {}

  // One-time registration token: plaintext is returned once, only its SHA-256 hash is persisted.
  public createRegistrationToken(
    input: CreateRegistrationTokenInput = {}
  ): RunnerRegistrationTokenResult {
    const id = `reg-${Date.now()}-${randomBytes(3).toString('hex')}`;
    const registrationToken = `agyr_reg_${randomBytes(24).toString('hex')}`;
    const tokenHash = hashRunnerToken(registrationToken);
    const now = new Date();
    const ttlMs = Math.max(60_000, input.ttlMs ?? 60 * 60 * 1000);
    const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
    const createdAt = now.toISOString();
    const labels = Array.from(
      new Set((input.labels ?? []).map((l) => l.trim().toLowerCase()).filter(Boolean))
    );
    const repositories = Array.from(
      new Set((input.repositories ?? []).map((r) => r.trim()).filter(Boolean))
    );
    const nameHint = input.nameHint?.trim() || undefined;

    this.rawDb
      .prepare(
        `INSERT INTO swarm_runner_registrations (
          id, token_hash, name_hint, labels_json, repositories_json, expires_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        tokenHash,
        nameHint ?? null,
        JSON.stringify(labels),
        JSON.stringify(repositories),
        expiresAt,
        createdAt
      );

    this.pruneRegistrationTokens();

    return {
      id,
      registrationToken,
      nameHint,
      labels,
      repositories,
      expiresAt,
      createdAt,
    };
  }

  public pruneRegistrationTokens(keepCount = REGISTRATION_TOKEN_RETENTION): void {
    try {
      const now = new Date().toISOString();
      this.rawDb
        .prepare(
          `DELETE FROM swarm_runner_registrations
           WHERE (consumed_by_runner_id IS NOT NULL OR expires_at <= ?)
             AND id NOT IN (
               SELECT id FROM swarm_runner_registrations
               WHERE consumed_by_runner_id IS NOT NULL OR expires_at <= ?
               ORDER BY created_at DESC, rowid DESC
               LIMIT ?
             )`
        )
        .run(now, now, keepCount);
    } catch {}
  }

  public exchangeRegistrationToken(
    input: ExchangeRegistrationTokenInput,
    nowMs = Date.now()
  ): { runner: SwarmRunnerRecord; runnerToken: string } {
    return this.runInTransaction(() => {
      const rawToken = input.registrationToken?.trim();
      if (!rawToken) {
        throw new RegistrationTokenError('Registration token is required');
      }

      const tokenHash = hashRunnerToken(rawToken);
      const regRow = this.rawDb
        .prepare('SELECT * FROM swarm_runner_registrations WHERE token_hash = ?')
        .get(tokenHash) as Record<string, any> | undefined;

      if (!regRow) {
        throw new RegistrationTokenError('Invalid runner registration token');
      }

      if (regRow.consumed_at) {
        throw new RegistrationTokenError('Runner registration token has already been used');
      }

      const expiresEpoch = new Date(String(regRow.expires_at)).getTime();
      if (Number.isNaN(expiresEpoch) || nowMs > expiresEpoch) {
        throw new RegistrationTokenError('Runner registration token has expired');
      }

      const defaultLabels = readJsonColumn<string[]>(regRow.labels_json || '[]', []);
      const defaultRepos = readJsonColumn<string[]>(regRow.repositories_json || '[]', []);

      const runnerId = input.runnerId?.trim() || `runner-${randomBytes(4).toString('hex')}`;
      const existingRunner = this.getRunner(runnerId);
      // Re-registering must not undo a pause an operator set deliberately.
      if (existingRunner && !existingRunner.enabled) {
        throw new RegistrationTokenError(
          `Runner "${runnerId}" is disabled; re-enable it before registering again`
        );
      }
      const runnerName =
        input.runnerName?.trim() ||
        (regRow.name_hint ? String(regRow.name_hint) : undefined) ||
        runnerId;
      const labels = Array.from(
        new Set(
          (input.labels && input.labels.length > 0 ? input.labels : defaultLabels)
            .map((l) => l.trim().toLowerCase())
            .filter(Boolean)
        )
      );
      const repositories = Array.from(
        new Set(
          (input.repositories && input.repositories.length > 0 ? input.repositories : defaultRepos)
            .map((r) => r.trim())
            .filter(Boolean)
        )
      );
      const systemInfo: RunnerSystemInfo = input.systemInfo ?? {};

      const runnerToken = `agyr_run_${randomBytes(32).toString('hex')}`;
      const runnerTokenHash = hashRunnerToken(runnerToken);
      const nowIso = new Date(nowMs).toISOString();

      // Issued, not spent: consumed_at stays null until the runner authenticates, so a runner that
      // crashed before persisting runner.json can exchange the same token again.
      this.rawDb
        .prepare(
          `UPDATE swarm_runner_registrations
           SET consumed_by_runner_id = ?
           WHERE id = ?`
        )
        .run(runnerId, String(regRow.id));

      this.rawDb
        .prepare(
          `INSERT INTO swarm_runners (
            runner_id, name, token_hash, labels_json, repositories_json,
            system_info_json, enabled, active_task_id, status, registered_at, last_seen_at
          ) VALUES (?, ?, ?, ?, ?, ?, 1, NULL, 'idle', ?, ?)
          ON CONFLICT(runner_id) DO UPDATE SET
            name = excluded.name,
            token_hash = excluded.token_hash,
            labels_json = excluded.labels_json,
            repositories_json = excluded.repositories_json,
            system_info_json = excluded.system_info_json,
            status = 'idle',
            last_seen_at = excluded.last_seen_at`
        )
        .run(
          runnerId,
          runnerName,
          runnerTokenHash,
          JSON.stringify(labels),
          JSON.stringify(repositories),
          JSON.stringify(systemInfo),
          nowIso,
          nowIso
        );

      return {
        runner: this.getRunner(runnerId)!,
        runnerToken,
      };
    });
  }

  public markRegistrationTokenUsed(runnerId: string, nowMs = Date.now()): void {
    this.rawDb
      .prepare(
        `UPDATE swarm_runner_registrations
         SET consumed_at = ?
         WHERE consumed_by_runner_id = ? AND consumed_at IS NULL`
      )
      .run(new Date(nowMs).toISOString(), runnerId);
  }

  public authenticateRunner(
    providedToken: string | undefined,
    fallbackSharedSecret?: string
  ): { authenticated: boolean; runner?: SwarmRunnerRecord; viaSharedSecret?: boolean } {
    const cleanToken = providedToken?.trim() || '';
    const cleanShared = fallbackSharedSecret?.trim() || '';

    if (cleanToken) {
      const tokenHash = hashRunnerToken(cleanToken);
      const row = this.rawDb
        .prepare('SELECT * FROM swarm_runners WHERE token_hash = ?')
        .get(tokenHash) as Record<string, any> | undefined;
      if (row) {
        return { authenticated: true, runner: this.mapRowToRunner(row) };
      }

      if (cleanShared) {
        const tokenBuf = Buffer.from(cleanToken);
        const sharedBuf = Buffer.from(cleanShared);
        if (tokenBuf.length === sharedBuf.length && timingSafeEqual(tokenBuf, sharedBuf)) {
          return { authenticated: true, viaSharedSecret: true };
        }
      }

      return { authenticated: false };
    }

    return { authenticated: false };
  }

  public getRunner(runnerId: string): SwarmRunnerRecord | undefined {
    const row = this.rawDb
      .prepare('SELECT * FROM swarm_runners WHERE runner_id = ?')
      .get(runnerId) as Record<string, any> | undefined;
    return row ? this.mapRowToRunner(row) : undefined;
  }

  public setRunnerEnabled(runnerId: string, enabled: boolean): SwarmRunnerRecord | undefined {
    const existing = this.getRunner(runnerId);
    if (!existing) return undefined;

    this.rawDb
      .prepare('UPDATE swarm_runners SET enabled = ? WHERE runner_id = ?')
      .run(enabled ? 1 : 0, runnerId);

    return this.getRunner(runnerId);
  }

  public revokeRunner(runnerId: string): boolean {
    return this.runInTransaction(() => {
      const existing = this.getRunner(runnerId);
      if (!existing) return false;

      const now = new Date().toISOString();
      this.rawDb
        .prepare(
          `UPDATE swarm_tasks
           SET status = 'queued',
               runner_id = NULL,
               claimed_at = NULL,
               heartbeat_at = NULL,
               updated_at = ?
           WHERE runner_id = ? AND status IN ('claimed', 'executing')`
        )
        .run(now, runnerId);

      this.rawDb.prepare('DELETE FROM swarm_runners WHERE runner_id = ?').run(runnerId);
      return true;
    });
  }

  public pruneOldRunners(maxOfflineAgeMs = 10 * 60 * 1000): void {
    try {
      const cutoff = new Date(Date.now() - maxOfflineAgeMs).toISOString();
      this.rawDb
        .prepare(
          "DELETE FROM swarm_runners WHERE status = 'offline' AND token_hash IS NULL AND last_seen_at < ?"
        )
        .run(cutoff);
    } catch {}
  }

  public registerRunnerHeartbeat(
    info: {
      runnerId: string;
      name?: string;
      labels?: string[];
      repositories?: string[];
      systemInfo?: RunnerSystemInfo;
      activeTaskId?: string | null;
      status?: 'idle' | 'busy' | 'offline';
    },
    options: { touchLastSeen?: boolean } = {}
  ): void {
    const now = new Date().toISOString();
    const existing = this.rawDb
      .prepare('SELECT * FROM swarm_runners WHERE runner_id = ?')
      .get(info.runnerId) as Record<string, any> | undefined;

    const name = info.name ?? existing?.name ?? info.runnerId;
    const labelsJson =
      info.labels !== undefined
        ? JSON.stringify(info.labels.map((l) => l.trim().toLowerCase()).filter(Boolean))
        : (existing?.labels_json ?? '[]');
    const reposJson =
      info.repositories !== undefined
        ? JSON.stringify(info.repositories)
        : (existing?.repositories_json ?? '[]');
    const systemInfoJson =
      info.systemInfo !== undefined
        ? JSON.stringify(info.systemInfo)
        : (existing?.system_info_json ?? '{}');
    const status = info.status ?? existing?.status ?? 'idle';
    const activeTaskId =
      status === 'idle' || status === 'offline'
        ? null
        : info.activeTaskId !== undefined
          ? info.activeTaskId
          : (existing?.active_task_id ?? null);
    const lastSeenAt = options.touchLastSeen === false ? (existing?.last_seen_at ?? now) : now;

    this.rawDb
      .prepare(
        `INSERT INTO swarm_runners (
          runner_id, name, labels_json, repositories_json, system_info_json,
          active_task_id, status, registered_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(runner_id) DO UPDATE SET
          name = excluded.name,
          labels_json = excluded.labels_json,
          repositories_json = excluded.repositories_json,
          system_info_json = excluded.system_info_json,
          active_task_id = excluded.active_task_id,
          status = excluded.status,
          last_seen_at = excluded.last_seen_at`
      )
      .run(
        info.runnerId,
        name,
        labelsJson,
        reposJson,
        systemInfoJson,
        activeTaskId,
        status,
        existing?.registered_at ?? now,
        lastSeenAt
      );
  }

  public listRunners(): SwarmRunnerRecord[] {
    const rows = this.rawDb
      .prepare('SELECT * FROM swarm_runners ORDER BY last_seen_at DESC')
      .all() as Array<Record<string, any>>;

    return rows.map((r) => this.mapRowToRunner(r));
  }

  private mapRowToRunner(r: Record<string, any>): SwarmRunnerRecord {
    const labels = readJsonColumn<string[]>(r.labels_json || '[]', []);
    const repositories = readJsonColumn<string[]>(r.repositories_json || '[]', []);
    const systemInfo = readJsonColumn<RunnerSystemInfo>(r.system_info_json || '{}', {});

    return {
      runnerId: String(r.runner_id ?? ''),
      name: String(r.name),
      labels,
      repositories,
      systemInfo,
      enabled: r.enabled !== 0,
      hasToken: Boolean(r.token_hash),
      activeTaskId: r.active_task_id ? String(r.active_task_id) : undefined,
      status: (r.status as 'idle' | 'busy' | 'offline') || 'idle',
      registeredAt: String(r.registered_at || r.last_seen_at),
      lastSeenAt: String(r.last_seen_at),
    };
  }
}
