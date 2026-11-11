/* =====================================================================
 * ui-smoke.test.cjs — 피클 화면이 기대하는 엔진 기능이 모두 있는지 점검
 * 실행: node --test tests/ui-smoke.test.cjs   (Node.js 18 이상)
 * 페이블 엔진이 바뀌어 이름이 달라지면 여기서 먼저 걸린다 → pickle-ui.js 를 맞춰 고칠 것.
 * ===================================================================== */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const W = path.join(__dirname, '../android/app/src/main/assets/www/');
globalThis.localStorage = { _: {}, getItem(k) { return this._[k] || null; }, setItem(k, v) { this._[k] = v; } };
['util.js', 'data/ports.js', 'data/land.js', 'data/seagraph.js', 'data/demo.js', 'route.js', 'parsers.js', 'bridge.js', 'store.js', 'engine.js', 'brief.js']
  .forEach((f) => require(W + 'js/' + f));
const F = globalThis.FST;

test('pickle-ui.js 가 쓰는 엔진 함수가 모두 있다', () => {
  const need = {
    Util: ['esc', 'fmtKst', 'fmtHm', 'ago', 'num', 'distNm', 'pathNm', 'pointAlong', 'compassKo', 'normName', 'fmtPos'],
    Store: ['load', 'save', 'get', 'selected', 'select', 'vessel', 'addVessel', 'removeVessel', 'reset'],
    Engine: ['view', 'refreshVessel', 'searchByName', 'srcName', 'addManualFix', 'clearCache'],
    Parsers: ['vfDetailUrl', 'wingoShipUrl'],
    Bridge: ['scrape', 'openBrowser', 'errorText'],
    Brief: ['seaArea']
  };
  for (const [mod, fns] of Object.entries(need)) for (const fn of fns) assert.equal(typeof F[mod][fn], 'function', `${mod}.${fn} 없음`);
  assert.ok(typeof F.Parsers.YSPILOT_URL === 'string' && typeof F.Parsers.WINGO === 'string');
});

test('항차 상태(view)에 피클 화면이 쓰는 값이 들어 있다', () => {
  F.Store.load();
  const v = F.Store.get().vessels[0];
  const vw = F.Engine.view(v, Date.now());
  for (const k of ['fix', 'cur', 'dr', 'dest', 'origin', 'originInfo', 'originText', 'originTs', 'destText', 'sog', 'cog', 'fresh', 'state',
    'future', 'pastTrack', 'pastEst', 'remainNm', 'progress', 'sailedNm', 'eta', 'etaCalc', 'etaAis', 'pilotRows', 'laycan']) {
    assert.ok(k in vw, 'view.' + k + ' 없음');
  }
});

test('index.html 이 엔진 파일과 pickle-ui.js 를 모두 불러온다', () => {
  const html = fs.readFileSync(W + 'index.html', 'utf8');
  for (const f of ['vendor/leaflet/leaflet.js', 'js/util.js', 'js/engine.js', 'js/brief.js', 'js/pickle-ui.js']) assert.ok(html.includes(f), f);
  assert.ok(!/unpkg\.com|cdn\./.test(html), '외부 CDN 을 쓰면 안 된다 (앱 내장)');
});
