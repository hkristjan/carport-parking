import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const HTML = join(dirname(fileURLToPath(import.meta.url)), '..', 'index.html');

// Run the DOM-free namespace blocks from index.html in the current realm, in document
// order, and hand back the App they build. Blocks that touch document/window will
// throw here, which is the point: those belong in the main IIFE, not a namespace.
export function loadApp() {
  const html = readFileSync(HTML, 'utf8');
  const re = /<script data-ns="([\w-]+)">([\s\S]*?)<\/script>/g;
  let m, count = 0;
  while ((m = re.exec(html))) {
    vm.runInThisContext(m[2], { filename: `index.html#${m[1]}` });
    count++;
  }
  if (count === 0) throw new Error('no <script data-ns="..."> blocks found in index.html');
  if (!globalThis.App) throw new Error('namespace blocks did not define globalThis.App');
  return globalThis.App;
}
