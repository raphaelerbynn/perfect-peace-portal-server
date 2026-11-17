// B10: walk the Express app's router stack and find, for every route, the
// permission gates it passes through. A gate is any middleware with a
// `permissions` list (requirePermission(...keys): the caller needs ANY of the
// keys). Gates on the app (app.use(path, gate, router)) and on a router
// (router.use(path, gate)) apply to every route mounted after them under that
// path, as Express runs them.
// A route with no gate at all is reported as "*" (public, portal-only, or a
// caller's-own route; it may still need a token).

const mountPath = (layer) => {
  if (layer.regexp?.fast_slash) return "";
  const src = layer.regexp?.source || "";
  return src
    .replace(/^\^/, "")
    .replace(/\\\/\?\(\?=\\\/\|\$\)$/, "")
    .replace(/\\\//g, "/");
};

const under = (gatePath, routePath) => gatePath === "" || routePath === gatePath || routePath.startsWith(`${gatePath}/`);

const isGate = (h) => Array.isArray(h?.permissions);

/** [{ key: "GET /fees", gates: [[keys], ...] }] in stack order; a repeated key gets " #2". */
export const collectRoutes = (app) => {
  const out = [];
  const appGates = []; // { path, keys }
  for (const layer of app._router.stack) {
    const base = mountPath(layer);
    if (isGate(layer.handle)) {
      appGates.push({ path: base, keys: layer.handle.permissions });
      continue;
    }
    if (layer.route) {
      walkRoute(layer.route, base, appGates, [], out);
      continue;
    }
    if (layer.name === "router" && Array.isArray(layer.handle?.stack)) {
      const routerGates = [];
      for (const inner of layer.handle.stack) {
        const innerBase = base + mountPath(inner);
        if (inner.route) {
          walkRoute(inner.route, base, appGates, routerGates, out);
        } else if (isGate(inner.handle)) {
          routerGates.push({ path: innerBase, keys: inner.handle.permissions });
        }
      }
    }
  }
  const seen = new Map();
  return out.map((r) => {
    const n = (seen.get(r.key) || 0) + 1;
    seen.set(r.key, n);
    return n === 1 ? r : { ...r, key: `${r.key} #${n}` };
  });
};

const walkRoute = (route, base, appGates, routerGates, out) => {
  const path = base + route.path;
  const methods = Object.keys(route.methods).filter((m) => route.methods[m] && m !== "_all");
  const own = route.stack.map((l) => l.handle).filter(isGate).map((h) => h.permissions);
  const inherited = [...appGates, ...routerGates].filter((g) => under(g.path, path)).map((g) => g.keys);
  for (const m of methods) {
    out.push({ key: `${m.toUpperCase()} ${path}`, gates: [...inherited, ...own] });
  }
};

/** true / false: does a role holding `permissions` pass every gate; "*" when there is none. */
export const passes = (gates, permissions) => {
  if (!gates.length) return "*";
  const held = permissions instanceof Set ? permissions : new Set(permissions);
  return gates.every((keys) => keys.some((k) => held.has(k)));
};

/** { "GET /fees": "fees.view" | "billing.give_discounts|billing.discount_types" | "*" } */
export const permissionTable = (app) => {
  const table = {};
  for (const { key, gates } of collectRoutes(app)) {
    table[key] = gates.length ? gates.map((g) => g.join("|")).join(" + ") : "*";
  }
  return table;
};

/** For named roles { A: Set, CT: Set, … }: { "GET /fees": "A Acc" | "*" | "" } (names in the given order). */
export const accessTable = (app, roles) => {
  const table = {};
  for (const { key, gates } of collectRoutes(app)) {
    if (!gates.length) {
      table[key] = "*";
      continue;
    }
    table[key] = Object.entries(roles)
      .filter(([, perms]) => passes(gates, perms) === true)
      .map(([name]) => name)
      .join(" ");
  }
  return table;
};

/** The gated routes a role holding `permissions` reaches. */
export const reachableRoutes = (app, permissions) =>
  collectRoutes(app)
    .filter(({ gates }) => gates.length && passes(gates, permissions) === true)
    .map(({ key }) => key);
