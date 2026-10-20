#!/usr/bin/env node
// Measures WebMeet room join and leave latency in a headless browser.
// Env: BASE_URL, LOGIN_EMAIL, ACCOUNT_PASSWORD, PW_DIR (dir containing node_modules/playwright),
//      CYCLES (default 6), LABEL, OUT (json path). Never prints credentials.
// Optional: BURST=<n> replays n parallel webmeet_room_list calls in the page (the
//      captured request, each with a fresh JSON-RPC id) BURST_REPEATS times (default 5)
//      and reports wall times; PERF_MARKS=1 opens the room page with ?webmeetPerf=1 and
//      records the webmeet:* performance marks of every join.
// Run it from a checkout, not from the measured deployment. Request headers and
// bodies stay inside the page and are never written to the output.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const pwDir = process.env.PW_DIR;
const { chromium } = await import(pathToFileURL(path.join(pwDir, 'node_modules/playwright/index.mjs')).href);
const base = process.env.BASE_URL.replace(/\/$/, '');
const cycles = Number(process.env.CYCLES || 6);
const label = process.env.LABEL || base;
const runId = Date.now().toString(36);
const roomTitle = `latency-${runId}`;
const T = 60_000;
const burstSize = Number(process.env.BURST || 0);
const burstRepeats = Number(process.env.BURST_REPEATS || 5);
const perfMarks = process.env.PERF_MARKS === '1';
const roomPage = perfMarks ? '/webmeetAgent/roomLoader.html?webmeetPerf=1' : '/webmeetAgent/roomLoader.html';

const browser = await chromium.launch({
  headless: true,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--ignore-certificate-errors'],
});
const context = await browser.newContext({ baseURL: base, ignoreHTTPSErrors: true });
const page = await context.newPage();
page.on('dialog', (d) => d.accept().catch(() => {}));

const requests = [];
// The last webmeet_room_list request, replayed in the page by the BURST stage.
let roomListRequest = null;
page.on('requestfinished', async (req) => {
  const t = req.timing();
  let name = new URL(req.url()).pathname;
  try {
    const body = JSON.parse(req.postData() || '');
    if (body?.params?.name) name = `tool:${body.params.name}`;
    else if (body?.method) name = `rpc:${body.method}`;
    if (body?.params?.name === 'webmeet_room_list') {
      const headers = await req.allHeaders();
      roomListRequest = {
        url: req.url(),
        body,
        headers: Object.fromEntries(Object.entries(headers).filter(([key]) => (
          // MCPBrowserClient also sends the Router's browser CSRF token on calls.
          ['accept', 'content-type', 'mcp-session-id', 'mcp-protocol-version', 'x-ploinky-browser-csrf-token'].includes(key.toLowerCase())
        ))),
      };
    }
  } catch {}
  requests.push({ name, start: t.startTime, dur: t.responseEnd, ttfb: t.responseStart - t.requestStart, at: Date.now() });
});

const now = () => Date.now();
async function measure(fn) { const s = now(); await fn(); return now() - s; }

// Sign in through the UserPersisto email-first wizard.
const signInMs = await measure(async () => {
  await page.goto(`/auth/login?${new URLSearchParams({ agent: 'explorer', returnTo: roomPage })}`, { waitUntil: 'load' });
  const content = page.locator('#auth_content');
  await content.locator('input[name="email"]').waitFor({ state: 'visible', timeout: T });
  await content.locator('input[name="email"]').fill(process.env.LOGIN_EMAIL);
  await content.getByRole('button', { name: 'Next', exact: true }).click();
  const signUp = content.getByRole('button', { name: 'Sign up', exact: true });
  const pwHeading = content.getByRole('heading', { name: 'Enter your password', exact: true });
  await pwHeading.or(signUp).first().waitFor({ state: 'visible', timeout: T });
  if (await signUp.isVisible()) {
    // Fresh local workspace: create the account (the first one becomes its administrator).
    await signUp.click();
    await content.locator('input[name="password"]').waitFor({ state: 'visible', timeout: T });
    await content.locator('input[name="password"]').fill(process.env.ACCOUNT_PASSWORD);
    await content.locator('input[name="passwordConfirmation"]').fill(process.env.ACCOUNT_PASSWORD);
    await Promise.all([
      page.waitForURL(/\/webmeetAgent\/roomLoader\.html/, { timeout: T }),
      content.getByRole('button', { name: 'Create account', exact: true }).click(),
    ]);
  } else {
    await content.locator('input[name="password"]').fill(process.env.ACCOUNT_PASSWORD);
    await Promise.all([
      page.waitForURL(/\/webmeetAgent\/roomLoader\.html/, { timeout: T }),
      content.getByRole('button', { name: 'Log in', exact: true }).click(),
    ]);
  }
});
const dashMs = await measure(() => page.locator('div.webmeet-dashboard').waitFor({ state: 'visible', timeout: T }));

