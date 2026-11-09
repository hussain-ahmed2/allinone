import { describe, expect, it } from "vitest";
import { createNotificationCenter } from "./notifications.js";
import type { NotificationMessage } from "./infra.js";

function memoryProvider() {
  const sent: NotificationMessage[] = [];
  return {
    sent,
    provider: {
      name: "test",
      async send(message: NotificationMessage): Promise<void> {
        sent.push(message);
      },
    },
  };
}

describe("NotificationCenter", () => {
  it("routes to inbox + provider by default", async () => {
    const { sent, provider } = memoryProvider();
    const center = createNotificationCenter(provider);
    const dispatched = await center.notify({
      tenantId: "t1",
      userId: "u1",
      email: "ada@example.com",
      title: "Welcome",
      body: "hello",
    });
    expect(dispatched).toEqual({ inApp: true, emailed: true });
    expect(sent).toHaveLength(1);
    expect(center.list("t1", "u1")).toHaveLength(1);
    expect(center.list("t2", "u1")).toHaveLength(0); // tenant-scoped
    expect(center.list("t1", "other")).toHaveLength(0);
  });

  it("respects per-user preferences", async () => {
    const { sent, provider } = memoryProvider();
    const center = createNotificationCenter(provider);
    center.setPreferences("u1", { email: false, inApp: true });
    const dispatched = await center.notify({
      tenantId: "t1",
      userId: "u1",
      email: "ada@example.com",
      title: "Hi",
      body: "hello",
    });
    expect(dispatched.emailed).toBe(false);
    expect(sent).toHaveLength(0);
    expect(center.list("t1", "u1")).toHaveLength(1);
  });

  it("markRead / markAllRead are tenant + user scoped", async () => {
    const center = createNotificationCenter();
    await center.notify({ tenantId: "t1", userId: "u1", email: "a@b.c", title: "A", body: "1" });
    await center.notify({ tenantId: "t1", userId: "u1", email: "a@b.c", title: "B", body: "2" });
    await center.notify({ tenantId: "t1", userId: "u2", email: "a@b.c", title: "C", body: "3" });
    const [first] = center.list("t1", "u1", true);
    expect(first).toBeTruthy();
    // Wrong tenant/user cannot mark the message.
    expect(center.markRead("t2", "u1", first!.id)).toBe(false);
    expect(center.markRead("t1", "u1", first!.id)).toBe(true);
    expect(center.list("t1", "u1", true)).toHaveLength(1);
    expect(center.markAllRead("t1", "u1")).toBe(1);
    expect(center.list("t1", "u1")).toHaveLength(2);
  });

  it("works without a provider (inbox-only mode)", async () => {
    const center = createNotificationCenter();
    const dispatched = await center.notify({
      tenantId: "t1",
      userId: "u1",
      email: "ada@example.com",
      title: "Note",
      body: "hello",
    });
    expect(dispatched).toEqual({ inApp: true, emailed: false });
  });
});
