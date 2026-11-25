#!/usr/bin/env node
/**
 * Mock the order gate and the legacy vault path. Never calls the live API
 * and never uses a real order id or a real access code.
 *
 *   NODE_PATH=/tmp/poss-test/node_modules node tools/order-unlock-mock.mjs
 */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire('/tmp/poss-test/package.json');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const API = 'https://snappy-tundra-7uesdvk-zengpenghui420-glitch.vercel.app';
const ORDER = 'P102938475610293847';
const CODE = 'POAB2K';
const TIERS = ['松弛放养派', '轻醋自愈型', '甜蜜圈地型', '紧握遥控器型', '高频雷达型', '全天候监控体'];
const CHROME = process.env.CHROME || '/usr/local/bin/google-chrome';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

function staticChecks() {
  const checks = [
    ['api base', HTML.includes(`const API_BASE='${API}'`)],
    ['quiz poss', HTML.includes("const QUIZ_KEY='poss'")],
    ['order redeem path', HTML.includes("API_BASE+'/order/redeem'")],
    ['order peek path', HTML.includes("API_BASE+'/order/get?quiz='")],
    ['vault redeem path', HTML.includes("API_BASE+'/redeem'")],
    ['vault peek path', HTML.includes("API_BASE+'/get?quiz='")],
    ['vault body uses code', HTML.includes('JSON.stringify({quiz:QUIZ_KEY,code})')],
    ['order body uses orderId', HTML.includes('JSON.stringify({quiz:QUIZ_KEY,orderId})')],
    ['no placeholder host', !HTML.includes('tmp.now')],
    ['no 验证码 in page', !HTML.includes('验证码')],
    ['no 付款 in page', !HTML.includes('付款')],
    ['no 支付 in page', !HTML.includes('支付')],
    ['xiaohongshu copy', HTML.includes('到小红书「我的订单」复制订单号贴过来')],
    ['three uses copy', HTML.includes('每个订单号可以测 3 次')],
    ['question kept', HTML.includes('对方出门晚归时，你会忍不住连发几条「到哪了」「和谁在一起」。')],
    ['tier kept', HTML.includes('松弛放养派')],
  ];
  checks.forEach(([name, ok]) => check('static ' + name, ok));
}

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', ['-u', '-m', 'http.server', '0', '--bind', '127.0.0.1'], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString();
      const m = buf.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) {
        child.stdout.off('data', onData);
        resolve({ child, origin: `http://127.0.0.1:${m[1]}/` });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', reject);
    setTimeout(() => reject(new Error('server did not start: ' + buf)), 5000);
  });
}

function orderPayload(uses, orderId) {
  const max = 3;
  return {
    ok: true,
    remaining: Math.max(0, max - uses),
    max,
    uses,
    quiz: 'poss',
    orderId,
    bound: true,
    paidVerified: false,
  };
}

function makeState() {
  return {
    uses: 0,
    bound: null,
    orderMode: 'ok',
    codeMode: 'ok',
  };
}

