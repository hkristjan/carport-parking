# Parking Builder — Phase A (data-driven world) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the app render and simulate entirely from a layout document, with today's carport as the first such document and identical on-screen behaviour.

**Architecture:** A `layout` document is the only source of truth. `compile(doc)` derives collision quads, a z-sorted draw list, bounds and bays; physics and rendering read only compiled output and never literals. Code is split into DOM-free namespaces (`geom`, `layout`, `registry`, `defaults`, `compile`) inside the existing single `index.html`, each shaped like a future ES module.

**Tech Stack:** Vanilla ES2020+, Canvas 2D, no dependencies, no build step. Tests via `node --test` over namespace blocks extracted from the HTML.

**Spec:** `docs/superpowers/specs/2026-09-07-parking-builder-design.md`

## Global Constraints

- **One self-contained `index.html`.** No build step, no runtime dependencies.
- **Must open by double-clicking the file.** `fetch()` and ES modules are both CORS-blocked over `file://` — the default layout is an inline literal, and namespaces are classic `<script>` blocks, never `import`.
- **World units are metres.** Origin at the top-left of the plan.
- **Zero behaviour change in Phase A.** Same collisions, same spawn, same pixels.
- **Every coordinate must be asserted finite on load.** A single `NaN` makes SAT return a
  bogus collision whose penetration depth is `NaN`, which then pushes the vehicle to `NaN`
  coordinates — it does not throw and it does not cleanly miss. Verified: `collide` returns
  `{d: NaN, nx: 1, ny: 0}` for an all-`NaN` quad.
- **Namespaces tagged `<script data-ns="…">` must be DOM-free and app-state-free** — the test harness runs them in a bare `vm` context with no `window` or `document`.
- **Never `git push`** without being asked (project CLAUDE.md).

## File Structure

| File | Responsibility |
|---|---|
| `index.html` (modify) | The app. Gains five `data-ns` script blocks before the existing main IIFE, which is progressively thinned |
| `test/extract.mjs` (create) | Pulls `data-ns` blocks out of `index.html`, runs them in a `vm` context, returns `App` |
| `test/geom.test.mjs` (create) | `App.geom` — SAT, wall quads, footprints |
| `test/layout.test.mjs` (create) | `App.layout` — validate, pack/unpack round-trip, migrate |
| `test/compile.test.mjs` (create) | `App.compile` — solids, runs, drawList, bounds |
| `CLAUDE.md` (modify) | Document namespaces, the test command, and the `file://` traps |

Namespace blocks go in dependency order: `geom`, `registry`, `layout`, `defaults`, `compile`, then the existing `<script>` main IIFE.

---

### Task 1: Test harness and the `geom` namespace

Extracts the four existing pure geometry functions into a testable namespace and adds the two new quad builders the builder needs. No behaviour change.

**Files:**
- Modify: `index.html:228` (insert blocks before `<script>`), `index.html:359-383` (remove the moved functions), `index.html:229-231` (add the destructuring alias)
- Create: `test/extract.mjs`, `test/geom.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `App.geom.cornersOf(c, spec) -> [[x,y],[x,y],[x,y],[x,y]]`
  - `App.geom.rectCorners(r) -> [[x,y]×4]` where `r` is `{x,y,w,h}`
  - `App.geom.collide(A, aA, B, aB) -> {d, nx, ny} | null`
  - `App.geom.pointInVehicle(x, y, v) -> boolean`
  - `App.geom.wallQuad(p, q, t) -> {corners: [[x,y]×4], a: number}` where `p`/`q` are `[x,y]`
  - `App.geom.rectQuad(cx, cy, w, h, a = 0) -> {corners: [[x,y]×4], a: number}`
  - `App.geom.bboxOf(corners) -> {x, y, w, h}`
  - `loadApp()` from `test/extract.mjs`

- [ ] **Step 1: Write the extractor**

Create `test/extract.mjs`:

```js
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const HTML = join(dirname(fileURLToPath(import.meta.url)), '..', 'index.html');

// Run the DOM-free namespace blocks from index.html in a bare context, in document
// order, and hand back the App they build. Blocks that touch document/window will
// throw here, which is the point: those belong in the main IIFE, not a namespace.
export function loadApp() {
  const html = readFileSync(HTML, 'utf8');
  const re = /<script data-ns="([\w-]+)">([\s\S]*?)<\/script>/g;
  const ctx = vm.createContext({});
  let m, count = 0;
  while ((m = re.exec(html))) {
    vm.runInContext(m[2], ctx, { filename: `index.html#${m[1]}` });
    count++;
  }
  if (count === 0) throw new Error('no <script data-ns="..."> blocks found in index.html');
  const App = vm.runInContext('globalThis.App', ctx);
  if (!App) throw new Error('namespace blocks did not define globalThis.App');
  return App;
}
```

- [ ] **Step 2: Write the failing test**

Create `test/geom.test.mjs`. The `wallQuad` test is the migration acceptance criterion checked up front: every one of today's eight wall-shaped obstacle boxes must survive a round trip through centreline-plus-thickness.

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './extract.mjs';

const { geom } = loadApp();
const round = n => { const r = Math.round(n * 1e6) / 1e6; return r === 0 ? 0 : r; }; // normalise -0

// The eight wall-shaped entries of today's staticObstacles, verbatim.
const BOXES = [
  { x: 2.25, y: 0.00, w: 0.22, h: 11.35 },
  { x: 2.55, y: 3.57, w: 7.95, h: 0.42 },
  { x: 2.55, y: 3.99, w: 0.10, h: 5.65 },
  { x: 10.40, y: 3.99, w: 0.10, h: 2.20 },
  { x: 10.40, y: 7.45, w: 0.10, h: 2.20 },
  { x: 2.50, y: 11.23, w: 2.00, h: 0.12 },
  { x: 10.90, y: 11.45, w: 7.70, h: 0.14 },
  { x: 0.00, y: 15.30, w: 18.6, h: 0.16 },
];

test('wallQuad reproduces every wall box exactly', () => {
  for (const r of BOXES) {
    const vertical = r.h > r.w, t = vertical ? r.w : r.h;
    const p = vertical ? [r.x + r.w / 2, r.y] : [r.x, r.y + r.h / 2];
    const q = vertical ? [r.x + r.w / 2, r.y + r.h] : [r.x + r.w, r.y + r.h / 2];
    const bb = geom.bboxOf(geom.wallQuad(p, q, t).corners);
    assert.deepEqual(
      [round(bb.x), round(bb.y), round(bb.w), round(bb.h)],
      [round(r.x), round(r.y), round(r.w), round(r.h)],
    );
  }
});

test('wallQuad angle follows the centreline', () => {
  assert.equal(round(geom.wallQuad([0, 0], [1, 0], 0.2).a), 0);
  assert.equal(round(geom.wallQuad([0, 0], [0, 1], 0.2).a), round(Math.PI / 2));
});

test('rectQuad centres on the given point', () => {
  const bb = geom.bboxOf(geom.rectQuad(5, 5, 2, 4).corners);
  assert.deepEqual([bb.x, bb.y, bb.w, bb.h], [4, 3, 2, 4]);
});

test('collide reports overlap for intersecting boxes and null otherwise', () => {
  const a = geom.rectCorners({ x: 0, y: 0, w: 2, h: 2 });
  assert.ok(geom.collide(a, 0, geom.rectCorners({ x: 1, y: 1, w: 2, h: 2 }), 0).d > 0);
  assert.equal(geom.collide(a, 0, geom.rectCorners({ x: 5, y: 5, w: 2, h: 2 }), 0), null);
  // touching edges are not a collision: overlap of exactly 0 returns null
  assert.equal(geom.collide(a, 0, geom.rectCorners({ x: 2, y: 0, w: 2, h: 2 }), 0), null);
});

test('a NaN coordinate corrupts collide rather than missing — hence validation on load', () => {
  // Every projection is NaN, so both `overlap <= 0` and `overlap < best.d` are false
  // (all NaN comparisons are). collide never returns null; it returns a bogus MTV with
  // d = NaN, and applying that puts the vehicle at NaN. Silent corruption, not a clean miss.
  const a = geom.rectCorners({ x: 0, y: 0, w: 2, h: 2 });
  const bad = [[NaN, NaN], [NaN, NaN], [NaN, NaN], [NaN, NaN]];
  const hit = geom.collide(a, 0, bad, 0);
  assert.ok(hit && Number.isNaN(hit.d));
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test test/*.test.mjs`
Expected: FAIL — `no <script data-ns="..."> blocks found in index.html`

