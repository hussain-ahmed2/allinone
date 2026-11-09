/**
 * Notification center — preferences + in-app inbox + provider routing.
 *
 * Delivery policy (per user):
 *  - `inApp` preference gates the inbox entry;
 *  - `email` preference gates the provider send;
 *  - `push` is reserved for future providers (stored, not yet dispatched).
 * Preferences default to all-true; an admin or the user can opt out.
 */
import { randomBytes } from "node:crypto";
import type { NotificationProvider } from "./infra.js";

export interface ChannelPreferences {
  email: boolean;
  push: boolean;
  inApp: boolean;
}

export interface InboxMessage {
  id: string;
  tenantId: string;
  userId: string;
  title: string;
  body: string;
  kind: string;
  read: boolean;
  createdAt: string;
}

const DEFAULT_PREFERENCES: ChannelPreferences = { email: true, push: true, inApp: true };

export class NotificationCenter {
  readonly #provider: NotificationProvider | undefined;
  readonly #preferences = new Map<string, ChannelPreferences>();
  readonly #inbox = new Map<string, InboxMessage>();

  constructor(provider?: NotificationProvider) {
    this.#provider = provider;
  }

  getPreferences(userId: string): ChannelPreferences {
    return { ...(this.#preferences.get(userId) ?? DEFAULT_PREFERENCES) };
  }

  setPreferences(userId: string, preferences: Partial<ChannelPreferences>): ChannelPreferences {
    const next: ChannelPreferences = { ...this.getPreferences(userId), ...preferences };
    this.#preferences.set(userId, next);
    return next;
  }

  /**
   * Notify one user. Writes the inbox entry (if inApp is on) and sends via
   * the provider (if email is on). Returns what was dispatched.
   */
  async notify(input: {
    tenantId: string;
    userId: string;
    email: string;
    title: string;
    body: string;
    kind?: string;
  }): Promise<{ inApp: boolean; emailed: boolean }> {
    const preferences = this.getPreferences(input.userId);
    let inApp = false;
    if (preferences.inApp) {
      const message: InboxMessage = {
        id: `ntf_${randomBytes(9).toString("base64url")}`,
        tenantId: input.tenantId,
        userId: input.userId,
        title: input.title,
        body: input.body,
        kind: input.kind ?? "general",
        read: false,
        createdAt: new Date().toISOString(),
      };
      this.#inbox.set(message.id, message);
      inApp = true;
    }
    let emailed = false;
    if (preferences.email && this.#provider) {
      await this.#provider.send({
        to: input.email,
        subject: input.title,
        body: input.body,
        tenantId: input.tenantId,
      });
      emailed = true;
    }
    return { inApp, emailed };
  }

  /** Tenant-scoped inbox list (unread first). */
  list(tenantId: string, userId: string, unreadOnly = false): InboxMessage[] {
    return [...this.#inbox.values()]
      .filter((m) => m.tenantId === tenantId && m.userId === userId && (!unreadOnly || !m.read))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  markRead(tenantId: string, userId: string, messageId: string): boolean {
    const message = this.#inbox.get(messageId);
    if (!message || message.tenantId !== tenantId || message.userId !== userId) return false;
    message.read = true;
    return true;
  }

  markAllRead(tenantId: string, userId: string): number {
    let count = 0;
    for (const message of this.#inbox.values()) {
      if (message.tenantId === tenantId && message.userId === userId && !message.read) {
        message.read = true;
        count += 1;
      }
    }
    return count;
  }
}

export function createNotificationCenter(provider?: NotificationProvider): NotificationCenter {
  return new NotificationCenter(provider);
}
