// A/B benchmark: same topology data, two render engines (D3 vs AntV G6).
// Measures peak/final JS heap and main-thread CPU time from the CONTROLLER
// (CDP / page.metrics()) so a pegged page thread can't distort the numbers.
// The apps are measured AS-IS — instrumentation is injected at runtime, no
// files are modified (the d3/ folder is read-only anyway).

const puppeteer = require('puppeteer-core');
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const ENGINES = ['d3', 'g6'];
const VIEWS = ['core', 'e2e', 'full'];
const WINDOW_MS = 20000;        // observation window per run
const HEAP_POLL_MS = 250;
const CHROME = '/usr/bin/google-chrome';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const withTimeout = (p, ms, sentinel) =>
  Promise.race([p, sleep(ms).then(() => sentinel)]);

// Injected before any app script runs: pin the view + start an in-page
// long-task/heap probe (used only as a cross-check; the authoritative
// numbers come from CDP page.metrics() on the controller side).
function inject(view) {
  try {
    sessionStorage.setItem('topology.view', view);
    sessionStorage.removeItem('topology.region');
    sessionStorage.removeItem('topology.site');
  } catch (e) {}
  window.__bench = { blocking: 0, longTasks: 0 };
  try {
    new PerformanceObserver(list => {
      for (const e of list.getEntries()) {
        window.__bench.blocking += e.duration;
        window.__bench.longTasks++;
      }
    }).observe({ type: 'longtask', buffered: true });
  } catch (e) {}
}

function readInPage() {
  const out = {};
  try { out.svgImages = document.querySelectorAll('svg image').length; } catch (e) {}
  try { out.canvases  = document.querySelectorAll('canvas').length; } catch (e) {}
  try { out.domNodes  = document.getElementsByTagName('*').length; } catch (e) {}
  try {
    const p = performance.getEntriesByType('paint')
      .find(x => x.name === 'first-contentful-paint');
    out.fcpMs = p ? Math.round(p.startTime) : null;
  } catch (e) {}
  try {
    out.blockingMs = window.__bench ? Math.round(window.__bench.blocking) : null;
    out.longTasks  = window.__bench ? window.__bench.longTasks : null;
  } catch (e) {}
  return out;
}

async function runOne(browser, engine, view) {
  const url = pathToFileURL(path.join(ROOT, engine, 'index.html')).href;
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  await page.evaluateOnNewDocument(inject, view);

  const navErr = await page
    .goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 })
    .then(() => null)
    .catch(e => e.message);

  const m0 = await page.metrics();
  const tStart = Date.now();
  let peakHeap = m0.JSHeapUsedSize || 0;

  // Heap sampling via CDP — runs in the browser process, NOT blocked even if
  // the page's main thread is 100% pegged.
  while (Date.now() - tStart < WINDOW_MS) {
    try {
      const m = await page.metrics();
      if (m.JSHeapUsedSize > peakHeap) peakHeap = m.JSHeapUsedSize;
    } catch (e) {}
    await sleep(HEAP_POLL_MS);
  }
  const m1 = await page.metrics();

  // Responsiveness probe: how long does a trivial eval take to come back?
  // Small => idle/settled. Times out => still frozen.
  const tProbe = Date.now();
  const probe = await withTimeout(
    page.evaluate(() => 1).then(() => 'ok'), 8000, 'FROZEN');
  const respMs = probe === 'FROZEN' ? null : Date.now() - tProbe;

  // Guarded in-page read (skip if the thread never frees).
  const info = await withTimeout(
    page.evaluate(readInPage).catch(() => ({ evalError: true })),
    4000, { unresponsive: true });

  try { await page.screenshot({ path: path.join(__dirname, 'shots', `${engine}-${view}.png`) }); } catch (e) {}

  const MB = b => +(b / 1048576).toFixed(1);
  const result = {
    engine, view, navErr,
    peakHeapMB: MB(peakHeap),
    finalHeapMB: MB(m1.JSHeapUsedSize || 0),
    scriptCpuS: +((m1.ScriptDuration - m0.ScriptDuration)).toFixed(2),
    taskCpuS:   +((m1.TaskDuration   - m0.TaskDuration)).toFixed(2),
    layoutCount: (m1.LayoutCount || 0) - (m0.LayoutCount || 0),
    domNodesFinal: m1.Nodes || 0,
    jsListeners: m1.JSEventListeners || 0,
    respMs, frozen: probe === 'FROZEN',
    inPage: info,
  };
  await ctx.close();
  return result;
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--enable-precise-memory-info', '--window-size=1600,1000',
    ],
  });
  const results = [];
  for (const engine of ENGINES) {
    for (const view of VIEWS) {
      process.stdout.write(`\n▶ ${engine.toUpperCase()} / ${view} … `);
      try {
        const r = await runOne(browser, engine, view);
        results.push(r);
        process.stdout.write(
          `heap peak ${r.peakHeapMB}MB | JS-CPU ${r.scriptCpuS}s/${(WINDOW_MS/1000)}s` +
          ` | resp ${r.frozen ? 'FROZEN(>8s)' : r.respMs + 'ms'}`);
      } catch (e) {
        process.stdout.write(`ERROR ${e.message}`);
        results.push({ engine, view, error: e.message });
      }
    }
  }
  await browser.close();
  fs.writeFileSync(path.join(__dirname, 'results.json'),
    JSON.stringify({ windowMs: WINDOW_MS, ranAt: process.env.BENCH_TS || null, results }, null, 2));
  console.log('\n\n=== results.json written ===');
  console.table(results.map(r => ({
    engine: r.engine, view: r.view,
    peakHeapMB: r.peakHeapMB, finalHeapMB: r.finalHeapMB,
    JS_CPU_s: r.scriptCpuS, task_CPU_s: r.taskCpuS,
    resp: r.frozen ? '>8000 (frozen)' : r.respMs,
    fcpMs: r.inPage && r.inPage.fcpMs,
  })));
})();
