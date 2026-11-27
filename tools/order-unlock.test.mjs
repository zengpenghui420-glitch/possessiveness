// Order-id unlock stays on this device. Synthetic ids only.
// Chrome resolves the API and Mantle hosts to 127.0.0.1, so a missed mock
// cannot redeem a real order or a real access code.
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire('/tmp/ppt/package.json');
const puppeteer = require('puppeteer-core');

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HTML = readFileSync(join(ROOT, 'index.html'), 'utf8');
const API_HOST = 'snappy-tundra-7uesdvk-zengpenghui420-glitch.vercel.app';
const API = 'https://' + API_HOST;
const ORDER = 'P847291038475610293';
const OTHER = 'P102938475610293847';
const CODE = 'POABCD';
const PORT = 8947;
const BASE = `http://127.0.0.1:${PORT}/`;
const ART = '/opt/cursor/artifacts';
const TIERS = ['松弛放养派', '轻醋自愈型', '甜蜜圈地型', '紧握遥控器型', '高频雷达型', '全天候监控体'];

function patternError(id) {
  if (!/^P\d{18}$/.test(id)) return 'shape';
  const d = id.slice(1);
  for (const size of [1, 2, 3, 6, 9]) {
    if (d.slice(0, size).repeat(d.length / size) === d) return 'repeat';
  }
  const step = (d.charCodeAt(1) - d.charCodeAt(0) + 10) % 10;
  if (step === 1 || step === 9) {
    let seq = true;
    for (let i = 1; i < d.length; i++) {
      if ((d.charCodeAt(i) - d.charCodeAt(i - 1) + 10) % 10 !== step) seq = false;
    }
    if (seq) return 'sequence';
  }
  return '';
}
if (patternError(ORDER)) throw new Error('synthetic order is not a legal id: ' + patternError(ORDER));
if (patternError(OTHER)) throw new Error('second synthetic order is not a legal id: ' + patternError(OTHER));
if (!/^PO[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/.test(CODE)) throw new Error('synthetic code shape');

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'Content-Type,Authorization,X-Device-Id,X-Fingerprint,X-Mantle-Key',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'content-type': 'application/json',
};

function freshState() {
  return {
    vaultMode: 'ok',
    vaultRemaining: 2,
    posts: 0,
    peeks: 0,
    vaultPosts: 0,
    vaultGets: 0,
    mantleGets: 0,
    mantleDecr: 0,
    mantleIncr: 0,
    bodies: [],
    urls: [],
    unexpected: [],
  };
}

async function send(req, status, obj) {
  await req.respond({ status, headers: CORS, body: JSON.stringify(obj) });
}

async function handleApi(req, u, state) {
  if (req.method() === 'OPTIONS') {
    await req.respond({ status: 204, headers: CORS, body: '' });
    return;
  }
  state.urls.push(req.method() + ' ' + u.pathname + u.search);
  if (u.pathname === '/order/get' || u.pathname === '/order/redeem' || u.pathname.startsWith('/order/')) {
    state.unexpected.push('vercel-order ' + req.method() + ' ' + u.pathname);
    await req.abort('failed');
    return;
  }
  if (u.pathname === '/redeem' && req.method() === 'POST') {
    const body = JSON.parse(req.postData() || '{}');
    state.bodies.push(body);
    state.vaultPosts++;
    if (state.vaultMode === 'down') {
      await req.abort('failed');
      return;
    }
    if (body.quiz !== 'poss' || body.code !== CODE || body.orderId) {
      state.unexpected.push('vault body ' + JSON.stringify(body));
    }
    if (state.vaultMode === 'not_found') return send(req, 404, { ok: false, error: 'not_found' });
    if (state.vaultMode === 'exhausted') return send(req, 403, { ok: false, error: 'exhausted', remaining: 0, max: 3 });
    return send(req, 200, { ok: true, remaining: state.vaultRemaining, max: 3 });
  }
  if (u.pathname === '/get') {
    state.vaultGets++;
    return send(req, 200, { ok: true, remaining: state.vaultRemaining, max: 3 });
  }
  state.unexpected.push('api ' + req.method() + ' ' + u.pathname);
  await req.abort('failed');
}