// Create a run-scoped team room.
const createMs = await measure(async () => {
  await page.locator('#webmeetCreateRoomButton').click();
  await page.locator('[data-id="roomTitleInput"]').fill(roomTitle);
  await page.locator('[data-local-action="confirmCreate"]').click();
  await page.locator('#webmeetMeetingList .webmeet-list-item', { hasText: roomTitle }).first().waitFor({ state: 'visible', timeout: T });
});
const item = page.locator('#webmeetMeetingList .webmeet-list-item', { hasText: roomTitle }).first();

const lkState = () => page.evaluate(() => {
  const p = document.querySelector('webmeet-dashboard')?.webSkelPresenter;
  const room = p?.roomLiveKit?.getRoom?.() || p?.room || null;
  return { session: Boolean(p?.state?.session), leaving: Boolean(p?.state?.leavingMeeting), lk: room?.state || null };
});
async function waitState(pred) {
  const s = now();
  while (now() - s < T) { if (pred(await lkState())) return now(); await page.waitForTimeout(25); }
  throw new Error('state wait timed out');
}

// Tool calls of one window as [tool, start offset from t0, duration], so the
// parallel tiers of a join or leave can be read from the output.
const timeline = (reqs, t0) => reqs.filter((q) => q.name.startsWith('tool:'))
  .map((q) => [q.name.slice(5), Math.round(q.start - t0), Math.round(q.dur)]);
const takeMarks = () => (perfMarks ? page.evaluate(() => {
  const origin = performance.timeOrigin;
  const marks = performance.getEntriesByType('mark').filter((m) => m.name.startsWith('webmeet:'))
    .map((m) => [m.name.slice(8), Math.round(origin + m.startTime)]);
  performance.clearMarks();
  return marks;
}) : Promise.resolve(null));

const results = [];
for (let i = 0; i < cycles; i += 1) {
  const r0 = requests.length;
  const t0 = now();
  await item.locator('.webmeet-meeting-row').click();
  await page.locator('#webmeetChatInput').waitFor({ state: 'visible', timeout: T });
  const chatVisible = now() - t0;
  const lkConnected = (await waitState((s) => s.lk === 'connected')) - t0;
  await page.waitForTimeout(2500);
  const joinReqs = requests.slice(r0);
  const joinMarks = await takeMarks();
  const r1 = requests.length;
  const t1 = now();
  await page.locator('#webmeetLeaveButton').click();
  const left = (await waitState((s) => !s.session && !s.leaving && (s.lk === 'disconnected' || s.lk === null))) - t1;
  await page.waitForTimeout(2500);
  const leaveReqs = requests.slice(r1);
  results.push({ chatVisible, lkConnected, left, joinReqs: joinReqs.length, leaveReqs: leaveReqs.length,
    joinTimeline: timeline(joinReqs, t0), leaveTimeline: timeline(leaveReqs, t1),
    joinMarks: joinMarks && joinMarks.map(([name, at]) => [name, at - t0]),
    joinTools: joinReqs.filter((q) => q.name.startsWith('tool:')).map((q) => [q.name.slice(5), Math.round(q.dur), Math.round(q.ttfb)]),
    leaveTools: leaveReqs.filter((q) => q.name.startsWith('tool:')).map((q) => [q.name.slice(5), Math.round(q.dur), Math.round(q.ttfb)]) });
  await page.waitForTimeout(1000);
}

