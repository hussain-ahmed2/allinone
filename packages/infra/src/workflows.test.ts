import { describe, expect, it } from "vitest";
import { createWorkflowEngine } from "./workflows.js";

describe("WorkflowEngine", () => {
  it("executes tasks in order", async () => {
    const engine = createWorkflowEngine();
    const calls: string[] = [];
    engine.register("first", () => {
      calls.push("first");
    });
    engine.register("second", () => {
      calls.push("second");
    });
    engine.define({
      id: "seq",
      name: "Sequence",
      steps: [
        { id: "s1", type: "task", action: "first" },
        { id: "s2", type: "task", action: "second" },
      ],
    });
    const run = engine.start("seq", { tenantId: "t1" });
    const done = await engine.execute(run.id);
    expect(done.status).toBe("completed");
    expect(calls).toEqual(["first", "second"]);
    expect(done.steps.every((s) => s.status === "succeeded")).toBe(true);
  });

  it("retries then succeeds; fails loud after budget", async () => {
    const engine = createWorkflowEngine();
    let attempts = 0;
    engine.register("flaky", () => {
      attempts += 1;
      if (attempts < 3) throw new Error("transient");
    });
    engine.define({
      id: "retry",
      name: "Retry",
      steps: [{ id: "s1", type: "task", action: "flaky", retry: { maxAttempts: 3, backoffMs: 1 } }],
    });
    const run = engine.start("retry", { tenantId: "t1" });
    expect((await engine.execute(run.id)).status).toBe("completed");
    expect(attempts).toBe(3);

    engine.register("doomsday", () => {
      throw new Error("fatal");
    });
    engine.define({
      id: "doomed",
      name: "Doomed",
      steps: [
        { id: "s1", type: "task", action: "doomsday", retry: { maxAttempts: 2, backoffMs: 1 } },
      ],
    });
    const failed = await engine.execute(engine.start("doomed", { tenantId: "t1" }).id);
    expect(failed.status).toBe("failed");
    expect(failed.steps[0]?.attempts).toBe(2);
    expect(failed.steps[0]?.error).toContain("fatal");
  });

  it("pauses at approval gates and resumes on approve", async () => {
    const engine = createWorkflowEngine();
    engine.register("notify", () => {
      // No-op.
    });
    engine.define({
      id: "approve-flow",
      name: "Approval",
      steps: [
        { id: "review", type: "approval", label: "Manager review" },
        { id: "notify", type: "task", action: "notify", retry: { maxAttempts: 1, backoffMs: 1 } },
      ],
    });
    const started = engine.start("approve-flow", { tenantId: "t1" });
    const paused = await engine.execute(started.id);
    expect(paused.status).toBe("waiting-approval");
    expect(paused.steps[1]?.status).toBe("pending");
    const approved = await engine.approve(started.id);
    expect(approved.status).toBe("completed");
    expect(approved.steps[1]?.status).toBe("succeeded");
  });

  it("rejects waiting runs", async () => {
    const engine = createWorkflowEngine();
    engine.define({
      id: "gate",
      name: "Gate",
      steps: [{ id: "review", type: "approval", label: "Review" }],
    });
    const started = engine.start("gate", { tenantId: "t1" });
    await engine.execute(started.id);
    const rejected = await engine.reject(started.id);
    expect(rejected.status).toBe("rejected");
  });

  it("routes conditional steps; history is tenant-scoped", async () => {
    const engine = createWorkflowEngine();
    engine.define({
      id: "route",
      name: "Route",
      steps: [
        {
          id: "check",
          type: "conditional",
          when: (input) => input["vip"] === true,
          then: "vip-track",
          otherwise: "std-track",
        },
        { id: "vip-track", type: "task", action: "noop", retry: { maxAttempts: 1 } },
        { id: "std-track", type: "task", action: "noop", retry: { maxAttempts: 1 } },
      ],
    });
    engine.register("noop", () => undefined);
    const run = engine.start("route", { tenantId: "t1", data: { vip: true } });
    await engine.execute(run.id);
    expect(run.input["__branch"]).toBe("vip-track");

    engine.start("route", { tenantId: "t2", data: {} });
    expect(engine.history("t1")).toHaveLength(1);
    expect(engine.history("t2")).toHaveLength(1);
    expect(engine.history("t3")).toHaveLength(0);
  });

  it("guards definitions and stores", () => {
    const engine = createWorkflowEngine();
    engine.define({ id: "x", name: "X", steps: [] });
    expect(() => {
      engine.define({ id: "x", name: "X2", steps: [] });
    }).toThrow(/already exists/);
    expect(() => {
      engine.define({
        id: "y",
        name: "Y",
        steps: [
          { id: "s", type: "task" },
          { id: "s", type: "task" },
        ],
      });
    }).toThrow(/Duplicate step id/);
    expect(() => engine.start("ghost", { tenantId: "t1" })).toThrow(/Unknown workflow definition/);
  });
});
