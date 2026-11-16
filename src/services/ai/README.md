# Shared AI infrastructure (AI-0)

Everything an AI feature (AI-1 Ask, AI-3 papers, AI-5 briefing, AI-8 announcements, …) needs:
the Gemini client, versioned prompts, the usage log, the monthly GH₵ cap, the switches, the
draft-and-approve store and redaction. Ported from SchoolPro (`teacher-ai` worktree,
`schoolpro-server/src/ai/`), reduced to one school with no plans or credits.

**Rules every feature keeps**

1. Call the model only through `run.js` (`runJson` / `runText` / `runChat` / `streamText` /
   `runToolLoop`). They check the switches and the cap, scrub contact data, log usage, and turn
   failures into friendly errors. Never import `@google/genai` or `providers/*` in feature code.
2. Every AI result is a **draft** (`Ai_suggestion`) that a person edits/accepts/rejects. Nothing
   reaches parents, report cards or the record until a person accepts it.
3. Never send contact data: build the context from the fields you need, and pass anything
   from the database through `redactForAi()` (tool results are done for you).
4. AI is optional: when a feature is off or over the cap the page must still work by hand.
5. No real API calls in tests: use `setAiProviderForTests(createFakeProvider([...]))`.

## Files

| File | What |
|---|---|
| `constants.js` | Feature keys, **the role table** (`AI_FEATURE_INFO`), error classes, statuses, default tone |
| `config.js` | Env (`aiConfig()`), the per-model price table (`priceFor`) |
| `errors.js` | `AiProviderError` (classified), `AiUnavailableError` (403 `AI_DISABLED`), `AiQuotaError` (429 `AI_QUOTA`), `toUserError` |
| `client.js` | Timeout, retry/backoff, error classification, JSON schema check + one malformed retry, tools, streaming. Unmetered |
| `providers/gemini.js` | The only file that knows Gemini (request/response translation, SDK loaded lazily) |
| `providers/fake.js` | Scripted provider for tests; `AI_FAKE_PROVIDER=1` for local clicking-through (never in production) |
| `run.js` | **The metered calls features use** |
| `gate.js` | `requireAiFeature()` middleware, `assertAiFeatureOn()`, `aiStatusFor()` |
| `settings.js` | `Ai_settings` (one row): school switch, per-feature switches, cap, tone |
| `usage.js` | `recordUsage`, `costOf`, `budgetState`, `assertWithinBudget`, `usageSummary`, `actorOf` |
| `suggestions.js` | Draft store + `registerAcceptHandler` |
| `redact.js` | `redactForAi(value)`, `redactText(text)` |
| `prompts/` | `registry.js` (register/render, versions), `base.js` (`schoolPreamble`, `toneLines`), `index.js` (imports every prompt) |
| `index.js` | Barrel: `import * as ai from "../services/ai/index.js"` |

Routes: `src/routes/aiRoutes.js`. Migration: `db/migrations/043_ai_infrastructure.sql`.
Models: `AiUsageLog`, `AiSuggestion`, `AiSettings`. Tests: `src/__tests__/ai*.test.js`.

## Switches: when does a call run?

All four must be true, checked in this order by `requireAiFeature` and again by `run.js`:

1. **Role** (`AI_FEATURE_INFO[feature].office` / `.portal`; 403). There is no B10 permission
   system yet, so that table *is* the permission check; `gate.js#roleAllowed` is the one place to
   swap when B10 lands.
   | Feature | Office roles | Portal |
   |---|---|---|
   | `ASK` | Administrator, Accountant (AI-1 limits the Accountant to finance tools) | – |
   | `PAPERS` | Administrator | `STAFF` (teachers) |
   | `BRIEFING`, `ANNOUNCEMENTS` | Administrator | – |
   | `REMARKS`, `AT_RISK`, `EXPLAIN`, `DOCUMENTS` | Administrator (switched off, not built) | – |
2. **Server**: `AI_ENABLED=true` and `GEMINI_API_KEY` set (reason `SERVER_OFF` / `NO_KEY`).
3. **School**: Settings → AI master switch (`SCHOOL_OFF`). Starts off.
4. **Feature**: its switch (`FEATURE_OFF`). The four built features default on, the rest off.

Then the **budget**: this calendar month's (UTC = Ghana time) `SUM(cost_ghs)` must be below the
cap (`Ai_settings.monthly_cap_ghs`, or `AI_MONTHLY_BUDGET_GHS` when empty). At or over → 429
`AI_QUOTA` and a `BLOCKED` usage row. Calls already in flight may finish, so the cap can be passed
by a few pesewas.

Error bodies the frontends read: `{ message, code: "AI_DISABLED", reason, feature }`,
`{ message, code: "AI_QUOTA", spentGhs, capGhs, period }`, `{ message, code: "AI_FAILED", errorClass }`.
Messages are written for staff and say the task can still be done by hand.

## Adding a feature (checklist)

1. Pick its key in `constants.js` (the four planned ones exist). A new key needs no migration.
2. Prompt: `prompts/<feature>.js` with `registerPrompt({ key, version, prefix, tail })`, imported
   from `prompts/index.js`.
