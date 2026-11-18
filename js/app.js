(function () {
  'use strict';
  var VERSION = '1.1.4';

  // ---------- util ----------
  var $ = function (s) { return document.querySelector(s); };
  var KEY = { LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13, BACK: 10009, BACKSPACE: 8, ESC: 27,
    PLAY: 415, PAUSE: 19, PLAYPAUSE: 10252, STOP: 413, FF: 417, RW: 412, CH_UP: 427, CH_DOWN: 428 };
  var PAGE = 100;

  function show(el, v) { el.classList.toggle('hidden', !v); }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function store(k, v) { try { if (v === undefined) return JSON.parse(localStorage.getItem(k)); localStorage.setItem(k, JSON.stringify(v)); } catch (e) { return null; } }

  function http(url, asText) {
    return new Promise(function (res, rej) {
      var x = new XMLHttpRequest();
      x.open('GET', url, true);
      x.timeout = 60000;
      x.onload = function () {
        if (x.status < 200 || x.status >= 300) return rej(new Error('HTTP ' + x.status));
        if (asText) return res(x.responseText);
        try { res(JSON.parse(x.responseText)); } catch (e) { rej(new Error('Resposta inválida do servidor')); }
      };
      x.onerror = function () { rej(new Error('Falha de rede / servidor inacessível')); };
      x.ontimeout = function () { rej(new Error('Tempo esgotado')); };
      x.send();
    });
  }


  // ---------- cache de listas (IndexedDB) e pré-carga de logos ----------
  var TTL = 6 * 3600 * 1000;
  function idb() {
    return new Promise(function (res, rej) {
      try {
        var r = indexedDB.open('iptv', 1);
        r.onupgradeneeded = function () { r.result.createObjectStore('kv'); };
        r.onsuccess = function () { res(r.result); };
        r.onerror = function () { rej(r.error); };
      } catch (e) { rej(e); }
    });
  }
  function idbGet(k) {
    return idb().then(function (db) {
      return new Promise(function (res) {
        var q = db.transaction('kv').objectStore('kv').get(k);
        q.onsuccess = function () { res(q.result || null); };
        q.onerror = function () { res(null); };
      });
    }).catch(function () { return null; });
  }
  function idbSet(k, v) {
    return idb().then(function (db) { db.transaction('kv', 'readwrite').objectStore('kv').put(v, k); }).catch(function () {});
  }

  var preloaded = {}, pq = [], active = 0, MAXC = 6;
  function preload(items) {
    items.forEach(function (i) {
      var u = i.stream_icon || i.cover;
      if (u && !preloaded[u]) { preloaded[u] = 1; pq.push(u); }
    });
    pump();
  }
  function pump() {
    while (active < MAXC && pq.length) {
      (function (u) {
        active++;
        var im = new Image();
        var done = function () { active--; pump(); };
        im.onload = done; im.onerror = done;
        im.src = u;
      })(pq.shift());
    }
  }

  // ---------- estado ----------
  var cfg = null;          // {base, user, pass, m3u}
  var tab = 'live';
  var data = { live: null, vod: null, series: null };   // {cats:[], items:[]}
  var curCat = '*';
  var curList = [];        // lista filtrada atual
  var shown = 0;
  var playCtx = { list: [], idx: 0, live: false };
  var view = 'login';      // login | main | detail | player

  // ---------- Xtream API ----------
  function api(action, extra) {
    var u = cfg.base + '/player_api.php?username=' + encodeURIComponent(cfg.user) + '&password=' + encodeURIComponent(cfg.pass);
    if (action) u += '&action=' + action;
    return http(u + (extra || ''));
  }

  function parseInput() {
    var s = $('#in-server').value.trim(), u = $('#in-user').value.trim(), p = $('#in-pass').value.trim();
    var m = s.match(/^(https?:\/\/[^\/?#]+)(?:.*?[?&]username=([^&]+))?(?:.*?[?&]password=([^&]+))?/i);
    if (!m) throw new Error('Informe a URL do servidor (começando com http://)');
    return { base: m[1], user: decodeURIComponent(m[2] || u), pass: decodeURIComponent(m[3] || p) };
  }

  function login() {
    var msg = $('#login-msg');
    msg.textContent = '';
    try { cfg = parseInput(); } catch (e) { msg.textContent = e.message; return; }
    if (!cfg.user || !cfg.pass) { msg.textContent = 'Informe usuário e senha'; return; }
    msg.style.color = '#9aa3c0'; msg.textContent = 'Autenticando...';
    api().then(function (r) {
      if (!r || !r.user_info || r.user_info.auth === 0) throw new Error('Usuário/senha inválidos');
      if (r.user_info.status && r.user_info.status !== 'Active') throw new Error('Conta: ' + r.user_info.status);
      store('cfg', cfg);
      data = { live: null, vod: null, series: null };
      enterMain();
    }).catch(function (e) {
      msg.style.color = '#ffb4b4';
      msg.textContent = 'Erro: ' + e.message + ' (se for teste, aguarde 1 min / verifique validade)';
    });
  }

  function loadTab(t) {
    tab = t; curCat = '*';
    document.querySelectorAll('.tab').forEach(function (b) { b.classList.toggle('active', b.dataset.tab === t); });
    $('#in-search').value = '';
    if (data[t]) return renderTab();
    $('#status').textContent = 'Carregando ' + t + '...';
    $('#grid').innerHTML = ''; $('#cats').innerHTML = '';
    var a = { live: ['get_live_categories', 'get_live_streams'], vod: ['get_vod_categories', 'get_vod_streams'], series: ['get_series_categories', 'get_series'] }[t];
    var key = 'list:' + cfg.user + ':' + t;
    function fetchFresh() {
      return Promise.all([api(a[0]), api(a[1])]).then(function (r) {
        var d = { cats: r[0] || [], items: r[1] || [] };
        idbSet(key, { ts: Date.now(), d: d });
        return d;
      });
    }
    idbGet(key).then(function (c) {
      if (c && c.d && Date.now() - c.ts < TTL) {
        data[t] = c.d;
        if (tab === t) renderTab();
        return;
      }
      return fetchFresh().then(function (d) { data[t] = d; if (tab === t) renderTab(); });
    }).catch(function (e) { $('#status').textContent = 'Erro: ' + e.message; });
  }

  function renderTab() {
    var d = data[tab];
    var box = $('#cats'); box.innerHTML = '';
    function addCat(id, name) {
      var b = el('button', 'f cat', name); b.dataset.id = id;
      if (id === curCat) b.classList.add('active');
      b.onclick = function () { curCat = id; markCats(); applyFilter(); };
      box.appendChild(b);
    }
    addCat('*', 'Todos (' + d.items.length + ')');
    d.cats.forEach(function (c) { addCat(String(c.category_id), c.category_name); });
    applyFilter();
    preload(d.items);
  }
  function markCats() {
    document.querySelectorAll('.cat').forEach(function (b) { b.classList.toggle('active', b.dataset.id === curCat); });
  }

  function applyFilter() {
    var q = $('#in-search').value.trim().toLowerCase();
    curList = data[tab].items.filter(function (i) {
      if (curCat !== '*' && String(i.category_id) !== curCat) return false;
      return !q || String(i.name || '').toLowerCase().indexOf(q) >= 0;
    });
    shown = 0;
    $('#grid').innerHTML = '';
    renderMore();
    $('#status').textContent = curList.length + ' itens';
  }

  function renderMore() {
    var g = $('#grid');
    var old = g.querySelector('.more'); if (old) old.remove();
    var end = Math.min(shown + PAGE, curList.length);
    for (var i = shown; i < end; i++) g.appendChild(card(curList[i], i));
    shown = end;
    if (shown < curList.length) {
      var m = el('button', 'f more', 'Carregar mais (' + (curList.length - shown) + ')');
      m.onclick = function () { renderMore(); var c = g.children[shown - PAGE]; if (c) c.focus(); };
      g.appendChild(m);
    }
  }

  function card(item, idx) {
    var live = tab === 'live';
    var c = el('button', 'f card' + (live ? ' live' : ''));
    var img = el('img');
    img.src = item.stream_icon || item.cover || '';
    img.onerror = function () { img.style.visibility = 'hidden'; };
    c.appendChild(img);
    c.appendChild(el('div', 't', item.name));
    c.onclick = function () { openItem(item, idx); };
    return c;
  }

  function openItem(item, idx) {
    if (tab === 'live') {
      playCtx = { list: curList, idx: idx, live: true };
      return playCurrent();
    }
    if (tab === 'vod') {
      playCtx = { list: [item], idx: 0, live: false };
      return playCurrent();
    }
    openSeries(item);
  }

  // ---------- séries ----------
  var epList = [];
  function openSeries(s) {
    $('#status').textContent = 'Carregando série...';
    api('get_series_info', '&series_id=' + s.series_id).then(function (r) {
      $('#status').textContent = '';
      var eps = r.episodes || {};
      if (Array.isArray(eps)) eps = { '1': eps };
      view = 'detail'; show($('#main'), false); show($('#detail'), true);
      $('#detail-head').textContent = s.name;
      var sb = $('#seasons'); sb.innerHTML = '';
      var keys = Object.keys(eps).sort(function (a, b) { return a - b; });
      keys.forEach(function (k, i) {
        var b = el('button', 'f btn small', 'Temporada ' + k);
        b.onclick = function () { showEpisodes(s, eps[k]); };
        sb.appendChild(b);
        if (i === 0) showEpisodes(s, eps[k]);
      });
      var first = sb.firstChild; if (first) first.focus();
    }).catch(function (e) { $('#status').textContent = 'Erro: ' + e.message; });
  }
  function showEpisodes(s, list) {
    epList = list.map(function (e) {
      return { name: 'E' + e.episode_num + ' - ' + (e.title || ''), id: e.id, ext: e.container_extension || 'mp4' };
    });
    var box = $('#episodes'); box.innerHTML = '';
    epList.forEach(function (e, i) {
      var b = el('button', 'f ep', e.name);
      b.onclick = function () {
        playCtx = { list: epList.map(function (x) { return { name: s.name + ' ' + x.name, url: cfg.base + '/series/' + cfg.user + '/' + cfg.pass + '/' + x.id + '.' + x.ext }; }), idx: i, live: false };
        playCurrent();
      };
      box.appendChild(b);
    });
  }

  // ---------- player ----------
  var avp = (window.webapis && window.webapis.avplay) || null;
  var timer, infoTimer, playing = false, duration = 0, curTime = 0, retried = false;

  function itemUrl(it) {
    if (it.url) return it.url;
    if (tab === 'live') return cfg.base + '/live/' + cfg.user + '/' + cfg.pass + '/' + it.stream_id + '.m3u8';
    return cfg.base + '/movie/' + cfg.user + '/' + cfg.pass + '/' + it.stream_id + '.' + (it.container_extension || 'mp4');
  }

  function playCurrent() {
    var it = playCtx.list[playCtx.idx];
    retried = false;
    startPlayback(itemUrl(it), it.name);
  }

  var stallTimer;
  function startPlayback(url, name) {
    stopPlayback(true);
    clearTimeout(stallTimer);
    stallTimer = setTimeout(function () {
      if (!$('#p-spinner').classList.contains('hidden')) fail('O stream não respondeu em 20s. Pode ser o limite de conexões da conta (3 simultâneas) ou canal fora do ar');
    }, 20000);
    view = 'player';
    document.body.classList.add('playing');
    show($('#player'), true); show($('#p-error'), false); show($('#p-spinner'), true);
    showInfo(name);
    duration = 0; curTime = 0;
    if (avp) {
      try {
        avp.open(url);
        avp.setDisplayRect(0, 0, 1920, 1080);
        avp.setListener({
          onbufferingstart: function () { show($('#p-spinner'), true); },
          onbufferingcomplete: function () { show($('#p-spinner'), false); },
          oncurrentplaytime: function (t) { curTime = t; updateBar(); },
          onstreamcompleted: function () { if (!playCtx.live && playCtx.idx < playCtx.list.length - 1) { playCtx.idx++; playCurrent(); } else closePlayer(); },
          onerror: function (e) { fail('Erro de reprodução: ' + e); }
        });
        avp.prepareAsync(function () {
          try { duration = avp.getDuration(); avp.play(); playing = true; clearTimeout(stallTimer); show($('#p-spinner'), false); } catch (e) { fail(e.message || e); }
        }, function (e) { fail('Não foi possível abrir o stream (' + e + ')'); });
      } catch (e) { fail(e.message || String(e)); }
    } else {
      var v = $('#html5'); show(v, true);
      v.src = url; v.onerror = function () { var c = v.error ? v.error.code : '?'; fail('Erro ao reproduzir (código ' + c + ', player: HTML5, URL: ' + url.replace(/\/(live|movie|series)\/[^\/]+\/[^\/]+\//, '/$1/***/***/') + ')'); };
      v.onplaying = function () { clearTimeout(stallTimer); show($('#p-spinner'), false); };
      v.ontimeupdate = function () { curTime = v.currentTime * 1000; duration = (v.duration || 0) * 1000; updateBar(); };
      v.play(); playing = true;
    }
  }

  function fail(msg) {
    show($('#p-spinner'), false);
    // Live: tenta .ts se .m3u8 falhou
    var it = playCtx.list[playCtx.idx];
    if (playCtx.live && !retried && !it.url) {
      retried = true;
      var alt = cfg.base + '/live/' + cfg.user + '/' + cfg.pass + '/' + it.stream_id + '.ts';
      return startPlayback(alt, it.name);
    }
    var e = $('#p-error'); e.textContent = msg + ' — pressione VOLTAR'; show(e, true);
  }

  function stopPlayback(keepUi) {
    playing = false;
    if (!keepUi) clearTimeout(stallTimer);
    if (avp) { try { avp.stop(); } catch (e) {} try { avp.close(); } catch (e) {} }
    var v = $('#html5'); try { v.pause(); v.removeAttribute('src'); v.load(); } catch (e) {}
    if (!keepUi) { show(v, false); }
  }

  function closePlayer() {
    stopPlayback();
    show($('#player'), false);
    document.body.classList.remove('playing');
    view = $('#detail').classList.contains('hidden') ? 'main' : 'detail';
    var f = document.querySelector('.f:focus'); if (!f) focusFirst();
  }

  function fmt(ms) {
    var s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60); s = s % 60;
    return (h ? h + ':' : '') + (m < 10 && h ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }
  function showInfo(name) {
    var box = $('#p-info');
    box.innerHTML = '';
    box.appendChild(document.createTextNode(name || ''));
    if (!playCtx.live) {
      box.appendChild(el('div', 'bar')).appendChild(el('i'));
      box.appendChild(el('small', '', ''));
    } else {
      box.appendChild(el('div')).appendChild(el('small', '', '▲▼ ou CH± trocam de canal'));
    }
    show(box, true);
    clearTimeout(infoTimer);
    infoTimer = setTimeout(function () { show(box, false); }, 4000);
  }
  function updateBar() {
    var i = $('#p-info .bar i'); if (!i || !duration) return;
    i.style.width = (curTime / duration * 100) + '%';
    var s = $('#p-info small'); if (s) s.textContent = fmt(curTime) + ' / ' + fmt(duration) + '   ◄ ► ±10s  OK pausa';
  }
  function seek(ms) {
    if (playCtx.live) return;
    if (avp) { try { ms > 0 ? avp.jumpForward(ms) : avp.jumpBackward(-ms); } catch (e) {} }
    else { var v = $('#html5'); v.currentTime = Math.max(0, v.currentTime + ms / 1000); }
    showInfo(playCtx.list[playCtx.idx].name);
  }
  function togglePause() {
    if (playCtx.live) return;
    try {
      if (avp) { playing ? avp.pause() : avp.play(); } else { var v = $('#html5'); playing ? v.pause() : v.play(); }
      playing = !playing;
    } catch (e) {}
    showInfo(playCtx.list[playCtx.idx].name);
  }
  function zap(d) {
    if (!playCtx.live) return;
    var n = playCtx.idx + d;
    if (n < 0 || n >= playCtx.list.length) return;
    playCtx.idx = n; playCurrent();
  }

  // ---------- navegação espacial ----------
  function focusables() {
    var root = view === 'main' ? $('#main') : view === 'detail' ? $('#detail') : $('#login');
    return Array.prototype.filter.call(root.querySelectorAll('.f'), function (e) { return e.offsetParent !== null; });
  }
  function focusFirst() {
    var l = focusables(); if (!l.length) return;
    var pref = view === 'main' ? (document.querySelector('.card') || l[0]) : l[0];
    pref.focus();
  }
  function move(dir) {
    var cur = document.activeElement, list = focusables();
    if (!cur || list.indexOf(cur) < 0) return focusFirst();
    var r = cur.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    var best = null, bs = Infinity;
    list.forEach(function (e) {
      if (e === cur) return;
      var b = e.getBoundingClientRect(), x = b.left + b.width / 2, y = b.top + b.height / 2;
      var dx = x - cx, dy = y - cy, main, cross;
      if (dir === 'left') { if (dx >= -2) return; main = -dx; cross = Math.abs(dy); }
      else if (dir === 'right') { if (dx <= 2) return; main = dx; cross = Math.abs(dy); }
      else if (dir === 'up') { if (dy >= -2) return; main = -dy; cross = Math.abs(dx); }
      else { if (dy <= 2) return; main = dy; cross = Math.abs(dx); }
      var score = main + cross * 3;
      if (score < bs) { bs = score; best = e; }
    });
    if (best) { best.focus(); best.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
  }

  // ---------- teclas ----------
  document.addEventListener('keydown', function (ev) {
    var k = ev.keyCode;
    var inInput = document.activeElement && document.activeElement.tagName === 'INPUT';

    if (view === 'player') {
      ev.preventDefault();
      if (k === KEY.BACK || k === KEY.ESC || k === KEY.STOP || k === KEY.BACKSPACE) return closePlayer();
      if (k === KEY.UP || k === KEY.CH_UP) return zap(-1);
      if (k === KEY.DOWN || k === KEY.CH_DOWN) return zap(1);
      if (k === KEY.RIGHT || k === KEY.FF) return seek(10000);
      if (k === KEY.LEFT || k === KEY.RW) return seek(-10000);
      if (k === KEY.ENTER || k === KEY.PLAY || k === KEY.PAUSE || k === KEY.PLAYPAUSE) return togglePause();
      return;
    }
    if (k === KEY.BACK || k === KEY.ESC) {
      if (view === 'detail') { view = 'main'; show($('#detail'), false); show($('#main'), true); focusFirst(); }
      else if (view === 'main') { var c = document.querySelector('.cat.active'); if (c && document.activeElement !== c) c.focus(); else if (window.tizen) tizen.application.getCurrentApplication().exit(); }
      else if (window.tizen) tizen.application.getCurrentApplication().exit();
      return;
    }
    if (inInput && (k === KEY.LEFT || k === KEY.RIGHT || k === KEY.BACKSPACE)) {
      // deixa editar o texto; sai do campo com UP/DOWN
      return;
    }
    var dir = { 37: 'left', 38: 'up', 39: 'right', 40: 'down' }[k];
    if (dir) { ev.preventDefault(); move(dir); }
  });

  // ---------- inicialização ----------
  function enterMain() {
    view = 'main';
    show($('#login'), false); show($('#main'), true);
    loadTab('live');
    setTimeout(function () { var t = document.querySelector('.tab.active'); if (t) t.focus(); }, 50);
  }

  document.querySelectorAll('.tab').forEach(function (b) { b.onclick = function () { loadTab(b.dataset.tab); }; });
  $('#btn-login').onclick = login;
  $('#in-search').addEventListener('input', function () { if (data[tab]) applyFilter(); });
  $('#btn-logout').onclick = function () {
    store('cfg', null); cfg = null; data = { live: null, vod: null, series: null };
    view = 'login'; show($('#main'), false); show($('#login'), true); $('#in-pass').value = ''; focusFirst();
  };

  try {
    if (window.tizen && tizen.tvinputdevice) {
      ['MediaPlay', 'MediaPause', 'MediaPlayPause', 'MediaStop', 'MediaFastForward', 'MediaRewind', 'ChannelUp', 'ChannelDown']
        .forEach(function (n) { try { tizen.tvinputdevice.registerKey(n); } catch (e) {} });
    }
  } catch (e) {}

  function fit() {
    var de = document.documentElement;
    var w = de.clientWidth || window.innerWidth, h = de.clientHeight || window.innerHeight;
    var k = Math.min(w / 1920, h / 1080) || 1;
    document.body.style.transformOrigin = '0 0';
    document.body.style.transform = Math.abs(k - 1) < 0.01 ? '' : 'scale(' + k + ')';
    var v = $('#ver');
    if (v) v.textContent = 'v' + VERSION;
  }
  window.addEventListener('resize', fit); fit();
  var saved = store('cfg');
  if (saved && saved.base) {
    cfg = saved;
    $('#in-server').value = saved.base; $('#in-user').value = saved.user; $('#in-pass').value = saved.pass;
    // revalida e entra direto
    api().then(function (r) {
      if (r && r.user_info && r.user_info.auth !== 0) enterMain(); else { show($('#login'), true); focusFirst(); }
    }).catch(function () { $('#login-msg').textContent = 'Não foi possível entrar automaticamente. Tente novamente.'; focusFirst(); });
  }
  focusFirst();
  if (!saved && $('#in-server').value && $('#in-user').value) $('#in-pass').focus();
})();