- [ ] **Step 4: Add the geom namespace block**

In `index.html`, immediately **before** line 228's `<script>`, insert:

```html
<script data-ns="geom">
globalThis.App = globalThis.App || {};
App.geom = (() => {
  'use strict';
  function cornersOf(c, spec) {
    const ca = Math.cos(c.a), sa = Math.sin(c.a), hl = spec.len / 2, hw = spec.wid / 2;
    return [[hl, hw], [hl, -hw], [-hl, -hw], [-hl, hw]].map(([px, py]) => [c.x + px * ca - py * sa, c.y + px * sa + py * ca]);
  }
  const rectCorners = r => [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]];
  // SAT between two oriented boxes; returns minimum translation vector for A, or null
  function collide(A, aA, B, aB) {
    const axes = [[Math.cos(aA), Math.sin(aA)], [-Math.sin(aA), Math.cos(aA)], [Math.cos(aB), Math.sin(aB)], [-Math.sin(aB), Math.cos(aB)]];
    let best = null;
    for (const [ax, ay] of axes) {
      let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
      for (const [x, y] of A) { const p = x * ax + y * ay; a0 = Math.min(a0, p); a1 = Math.max(a1, p); }
      for (const [x, y] of B) { const p = x * ax + y * ay; b0 = Math.min(b0, p); b1 = Math.max(b1, p); }
      const overlap = Math.min(a1, b1) - Math.max(a0, b0);
      if (overlap <= 0) return null;
      if (!best || overlap < best.d) { const s = (a0 + a1) / 2 < (b0 + b1) / 2 ? -1 : 1; best = { d: overlap, nx: ax * s, ny: ay * s }; }
    }
    return best;
  }
  function pointInVehicle(x, y, v) {
    const dx = x - v.x, dy = y - v.y, ca = Math.cos(v.a), sa = Math.sin(v.a);
    const lx = dx * ca + dy * sa, ly = -dx * sa + dy * ca;
    return Math.abs(lx) <= v.spec.len / 2 + 0.15 && Math.abs(ly) <= v.spec.wid / 2 + 0.15;
  }
  // A wall is its centreline p->q extruded t/2 either side: one oriented box.
  function wallQuad(p, q, t) {
    const a = Math.atan2(q[1] - p[1], q[0] - p[0]);
    const nx = -Math.sin(a) * t / 2, ny = Math.cos(a) * t / 2;
    return { corners: [[p[0] + nx, p[1] + ny], [q[0] + nx, q[1] + ny], [q[0] - nx, q[1] - ny], [p[0] - nx, p[1] - ny]], a };
  }
  // Item footprint: a w x h box centred on (cx, cy), rotated by a.
  function rectQuad(cx, cy, w, h, a = 0) {
    const ca = Math.cos(a), sa = Math.sin(a), hw = w / 2, hh = h / 2;
    return { corners: [[hw, hh], [hw, -hh], [-hw, -hh], [-hw, hh]].map(([x, y]) => [cx + x * ca - y * sa, cy + x * sa + y * ca]), a };
  }
  function bboxOf(corners) {
    const xs = corners.map(c => c[0]), ys = corners.map(c => c[1]);
    const x = Math.min(...xs), y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
  }
  return { cornersOf, rectCorners, collide, pointInVehicle, wallQuad, rectQuad, bboxOf };
})();
</script>
```

- [ ] **Step 5: Delete the originals and alias them in the main IIFE**

Delete `index.html:359-383` — `cornersOf`, `rectCorners`, the `// SAT between…` comment, `collide` and `pointInVehicle`. Keep the `// ---------- Simulation` comment that follows.

Then immediately after `'use strict';` (line 231) add:

```js
const { cornersOf, rectCorners, collide, pointInVehicle } = App.geom;
```

