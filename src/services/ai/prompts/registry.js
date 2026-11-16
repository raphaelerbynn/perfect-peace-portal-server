// AI-0: prompts are code (ported from SchoolPro prompts/registry.ts). They
// live in this folder, are reviewed in the diff and roll back with a deploy.
// The school varies them through variables (name, tone), never by editing text.
//
// A prompt has two halves on purpose:
//   prefix(vars) the large stable part: who the assistant is, the school, the
//                tone, the rules. The same for every call in a day, so a
//                provider cache can hold it. Sent as the system instruction.
//   tail(vars)   the small per-request part: this question, this data.
//                Sent as the user message.
// Every prompt has a version. Bump it on ANY text change: run.js writes
// `<key>@<version>` to Ai_usage_log.prompt_version (and Ai_suggestion), so
// "the drafts got worse" can be traced to the text that wrote them.

const registry = new Map();

export const registerPrompt = (prompt) => {
  if (!prompt?.key || !String(prompt.key).trim()) throw new Error("A prompt needs a key");
  if (!prompt.version || !String(prompt.version).trim()) throw new Error(`Prompt "${prompt.key}" needs a version`);
  if (typeof prompt.prefix !== "function" || typeof prompt.tail !== "function") {
    throw new Error(`Prompt "${prompt.key}" needs prefix(vars) and tail(vars) functions`);
  }
  const existing = registry.get(prompt.key);
  // Re-registering the same object is fine (a module imported twice); a
  // different prompt under a live key would make prompt_version ambiguous.
  if (existing && existing !== prompt) {
    throw new Error(`Prompt key "${prompt.key}" is already registered (version ${existing.version})`);
  }
  registry.set(prompt.key, prompt);
  return prompt;
};

export const getPrompt = (key) => {
  const prompt = registry.get(key);
  if (!prompt) {
    throw new Error(`No prompt registered for "${key}". Registered: ${[...registry.keys()].sort().join(", ") || "none"}`);
  }
  return prompt;
};

export const hasPrompt = (key) => registry.has(key);

/** { key: version } of what is deployed (handy when a usage row looks odd). */
export const livePromptVersions = () =>
  Object.fromEntries([...registry.values()].sort((a, b) => a.key.localeCompare(b.key)).map((p) => [p.key, p.version]));

/**
 * Render both halves. The result is what run.js takes:
 *   { key, version, promptVersion: "key@version", system, user }
 */
export const renderPrompt = (promptOrKey, vars = {}) => {
  const prompt = typeof promptOrKey === "string" ? getPrompt(promptOrKey) : promptOrKey;
  return {
    key: prompt.key,
    version: prompt.version,
    promptVersion: `${prompt.key}@${prompt.version}`,
    system: prompt.prefix(vars),
    user: prompt.tail(vars),
  };
};

/** Tests only. */
export const resetPromptRegistry = () => registry.clear();
