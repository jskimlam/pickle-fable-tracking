/* =====================================================================
 * pickle-ui.js — 피클마린트래킹 화면 ↔ 페이블 엔진 연결
 * ---------------------------------------------------------------------
 * 화면(HTML·CSS)은 피클 원본을 그대로 쓰고, 데이터는 페이블 엔진에서 가져온다.
 *   - 직접 조회   : FST.Engine.refreshVessel  (Wingo → VesselFinder → 도선예보)
 *   - 선박 검색   : FST.Engine.searchByName   (Wingo 공개 검색, 탱커만 표시)
 *   - 항차 계산   : FST.Engine.view           (실측/추정 구분, 항로, ETA, 출항지)
 *   - 저장        : FST.Store                 (기기 안 저장, 서버 없음)
 * 이 파일이 하는 일은 그 결과를 피클 화면 요소(칩·지도·말풍선)에 그리는 것뿐이다.
 * 엔진 파일(js/*.js, js/data/*.js)은 fable-ship-tracking 저장소가 원본이며,
 * GitHub Actions 빌드 때 최신본으로 덮어쓴다 (HOW-IT-WORKS.md 참고).
 * ===================================================================== */
(function (root) {
  'use strict';
  var FST = root.FST;
  var U = FST.Util, S = FST.Store, E = FST.Engine, R = FST.Route, P = FST.Parsers, B = FST.Bridge, BR = FST.Brief;
  var L = root.L;
  var doc = root.document;
  var $ = function (id) { return doc.getElementById(id); };

  var CARGOS = ['SM', 'AN', 'BD', 'MMA', 'BPA'];     // 화물 태그 후보
  var busy = {};                                       // 선박 id → 갱신 중
  var runLog = {};                                     // 선박 id → 진행 중 단계 목록 [{label, state}]
  var lastPos = {};                                    // 선박 id → 직전에 그린 위치 (이동 애니메이션 출발점)
  var searchList = [];                                 // 마지막 검색 결과

  /* ================= 프로필 (피클 원본 저장 키 그대로) ================= */
  var profile = { agentName: '유리나', userName: '진수 님' };
  try {
    var pst = JSON.parse(root.localStorage.getItem('pickle_marine_profile') || 'null');
    if (pst && pst.agentName) profile.agentName = pst.agentName;
    if (pst && pst.userName) profile.userName = pst.userName;
  } catch (e) { /* 저장값이 깨졌으면 기본 프로필 */ }

  function applyProfile() {
    $('pickleAgentName').textContent = profile.agentName;
    $('pickleUserBadge').textContent = profile.userName + '의 AI 비서';
    $('tabAgentName').textContent = profile.agentName;
  }

  /* ================= 공통 ================= */
  var toastTimer = null;
  function toast(text) {
    var t = $('toast');
    t.textContent = text;
    t.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('on'); }, 3000);
  }
  function setStatus(text) { $('yurinaStatus').textContent = text; }
  function views() { var now = Date.now(); return S.get().vessels.map(function (v) { return E.view(v, now); }); }
  function curView() { var v = S.selected(); return v ? E.view(v, Date.now()) : null; }
  function canFetch() { return B.available || B.demo; }

  // "28 km S of Tokuyamakudamatsu, Japan" → "Tokuyamakudamatsu 남쪽 28km"
  function nearKo(t) {
    var m = String(t || '').match(/^([\d.,]+)\s*km\s+([NSEW]{1,3})\s+of\s+(.+)$/);
    if (!m) return t || '';
    var dir = { N: '북', S: '남', E: '동', W: '서', NE: '북동', NW: '북서', SE: '남동', SW: '남서',
      NNE: '북북동', ENE: '동북동', ESE: '동남동', SSE: '남남동', SSW: '남남서', WSW: '서남서', WNW: '서북서', NNW: '북북서' }[m[2]] || m[2];
    return m[3].replace(/,\s*[^,]+$/, '') + ' ' + dir + '쪽 ' + m[1] + 'km';
  }
  function cyan(s) { return "<span class='highlight-cyan'>" + s + '</span>'; }
  function amber(s) { return "<span class='highlight-amber'>" + s + '</span>'; }
  function blue(s) { return "<span class='highlight-blue'>" + s + '</span>'; }
  function tag(kind) {
    var t = { real: ['실측', 'tg-real'], est: ['추정', 'tg-est'], none: ['미확인', 'tg-none'], ext: ['외부 기록', 'tg-ext'] }[kind];
    return "<span class='tg " + t[1] + "'>" + t[0] + '</span>';
  }

  /* ================= 선대 칩 ================= */
  function renderChips(vws) {
    var sel = S.get().selectedId;
    var box = $('fleetChipsContainer');
    box.innerHTML = vws.map(function (vw) {
      var v = vw.v;
      return '<div class="chip' + (v.id === sel ? ' active' : '') + (busy[v.id] ? ' busy' : '') + '" data-id="' + v.id + '">' +
        '<span class="chip-label"><i class="chip-dot ' + vw.fresh + '"></i>🚢 ' + U.esc(v.name) + (v.cargo ? ' · ' + U.esc(v.cargo) : '') + '</span>' +
        '<button class="chip-delete-btn" data-del="' + v.id + '" title="' + U.esc(v.name) + ' 관제 종료">×</button></div>';
    }).join('');
  }

  /* ================= 지도 ================= */
  var map = null, layer = null, base = {}, labels = null, shipMarker = null, anim = null, styleNow = 'sat';

  function initMap() {
    map = L.map('map', { zoomControl: true, attributionControl: true, zoomSnap: 0.25 }).setView([34.0, 126.5], 6);
    map.attributionControl.setPrefix(false);
    base.sat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      { maxZoom: 17, attribution: '위성: Esri, Maxar, Earthstar Geographics' });
    labels = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
      { maxZoom: 17, opacity: 0.85 });
    base.chart = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '© OpenStreetMap' });
    layer = L.layerGroup().addTo(map);
    setStyle(S.get().settings.mapStyle || 'sat');
  }

  function setStyle(style) {
    styleNow = style === 'chart' ? 'chart' : 'sat';
    [base.sat, base.chart, labels].forEach(function (t) { if (map.hasLayer(t)) map.removeLayer(t); });
    if (styleNow === 'sat') { base.sat.addTo(map); labels.addTo(map); } else { base.chart.addTo(map); }
    $('styleLabel').textContent = styleNow === 'sat' ? '위성 지도' : '일반 지도';
  }

  function icon(html, anchor) { return L.divIcon({ className: '', html: html, iconSize: [0, 0], iconAnchor: anchor || [0, 0] }); }

  // 피클 원본 모양의 선박 표식 (추정 위치면 호박색 + '추정')
  function shipIcon(vw) {
    var est = !!(vw.cur && vw.cur.est);
    return L.divIcon({
      className: 'vessel-marker-pin',
      html: '<div class="vessel-marker-halo' + (est ? ' est' : '') + '">🚢</div>' +
        '<div class="vessel-marker-label">' + U.esc(vw.v.name) + (est ? '<span class="est-tag">추정</span>' : '') + '</div>',
      iconAnchor: [16, 28]
    });
  }

  function stopAnim() { if (anim) { root.cancelAnimationFrame(anim); anim = null; } }

  // 경로를 따라 표식을 움직인다
  function animateAlong(pts, ms, onEnd, trail) {
    stopAnim();
    var total = U.pathNm(pts);
    if (!shipMarker || pts.length < 2 || total < 0.05) { if (onEnd) onEnd(); return; }
    var t0 = null;
    function frame(ts) {
      if (t0 == null) t0 = ts;
      var k = Math.min(1, (ts - t0) / ms);
      var e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2; // 부드러운 가감속
      var pa = U.pointAlong(pts, total * e);
      shipMarker.setLatLng(pa.pos);
      if (trail) trail.setLatLngs(pts.slice(0, pa.index + 1).concat([pa.pos]));
      if (k < 1) anim = root.requestAnimationFrame(frame);
      else { anim = null; if (onEnd) onEnd(); }
    }
    anim = root.requestAnimationFrame(frame);
  }

  function drawMap(vw, opts, all) {
    opts = opts || {};
    stopAnim();
    layer.clearLayers();
    shipMarker = null;
    var bounds = [];

    // 다른 추적 선박 (작은 점, 누르면 선택)
    (all || []).forEach(function (o) {
      if (!o.cur || o.v.id === vw.v.id) return;
      var p = [o.cur.lat, o.cur.lon];
      L.marker(p, { icon: icon('<div class="other-dot"></div>', [7, 7]) }).addTo(layer).on('click', function () { selectVessel(o.v.id); });
      L.marker(p, { icon: icon('<span class="other-label">' + U.esc(o.v.name) + '</span>'), interactive: false }).addTo(layer);
    });

    // 지나온 길: 출항지~첫 실측(추정, 가는 점선) + 실측 항적(청록 실선)
    if (vw.pastEst.length > 1) {
      L.polyline(vw.pastEst, { color: '#06b6d4', weight: 2.2, opacity: 0.55, dashArray: '4 7', interactive: false }).addTo(layer);
      bounds = bounds.concat(vw.pastEst);
    }
    if (vw.pastTrack.length > 1) {
      L.polyline(vw.pastTrack, { color: '#06b6d4', weight: 3.5, opacity: 0.9, lineJoin: 'round', lineCap: 'round', interactive: false }).addTo(layer);
      bounds = bounds.concat(vw.pastTrack);
    }
    // 앞으로 갈 길: 피클 원본처럼 빨간 점선. 실측 이후 추정으로 지난 구간은 호박색 점선
    if (vw.future.length > 1) {
      var ahead = vw.future, behind = null;
      if (vw.dr) {
        var pa = U.pointAlong(vw.future, vw.dr.advNm);
        behind = vw.future.slice(0, pa.index + 1).concat([pa.pos]);
        ahead = [pa.pos].concat(vw.future.slice(pa.index + 1));
      }
      if (behind && behind.length > 1) L.polyline(behind, { color: '#f59e0b', weight: 2.5, opacity: 0.85, dashArray: '3 6', interactive: false }).addTo(layer);
      L.polyline(ahead, { color: '#ef4444', weight: 3.5, opacity: 0.95, lineJoin: 'round', lineCap: 'round', className: 'route-future', interactive: false }).addTo(layer);
      bounds = bounds.concat(vw.future);
    }
    // 출항지·목적지 이름표 (피클 원본 모양)
    if (vw.origin && !(vw.dest && vw.dest.id === vw.origin.id)) {
      var ot = vw.originTs ? (vw.originTsEst ? '약 ' : '') + U.fmtKst(vw.originTs) + ' 출항' : '출항';
      L.marker([vw.origin.lat, vw.origin.lon], { icon: icon('<div class="port-marker-origin">⚓ ' + U.esc(vw.origin.ko) + ' (' + U.esc(ot) + ')</div>', [30, 20]), interactive: false }).addTo(layer);
      bounds.push([vw.origin.lat, vw.origin.lon]);
    }
    if (vw.dest) {
      var badge = vw.eta ? U.fmtKst(vw.eta.ts) + ' ' + vw.eta.label : '도착 예정';
      L.marker([vw.dest.lat, vw.dest.lon], { icon: icon('<div class="port-marker-dest">🏁 <span class="dest-name">' + U.esc(vw.dest.ko) +
        '</span> <span class="dest-badge">' + U.esc(badge) + '</span></div>', [30, 20]), interactive: false }).addTo(layer);
      bounds.push([vw.dest.lat, vw.dest.lon]);
    }
    // 실측 지점 (최근 10개 점, 마지막에는 시각)
    (vw.v.fixes || []).slice(-10).forEach(function (f, i, arr) {
      var last = i === arr.length - 1;
      L.marker([f.lat, f.lon], { icon: icon('<div class="fix-dot"></div>', [5, 5]), interactive: false, opacity: last ? 1 : 0.55 }).addTo(layer);
      if (last) L.marker([f.lat, f.lon], { icon: icon('<span class="fix-label">실측 ' + U.fmtKst(f.t) + '</span>'), interactive: false }).addTo(layer);
    });
    // 정밀 위치가 없을 때의 개략 위치 (1도 단위)
    if (vw.coarse) {
      L.circle([vw.coarse.lat, vw.coarse.lon], { radius: 111000, color: '#c084fc', weight: 1.5, dashArray: '6 6', fillColor: '#c084fc', fillOpacity: 0.08, interactive: false }).addTo(layer);
      bounds.push([vw.coarse.lat + 1, vw.coarse.lon + 1], [vw.coarse.lat - 1, vw.coarse.lon - 1]);
    }
    // 선박 표식 + 갱신 시 이동 애니메이션
    if (vw.cur) {
      var target = [vw.cur.lat, vw.cur.lon];
      var from = lastPos[vw.v.id];
      shipMarker = L.marker(target, { icon: shipIcon(vw), zIndexOffset: 1000, interactive: false }).addTo(layer);
      bounds.push(target);
      if (opts.animate && from && U.distNm(from, target) > 0.2 && U.distNm(from, target) < 400) {
        shipMarker.setLatLng(from);
        animateAlong([from, target], 1600);
      }
      lastPos[vw.v.id] = target;
    }
    if (opts.fit && bounds.length) {
      map.flyToBounds(L.latLngBounds(bounds), { paddingTopLeft: [40, 60], paddingBottomRight: [40, 110], maxZoom: 9, duration: 0.9 });
    }
  }

  // 항적 재생: 출항지 → 실측 항적 → 추정 위치까지 선박을 움직여 보여 준다
  function replay(vw) {
    if (!vw || !vw.cur) { toast('재생할 항적이 없습니다. 위치가 확인된 뒤에 쓸 수 있어요.'); return; }
    var pts = [];
    if (vw.pastEst.length > 1) pts = pts.concat(vw.pastEst);
    if (vw.pastTrack.length > 1) pts = pts.concat(pts.length ? vw.pastTrack.slice(1) : vw.pastTrack);
    if (vw.dr && vw.future.length > 1) {
      var pa = U.pointAlong(vw.future, vw.dr.advNm);
      var seg = vw.future.slice(0, pa.index + 1).concat([pa.pos]);
      pts = pts.concat(pts.length ? seg.slice(1) : seg);
    }
    if (pts.length < 2) { toast('재생할 항적이 없습니다.'); return; }
    drawMap(vw, {}, views());
    map.flyToBounds(L.latLngBounds(pts), { paddingTopLeft: [40, 60], paddingBottomRight: [40, 110], maxZoom: 9, duration: 0.6 });
    var trail = L.polyline([pts[0]], { color: '#ffffff', weight: 4, opacity: 0.9, lineCap: 'round', interactive: false }).addTo(layer);
    shipMarker.setLatLng(pts[0]);
    setTimeout(function () {
      animateAlong(pts, 5200, function () { layer.removeLayer(trail); shipMarker.setLatLng([vw.cur.lat, vw.cur.lon]); }, trail);
    }, 700);
  }

  /* ================= 지도 위 항차 진행 띠 ================= */
  function renderStrip(vw) {
    var el = $('voyageStrip');
    if (!vw || (!vw.originText && !vw.destText)) { el.innerHTML = ''; return; }
    var pct = Math.round((vw.progress || 0) * 100);
    var ot = vw.originTs ? (vw.originTsEst ? '약 ' : '') + U.fmtKst(vw.originTs) + ' 출항' : '출항지';
    el.innerHTML =
      '<div class="vs-ends"><div>' + U.esc(ot) + '<b>' + U.esc(vw.originText || '미확인') + '</b></div>' +
      '<div>' + (vw.eta ? U.esc(vw.eta.label) + ' ' + U.fmtKst(vw.eta.ts) : '목적지') + '<b>' + U.esc(vw.destText || '미확인') + '</b></div></div>' +
      '<div class="vs-bar"><div class="done" style="width:' + pct + '%"></div><i class="end-d"></i><span class="ship" style="left:' + pct + '%">🚢</span></div>' +
      '<div class="vs-meta"><span>항해 <b>' + U.num(vw.sailedNm, 0) + '</b>해리</span><span>' + (vw.cur && vw.cur.est ? '추정 위치 기준 ' : '') + '<b>' + pct + '%</b></span>' +
      '<span>잔여 <b>' + U.num(vw.remainNm, 0) + '</b>해리</span></div>';
  }

  /* ================= 유리나 말풍선 브리핑 (데이터에 있는 값만 말한다) ================= */
  function bubbles(vw) {
    var v = vw.v, u = profile.userName, out = [];
    var vo = v.voyage || {};

    // 진행 중인 직접 조회
    if (busy[v.id]) {
      out.push({ tag: '📡 직접 조회 중', time: '잠시만요', running: true,
        text: '최신 위치를 사이트에서 직접 확인하고 있어요.<div class="step-list">' +
          (runLog[v.id] || []).map(function (s) { return '<span class="' + s.state + '">' + U.esc(s.label) + '</span>'; }).join('') + '</div>' });
    }

    // 1. 현재 위치
    var f = vw.fix;
    if (!f) {
      var t1 = u + '! <b>' + U.esc(v.name) + '</b>호는 아직 확인된 위치가 없어요. ';
      if (vw.coarse) t1 += 'VesselFinder 무료 기록으로는 ' + cyan(Math.abs(vw.coarse.lat) + '°N, ' + Math.abs(vw.coarse.lon) + '°E 부근') + ' (1도 단위, ' + U.ago(vw.coarse.ts, vw.now) + ')이라 정확하지 않아요. ';
      t1 += '🔄 최신 갱신을 누르면 Wingo에서 바로 찾아올게요.';
      out.push({ tag: '📍 1. 현재 위치', time: '미확인', text: tag('none') + t1 });
    } else {
      var near = vo.nearText ? nearKo(vo.nearText) : BR.seaArea(f.lat, f.lon);
      var t = tag('real') + u + '! <b>' + U.esc(v.name) + '</b>호는 ' + cyan('북위 ' + f.lat.toFixed(2) + '°N, 동경 ' + f.lon.toFixed(2) + '°E') +
        ' (' + U.esc(near) + ')에서 ' + U.ago(f.t, vw.now) + ' 확인됐어요 🚢' +
        '<span class="small-note">📡 ' + U.esc(E.srcName(f.src)) + ' 수신 ' + U.fmtKst(f.t) + (vo.wingoLive === false && f.src === 'wingo' ? ' · 최근 수신 끊김(Last seen)' : '') + '</span>';
      if (vw.dr) {
        t += '<div class="note-box note-amber">' + tag('est') + '같은 속력으로 항로를 따라갔다면 지금쯤 ' + amber('북위 ' + vw.dr.lat.toFixed(2) + '°N, 동경 ' + vw.dr.lon.toFixed(2) + '°E') +
          ' 부근이에요 (실측 이후 ' + U.num(vw.dr.advNm, 0) + '해리 전진 계산).</div>';
      }
      if (vw.fresh === 'stale') t += '<div class="note-box note-red">⚠️ 실측이 하루 넘게 지났어요. 추정 위치의 오차가 클 수 있으니 갱신해 주세요.</div>';
      out.push({ tag: '📍 1. 현재 위치', time: U.fmtHm(f.t) + ' 실측', text: t });
    }

    // 2. 속도·침로
    if (vw.sog == null) {
      out.push({ tag: '⚡ 2. 현재 속도 및 침로', time: '미확인', text: tag('none') + '속력·침로 정보가 아직 없어요.' });
    } else {
      var s2 = '현재 속력은 ' + cyan(U.num(vw.sog, 1) + '노트') + (vw.cog != null ? ', 침로는 ' + blue(Math.round(vw.cog) + '° ' + U.compassKo(vw.cog)) : '') + '입니다.';
      if (vw.state === 'arrived') s2 += '<div class="note-box note-cyan">⚓ <b>목적 항만 도착:</b> 부두 가까이에 멈춰 있어요.</div>';
      else if (vw.sog < 0.5) s2 += '<div class="note-box note-cyan">⚓ <b>정박·대기 중:</b> 0.5노트 미만이라 투묘나 계류 상태로 보여요. 대기 사유는 조회 데이터에 나오지 않아요.</div>';
      else if (vw.sog < 8) s2 += '<div class="note-box note-red">⚠️ <b>통상 항해 속력(10~13노트) 대비 저속:</b> 사유는 데이터로 확인되지 않아요. 흔한 경우는 선석·도선 시간에 맞춘 감속, 협수로·연안 감속, 기상 영향이에요.</div>';
      else if (vw.sog < 10.5) s2 += '<div class="note-box note-amber">💡 <b>경제 속도 범위:</b> 연료 절감이나 입항 시간 조정 구간일 때가 많아요.</div>';
      else s2 += ' 적정 순항 속도로 정상 운항 중이에요.';
      out.push({ tag: '⚡ 2. 현재 속도 및 침로', time: f ? U.fmtHm(f.t) + ' 측정' : '기록값', text: s2 });
    }

    // 3. 화물·흘수
    var s3 = v.cargo ? '화물은 <b>' + U.esc(v.cargo) + '</b>로 지정돼 있고' : '화물은 아직 지정되지 않았어요 (✏️ 선박 정보에서 SM·AN·BD 등을 고를 수 있어요)';
    s3 += vo.draught ? ', 현재 흘수는 ' + amber(U.num(vo.draught, 1) + 'm') + '(AIS 입력값)예요.' : '. 흘수 정보는 아직 없어요.';
    var spec = [v.type, v.dwt ? U.num(v.dwt, 0) + ' DWT' : '', v.loa ? v.loa + 'm' : ''].filter(Boolean).join(' · ');
    if (spec) s3 += '<span class="small-note">제원: ' + U.esc(spec) + '</span>';
    out.push({ tag: '📦 3. 화물 및 흘수 상태', time: v.cargo ? U.esc(v.cargo) : '화물 미지정', text: s3 });

    // 4. ETA
    var destTitle = vw.destText || '목적지';
    if (!vw.destText) {
      out.push({ tag: '⏱️ 4. 도착 예정일 (ETA)', time: '미확인', text: tag('none') + '목적지가 아직 확인되지 않았어요. ✏️ 선박 정보에서 목적 항만을 고르면 항로와 ETA를 계산해 드릴게요.' });
    } else {
      var oi = vw.originInfo;
      var s4 = (vw.originText ? '<b>' + U.esc(vw.originText) + '</b>' + (vw.originTs ? ' (' + (vw.originTsEst ? '약 ' : '') + U.fmtKst(vw.originTs) + ' 출항)' : '') + ' ➡️ ' : '') + '<b>' + U.esc(destTitle) + '</b> 항차예요.';
      var lines = [];
      if (vw.pilotNext && vw.pilotNext.kind === 'B') lines.push('도선예보 기준 ' + amber(U.fmtKst(vw.pilotNext.ts)) + ' 도선사 승선 예정 ' + tag('real'));
      if (vw.etaCalc && vw.state !== 'stopped') lines.push('지금 속력이면 ' + amber(U.fmtKst(vw.etaCalc) + ' KST') + ' 도착 계산 ' + tag('est'));
      if (vw.etaAis) lines.push('선박이 AIS에 입력한 ETA ' + amber(U.fmtKst(vw.etaAis)) + ' ' + tag('ext'));
      if (lines.length) s4 += '<br>' + lines.join('<br>');
      else s4 += '<br>' + tag('none') + '도착 시각을 계산할 정보가 아직 부족해요.';
      if (vw.remainNm != null) s4 += '<br>남은 거리는 약 ' + cyan(U.num(vw.remainNm, 0) + '해리') + (vw.progress != null ? ' (진행 ' + Math.round(vw.progress * 100) + '%)' : '') + '예요.';
      if (vw.etaCalc && vw.etaAis && Math.abs(vw.etaCalc - vw.etaAis) > 6 * 36e5) {
        s4 += '<div class="note-box note-amber">⚠️ 계산 ETA와 AIS 입력 ETA가 ' + Math.round(Math.abs(vw.etaCalc - vw.etaAis) / 36e5) + '시간 차이 나요. 대리점 통보로 확인이 필요해요.</div>';
      }
      if (vw.laycan) {
        if (vw.laycan.level === 'late') s4 += '<div class="note-box note-red">🚨 레이캔 종료보다 약 <b>' + Math.round(vw.laycan.hours) + '시간 늦게</b> 도착할 전망이에요.</div>';
        else if (vw.laycan.level === 'early') s4 += '<div class="note-box note-cyan">ℹ️ 레이캔 시작보다 약 ' + Math.round(vw.laycan.hours) + '시간 일찍 도착할 전망이에요.</div>';
        else s4 += '<div class="note-box note-cyan">✅ 레이캔 안에 도착할 전망이에요' + (vw.laycan.hours != null ? ' (여유 약 ' + Math.round(vw.laycan.hours) + '시간)' : '') + '.</div>';
      }
      if (oi && oi.kind === 'track') s4 += '<span class="small-note">출항지는 Wingo 항적에서 정박해 있던 자리로 판단했어요.</span>';
      if (vw.originDoubt) s4 += '<div class="note-box note-lilac">VesselFinder 직전 항만 기록(' + U.esc(vo.lastPortText) + ')이 목적지와 같아서 오래된 기록으로 보고 출항지를 비워 뒀어요.</div>';
      var badge4 = vw.eta ? { pilot: '도선예보', calc: '실시간 연산', ais: 'AIS 입력' }[vw.eta.kind] : '확인 중';
      out.push({ tag: '⏱️ 4. ' + destTitle + ' 도착 예정일 (ETA)', time: badge4, text: s4 });
    }

    // 5. 접안·관제
    var port = vw.dest;
    if (port) {
      var s5 = '';
      var rows = vw.pilotRows || [];
      if (port.pilot === 'yspilot') {
        var st = v.src && v.src.yspilot;
        if (rows.length) {
          s5 += tag('real') + '여수항도선사회 도선예보에 <b>' + rows.length + '건</b>이 올라와 있어요.';
          rows.slice(0, 4).forEach(function (r) {
            s5 += '<br>· ' + amber(U.fmtKst(r.ts)) + ' ' + U.esc(r.from) + ' → <b>' + U.esc(r.to) + '</b> (' +
              (r.kind === 'B' ? '접안' : r.kind === 'L' ? '이안' : U.esc(r.kind || '-')) + ', ' + U.esc(r.spec) +
              (r.draft ? ', 흘수 ' + U.esc(r.draft) + 'm' : '') + (r.agent ? ', 대리점 ' + U.esc(r.agent) : '') + ')';
          });
        } else if (st && st.ok) {
          s5 += '여수항도선사회 도선예보(오늘~모레)에 아직 이 배가 없어요. 보통 도착 하루 전쯤부터 올라와요.';
        } else if (st && !st.ok) {
          s5 += tag('none') + '도선예보를 읽지 못했어요: ' + U.esc(B.errorText(st.error));
        } else {
          s5 += '도선예보는 🔄 최신 갱신 때 같이 확인해 드릴게요.';
        }
      } else {
        s5 += '<b>' + U.esc(port.ko) + '</b> 항만은 아직 도선예보 직접 조회를 지원하지 않아요.';
      }
      if (port.rule) s5 += '<br>' + amber('📌 ' + U.esc(port.rule));
      out.push({ tag: '⚠️ 5. ' + port.ko + ' 접안 및 관제 조건', time: '항만 관제', text: s5 });
    }

    // 6. 여수 도착 (목적지가 여수·광양일 때만)
    if (port && port.id === 'yeosu') {
      var s6 = vw.state === 'arrived' ? '<b>[여수 도착]</b> 목적 부두 가까이에 도착해 있어요.'
        : '<b>[여수/광양 입항 예정]</b> ' + (vw.eta ? amber(U.fmtKst(vw.eta.ts)) + ' (' + U.esc(vw.eta.label) + ')' : '도착 시각 확인 중') + ' — 여수공장 원료 투입 스케줄과 맞춰 보시면 돼요.';
      out.push({ tag: '⚓ 6. 여수 도착 여부 및 계획', time: '공장 투입 스케줄', text: s6 });
    }

    // 조회 결과
    var keys = Object.keys(v.src || {});
    if (keys.length) {
      var s7 = keys.map(function (k) {
        var s = v.src[k];
        return (s.ok ? '✅ ' : '⚠️ ') + U.esc(s.label) + ' ' + U.fmtHm(s.at) + (s.ok ? (s.info ? ' · ' + U.esc(s.info) : '') : ' · ' + U.esc(B.errorText(s.error)));
      }).join('<br>');
      out.push({ tag: '🔎 조회 결과', time: v.lastRefresh ? U.fmtHm(v.lastRefresh) + ' 갱신' : '', text: s7 });
    }
    return out;
  }

  function renderBubbles(vw) {
    var box = $('chatBubbleStream');
    if (!vw) {
      box.innerHTML = '<div class="empty-state-box"><div style="font-size:32px;">⚓</div><div><b>관제 중인 선박이 없어요!</b></div>' +
        '<div style="font-size:12.5px;">상단 검색창에서 탱커 이름이나 IMO 번호로 선박을 추가해 주세요.</div>' +
        '<button class="btn-restore-fleet" id="btnRestoreFleet">🔄 기본 선박 목록 복원하기</button></div>';
      return;
    }
    box.innerHTML = bubbles(vw).map(function (b) {
      return '<div class="bubble-item"><div class="bubble-header-row"><div class="bubble-tag">' + U.esc(b.tag) + '</div>' +
        '<div class="bubble-time-badge">' + b.time + '</div></div>' +
        '<div class="bubble-box' + (b.running ? ' running' : '') + '">' + b.text + '</div></div>'; // text 는 위에서 이스케이프해 조립한 HTML
    }).join('');
  }

  /* ================= 전체 그리기 ================= */
  function renderAll(mapOpts) {
    var all = views();
    var sel = S.selected();
    var vw = sel ? all.filter(function (x) { return x.v.id === sel.id; })[0] : null;
    renderChips(all);
    renderBubbles(vw);
    renderStrip(vw);
    if (vw) {
      $('mapTagOverlay').textContent = '📐 ' + vw.v.name + ' 항적도' + (vw.fix ? ' (실측 ' + U.fmtKst(vw.fix.t) + ')' : '');
      if (!busy[vw.v.id]) setStatus(vw.v.name + ' 관제 중' + (vw.v.lastRefresh ? ' (' + U.fmtHm(vw.v.lastRefresh) + ' 갱신)' : '') + ' ✨');
      if (mapOpts !== false) drawMap(vw, mapOpts || {}, all);
    } else {
      layer.clearLayers();
      $('mapTagOverlay').textContent = '관제 대기 중';
      setStatus('관제 중인 선박이 없습니다');
    }
  }

  /* ================= 동작 ================= */
  function selectVessel(id) {
    S.select(id);
    renderAll({ fit: true });
  }

  function refreshOne(id, quiet) {
    var v = S.vessel(id);
    if (!v || busy[id]) return Promise.resolve();
    if (!canFetch()) { toast('직접 조회는 안드로이드 앱에서만 돼요. 저장된 값으로 보여 드릴게요.'); return Promise.resolve(); }
    busy[id] = true;
    runLog[id] = [];
    if (S.get().selectedId === id) setStatus('📡 ' + v.name + ' 직접 조회 중...');
    renderAll(false);
    return E.refreshVessel(v, function (label, state) {
      var s = runLog[id].filter(function (x) { return x.label === label; })[0];
      if (!s) runLog[id].push({ label: label, state: state }); else s.state = state;
      if (S.get().selectedId === id) renderBubbles(curView());
    }).then(function (sum) {
      busy[id] = false;
      var fails = sum.steps.filter(function (s) { return !s.ok; }).length;
      if (S.get().selectedId === id) renderAll({ animate: true, fit: !quiet }); else renderAll(false);
      if (!quiet) toast(fails ? '갱신 완료 · ' + fails + '곳은 읽지 못했어요' : '갱신 완료 ✨');
    }).catch(function () {
      busy[id] = false;
      renderAll(false);
      toast('갱신 중 오류가 났어요. 다시 시도해 주세요.');
    });
  }

  function refreshAll() {
    var btn = $('btnRefreshAll');
    if (btn.disabled) return;
    if (!canFetch()) { toast('직접 조회는 안드로이드 앱에서만 돼요.'); return; }
    btn.disabled = true; $('btnRefresh').disabled = true;
    btn.classList.add('spinning');
    var ids = S.get().vessels.map(function (v) { return v.id; });
    ids.reduce(function (ch, id) { return ch.then(function () { return refreshOne(id, true); }); }, Promise.resolve()).then(function () {
      btn.disabled = false; $('btnRefresh').disabled = false;
      btn.classList.remove('spinning');
      renderAll({ fit: true });
      toast('전체 ' + ids.length + '척 갱신 완료 ✨');
    });
  }

  function deleteVessel(id) {
    var v = S.vessel(id);
    if (!v) return;
    S.removeVessel(id);
    closeInfo();
    renderAll({ fit: true });
    setStatus(v.name + '호 관제가 종료되었습니다 ✅');
  }

  /* ================= 검색 (Wingo 공개 검색, 탱커만) ================= */
  function showResults(html) {
    var el = $('searchResults');
    el.innerHTML = html;
    el.classList.toggle('active', !!html);
  }

  function addAndRefresh(o) {
    var v = S.addVessel(o);
    showResults('');
    $('shipSearchInput').value = '';
    selectVessel(v.id);
    refreshOne(v.id);
  }

  function search() {
    var q = $('shipSearchInput').value.trim();
    if (!q) { showResults(''); return; }
    $('shipSearchInput').blur();
    var nq = U.normName(q);
    var mine = S.get().vessels.filter(function (v) { return U.normName(v.name) === nq || v.imo === q || v.mmsi === q; })[0]; // 선명이 정확히 같을 때만
    if (mine) { showResults(''); $('shipSearchInput').value = ''; selectVessel(mine.id); return; } // 이미 추적 중인 배
    if (/^\d{7}$/.test(q)) { addAndRefresh({ name: 'IMO ' + q, imo: q }); return; }
    if (/^\d{9}$/.test(q)) { addAndRefresh({ name: 'MMSI ' + q, mmsi: q }); return; }
    if (!canFetch()) { showResults('<div class="sr-note">선명 검색은 앱에서만 돼요. IMO(7자리)나 MMSI(9자리)로 넣어 주세요.</div>'); return; }
    showResults('<div class="sr-note">📡 Wingo에서 탱커를 찾는 중...</div>');
    E.searchByName(q).then(function (r) {
      if (!r.ok) { showResults('<div class="sr-note">' + U.esc(B.errorText(r.error)) + '</div>'); return; }
      var tankers = r.list.filter(function (x) { return /tanker/i.test((x.category || '') + ' ' + (x.type || '')); });
      searchList = tankers.length ? tankers : r.list;
      if (!searchList.length) { showResults('<div class="sr-note">일치하는 선박이 없어요. 철자를 확인하거나 IMO 번호로 넣어 주세요.</div>'); return; }
      showResults((tankers.length ? '' : '<div class="sr-note">탱커가 없어 전체 결과를 보여 드려요.</div>') +
        searchList.slice(0, 10).map(function (x, i) {
          var seen = x.lastSeenTs ? '수신 ' + U.ago(x.lastSeenTs, Date.now()) : '';
          return '<button data-i="' + i + '">🚢 ' + U.esc(x.name) + '<small>' +
            U.esc([x.flag, x.imo ? 'IMO ' + x.imo : '', x.mmsi ? 'MMSI ' + x.mmsi : '', seen].filter(Boolean).join(' · ')) + '</small></button>';
        }).join('') + '<div class="sr-note" style="text-align:right"><a href="#" id="srClose" style="color:var(--text-sub)">닫기</a></div>');
    });
  }

  /* ================= 선박 정보 모달 ================= */
  function portOptions(selId, autoLabel) {
    return '<option value="">' + U.esc(autoLabel) + '</option>' + (root.FST_PORTS || []).map(function (p) {
      return '<option value="' + p.id + '"' + (p.id === selId ? ' selected' : '') + '>' + U.esc(p.ko + ' (' + p.en + ')') + '</option>';
    }).join('');
  }

  function openInfo() {
    var v = S.selected();
    if (!v) { toast('먼저 선박을 골라 주세요.'); return; }
    var vw = E.view(v, Date.now());
    var srcRows = Object.keys(v.src || {}).map(function (k) {
      var s = v.src[k];
      return '<div class="row"><div>' + (s.ok ? '✅ ' : '⚠️ ') + U.esc(s.label) + '<small>' + U.fmtKst(s.at) + ' · ' + U.esc(s.ok ? (s.info || '읽기 성공') : B.errorText(s.error)) + '</small></div></div>';
    }).join('') || '<div class="modal-hint">아직 직접 조회한 기록이 없어요.</div>';
    var fixRows = (v.fixes || []).slice(-5).reverse().map(function (f) {
      return '<div class="row"><div>' + U.fmtKst(f.t) + ' · ' + U.fmtPos(f.lat, f.lon) + '<small>' + U.esc(E.srcName(f.src)) +
        (f.sog != null ? ' · ' + U.num(f.sog, 1) + '노트' : '') + (f.timeAssumed ? ' · 시각 추정' : '') + '</small></div>' +
        '<button class="mbtn tiny" data-delfix="' + f.t + '">삭제</button></div>';
    }).join('') || '<div class="modal-hint">기록된 실측 위치가 없어요.</div>';
    var originAuto = '자동 (' + (vw.originText || '미확인') + ({ track: ', 항적 기준', vf: ', VesselFinder 기록' }[vw.originInfo && vw.originInfo.kind] || '') + ')';
    var destAuto = '자동 (AIS 목적지: ' + ((v.voyage && v.voyage.destText) || '미확인') + ')';

    $('infoCard').innerHTML =
      '<div class="modal-header"><div><div style="font-size:16px;font-weight:800;">🚢 ' + U.esc(v.name) + '</div>' +
      '<div class="modal-hint">' + U.esc([v.imo ? 'IMO ' + v.imo : '', v.mmsi ? 'MMSI ' + v.mmsi : '', v.callsign, v.flag].filter(Boolean).join(' · ') || '제원은 갱신하면 채워져요') + '</div></div>' +
      '<button class="modal-close-btn" data-act="close">×</button></div>' +
      '<div class="modal-body">' +
      '<div class="modal-field"><span class="modal-label">화물</span><div class="cargo-grid" id="cargoGrid">' +
      CARGOS.map(function (c) { return '<button class="cargo-btn' + (v.cargo === c ? ' active' : '') + '" data-cargo="' + c + '">' + c + '</button>'; }).join('') +
      '<input class="modal-input" id="cargoFree" placeholder="기타" style="width:90px;flex:none" value="' + U.esc(CARGOS.indexOf(v.cargo) < 0 ? v.cargo : '') + '"></div></div>' +
      '<div class="modal-field"><span class="modal-label">레이캔 (도착 허용 기간)</span><div class="modal-row">' +
      '<input class="modal-input" type="date" id="lcStart" value="' + U.esc(v.laycanStart) + '"><input class="modal-input" type="date" id="lcEnd" value="' + U.esc(v.laycanEnd) + '"></div></div>' +
      '<div class="modal-field"><span class="modal-label">출항지</span><select class="modal-select" id="selOrigin">' + portOptions(v.originUser ? v.originPortId : '', originAuto) + '</select></div>' +
      '<div class="modal-field"><span class="modal-label">목적지</span><select class="modal-select" id="selDest">' + portOptions(v.destPortId, destAuto) + '</select></div>' +
      '<div class="modal-field"><span class="modal-label">위치 직접 입력</span>' +
      '<div class="modal-hint">대리점 통보 좌표를 옮겨 적으면 실측으로 기록돼요. 예: 33.0287 / 126.6602</div>' +
      '<div class="modal-row"><input class="modal-input" id="mLat" inputmode="decimal" placeholder="위도"><input class="modal-input" id="mLon" inputmode="decimal" placeholder="경도"></div>' +
      '<div class="modal-row"><input class="modal-input" id="mSog" inputmode="decimal" placeholder="속력(노트)"><input class="modal-input" id="mCog" inputmode="decimal" placeholder="침로(도)"><input class="modal-input" type="datetime-local" id="mTime"></div>' +
      '<div class="modal-btns"><button class="mbtn" data-act="manual">📍 위치 기록</button></div></div>' +
      '<div class="modal-field"><span class="modal-label">최근 실측 기록</span><div class="modal-list">' + fixRows + '</div></div>' +
      '<div class="modal-field"><span class="modal-label">소스별 조회 결과</span><div class="modal-list">' + srcRows + '</div></div>' +
      '<div class="modal-btns">' +
      (v.imo || v.mmsi ? '<button class="mbtn" data-act="vf">VesselFinder 원문</button>' : '') +
      (vw.dest && vw.dest.pilot === 'yspilot' ? '<button class="mbtn" data-act="pilot">도선예보 원문</button>' : '') + '</div>' +
      '<div class="modal-btns"><button class="mbtn danger" data-act="end">🗑️ 관제 종료</button><button class="mbtn primary" data-act="save">저장</button></div>' +
      '</div>';
    $('infoModal').classList.add('active');
  }

  function closeInfo() { $('infoModal').classList.remove('active'); }

  function infoClick(ev) {
    var v = S.selected();
    if (!v) return;
    if (ev.target === $('infoModal')) { closeInfo(); return; }
    var t = ev.target.closest('button');
    if (!t) return;
    if (t.dataset.cargo) {
      var on = t.classList.contains('active');
      [].forEach.call($('cargoGrid').querySelectorAll('.cargo-btn'), function (b) { b.classList.remove('active'); });
      if (!on) { t.classList.add('active'); $('cargoFree').value = ''; }
      return;
    }
    if (t.dataset.delfix) {
      v.fixes = v.fixes.filter(function (f) { return String(f.t) !== t.dataset.delfix; });
      E.clearCache(); S.save(); openInfo(); renderAll({ fit: true });
      return;
    }
    var act = t.dataset.act;
    if (act === 'close') { closeInfo(); return; }
    if (act === 'vf') { B.openBrowser(P.vfDetailUrl(v), v.name + ' · VesselFinder'); return; }
    if (act === 'pilot') { B.openBrowser(P.YSPILOT_URL, '여수항도선사회 도선예보'); return; }
    if (act === 'manual') {
      var lat = parseFloat($('mLat').value), lon = parseFloat($('mLon').value);
      if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) { toast('위도·경도를 숫자로 넣어 주세요. 예: 33.0287 / 126.6602'); return; }
      var ts = $('mTime').value ? new Date($('mTime').value).getTime() : Date.now();
      if (!isFinite(ts) || ts > Date.now() + 6e5) { toast('수신 시각이 올바르지 않아요.'); return; }
      E.addManualFix(v, { lat: lat, lon: lon, sog: $('mSog').value, cog: $('mCog').value, t: ts });
      closeInfo();
      renderAll({ fit: true, animate: true });
      toast('수동 입력 위치를 실측으로 기록했어요.');
      return;
    }
    if (act === 'end') {
      if (t.dataset.sure !== '1') { t.dataset.sure = '1'; t.textContent = '한 번 더 누르면 종료'; return; } // 실수 방지
      deleteVessel(v.id);
      return;
    }
    if (act === 'save') {
      var picked = $('cargoGrid').querySelector('.cargo-btn.active');
      v.cargo = picked ? picked.dataset.cargo : $('cargoFree').value.trim().toUpperCase().slice(0, 12);
      v.laycanStart = $('lcStart').value; v.laycanEnd = $('lcEnd').value;
      v.originPortId = $('selOrigin').value; v.originUser = !!v.originPortId; // 직접 고른 출항지만 고정
      v.destPortId = $('selDest').value;
      E.clearCache(); S.save();
      closeInfo();
      renderAll({ fit: true });
      toast('저장했어요 ✨');
    }
  }

  /* ================= 커버 화면 탭 (피클 원본 동작) ================= */
  function switchCoverTab(tab) {
    try { root.localStorage.setItem('pickle_cover_tab', tab); } catch (e) { /* 저장 실패는 무시 */ }
    doc.body.classList.toggle('cover-view-briefing', tab === 'briefing');
    doc.body.classList.toggle('cover-view-map', tab !== 'briefing');
    $('tabBtnMap').classList.toggle('active', tab !== 'briefing');
    $('tabBtnBriefing').classList.toggle('active', tab === 'briefing');
    if (tab !== 'briefing') setTimeout(function () { if (map) map.invalidateSize(); }, 150);
  }

  // 안드로이드 뒤로 가기: 모달·검색 결과 닫기 → 지도 탭으로 → (false 면 앱이 뒤로 물러남)
  root.FST_BACK = function () {
    if ($('infoModal').classList.contains('active')) { closeInfo(); return true; }
    if ($('searchResults').classList.contains('active')) { showResults(''); return true; }
    if (doc.body.classList.contains('cover-view-briefing') && root.innerWidth < 680) { switchCoverTab('map'); return true; }
    return false;
  };

  /* ================= 시작 ================= */
  function boot() {
    S.load();
    applyProfile();
    var chip = $('modeChip');
    if (!B.available) {
      chip.className = 'live-chip preview';
      chip.innerHTML = '<span class="live-dot"></span>' + (B.demo ? '예시 데이터' : '미리보기');
    }
    initMap();

    $('fleetChipsContainer').addEventListener('click', function (ev) {
      var del = ev.target.closest('[data-del]');
      if (del) { ev.stopPropagation(); deleteVessel(del.dataset.del); return; }
      var c = ev.target.closest('.chip');
      if (c) selectVessel(c.dataset.id);
    });
    $('btnRefresh').addEventListener('click', function () { var v = S.selected(); if (v) refreshOne(v.id); });
    $('btnRefreshAll').addEventListener('click', refreshAll);
    $('btnSearchGo').addEventListener('click', search);
    $('shipSearchInput').addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); search(); } });
    $('searchResults').addEventListener('click', function (ev) {
      if (ev.target.id === 'srClose') { ev.preventDefault(); showResults(''); return; }
      var b = ev.target.closest('button[data-i]');
      if (b) addAndRefresh(searchList[+b.dataset.i]);
    });
    $('btnCloseVessel').addEventListener('click', function () {
      var v = S.selected();
      if (!v) return;
      var btn = $('btnCloseVessel');
      if (btn.dataset.sure !== '1') {                  // 실수 방지: 한 번 더 눌러야 종료
        btn.dataset.sure = '1'; btn.textContent = '한 번 더 누르면 종료';
        setTimeout(function () { btn.dataset.sure = ''; btn.textContent = '🗑️ 관제 종료'; }, 3000);
        return;
      }
      btn.dataset.sure = ''; btn.textContent = '🗑️ 관제 종료';
      deleteVessel(v.id);
    });
    $('chatBubbleStream').addEventListener('click', function (ev) {
      if (ev.target.id === 'btnRestoreFleet') { S.reset(); renderAll({ fit: true }); }
    });
    $('btnStyle').addEventListener('click', function () {
      var next = styleNow === 'sat' ? 'chart' : 'sat';
      setStyle(next); S.get().settings.mapStyle = next; S.save();
    });
    $('btnReplay').addEventListener('click', function () { replay(curView()); });
    $('btnWingo').addEventListener('click', function () {
      var v = S.selected();
      if (!v) return;
      B.openBrowser(v.mmsi ? P.wingoShipUrl(v.mmsi) : P.WINGO + '/ships', v.name + ' · Wingo Marine'); // MMSI 를 모르면 Wingo 선박 목록
    });
    $('btnInfo').addEventListener('click', openInfo);
    $('infoModal').addEventListener('click', infoClick);
    $('tabBtnMap').addEventListener('click', function () { switchCoverTab('map'); });
    $('tabBtnBriefing').addEventListener('click', function () { switchCoverTab('briefing'); });
    root.addEventListener('resize', function () { setTimeout(function () { if (map) map.invalidateSize(); }, 80); });
    // 1분마다 화면만 다시 계산 (통신 없음): 경과 시간·추정 위치 갱신
    root.setInterval(function () { if (!doc.hidden && !$('infoModal').classList.contains('active')) renderAll({}); }, 60000);

    var tab = 'map';
    try { tab = root.localStorage.getItem('pickle_cover_tab') || 'map'; } catch (e) { /* 기본 지도 탭 */ }
    switchCoverTab(tab);
    renderAll({ fit: true });
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot); else boot();
})(window);