Every existing call site (lines 317, 423, and inside `step`/`pointerdown`) then works unchanged.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test test/*.test.mjs`
Expected: PASS, 5 tests

- [ ] **Step 7: Verify the app still runs**

Run: `python3 -c "import re;s=open('index.html').read();open('/tmp/s.js','w').write(re.search(r'<script>(.*?)</script>',s,re.S).group(1))" && node --check /tmp/s.js`
Expected: no output (syntax OK)

Then open `index.html`, confirm the console is clean, drive into a wall and confirm the collision counter still increments.

- [ ] **Step 8: Commit**

```bash
git add index.html test/
git commit -m "Extract pure geometry into App.geom with a node --test harness"
```

---

### Task 2: The `layout` namespace — schema, validation, pack/unpack

Pure document handling. Not yet wired into the app.

**Files:**
- Modify: `index.html` (insert the `layout` block after the `registry` block position — for now, directly after `geom`)
- Create: `test/layout.test.mjs`

**Interfaces:**
- Consumes: `App.geom` (nothing yet, but declared as the dependency order).
- Produces:
  - `App.layout.VERSION` → `1`
  - `App.layout.validate(doc) -> string[]` (empty array means valid)
  - `App.layout.pack(doc) -> object` (plain, JSON-safe, deep-cloned)
  - `App.layout.unpack(json) -> {doc} | {errors: string[]}`
  - `App.layout.migrate(doc) -> doc`
  - `App.layout.blank(name) -> doc`

- [ ] **Step 1: Write the failing test**

Create `test/layout.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './extract.mjs';

const { layout } = loadApp();

const good = () => ({
  v: 1, id: 'lay_test', name: 'T',
  plot: { w: 10, h: 10 },
  nodes: { a: [1, 1], b: [5, 1] },
  walls: [{ id: 'w1', from: 'a', to: 'b', t: 0.2, type: 'wall' }],
  areas: [], items: [],
  bays: [{ id: 'bay1', rect: [2, 3, 2.5, 5], a: 0, label: 'Bay 1' }],
  dims: [], spawn: { at: [8, 8], a: 0 },
  brief: { targets: [], vehicles: [], notes: '' },
});

test('a well-formed document validates', () => {
  assert.deepEqual(layout.validate(good()), []);
});

test('blank() produces a valid document', () => {
  assert.deepEqual(layout.validate(layout.blank('My plot')), []);
});

test('pack/unpack round-trips exactly', () => {
  const doc = good();
  const back = layout.unpack(layout.pack(doc));
  assert.ok(back.doc, JSON.stringify(back.errors));
  assert.deepEqual(back.doc, doc);
});

test('pack returns a deep clone, not the same objects', () => {
  const doc = good();
  const packed = layout.pack(doc);
  packed.nodes.a[0] = 999;
  assert.equal(doc.nodes.a[0], 1);
});

test('a wall referencing a missing node is rejected', () => {
  const doc = good(); doc.walls[0].to = 'nope';
  assert.match(layout.validate(doc).join(), /unknown node/);
});

test('a zero-length wall is rejected', () => {
  const doc = good(); doc.nodes.b = [1, 1];
  assert.match(layout.validate(doc).join(), /zero-length/);
});

test('non-positive thickness is rejected', () => {
  const doc = good(); doc.walls[0].t = 0;
  assert.match(layout.validate(doc).join(), /thickness/);
});

test('a non-finite coordinate is rejected', () => {
  const doc = good(); doc.nodes.a = [NaN, 1];
  assert.match(layout.validate(doc).join(), /finite/);
});

test('an area polygon with fewer than three points is rejected', () => {
  const doc = good(); doc.areas.push({ id: 'a1', type: 'gravel', poly: [[0, 0], [1, 1]] });
  assert.match(layout.validate(doc).join(), /at least 3/);
});

test('unpack refuses a future schema version', () => {
  const doc = good(); doc.v = 99;
  const r = layout.unpack(doc);
  assert.ok(!r.doc);
  assert.match(r.errors.join(), /newer/);
});

test('unpack rejects non-objects without throwing', () => {
  for (const bad of [null, 'x', 7, []]) assert.ok(layout.unpack(bad).errors.length);
});

test('unknown top-level keys survive a round trip', () => {
  const doc = good(); doc.futureThing = { hello: 1 };
  const back = layout.unpack(layout.pack(doc));
  assert.deepEqual(back.doc.futureThing, { hello: 1 });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/layout.test.mjs`
Expected: FAIL — `Cannot read properties of undefined (reading 'validate')`

- [ ] **Step 3: Add the layout namespace block**

Insert after the `geom` block in `index.html`:

```html
<script data-ns="layout">
globalThis.App = globalThis.App || {};
App.layout = (() => {
  'use strict';
  const VERSION = 1;
  const ARRAYS = ['walls', 'areas', 'items', 'bays', 'dims'];
  const fin = n => typeof n === 'number' && Number.isFinite(n);
  const isPt = p => Array.isArray(p) && p.length === 2 && fin(p[0]) && fin(p[1]);

  function validate(doc) {
    const e = [];
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return ['document must be an object'];
    if (doc.v !== VERSION) e.push(`schema version must be ${VERSION}`);
    if (!doc.plot || !fin(doc.plot.w) || !fin(doc.plot.h) || doc.plot.w <= 0 || doc.plot.h <= 0)
      e.push('plot must have finite positive w and h');
    if (!doc.nodes || typeof doc.nodes !== 'object') e.push('nodes must be an object');
    for (const [id, p] of Object.entries(doc.nodes || {}))
      if (!isPt(p)) e.push(`node ${id} must be a pair of finite numbers`);
    for (const k of ARRAYS) if (!Array.isArray(doc[k])) e.push(`${k} must be an array`);

    for (const w of doc.walls || []) {
      const p = (doc.nodes || {})[w.from], q = (doc.nodes || {})[w.to];
      if (!p) e.push(`wall ${w.id} references unknown node ${w.from}`);
      if (!q) e.push(`wall ${w.id} references unknown node ${w.to}`);
      if (!fin(w.t) || w.t <= 0) e.push(`wall ${w.id} thickness must be finite and > 0`);
      if (p && q && Math.hypot(q[0] - p[0], q[1] - p[1]) < 1e-6) e.push(`wall ${w.id} is zero-length`);
      if (typeof w.type !== 'string') e.push(`wall ${w.id} needs a type`);
    }
    for (const a of doc.areas || []) {
      if (!Array.isArray(a.poly) || a.poly.length < 3) e.push(`area ${a.id} needs at least 3 points`);
      else for (const p of a.poly) if (!isPt(p)) e.push(`area ${a.id} has a non-finite point`);
    }
    for (const it of doc.items || []) {
      if (!isPt(it.at)) e.push(`item ${it.id} position must be finite`);
      if (!fin(it.a)) e.push(`item ${it.id} angle must be finite`);
    }
    for (const b of doc.bays || []) {
      if (!Array.isArray(b.rect) || b.rect.length !== 4 || !b.rect.every(fin))
        e.push(`bay ${b.id} rect must be four finite numbers`);
      else if (b.rect[2] <= 0 || b.rect[3] <= 0) e.push(`bay ${b.id} must have positive size`);
    }
    for (const d of doc.dims || []) if (!isPt(d.from) || !isPt(d.to)) e.push('a dim has non-finite ends');
    if (!doc.spawn || !isPt(doc.spawn.at) || !fin(doc.spawn.a)) e.push('spawn must be finite');
    if (!doc.brief || !Array.isArray(doc.brief.targets) || !Array.isArray(doc.brief.vehicles))
      e.push('brief needs targets and vehicles arrays');
    return e;
  }

  const pack = doc => JSON.parse(JSON.stringify(doc));

  function migrate(doc) { return doc; }   // no migrations yet; chain grows from v2

  function unpack(json) {
    if (!json || typeof json !== 'object' || Array.isArray(json)) return { errors: ['document must be an object'] };
    if (typeof json.v === 'number' && json.v > VERSION) return { errors: [`document is newer (v${json.v}) than this client (v${VERSION})`] };
    const doc = migrate(pack(json));
    const errors = validate(doc);
    return errors.length ? { errors } : { doc };
  }

  const blank = name => ({
    v: VERSION, id: 'lay_' + Math.random().toString(36).slice(2, 10), name: name || 'Untitled',
    plot: { w: 20, h: 16 }, nodes: {}, walls: [], areas: [], items: [], bays: [], dims: [],
    spawn: { at: [18, 14], a: Math.PI }, brief: { targets: [], vehicles: [], notes: '' },
  });

  return { VERSION, validate, pack, unpack, migrate, blank };
})();
</script>
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/*.test.mjs`
Expected: PASS, all tests

- [ ] **Step 5: Commit**

```bash
git add index.html test/layout.test.mjs
git commit -m "Add App.layout: schema, validation and pack/unpack"
```

---

### Task 3: The `registry` namespace and today's scene as a document

Converts today's literals into `App.defaults.carport` and proves the conversion is exact against the literals still present in the file.

**Files:**
- Modify: `index.html` (insert `registry` block after `geom`, `defaults` block after `layout`)
- Create: `test/defaults.test.mjs`

**Interfaces:**
- Consumes: `App.geom.wallQuad`, `App.geom.bboxOf`, `App.layout.validate`.
- Produces:
  - `App.registry.VEHICLE_Z` → `50`
  - `App.registry.get(type) -> {kind, solid, footprint?, layers} | null`
  - `App.registry.types` — the raw table
  - `App.defaults.carport` — the converted document

Registry entries carry metadata only in this task; `draw` functions arrive in Tasks 6 and 7.

- [ ] **Step 1: Write the failing test**

Create `test/defaults.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './extract.mjs';

const { geom, layout, registry, defaults } = loadApp();
const round = n => { const r = Math.round(n * 1e6) / 1e6; return r === 0 ? 0 : r; }; // normalise -0
const box = r => [round(r.x), round(r.y), round(r.w), round(r.h)];

// Today's nine staticObstacles, verbatim and in source order.
const TODAY = [
  { x: 2.25, y: 0.00, w: 0.22, h: 11.35, kind: 'wall' },
  { x: 8.13, y: 0.00, w: 10.47, h: 1.76, kind: 'deck' },
  { x: 2.55, y: 3.57, w: 7.95, h: 0.42, kind: 'frame' },
  { x: 2.55, y: 3.99, w: 0.10, h: 5.65, kind: 'frame' },
  { x: 10.40, y: 3.99, w: 0.10, h: 2.20, kind: 'post' },
  { x: 10.40, y: 7.45, w: 0.10, h: 2.20, kind: 'post' },
  { x: 2.50, y: 11.23, w: 2.00, h: 0.12, kind: 'curb' },
  { x: 10.90, y: 11.45, w: 7.70, h: 0.14, kind: 'fence' },
  { x: 0.00, y: 15.30, w: 18.6, h: 0.16, kind: 'fence' },
];

test('the default layout is a valid document', () => {
  assert.deepEqual(layout.validate(defaults.carport), []);
});

test('plot matches the old W and H', () => {
  assert.deepEqual(defaults.carport.plot, { w: 18.6, h: 15.6 });
});

test('every wall and the deck reproduce a staticObstacles box exactly', () => {
  const doc = defaults.carport;
  const got = doc.walls.map(w =>
    box(geom.bboxOf(geom.wallQuad(doc.nodes[w.from], doc.nodes[w.to], w.t).corners)));
  const deck = doc.items.find(i => i.type === 'deck');
  const fp = registry.get('deck').footprint;
  got.push(box(geom.bboxOf(geom.rectQuad(deck.at[0], deck.at[1], fp.w, fp.h, deck.a).corners)));

  const want = TODAY.map(box);
  assert.equal(got.length, want.length, 'must cover all nine obstacles');
  for (const w of want) assert.ok(got.some(gv => gv.join() === w.join()), `missing box ${w.join()}`);
});

test('the three bays carry over', () => {
  assert.deepEqual(defaults.carport.bays.map(b => b.rect), [
    [2.70, 4.05, 2.55, 5.55], [5.25, 4.05, 2.55, 5.55], [7.80, 4.05, 2.55, 5.55],
  ]);
});

test('both palms, five dims and the spawn carry over', () => {
  const doc = defaults.carport;
  assert.equal(doc.items.filter(i => i.type === 'palm').length, 2);
  assert.equal(doc.dims.length, 5);
  assert.deepEqual(doc.spawn.at, [16.4, 14.05]);
  assert.equal(round(doc.spawn.a), round(Math.PI));
});

test('every referenced type exists in the registry with a matching kind', () => {
  const doc = defaults.carport;
  for (const [arr, kind] of [['walls', 'wall'], ['areas', 'area'], ['items', 'item']])
    for (const o of doc[arr]) {
      const t = registry.get(o.type);
      assert.ok(t, `unknown type ${o.type}`);
      assert.equal(t.kind, kind, `${o.type} is kind ${t.kind}, used as ${kind}`);
    }
});

test('registry layers all have finite z and vehicles sit between them', () => {
  for (const [name, t] of Object.entries(registry.types)) {
    assert.ok(Array.isArray(t.layers) && t.layers.length, `${name} needs layers`);
    for (const l of t.layers) assert.ok(Number.isFinite(l.z), `${name} layer needs z`);
  }
  const zs = Object.values(registry.types).flatMap(t => t.layers.map(l => l.z));
  assert.ok(Math.min(...zs) < registry.VEHICLE_Z && Math.max(...zs) > registry.VEHICLE_Z,
    'some layers must paint under vehicles and some over');
});

test('pack/unpack round-trips the default layout', () => {
  const back = layout.unpack(layout.pack(defaults.carport));
  assert.ok(back.doc, JSON.stringify(back.errors));
  assert.deepEqual(back.doc, defaults.carport);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/defaults.test.mjs`
Expected: FAIL — cannot read `carport` of undefined

- [ ] **Step 3: Add the registry namespace block**

Insert after the `geom` block:

```html
<script data-ns="registry">
globalThis.App = globalThis.App || {};
App.registry = (() => {
  'use strict';
  // Vehicles paint in the middle of the scene, not on top: the carport floor and bay
  // outlines go under them, the slatted roof, palms and dimension lines over them.
  const VEHICLE_Z = 50, BAY_Z = 35, DIM_Z = 80;
  const types = {
    ground:  { kind: 'area', solid: false, layers: [{ z: 0,  fill: '#f8f9fa' }] },
    street:  { kind: 'area', solid: false, layers: [{ z: 5,  fill: '#e9ebee' }] },
    deck:    { kind: 'item', solid: true,  footprint: { w: 10.47, h: 1.76 }, layers: [{ z: 20 }] },
    path:    { kind: 'area', solid: false, layers: [{ z: 25, fill: '#bfc4ca' }] },
    apron:   { kind: 'area', solid: false, layers: [{ z: 26, fill: '#c9cdd3' }] },
    carport: { kind: 'item', solid: false, layers: [{ z: 30 }, { z: 60 }] },
    wall:    { kind: 'wall', solid: true,  layers: [{ z: 40, stroke: '#a3a8ae' }] },
    frame:   { kind: 'wall', solid: true,  layers: [{ z: 40, stroke: '#2c3335' }] },
    post:    { kind: 'wall', solid: true,  layers: [{ z: 40, stroke: '#2c3335' }] },
    curb:    { kind: 'wall', solid: true,  layers: [{ z: 40, stroke: '#8f949a' }] },
    fence:   { kind: 'wall', solid: true,  layers: [{ z: 40, stroke: '#3a4144' }] },
    palm:    { kind: 'item', solid: false, layers: [{ z: 70 }] },
  };
  return { VEHICLE_Z, BAY_Z, DIM_Z, types, get: t => types[t] || null };
})();
</script>
```

- [ ] **Step 4: Add the defaults namespace block**

Insert after the `layout` block. Node ids are `w<n>` for wall endpoints. Each wall's centreline is the box's long axis and `t` is its short dimension — verified exact by Task 1's test.

```html
<script data-ns="defaults">
globalThis.App = globalThis.App || {};
App.defaults = (() => {
  'use strict';
  // Today's hardcoded carport, converted once. An inline literal, never a fetched
  // .json file: fetch() is CORS-blocked over file:// and the app must open by
  // double-clicking index.html.
  const carport = {
    v: 1, id: 'lay_carport', name: 'Carport',
    plot: { w: 18.6, h: 15.6 },
    nodes: {
      a1: [2.36, 0], a2: [2.36, 11.35],           // boundary wall, t 0.22
      b1: [2.55, 3.78], b2: [10.50, 3.78],        // carport back beam, t 0.42
      c1: [2.60, 3.99], c2: [2.60, 9.64],         // carport left side, t 0.10
      d1: [10.45, 3.99], d2: [10.45, 6.19],       // right post, t 0.10
      e1: [10.45, 7.45], e2: [10.45, 9.65],       // right post, t 0.10
      f1: [2.50, 11.29], f2: [4.50, 11.29],       // kerb, t 0.12
      g1: [10.90, 11.52], g2: [18.60, 11.52],     // street fence, t 0.14
      h1: [0, 15.38], h2: [18.60, 15.38],         // south boundary fence, t 0.16
    },
    walls: [
      { id: 'w1', from: 'a1', to: 'a2', t: 0.22, type: 'wall' },
      { id: 'w2', from: 'b1', to: 'b2', t: 0.42, type: 'frame' },
      { id: 'w3', from: 'c1', to: 'c2', t: 0.10, type: 'frame' },
      { id: 'w4', from: 'd1', to: 'd2', t: 0.10, type: 'post' },
      { id: 'w5', from: 'e1', to: 'e2', t: 0.10, type: 'post' },
      { id: 'w6', from: 'f1', to: 'f2', t: 0.12, type: 'curb' },
      { id: 'w7', from: 'g1', to: 'g2', t: 0.14, type: 'fence' },
      { id: 'w8', from: 'h1', to: 'h2', t: 0.16, type: 'fence' },
    ],
    areas: [
      { id: 'ar0', type: 'ground', poly: [[0, 0], [18.6, 0], [18.6, 15.6], [0, 15.6]] },
      { id: 'ar1', type: 'street', poly: [[0, 11.6], [18.6, 11.6], [18.6, 15.6], [0, 15.6]] },
      { id: 'ar2', type: 'path',   poly: [[8.13, 1.76], [10.53, 1.76], [10.53, 3.57], [8.13, 3.57]] },
      { id: 'ar3', type: 'apron',  poly: [[2.55, 9.65], [10.50, 9.65], [10.50, 11.23], [2.55, 11.23]] },
    ],
    items: [
      { id: 'it1', type: 'deck',    at: [13.365, 0.88], a: 0 },
      { id: 'it2', type: 'carport', at: [6.525, 6.61],  a: 0 },
      { id: 'it3', type: 'palm',    at: [13.1, 1.4],    a: 0 },
      { id: 'it4', type: 'palm',    at: [16.7, 1.4],    a: 0 },
    ],
    bays: [
      { id: 'bay1', rect: [2.70, 4.05, 2.55, 5.55], a: 0, label: 'Bay 1' },
      { id: 'bay2', rect: [5.25, 4.05, 2.55, 5.55], a: 0, label: 'Bay 2' },
      { id: 'bay3', rect: [7.80, 4.05, 2.55, 5.55], a: 0, label: 'Bay 3' },
    ],
    dims: [
      { from: [2.55, 2.10],  to: [10.50, 2.10],  label: '7,98 m' },
      { from: [8.13, 2.90],  to: [10.53, 2.90],  label: '2,40 m' },
      { from: [2.60, 11.95], to: [4.60, 11.95],  label: '2,00 m' },
      { from: [4.60, 11.95], to: [10.60, 11.95], label: '6,00 m' },
      { from: [8.13, 1.35],  to: [18.60, 1.35],  label: '12,73 m' },
    ],
    spawn: { at: [16.4, 14.05], a: Math.PI },
    brief: { targets: [], vehicles: [], notes: '' },
  };
  return { carport };
})();
</script>
```

The `carport` item's `at` is the centre of the old `{x:2.55, y:3.57, w:7.95, h:6.08}` rect; its dimensions live in the renderer added in Task 7, since it is drawn furniture rather than a collision footprint.

- [ ] **Step 5: Run to verify it passes**

Run: `node --test test/*.test.mjs`
Expected: PASS, all tests

- [ ] **Step 6: Commit**

```bash
git add index.html test/defaults.test.mjs
git commit -m "Add App.registry and today's carport as App.defaults.carport"
```

---

### Task 4: The `compile` namespace

Turns a document into what physics and rendering consume.

**Files:**
- Modify: `index.html` (insert `compile` block after `defaults`)
- Create: `test/compile.test.mjs`

**Interfaces:**
- Consumes: `App.geom.wallQuad`, `App.geom.rectQuad`, `App.registry.get`, `App.registry.VEHICLE_Z`.
- Produces `App.compile(doc) ->`
  ```js
  { extent: {w, h},
    solids:   [ {corners, a} ],
    bounds:   [ {x, y, w, h} ],
    runs:     [ {type, t, z, stroke, points: [[x,y], …]} ],
    drawList: [ {z, type, kind, obj, layer} ],   // sorted ascending by z
    bays, dims, spawn, brief,
    warnings: [ string ] }
  ```

- [ ] **Step 1: Write the failing test**

Create `test/compile.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './extract.mjs';

const { layout, compile, defaults, registry } = loadApp();

const doc = (over = {}) => Object.assign(layout.blank('t'), over);

test('extent comes from the plot and bounds ring it', () => {
  const c = compile(doc({ plot: { w: 10, h: 8 } }));
  assert.deepEqual(c.extent, { w: 10, h: 8 });
  assert.equal(c.bounds.length, 4);
  // every bound lies outside the plot
  for (const b of c.bounds) assert.ok(b.x < 0 || b.y < 0 || b.x >= 10 || b.y >= 8);
});

test('the default layout compiles to exactly nine solids', () => {
  assert.equal(compile(defaults.carport).solids.length, 9);
});

test('non-solid types contribute no solids', () => {
  const c = compile(defaults.carport);
  assert.equal(c.solids.length, defaults.carport.walls.length + 1);  // 8 walls + deck
});

test('drawList is sorted by z and includes both carport layers', () => {
  const c = compile(defaults.carport);
  for (let i = 1; i < c.drawList.length; i++) assert.ok(c.drawList[i].z >= c.drawList[i - 1].z);
  const cp = c.drawList.filter(d => d.type === 'carport');
  assert.equal(cp.length, 2);
  assert.ok(cp[0].z < registry.VEHICLE_Z && cp[1].z > registry.VEHICLE_Z);
});

test('a chain through a degree-2 node becomes one run', () => {
  const c = compile(doc({
    nodes: { a: [0, 0], b: [5, 0], d: [5, 5] },
    walls: [{ id: 'w1', from: 'a', to: 'b', t: 0.2, type: 'wall' },
            { id: 'w2', from: 'b', to: 'd', t: 0.2, type: 'wall' }],
  }));
  assert.equal(c.runs.length, 1);
  assert.deepEqual(c.runs[0].points, [[0, 0], [5, 0], [5, 5]]);
});

test('a run splits at a thickness change', () => {
  const c = compile(doc({
    nodes: { a: [0, 0], b: [5, 0], d: [5, 5] },
    walls: [{ id: 'w1', from: 'a', to: 'b', t: 0.2, type: 'wall' },
            { id: 'w2', from: 'b', to: 'd', t: 0.4, type: 'wall' }],
  }));
  assert.equal(c.runs.length, 2);
});

test('a run splits at a degree-3 junction', () => {
  const c = compile(doc({
    nodes: { a: [0, 0], b: [5, 0], d: [10, 0], e: [5, 5] },
    walls: [{ id: 'w1', from: 'a', to: 'b', t: 0.2, type: 'wall' },
            { id: 'w2', from: 'b', to: 'd', t: 0.2, type: 'wall' },
            { id: 'w3', from: 'b', to: 'e', t: 0.2, type: 'wall' }],
  }));
  assert.equal(c.runs.length, 3);
});

test('every wall appears in exactly one run', () => {
  const c = compile(defaults.carport);
  const segs = c.runs.reduce((n, r) => n + r.points.length - 1, 0);
  assert.equal(segs, defaults.carport.walls.length);
});

test('unknown types are skipped rather than fatal', () => {
  const c = compile(doc({
    nodes: { a: [0, 0], b: [1, 0] },
    walls: [{ id: 'w1', from: 'a', to: 'b', t: 0.2, type: 'nosuchtype' }],
  }));
  assert.equal(c.solids.length, 0);
  assert.equal(c.drawList.length, 0);
  assert.match(c.warnings.join(), /nosuchtype/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/compile.test.mjs`
Expected: FAIL — `compile is not a function`

- [ ] **Step 3: Add the compile namespace block**

Insert after the `defaults` block:

```html
<script data-ns="compile">
globalThis.App = globalThis.App || {};
App.compile = (() => {
  'use strict';
  const { wallQuad, rectQuad } = App.geom;
  const reg = App.registry;

  // Walls that share a degree-2 node, thickness and type form one stroked run, so
  // canvas does the corner mitring. Collision does not care: overlapping quads union.
  function buildRuns(doc, walls) {
    const deg = {};
    for (const w of walls) { deg[w.from] = (deg[w.from] || 0) + 1; deg[w.to] = (deg[w.to] || 0) + 1; }
    const key = w => `${w.type}|${w.t}`;
    const left = new Set(walls.map(w => w.id));
    const byId = new Map(walls.map(w => [w.id, w]));
    const at = {};
    for (const w of walls) { (at[w.from] ||= []).push(w); (at[w.to] ||= []).push(w); }

    const runs = [];
    for (const seed of walls) {
      if (!left.has(seed.id)) continue;
      left.delete(seed.id);
      let pts = [seed.from, seed.to];
      // extend from both ends while the joint is a clean degree-2 pass-through
      for (let end = 0; end < 2; end++) {
        for (;;) {
          const tip = end === 0 ? pts[0] : pts[pts.length - 1];
          if (deg[tip] !== 2) break;
          const next = (at[tip] || []).find(w => left.has(w.id) && key(w) === key(seed));
          if (!next) break;
          left.delete(next.id);
          const far = next.from === tip ? next.to : next.from;
          if (end === 0) pts.unshift(far); else pts.push(far);
        }
      }
      const layer = reg.get(seed.type).layers[0];
      runs.push({ type: seed.type, t: seed.t, z: layer.z, stroke: layer.stroke, points: pts.map(id => doc.nodes[id]) });
    }
    return runs;
  }

  return function compile(doc) {
    const warnings = [], solids = [], drawList = [];
    const push = (obj, kind, type) => {
      const t = reg.get(type);
      if (!t) { warnings.push(`unknown type ${type}, skipped`); return null; }
      if (t.kind !== kind) { warnings.push(`type ${type} is ${t.kind}, used as ${kind}`); return null; }
      t.layers.forEach(layer => drawList.push({ z: layer.z, type, kind, obj, layer }));
      return t;
    };

    const walls = [];
    for (const w of doc.walls) {
      const t = push(w, 'wall', w.type);
      if (!t) continue;
      walls.push(w);
      if (t.solid) solids.push(wallQuad(doc.nodes[w.from], doc.nodes[w.to], w.t));
    }
    for (const a of doc.areas) push(a, 'area', a.type);
    for (const it of doc.items) {
      const t = push(it, 'item', it.type);
      if (!t || !t.solid || !t.footprint) continue;
      const f = t.footprint;
      const w = f.w != null ? f.w : f.r * 2, h = f.h != null ? f.h : f.r * 2;
      solids.push(rectQuad(it.at[0], it.at[1], w, h, it.a));
    }

    const { w: W, h: H } = doc.plot;
    return {
      extent: { w: W, h: H },
      solids,
      bounds: [
        { x: -1, y: -1, w: W + 2, h: 1 }, { x: -1, y: H, w: W + 2, h: 1 },
        { x: -1, y: -1, w: 1, h: H + 2 }, { x: W, y: -1, w: 1, h: H + 2 },
      ],
      runs: buildRuns(doc, walls),
      drawList: drawList.sort((a, b) => a.z - b.z),
      bays: doc.bays, dims: doc.dims, spawn: doc.spawn, brief: doc.brief,
      warnings,
    };
  };
})();
</script>
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/*.test.mjs`
Expected: PASS, all tests

- [ ] **Step 5: Commit**

```bash
git add index.html test/compile.test.mjs
git commit -m "Add App.compile: solids, bounds, wall runs and a z-sorted draw list"
```

---

### Task 5: Cut physics over to compiled solids

Physics stops reading `staticObstacles`. Rendering still uses the literals, so the screen is unchanged and any behaviour difference is isolated to this task.

**Files:**
- Modify: `index.html:231` (compile the default layout), `index.html:317`, `index.html:423`, `index.html:330-335` (`reset` uses `spawn`), `index.html:313` (`addVehicle` uses `spawn`)

**Interfaces:**
- Consumes: `App.compile`, `App.defaults.carport`, `App.layout.unpack`.
- Produces: module-scope `world` (the compiled layout) and `doc` (the document) inside the main IIFE.

- [ ] **Step 1: Load and compile the document at startup**

After the `const { cornersOf, … } = App.geom;` line added in Task 1, add:

```js
// The layout document is the only source of truth; everything below reads `world`.
const loaded = App.layout.unpack(App.defaults.carport);
if (loaded.errors) throw new Error('default layout is invalid: ' + loaded.errors.join('; '));
const doc = loaded.doc;
let world = App.compile(doc);
if (world.warnings.length) console.warn('layout warnings:', world.warnings);
```

- [ ] **Step 2: Point the spawn-blocked check at compiled solids**

`index.html:317` currently reads:

```js
    const blocked = vehicles.some(o => collide(c, v.a, cornersOf(o, o.spec), o.a)) || staticObstacles.some(r => collide(c, v.a, rectCorners(r), 0));
```

Replace with:

```js
    const blocked = vehicles.some(o => collide(c, v.a, cornersOf(o, o.spec), o.a)) || world.solids.some(s => collide(c, v.a, s.corners, s.a));
```

- [ ] **Step 3: Point the collision loop at compiled solids**

`index.html:423` currently reads:

```js
    const targets = [...[...staticObstacles, ...bounds].map(r => [rectCorners(r), 0]), ...vehicles.filter(o => o !== car).map(o => [cornersOf(o, o.spec), o.a])];
```

Replace with:

```js
    const targets = [...world.solids.map(s => [s.corners, s.a]), ...world.bounds.map(r => [rectCorners(r), 0]), ...vehicles.filter(o => o !== car).map(o => [cornersOf(o, o.spec), o.a])];
```

- [ ] **Step 4: Take the spawn point from the document**

`index.html:313-314` currently opens:

```js
function addVehicle(spec) {
  const v = { x: 16.4, y: 14.05, a: Math.PI, v: 0, steer: 0, spec, paint: paints[0] };
```

Replace those coordinates with the document's:

```js
function addVehicle(spec) {
  const v = { x: world.spawn.at[0], y: world.spawn.at[1], a: world.spawn.a, v: 0, steer: 0, spec, paint: paints[0] };
```

- [ ] **Step 5: Verify collision behaviour is unchanged**

Run: `python3 -c "import re;s=open('index.html').read();open('/tmp/s.js','w').write(re.search(r'<script>(.*?)</script>',s,re.S).group(1))" && node --check /tmp/s.js`
Expected: no output

Then open `index.html` and check all of:
- the car spawns in the same place on the street, facing west
- driving into the boundary wall, the kerb, the carport posts and the south fence each increment the collision counter
- driving onto the wooden deck is still blocked
- the car cannot leave the plot on any of the four sides

Run: `node --test test/*.test.mjs`
Expected: PASS (unchanged)

- [ ] **Step 6: Commit**

```bash
git add index.html
git commit -m "Drive collision from compiled layout solids instead of literals"
```

---

### Task 6: Cut rendering over to the draw list

Ground, street, path, apron, bays, dims and walls render from `world`. The deck, carport and palms keep their current bespoke code for one more task so this step stays reviewable.

**Files:**
- Modify: `index.html:605-658` (`draw`), `index.html` registry block (add `fill`/`stroke` handling), `index.html:558-570` (`drawDim` signature)

**Interfaces:**
- Consumes: `world.drawList`, `world.runs`, `world.bays`, `world.dims`, `App.registry.VEHICLE_Z`.
- Produces: `drawArea(poly, fill)`, `drawRun(run, stroke)`, `paintList(from, to)` inside the main IIFE.

- [ ] **Step 1: Add the area and run painters**

Immediately before `function draw()` (line 605), add:

```js
function drawArea(poly, fill) {
  g.fillStyle = fill; g.beginPath();
  poly.forEach(([x, y], i) => i ? g.lineTo(px(x), px(y)) : g.moveTo(px(x), px(y)));
  g.closePath(); g.fill();
}
// One stroked path per run: canvas mitres the corners for us.
function drawRun(run, stroke) {
  g.strokeStyle = stroke; g.lineWidth = px(run.t); g.lineJoin = 'miter'; g.miterLimit = 4; g.lineCap = 'butt';
  g.beginPath();
  run.points.forEach(([x, y], i) => i ? g.lineTo(px(x), px(y)) : g.moveTo(px(x), px(y)));
  g.stroke();
}
```

- [ ] **Step 2: Add a z-banded list painter**

Directly after those, add:

```js
// Paint every drawList entry whose z falls in [from, to). Vehicles are painted
// between the two calls, because today's scene draws its carport roof and palms
// over the cars but its floor and bay outlines under them.
function paintList(from, to) {
  for (const d of world.drawList) {
    if (d.z < from || d.z >= to) continue;
    if (d.kind === 'area' && d.layer.fill) drawArea(d.obj.poly, d.layer.fill);
    else if (d.layer.draw) d.layer.draw(g, d.obj, { px });
  }
  // walls stroke per run rather than per wall, so they are painted from world.runs
  // instead of drawList. Each run carries the z its type declared.
  for (const run of world.runs) if (run.z >= from && run.z < to) drawRun(run, run.stroke);
}
```

- [ ] **Step 3: Replace the ground, street, path, apron, bays and dims in `draw()`**

In `draw()`, delete these existing lines: 611-614 (plot fill, street fill, centre-line loop), 621 (`rect(path…)`, `rect(apron…)`), 623-625 (the bays `save`/`strokeRect`/`restore` block), the `for (const o of staticObstacles)` loop at 628-631, and the five `drawDim(…)` calls at 652-656.

In their place, after `g.translate(OX, OY);`, put:

```js
  paintList(0, App.registry.VEHICLE_Z);
```

and immediately **after** the two `drawVehicle` lines (632-633), put:

```js
  paintList(App.registry.VEHICLE_Z, Infinity);
```

- [ ] **Step 4: Give the street its centre line and bays and dims their painters**

In the `registry` block, replace the `street` entry and add `bay`/`dim` handling by giving the layers `draw` functions. Because the registry block is DOM-free it cannot close over `g`, so painters take it as an argument:

```js
    street:  { kind: 'area', solid: false, layers: [{ z: 5, fill: '#e9ebee', draw: (g, a, v) => {
      g.fillStyle = '#e9ebee'; g.beginPath();
      a.poly.forEach(([x, y], i) => i ? g.lineTo(v.px(x), v.px(y)) : g.moveTo(v.px(x), v.px(y)));
      g.closePath(); g.fill();
      g.strokeStyle = 'rgba(46,53,56,.35)'; g.lineWidth = 1;
      const xs = a.poly.map(p => p[0]), x1 = Math.max(...xs);
      const ys = a.poly.map(p => p[1]), mid = Math.min(...ys) + 1.85;
      for (let x = Math.min(...xs) + 0.5; x < x1; x += 1.2) { g.beginPath(); g.moveTo(v.px(x), v.px(mid)); g.lineTo(v.px(x + 0.6), v.px(mid)); g.stroke(); }
    } }] },
```

Then in `paintList`, paint bays and dims after the banded entries:

```js
  const { BAY_Z, DIM_Z } = App.registry;
  if (BAY_Z >= from && BAY_Z < to) {
    g.save(); g.setLineDash([px(0.22), px(0.14)]); g.strokeStyle = 'rgba(46,53,56,.45)'; g.lineWidth = Math.max(1, px(0.04));
    for (const b of world.bays) g.strokeRect(px(b.rect[0]), px(b.rect[1]), px(b.rect[2]), px(b.rect[3]));
    g.restore();
  }
  if (DIM_Z >= from && DIM_Z < to) for (const d of world.dims) drawDim(d.from[0], d.from[1], d.to[0], d.to[1], d.label);
```

- [ ] **Step 5: Verify the render is unchanged**

Run: `python3 -c "import re;s=open('index.html').read();open('/tmp/s.js','w').write(re.search(r'<script>(.*?)</script>',s,re.S).group(1))" && node --check /tmp/s.js`
Expected: no output

Open `index.html` and compare against `git stash`-ed original side by side. Confirm: ground and street shading identical, street centre-line dashes present, path and apron shading present, all three bay outlines dashed in the same places, all eight walls/kerb/fence in their original greys, all five dimension lines with their labels, vehicles still drawn *under* the carport slats.

Run: `node --test test/*.test.mjs`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add index.html
git commit -m "Render ground, walls, bays and dims from the compiled draw list"
```

---

### Task 7: Move the remaining ornament into the registry and delete the literals

The deck planking, carport floor/slats/shadow, palms, south fence posts and boundary-wall highlight become registry painters. All world literals then go.

**Files:**
- Modify: `index.html` registry block, `index.html:605-658` (`draw`), `index.html:241-263` (delete literals)

**Interfaces:**
- Consumes: `world.drawList` with `layer.draw`.
- Produces: no new names; `staticObstacles`, `bounds`, `bays`, `palms`, `apron`, `path`, `carport`, `W`, `H` cease to exist.

- [ ] **Step 1: Add the ornament painters to the registry**

Replace the `deck`, `carport` and `palm` entries in the `registry` block with:

```js
    deck: { kind: 'item', solid: true, footprint: { w: 10.47, h: 1.76 }, layers: [{ z: 20, draw: (g, it, v) => {
      const w = 10.47, h = 1.76, x = it.at[0] - w / 2, y = it.at[1] - h / 2;
      g.fillStyle = '#aeb3b8'; g.fillRect(v.px(x), v.px(y), v.px(w), v.px(h));
      g.strokeStyle = 'rgba(60,66,70,.35)';
      for (let ly = y + 0.16; ly < y + h; ly += 0.16) { g.beginPath(); g.moveTo(v.px(x), v.px(ly)); g.lineTo(v.px(x + w), v.px(ly)); g.stroke(); }
    } }] },
    carport: { kind: 'item', solid: false, layers: [
      { z: 30, draw: (g, it, v) => {                      // floor, under the cars
        const w = 7.95, h = 6.08, x = it.at[0] - w / 2, y = it.at[1] - h / 2;
        g.fillStyle = '#e6e8eb'; g.fillRect(v.px(x), v.px(y + 0.42), v.px(w), v.px(h - 0.42));
      } },
      { z: 60, draw: (g, it, v) => {                      // slats and shadow, over them
        const w = 7.95, h = 6.08, x = it.at[0] - w / 2, y = it.at[1] - h / 2;
        g.save(); g.beginPath(); g.rect(v.px(x), v.px(y + 0.42), v.px(w), v.px(h - 0.9)); g.clip();
        g.strokeStyle = 'rgba(44,51,53,.55)'; g.lineWidth = Math.max(1, v.px(0.045));
        for (let sx = x + 0.1; sx < x + w; sx += 0.1) { g.beginPath(); g.moveTo(v.px(sx), v.px(y)); g.lineTo(v.px(sx), v.px(y + h)); g.stroke(); }
        g.restore();
        g.fillStyle = 'rgba(44,51,53,.92)'; g.fillRect(v.px(x), v.px(y + h - 0.48), v.px(w), v.px(0.48));
      } },
    ] },
    palm: { kind: 'item', solid: false, layers: [{ z: 70, draw: (g, it, v) => {
      const [x, y] = it.at;
      g.strokeStyle = '#4f8a3a'; g.lineWidth = Math.max(1.5, v.px(0.07)); g.lineCap = 'round';
      for (let i = 0; i < 9; i++) { const a = i * Math.PI * 2 / 9 + 0.3; g.beginPath(); g.moveTo(v.px(x), v.px(y)); g.quadraticCurveTo(v.px(x + Math.cos(a) * 0.5), v.px(y + Math.sin(a) * 0.5 - 0.1), v.px(x + Math.cos(a) * 1.05), v.px(y + Math.sin(a) * 1.05)); g.stroke(); }
      g.fillStyle = '#6b4a2a'; g.beginPath(); g.arc(v.px(x), v.px(y), v.px(0.16), 0, Math.PI * 2); g.fill();
    } }] },
```

- [ ] **Step 2: Turn the south fence posts and the wall highlight into types**

Today's fence posts and the boundary-wall edge highlight are drawn unconditionally at fixed coordinates. Give them types so they come from the document. Add to `registry.types`:

```js
    fenceposts: { kind: 'item', solid: false, layers: [{ z: 41, draw: (g, it, v) => {
      const [x0, y] = it.at, span = it.span || 18.6;
      g.fillStyle = '#2c3335';
      for (let x = x0; x < x0 + span; x += 2.0) g.fillRect(v.px(x) - v.px(0.08), v.px(y), v.px(0.16), v.px(0.32));
    } }] },
    walltrim: { kind: 'item', solid: false, layers: [{ z: 41, draw: (g, it, v) => {
      g.fillStyle = '#8a8f95';
      g.fillRect(v.px(it.at[0]), v.px(it.at[1]), v.px(it.w || 0.06), v.px(it.h || 11.35));
    } }] },
```

And to `defaults.carport.items`:

```js
      { id: 'it5', type: 'fenceposts', at: [0.4, 15.22], a: 0, span: 18.6 },
      { id: 'it6', type: 'walltrim',   at: [2.25, 0],    a: 0, w: 0.06, h: 11.35 },
```

- [ ] **Step 3: Delete the remaining bespoke drawing from `draw()`**

From `draw()` delete: the `const deck = staticObstacles[1];` block (616-619), the carport floor `rect(...)` (622), the fence-post loop and `rect({x:2.25,...})` (635-637), the carport clip/slat/shadow block (640-644) and the palm loop (646-650).

`draw()` should reduce to: transform setup, `paintList(0, VEHICLE_Z)`, the two `drawVehicle` lines, `paintList(VEHICLE_Z, Infinity)`.

- [ ] **Step 4: Delete the world literals**

Delete `index.html:241-263` entirely — `W`, `H`, `staticObstacles`, `bounds`, `bays`, `palms`, `apron`, `path`, `carport`.

- [ ] **Step 5: Add a test that no literals remain**

Append to `test/defaults.test.mjs`:

```js
import { readFileSync } from 'node:fs';

test('the main script no longer declares world literals', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const main = html.slice(html.lastIndexOf('<script>'));
  for (const name of ['staticObstacles', 'const palms', 'const apron', 'const carport'])
    assert.ok(!main.includes(name), `${name} still present in the main script`);
});
```

- [ ] **Step 6: Verify and run**

Run: `node --test test/*.test.mjs`
Expected: PASS

Open `index.html`. The scene must be pixel-identical to `git show HEAD~1:index.html`: deck planking, carport slats and shadow band, both palms, the ten south fence posts, the light stripe on the boundary wall. Drive a lap and confirm collisions unchanged.

- [ ] **Step 7: Commit**

```bash
git add index.html test/defaults.test.mjs
git commit -m "Move remaining ornament into registry painters and delete world literals"
```

---

### Task 8: Plot-driven camera, and document the new structure

`W`/`H` are gone, so `fit()` must read the compiled extent. This also introduces the `view` object the editor's pan/zoom will use in Phase B.

**Files:**
- Modify: `index.html:441-470` (`fit`), `index.html:553` (`px`), `index.html:477-481` (canvas `pointerdown`), `index.html:605-609` (`draw`), `CLAUDE.md`

**Interfaces:**
- Consumes: `world.extent`.
- Produces: `view = {scale, ox, oy}` and `toWorld(clientX, clientY) -> [x, y]` inside the main IIFE.

- [ ] **Step 1: Replace S/OX/OY with a view object**

`index.html:441` currently reads:

```js
let S = 40, OX = 0, OY = 0, VW = 0, VH = 0;
```

Replace with:

```js
// One camera for both modes. fit() is one way to set it; Phase B's editor pans and
// zooms it directly. S/OX/OY are kept as aliases so existing call sites still read.
const view = { scale: 40, ox: 0, oy: 0 };
let VW = 0, VH = 0;
```

In `fit()`, replace the two assignment lines (`S = Math.min(...)` and `OX = ...; OY = ...`) with:

```js
  const { w: PW, h: PH } = world.extent;
  view.scale = Math.min(VW / PW, availH / PH) * 0.94;
  view.ox = (VW - PW * view.scale) / 2;
  view.oy = top + (availH - PH * view.scale) / 2;
```

and delete the `const { w: W, h: H }`-style references to the old constants inside `fit()`.

- [ ] **Step 2: Redirect px, draw and hit-testing at the view**

Replace `index.html:553`:

```js
const px = m => m * S;
```

with:

```js
const px = m => m * view.scale;
```

In `draw()` replace `g.translate(OX, OY);` with `g.translate(view.ox, view.oy);`.

Replace the canvas `pointerdown` body at 477-481 with a shared unprojection:

```js
const toWorld = (cx, cy) => [(cx - view.ox) / view.scale, (cy - view.oy) / view.scale];
cv.addEventListener('pointerdown', e => {
  const [x, y] = toWorld(e.clientX, e.clientY);
  for (let i = vehicles.length - 1; i >= 0; i--) if (pointInVehicle(x, y, vehicles[i])) { select(vehicles[i]); return; }
});
```

- [ ] **Step 3: Test the fit maths against a different plot size**

Append to `test/compile.test.mjs`:

```js
test('a larger plot compiles to a larger extent and matching bounds', () => {
  const c = compile(doc({ plot: { w: 40, h: 30 } }));
  assert.deepEqual(c.extent, { w: 40, h: 30 });
  assert.deepEqual(c.bounds[1], { x: -1, y: 30, w: 42, h: 1 });
});
```

- [ ] **Step 4: Run and verify**

Run: `node --test test/*.test.mjs`
Expected: PASS

Run: `python3 -c "import re;s=open('index.html').read();open('/tmp/s.js','w').write(re.search(r'<script>(.*?)</script>',s,re.S).group(1))" && node --check /tmp/s.js`
Expected: no output

Open `index.html`, confirm the plan is positioned and scaled exactly as before at desktop size, in portrait at 375×812 and in landscape at 844×390, and that tapping a car still selects it in all three.

- [ ] **Step 5: Document the new structure in CLAUDE.md**

Add this section to `CLAUDE.md` immediately before the `## Git` heading:

```markdown
## Namespaces and the layout document

The world is data. `App.defaults.carport` is a layout document, `App.compile(doc)`
derives collision quads, wall runs and a z-sorted draw list, and physics and rendering
read only that. Nothing reads world literals — there are none.

DOM-free namespaces live in `<script data-ns="…">` blocks, in dependency order:
`geom`, `registry`, `layout`, `defaults`, `compile`. They must not touch `document` or
`window`: the test harness runs them in a bare `vm` context, and touching the DOM
there throws. Everything else stays in the final `<script>` main IIFE.

Adding a scene type is a `registry.types` entry — `kind`, `solid`, optional
`footprint`, and `layers` of `{z, draw}`. Nothing else changes. `layers` is plural
because the carport paints its floor under the vehicles and its roof over them;
vehicles paint at `registry.VEHICLE_Z` (50).

Run the tests with:

```bash
node --test test/*.test.mjs
```

They cover `geom`, `layout` and `compile` only. Rendering and interaction stay
eyeball-verified: extract, `node --check`, then open the page and drive it.

Two `file://` traps: `fetch()` and ES modules are both CORS-blocked, so the default
layout is an inline literal and namespaces are classic script blocks. And validate
every coordinate as finite on load — a single `NaN` makes SAT silently report *no
collision*, so bad data turns collisions off rather than crashing.
```

- [ ] **Step 6: Commit**

```bash
git add index.html CLAUDE.md test/compile.test.mjs
git commit -m "Drive the camera from the compiled plot extent and document namespaces"
```

---

## Phase A exit criteria

All must hold before Phase B (the editor) starts:

1. `node --test test/*.test.mjs` passes.
2. `grep -c staticObstacles index.html` returns 0.
3. The scene is pixel-identical to `5109062:index.html` at desktop, 375×812 and 844×390.
4. Collisions are unchanged: boundary wall, kerb, posts, fences, deck and all four plot edges all block.
5. The car spawns at the document's spawn point.
6. `App.layout.unpack(App.layout.pack(App.defaults.carport))` deep-equals the original.
7. The console is clean on load.

## Deferred to Phase B

Written as its own plan once Phase A lands, because the editor's API depends on the
compiled shapes this phase actually produces:

- Build/drive mode toggle and mode-aware input routing, including the missing `INPUT`
  guard that currently lets `r` fire while typing in a field.
- Selection, handles, marquee, delete with orphan-node collection.
- Undo/redo over document snapshots, one per committed drag.
- The wall tool: chaining, node/centreline/grid/angle snapping in screen pixels, node
  merge and wall split.
- The properties panel: thickness, length with an anchor toggle, angle, type.
- The bay tool, the brief editor, parking detection and `QAResult` with `layoutHash`.
