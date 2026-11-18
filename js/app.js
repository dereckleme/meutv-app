(function () {
  'use strict';
  // ES5 apenas: a TV (Tizen 5.0) usa um Chromium antigo.
  var VERSION = '1.2.0';

  // ---------- util ----------
  var $ = function (s) { return document.querySelector(s); };
  var KEY = { LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13, BACK: 10009, BACKSPACE: 8, ESC: 27,
    PLAY: 415, PAUSE: 19, PLAYPAUSE: 10252, STOP: 413, FF: 417, RW: 412, CH_UP: 427, CH_DOWN: 428 };
  var PAGE = 100;
  var TAB_LABEL = { live: 'Todos os canais', vod: 'Todos os filmes', series: 'Todas as séries' };

  function show(e, v) { e.classList.toggle('hidden', !v); }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function store(k, v) { try { if (v === undefined) return JSON.parse(localStorage.getItem(k)); localStorage.setItem(k, JSON.stringify(v)); } catch (e) { return null; } }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function hhmm() { var d = new Date(); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function clean(name) { return String(name || '').replace(/^[\s+•*\-]+/, ''); }
  function initials(name) {
    var w = String(name || '').replace(/[^A-Za-zÀ-ÿ0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
    return ((w[0] || '?').charAt(0) + (w[1] ? w[1].charAt(0) : '')).toUpperCase();
  }

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

  // ---------- cache de listas (IndexedDB) ----------
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

  // ---------- logos: fila curta + cache em memória/IndexedDB + retentativa ----------
  // Os hosts de imagem (imgur, ibb...) limitam requisições; poucas conexões por vez.
  var memLogo = {}, lq = [], lactive = 0, LMAX = 3;
  function setLogo(img, url) {
    if (!url) return;
    if (memLogo[url]) { img.src = memLogo[url]; return; }
    lq.push({ img: img, url: url, tries: 0 });
    lpump();
  }
  function resetLogos() { lq = []; }
  function lpump() { while (lactive < LMAX && lq.length) loadLogo(lq.shift()); }
  function loadLogo(j) {
    if (memLogo[j.url]) { j.img.src = memLogo[j.url]; return; }
    lactive++;
    var done = function () { lactive--; lpump(); };
    idbGet('logo:' + j.url).then(function (blob) {
      if (blob) { memLogo[j.url] = URL.createObjectURL(blob); j.img.src = memLogo[j.url]; return done(); }
      var x = new XMLHttpRequest();
      x.open('GET', j.url, true); x.responseType = 'blob'; x.timeout = 15000;
      x.onload = function () {
        if (x.status === 200 && x.response && x.response.size) {
          idbSet('logo:' + j.url, x.response);
          memLogo[j.url] = URL.createObjectURL(x.response); j.img.src = memLogo[j.url];
          return done();
        }
        retry();
      };
      x.onerror = x.ontimeout = function () { retry(); };
      x.send();
      function retry() {
        if (j.tries++ < 2) { setTimeout(function () { lq.push(j); lpump(); }, 1500 * j.tries); }
        else { j.img.src = j.url; }   // última tentativa: o navegador carrega direto (sem CORS)
        done();
      }
    });
  }

  // ---------- estado ----------
  var cfg = null;
  var tab = 'live';
  var data = { live: null, vod: null, series: null };   // {cats:[], items:[], names:{}}
  var curCat = '*';
  var curList = [];
  var shown = 0;
  var playCtx = { list: [], idx: 0, live: false };
  var view = 'login';      // login | main | detail | player
  var mainFocus = null, detailFocus = null;

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

  function loginMsg(text, err) { var m = $('#login-msg'); m.textContent = text; m.classList.toggle('err', !!err); }

  function login() {
    loginMsg('');
    try { cfg = parseInput(); } catch (e) { loginMsg(e.message, true); return; }
    if (!cfg.user || !cfg.pass) { loginMsg('Informe usuário e senha', true); return; }
    loginMsg('Autenticando...');
    api().then(function (r) {
      if (!r || !r.user_info || r.user_info.auth === 0) throw new Error('Usuário ou senha inválidos');
      if (r.user_info.status && r.user_info.status !== 'Active') throw new Error('Conta: ' + r.user_info.status);
      store('cfg', cfg);
      data = { live: null, vod: null, series: null };
      enterMain();
    }).catch(function (e) { loginMsg(e.message, true); });
  }

  // ---------- listas ----------
  function gridState(text, spinning) {
    var g = $('#grid'); g.innerHTML = '';
    var s = el('div', 'state');
    if (spinning) s.appendChild(el('div', 'spin'));
    s.appendChild(el('div', '', text));
    g.appendChild(s);
  }

  function loadTab(t) {
    tab = t; curCat = '*';
    document.querySelectorAll('.tab').forEach(function (b) { b.classList.toggle('active', b.dataset.tab === t); });
    $('#in-search').value = '';
    if (data[t]) return renderTab();
    $('#cats').innerHTML = '';
    $('#crumb-title').textContent = TAB_LABEL[t];
    $('#status').textContent = '';
    gridState('Carregando...', true);
    var a = { live: ['get_live_categories', 'get_live_streams'], vod: ['get_vod_categories', 'get_vod_streams'], series: ['get_series_categories', 'get_series'] }[t];
    var key = 'list:' + cfg.user + ':' + t;
    function prep(d) {
      d.names = {}; d.counts = {};
      d.cats.forEach(function (c) { d.names[String(c.category_id)] = c.category_name; });
      d.items.forEach(function (i) { var k = String(i.category_id); d.counts[k] = (d.counts[k] || 0) + 1; });
      return d;
    }
    function fetchFresh() {
      return Promise.all([api(a[0]), api(a[1])]).then(function (r) {
        var d = { cats: r[0] || [], items: r[1] || [] };
        idbSet(key, { ts: Date.now(), d: d });
        return d;
      });
    }
    idbGet(key).then(function (c) {
      if (c && c.d && Date.now() - c.ts < TTL) return c.d;
      return fetchFresh();
    }).then(function (d) {
      data[t] = prep(d);
      if (tab === t) renderTab();
    }).catch(function (e) { gridState('Não foi possível carregar: ' + e.message, false); });
  }

  function renderTab() {
    var d = data[tab];
    var box = $('#cats'); box.innerHTML = ''; box.scrollTop = 0;
    function addCat(id, name, n) {
      var b = el('button', 'f cat'); b.dataset.id = id;
      b.appendChild(el('span', 'nm', catLabel(name)));
      b.appendChild(el('span', 'n', String(n || 0)));
      if (id === curCat) b.classList.add('active');
      b.onclick = function () { curCat = id; markCats(); applyFilter(); };
      box.appendChild(b);
    }
    addCat('*', 'Todos', d.items.length);
    d.cats.forEach(function (c) { var id = String(c.category_id); if (d.counts[id]) addCat(id, c.category_name, d.counts[id]); });
    applyFilter();
    var fa = document.activeElement;
    if (!fa || fa === document.body) focusFirst();
  }
  // "Canais ⫸ Globo Sul" -> "Globo Sul" (o prefixo se repete em quase todas)
  function catLabel(name) {
    var m = String(name || '').match(/^\s*[^|⫸»>•]{2,24}?\s*[|⫸»>•]+\s*(.+)$/);
    return m ? m[1] : name;
  }
  function markCats() {
    document.querySelectorAll('.cat').forEach(function (b) { b.classList.toggle('active', b.dataset.id === curCat); });
  }

  function applyFilter() {
    var d = data[tab];
    var q = $('#in-search').value.trim().toLowerCase();
    curList = d.items.filter(function (i) {
      if (curCat !== '*' && String(i.category_id) !== curCat) return false;
      return !q || String(i.name || '').toLowerCase().indexOf(q) >= 0;
    });
    $('#crumb-title').textContent = q ? 'Resultados para “' + $('#in-search').value.trim() + '”' : (curCat === '*' ? TAB_LABEL[tab] : catLabel(d.names[curCat] || ''));
    $('#status').textContent = curList.length + (curList.length === 1 ? ' título' : ' títulos');
    shown = 0;
    resetLogos();
    var g = $('#grid'); g.innerHTML = ''; g.scrollTop = 0;
    if (!curList.length) return gridState(q ? 'Nada encontrado.' : 'Esta categoria está vazia.', false);
    renderMore();
  }

  function renderMore() {
    var g = $('#grid');
    var old = g.querySelector('.more'); if (old) old.parentNode.removeChild(old);
    var start = shown, end = Math.min(shown + PAGE, curList.length);
    for (var i = start; i < end; i++) g.appendChild(card(curList[i], i));
    shown = end;
    if (shown < curList.length) {
      var m = el('button', 'f more ' + (tab === 'live' ? 'live' : 'poster'), 'Mostrar mais ' + (curList.length - shown));
      m.onclick = function () { renderMore(); var c = g.children[start + PAGE]; if (c) { c.focus(); ensureVisible(c); } };
      g.appendChild(m);
    }
  }

  function card(item, idx) {
    var live = tab === 'live';
    var c = el('button', 'f card ' + (live ? 'live' : 'poster'));
    var art = el('div', 'art');
    art.appendChild(el('div', 'ph', initials(clean(item.name))));
    var img = el('img');
    img.onload = function () { img.classList.add('ok'); };
    img.onerror = function () { img.style.display = 'none'; };
    setLogo(img, item.stream_icon || item.cover || '');
    art.appendChild(img);
    var rating = parseFloat(item.rating || item.rating_5based * 2 || 0);
    if (!live && rating > 0) art.appendChild(el('div', 'rate', '★ ' + rating.toFixed(1)));
    c.appendChild(art);
    c.appendChild(el('div', 't', clean(item.name)));
    c.onclick = function () { openItem(item, idx); };
    return c;
  }

  function openItem(item, idx) {
    mainFocus = document.activeElement;
    var catName = curCat === '*' ? '' : catLabel(data[tab].names[curCat] || '');
    if (tab === 'live') {
      playCtx = { list: curList, idx: idx, live: true, kind: 'live', cat: catName };
      return playCurrent();
    }
    if (tab === 'vod') {
      playCtx = { list: [item], idx: 0, live: false, kind: 'vod', cat: catName };
      return playCurrent();
    }
    openSeries(item);
  }

  // ---------- séries ----------
  function openSeries(s) {
    $('#status').textContent = 'Abrindo série...';
    api('get_series_info', '&series_id=' + s.series_id).then(function (r) {
      $('#status').textContent = curList.length + ' títulos';
      var info = r.info || {};
      var eps = r.episodes || {};
      if (Array.isArray(eps)) eps = { '1': eps };
      view = 'detail'; show($('#main'), false); show($('#detail'), true);

      var cover = info.cover || s.cover || '';
      var backdrop = (info.backdrop_path && info.backdrop_path[0]) || cover;
      $('#d-bg').style.backgroundImage = backdrop ? 'url("' + backdrop + '")' : '';
      var ci = $('#d-cover'); ci.style.visibility = cover ? '' : 'hidden'; ci.src = cover;
      $('#d-title').textContent = clean(info.name || s.name);
      var meta = $('#d-meta'); meta.innerHTML = '';
      var year = String(info.releaseDate || info.release_date || s.releaseDate || '').slice(0, 4);
      var bits = [];
      if (year) bits.push(year);
      if (info.genre) bits.push(info.genre);
      var keys = Object.keys(eps).sort(function (a, b) { return a - b; });
      bits.push(keys.length + (keys.length === 1 ? ' temporada' : ' temporadas'));
      meta.appendChild(document.createTextNode(bits.join('  ·  ')));
      var rt = parseFloat(info.rating || s.rating || 0);
      if (rt > 0) { meta.appendChild(document.createTextNode('  ·  ')); meta.appendChild(el('span', 'star', '★ ' + rt.toFixed(1))); }
      $('#d-plot').textContent = info.plot || s.plot || '';

      var sb = $('#seasons'); sb.innerHTML = '';
      keys.forEach(function (k, i) {
        var b = el('button', 'f pill', 'Temporada ' + k);
        b.onclick = function () {
          sb.querySelectorAll('.pill').forEach(function (p) { p.classList.toggle('active', p === b); });
          showEpisodes(s, info, eps[k]);
          var f = $('#episodes .ep'); if (f) f.focus();
        };
        if (i === 0) b.classList.add('active');
        sb.appendChild(b);
      });
      if (keys.length) showEpisodes(s, info, eps[keys[0]]);
      var first = $('#episodes .ep') || sb.firstChild; if (first) first.focus();
    }).catch(function (e) { $('#status').textContent = 'Erro: ' + e.message; });
  }
  function showEpisodes(s, info, list) {
    var cover = info.cover || s.cover || '';
    var eps = list.map(function (e) {
      var n = parseInt(e.episode_num, 10) || 0;
      return {
        no: 'E' + pad(n),
        title: e.title || ('Episódio ' + n),
        dur: (e.info && (e.info.duration || '')) || '',
        name: (info.name || s.name) + ' · E' + pad(n),
        logo: cover,
        url: cfg.base + '/series/' + cfg.user + '/' + cfg.pass + '/' + e.id + '.' + (e.container_extension || 'mp4')
      };
    });
    var box = $('#episodes'); box.innerHTML = ''; box.scrollTop = 0;
    eps.forEach(function (e, i) {
      var b = el('button', 'f ep');
      b.appendChild(el('span', 'no', e.no));
      b.appendChild(el('span', 'tt', e.title));
      if (e.dur) b.appendChild(el('span', 'du', String(e.dur).replace(/^00:/, '')));
      b.onclick = function () {
        detailFocus = b;
        playCtx = { list: eps, idx: i, live: false, kind: 'series', cat: info.name || s.name };
        playCurrent();
      };
      box.appendChild(b);
    });
  }

  // ---------- player ----------
  var avp = (window.webapis && window.webapis.avplay) || null;
  var infoTimer, stallTimer, playing = false, duration = 0, curTime = 0, retried = false;

  function itemUrl(it) {
    if (it.url) return it.url;
    if (playCtx.kind === 'live') return cfg.base + '/live/' + cfg.user + '/' + cfg.pass + '/' + it.stream_id + '.m3u8';
    return cfg.base + '/movie/' + cfg.user + '/' + cfg.pass + '/' + it.stream_id + '.' + (it.container_extension || 'mp4');
  }

  function playCurrent() {
    var it = playCtx.list[playCtx.idx];
    retried = false;
    startPlayback(itemUrl(it), it);
  }

  function startPlayback(url, it) {
    stopPlayback(true);
    clearTimeout(stallTimer);
    stallTimer = setTimeout(function () {
      if (!$('#p-spinner').classList.contains('hidden')) fail('O canal não respondeu em 20 segundos. Pode ser o limite de 3 conexões simultâneas da conta ou o canal está fora do ar.');
    }, 20000);
    view = 'player';
    document.body.classList.add('playing');
    show($('#player'), true); show($('#p-error'), false); show($('#p-spinner'), true);
    showInfo();
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
        }, function (e) { fail('Não foi possível abrir o stream (' + e + ').'); });
      } catch (e) { fail(e.message || String(e)); }
    } else {
      var v = $('#html5'); show(v, true);
      v.src = url;
      v.onerror = function () { var c = v.error ? v.error.code : '?'; fail('O player não conseguiu reproduzir este conteúdo (código ' + c + ').'); };
      v.onplaying = function () { clearTimeout(stallTimer); show($('#p-spinner'), false); };
      v.onwaiting = function () { show($('#p-spinner'), true); };
      v.ontimeupdate = function () { curTime = v.currentTime * 1000; duration = (v.duration || 0) * 1000; updateBar(); };
      v.play(); playing = true;
    }
  }

  function fail(msg) {
    show($('#p-spinner'), false);
    clearTimeout(stallTimer);
    var it = playCtx.list[playCtx.idx];
    if (playCtx.live && !retried && !it.url) {   // ao vivo: tenta .ts se .m3u8 falhou
      retried = true;
      return startPlayback(cfg.base + '/live/' + cfg.user + '/' + cfg.pass + '/' + it.stream_id + '.ts', it);
    }
    var e = $('#p-error'); e.innerHTML = '';
    e.appendChild(el('h3', '', 'Não foi possível reproduzir'));
    e.appendChild(el('p', '', msg));
    e.appendChild(el('small', '', playCtx.live ? '▲ ▼ outro canal   ·   VOLTAR sair' : 'VOLTAR para sair'));
    show(e, true);
  }

  function stopPlayback(keepUi) {
    playing = false;
    if (!keepUi) clearTimeout(stallTimer);
    if (avp) { try { avp.stop(); } catch (e) {} try { avp.close(); } catch (e) {} }
    var v = $('#html5'); try { v.pause(); v.removeAttribute('src'); v.load(); } catch (e) {}
    if (!keepUi) show(v, false);
  }

  function closePlayer() {
    stopPlayback();
    show($('#player'), false); show($('#p-info'), false);
    document.body.classList.remove('playing');
    view = $('#detail').classList.contains('hidden') ? 'main' : 'detail';
    var back = view === 'main' ? mainFocus : detailFocus;
    // ao vivo: volta com o foco no canal que estava tocando
    if (view === 'main' && playCtx.live && tab === 'live') {
      var cards = document.querySelectorAll('#grid .card');
      if (cards[playCtx.idx]) back = cards[playCtx.idx];
    }
    if (back && back.offsetParent !== null) { back.focus(); ensureVisible(back); } else focusFirst();
  }

  function fmt(ms) {
    var s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60); s = s % 60;
    return (h ? h + ':' + pad(m) : m) + ':' + pad(s);
  }
  function showInfo() {
    var it = playCtx.list[playCtx.idx];
    var box = $('#p-info'); box.innerHTML = '';
    var logo = el('div', 'pi-logo' + (playCtx.live ? '' : ' poster'));
    var url = it.stream_icon || it.cover || it.logo;
    if (url) { var img = el('img'); img.onerror = function () { img.style.display = 'none'; }; img.src = memLogo[url] || url; logo.appendChild(img); }
    else logo.appendChild(el('span', '', initials(it.name)));
    box.appendChild(logo);

    var tx = el('div', 'pi-text');
    var badge = playCtx.live ? el('div', 'badge live', 'AO VIVO') : el('div', 'badge', playCtx.kind === 'series' ? 'SÉRIE' : 'FILME');
    tx.appendChild(badge);
    tx.appendChild(el('div', 'pi-title', clean(it.name)));
    if (playCtx.live) {
      var sub = el('div', 'pi-sub');
      sub.appendChild(document.createTextNode('Canal ' + (playCtx.idx + 1) + ' de ' + playCtx.list.length + (playCtx.cat ? '  ·  ' + playCtx.cat : '') + '     '));
      sub.appendChild(el('b', '', '▲ ▼')); sub.appendChild(document.createTextNode(' trocar canal'));
      tx.appendChild(sub);
    } else {
      var bar = el('div', 'pi-bar'); bar.appendChild(el('i')); tx.appendChild(bar);
      var sub2 = el('div', 'pi-sub pi-time', ' '); tx.appendChild(sub2);
    }
    box.appendChild(tx);
    box.appendChild(el('div', 'pi-clock', hhmm()));
    show(box, true);
    updateBar();
    clearTimeout(infoTimer);
    infoTimer = setTimeout(function () { show(box, false); }, playCtx.live ? 5000 : 4000);
  }
  function updateBar() {
    var i = $('#p-info .pi-bar i'); if (!i || !duration) return;
    i.style.width = Math.min(100, curTime / duration * 100) + '%';
    var s = $('#p-info .pi-time');
    if (s) s.textContent = fmt(curTime) + ' / ' + fmt(duration) + '      ◄ ► 10s   ·   OK ' + (playing ? 'pausar' : 'continuar');
  }
  function seek(ms) {
    if (playCtx.live) return showInfo();
    if (avp) { try { if (ms > 0) avp.jumpForward(ms); else avp.jumpBackward(-ms); } catch (e) {} }
    else { var v = $('#html5'); v.currentTime = Math.max(0, v.currentTime + ms / 1000); }
    showInfo();
  }
  function togglePause() {
    if (playCtx.live) return showInfo();
    try {
      if (avp) { if (playing) avp.pause(); else avp.play(); } else { var v = $('#html5'); if (playing) v.pause(); else v.play(); }
      playing = !playing;
    } catch (e) {}
    showInfo();
  }
  function zap(d) {
    if (!playCtx.live) return showInfo();
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
    var pref = view === 'main' ? (document.querySelector('#grid .card') || l[0]) : l[0];
    pref.focus(); ensureVisible(pref);
  }
  // Rola o contêiner (.scroller) para mostrar o item com folga, sem cortar o zoom do foco.
  function ensureVisible(e) {
    var p = e.parentNode;
    while (p && p.classList && !p.classList.contains('scroller')) p = p.parentNode;
    if (!p || !p.classList) return;
    var top = e.offsetTop, bottom = top + e.offsetHeight, m = 36;
    if (p.id === 'grid') {
      // grade: rola por linhas inteiras; a linha focada fica na segunda posição
      var pitch = e.offsetHeight + 30;
      if (top - m < p.scrollTop || bottom + m > p.scrollTop + p.clientHeight) p.scrollTop = Math.max(0, top - pitch - 18);
      return;
    }
    if (top - m < p.scrollTop) p.scrollTop = Math.max(0, top - m);
    else if (bottom + m > p.scrollTop + p.clientHeight) p.scrollTop = bottom + m - p.clientHeight;
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
    if (best) { best.focus(); ensureVisible(best); }
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
      return showInfo();
    }
    if (k === KEY.BACK || k === KEY.ESC) {
      ev.preventDefault();
      if (view === 'detail') {
        view = 'main'; show($('#detail'), false); show($('#main'), true);
        if (mainFocus && mainFocus.offsetParent !== null) { mainFocus.focus(); ensureVisible(mainFocus); } else focusFirst();
      } else if (view === 'main') {
        var c = document.querySelector('.cat.active');
        if (c && document.activeElement !== c) { c.focus(); ensureVisible(c); }
        else if (window.tizen) tizen.application.getCurrentApplication().exit();
      } else if (window.tizen) tizen.application.getCurrentApplication().exit();
      return;
    }
    if (inInput && (k === KEY.LEFT || k === KEY.RIGHT || k === KEY.BACKSPACE)) return;   // edição de texto
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
  $('#in-pass').addEventListener('keydown', function (e) { if (e.keyCode === KEY.ENTER) login(); });
  var searchT;
  $('#in-search').addEventListener('input', function () { clearTimeout(searchT); searchT = setTimeout(function () { if (data[tab]) applyFilter(); }, 250); });
  $('#btn-logout').onclick = function () {
    store('cfg', null); cfg = null; data = { live: null, vod: null, series: null };
    view = 'login'; show($('#main'), false); show($('#login'), true); $('#in-pass').value = ''; loginMsg(''); $('#in-pass').focus();
  };

  try {
    if (window.tizen && tizen.tvinputdevice) {
      ['MediaPlay', 'MediaPause', 'MediaPlayPause', 'MediaStop', 'MediaFastForward', 'MediaRewind', 'ChannelUp', 'ChannelDown']
        .forEach(function (n) { try { tizen.tvinputdevice.registerKey(n); } catch (e) {} });
    }
  } catch (e) {}

  function tick() { $('#clock').textContent = hhmm(); var pc = $('#p-info .pi-clock'); if (pc) pc.textContent = hhmm(); }
  tick(); setInterval(tick, 15000);

  function fit() {
    var de = document.documentElement;
    var w = de.clientWidth || window.innerWidth, h = de.clientHeight || window.innerHeight;
    var k = Math.min(w / 1920, h / 1080) || 1;
    document.body.style.transformOrigin = '0 0';
    document.body.style.transform = Math.abs(k - 1) < 0.01 ? '' : 'scale(' + k + ')';
  }
  $('#ver').textContent = 'v' + VERSION;
  window.addEventListener('resize', fit); fit();

  var saved = store('cfg');
  if (saved && saved.base) {
    cfg = saved;
    $('#in-server').value = saved.base; $('#in-user').value = saved.user; $('#in-pass').value = saved.pass;
    loginMsg('Entrando...');
    api().then(function (r) {
      if (r && r.user_info && r.user_info.auth !== 0) enterMain(); else { loginMsg('Sessão expirada. Entre novamente.', true); focusFirst(); }
    }).catch(function () { loginMsg('Não foi possível entrar automaticamente. Tente novamente.', true); focusFirst(); });
  }
  focusFirst();
  if (!saved && $('#in-server').value && $('#in-user').value) $('#in-pass').focus();
})();
