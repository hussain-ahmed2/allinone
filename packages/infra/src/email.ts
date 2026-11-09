/**
 * Email / SMTP notification provider (nodemailer, no extra abstractions).
 *
 * - Rendering escapes interpolated variables by default (`escapeHtml`) so
 *   user input cannot inject markup into emails.
 * - `transport` is injectable for tests: pass a fake `sendMail` and assert
 *   on the captured message instead of hitting a server.
 */
import nodemailer, { type Transporter, type SendMailOptions } from "nodemailer";
import { type NotificationMessage, type NotificationProvider } from "./infra.js";

/** Minimal nodemailer-transport-shaped interface (injectable for tests). */
export type MailSendFn = (mail: SendMailOptions) => Promise<unknown>;

/** HTML-escape interpolated values. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Tiny mustache-ish renderer: replaces `{{ key }}` with the escaped value.
 * Unknown keys render as empty strings (templates never half-fill silently).
 * Callers treat templates as trusted code; user data MUST go through
 * variables (which are escaped).
 */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_match, key: string) =>
    escapeHtml(vars[key] ?? ""),
  );
}

export interface SmtpMailerOptions {
  /** nodemailer transporter (skip to build from SMTP options below). */
  transporter?: Transporter;
  host?: string;
  port?: number;
  secure?: boolean;
  user?: string;
  pass?: string;
  from?: string;
  /** Injectable send function for tests — replaces nodemailer entirely. */
  sendMail?: MailSendFn;
}

export interface MailTemplate {
  subject: string;
  html: string;
}

/**
 * Create an email NotificationProvider.
 *
 * ```ts
 * const mailer = createSmtpMailer({ host, port, secure, user, pass, from });
 * await mailer.send({ to, subject, body: html, tenantId });
 * ```
 */
export function createSmtpMailer(options: SmtpMailerOptions): NotificationProvider {
  const send: MailSendFn =
    options.sendMail ??
    (() => {
      const transport: Transporter =
        options.transporter ??
        nodemailer.createTransport({
          host: options.host,
          port: options.port,
          secure: options.secure ?? false,
          auth:
            options.user && options.pass ? { user: options.user, pass: options.pass } : undefined,
        });
      return (mail: SendMailOptions) => transport.sendMail(mail);
    })();
  const from = options.from ?? "allinone@localhost";
  return {
    name: "smtp",
    async send(message: NotificationMessage): Promise<void> {
      if (!message.to) throw new Error("[allinone/infra] Notification requires a recipient");
      if (!message.subject) throw new Error("[allinone/infra] Notification requires a subject");
      if (!message.body) throw new Error("[allinone/infra] Notification requires a body");
      await send({ from, to: message.to, subject: message.subject, html: message.body });
    },
  };
}

export const DEFAULT_TEMPLATES = {
  welcome: {
    subject: "Welcome to {{ appName }}",
    html: "<p>Welcome, {{ name }}! Your tenant is <b>{{ tenantName }}</b>.</p><p>Confirm your email to activate your account.</p>",
  },
  verification: {
    subject: "Verify your email",
    html: '<p>Click <a href="{{ verifyUrl }}">here</a> to verify your email address.</p>',
  },
  passwordReset: {
    subject: "Reset your password",
    html: '<p>We received a password reset request. <a href="{{ resetUrl }}">Reset now</a>.</p><p>If you did not request this, ignore this email.</p>',
  },
} satisfies Record<string, MailTemplate>;
