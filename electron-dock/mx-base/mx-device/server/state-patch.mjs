// Incremental updates of the /api/state payload (V2-4). The server diffs two
// payloads once per tick and streams the patch to every viewer; the browser
// applies it to its local model. Shared by server and client.
//
// Arrays of rows with an identity field are diffed by row: changed or new
// rows are sent whole, removed ones by id. A changed row keeps its place; new
// rows go to the end; `order` is sent only when that rule would put rows in a
// different order than the server's (never for unordered collections).
// Everything else is replaced when its JSON changes.

// Identity field per array path; arrays not listed are replaced wholesale.
const KEYS = {
  devices: "id",
  jobs: "id",
  attempts: "id",
  commands: "id",
  events: "id",
  apps: "id",
  accounts: "id",
  agents: "id",
  clients: "id",
  workers: "id",
  resources: "id",
  loopPolicies: "id",
  definitions: "id",
  commandDefinitions: "id",
  ruleDefinitions: "id",
  strategyDefinitions: "id",
  "scheduling.devices": "deviceId",
  "scheduling.queue": "jobId",
};
// Collections whose order the UI never relies on (it filters or sorts).
const UNORDERED = new Set(["attempts", "commands", "scheduling.devices"]);
// Objects whose fields are diffed one level down instead of replaced whole.
const NESTED = new Set(["scheduling"]);

const keyed = (path, value) =>
  Array.isArray(value) &&
  KEYS[path] &&
  value.every((row) => row && typeof row === "object" && KEYS[path] in row);

/** Row-JSON index of a payload, so the previous side is not re-serialized. */
export function indexState(state) {
  const index = new Map();
  const visit = (path, value) => {
    if (keyed(path, value)) {
      const rows = new Map();
      for (const row of value) rows.set(row[KEYS[path]], JSON.stringify(row));
      index.set(path, { rows, ids: value.map((row) => row[KEYS[path]]) });
    } else index.set(path, { json: JSON.stringify(value) });
  };
  for (const [key, value] of Object.entries(state))
    if (NESTED.has(key) && value && typeof value === "object")
      for (const [sub, inner] of Object.entries(value))
        visit(`${key}.${sub}`, inner);
    else visit(key, value);
  return index;
}

/** The patch from prev (as indexed) to next; null when nothing changed. */
export function diffState(prevIndex, next) {
  const nextIndex = indexState(next),
    patch = {};
  const lookup = (path) =>
    path.includes(".")
      ? next[path.split(".")[0]]?.[path.split(".")[1]]
      : next[path];
  for (const [path, now] of nextIndex) {
    const before = prevIndex?.get(path),
      value = lookup(path);
    if (!now.rows) {
      if (before?.json !== now.json) (patch.put ||= {})[path] = value;
      continue;
    }
    if (!before?.rows) {
      (patch.put ||= {})[path] = value;
      continue;
    }
    const key = KEYS[path],
      set = [],
      del = [];
    for (const row of value)
      if (before.rows.get(row[key]) !== now.rows.get(row[key])) set.push(row);
    for (const id of before.ids) if (!now.rows.has(id)) del.push(id);
    if (set.length) (patch.set ||= {})[path] = set;
    if (del.length) (patch.del ||= {})[path] = del;
    if (!UNORDERED.has(path)) {
      // What the client will rebuild: survivors in place, new rows appended.
      const kept = before.ids.filter((id) => now.rows.has(id));
      const added = now.ids.filter((id) => !before.rows.has(id));
      const rebuilt = [...kept, ...added];
      if (rebuilt.some((id, i) => id !== now.ids[i]))
        (patch.order ||= {})[path] = now.ids;
    }
  }
  for (const path of prevIndex?.keys() || [])
    if (!nextIndex.has(path)) (patch.put ||= {})[path] = undefined;
  return Object.keys(patch).length
    ? { patch, index: nextIndex }
    : { patch: null, index: nextIndex };
}

const getAt = (state, path) =>
  path.includes(".")
    ? state[path.split(".")[0]]?.[path.split(".")[1]]
    : state[path];
function setAt(state, path, value) {
  if (!path.includes(".")) {
    if (value === undefined) delete state[path];
    else state[path] = value;
    return;
  }
  const [top, sub] = path.split(".");
  state[top] = { ...(state[top] || {}) };
  if (value === undefined) delete state[top][sub];
  else state[top][sub] = value;
}

/** Applies a patch; returns a new top-level object (changed arrays are new). */
export function applyPatch(state, patch) {
  const next = { ...state };
  for (const [path, value] of Object.entries(patch.put || {}))
    setAt(next, path, value);
  const paths = new Set([
    ...Object.keys(patch.set || {}),
    ...Object.keys(patch.del || {}),
    ...Object.keys(patch.order || {}),
  ]);
  for (const path of paths) {
    const key = KEYS[path];
    const rows = new Map(
      (getAt(next, path) || []).map((row) => [row[key], row]),
    );
    for (const id of patch.del?.[path] || []) rows.delete(id);
    for (const row of patch.set?.[path] || []) rows.set(row[key], row);
    const order = patch.order?.[path];
    setAt(
      next,
      path,
      order
        ? order.map((id) => rows.get(id)).filter(Boolean)
        : [...rows.values()],
    );
  }
  return next;
}