async function handleMantle(req, u, state) {
  if (req.method() === 'OPTIONS') {
    await req.respond({ status: 204, headers: CORS, body: '' });
    return;
  }
  state.urls.push(req.method() + ' mantle ' + u.pathname);
  if (u.pathname.includes('/orders/')) {
    state.unexpected.push('mantle-order ' + u.pathname);
    await req.abort('failed');
    return;
  }
  if (req.method() === 'GET') state.mantleGets++;
  if (req.method() === 'POST' && u.pathname.includes('/increment/')) {
    const body = JSON.parse(req.postData() || '{}');
    if (body.by === -1) state.mantleDecr++;
    else if (body.by === 1) state.mantleIncr++;
  }
  state.unexpected.push('mantle ' + req.method() + ' ' + u.pathname);
  await req.abort('failed');
}

async function arm(page, state) {
  await page.setRequestInterception(true);
  page.on('request', async (req) => {
    try {
      const u = new URL(req.url());
      if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') {
        await req.continue();
        return;
      }
      if (u.hostname === API_HOST) return await handleApi(req, u, state);
      if (u.hostname === 'mantledb.sh') return await handleMantle(req, u, state);
      state.unexpected.push(u.hostname + ' ' + req.url());
      await req.abort('failed');
    } catch (e) {
      state.unexpected.push('handler ' + e.message);
      try { await req.abort('failed'); } catch (err) {}
    }
  });
}

function assert(cond, msg, state) {
  if (!cond) {
    const extra = state ? '\n' + JSON.stringify({
      posts: state.posts, peeks: state.peeks,
      vaultPosts: state.vaultPosts, vaultGets: state.vaultGets,
      mantleGets: state.mantleGets, mantleDecr: state.mantleDecr, mantleIncr: state.mantleIncr,
      bodies: state.bodies, urls: state.urls, unexpected: state.unexpected,
    }, null, 2) : '';
    throw new Error(msg + extra);
  }
}

function assertNoOrderNet(state, msg) {
  const hit = state.urls.filter((u) => u.includes('/orders/') || u.includes('/order/') || u.includes('vercel'));
  assert(hit.length === 0 && state.unexpected.length === 0, msg, state);
  assert(state.posts === 0 && state.peeks === 0 && state.vaultPosts === 0 && state.vaultGets === 0, msg, state);
  assert(state.mantleGets === 0 && state.mantleDecr === 0 && state.mantleIncr === 0, msg, state);
}

async function openAndSubmit(page, value) {
  await page.click('#btnStart');
  await page.waitForSelector('#codeMask.show');
  await page.$eval('#codeInput', (el, v) => { el.value = v; }, value);
  await page.click('#btnCodeOk');
}

async function waitQuiz(page) {
  await page.waitForFunction(() => document.getElementById('quiz').classList.contains('active'), { timeout: 8000 });
}

async function waitResult(page) {
  await page.waitForFunction(() => document.getElementById('result').classList.contains('active'), { timeout: 8000 });
}

async function fastFinish(page) {
  await page.evaluate(() => {
    ans = Array(QS.length).fill(3);
    qi = QS.length - 1;
    finish();
  });
  await waitResult(page);
}

async function answerOne(page) {
  const before = await page.$eval('#qno', (el) => el.textContent);
  await page.click('#opts .opt');
  await page.waitForFunction((prev) => document.getElementById('qno').textContent !== prev, { timeout: 3000 }, before);
}

async function shownUses(page, orderId = ORDER) {
  return page.evaluate((id) => shownOrderUses(id), orderId);
}

async function shot(page, name) {
  await mkdir(ART, { recursive: true });
  await page.screenshot({ path: join(ART, name), fullPage: false });
}

