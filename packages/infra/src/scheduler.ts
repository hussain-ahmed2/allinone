/**
 * Scheduler — cron expressions (5-field) with a stack-safe executor.
 *
 * Implementation notes:
 *  - Only `*`, exact numbers, lists (`1,2`), ranges (`1-5`), and step
 *    values (`star5` means every 5th — the literal sequence is avoided
 *    here because it would close this comment) are supported. Month/dow
 *    names are not.
 *  - `nextRunAfter` walks minute-by-minute from the start time for at
 *    most 366 days (bounded; returns null beyond that).
 *  - Executor uses `setInterval` ticks with overlapping runs guarded
 *    per job (a slow handler cannot overlap itself by default).
 */
import { randomBytes } from "node:crypto";

interface Field {
  min: number;
  max: number;
  allowed: Set<number>;
}

function parseField(raw: string, min: number, max: number, label: string): Field {
  const allowed = new Set<number>();
  for (const part of raw.split(",")) {
    const pieces = part.trim().split("/");
    const baseRaw = pieces[0] ?? "";
    const stepRaw = pieces[1];
    const step = stepRaw !== undefined ? Number.parseInt(stepRaw, 10) : 1;
    if (!Number.isInteger(step) || step <= 0) {
      throw new Error(`[allinone/infra] Invalid step in ${label}: ${part}`);
    }
    let lo: number;
    let hi: number;
    if (baseRaw === "*") {
      lo = min;
      hi = max;
    } else if (baseRaw.includes("-")) {
      const segments = baseRaw.split("-");
      const a = segments[0] ?? "";
      const b = segments[1] ?? "";
      lo = Number.parseInt(a, 10);
      hi = Number.parseInt(b, 10);
    } else {
      lo = hi = Number.parseInt(baseRaw, 10);
    }
    if (lo < min || hi > max || !Number.isInteger(lo) || !Number.isInteger(hi)) {
      throw new Error(`[allinone/infra] Value out of range in ${label}: ${part}`);
    }
    for (let v = lo; v <= hi; v += step) allowed.add(v);
  }
  return { min, max, allowed };
}

interface ParsedCron {
  /** minute, hour, dayOfMonth, month, dayOfWeek */
  fields: [Field, Field, Field, Field, Field];
}

export function parseCron(expression: string): ParsedCron {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(
      `[allinone/infra] Cron expressions need 5 fields (m h dom mon dow): ${JSON.stringify(expression)}`,
    );
  }
  const mins = [0, 59];
  const hours = [0, 23];
  const dom = [1, 31];
  const mon = [1, 12];
  const dow = [0, 6];
  const [minuteRaw = "", hourRaw = "", domRaw = "", monthRaw = "", dowRaw = ""] = parts;
  const [minuteMin = 0, minuteMax = 59] = mins;
  const [hourMin = 0, hourMax = 23] = hours;
  const [domMin = 1, domMax = 31] = dom;
  const [monthMin = 1, monthMax = 12] = mon;
  const [dowMin = 0, dowMax = 6] = dow;
  return {
    fields: [
      parseField(minuteRaw, minuteMin, minuteMax, "minute"),
      parseField(hourRaw, hourMin, hourMax, "hour"),
      parseField(domRaw, domMin, domMax, "day-of-month"),
      parseField(monthRaw, monthMin, monthMax, "month"),
      parseField(dowRaw, dowMin, dowMax, "day-of-week"),
    ],
  };
}

function matches(parsed: ParsedCron, date: Date): boolean {
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parsed.fields;
  // POSIX day rule (cron is evaluated in UTC for determinism across servers):
  // when BOTH dom and dow are restricted, the day matches if EITHER does;
  // when one is unrestricted (*), only the restricted one decides.
  const domRestricted = dayOfMonth.allowed.size !== 31;
  const dowRestricted = dayOfWeek.allowed.size !== 7;
  const domMatch = dayOfMonth.allowed.has(date.getUTCDate());
  const dowMatch = dayOfWeek.allowed.has(date.getUTCDay());
  const dayOk =
    domRestricted && dowRestricted ? domMatch || dowMatch : domRestricted ? domMatch : dowMatch;
  return (
    minute.allowed.has(date.getUTCMinutes()) &&
    hour.allowed.has(date.getUTCHours()) &&
    dayOk &&
    month.allowed.has(date.getUTCMonth() + 1)
  );
}

/**
 * Next fire time strictly AFTER `from` (minutes aligned), or null when no
 * match exists within 366 days (e.g. Feb 31 syntax).
 */
export function nextRunAfter(expression: string, from: Date): Date | null {
  const parsed = parseCron(expression);
  const limit = from.getTime() + 366 * 24 * 60 * 60 * 1000;
  const cursor = new Date(from.getTime() + 60_000);
  cursor.setSeconds(0, 0);
  while (cursor.getTime() <= limit) {
    if (matches(parsed, cursor)) return new Date(cursor);
    cursor.setTime(cursor.getTime() + 60_000);
  }
  return null;
}

export interface ScheduledJob {
  id: string;
  cron: string;
  tenantId?: string;
  handler: (ctx: { tenantId?: string; nextRun: Date }) => Promise<void> | void;
  allowOverlap?: boolean;
  timer?: ReturnType<typeof setInterval>;
  running?: boolean;
}

export class Scheduler {
  readonly #jobs = new Map<string, ScheduledJob>();

  /** Schedule a named handler. Tick granularity: 1s (next-run aligned). */
  schedule(input: {
    cron: string;
    handler: ScheduledJob["handler"];
    tenantId?: string;
    allowOverlap?: boolean;
  }): string {
    parseCron(input.cron); // validate eagerly
    const id = `job_${randomBytes(6).toString("base64url")}`;
    const job: ScheduledJob = {
      id,
      cron: input.cron,
      ...(input.tenantId ? { tenantId: input.tenantId } : {}),
      handler: input.handler,
      ...(input.allowOverlap !== undefined ? { allowOverlap: input.allowOverlap } : {}),
    };
    this.#jobs.set(id, job);
    job.timer = setInterval(() => {
      void this.#tick(job);
    }, 1000);
    job.timer.unref();
    return id;
  }

  async #tick(job: ScheduledJob): Promise<void> {
    if (job.running && !job.allowOverlap) return;
    const next = nextRunAfter(job.cron, new Date(Date.now() - 1000));
    if (!next || next.getTime() > Date.now() + 1000) return;
    job.running = true;
    try {
      await job.handler({
        ...(job.tenantId !== undefined ? { tenantId: job.tenantId } : {}),
        nextRun: next,
      });
    } finally {
      job.running = false;
    }
  }

  /** Stop a job (idempotent). */
  stop(id: string): boolean {
    const job = this.#jobs.get(id);
    if (!job) return false;
    if (job.timer) clearInterval(job.timer);
    this.#jobs.delete(id);
    return true;
  }

  /** Stop every job. */
  stopAll(): void {
    for (const id of [...this.#jobs.keys()]) this.stop(id);
  }

  scheduled(): ScheduledJob[] {
    return [...this.#jobs.values()];
  }
}

export function createScheduler(): Scheduler {
  return new Scheduler();
}