async function attach(page, state) {
  const hits = [];
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const url = req.url();
    let parsed;
    try { parsed = new URL(url); } catch (e) { req.continue(); return; }
    const host = parsed.hostname;
    const isApi = host.includes('vercel.app') || host.includes('snappy-tundra') || host.includes('tmp.now');
    if (!isApi) { req.continue(); return; }
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Device-Id,X-Fingerprint',
      'Cache-Control': 'no-store',
    };
    if (req.method() === 'OPTIONS') {
      req.respond({ status: 204, headers: cors, body: '' });
      return;
    }
    const pathName = parsed.pathname;
    const record = {
      method: req.method(),
      path: pathName,
      search: parsed.search,
      body: req.postData() || '',
      quiz: parsed.searchParams.get('quiz'),
    };
    hits.push(record);
    const send = (status, obj) => req.respond({
      status,
      contentType: 'application/json',
      headers: cors,
      body: JSON.stringify(obj),
    });
    if (pathName === '/order/get') {
      record.kind = 'order-peek';
      if (state.bound === 'other') return send(403, { ok: false, error: 'bound_other_quiz' });
      if (!state.uses) return send(404, { ok: false, error: 'not_found' });
      return send(200, orderPayload(state.uses, parsed.searchParams.get('orderId')));
    }
    if (pathName === '/order/redeem') {
      record.kind = 'order-redeem';
      let posted = {};
      try { posted = JSON.parse(record.body || '{}'); } catch (e) { posted = {}; }
      record.posted = posted;
      if (state.orderMode === 'bound') return send(403, { ok: false, error: 'bound_other_quiz' });
      if (state.orderMode === 'timeout-charged') {
        state.uses += 1;
        state.bound = 'poss';
        state.orderMode = 'ok';
        return send(504, { ok: false, error: 'gateway' });
      }
      if (state.orderMode === 'timeout-open') {
        state.orderMode = 'ok';
        return send(504, { ok: false, error: 'gateway' });
      }
      if (state.orderMode === 'abort') {
        state.uses += 1;
        state.bound = 'poss';
        state.orderMode = 'ok';
        setTimeout(() => { try { send(504, { ok: false, error: 'gateway' }); } catch (e) {} }, 3000);
        return;
      }
      if (state.uses >= 3) return send(403, { ok: false, error: 'exhausted', remaining: 0, max: 3 });
      state.uses += 1;
      state.bound = 'poss';
      return send(200, orderPayload(state.uses, posted.orderId));
    }
    if (pathName === '/redeem') {
      record.kind = 'vault-redeem';
      let posted = {};
      try { posted = JSON.parse(record.body || '{}'); } catch (e) { posted = {}; }
      record.posted = posted;
      if (state.codeMode === 'exhausted') return send(403, { ok: false, error: 'exhausted' });
      if (state.codeMode === 'invalid') return send(404, { ok: false, error: 'not_found' });
      return send(200, { ok: true, remaining: 2, max: 3 });
    }
    if (pathName === '/get') {
      record.kind = 'vault-peek';
      return send(200, { ok: true, remaining: 2, max: 3 });
    }
    record.kind = 'unexpected';
    return send(500, { ok: false, error: 'unexpected' });
  });
  page.on('pageerror', (err) => console.log('PAGEERROR', err.message));
  return hits;
}

function count(hits, kind) {
  return hits.filter((h) => h.kind === kind);
}

async function openOrder(page, raw) {
  await page.click('#btnStart');
  await page.waitForSelector('.code-mask.show');
  await page.$eval('#codeInput', (el, v) => {
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, raw);
  await page.click('#btnCodeOk');
}

async function finishQuiz(page) {
  for (let i = 0; i < 24; i++) {
    const onQuiz = await page.$eval('#quiz', (el) => el.classList.contains('active'));
    if (!onQuiz) break;
    await page.click('#opts button.opt');
    await delay(230);
  }
  await page.waitForSelector('#result.active', { timeout: 5000 });
}

async function visibleText(page) {
  return page.$eval('body', (el) => el.innerText);
}

async function overflow(page) {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

async function freshPage(browser, state, viewport) {
  const page = await browser.newPage();
  await page.setViewport(viewport || { width: 390, height: 844, isMobile: true, hasTouch: true });
  await page.evaluateOnNewDocument(() => { globalThis.__ORDER_RECONCILE_MS = 0; });
  const hits = await attach(page, state);
  return { page, hits };
}

async function reset(page, origin) {
  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { sessionStorage.clear(); localStorage.clear(); });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await delay(80);
}

async function main() {
  staticChecks();
  const { child, origin } = await startServer();
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--font-render-hinting=none'],
  });
  try {
    await testFormats(browser, origin);
    await testHappyPath(browser, origin);
    await testWrongBind(browser, origin);
    await testTimeoutCharged(browser, origin);
    await testTimeoutOpen(browser, origin);
    await testAbort(browser, origin);
    await testLegacy(browser, origin);
    await testMobile(browser, origin);
  } finally {
    await browser.close();
    child.kill('SIGTERM');
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exit(1);
}

