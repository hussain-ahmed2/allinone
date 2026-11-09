/**
 * Workflow engine — event-driven multi-step execution with approval gates,
 * retries, and tenant-scoped execution history.
 *
 * Design rules:
 *  - Workflows are DATA (definition) + CODE (registered handlers). The
 *    engine never embeds secrets or performs side effects implicitly.
 *  - Steps run sequentially in declaration order; a step is either a
 *    task (calls a registered handler), a conditional (routes to one
 *    handler or another by predicate), or an approval (pauses until a
 *    human approves/rejects).
 *  - Every attempt is recorded; exhausted retries fail the run loudly.
 */
import { randomBytes } from "node:crypto";

export type WorkflowStepType = "task" | "approval" | "conditional";

export interface WorkflowStep {
  /** Stable id unique in the definition. */
  id: string;
  type: WorkflowStepType;
  /** Registered handler name (task steps). */
  action?: string;
  /** Retry policy (task steps). Defaults: 3 attempts, 100ms base. */
  retry?: { maxAttempts?: number; backoffMs?: number };
  /** Approval label (approval steps). */
  label?: string;
  /** Predicate + routes (conditional steps). */
  when?: (input: Record<string, unknown>) => boolean;
  then?: string;
  otherwise?: string;
}

export interface WorkflowDefinition {
  id: string;
  name: string;
  steps: readonly WorkflowStep[];
}

export type RunStatus = "running" | "waiting-approval" | "completed" | "failed" | "rejected";

export type StepStatus =
  "pending" | "running" | "succeeded" | "failed" | "skipped" | "waiting-approval";

export interface StepRecord {
  stepId: string;
  status: StepStatus;
  attempts: number;
  startedAt: string;
  finishedAt?: string;
  output?: unknown;
  error?: string;
}

export interface RunRecord {
  id: string;
  definitionId: string;
  tenantId: string;
  status: RunStatus;
  steps: StepRecord[];
  createdAt: string;
  finishedAt?: string;
  input: Record<string, unknown>;
}

export type WorkflowHandler = (input: Record<string, unknown>) => unknown;

export class WorkflowEngine {
  readonly #handlers = new Map<string, WorkflowHandler>();
  readonly #definitions = new Map<string, WorkflowDefinition>();
  readonly #runs = new Map<string, RunRecord>();

  /** Register executable handler by name. */
  register(name: string, handler: WorkflowHandler): void {
    if (this.#handlers.has(name)) {
      throw new Error(`[allinone/infra] Workflow handler already registered: ${name}`);
    }
    this.#handlers.set(name, handler);
  }

  /** Define a workflow. Duplicate ids are rejected. */
  define(definition: WorkflowDefinition): void {
    if (this.#definitions.has(definition.id)) {
      throw new Error(`[allinone/infra] Workflow definition already exists: ${definition.id}`);
    }
    const ids = new Set<string>();
    for (const step of definition.steps) {
      if (ids.has(step.id)) {
        throw new Error(`[allinone/infra] Duplicate step id "${step.id}" in "${definition.id}"`);
      }
      ids.add(step.id);
    }
    this.#definitions.set(definition.id, definition);
  }

  /** Start a run (does not execute — call `execute`). */
  start(
    definitionId: string,
    input: { tenantId: string; data?: Record<string, unknown> },
  ): RunRecord {
    const definition = this.#definitions.get(definitionId);
    if (!definition) {
      throw new Error(`[allinone/infra] Unknown workflow definition: ${definitionId}`);
    }
    if (!input.tenantId) throw new Error("[allinone/infra] Workflow run requires tenantId");
    const run: RunRecord = {
      id: `wfr_${randomBytes(9).toString("base64url")}`,
      definitionId,
      tenantId: input.tenantId,
      status: "running",
      steps: definition.steps.map((step) => ({
        stepId: step.id,
        status: "pending" as const,
        attempts: 0,
        startedAt: new Date().toISOString(),
      })),
      createdAt: new Date().toISOString(),
      input: { ...(input.data ?? {}) },
    };
    this.#runs.set(run.id, run);
    return run;
  }

