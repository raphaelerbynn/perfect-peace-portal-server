// B16: the mailer (nodemailer mocked): driver choice, Gmail TLS by port,
// From name, falls back to log when not configured, never throws; the email
// template escapes everything.
const mockSendMail = jest.fn(async () => ({ messageId: "x" }));
jest.mock("nodemailer", () => ({ __esModule: true, default: { createTransport: jest.fn(() => ({ sendMail: mockSendMail })) } }));

import nodemailer from "nodemailer";
import { __resetMailer, fromHeader, isEmail, mailConfig, maskEmail, sendMail } from "../services/mailer.js";
import { escapeHtml, renderNotificationEmail, safeUrl } from "../utils/emailTemplate.js";

const ENV = { ...process.env };
const gmail = { EMAIL_DRIVER: "smtp", SMTP_HOST: "smtp.gmail.com", SMTP_USER: "pp.school@gmail.com", SMTP_PASS: "app-password", EMAIL_FROM: "pp.school@gmail.com", EMAIL_FROM_NAME: "Perfect Peace School" };
const mail = { to: "mum@example.com", subject: "Hi", text: "t", html: "<p>t</p>" };

beforeEach(() => {
  jest.clearAllMocks();
  __resetMailer();
  process.env = { ...ENV };
  for (const k of ["EMAIL_DRIVER", "SMTP_HOST", "SMTP_PORT", "SMTP_SECURE", "SMTP_USER", "SMTP_PASS", "EMAIL_FROM", "SMTP_FROM", "EMAIL_FROM_NAME", "EMAIL_DAILY_LIMIT"]) delete process.env[k];
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
});
afterAll(() => {
  process.env = ENV;
});

describe("mailConfig", () => {
  it("defaults to log, Gmail-safe daily limit", () => {
    expect(mailConfig()).toMatchObject({ driver: "log", dailyLimit: 450 });
  });

  it("smtp without credentials or From falls back to log (boot never breaks)", () => {
    process.env.EMAIL_DRIVER = "smtp";
    process.env.SMTP_HOST = "smtp.gmail.com";
    expect(mailConfig().driver).toBe("log");
    expect(console.warn).toHaveBeenCalledTimes(1);
    mailConfig();
    expect(console.warn).toHaveBeenCalledTimes(1); // warned once
  });

  it("unknown driver = log", () => {
    process.env.EMAIL_DRIVER = "sendgrid";
    expect(mailConfig().driver).toBe("log");
  });

  it("port 465 = TLS, 587 = STARTTLS, SMTP_SECURE overrides; From defaults to the user", () => {
    Object.assign(process.env, gmail, { SMTP_PORT: "465" });
    expect(mailConfig()).toMatchObject({ driver: "smtp", smtp: { port: 465, secure: true } });
    process.env.SMTP_PORT = "587";
    expect(mailConfig().smtp).toMatchObject({ port: 587, secure: false });
    process.env.SMTP_SECURE = "true";
    expect(mailConfig().smtp.secure).toBe(true);
    delete process.env.EMAIL_FROM;
    expect(mailConfig().fromAddress).toBe("pp.school@gmail.com");
  });
});

describe("sendMail", () => {
  it("log driver sends nothing and masks the address", async () => {
    await expect(sendMail(mail)).resolves.toEqual({ status: "LOGGED" });
    expect(nodemailer.createTransport).not.toHaveBeenCalled();
    expect(console.log.mock.calls[0][0]).toContain("m***@example.com");
    expect(console.log.mock.calls[0][0]).not.toContain("mum@");
  });

  it("smtp on 587 insists on STARTTLS and sends with the From name", async () => {
    Object.assign(process.env, gmail, { SMTP_PORT: "587" });
    await expect(sendMail(mail)).resolves.toEqual({ status: "SENT" });
    expect(nodemailer.createTransport).toHaveBeenCalledWith(expect.objectContaining({ host: "smtp.gmail.com", port: 587, secure: false, requireTLS: true, auth: { user: gmail.SMTP_USER, pass: gmail.SMTP_PASS } }));
    expect(mockSendMail).toHaveBeenCalledWith(expect.objectContaining({ from: '"Perfect Peace School" <pp.school@gmail.com>', to: "mum@example.com", subject: "Hi" }));
    await sendMail(mail);
    expect(nodemailer.createTransport).toHaveBeenCalledTimes(1); // transport reused
  });

  it("a provider failure is FAILED with a short reason, never thrown, no password", async () => {
    Object.assign(process.env, gmail, { SMTP_PORT: "465" });
    mockSendMail.mockRejectedValueOnce(Object.assign(new Error("Invalid login"), { responseCode: 535, response: "5.7.8 Username and Password not accepted" }));
    const res = await sendMail(mail);
    expect(res.status).toBe("FAILED");
    expect(res.error).toContain("535");
    expect(res.error).not.toContain("app-password");
  });

  it("a bad address fails without trying", async () => {
    Object.assign(process.env, gmail);
    await expect(sendMail({ ...mail, to: "not an email" })).resolves.toMatchObject({ status: "FAILED" });
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it("off driver does nothing", async () => {
    process.env.EMAIL_DRIVER = "off";
    await expect(sendMail(mail)).resolves.toEqual({ status: "OFF" });
  });
});

describe("helpers + template", () => {
  it("isEmail / maskEmail / fromHeader", () => {
    expect(isEmail("a@b.co")).toBe(true);
    expect(isEmail("a@b")).toBe(false);
    expect(isEmail("a b@c.co")).toBe(false);
    expect(isEmail(null)).toBe(false);
    expect(maskEmail("kofi@x.com")).toBe("k***@x.com");
    expect(fromHeader({ fromAddress: "a@b.co", fromName: 'Bad "name"\r\nBcc: x' })).toBe('"Bad nameBcc: x" <a@b.co>');
    expect(fromHeader({ fromAddress: "a@b.co", fromName: "" })).toBe("a@b.co");
  });

  it("escapes the title and body, keeps line breaks, only http(s) links", () => {
    const m = renderNotificationEmail({
      school: { name: "Perfect <Peace>", primaryColor: "red;background:url(x)" },
      title: '<script>alert(1)</script>',
      body: "Line 1\nLine 2\n\n<img src=x onerror=1>",
      url: "javascript:alert(1)",
    });
    expect(m.html).not.toContain("<script>");
    expect(m.html).not.toContain("<img");
    expect(m.html).toContain("Line 1<br>Line 2");
    expect(m.html).toContain("Perfect &lt;Peace&gt;");
    expect(m.html).not.toContain("javascript:");
    expect(m.html).not.toContain("url(x)"); // bad colour ignored
    expect(m.text).toContain("Line 1\nLine 2");
    expect(safeUrl("https://portal.example/fees")).toBe("https://portal.example/fees");
    expect(safeUrl("/fees")).toBeNull();
    expect(escapeHtml(`"'&`)).toBe("&quot;&#39;&amp;");
    const withLink = renderNotificationEmail({ school: {}, title: "T", body: "B", url: "https://portal.example/fees" });
    expect(withLink.html).toContain('href="https://portal.example/fees"');
    expect(withLink.text).toContain("Open: https://portal.example/fees");
  });
});