// Static round trip baseline.
const staticRtt = [];
for (let i = 0; i < 10; i += 1) {
  staticRtt.push(await measure(() => page.request.get(`/webmeetAgent/roomLoader.html?rtt=${i}`)));
}

// Burst: BURST parallel copies of the captured room_list request, BURST_REPEATS times.
let burst = null;
if (burstSize > 0) {
  if (!roomListRequest) {
    burst = { error: 'no webmeet_room_list request was captured' };
  } else {
    const runs = [];
    for (let repeat = 0; repeat < burstRepeats; repeat += 1) {
      runs.push(await page.evaluate(async ({ request, size, repeat }) => {
        const started = performance.now();
        const statuses = await Promise.all(Array.from({ length: size }, async (_, index) => {
          const body = { ...request.body, id: `burst-${repeat}-${index}-${Date.now()}` };
          const response = await fetch(request.url, { method: 'POST', credentials: 'include', headers: request.headers, body: JSON.stringify(body) });
          const text = await response.text();
          return response.ok && !/"isError"\s*:\s*true/.test(text) ? 'ok' : `http-${response.status}`;
        }));
        return { wallMs: Math.round(performance.now() - started), ok: statuses.filter((s) => s === 'ok').length, failed: statuses.filter((s) => s !== 'ok') };
      }, { request: roomListRequest, size: burstSize, repeat }));
      await page.waitForTimeout(500);
    }
    const walls = runs.map((r) => r.wallMs).sort((a, b) => a - b);
    burst = { size: burstSize, repeats: burstRepeats, medianWallMs: walls[Math.floor(walls.length / 2)], runs };
  }
}

// Delete the run-scoped room through Room settings.
let deleted = false;
try {
  await item.hover();
  await item.getByRole('button', { name: 'Room settings' }).click();
  const dlg = page.locator('dialog:has(webmeet-room-settings-modal)').last();
  await dlg.getByRole('tab', { name: 'Lifecycle' }).click();
  await dlg.getByRole('button', { name: 'Delete room' }).click();
  const confirmDlg = page.locator('dialog:has(confirm-action-modal)').last();
  if (await confirmDlg.isVisible().catch(() => false)) await confirmDlg.getByRole('button', { name: 'Yes' }).click();
  await page.locator('#webmeetMeetingList .webmeet-list-item', { hasText: roomTitle }).waitFor({ state: 'detached', timeout: T });
  deleted = true;
} catch (e) { deleted = `failed: ${e.message}`; }

const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const toolAgg = {};
for (const r of results) for (const [n, d, tt] of [...r.joinTools, ...r.leaveTools]) (toolAgg[n] ||= []).push([d, tt]);
const summary = {
  label, base, cycles, roomTitle, deleted, signInMs, dashMs, createMs,
  median: {
    chatVisible: med(results.map((r) => r.chatVisible)),
    lkConnected: med(results.map((r) => r.lkConnected)),
    left: med(results.map((r) => r.left)),
    staticRtt: med(staticRtt),
  },
  perCycle: results.map((r) => [r.chatVisible, r.lkConnected, r.left, r.joinReqs, r.leaveReqs]),
  toolMedians: Object.fromEntries(Object.entries(toolAgg).map(([n, v]) => [n, { n: v.length, durMs: med(v.map((x) => x[0])), ttfbMs: med(v.map((x) => x[1])) }])),
  staticRtt,
  firstCycle: results[0],
  burst,
};
if (process.env.OUT) fs.writeFileSync(process.env.OUT, JSON.stringify({ summary, results }, null, 2));
console.log(JSON.stringify(summary, null, 1));
await browser.close();
