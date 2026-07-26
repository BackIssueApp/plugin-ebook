// Books client — injected by core via window.BackIssue. Books live in the
// normal Library/series flow, so this file adds NO pages of its own: it
// registers per-issue actions (Read / Download file) and a cover provider for
// ebook issues, owns the series page's shelf (grid of covers or a list, via
// core's registerSeriesView) plus the book detail sheet the shelf opens, and
// owns the EPUB reading shell — the vendored foliate-js engine in an overlay
// styled like the comic reader (same chrome vocabulary: full-screen flex
// column, translucent top/bottom bars, chrome-hidden translate, tap zones /
// arrow keys), with font/theme/spacing settings and per-user progress +
// resume. PDFs stream inline to the browser's own viewer.
(function () {
  'use strict';

  const VENDOR = '/plugins/ebooks/client/vendor/foliate-js/view.js';
  const THEMES = {
    light: { bg: '#ffffff', fg: '#1b1b1f', link: '#1a5fb4' },
    sepia: { bg: '#f3ead3', fg: '#4f402a', link: '#8a5a2b' },
    dark:  { bg: '#14141a', fg: '#c8c8d0', link: '#7aa2ff' },
  };
  const SETTINGS_KEY = 'ebooksReaderSettings';
  const FINISHED = 0.98; // an EPUB read this far counts as finished

  window.BackIssue.registerClient((api) => {
    const esc = api.escapeHtml;
    const icon = (n, o) => (api.icon && api.icon(n, o)) || '';
    const canUse = () => typeof api.can !== 'function' || api.can('ebooks.use');

    // The series page hands ebook series' whole issue area to this view
    // (core's registerSeriesView) — registered before the permission gate so
    // the page always has a view (it explains itself to roles without the
    // permission). On cores without the hook this is a no-op and the old
    // generic issue list renders instead.
    api.registerSeriesView && api.registerSeriesView({ type: 'ebook', render: renderBooksView });

    // Row actions, covers and the reading shell are pointless without the
    // permission — the server would 403 every route they touch.
    if (!canUse()) return;

    // ---------------- issue-row integration ----------------
    // An ebook issue: a local (non-ComicVine) issue the ebooks store knows as a
    // book. Detection comes from the store's book-info map (`books`, loaded
    // below), NOT core's on-disk `files` — so a FILE-LESS remote (on-demand)
    // book is recognized as readable too (opening it downloads on demand).
    // `books` may not have loaded yet on the very first render; fall back to the
    // on-disk file so owned books still show before the map arrives.
    const bookInfoOf = (i) => (i && i.id != null ? bookInfo[i.id] : null);
    const diskFile = (i) => (i.files || []).find((f) => /\.(epub|pdf)$/i.test(f.name || '')) || null;
    const bookFormat = (i) => {
      const bi = bookInfoOf(i);
      if (bi && bi.format) return bi.format;
      const f = diskFile(i); return f ? (/\.epub$/i.test(f.name) ? 'epub' : 'pdf') : null;
    };
    const isRemote = (i) => { const bi = bookInfoOf(i); return !!(bi && bi.remote); };
    const isBook = (i) => !!i && i.id != null && !i.cv_issue_id && !i.corrupt
      && (!!bookInfoOf(i) || (!!i.owned && !!diskFile(i)));

    // One open path for every trigger (issue-row action, series-view Read
    // button): EPUB opens the shell; PDF streams inline to the browser's own
    // viewer.
    function openBook(issue) {
      if (bookFormat(issue) === 'epub') openReader(issue);
      else window.open('/api/ebooks/issue/' + issue.id + '/file', '_blank');
    }

    // The caller's reading positions (issue id → { fraction }) — drives the
    // Read action's icon/label, same pattern as the comic reader's states.
    let states = {};
    const bookInfo = {}; // issue id → { format, remote } — filled per series (scoped)
    const stateOf = (i) => states[i.id] || null;
    async function loadStates() {
      try {
        states = (await api.get('/api/ebooks/state')).states || {};
        api.refreshIssueActions && api.refreshIssueActions();
      } catch { /* icons just stay at "unread" */ }
    }
    loadStates();

    // Fill bookInfo for a SET of issues (a series' issues) — scoped, so we never
    // pull the whole catalog. Returns once the info is in `bookInfo`.
    async function ensureBookInfo(issues) {
      const need = (issues || []).map((i) => i && i.id).filter((id) => id != null && !(id in bookInfo));
      if (!need.length) return;
      try {
        const r = await api.get('/api/ebooks/books?issues=' + need.join(','));
        Object.assign(bookInfo, r.books || {});
      } catch { /* undetected → diskFile fallback */ }
      // Ids with no ebook row: mark resolved (null) so we don't refetch them.
      for (const id of need) if (!(id in bookInfo)) bookInfo[id] = null;
    }

    // Covers: embedded EPUB art (or the metadata match thumbnail) via the
    // plugin's cover route. First non-null provider wins in core.
    api.registerIssueCover && api.registerIssueCover((i) =>
      (i && i.id != null && !i.cv_issue_id && isBook(i) ? '/api/ebooks/issue/' + i.id + '/cover' : null));

    // Read: EPUB opens the shell; PDF streams inline to the browser's viewer.
    api.registerIssueAction && api.registerIssueAction({
      id: 'ebooks-read',
      icon: (i) => {
        const st = stateOf(i);
        if (st && st.fraction >= FINISHED) return icon('check');
        if (st && st.fraction > 0) return icon('circle-half');
        return icon('play');
      },
      title: (i) => {
        const st = stateOf(i);
        if (bookFormat(i) === 'pdf') return 'Open (browser PDF viewer)';
        if (st && st.fraction >= FINISHED) return 'Read again';
        if (st && st.fraction > 0) return 'Continue (' + Math.round(st.fraction * 100) + '%)';
        return 'Read';
      },
      when: isBook,
      run: (i) => openBook(i),
    });

    // Download the book file itself (books have no source downloads).
    api.registerIssueAction && api.registerIssueAction({
      id: 'ebooks-download',
      icon: icon('download'),
      title: 'Download book file',
      when: isBook,
      run: (i) => {
        const a = document.createElement('a');
        a.href = '/api/ebooks/issue/' + i.id + '/file?dl=1';
        document.body.appendChild(a); a.click(); a.remove();
      },
    });

    // ---------------- EPUB reading shell ----------------
    let reader = null; // { el, view, issue, saveTimer, pending }
    const defaults = { theme: 'dark', fontPct: 100, spacing: 1.5 };
    let prefs = { ...defaults };
    try { prefs = { ...defaults, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; } catch { /* defaults */ }
    const savePrefs = () => localStorage.setItem(SETTINGS_KEY, JSON.stringify(prefs));

    function buildReader() {
      const el = document.createElement('div');
      el.className = 'ebr';
      el.setAttribute('role', 'dialog');
      el.innerHTML =
        '<div class="ebr__stage"><div class="ebr__loading">Opening…</div></div>' +
        '<div class="ebr__zone ebr__zone--left" title="Previous page"></div>' +
        '<div class="ebr__zone ebr__zone--right" title="Next page"></div>' +
        '<div class="ebr__top">' +
          '<button class="ebr__btn ebr-back" title="Close (Esc)" aria-label="Close reader">' + icon('close') + '</button>' +
          '<div class="ebr__title"></div>' +
          '<div class="ebr__count"></div>' +
          '<span class="ebr__spacer"></span>' +
          '<button class="ebr__btn ebr-toc" title="Contents" aria-label="Contents">' + icon('list') + '</button>' +
          '<button class="ebr__btn ebr-set" title="Display settings" aria-label="Display settings">' + icon('settings') + '</button>' +
        '</div>' +
        '<div class="ebr__bottom">' +
          '<button class="ebr__btn ebr-prev" title="Previous page" aria-label="Previous page">' + icon('chevron-left') + '</button>' +
          '<div class="ebr__sliderwrap">' +
            '<input class="ebr__slider" type="range" min="0" max="1" step="0.001" value="0" aria-label="Position">' +
          '</div>' +
          '<button class="ebr__btn ebr-next" title="Next page" aria-label="Next page">' + icon('chevron-right') + '</button>' +
          '<div class="ebr__loc"></div>' +
        '</div>' +
        '<div class="ebr__settings">' +
          '<label>Font size <span class="ebr__step">' +
            '<button class="ebr__btn ebr-font-dn" aria-label="Smaller text">' + icon('minus') + '</button><b class="ebr-font-val"></b>' +
            '<button class="ebr__btn ebr-font-up" aria-label="Larger text">' + icon('plus') + '</button></span></label>' +
          '<label>Line spacing <span class="ebr__step">' +
            '<button class="ebr__btn ebr-sp-dn" aria-label="Tighter lines">' + icon('minus') + '</button><b class="ebr-sp-val"></b>' +
            '<button class="ebr__btn ebr-sp-up" aria-label="Looser lines">' + icon('plus') + '</button></span></label>' +
          '<div class="ebr__themes" role="group" aria-label="Book theme">' +
            ['light', 'sepia', 'dark'].map((t) => '<button class="ebr__themebtn" data-theme="' + t + '" title="' + t[0].toUpperCase() + t.slice(1) + '" aria-label="' + t + ' theme"></button>').join('') +
          '</div>' +
        '</div>' +
        '<div class="ebr__toc">' +
          '<div class="ebr__tochead"><span>Contents</span> <button class="ebr__btn ebr-toc-close" aria-label="Close contents">' + icon('close') + '</button></div>' +
          '<div class="ebr__toc-list"></div>' +
        '</div>';
      document.body.appendChild(el);
      return el;
    }

    async function openReader(issue) {
      const el = (reader && reader.el) || buildReader();
      reader = { el, view: null, issue, saveTimer: null, pending: null };
      el.classList.add('is-open');
      // A previous session may have ended with the bars hidden — a reopened
      // book must always start with visible chrome or it can't be controlled.
      el.classList.remove('chrome-hidden');
      el.dataset.theme = prefs.theme;
      document.body.classList.add('ebr-open');
      el.querySelector('.ebr__title').textContent = issue.title || 'Untitled';
      el.querySelector('.ebr__count').textContent = '';
      el.querySelector('.ebr__loc').textContent = '';
      el.querySelector('.ebr__settings').classList.remove('is-open');
      el.querySelector('.ebr__toc').classList.remove('is-open');
      const stage = el.querySelector('.ebr__stage');
      stage.innerHTML = '<div class="ebr__loading">Opening…</div>';

      try {
        // The engine: vendored foliate-js, loaded on first read (an ES module —
        // this also defines the <foliate-view> element). The whole file is
        // fetched and handed over as a File; foliate-js does the rest.
        const [prog] = await Promise.all([
          api.get('/api/ebooks/issue/' + issue.id + '/progress').then((r) => r.progress).catch(() => null),
          import(VENDOR),
        ]);
        const resp = await fetch('/api/ebooks/issue/' + issue.id + '/file');
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const name = (diskFile(issue) || {}).name || 'book.epub';
        const file = new File([await resp.blob()], name, { type: 'application/epub+zip' });

        const view = document.createElement('foliate-view');
        stage.innerHTML = '';
        stage.appendChild(view);
        reader.view = view;
        // Subscribe BEFORE open(): the engine fires 'load' for the first
        // section during open, and a late listener misses it — leaving the
        // landing page without tap/keyboard wiring (dead center-tap).
        view.addEventListener('relocate', (e) => onRelocate(e.detail));
        view.addEventListener('load', (e) => wireDoc(e.detail.doc));
        await view.open(file);
        applyEngineStyles();
        buildToc(view.book?.toc);
        // Resume at the saved locator (a CFI); a book never opened starts at
        // the beginning.
        if (prog && prog.locator) await view.init({ lastLocation: prog.locator });
        else view.renderer.next();
      } catch (e) {
        stage.innerHTML = '<div class="ebr__loading">Couldn’t open this book: ' + esc(String(e?.message || e)) + '</div>';
      }
      wireReaderChrome();
    }

    function wireReaderChrome() {
      const el = reader.el;
      const view = () => reader.view;
      el.querySelector('.ebr-back').onclick = closeReader;
      el.querySelector('.ebr-prev').onclick = () => view()?.goLeft();
      el.querySelector('.ebr-next').onclick = () => view()?.goRight();
      el.querySelector('.ebr__zone--left').onclick = () => view()?.goLeft();
      el.querySelector('.ebr__zone--right').onclick = () => view()?.goRight();
      el.querySelector('.ebr-toc').onclick = () => el.querySelector('.ebr__toc').classList.toggle('is-open');
      el.querySelector('.ebr-toc-close').onclick = () => el.querySelector('.ebr__toc').classList.remove('is-open');
      el.querySelector('.ebr-set').onclick = () => el.querySelector('.ebr__settings').classList.toggle('is-open');
      el.querySelector('.ebr__slider').oninput = (e) => view()?.goToFraction(parseFloat(e.target.value));

      const setFont = (d) => { prefs.fontPct = Math.min(200, Math.max(60, prefs.fontPct + d)); savePrefs(); syncSettingsUI(); applyEngineStyles(); };
      const setSp = (d) => { prefs.spacing = Math.round(Math.min(2.4, Math.max(1.0, prefs.spacing + d)) * 10) / 10; savePrefs(); syncSettingsUI(); applyEngineStyles(); };
      el.querySelector('.ebr-font-dn').onclick = () => setFont(-10);
      el.querySelector('.ebr-font-up').onclick = () => setFont(10);
      el.querySelector('.ebr-sp-dn').onclick = () => setSp(-0.1);
      el.querySelector('.ebr-sp-up').onclick = () => setSp(0.1);
      for (const b of el.querySelectorAll('.ebr__themebtn')) {
        b.onclick = () => { prefs.theme = b.dataset.theme; savePrefs(); el.dataset.theme = prefs.theme; syncSettingsUI(); applyEngineStyles(); };
      }
      syncSettingsUI();
      document.addEventListener('keydown', shellKeydown);
    }

    function syncSettingsUI() {
      const el = reader.el;
      el.querySelector('.ebr-font-val').textContent = prefs.fontPct + '%';
      el.querySelector('.ebr-sp-val').textContent = prefs.spacing.toFixed(1);
      for (const b of el.querySelectorAll('.ebr__themebtn')) b.classList.toggle('is-on', b.dataset.theme === prefs.theme);
    }

    // Styles injected into the book iframe: theme colors, font scale, spacing.
    function applyEngineStyles() {
      const t = THEMES[prefs.theme] || THEMES.dark;
      reader.view?.renderer?.setStyles?.(
        'html { color-scheme: ' + (prefs.theme === 'dark' ? 'dark' : 'light') + '; font-size: ' + prefs.fontPct + '%; }' +
        'html, body { background: ' + t.bg + ' !important; color: ' + t.fg + '; }' +
        'a:link, a:visited { color: ' + t.link + '; }' +
        'p, li, blockquote, dd { line-height: ' + prefs.spacing + '; }' +
        'pre { white-space: pre-wrap !important; }' +
        // Reading surface, not a web page: selectable text makes mobile
        // browsers hijack taps (Chrome's Touch to Search opens a Google
        // sheet on word taps). Re-enable deliberately if highlights or a
        // dictionary feature ever land.
        'html, body { -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; }');
    }

    // Keyboard + tap zones INSIDE the book iframe (each loaded section doc).
    function wireDoc(doc) {
      doc.addEventListener('keydown', shellKeydown);
      doc.addEventListener('click', (e) => {
        if (e.target?.closest?.('a')) return; // links navigate, not chrome-toggle
        // No zone math in here: the engine paginates sections as a wide
        // multi-column strip, so click coordinates inside the iframe don't
        // correspond to what's visually on screen. Page turns belong to the
        // shell's edge zones (screen space) and the keyboard; a tap on the
        // book itself only shows/hides the chrome.
        reader.el.classList.toggle('chrome-hidden');
      });
    }
    function shellKeydown(e) {
      if (!reader || !reader.el.classList.contains('is-open')) return;
      if (e.key === 'ArrowLeft') reader.view?.goLeft();
      else if (e.key === 'ArrowRight') reader.view?.goRight();
      else if (e.key === 'Escape') closeReader();
    }

    function buildToc(toc) {
      const wrap = reader.el.querySelector('.ebr__toc-list');
      wrap.innerHTML = '';
      if (!Array.isArray(toc) || !toc.length) { wrap.innerHTML = '<div class="ebr__note">No contents listing.</div>'; return; }
      const render = (items) => {
        const ul = document.createElement('ul');
        for (const it of items) {
          const li = document.createElement('li');
          const a = document.createElement('a');
          a.textContent = it.label || '—';
          a.onclick = () => {
            reader.view?.goTo(it.href).catch(() => {});
            reader.el.querySelector('.ebr__toc').classList.remove('is-open');
          };
          li.appendChild(a);
          if (Array.isArray(it.subitems) && it.subitems.length) li.appendChild(render(it.subitems));
          ul.appendChild(li);
        }
        return ul;
      };
      wrap.appendChild(render(toc));
    }

    // Progress: the relocate event fires on every page turn; saves are
    // debounced so a fast flipper doesn't spray the server. The local state
    // map updates too, so the row icon is honest the moment the shell closes.
    function onRelocate(detail) {
      const el = reader.el;
      const frac = detail?.fraction ?? 0;
      el.querySelector('.ebr__slider').value = String(frac);
      // Top-bar count + bottom-bar position, same split as the comic reader's
      // page count (top) and pageno (bottom); the count hides on phones.
      el.querySelector('.ebr__count').textContent = Math.round(frac * 100) + '%';
      el.querySelector('.ebr__loc').textContent =
        Math.round(frac * 100) + '%' + (detail?.tocItem?.label ? ' · ' + detail.tocItem.label : '');
      reader.pending = { locator: detail?.cfi || null, fraction: frac };
      states[reader.issue.id] = { fraction: frac };
      clearTimeout(reader.saveTimer);
      reader.saveTimer = setTimeout(flushProgress, 1200);
    }
    function flushProgress() {
      if (!reader || !reader.pending) return;
      const body = reader.pending;
      reader.pending = null;
      api.post('/api/ebooks/issue/' + reader.issue.id + '/progress', body).catch(() => {});
    }

    function closeReader() {
      if (!reader) return;
      clearTimeout(reader.saveTimer);
      flushProgress();
      document.removeEventListener('keydown', shellKeydown);
      reader.view?.close?.();
      reader.el.querySelector('.ebr__stage').innerHTML = '';
      reader.el.classList.remove('is-open');
      document.body.classList.remove('ebr-open');
      reader.view = null;
      // Row icons reflect this session immediately — and if the detail sheet
      // is waiting under the shell, its progress/labels repaint right away
      // too (the tick-driven shelf re-render also re-syncs it, later).
      api.refreshIssueActions && api.refreshIssueActions();
      if (sheet) renderSheet();
    }

    // ---------------- series view: the book shelf ----------------
    // Owns the issue area of ebook series pages (core keeps the hero/menu and
    // hands this a container). Comic vocabulary — filter chips, issue-number
    // rows, download states — means nothing for a shelf of one to a few
    // books, so instead: a shelf header (title, mono stat line, series
    // read-through bar, shelf/list toggle) over either a cover grid or a list,
    // one entry per BOOK — multiple files of the same book (an EPUB + PDF of
    // one title) group into a single entry carrying per-format download
    // badges. Cards open the detail sheet (one click for everything — its
    // primary button reads); list rows keep a direct Read button. A series
    // of exactly ONE book (standalone books — the common case) skips the
    // shelf entirely and renders the book detail inline (renderSingleBook):
    // one click on the book, everything's there. Core re-renders on series
    // refresh and on refreshIssueActions() (progress saved when the shell
    // closes), so read states stay honest.
    const VIEW_KEY = 'ebooksShelfView';
    let shelfView = localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'shelf';

    // Deterministic per-title hue for placeholder covers: the same book keeps
    // the same gradient tile across renders, views, and the detail sheet.
    const hueOf = (t) => {
      let h = 0;
      const s = String(t || '');
      for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
      return h % 360;
    };
    const coverBg = (title, lift) => {
      const h = hueOf(title);
      const l = lift ? [40, 24] : [38, 22]; // hero tiles sit a touch lighter
      return 'linear-gradient(150deg,hsl(' + h + ' 55% ' + l[0] + '%),hsl(' + (h + 25) + ' 50% ' + l[1] + '%))';
    };

    const bookFrac = (b) => { const st = stateOf(b.primary); return st ? st.fraction : 0; };

    // Group issue rows into books: same number + title = one book in several
    // formats. EPUB leads (it's what the shell reads); the rest ride along as
    // download badges.
    function groupBooks(issues) {
      const groups = new Map();
      for (const i of issues) {
        if (!isBook(i)) continue; // no readable file on disk (vanished/corrupt)
        const key = String(i.number ?? '') + '\x00' + String(i.title || '').trim().toLowerCase();
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(i);
      }
      return [...groups.values()].map((entries) => {
        entries.sort((a, b) => (bookFormat(a) === 'pdf' ? 1 : 0) - (bookFormat(b) === 'pdf' ? 1 : 0));
        return { primary: entries[0], entries };
      });
    }

    // A standalone book is a single-book series named after itself (that's
    // how the scanner files series-less books) — it hides sequence chips and
    // swaps "Series · Book N of M" for its library's name.
    const isStandalone = (books, series) => books.length === 1 &&
      String((series && series.title) || '').trim().toLowerCase() ===
      String(books[0].primary.title || '').trim().toLowerCase();

    // One re-match path for the list row and the sheet's Manage block.
    async function rematchBook(issue, ctx) {
      try {
        const r = await ctx.post('/api/ebooks/issue/' + issue.id + '/rematch', {});
        if (r && r.error) api.toast(r.error, 'error');
        else if (r && r.matched) { api.toast('Matched — metadata updated.', 'ok'); ctx.refresh(); }
        else api.toast('No confident match found.', 'info');
      } catch (e) { api.toast('Re-match failed: ' + String((e && e.message) || e), 'error'); }
    }

    function renderBooksView(container, ctx) {
      container.innerHTML = '';
      if (!canUse()) {
        container.innerHTML = '<div class="ebk__empty">Reading books requires the “Books library” permission.</div>';
        return;
      }

      // Book detection needs this series' book-info (local vs file-less remote).
      // Fetch it scoped to THIS series' issues if we don't have it yet, show a
      // brief loading state, and re-render when it arrives — otherwise a
      // file-less on-demand series would flash the empty message.
      const unknown = (ctx.issues || []).some((i) => i && i.id != null && !(i.id in bookInfo));
      if (unknown) {
        container.innerHTML = '<div class="ebk__empty">Loading…</div>';
        ensureBookInfo(ctx.issues).then(() => { if (container.isConnected) renderBooksView(container, ctx); });
        return;
      }
      const books = groupBooks(ctx.issues);
      if (!books.length) {
        container.innerHTML = '<div class="ebk__empty">No readable books in this series yet. If files were moved or deleted, a library scan will tidy this up.</div>';
        return;
      }

      // One book: the detail renders right here — a one-card shelf that
      // needs another click is pure friction, and the shelf header (stat
      // line, read-through bar, view toggle) says nothing the detail's own
      // Files section doesn't.
      if (books.length === 1) {
        if (sheet) closeSheet(); // the inline view IS the detail
        renderSingleBook(container, ctx, books);
        return;
      }

      const readCount = books.filter((b) => bookFrac(b) >= FINISHED).length;

      // Mono stat line: "3 books · 1 read · 2 EPUB · 1 PDF".
      const fmtCounts = {};
      for (const b of books) {
        for (const e of b.entries) {
          const f = (bookFormat(e) || '').toUpperCase();
          fmtCounts[f] = (fmtCounts[f] || 0) + 1;
        }
      }
      const bits = [books.length + ' books'];
      if (readCount) bits.push(readCount + ' read');
      for (const [f, n] of Object.entries(fmtCounts)) bits.push(n + ' ' + f);

      const manage = ctx.can('library.manage');
      const thruPct = Math.round((readCount / books.length) * 100);

      const fmtLinks = (b) => b.entries.map((e) => {
        const f = (bookFormat(e) || '').toUpperCase();
        return '<a class="ebk__fmt" href="/api/ebooks/issue/' + e.id + '/file?dl=1" title="Download the ' + f + ' file">' + f + '</a>';
      }).join('');

      // Read-state vocabulary matches the issue rows: check = finished,
      // half-circle + percent = in progress, quiet "Unread" otherwise.
      const cardHtml = (b, idx) => {
        const frac = bookFrac(b);
        const done = frac >= FINISHED;
        const part = !done && frac > 0;
        const p = Math.round(frac * 100);
        const pdfOnly = bookFormat(b.primary) !== 'epub';
        const chip = done
          ? '<span class="ebk__chip ebk__chip--done">' + icon('check', { size: 12 }) + 'Read</span>'
          : part ? '<span class="ebk__chip ebk__chip--part">' + icon('circle-half', { size: 12 }) + p + '%</span>' : '';
        const stateCls = done ? ' ebk__st--done' : part ? ' ebk__st--part' : '';
        const stateText = done ? 'Finished' : part ? p + '% read' : (pdfOnly ? 'PDF' : 'Unread');
        return '<div class="ebk__card" data-book="' + idx + '" role="button" tabindex="0">' +
          '<div class="ebk__cover" style="background:' + coverBg(b.primary.title) + '">' +
            icon('library', { size: 46 }) +
            '<img loading="lazy" alt="" src="/api/ebooks/issue/' + b.primary.id + '/cover">' +
            '<span class="ebk__seq">' + esc(String(b.primary.number ?? '')) + '</span>' +
            chip +
            (part ? '<div class="ebk__bar"><div class="ebk__bar-fill" style="width:' + p + '%"></div></div>' : '') +
          '</div>' +
          '<div class="ebk__card-title">' + esc(b.primary.title || 'Untitled') + '</div>' +
          '<div class="ebk__card-meta"><span class="ebk__st' + stateCls + '">' + stateText + '</span>' +
            '<span class="ebk__fmts">' + fmtLinks(b) + '</span></div>' +
        '</div>';
      };

      const rowHtml = (b, idx) => {
        const frac = bookFrac(b);
        const done = frac >= FINISHED;
        const part = !done && frac > 0;
        const p = Math.round(frac * 100);
        const pdfOnly = bookFormat(b.primary) !== 'epub';
        const stateCls = done ? ' ebk__st--done' : part ? ' ebk__st--part' : '';
        const stateIcon = done ? icon('check', { size: 13 }) : part ? icon('circle-half', { size: 13 }) : '';
        const stateText = done ? 'Finished' : part ? p + '% read' : (pdfOnly ? 'PDF' : 'Unread');
        const readLabel = pdfOnly ? 'Open' : done ? 'Read again' : part ? 'Continue' : 'Read';
        const readIcon = done ? icon('check', { size: 15 }) : icon('play', { size: 15 });
        return '<div class="ebk__row">' +
          '<span class="ebk__rowseq">' + esc(String(b.primary.number ?? '')) + '</span>' +
          '<div class="ebk__art" style="background:' + coverBg(b.primary.title) + '">' + icon('library', { size: 18 }) +
            '<img loading="lazy" alt="" src="/api/ebooks/issue/' + b.primary.id + '/cover"></div>' +
          '<div class="ebk__main">' +
            '<div class="ebk__title">' + esc(b.primary.title || 'Untitled') + '</div>' +
            '<div class="ebk__meta"><span class="ebk__st' + stateCls + '">' + stateIcon + stateText + '</span>' +
              (part ? '<div class="ebk__bar ebk__bar--row"><div class="ebk__bar-fill" style="width:' + p + '%"></div></div>' : '') +
            '</div>' +
          '</div>' +
          '<span class="ebk__fmts">' + fmtLinks(b) + '</span>' +
          '<button class="ebk__read' + (done || part ? '' : ' ebk__read--primary') + '" data-read="' + idx + '" title="' +
            (pdfOnly ? 'Open (browser PDF viewer)' : part ? 'Continue (' + p + '%)' : readLabel) + '">' +
            readIcon + ' ' + readLabel + '</button>' +
          (manage ? '<button class="ebk__rematch" data-rematch="' + idx +
            '" title="Re-match this book against the metadata service">' + icon('diamond', { size: 15 }) + '</button>' : '') +
        '</div>';
      };

      container.innerHTML =
        '<div class="ebk">' +
          '<div class="ebk__head">' +
            '<div class="ebk__headline"><span class="ebk__h">Shelf</span>' +
              '<span class="ebk__stats">' + esc(bits.join(' · ')) + '</span></div>' +
            '<div class="ebk__thru"><div class="ebk__thru-track"><div class="ebk__thru-fill" style="width:' + thruPct + '%"></div></div>' +
              '<span class="ebk__thru-txt">' + readCount + '/' + books.length + ' read</span></div>' +
            '<div class="viewtoggle ebk__toggle" role="group" aria-label="Shelf view">' +
              '<button class="viewtoggle__btn' + (shelfView === 'shelf' ? ' is-active' : '') + '" data-view="shelf" title="Shelf">' + icon('grid', { size: 15 }) + '</button>' +
              '<button class="viewtoggle__btn' + (shelfView === 'list' ? ' is-active' : '') + '" data-view="list" title="List">' + icon('menu', { size: 15 }) + '</button>' +
            '</div>' +
          '</div>' +
          (shelfView === 'shelf'
            ? '<div class="ebk__grid">' + books.map(cardHtml).join('') + '</div>'
            : '<div class="ebk__list">' + books.map(rowHtml).join('') + '</div>') +
        '</div>';

      // Wiring: no inline handlers — everything hangs off nodes inside the
      // container, so core's clear-on-rerender tears it all down cleanly.
      for (const img of container.querySelectorAll('.ebk__art img, .ebk__cover img')) {
        img.addEventListener('error', () => img.remove()); // the book glyph shows through
      }
      // Format badges are downloads, not card opens.
      for (const a of container.querySelectorAll('.ebk__fmt')) {
        a.addEventListener('click', (e) => e.stopPropagation());
      }
      for (const card of container.querySelectorAll('[data-book]')) {
        const open = () => openSheet(books, +card.dataset.book, ctx);
        card.addEventListener('click', open);
        card.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
        });
      }
      for (const btn of container.querySelectorAll('[data-view]')) {
        btn.addEventListener('click', () => {
          shelfView = btn.dataset.view === 'list' ? 'list' : 'shelf';
          localStorage.setItem(VIEW_KEY, shelfView);
          renderBooksView(container, ctx);
        });
      }
      for (const btn of container.querySelectorAll('[data-read]')) {
        btn.addEventListener('click', () => openBook(books[+btn.dataset.read].primary));
      }
      for (const btn of container.querySelectorAll('[data-rematch]')) {
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          await rematchBook(books[+btn.dataset.rematch].primary, ctx);
          btn.disabled = false;
        });
      }

      // An open detail sheet rides every shelf re-render (series refresh,
      // reader close, mark-read): re-point it at the fresh book objects so
      // its progress/labels never go stale — or close it if its book is gone.
      if (sheet) {
        const at = books.findIndex((b) => b.entries.some((e) => e.id === sheet.bookId));
        if (at < 0) closeSheet();
        else { sheet.books = books; sheet.idx = at; sheet.ctx = ctx; renderSheet(); }
      }
    }

    // ---------------- shared book-detail builders ----------------
    // One source of truth for both detail surfaces: the full-page sheet a
    // multi-book shelf card opens (renderSheet), and the inline detail a
    // single-book series renders directly (renderSingleBook). Builders return
    // the same `.ebs__*` markup and wireBookDetail hangs the same handlers
    // off whatever root it was rendered into, so the two views can't drift.
    const detailCache = {};   // issue id → plugin details (language/ISBN/added), null = fetch failed/ran

    // Derived read-state for one grouped book — every builder starts here.
    function bookState(b) {
      const frac = bookFrac(b);
      const done = frac >= FINISHED;
      const part = !done && frac > 0;
      return {
        done, part,
        p: Math.round(frac * 100),
        pdfOnly: bookFormat(b.primary) !== 'epub',
        hasEpub: b.entries.some((e) => bookFormat(e) === 'epub'),
      };
    }

    // Language/ISBN/added live on the plugin's file rows, not the core issue
    // payload — fetched once per book (even if it fails); `rerender` runs
    // when they land so the Details grid fills in.
    function ensureDetails(b, rerender) {
      if (detailCache[b.primary.id] !== undefined) return;
      detailCache[b.primary.id] = null;
      api.get('/api/ebooks/issue/' + b.primary.id + '/details')
        .then((r) => { detailCache[b.primary.id] = (r && r.details) || null; rerender(); })
        .catch(() => {});
    }

    // The progress strip + action row: bar, colored state text, the primary
    // Read/Continue/Read again/Open button and the Mark finished toggle.
    function progressActionsHtml(b) {
      const { done, part, p, pdfOnly, hasEpub } = bookState(b);
      const progCls = done ? ' ebs__prog--done' : part ? ' ebs__prog--part' : '';
      const progText = done ? 'Finished' : part ? p + '% read' : 'Unread';
      const readLabel = pdfOnly ? 'Open (PDF viewer)' : done ? 'Read again' : part ? 'Continue reading' : 'Read';
      const readIcon = done ? icon('check', { size: 15 }) : icon('play', { size: 15 });
      return '<div class="ebs__prog' + progCls + '"><div class="ebs__prog-track"><div class="ebs__prog-fill" style="width:' + (done ? 100 : p) + '%"></div></div>' +
          '<span class="ebs__prog-txt">' + progText + '</span></div>' +
        '<div class="ebs__actions">' +
          '<button class="btn btn--primary ebs__readbtn ebs-read">' + readIcon + ' ' + readLabel + '</button>' +
          (hasEpub ? '<button class="btn btn--ghost ebs__markbtn ebs-mark">' + (done ? 'Mark unread' : 'Mark finished') + '</button>' : '') +
        '</div>';
    }

    // Files rows, Details grid, resume card (while in progress) and the
    // Manage block (library.manage) — everything below the blurb.
    function detailSectionsHtml(b, books, ctx, busy) {
      const { done, part, p, hasEpub } = bookState(b);
      const standalone = isStandalone(books, ctx.series);
      const seriesTitle = String((ctx.series && ctx.series.title) || '');
      const num = String(b.primary.number ?? '');
      const by = (ctx.series && ctx.series.publisher) || '';
      const det = detailCache[b.primary.id];
      const manage = ctx.can('library.manage');

      const fileRows = b.entries.map((e, i) => {
        const fmtU = (bookFormat(e) || '').toUpperCase();
        const epub = fmtU === 'EPUB';
        const f = diskFile(e) || {};
        const size = Number(f.size);
        const meta = [
          Number.isFinite(size) && size > 0 ? (size / 1048576).toFixed(1) + ' MB' : null,
          epub ? 'reads in-browser' : 'opens in PDF viewer',
        ].filter(Boolean).join(' · ');
        return '<div class="ebs__file">' +
          '<span class="ebs__file-ext ebs__file-ext--' + (epub ? 'epub' : 'pdf') + '">' + fmtU + '</span>' +
          '<div class="ebs__file-main">' +
            '<div class="ebs__file-name">' + esc(f.name || '') + '</div>' +
            '<div class="ebs__file-meta">' + esc(meta) + '</div>' +
          '</div>' +
          '<button class="ebs__file-read" data-file-read="' + i + '">' +
            (epub ? (done ? 'Read again' : part ? 'Continue' : 'Read') : 'Open') + '</button>' +
          '<a class="ebs__file-dl" href="/api/ebooks/issue/' + e.id + '/file?dl=1" title="Download ' + fmtU + '">' +
            icon('download', { size: 15 }) + '</a>' +
        '</div>';
      }).join('');

      // Details grid — only fields the catalog actually has (no pages/words).
      const added = det && det.added ? new Date(det.added) : null;
      const cells = [];
      if (!standalone) cells.push(['Series', seriesTitle + ' #' + num]);
      if (standalone && ctx.series && ctx.series.year) cells.push(['Published', String(ctx.series.year)]);
      if (by) cells.push([String(by).includes(',') ? 'Authors' : 'Author', String(by)]);
      if (det && det.language) cells.push(['Language', String(det.language)]);
      if (det && det.isbn) cells.push(['ISBN', String(det.isbn)]);
      if (added && !isNaN(added)) {
        cells.push(['Added', added.toLocaleDateString(undefined, { month: 'short', year: 'numeric' })]);
      }
      const cellsHtml = cells.map(([label, value]) =>
        '<div class="ebs__cell"><div class="ebs__cell-label">' + esc(label) + '</div>' +
        '<div class="ebs__cell-value">' + esc(value) + '</div></div>').join('');

      return '<div class="ebs__sect">Files</div>' +
        '<div class="ebs__files">' + fileRows + '</div>' +
        (cellsHtml ? '<div class="ebs__sect">Details</div><div class="ebs__details">' + cellsHtml + '</div>' : '') +
        (part && hasEpub
          ? '<div class="ebs__resume">' + icon('bookmark', { size: 17 }) +
              '<div class="ebs__resume-txt">You’re ' + p + '% through</div>' +
              '<button class="ebs__resume-btn ebs-resume">Resume</button></div>'
          : '') +
        (manage
          ? '<div class="ebs__sect">Manage</div><div class="ebs__manage">' +
              '<button class="ebs__managebtn ebs-rematch"' + (busy ? ' disabled' : '') + '>' +
                icon('diamond', { size: 15 }) + ' ' + (busy ? 'Matching…' : 'Re-match metadata') + '</button></div>'
          : '');
    }

    // Handlers for everything the shared markup renders. hooks.rerender
    // repaints the owning surface after a state flip; getBusy/setBusy carry
    // the re-match in-flight flag (the sheet keeps it on the sheet object,
    // the inline view in a module flag that survives its re-renders).
    function wireBookDetail(root, b, ctx, hooks) {
      const readBtn = root.querySelector('.ebs-read');
      if (readBtn) readBtn.onclick = () => openBook(b.primary);
      for (const btn of root.querySelectorAll('[data-file-read]')) {
        btn.onclick = () => openBook(b.entries[+btn.dataset.fileRead]);
      }
      const res = root.querySelector('.ebs-resume');
      if (res) res.onclick = () => openBook(b.primary);
      const mark = root.querySelector('.ebs-mark');
      if (mark) {
        // Mark finished/unread: a fraction-only progress write (locator null
        // — "read again" starts from the beginning, which is what a manual
        // finish means). Local state flips immediately; refresh() keeps the
        // server-derived bits (shelf, row icons) honest.
        mark.onclick = async () => {
          const { done } = bookState(b);
          mark.disabled = true;
          try {
            await api.post('/api/ebooks/issue/' + b.primary.id + '/progress', { locator: null, fraction: done ? 0 : 1 });
            states[b.primary.id] = { fraction: done ? 0 : 1 };
            hooks.rerender();
            api.refreshIssueActions && api.refreshIssueActions();
            ctx.refresh();
          } catch (e) {
            api.toast('Could not update read state: ' + String((e && e.message) || e), 'error');
            mark.disabled = false;
          }
        };
      }
      const rem = root.querySelector('.ebs-rematch');
      if (rem) {
        rem.onclick = async () => {
          if (hooks.getBusy()) return;
          hooks.setBusy(true); // the button flips to "Matching…"
          await rematchBook(b.primary, ctx); // a hit refreshes the series → the surface re-syncs
          delete detailCache[b.primary.id]; // ISBN/language may have upgraded
          hooks.setBusy(false);
        };
      }
    }

    // ---------------- inline single-book detail ----------------
    // A one-book series IS its book, so the plugin area renders the detail
    // content directly — no shelf card, no second click. Core's hero above
    // already shows the cover, title, author byline and description, so this
    // starts at the progress strip and skips the hero and blurb; there's no
    // breadcrumb/prev/next/close either — this IS the page, and core's back
    // button leaves it. Re-renders on the same ticks as the shelf (core calls
    // renderBooksView again on series refresh and refreshIssueActions).
    let singleBusyId = null; // issue id with a re-match in flight; survives tick re-renders
    function renderSingleBook(container, ctx, books) {
      const b = books[0];
      const busy = singleBusyId === b.primary.id;
      const rerender = () => { if (container.isConnected) renderBooksView(container, ctx); };
      ensureDetails(b, rerender);
      container.innerHTML =
        '<div class="ebk ebk__single">' +
          progressActionsHtml(b) +
          detailSectionsHtml(b, books, ctx, busy) +
        '</div>';
      wireBookDetail(container, b, ctx, {
        rerender,
        getBusy: () => singleBusyId === b.primary.id,
        setBusy: (v) => { singleBusyId = v ? b.primary.id : null; rerender(); },
      });
    }

    // ---------------- book detail sheet ----------------
    // The overlay a shelf card opens: same fixed-overlay pattern as the
    // reading shell but a page-level dialog — a dimmed backdrop over the real
    // page and a centered sheet, stacked BELOW the reader so its Read button
    // opens the shell on top and closing the shell lands back here.
    let sheet = null;         // { el, books, idx, ctx, bookId, busy }
    let libNames = null;      // library id → name, fetched once for standalone books

    function openSheet(books, idx, ctx) {
      if (!sheet) {
        const el = document.createElement('div');
        el.className = 'ebs';
        el.setAttribute('role', 'dialog');
        el.setAttribute('aria-modal', 'true');
        el.innerHTML = '<div class="ebs__panel"></div>';
        el.addEventListener('click', (e) => { if (e.target === el) closeSheet(); });
        document.body.appendChild(el);
        sheet = { el };
        document.addEventListener('keydown', sheetKeydown);
      }
      Object.assign(sheet, { books, idx, ctx, bookId: books[idx].primary.id, busy: false });
      renderSheet();
    }

    function closeSheet() {
      if (!sheet) return;
      document.removeEventListener('keydown', sheetKeydown);
      sheet.el.remove();
      sheet = null;
    }

    function sheetKeydown(e) {
      // The reading shell stacks above the sheet and owns the keyboard while
      // open — Esc there closes the reader, never the sheet under it.
      if (!sheet || (reader && reader.el.classList.contains('is-open'))) return;
      if (e.key === 'Escape') closeSheet();
      else if (e.key === 'ArrowLeft') stepSheet(-1);
      else if (e.key === 'ArrowRight') stepSheet(1);
    }

    // Prev/next book in the shelf's order; no wrap-around (the head buttons
    // disable at the ends, so the keyboard matches them).
    function stepSheet(d) {
      if (!sheet) return;
      const at = sheet.idx + d;
      if (at < 0 || at >= sheet.books.length) return;
      sheet.idx = at;
      sheet.bookId = sheet.books[at].primary.id;
      sheet.busy = false;
      renderSheet();
      const sc = sheet.el.querySelector('.ebs__scroll');
      if (sc) sc.scrollTop = 0;
    }

    function renderSheet() {
      if (!sheet) return;
      const { books, idx, ctx } = sheet;
      const b = books[idx];
      const standalone = isStandalone(books, ctx.series);
      const seriesTitle = String((ctx.series && ctx.series.title) || '');
      const num = String(b.primary.number ?? '');

      ensureDetails(b, () => { if (sheet && sheet.bookId === b.primary.id) renderSheet(); });
      // Standalone books breadcrumb under their library's name.
      if (standalone && !libNames) {
        libNames = {};
        api.get('/api/libraries').then((r) => {
          for (const l of (r && r.libraries) || []) libNames[l.id] = l.name;
          if (sheet) renderSheet();
        }).catch(() => {});
      }
      const libName = (libNames && ctx.series && libNames[ctx.series.library_id]) || 'Books';

      const crumb = standalone
        ? libName + ' / ' + (b.primary.title || 'Untitled')
        : seriesTitle + ' / Book ' + num;
      const pos = standalone ? libName : seriesTitle + ' · Book ' + num + ' of ' + books.length;
      const by = (ctx.series && ctx.series.publisher) || '';

      // Standalone series carry the book's own description; calibre-series
      // books have no per-book blurb in the catalog, so nothing shows.
      const blurb = standalone
        ? String((ctx.series && ctx.series.description) || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
        : '';

      sheet.el.querySelector('.ebs__panel').innerHTML =
        '<div class="ebs__head"><div class="ebs__head-in">' +
          '<button class="ebs__hbtn ebs-back" title="Back to shelf" aria-label="Back to shelf">' + icon('arrow-left', { size: 16 }) + '</button>' +
          '<div class="ebs__crumb">' + esc(crumb) + '</div>' +
          '<button class="ebs__hbtn ebs-prev" title="Previous book" aria-label="Previous book"' + (idx <= 0 ? ' disabled' : '') + '>' + icon('chevron-left', { size: 15 }) + '</button>' +
          '<button class="ebs__hbtn ebs-next" title="Next book" aria-label="Next book"' + (idx >= books.length - 1 ? ' disabled' : '') + '>' + icon('chevron-right', { size: 15 }) + '</button>' +
          '<button class="ebs__hbtn ebs__hbtn--bare ebs-close" title="Close (Esc)" aria-label="Close">' + icon('close', { size: 16 }) + '</button>' +
        '</div></div>' +
        '<div class="ebs__scroll">' +
          '<div class="ebs__hero"><div class="ebs__hero-in">' +
            '<div class="ebs__cover" style="background:' + coverBg(b.primary.title, true) + '">' + icon('library', { size: 42 }) +
              '<img alt="" src="/api/ebooks/issue/' + b.primary.id + '/cover"></div>' +
            '<div class="ebs__herobody">' +
              '<div class="ebs__tagrow"><span class="ebs__tag">Book</span><span class="ebs__pos">' + esc(pos) + '</span></div>' +
              '<h2 class="ebs__title">' + esc(b.primary.title || 'Untitled') + '</h2>' +
              (by ? '<div class="ebs__author">by <b>' + esc(String(by)) + '</b></div>' : '') +
              progressActionsHtml(b) +
            '</div>' +
          '</div></div>' +
          '<div class="ebs__body"><div class="ebs__body-in">' +
            (blurb ? '<p class="ebs__blurb">' + esc(blurb) + '</p>' : '') +
            detailSectionsHtml(b, books, ctx, sheet.busy) +
          '</div></div>' +
        '</div>';

      const q = (sel) => sheet.el.querySelector(sel);
      const img = q('.ebs__cover img');
      img.addEventListener('error', () => img.remove());
      q('.ebs-back').onclick = closeSheet;
      q('.ebs-close').onclick = closeSheet;
      q('.ebs-prev').onclick = () => stepSheet(-1);
      q('.ebs-next').onclick = () => stepSheet(1);
      wireBookDetail(sheet.el, b, ctx, {
        rerender: renderSheet,
        getBusy: () => !!(sheet && sheet.busy),
        setBusy: (v) => { if (sheet) { sheet.busy = v; renderSheet(); } },
      });
    }
  });
})();