async function testFormats(browser, origin) {
  const state = makeState();
  const { page, hits } = await freshPage(browser, state);
  await reset(page, origin);
  await openOrder(page, 'P111111111111111111');
  await delay(200);
  const toast = await page.$eval('#toast', (el) => el.textContent);
  check('format repeating rejected', toast.includes('订单号格式不对') && hits.length === 0, toast);
  await page.click('#codeClose');
  await openOrder(page, 'P123456789012345678');
  await delay(200);
  const toast2 = await page.$eval('#toast', (el) => el.textContent);
  check('format sequence rejected', toast2.includes('订单号格式不对') && hits.length === 0, toast2);
  await page.close();
}

async function testHappyPath(browser, origin) {
  const state = makeState();
  const { page, hits } = await freshPage(browser, state);
  await reset(page, origin);
  const before = await visibleText(page);
  check('start has no 验证码', !before.includes('验证码') && !before.includes('付款') && !before.includes('支付'));
  await openOrder(page, 'p1029-3847-5610-293847');
  await page.waitForSelector('#quiz.active', { timeout: 8000 });
  const redeems = count(hits, 'order-redeem');
  const peeks = count(hits, 'order-peek');
  check('first redeem once', redeems.length === 1, 'redeems=' + redeems.length);
  check('first redeem quiz poss', redeems[0] && redeems[0].posted && redeems[0].posted.quiz === 'poss' && redeems[0].posted.orderId === ORDER, JSON.stringify(redeems[0] && redeems[0].posted));
  check('first redeem no code field', redeems[0] && !('code' in (redeems[0].posted || {})));
  check('peek before first redeem', peeks.length === 1 && peeks[0].quiz === 'poss');
  check('no vault on order', count(hits, 'vault-redeem').length === 0 && count(hits, 'vault-peek').length === 0);
  check('uses is 1', state.uses === 1, 'uses=' + state.uses);
  const q1 = await page.$eval('#qtext', (el) => el.textContent);
  const prog1 = await page.$eval('#qprog', (el) => el.textContent);
  check('quiz starts at 1', prog1 === '1 / 18', prog1);
  await page.click('#opts button.opt');
  await delay(260);
  const q2 = await page.$eval('#qtext', (el) => el.textContent);
  const prog2 = await page.$eval('#qprog', (el) => el.textContent);
  check('advanced to question 2', prog2 === '2 / 18' && q2 !== q1, prog2);
  const mark = hits.length;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#quiz.active', { timeout: 8000 });
  const mid = hits.slice(mark);
  const midText = await page.$eval('#qtext', (el) => el.textContent);
  const midProg = await page.$eval('#qprog', (el) => el.textContent);
  check('mid refresh peeks only', mid.every((h) => h.kind === 'order-peek') && mid.length >= 1, mid.map((h) => h.kind).join(','));
  check('mid refresh same question', midText === q2 && midProg === '2 / 18', midProg + ' ' + midText.slice(0, 12));
  check('mid refresh did not deduct', state.uses === 1, 'uses=' + state.uses);
  await page.click('#qback');
  await delay(40);
  await page.click('#qback');
  await page.waitForSelector('#start.active');
  const label = await page.$eval('#btnStart', (el) => el.textContent);
  check('continue label', label === '继续答题', label);
  const mark2 = hits.length;
  await page.click('#btnStart');
  await page.waitForSelector('#quiz.active', { timeout: 8000 });
  const cont = hits.slice(mark2);
  const backText = await page.$eval('#qtext', (el) => el.textContent);
  const backProg = await page.$eval('#qprog', (el) => el.textContent);
  check('continue peeks only', cont.every((h) => h.kind === 'order-peek') && cont.length >= 1, cont.map((h) => h.kind).join(','));
  check('continue resumes question 1', backProg === '1 / 18' && backText === q1, backProg);
  check('continue did not deduct', state.uses === 1, 'uses=' + state.uses);
  await finishQuiz(page);
  const title1 = await page.$eval('#typeTitle', (el) => el.textContent);
  check('result tier from scorer', TIERS.includes(title1), title1);
  const mark3 = hits.length;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#result.active', { timeout: 8000 });
  const restored = await page.$eval('#typeTitle', (el) => el.textContent);
  const afterResult = hits.slice(mark3);
  check('result refresh peeks only', afterResult.every((h) => h.kind === 'order-peek') && afterResult.length >= 1, afterResult.map((h) => h.kind).join(','));
  check('result refresh same result', restored === title1, restored);
  check('result refresh did not deduct', state.uses === 1, 'uses=' + state.uses);
  const mark4 = hits.length;
  await page.click('#btnRetry');
  await page.waitForSelector('#quiz.active', { timeout: 8000 });
  const retryHits = hits.slice(mark4).filter((h) => h.kind === 'order-redeem');
  check('retest redeems once', retryHits.length === 1 && retryHits[0].posted.quiz === 'poss', 'n=' + retryHits.length);
  check('retest uses 2', state.uses === 2, 'uses=' + state.uses);
  check('retest starts at 1', (await page.$eval('#qprog', (el) => el.textContent)) === '1 / 18');
  await finishQuiz(page);
  await page.click('#btnRetry');
  await page.waitForSelector('#quiz.active', { timeout: 8000 });
  check('third attempt uses 3', state.uses === 3, 'uses=' + state.uses);
  await finishQuiz(page);
  const kept = await page.$eval('#typeTitle', (el) => el.textContent);
  const postsBefore = count(hits, 'order-redeem').length;
  await page.click('#btnRetry');
  await delay(400);
  const toast = await page.$eval('#toast', (el) => el.textContent);
  const still = await page.$eval('#typeTitle', (el) => el.textContent);
  const onResult = await page.$eval('#result', (el) => el.classList.contains('active'));
  check('fourth rejected', toast.includes('3 次已经用完') && count(hits, 'order-redeem').length === postsBefore, toast);
  check('fourth keeps result', onResult && still === kept && state.uses === 3, still);
  const surface = await visibleText(page);
  check('result surface has no payment copy', !surface.includes('验证码') && !surface.includes('付款') && !surface.includes('支付') && !surface.includes('paidVerified'));
  await page.close();
}