3. Service: build the facts (only the fields you need, through `redactForAi`), call
   `runJson`/`runText`/`runToolLoop`, store the result with `createSuggestion`.
4. Accept handler: `registerAcceptHandler("<FEATURE>", handler)` at import of the feature's service.
5. Route: `requireAiFeature("<FEATURE>")` in the right router (mount order in `src/index.js`).
6. Migration if the feature needs its own tables: **044–046 are reserved** for AI-1/3/5/8.
7. Tests with the fake provider; add the page using the shared UI pieces below.

## Calling the model

```js
import { renderPrompt, runJson, runText, createSuggestion } from "../services/ai/index.js";
import { getSchoolSettings } from "../services/school.js";

const school = await getSchoolSettings();
const prompt = renderPrompt("announcement", { schoolName: school.name, tone: settings.tone, notes });
const { data, model, promptVersion, costGhs } = await runJson({
  feature: "ANNOUNCEMENTS",
  user: req.user,                       // logged as OFFICE:<username> / STAFF:<teacherId>
  prompt,                               // { system, user, promptVersion }
  schema: { type: "object", required: ["title", "body"], properties: { title: { type: "string", maxLength: 120 }, body: { type: "string" } } },
  validate: (d) => (mentionsDateNotGiven(d, notes) ? "the notice invented a date" : null), // optional
  // model, temperature, maxOutputTokens, timeoutMs, signal: optional
});
```

- `runJson` sends the schema as Gemini's `responseJsonSchema` **and** checks it (plus your
  `validate`). A bad answer is retried **once** with a note saying what was wrong; a second bad
  answer is `MALFORMED_OUTPUT` (502). Tokens from both attempts are logged.
- `runText` → `{ text }`. `runChat({ messages, tools })` → one model turn `{ text, toolCalls }`.
- Retries: `RATE_LIMIT` (429/503) and `TIMEOUT` are retried with exponential backoff + jitter
  (`AI_MAX_RETRIES`, default 2); `SAFETY_BLOCK` and `AUTH` never. Timeout per attempt
  `AI_REQUEST_TIMEOUT_MS` (60 s).
- Errors come out as an exposable `AppError` (`code: "AI_FAILED"`, `errorClass`): just `next(error)`.
- A cron job (AI-5 briefing) has no `req`: pass `user: null` (logged with no user); the switches
  and cap are still checked by `run.js`.

### Tools (AI-1) and streaming

```js
const { text, toolsUsed } = await runToolLoop({
  feature: "ASK", user: req.user, prompt,
  tools: [{ name: "count_owing", description: "…", parameters: { type: "object", properties: { classId: { type: "integer" } } },
            handler: async (args, { user }) => countOwing(args) }],   // results are redacted for you
  maxIterations: 5,                                                   // default AI_MAX_TOOL_ITERATIONS
});
```

Each model turn is a separate metered call (switches and cap re-checked, one usage row per
turn), so a loop stops at the cap. Tool results are passed through `redactForAi` and cut to
12,000 characters (the model is told). A handler that throws becomes `{ error }` for the model.
Pass only the tools the caller's role may use (e.g. the Accountant gets finance tools only).
Gemini 3 thought signatures on tool calls are kept and replayed (`providerSignature`).

Streaming: `for await (const chunk of streamText({ feature, user, prompt, messages }))` yields
`{ type: "text", text }`, `{ type: "tool_call", call }`, `{ type: "usage" }`, `{ type: "done" }`;
usage is logged when the stream ends. Writing SSE (`res.write("data: …\n\n")`) and wiring
`signal` to `req.on("close")` is the feature's job. A streamed tool loop is not built: for AI-1
either run `runToolLoop` for the tool rounds and stream only the final answer, or extend
`run.js` with a streaming loop next to `runToolLoop`.

## Prompts and versions

```js
// prompts/announcement.js
import { registerPrompt } from "./registry.js";
import { schoolPreamble, toneLines } from "./base.js";
export const ANNOUNCEMENT_PROMPT = registerPrompt({
  key: "announcement",
  version: "1.0.0",                 // bump on ANY text change
  prefix: (v) => [schoolPreamble(v), ...toneLines(v.tone), "Task: write a notice for parents…"].join("\n"),
  tail: (v) => `Notes from the office:\n${v.notes}`,
});
```
then add `import "./announcement.js";` to `prompts/index.js`. `renderPrompt(key, vars)` returns
`{ system, user, promptVersion: "announcement@1.0.0" }`; `run.js` writes `promptVersion` to every
usage row, and you store it on the suggestion. Keep the prefix stable (school, tone, rules) and
the per-request data in the tail. Tone (Settings → AI): `{ formal, salutation, britishSpelling }`
from `getAiSettings().tone`; `toneLines(tone)` turns it into instructions.

## Usage and budget