async function newPage(browser, state, opts = {}) {
  const page = await browser.newPage();
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  await page.setCacheEnabled(false);
  await page.evaluateOnNewDocument(() => {
    try {
      if (sessionStorage.getItem('__test_ready')) return;
      localStorage.clear();
      sessionStorage.clear();
      sessionStorage.setItem('__test_ready', '1');
    } catch (e) {}
  });
  await page.setViewport(opts.viewport || { width: 390, height: 844, isMobile: true, hasTouch: true });
  await arm(page, state);
  await page.goto(BASE + (opts.path || ''), { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof redeemOrder === 'function' && typeof redeemVault === 'function' && typeof shownOrderUses === 'function');
  return { page, errors };
}

const cases = [];
function test(name, fn) { cases.push({ name, fn }); }

test('source keeps vault redeem and drops order endpoints', async () => {
  assert(HTML.includes("const QUIZ_KEY='poss'"), 'quiz key');
  assert(HTML.includes("const API_BASE='" + API + "'"), 'api base');
  assert(HTML.includes("const ORDER_USES_KEY='poss_order_uses'"), 'quiz-specific storage key');
  assert(!HTML.includes('soft_persimmon_order_uses'), 'must not reuse the other quiz key');
  assert(!HTML.includes('/order/redeem') && !HTML.includes('/order/get') && !HTML.includes('/orders/'), 'order endpoints removed');
  assert(!HTML.includes('mantledb'), 'this quiz has no Mantle client');
  assert(HTML.includes("API_BASE+'/redeem'") && HTML.includes('JSON.stringify({quiz:QUIZ_KEY,code})'), 'vault redeem kept');
  assert(HTML.includes("API_BASE+'/get?quiz='"), 'vault peek kept');
  assert(HTML.includes('paidVerified:false'), 'paidVerified stays false');
  assert(!HTML.includes('暂时验证不了'), 'format-valid ids must not use that toast');
  assert(HTML.includes('>输入订单号<'), 'field title');
  assert(HTML.includes('到小红书「我的订单」复制订单号贴过来'), 'order hint');
  assert(HTML.includes('每个订单号可以测 3 次'), 'three-start hint');
  assert(HTML.includes('对方出门晚归时，你会忍不住连发几条「到哪了」「和谁在一起」。'), 'question kept');
  assert(HTML.includes('松弛放养派'), 'tier kept');
  assert(!HTML.includes('验证码') && !HTML.includes('付款') && !HTML.includes('支付'), 'buyer copy');
  assert(!HTML.includes('local-only') && !HTML.includes('cosmetic') && !HTML.includes('假的'), 'do not describe the count as fake');
});

test('format helpers reject patterns and keep PO codes off the order path', async (browser) => {
  const state = freshState();
  const { page, errors } = await newPage(browser, state);
  const out = await page.evaluate((order) => ({
    good: orderFormatError(order),
    repeat: orderFormatError('P111111111111111111'),
    seq: orderFormatError('P123456789012345678'),
    minus: orderFormatError('P987654321098765432'),
    block: orderFormatError('P121212121212121212'),
    pasted: classifyInput(' 「p8472-9103-8475-610293」 '),
    code: classifyInput(' po ab cd '),
    junk: classifyInput('hello'),
    badCode: classifyInput('POIIII'),
    shortP: classifyInput('P12345'),
    quiz: QUIZ_KEY,
    api: API_BASE,
    key: ORDER_USES_KEY,
    p19: orderFormatError('P9900000000000001378'),
    p19c: classifyInput('P9900000000000001378').type,
    copy: orderSuccessText({ ok: true, uses: 1, remaining: 2, paidVerified: false }),
    lastCopy: orderSuccessText({ ok: true, uses: 3, remaining: 0, paidVerified: false }),
    laterCopy: orderSuccessText({ ok: true, uses: 4, remaining: 0, paidVerified: false }),
    vaultCopy: orderSuccessText({ ok: true, remaining: 2, max: 3 }),
    paid: noteDisplayedUse('P564738291056473829').paidVerified,
  }), ORDER);
  assert(out.good === '', 'legal synthetic id rejected ' + out.good);
  assert(out.repeat === 'invalid' && out.seq === 'invalid' && out.minus === 'invalid' && out.block === 'invalid', 'pattern ids should be invalid');
  assert(out.pasted.type === 'order' && out.pasted.orderId === ORDER, 'paste normalize ' + JSON.stringify(out.pasted));
  assert(out.code.type === 'code' && out.code.code === CODE, 'spaced PO code ' + JSON.stringify(out.code));
  assert(out.junk.type === 'order-invalid' && out.badCode.type === 'order-invalid' && out.shortP.type === 'order-invalid', 'classifier mixed');
  assert(out.quiz === 'poss' && out.api === API && out.key === 'poss_order_uses', 'quiz constants');
  assert(out.p19 === 'invalid' && out.p19c === 'order-invalid', '19-digit id must stay invalid');
  assert(out.copy === '验证成功，还可以测 2 次', out.copy);
  assert(out.lastCopy === '验证成功，这是最后一次', out.lastCopy);
  assert(out.laterCopy === '验证成功', out.laterCopy);
  assert(out.vaultCopy === '验证成功，还可以测 2 次', 'vault remaining toast ' + out.vaultCopy);
  assert(out.paid === false, 'paidVerified');
  assertNoOrderNet(state, 'format checks must not hit the network');
  assert(errors.length === 0, errors.join('\n'));
  await page.close();
});

test('valid id starts with no order request; refresh and continue keep the count', async (browser) => {
  const state = freshState();
  const { page, errors } = await newPage(browser, state);
  const visible = await page.evaluate(() => document.body.innerText);
  assert(visible.includes('恋爱占有欲指数测试'), 'product title');
  assert(!visible.includes('验证码') && !visible.includes('付款') && !visible.includes('支付') && !visible.includes('paidVerified'), 'start copy');
  await openAndSubmit(page, ' 「p8472-9103-8475-610293」 ');
  await waitQuiz(page);
  assert(await shownUses(page) === 1, 'first start should display one use');
  assertNoOrderNet(state, 'first start must not call the network');
  const toast = await page.$eval('#toast', (el) => el.textContent);
  assert(toast === '验证成功，还可以测 2 次', 'success copy ' + toast);
  const q1 = await page.$eval('#qtext', (el) => el.textContent);
  const prog1 = await page.$eval('#qprog', (el) => el.textContent);
  assert(prog1 === '1 / 18' && q1.length > 0, prog1 + ' ' + q1);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitQuiz(page);
  const same = await page.$eval('#qtext', (el) => el.textContent);
  assert(same === q1, 'refresh changed the question');
  assert(await shownUses(page) === 1, 'refresh at question 1 must not change the display count');
  assertNoOrderNet(state, 'refresh must not call the network');
  await answerOne(page);
  await answerOne(page);
  const prog = await page.$eval('#qprog', (el) => el.textContent);
  assert(prog === '3 / 18', 'progress ' + prog);
  const midText = await page.$eval('#qtext', (el) => el.textContent);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitQuiz(page);
  const resumed = await page.evaluate(() => ({
    prog: document.getElementById('qprog').textContent,
    text: document.getElementById('qtext').textContent,
    qi,
    a0: ans[0],
    a1: ans[1],
  }));
  assert(resumed.prog === '3 / 18' && resumed.qi === 2 && resumed.text === midText && resumed.a0 === 1 && resumed.a1 === 1, 'mid refresh ' + JSON.stringify(resumed));
  assert(await shownUses(page) === 1, 'mid refresh must not change the display count');
  assertNoOrderNet(state, 'mid refresh must not call the network');
  await page.click('#qback');
  await page.click('#qback');
  await page.click('#qback');
  await page.waitForFunction(() => document.getElementById('start').classList.contains('active'));
  const label = await page.$eval('#btnStart', (el) => el.textContent);
  assert(label === '继续答题', label);
  await page.click('#btnStart');
  await waitQuiz(page);
  const cont = await page.evaluate(() => ({
    prog: document.getElementById('qprog').textContent,
    sel: document.querySelectorAll('#opts .opt.sel').length,
    a0: ans[0],
  }));
  assert(cont.prog === '1 / 18' && cont.sel === 1 && cont.a0 === 1, 'continue kept this attempt ' + JSON.stringify(cont));
  assert(await shownUses(page) === 1, 'continue must not change the display count');
  assertNoOrderNet(state, 'continue must not call the network');
  const stored = await page.evaluate((key) => localStorage.getItem(key), 'poss_order_uses');
  assert(stored && stored.includes(ORDER) && !localStorageKeyLeak(stored), 'stored count ' + stored);
  assert(errors.length === 0, errors.join('\n'));
  await page.close();
});

function localStorageKeyLeak(raw) {
  return raw.includes('soft_persimmon');
}

test('result restore and 查看上次结果 do not advance; 重新测试 does; a later entry still opens', async (browser) => {
  const state = freshState();
  const { page, errors } = await newPage(browser, state);
  await openAndSubmit(page, ORDER);
  await waitQuiz(page);
  await fastFinish(page);
  const firstIndex = await page.$eval('.index-num', (el) => el.textContent);
  assert(firstIndex === '50', 'all-neutral index ' + firstIndex);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitResult(page);
  const peeked = await page.$eval('.index-num', (el) => el.textContent);
  assert(peeked === firstIndex, 'result refresh changed the index');
  assert(await shownUses(page) === 1, 'result refresh changed the display count');
  assertNoOrderNet(state, 'result refresh must not call the network');

  await page.click('#btnViewLast');
  await page.waitForFunction(() => document.getElementById('toast').textContent.includes('不扣次'));
  assert(await shownUses(page) === 1, 'view last changed the display count');
  assertNoOrderNet(state, 'view last must not call the network for an order');

  await page.click('#btnRetry');
  await waitQuiz(page);
  assert(await shownUses(page) === 2, 'retest should display the second use');
  const secondToast = await page.$eval('#toast', (el) => el.textContent);
  assert(secondToast === '验证成功，还可以测 1 次', secondToast);
  const restarted = await page.evaluate(() => ({ prog: document.getElementById('qprog').textContent, len: ans.length }));
  assert(restarted.prog === '1 / 18' && restarted.len === 0, 'retest should open a new attempt ' + JSON.stringify(restarted));
  await fastFinish(page);
  await page.click('#btnRetry');
  await waitQuiz(page);
  assert(await shownUses(page) === 3, 'third displayed use');
  const thirdToast = await page.$eval('#toast', (el) => el.textContent);
  assert(thirdToast === '验证成功，这是最后一次', thirdToast);
  await fastFinish(page);
  await page.click('#btnRetry');
  await waitQuiz(page);
  await page.waitForFunction(() => document.getElementById('toast').textContent === '验证成功');
  const after = await page.evaluate((id) => ({
    quiz: document.getElementById('quiz').classList.contains('active'),
    toast: document.getElementById('toast').textContent,
    uses: shownOrderUses(id),
  }), ORDER);
  assert(after.quiz, 'a later entry must still open the quiz');
  assert(after.toast === '验证成功' && !after.toast.includes('用完') && !after.toast.includes('暂时验证不了'), after.toast);
  assert(await shownUses(page) === 4, 'later entry still records a display count');
  assertNoOrderNet(state, 'later entry must not call the network');

  await page.evaluate(() => { clearUnlock(); show('start'); });
  await openAndSubmit(page, OTHER);
  await waitQuiz(page);
  const split = await page.evaluate((a, b) => ({ a: shownOrderUses(a), b: shownOrderUses(b), raw: localStorage.getItem(ORDER_USES_KEY) }), ORDER, OTHER);
  assert(split.a === 4 && split.b === 1, 'counts must be per order id ' + JSON.stringify(split));
  const otherToast = await page.$eval('#toast', (el) => el.textContent);
  assert(otherToast === '验证成功，还可以测 2 次', otherToast);
  assertNoOrderNet(state, 'a second id must not call the network');
  assert(errors.length === 0, errors.join('\n'));
  await page.close();
});

test('19-digit, repeating, and sequence ids are rejected on the page', async (browser) => {
  const state = freshState();
  const { page, errors } = await newPage(browser, state);
  await page.click('#btnStart');
  await page.waitForSelector('#codeMask.show');
  const title = await page.$eval('.code-panel h3', (el) => el.textContent);
  assert(title === '输入订单号', title);
  for (const raw of ['P111111111111111111', 'P123456789012345678', 'P9900000000000001378', 'hello']) {
    await page.evaluate(() => { document.getElementById('toast').textContent = ''; });
    await page.$eval('#codeInput', (el, v) => { el.value = v; }, raw);
    await page.click('#btnCodeOk');
    await page.waitForFunction(() => document.getElementById('toast').textContent.includes('订单号格式不对'));
    const onQuiz = await page.$eval('#quiz', (el) => el.classList.contains('active'));
    assert(!onQuiz, raw + ' started the quiz');
  }
  assertNoOrderNet(state, 'rejected ids must not call the network');
  assert(errors.length === 0, errors.join('\n'));
  await page.close();
});

test('access codes hit the vault and do not fall through to Mantle or orders', async (browser) => {
  const state = freshState();
  const { page, errors } = await newPage(browser, state);
  await openAndSubmit(page, ' po ab cd ');
  await waitQuiz(page);
  assert(state.vaultPosts === 1 && state.bodies[0].quiz === 'poss' && state.bodies[0].code === CODE, 'vault body', state);
  assert(!('orderId' in state.bodies[0]), 'legacy redeem must not send orderId', state);
  assert(state.posts === 0 && state.peeks === 0 && state.mantleGets === 0 && state.mantleDecr === 0, 'vault hit must not touch orders or Mantle', state);
  assert(state.urls.some((u) => u.startsWith('POST /redeem')), 'vault url', state);
  const toast = await page.$eval('#toast', (el) => el.textContent);
  assert(toast === '验证成功，还可以测 2 次', 'vault remaining ' + toast);
  assert(errors.length === 0, errors.join('\n'));
  await page.close();

  const miss = freshState();
  miss.vaultMode = 'not_found';
  const opened = await newPage(browser, miss);
  await openAndSubmit(opened.page, CODE);
  await opened.page.waitForFunction(() => document.getElementById('toast').textContent.includes('订单号不对'));
  const onQuiz = await opened.page.$eval('#quiz', (el) => el.classList.contains('active'));
  assert(!onQuiz && miss.vaultPosts === 1 && miss.mantleGets === 0 && miss.mantleDecr === 0, 'vault miss must not call Mantle', miss);
  assert(!miss.urls.some((u) => u.includes('/order/')), 'vault miss called an order route', miss);
  await opened.page.close();

  const done = freshState();
  done.vaultMode = 'exhausted';
  const second = await newPage(browser, done);
  await openAndSubmit(second.page, CODE);
  await second.page.waitForFunction(() => document.getElementById('toast').textContent.includes('次数已经用完'));
  const still = await second.page.$eval('#quiz', (el) => el.classList.contains('active'));
  assert(!still && done.vaultPosts === 1 && done.mantleGets === 0 && done.mantleDecr === 0, 'exhausted vault fell through', done);
  await second.page.close();

  const down = freshState();
  down.vaultMode = 'down';
  const third = await newPage(browser, down);
  await openAndSubmit(third.page, CODE);
  await third.page.waitForFunction(() => document.getElementById('toast').textContent.includes('网络异常'));
  const unlocked = await third.page.evaluate(() => isUnlocked());
  assert(!unlocked && down.mantleGets === 0 && down.mantleDecr === 0, 'vault outage fell through', down);
  await third.page.close();
});

test('an already unlocked access code does not redeem again until 重新测试', async (browser) => {
  const state = freshState();
  const { page, errors } = await newPage(browser, state);
  await openAndSubmit(page, CODE);
  await waitQuiz(page);
  assert(state.vaultPosts === 1, 'first code redeem', state);
  await page.evaluate(() => { show('start'); });
  await page.click('#btnStart');
  await waitQuiz(page);
  assert(state.vaultPosts === 1 && state.mantleDecr === 0 && state.posts === 0, 'same tab must not redeem again', state);
  await fastFinish(page);
  await page.click('#btnRetry');
  await page.waitForSelector('#codeMask.show');
  const prefill = await page.$eval('#codeInput', (el) => el.value);
  assert(prefill === CODE, 'retry prefill ' + prefill);
  assert(state.vaultPosts === 1, 'opening the code again must not redeem yet', state);
  await page.click('#btnCodeOk');
  await waitQuiz(page);
  assert(state.vaultPosts === 2 && state.bodies[1].code === CODE && state.bodies[1].quiz === 'poss', 'code retry uses vault redeem', state);
  assert(state.mantleDecr === 0 && state.posts === 0, 'code retry must not call Mantle or orders', state);
  assert(errors.length === 0, errors.join('\n'));
  await page.close();
});

test('query string does not redeem by itself', async (browser) => {
  const order = freshState();
  const p1 = await newPage(browser, order, { path: '?code=' + ORDER });
  await new Promise((r) => setTimeout(r, 200));
  const started = await p1.page.$eval('#quiz', (el) => el.classList.contains('active'));
  assert(!started && await shownUses(p1.page) === 0, 'query order must not start');
  assertNoOrderNet(order, 'query order must not call the network');
  await p1.page.close();

  const code = freshState();
  const p2 = await newPage(browser, code, { path: '?code=' + CODE });
  await new Promise((r) => setTimeout(r, 200));
  const opened = await p2.page.$eval('#codeMask', (el) => el.classList.contains('show'));
  const value = await p2.page.$eval('#codeInput', (el) => el.value);
  assert(opened && value === CODE, 'query code opens the field ' + value);
  assert(code.vaultPosts === 0 && code.mantleGets === 0 && code.posts === 0, 'query code must not redeem by itself', code);
  await p2.page.close();
});

test('order field fits at 390', async (browser) => {
  const state = freshState();
  const { page, errors } = await newPage(browser, state, { viewport: { width: 390, height: 844, isMobile: true, hasTouch: true } });
  await page.click('#btnStart');
  await page.waitForSelector('#codeMask.show');
  await page.$eval('#codeInput', (el, v) => { el.value = v; }, ORDER);
  const box = await page.evaluate(() => {
    const input = document.getElementById('codeInput');
    const r = input.getBoundingClientRect();
    return {
      title: document.querySelector('.code-panel h3').textContent,
      hint: document.querySelector('.code-hint').innerText,
      left: r.left,
      right: r.right,
      vw: window.innerWidth,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  assert(box.title === '输入订单号' && box.hint.includes('我的订单') && box.hint.includes('3 次'), JSON.stringify(box));
  assert(box.left >= -1 && box.right <= box.vw + 1 && box.overflow <= 1, JSON.stringify(box));
  await shot(page, 'poss-order-modal-390.png');
  await page.click('#btnCodeOk');
  await waitQuiz(page);
  await shot(page, 'poss-quiz-390.png');
  assert(errors.length === 0, errors.join('\n'));
  await page.close();
});

const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], {
  cwd: ROOT,
  stdio: 'ignore',
});
await new Promise((resolve) => setTimeout(resolve, 300));

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome',
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    `--host-resolver-rules=MAP ${API_HOST} 127.0.0.1, MAP mantledb.sh 127.0.0.1`,
  ],
});

let failed = 0;
try {
  for (const c of cases) {
    try {
      await c.fn(browser);
      console.log('ok  ' + c.name);
    } catch (e) {
      failed++;
      console.error('FAIL ' + c.name);
      console.error(e && e.stack || e);
    }
  }
} finally {
  await browser.close();
  server.kill();
}
if (failed) {
  console.error(failed + ' failed');
  process.exit(1);
}
console.log(cases.length + ' passed');
