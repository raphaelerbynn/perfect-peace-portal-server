// B16: the notification email (HTML + plain text), branded with the school's
// name, contacts and colour (B18 settings). Everything is escaped.

export const escapeHtml = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const DEFAULT_BRAND = "#1e3a8a";

// Only http(s) links, so a stored link can't become javascript: in an email.
export const safeUrl = (u) => (typeof u === "string" && /^https?:\/\/[^\s"<>]+$/i.test(u) ? u : null);

/**
 * { school: {name, addressLines, phones, email, primaryColor}, title, body, url }
 * -> { subject, text, html }
 */
export const renderNotificationEmail = ({ school = {}, title, body, url }) => {
  const name = school.name || "Perfect Peace";
  const brand = HEX_RE.test(school.primaryColor || "") ? school.primaryColor : DEFAULT_BRAND;
  const link = safeUrl(url);
  const contact = [school.phones, school.email].filter(Boolean).join(" · ");
  const subject = `${title} - ${school.shortName || name}`.slice(0, 200);

  const text = [
    name,
    "",
    title,
    "",
    body || "",
    link ? `\nOpen: ${link}` : "",
    "",
    "This is an automatic message from the school. Please do not reply to it.",
    contact ? `Contact the school: ${contact}` : "",
  ]
    .filter((l) => l !== null)
    .join("\n");

  const paragraphs = escapeHtml(body || "")
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 12px">${p.replace(/\n/g, "<br>")}</p>`)
    .join("");

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif;color:#1f2937">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:8px;overflow:hidden">
<tr><td style="background:${brand};color:#ffffff;padding:18px 24px;font-size:18px;font-weight:bold">${escapeHtml(name)}</td></tr>
<tr><td style="padding:24px">
<h1 style="margin:0 0 16px;font-size:18px;color:#111827">${escapeHtml(title)}</h1>
${paragraphs}
${link ? `<p style="margin:20px 0 0"><a href="${escapeHtml(link)}" style="display:inline-block;background:${brand};color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:6px;font-weight:bold">Open</a></p>` : ""}
</td></tr>
<tr><td style="padding:16px 24px;border-top:1px solid #e5e7eb;font-size:12px;color:#6b7280">
This is an automatic message from the school. Please do not reply to it.${contact ? `<br>Contact the school: ${escapeHtml(contact)}` : ""}
</td></tr>
</table></td></tr></table>
</body></html>`;

  return { subject, text, html };
};
