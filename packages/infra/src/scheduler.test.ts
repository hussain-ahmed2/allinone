import { describe, expect, it } from "vitest";
import { createScheduler, nextRunAfter, parseCron, Scheduler } from "./scheduler.js";

describe("parseCron", () => {
  it("parses all five fields", () => {
    const parsed = parseCron("*/15 9-17 * * 1-5");
    expect(parsed.fields).toHaveLength(5);
    expect([...parsed.fields[0].allowed].sort((a, b) => a - b)).toEqual([0, 15, 30, 45]);
    expect([...parsed.fields[1].allowed].length).toBe(9);
  });

  it("rejects malformed expressions", () => {
    expect(() => parseCron("*/5 * *")).toThrow(/5 fields/);
    expect(() => parseCron("*/0 * * * *")).toThrow(/Invalid step/);
    expect(() => parseCron("* 25 * * *")).toThrow(/out of range/);
    expect(() => parseCron("* * * * mon")).toThrow(/Value out of range|Invalid/);
  });
});

describe("nextRunAfter", () => {
  it("finds the next quarter hour", () => {
    const next = nextRunAfter("*/15 * * * *", new Date("2026-01-01T10:07:30Z"));
    expect(next?.toISOString()).toBe("2026-01-01T10:15:00.000Z");
  });

  it("respects weekday restrictions", () => {
    // 2026-01-02 is a Friday; next Monday 09:00 is 2026-01-05.
    const next = nextRunAfter("0 9 * * 1", new Date("2026-01-01T10:00:00Z"));
    expect(next?.toISOString()).toBe("2026-01-05T09:00:00.000Z");
  });

  it("returns null when nothing matches within a year", () => {
    expect(nextRunAfter("0 0 31 2 *", new Date("2026-01-01T00:00:00Z"))).toBeNull();
  });
});

describe("Scheduler", () => {
  it("validates eagerly and stops idempotently", () => {
    const scheduler = new Scheduler();
    expect(() => scheduler.schedule({ cron: "not-a-cron", handler: () => undefined })).toThrow(
      /5 fields/,
    );
    expect(() => scheduler.schedule({ cron: "*", handler: () => undefined })).toThrow(/5 fields/);
    const id = scheduler.schedule({ cron: "* * * * *", handler: () => undefined });
    expect(scheduler.scheduled()).toHaveLength(1);
    expect(scheduler.stop(id)).toBe(true);
    expect(scheduler.stop(id)).toBe(false);
    expect(scheduler.scheduled()).toHaveLength(0);
  });

  it("keeps job metadata", () => {
    const scheduler = new Scheduler();
    const id = scheduler.schedule({
      cron: "*/5 * * * *",
      handler: () => undefined,
      tenantId: "t1",
    });
    const [job] = scheduler.scheduled();
    expect(job?.id).toBe(id);
    expect(job?.cron).toBe("*/5 * * * *");
    expect(job?.tenantId).toBe("t1");
    scheduler.stop(id);
  });

  it("factory creates an empty scheduler", () => {
    expect(createScheduler().scheduled()).toEqual([]);
  });
});