  /** Execute a started run (or resume an approved one). */
  async execute(runId: string, startFrom?: number): Promise<RunRecord> {
    const run = this.#runs.get(runId);
    if (!run) throw new Error(`[allinone/infra] Unknown workflow run: ${runId}`);
    if (run.status !== "running" && run.status !== "waiting-approval") {
      throw new Error(`[allinone/infra] Run ${runId} is ${run.status} — cannot execute`);
    }
    const definition = this.#definitions.get(run.definitionId);
    if (!definition) throw new Error("[allinone/infra] Definition missing (server error)");
    run.status = "running";

    for (let index = startFrom ?? 0; index < definition.steps.length; index += 1) {
      const step = definition.steps[index];
      const record = run.steps[index];
      if (!step || !record) continue;
      if (record.status === "succeeded" || record.status === "skipped") continue;

      if (step.type === "approval") {
        record.status = "waiting-approval";
        run.status = "waiting-approval";
        return run;
      }

      if (step.type === "conditional") {
        const predicate = step.when ?? (() => false);
        const branch = predicate(run.input) ? step.then : step.otherwise;
        record.output = branch ?? null;
        record.status = "skipped";
        // Route: jump the input when a branch is declared.
        if (branch) {
          const target = definition.steps.findIndex((s) => s.id === branch);
          record.output = { branch };
          Object.assign(run.input, { __branch: branch });
          if (target !== -1) {
            index = target - 1;
            continue;
          }
        }
        continue;
      }

      // Task step with retries.
      const handler = this.#handlers.get(step.action ?? "");
      if (!handler) {
        record.status = "failed";
        record.error = `No handler registered for "${step.action ?? "(missing)"}"`;
        record.finishedAt = new Date().toISOString();
        run.status = "failed";
        run.finishedAt = new Date().toISOString();
        return run;
      }
      const maxAttempts = step.retry?.maxAttempts ?? 3;
      const backoff = step.retry?.backoffMs ?? 100;
      record.status = "running";
      let delay = backoff;
      let exhausted = false;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        record.attempts = attempt;
        try {
          record.output = await handler({ ...run.input });
          record.status = "succeeded";
          break;
        } catch (error) {
          record.error = error instanceof Error ? error.message : String(error);
          if (attempt >= maxAttempts) {
            record.status = "failed";
            exhausted = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, delay));
          delay *= 2;
        }
      }
      if (exhausted) {
        run.status = "failed";
        run.finishedAt = new Date().toISOString();
        return run;
      }
      record.finishedAt = new Date().toISOString();
    }

    run.status = "completed";
    run.finishedAt = new Date().toISOString();
    return run;
  }

  /** Approve a waiting run and resume execution. */
  async approve(runId: string): Promise<RunRecord> {
    const run = this.#runs.get(runId);
    if (!run || run.status !== "waiting-approval") {
      throw new Error(`[allinone/infra] Run not waiting for approval: ${runId}`);
    }
    const definition = this.#definitions.get(run.definitionId);
    if (!definition) throw new Error("[allinone/infra] Definition missing (server error)");
    const index = definition.steps.findIndex(
      (s, i) => s.type === "approval" && run.steps[i]?.status === "waiting-approval",
    );
    const record = run.steps[index];
    if (index !== -1 && record) {
      record.status = "succeeded";
      record.finishedAt = new Date().toISOString();
      run.status = "running";
    }
    return this.execute(runId, index + 1);
  }

  /** Reject a waiting run (terminal). */
  async reject(runId: string): Promise<RunRecord> {
    const run = this.#runs.get(runId);
    if (!run || run.status !== "waiting-approval") {
      throw new Error(`[allinone/infra] Run not waiting for approval: ${runId}`);
    }
    run.status = "rejected";
    run.finishedAt = new Date().toISOString();
    return run;
  }

  /** Tenant-scoped history — cross-tenant access is impossible via this API. */
  history(tenantId: string): RunRecord[] {
    return [...this.#runs.values()].filter((run) => run.tenantId === tenantId);
  }

  /** Fetch one run (throws when unknown). */
  get(runId: string): RunRecord {
    const run = this.#runs.get(runId);
    if (!run) throw new Error(`[allinone/infra] Unknown workflow run: ${runId}`);
    return run;
  }
}

export function createWorkflowEngine(): WorkflowEngine {
  return new WorkflowEngine();
}