`run.js` logs every call for you (`OK`, `ERROR` + `errorClass`, `BLOCKED` for the cap). Cost =
tokens × the model's USD price (`config.js` `MODEL_PRICES_USD_PER_MTOK`, estimates; override with
`AI_PRICES_JSON`; an unknown model is priced at the dearest row) × `AI_USD_TO_GHS`. Stored as
`cost_micros` (USD) and `cost_ghs`. Only if you call the client directly (you shouldn't) use
`recordUsage(...)` and `assertWithinBudget(...)` yourself. `budgetState()` gives
`{ spentGhs, capGhs, remainingGhs, percent, overCap }`.

## Drafts (suggestions)

```js
const draft = await createSuggestion({
  feature: "ANNOUNCEMENTS", entityType: "POST", entityId: null, field: null,
  content: data,                               // any JSON object (≤ 100 KB), shape is yours
  model, promptVersion, createdBy: actorOf(req.user),
});

// once, when your service module is imported:
registerAcceptHandler("ANNOUNCEMENTS", async (suggestion, { transaction, actor }) => {
  const post = await createPost(suggestion.content, { transaction, by: actor });   // use THIS transaction
  return { entityId: post.postId };            // optional: stored on the draft
}, { validateContent: (c) => (c.body?.trim() ? null : "The notice needs some text.") });   // optional, checked on create + edit
```

States: `PENDING → EDITED → ACCEPTED | REJECTED` (`PENDING → ACCEPTED | REJECTED` too).
Accept locks the row, runs your handler in the same transaction, then marks it ACCEPTED: a handler
that throws leaves the draft untouched, and a second accept returns the row without running the
handler again. A feature with no handler cannot be accepted (400). Edits/accept/reject of a final
draft are 409.

Office endpoints (Administrator), in `routes/aiRoutes.js`:

| Method | Path | |
|---|---|---|
| GET | `/ai/suggestions?feature&status=PENDING,EDITED&entityType&entityId&createdBy&page&limit` | list |
| GET | `/ai/suggestions/:id` | one |
| PATCH | `/ai/suggestions/:id` `{ content }` | edit |
| POST | `/ai/suggestions/:id/accept` · `/reject` | |

These work while AI is switched off (drafts already waiting are never stranded). For a
feature's own screens (e.g. a teacher's papers in the portal) add routes in the feature's router
and call the same service functions with `scope: { createdBy: actorOf(req.user) }`, so each
teacher sees and acts only on their own drafts (another's is a 404).

## Gating a route

```js
import { requireAiFeature } from "../services/ai/gate.js";

router.post("/ai/announcements/draft", requireAiFeature("ANNOUNCEMENTS"), handler);          // office router or its own
router.post("/teacher/papers/draft", requireAiFeature("PAPERS"), handler);                   // inside teacherRouter (staffToken already ran)
router.get("/teacher/papers", requireAiFeature("PAPERS", { budget: false }), listHandler);   // reads: skip the cap pre-check
```

It authenticates if no earlier middleware did, so it works on its own, after
`authenticateManagementUser`, or after the teacher router's `staffToken`. On success
`req.aiFeature` and `req.aiActor` are set. Put the route in the router that matches its token
type (mount order in `src/index.js`): portal-teacher routes under `/teacher/*`, office routes in a
router behind `authenticateManagementUser` or per-route auth like `aiRouter`.

Other endpoints: `GET /ai/status` (any signed-in user; their features with `{ available, reason }`,
budget only for the Administrator), `GET/PUT /ai/settings` and `GET /ai/usage` (Administrator).

## Shared UI

**Admin** (`perfectpeace-web-school-management`):
- `src/components/ai/AiDraftChip.jsx`: the "AI draft" / "Edited draft" / "Approved" / "Discarded" chip.
- `src/components/ai/AiSuggestionCard.jsx`: draft text + chip + edit / accept / reject row (`onAccept` etc., or uses the `/ai/suggestions` API itself).
- `src/components/ai/AiStates.jsx`: `AiDisabledState`, `AiQuotaState`, `AiEmptyState`, `AiErrorState` (picks the right one from an axios error), `AiUsageBar`.
- `src/components/ai/index.js`: barrel. API helpers: `src/utils/ai.js` (`fetchAiStatus`, settings, usage, suggestions, `aiErrorInfo`).
- Page: `src/pages/AiSettings.jsx` (Settings → AI, route `ai-settings`).

**Portal** (`Perfect-Peace`):
- `src/components/ai/AiDraftChip.jsx`, `src/components/ai/AiStates.jsx` (`AiDisabledState`, `AiQuotaState`, `AiErrorState`), `src/components/ai/index.js`.
- API helper: `src/utils/ai.js` (`fetchAiStatus`, `aiErrorInfo`). No pages yet (AI-3 adds them).

## Env

`AI_ENABLED` (default off), `GEMINI_API_KEY`, `AI_MODEL_DEFAULT` (`gemini-3.1-flash-lite`),
`AI_MONTHLY_BUDGET_GHS` (200), `AI_USD_TO_GHS` (15.5); optional `AI_REQUEST_TIMEOUT_MS`,
`AI_MAX_RETRIES`, `AI_RETRY_BASE_DELAY_MS`, `AI_MAX_TOOL_ITERATIONS`, `AI_PRICES_JSON`,
`AI_FAKE_PROVIDER` (dev only). Documented in `.env.example`.
