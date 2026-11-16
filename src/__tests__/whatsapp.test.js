// AI-5: the WhatsApp driver. log (default) never calls out; cloud posts plain
// text to the Cloud API (axios mocked: no real calls); errors never throw.
jest.mock("axios", () => ({ __esModule: true, default: { post: jest.fn() } }));

const axios = require("axios").default;
const { __resetWhatsApp, maskWhatsAppNumber, normalizeWhatsAppNumber, sendWhatsApp, whatsappConfig } = require("../services/whatsapp.js");

const ENV = { ...process.env };
let log;
beforeEach(() => {
  process.env = { ...ENV };
  delete process.env.WHATSAPP_DRIVER;
  delete process.env.WHATSAPP_TOKEN;
  delete process.env.WHATSAPP_PHONE_NUMBER_ID;
  __resetWhatsApp();
  axios.post.mockReset();
  log = jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());
afterAll(() => {
  process.env = ENV;
});

describe("numbers", () => {
  it.each([
    ["024 123 4567", "233241234567"],
    ["0241234567", "233241234567"],
    ["+233 24 123 4567", "233241234567"],
    ["233-20-123-4567", "233201234567"],
    ["+44 7700 900123", "447700900123"],
  ])("%s -> %s", (raw, out) => expect(normalizeWhatsAppNumber(raw)).toBe(out));
  it.each(["", "12345", "0123", "abc", "+233 12 345", "0141234567", "44 7700 900123"])("refuses %j", (raw) => expect(normalizeWhatsAppNumber(raw)).toBeNull());
  it("masks for logs", () => expect(maskWhatsAppNumber("233241234567")).toBe("+23324***67"));
});

describe("drivers", () => {
  it("log by default: logs a masked line, calls nothing", async () => {
    expect(whatsappConfig().driver).toBe("log");
    expect(await sendWhatsApp({ to: "0241234567", text: "Hello" })).toEqual({ status: "LOGGED" });
    expect(axios.post).not.toHaveBeenCalled();
    expect(log.mock.calls[0][0]).toContain("+23324***67");
    expect(log.mock.calls[0][0]).not.toContain("241234567");
  });
  it("cloud without a token falls back to log", async () => {
    process.env.WHATSAPP_DRIVER = "cloud";
    expect(whatsappConfig().driver).toBe("log");
    await sendWhatsApp({ to: "0241234567", text: "Hello" });
    expect(axios.post).not.toHaveBeenCalled();
  });
  it("off sends nothing", async () => {
    process.env.WHATSAPP_DRIVER = "off";
    expect(await sendWhatsApp({ to: "0241234567", text: "Hello" })).toEqual({ status: "OFF" });
    expect(axios.post).not.toHaveBeenCalled();
  });
  it("cloud posts plain text to the Cloud API with the token", async () => {
    Object.assign(process.env, { WHATSAPP_DRIVER: "cloud", WHATSAPP_TOKEN: "tok", WHATSAPP_PHONE_NUMBER_ID: "12345" });
    axios.post.mockResolvedValue({ data: { messages: [{ id: "wamid.1" }] } });
    expect(await sendWhatsApp({ to: "024 123 4567", text: "Briefing" })).toEqual({ status: "SENT", id: "wamid.1" });
    const [url, body, opts] = axios.post.mock.calls[0];
    expect(url).toBe("https://graph.facebook.com/v21.0/12345/messages");
    expect(body).toEqual({ messaging_product: "whatsapp", recipient_type: "individual", to: "233241234567", type: "text", text: { preview_url: false, body: "Briefing" } });
    expect(opts.headers.Authorization).toBe("Bearer tok");
  });
  it("cloud errors come back as FAILED with Meta's reason, never thrown, never the token", async () => {
    Object.assign(process.env, { WHATSAPP_DRIVER: "cloud", WHATSAPP_TOKEN: "secret-token", WHATSAPP_PHONE_NUMBER_ID: "12345" });
    axios.post.mockRejectedValue(Object.assign(new Error("Request failed"), { response: { status: 400, data: { error: { code: 131047, message: "Re-engagement message" } } } }));
    const res = await sendWhatsApp({ to: "0241234567", text: "Briefing" });
    expect(res).toEqual({ status: "FAILED", error: "131047 Re-engagement message" });
    expect(JSON.stringify(res)).not.toContain("secret-token");
  });
  it("a bad number or empty text fails without a call; long text is cut to 4096", async () => {
    Object.assign(process.env, { WHATSAPP_DRIVER: "cloud", WHATSAPP_TOKEN: "tok", WHATSAPP_PHONE_NUMBER_ID: "12345" });
    expect((await sendWhatsApp({ to: "123", text: "x" })).status).toBe("FAILED");
    expect((await sendWhatsApp({ to: "0241234567", text: "  " })).status).toBe("FAILED");
    expect(axios.post).not.toHaveBeenCalled();
    axios.post.mockResolvedValue({ data: {} });
    await sendWhatsApp({ to: "0241234567", text: "a".repeat(5000) });
    expect(axios.post.mock.calls[0][1].text.body).toHaveLength(4096);
  });
});