async function testWrongBind(browser, origin) {
  const state = makeState();
  state.bound = 'other';
  const { page, hits } = await freshPage(browser, state);
  await reset(page, origin);
  await openOrder(page, ORDER);
  await delay(400);
  const toast = await page.$eval('#toast', (el) => el.textContent);
  const onStart = await page.$eval('#start', (el) => el.classList.contains('active'));
  check('wrong bind toast', toast.includes('已经用来测过别的测试'), toast);
  check('wrong bind stays on start', onStart && count(hits, 'order-redeem').length === 0 && state.uses === 0);
  check('wrong bind peeked poss', count(hits, 'order-peek').every((h) => h.quiz === 'poss'));
  await page.close();
}

async function testTimeoutCharged(browser, origin) {
  const state = makeState();
  state.orderMode = 'timeout-charged';
  const { page, hits } = await freshPage(browser, state);
  await reset(page, origin);
  await openOrder(page, ORDER);
  await page.waitForSelector('#quiz.active', { timeout: 8000 });
  const redeems = count(hits, 'order-redeem');
  check('timeout charged does not redeem twice', redeems.length === 1 && state.uses === 1, 'redeems=' + redeems.length + ' uses=' + state.uses);
  check('timeout charged quiz poss', redeems[0].posted.quiz === 'poss');
  await page.close();
}

async function testTimeoutOpen(browser, origin) {
  const state = makeState();
  state.orderMode = 'timeout-open';
  const { page, hits } = await freshPage(browser, state);
  await reset(page, origin);
  page.on('requestfinished', () => {});
  await openOrder(page, ORDER);
  await page.waitForFunction(() => document.getElementById('quiz').classList.contains('active'), { timeout: 8000 });
  const redeems = count(hits, 'order-redeem');
  check('timeout open retries once', redeems.length === 2 && state.uses === 1, 'redeems=' + redeems.length + ' uses=' + state.uses);
  await page.close();
}

