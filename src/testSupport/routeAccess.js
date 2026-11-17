// B10: walk the Express app's router stack and work out, for every route,
// which office roles get past its role gates. A gate is any middleware with an
// `allowedRoles` list (authorizeRoles(...) and the news `writers` check).
// Gates on the app (app.use(path, authorizeRoles(...), router)) apply to every
// router mounted after them under that path, as Express runs them.
// A route with no gate at all is reported as "*" (no role check on the route;
// it may still need a token, or scope inside the service).
import { OFFICE_ROLES } from "../utils/roles.js";

const mountPath = (layer) => {
  if (layer.regexp?.fast_slash) return "";
  const src = layer.regexp?.source || "";
  return src
    .replace(/^\^/, "")
    .replace(/\\\/\?\(\?=\\\/\|\$\)$/, "")
    .replace(/\\\//g, "/");
};

const under = (gatePath, routePath) => gatePath === "" || routePath === gatePath || routePath.startsWith(`${gatePath}/`);

const gatesOf = (handles) => handles.filter((h) => Array.isArray(h?.allowedRoles));

/** [{ key: "GET /fees", gates: [[roles], ...] }] in stack order. */
export const collectRoutes = (app) => {
  const out = [];
  const appGates = []; // { path, roles }
  for (const layer of app._router.stack) {
    const base = mountPath(layer);
    if (Array.isArray(layer.handle?.allowedRoles)) {
      appGates.push({ path: base, roles: layer.handle.allowedRoles });
      continue;
    }
    if (layer.route) {
      walkRoute(layer.route, base, appGates, [], out);
      continue;
    }
    if (layer.name === "router" && Array.isArray(layer.handle?.stack)) {
      const routerGates = []; // router.use(path, gate)
      for (const inner of layer.handle.stack) {
        const innerBase = base + mountPath(inner);
        if (inner.route) {
          walkRoute(inner.route, base, appGates, routerGates, out);
        } else if (Array.isArray(inner.handle?.allowedRoles)) {
          routerGates.push({ path: innerBase, roles: inner.handle.allowedRoles });
        }
      }
    }
  }
  return out;
};

const walkRoute = (route, base, appGates, routerGates, out) => {
  const path = base + route.path;
  const methods = Object.keys(route.methods).filter((m) => route.methods[m] && m !== "_all");
  const own = gatesOf(route.stack.map((l) => l.handle)).map((h) => h.allowedRoles);
  const inherited = [...appGates, ...routerGates].filter((g) => under(g.path, path)).map((g) => g.roles);
  for (const m of methods) {
    out.push({ key: `${m.toUpperCase()} ${path}`, gates: [...inherited, ...own] });
  }
};

/** Which of `roles` pass every gate; "*" when the route has no gate. */
export const allowedFor = (gates, roles = OFFICE_ROLES) => {
  if (!gates.length) return "*";
  return roles.filter((r) => gates.every((g) => g.includes(r)));
};

/** { "GET /fees": "Administrator,Accountant" | "*" | "" }; a repeated key gets " #2". */
export const accessTable = (app, roles = OFFICE_ROLES) => {
  const table = {};
  for (const { key, gates } of collectRoutes(app)) {
    let k = key;
    for (let n = 2; table[k] !== undefined; n += 1) k = `${key} #${n}`;
    const a = allowedFor(gates, roles);
    table[k] = a === "*" ? "*" : a.join(",");
  }
  return table;
};
