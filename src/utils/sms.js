// AI-8 (and the A7 SMS box): how many characters and SMS parts a message is.
// The admin app has the same counter in src/utils/sms.js; keep the two alike.
//
// An SMS is sent in the plain GSM alphabet when every character is in it
// (160 characters in one part, 153 per part when it is split, so 306 for two;
// ^ { } [ ] ~ | \ € count as two), otherwise as Unicode (70 in one part, 67
// per part when split, so 134 for two).

const GSM_BASIC =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM_EXTENDED = "^{}\\[~]|€\f";
const BASIC = new Set([...GSM_BASIC]);
const EXTENDED = new Set([...GSM_EXTENDED]);

export const SMS_LIMITS = Object.freeze({
  GSM: { single: 160, perPart: 153 },
  UNICODE: { single: 70, perPart: 67 },
});
export const SMS_MAX_PARTS = 2;

const isGsm = (text) => [...text].every((ch) => BASIC.has(ch) || EXTENDED.has(ch));

/** The most characters that fit in `parts` SMS parts in this encoding. */
export const smsLimit = (parts, encoding = "GSM") => {
  const l = SMS_LIMITS[encoding] || SMS_LIMITS.GSM;
  const p = Math.max(1, Math.floor(Number(parts) || 1));
  return p === 1 ? l.single : l.perPart * p;
};

/** { encoding: "GSM" | "UNICODE", chars, parts, limitForParts } for a message. */
export const smsInfo = (input) => {
  const text = String(input ?? "");
  const encoding = isGsm(text) ? "GSM" : "UNICODE";
  const chars =
    encoding === "GSM"
      ? [...text].reduce((n, ch) => n + (EXTENDED.has(ch) ? 2 : 1), 0)
      : text.length; // UTF-16 code units (an emoji is two)
  const l = SMS_LIMITS[encoding];
  const parts = chars === 0 ? 0 : chars <= l.single ? 1 : Math.ceil(chars / l.perPart);
  return { encoding, chars, parts, limit: smsLimit(Math.max(parts, 1), encoding) };
};

// Typographic characters a model likes that would push a message into
// Unicode (half the room) for no reason. GH₵ becomes GHC, the usual SMS spelling.
const PLAIN = [
  [/[\u2018\u2019\u201A\u201B\u2032\u00B4`]/g, "'"],
  [/[\u201C\u201D\u201E\u201F\u2033]/g, '"'],
  [/[\u2013\u2014\u2015\u2212]/g, "-"],
  [/\u2026/g, "..."],
  [/[\u2022\u00B7]/g, "-"],
  [/\u20B5/g, "C"],
  [/[\u00A0\u2007\u202F\u2009\u200A]/g, " "],
  [/[\u200B-\u200D\uFEFF]/g, ""],
];

/** Plain-alphabet punctuation and tidy spacing (one blank line at most). */
export const normaliseSms = (input) => {
  let text = String(input ?? "");
  for (const [re, to] of PLAIN) text = text.replace(re, to);
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
};