async function testAbort(browser, origin) {
  const state = makeState();
  state.orderMode = 'abort';
  const { page, hits } = await freshPage(browser, state);
  await page.evaluateOnNewDocument(() => { globalThis.__ORDER_TIMEOUT_MS = 600; });
  await reset(page, origin);
  await page.evaluate(() => { globalThis.__ORDER_TIMEOUT_MS = 600; globalThis.__ORDER_RECONCILE_MS = 0; });
  await openOrder(page, ORDER);
  try {
    await page.waitForSelector('#quiz.active', { timeout: 8000 });
    const redeems = count(hits, 'order-redeem');
    check('abort reconcile accepts peeked charge', state.uses === 1 && redeems.length === 1, 'redeems=' + redeems.length + ' uses=' + state.uses);
  } catch (e) {
    check('abort reconcile accepts peeked charge', false, e.message);
  }
  await page.close();
}

async function testLegacy(browser, origin) {
  const state = makeState();
  const { page, hits } = await freshPage(browser, state);
  await page.goto(origin + '?code=' + CODE, { waitUntil: 'domcontentloaded' });
  await delay(150);
  const opened = await page.$eval('.code-mask', (el) => el.classList.contains('show'));
  const value = await page.$eval('#codeInput', (el) => el.value);
  const title = await page.$eval('.code-panel h3', (el) => el.textContent);
  check('legacy url opens order field', opened && value === CODE && title === '输入订单号', title + ' ' + value);
  check('legacy url does not redeem by itself', hits.length === 0, 'hits=' + hits.length);
  await page.click('#btnCodeOk');
  await page.waitForSelector('#quiz.active', { timeout: 8000 });
  const vault = count(hits, 'vault-redeem');
  check('legacy posts vault redeem', vault.length === 1 && vault[0].posted.quiz === 'poss' && vault[0].posted.code === CODE, JSON.stringify(vault[0] && vault[0].posted));
  check('legacy does not call order api', count(hits, 'order-redeem').length === 0 && count(hits, 'order-peek').length === 0);
  check('legacy path is /redeem', vault[0] && vault[0].path === '/redeem');
  const mark = hits.length;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await delay(300);
  const onStart = await page.$eval('#start', (el) => el.classList.contains('active'));
  await page.click('#btnStart');
  await page.waitForSelector('#quiz.active', { timeout: 4000 });
  check('legacy refresh does not redeem again', onStart && hits.length === mark, 'new hits=' + (hits.length - mark));
  await page.close();
}

async function testMobile(browser, origin) {
  const dir = '/opt/cursor/artifacts';
  for (const width of [320, 390]) {
    const state = makeState();
    const { page } = await freshPage(browser, state, { width, height: 780, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await reset(page, origin);
    await page.click('#btnStart');
    await page.waitForSelector('.code-mask.show');
    const gap = await overflow(page);
    const text = await visibleText(page);
    check(`mobile ${width} modal copy`, text.includes('输入订单号') && text.includes('我的订单') && text.includes('3 次'), text.split('\n').slice(0, 8).join('/'));
    check(`mobile ${width} no page overflow`, gap <= 1, 'overflow=' + gap);
    const input = await page.$eval('#codeInput', (el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, width: r.width };
    });
    const vw = width;
    check(`mobile ${width} input inside`, input.left >= -1 && input.right <= vw + 1 && input.width > 80, JSON.stringify(input));
    await page.screenshot({ path: path.join(dir, `poss_order_modal_${width}.png`) });
    await page.$eval('#codeInput', (el, v) => { el.value = v; }, ORDER);
    await page.click('#btnCodeOk');
    await page.waitForSelector('#quiz.active', { timeout: 8000 });
    const quizGap = await overflow(page);
    check(`mobile ${width} quiz no overflow`, quizGap <= 1, 'overflow=' + quizGap);
    if (width === 320) await page.screenshot({ path: path.join(dir, 'poss_quiz_320.png') });
    if (width === 390) {
      await finishQuiz(page);
      const resultGap = await overflow(page);
      check('mobile 390 result no overflow', resultGap <= 1, 'overflow=' + resultGap);
      const title = await page.$eval('#typeTitle', (el) => el.textContent);
      check('mobile 390 result rendered', TIERS.includes(title), title);
      await page.screenshot({ path: path.join(dir, 'poss_result_390.png') });
    }
    await page.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
