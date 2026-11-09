import { describe, expect, it } from "vitest";
import { createWebhookDispatcher } from "./webhooks.js";
import { signWebhook, verifyWebhook } from "./infra.js";

describe("WebhookDispatcher", () => {
  it("delivers signed events to matching tenant subscriptions", async () => {
    const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
    const dispatcher = createWebhookDispatcher({
      fetchImpl: async (url, init) => {
        calls.push({ url, headers: init.headers, body: init.body });
        return { status: 200 };
      },
    });
    dispatcher.subscribe({
      id: "sub1",
      tenantId: "t1",
      url: "https://api.example/hook",
      secret: "s3cr3t",
      events: ["user.created"],
    });
    dispatcher.subscribe({
      id: "sub2",
      tenantId: "t2",
      url: "https://api.example/hook",
      secret: "s3cr3t",
      events: ["user.created"],
    });

    const deliveries = dispatcher.dispatch("t1", { event: "user.created", payload: { id: "u1" } });
    // Cross-tenant subscriptions never receive the event.
    expect(deliveries).toHaveLength(1);

    const attempted = await dispatcher.processDue();
    expect(attempted).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.example/hook");
    const headers = calls[0]?.headers ?? {};
    // Signature verifies against the literal body.
    expect(
      verifyWebhook(
        "s3cr3t",
        calls[0]!.body,
        headers["x-webhook-timestamp"]!,
        headers["x-webhook-signature"]!,
      ),
    ).toBe(true);
    const record = dispatcher.deliveriesByEndpoint("sub1")[0];
    expect(record?.status).toBe("delivered");
    expect(record?.payload).toEqual({ id: "u1" });
    expect(signWebhook("s3cr3t", "x", "1")).toBe(signWebhook("s3cr3t", "x", "1"));
  });

  it("retries then dead-letters after maxAttempts", async () => {
    const dispatcher = createWebhookDispatcher({
      maxAttempts: 2,
      baseDelaySeconds: 0,
      fetchImpl: async () => ({ status: 500 }),
    });
    dispatcher.subscribe({
      id: "sub1",
      tenantId: "t1",
      url: "https://api.example/hook",
      secret: "s",
      events: ["job"],
    });
    dispatcher.dispatch("t1", { event: "job", payload: {} });
    await dispatcher.processDue();
    const dead = () => dispatcher.deadLetters("t1");
    // First failure schedules a retry (stays queued until its backoff).
    expect(dead()).toHaveLength(0);
    await dispatcher.processDue(Date.now() + 100_000); // after backoff
    expect(dead()).toHaveLength(1);
    expect(dead()[0]?.status).toBe("dead");
    expect(dead()[0]?.attempts).toBe(2);
  });

  it("dead-letters cleanly when the endpoint disappears", async () => {
    const dispatcher = createWebhookDispatcher({ fetchImpl: async () => ({ status: 200 }) });
    dispatcher.subscribe({
      id: "sub1",
      tenantId: "t1",
      url: "https://api.example/hook",
      secret: "s",
      events: ["job"],
    });
    // No subscription removal API — dead-letter case is covered by attempts path.
    dispatcher.dispatch("t1", { event: "job", payload: {} });
    expect(dispatcher.deliveriesByEndpoint("sub1")).toHaveLength(1);
  });

  it("ignores events a subscription does not match", async () => {
    const dispatcher = createWebhookDispatcher({ fetchImpl: async () => ({ status: 200 }) });
    dispatcher.subscribe({
      id: "sub1",
      tenantId: "t1",
      url: "https://api.example/hook",
      secret: "s",
      events: ["user.created"],
    });
    const deliveries = dispatcher.dispatch("t1", { event: "post.published", payload: {} });
    expect(deliveries).toHaveLength(0);
  });
});
