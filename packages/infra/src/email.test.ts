import { describe, expect, it } from "vitest";
import {
  createSmtpMailer,
  DEFAULT_TEMPLATES,
  escapeHtml,
  renderTemplate,
  type MailSendFn,
} from "./email.js";
import type { SendMailOptions } from "nodemailer";

function capture() {
  const sent: SendMailOptions[] = [];
  const sendMail: MailSendFn = async (mail: SendMailOptions) => {
    sent.push(mail);
  };
  return { sent, sendMail };
}

describe("escapeHtml", () => {
  it("escapes markup characters", () => {
    expect(escapeHtml('<script>alert("x")</script>')).toBe(
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;",
    );
    expect(escapeHtml("a & b")).toBe("a &amp; b");
  });
});

describe("renderTemplate", () => {
  it("interpolates and escapes values", () => {
    const html = renderTemplate(DEFAULT_TEMPLATES.welcome.html, {
      appName: "Acme",
      name: "<b>Ada</b>",
      tenantName: 'Acme" Inc',
    });
    expect(html).toContain("Acme");
    expect(html).toContain("&lt;b&gt;Ada&lt;/b&gt;");
    expect(html).toContain("Acme&quot; Inc");
  });

  it("renders unknown keys as empty strings", () => {
    expect(renderTemplate("hi {{ missing }}!", {})).toBe("hi !");
  });
});

describe("createSmtpMailer", () => {
  it("sends via the injected transport", async () => {
    const { sent, sendMail } = capture();
    const mailer = createSmtpMailer({ sendMail, from: "billing@acme.example" });
    await mailer.send({ to: "ada@example.com", subject: "Hi", body: "<p>x</p>", tenantId: "t1" });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe("ada@example.com");
    expect(sent[0]?.from).toBe("billing@acme.example");
    expect(sent[0]?.subject).toBe("Hi");
    expect(mailer.name).toBe("smtp");
  });

  it("rejects incomplete messages", async () => {
    const { sendMail } = capture();
    const mailer = createSmtpMailer({ sendMail });
    await expect(mailer.send({ to: "", subject: "s", body: "b", tenantId: "t" })).rejects.toThrow(
      /recipient/,
    );
    await expect(
      mailer.send({ to: "a@b.c", subject: "", body: "b", tenantId: "t" }),
    ).rejects.toThrow(/subject/);
    await expect(
      mailer.send({ to: "a@b.c", subject: "s", body: "", tenantId: "t" }),
    ).rejects.toThrow(/body/);
  });

  it("templates build full messages", async () => {
    const { sent, sendMail } = capture();
    const mailer = createSmtpMailer({ sendMail });
    const template = DEFAULT_TEMPLATES.verification;
    const html = renderTemplate(template.html, { verifyUrl: "https://app.example/v/abc" });
    await mailer.send({
      to: "ada@example.com",
      subject: template.subject,
      body: html,
      tenantId: "t1",
    });
    expect(sent[0]?.html).toContain("https://app.example/v/abc");
  });
});
