/* ==========================================================================
   Big Four Breaking — app.js
   SPA leve (rotas por hash) que busca notícias reais de NBA, NFL, NHL e MLB
   direto no navegador e renderiza a interface com classes do Tailwind.

   Fluxo de dados:
     1. Mostra na hora o último resultado salvo no navegador (se houver).
     2. Busca as notícias ao vivo (ESPN, ou NewsAPI se configurado).
     3. Se uma liga falhar: tenta a ESPN → snapshot data/news.json → dados antigos.
     4. Com a página aberta, verifica novidades a cada N minutos e avisa o usuário.
   ========================================================================== */
(() => {
  'use strict';

  // ------------------------------------------------------------------------
  // 1. Configuração e constantes
  // ------------------------------------------------------------------------
  const CONFIG = {
    provider: 'espn',
    newsApiKey: '',
    articlesPerLeague: 50,
    refreshIntervalMinutes: 5,
    snapshotUrl: 'data/news.json',
    requestTimeoutMs: 10000,
    ...(window.BIG4_CONFIG || {}),
  };

  const LEAGUES = {
    nba: { name: 'NBA', full: 'National Basketball Association', sport: 'basketball', sportPt: 'Basquete', query: '"NBA" OR "National Basketball Association"' },
    nfl: { name: 'NFL', full: 'National Football League', sport: 'football', sportPt: 'Futebol americano', query: '"NFL" OR "National Football League"' },
    nhl: { name: 'NHL', full: 'National Hockey League', sport: 'hockey', sportPt: 'Hóquei no gelo', query: '"NHL" OR "National Hockey League"' },
    mlb: { name: 'MLB', full: 'Major League Baseball', sport: 'baseball', sportPt: 'Beisebol', query: '"MLB" OR "Major League Baseball"' },
  };
  const LEAGUE_IDS = Object.keys(LEAGUES);

  const REFRESH_MS = Math.max(1, Number(CONFIG.refreshIntervalMinutes) || 5) * 60000;
  const CACHE_KEY = 'big4:cache:v1';
  const THEME_KEY = 'big4:theme';
  const CACHE_MAX_AGE = 12 * 60 * 60 * 1000; // ignora cache local com mais de 12h
  const NEW_WINDOW = 60 * 60 * 1000;         // selo "Novo" para notícias com menos de 1h
  const DEFAULT_TITLE = document.title;

  // Classes de layout compartilhadas entre a página real e o skeleton
  const BENTO_GRID = 'mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4 lg:gap-5 lg:auto-rows-[clamp(14rem,18vw,20rem)]';
  const HERO_SIZE = 'aspect-[4/5] sm:col-span-2 sm:aspect-[16/9] lg:row-span-2 lg:aspect-auto';
  const TILE_SIZE = 'aspect-[16/10] sm:aspect-[4/3] lg:aspect-auto';
  const FEED_GRID = 'grid gap-4 sm:grid-cols-2 lg:grid-cols-3 lg:gap-5 2xl:grid-cols-4 3xl:grid-cols-5';

  const state = {
    data: null,      // { leagues: { nba: Article[] … }, sources, errors, fetchedAt }
    pending: null,   // dados novos esperando o clique no aviso "N notícias novas"
    route: 'home',
    feed: [],        // lista da seção "Mais notícias" da página atual (para paginação)
    loading: false,
    failed: false,   // a última atualização falhou por completo
  };

  // ------------------------------------------------------------------------
  // 2. Utilitários
  // ------------------------------------------------------------------------
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);

  /** Aceita só URLs http(s) — evita links "javascript:" vindos de fontes externas. */
  function safeUrl(url) {
    if (!url) return '';
    try {
      const u = new URL(url, location.href);
      return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : '';
    } catch {
      return '';
    }
  }

  const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const rtf = new Intl.RelativeTimeFormat('pt-BR', { numeric: 'auto' });
  const shortDate = new Intl.DateTimeFormat('pt-BR', { day: 'numeric', month: 'short' });
  const fullDate = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'full', timeStyle: 'short' });
  const clock = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });

  /** "Agora mesmo", "Há 5 minutos", "Há 2 horas", "Ontem", "12 de out." */
  function timeAgo(ts, now = Date.now()) {
    const diff = Math.min(0, Math.round((ts - now) / 1000)); // segundos (negativo = passado)
    const abs = -diff;
    if (abs < 45) return 'Agora mesmo';
    if (abs < 3600) return capitalize(rtf.format(Math.round(diff / 60), 'minute'));
    if (abs < 86400) return capitalize(rtf.format(Math.round(diff / 3600), 'hour'));
    if (abs < 7 * 86400) return capitalize(rtf.format(Math.round(diff / 86400), 'day'));
    return shortDate.format(ts);
  }

  const byDate = (a, b) => b.published - a.published;
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  const storage = {
    get(key) {
      try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* modo privado ou cota cheia */ }
    },
  };

  async function fetchJSON(url, { headers } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONFIG.requestTimeoutMs);
    try {
      const res = await fetch(url, { headers, signal: controller.signal, cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  // ------------------------------------------------------------------------
  // 3. Fontes de notícias (providers) e normalização
  //    Todas as fontes viram o mesmo formato "Article" usado na interface.
  // ------------------------------------------------------------------------
  const ESPN_LABELS = { Story: 'Reportagem', HeadlineNews: 'Notícia', Media: 'Vídeo', Recap: 'Resumo do jogo', Preview: 'Prévia' };

  /** Prefere a foto "header" (a principal da matéria); depois a mais larga. */
  function pickEspnImage(images = []) {
    const score = (img) => (img.type === 'header' ? 1e5 : 0) + (img.width || 0);
    return images.filter((img) => img.url).sort((a, b) => score(b) - score(a))[0] || null;
  }

  function normalizeEspn(raw, league) {
    const url = safeUrl(raw.links?.web?.href);
    if (!raw.headline || !url) return null;
    const img = pickEspnImage(raw.images);
    return {
      id: `espn:${raw.id ?? url}`,
      league,
      title: raw.headline,
      summary: raw.description || '',
      image: img ? safeUrl(img.url) : '',
      imageWidth: img?.width || 0,
      credit: img?.credit || '',
      url,
      published: Date.parse(raw.published || raw.lastModified) || Date.now(),
      byline: raw.byline || '',
      kind: raw.type === 'Media' ? 'video' : 'article',
      label: ESPN_LABELS[raw.type] || 'Notícia',
      premium: Boolean(raw.premium),
      source: 'ESPN',
    };
  }

  function normalizeNewsApi(raw, league) {
    const url = safeUrl(raw.url);
    if (!raw.title || raw.title === '[Removed]' || !url) return null;
    return {
      id: `newsapi:${url}`,
      league,
      title: raw.title,
      summary: raw.description || '',
      image: safeUrl(raw.urlToImage),
      imageWidth: 0,
      credit: '',
      url,
      published: Date.parse(raw.publishedAt) || Date.now(),
      byline: raw.author || '',
      kind: 'article',
      label: 'Notícia',
      premium: false,
      source: raw.source?.name || 'NewsAPI',
    };
  }

  const PROVIDERS = {
    espn: {
      label: 'ESPN',
      async fetchLeague(id) {
        // API pública (não oficial) da ESPN — sem chave e com CORS liberado.
        const url = `https://site.api.espn.com/apis/site/v2/sports/${LEAGUES[id].sport}/${id}/news?limit=${CONFIG.articlesPerLeague}`;
        const json = await fetchJSON(url);
        return (json.articles || []).map((a) => normalizeEspn(a, id)).filter(Boolean);
      },
    },
    newsapi: {
      label: 'NewsAPI',
      async fetchLeague(id) {
        // A chave vem de js/config.js (campo newsApiKey).
        if (!CONFIG.newsApiKey) throw new Error('newsApiKey vazio em js/config.js');
        const params = new URLSearchParams({
          q: LEAGUES[id].query,
          searchIn: 'title,description',
          language: 'en',
          sortBy: 'publishedAt',
          pageSize: String(Math.min(CONFIG.articlesPerLeague, 100)),
        });
        const json = await fetchJSON(`https://newsapi.org/v2/everything?${params}`, {
          headers: { 'X-Api-Key': CONFIG.newsApiKey },
        });
        if (json.status !== 'ok') throw new Error(json.message || 'Resposta inválida da NewsAPI');
        return (json.articles || []).map((a) => normalizeNewsApi(a, id)).filter(Boolean);
      },
    },
  };

  /** Snapshot gerado por scripts/fetch-news.mjs (mesmo formato bruto da ESPN). */
  async function loadSnapshot() {
    const bust = Math.floor(Date.now() / 300000); // muda a cada 5 min para driblar cache
    const snap = await fetchJSON(`${CONFIG.snapshotUrl}?v=${bust}`);
    const leagues = {};
    for (const id of LEAGUE_IDS) {
      leagues[id] = (snap.leagues?.[id] || []).map((a) => normalizeEspn(a, id)).filter(Boolean);
    }
    return { leagues, generatedAt: Date.parse(snap.generatedAt) || null };
  }

  function dedupeSorted(list) {
    const seen = new Set();
    return list.filter((a) => !seen.has(a.id) && seen.add(a.id)).sort(byDate);
  }

  /** Busca as 4 ligas em paralelo, com a cadeia de reservas descrita no topo. */
  async function fetchAllLeagues() {
    const primary = PROVIDERS[CONFIG.provider] || PROVIDERS.espn;
    const chain = primary === PROVIDERS.espn ? [primary] : [primary, PROVIDERS.espn];
    let snapshot = null;
    const getSnapshot = () => (snapshot ??= loadSnapshot().catch((err) => {
      console.warn('[big4] snapshot indisponível:', err.message || err);
      throw err;
    }));

    const leagues = {};
    const sources = {};
    const errors = {};

    await Promise.all(LEAGUE_IDS.map(async (id) => {
      for (const provider of chain) {
        try {
          const list = await provider.fetchLeague(id);
          if (list.length) {
            leagues[id] = dedupeSorted(list);
            sources[id] = 'live';
            return;
          }
        } catch (err) {
          console.warn(`[big4] ${provider.label} falhou para ${id.toUpperCase()}:`, err.message || err);
        }
      }
      try {
        const snap = await getSnapshot();
        if (snap.leagues[id].length) {
          leagues[id] = dedupeSorted(snap.leagues[id]);
          sources[id] = 'snapshot';
          return;
        }
      } catch {
        // já registrado em getSnapshot()
      }
      // Último recurso: mantém o que já está na tela
      const previous = state.data?.leagues?.[id];
      leagues[id] = previous || [];
      sources[id] = previous?.length ? 'cache' : 'none';
      errors[id] = true;
    }));

    const snapshotAt = snapshot ? await snapshot.then((s) => s.generatedAt, () => null) : null;
    return { leagues, sources, errors, snapshotAt, fetchedAt: Date.now() };
  }

  // ------------------------------------------------------------------------
  // 4. Seleção de conteúdo (hero, bento, painéis, feed)
  // ------------------------------------------------------------------------
  function allArticles() {
    if (!state.data) return [];
    return dedupeSorted(LEAGUE_IDS.flatMap((id) => state.data.leagues[id] || []));
  }

  /** Notícia principal: a mais recente com foto grande que não seja vídeo. */
  function pickHero(list) {
    const recent = list.slice(0, 8);
    return (
      recent.find((a) => a.kind !== 'video' && a.image && a.imageWidth >= 1000) ||
      recent.find((a) => a.kind !== 'video' && a.image) ||
      list.find((a) => a.image) ||
      list[0]
    );
  }

  /** 4 destaques ao redor do hero. Na Home, tenta ter uma notícia de cada liga. */
  function pickBento(list, hero, diverse) {
    const used = new Set([hero.id]);
    const picks = [];
    const take = (a) => { if (a && !used.has(a.id)) { picks.push(a); used.add(a.id); } };
    if (diverse) LEAGUE_IDS.forEach((id) => take(list.find((a) => a.league === id && !used.has(a.id))));
    for (const a of list) {
      if (picks.length >= 4) break;
      take(a);
    }
    return picks.slice(0, 4).sort(byDate);
  }

  /** Quantos cards por "página" do feed (múltiplo do nº de colunas visível). */
  function pageSize() {
    const w = window.innerWidth;
    const cols = w >= 1920 ? 5 : w >= 1536 ? 4 : w >= 1024 ? 3 : w >= 640 ? 2 : 1;
    return Math.max(8, cols * (cols >= 4 ? 3 : 4));
  }

  // ------------------------------------------------------------------------
  // 5. Templates (HTML) — todo texto externo passa por esc()
  // ------------------------------------------------------------------------
  const ICONS = {
    arrow: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="size-4" aria-hidden="true"><path d="M7 13 13 7M8 7h5v5"/></svg>',
    play: '<svg viewBox="0 0 20 20" fill="currentColor" class="size-3.5" aria-hidden="true"><path d="M6.5 4.6v10.8a.8.8 0 0 0 1.2.7l8.6-5.4a.8.8 0 0 0 0-1.4L7.7 3.9a.8.8 0 0 0-1.2.7Z"/></svg>',
    chevron: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="size-3.5" aria-hidden="true"><path d="m8 5 5 5-5 5"/></svg>',
    down: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="size-4" aria-hidden="true"><path d="M10 5v10M5.5 10.5 10 15l4.5-4.5"/></svg>',
    signal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" class="size-6" aria-hidden="true"><path d="M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M2 9a14.5 14.5 0 0 1 20 0"/><circle cx="12" cy="19.5" r="1" fill="currentColor"/><path d="m3 3 18 18"/></svg>',
  };

  const isNew = (a) => Date.now() - a.published < NEW_WINDOW;

  function timeTag(a, cls = '') {
    return `<time datetime="${new Date(a.published).toISOString()}" data-ts="${a.published}" title="${esc(capitalize(fullDate.format(a.published)))}" class="${cls}">${timeAgo(a.published)}</time>`;
  }

  function leagueBadge(a, glass = false) {
    const { name } = LEAGUES[a.league];
    return `<a href="#/${a.league}" class="badge ${glass ? 'badge--glass' : ''} relative z-10" aria-label="Ver notícias da ${name}"><span class="dot"></span>${name}</a>`;
  }

  function chips(a, glass = false) {
    let html = '';
    if (isNew(a)) html += `<span class="chip chip--new" data-new-until="${a.published + NEW_WINDOW}"><span class="live-dot"></span>Novo</span>`;
    if (a.kind === 'video' && glass) html += `<span class="chip chip--glass">${ICONS.play}Vídeo</span>`;
    if (a.premium) html += `<span class="chip ${glass ? 'chip--glass' : ''}">ESPN+</span>`;
    return html;
  }

  function fallbackCover(league, extra = '') {
    return `<div class="cover-fallback ${extra}" aria-hidden="true"><span>${LEAGUES[league]?.name || ''}</span></div>`;
  }

  function cover(a, { eager = false, layer = '' } = {}) {
    if (!a.image) return fallbackCover(a.league, layer);
    const loading = eager ? 'fetchpriority="high"' : 'loading="lazy"';
    return `<img class="cover absolute inset-0 h-full w-full object-cover ${layer}" src="${esc(a.image)}" alt="" ${loading} decoding="async" referrerpolicy="no-referrer">`;
  }

  function titleLink(a) {
    return `<a href="${esc(a.url)}" target="_blank" rel="noopener noreferrer" class="stretched">${esc(a.title)}<span class="sr-only"> (abre em nova aba)</span></a>`;
  }

  const sectionHead = (title, id, aside = '') => `
    <div class="mb-6 flex items-end justify-between gap-4">
      <h2 id="${id}" class="flex items-center gap-3 font-display text-2xl font-extrabold tracking-tight sm:text-3xl">
        <span class="h-6 w-1.5 rounded-full bg-live" aria-hidden="true"></span>${title}
      </h2>${aside}
    </div>`;

  const statusLine = (cls) => `
    <p data-status class="${cls} flex items-center gap-2 text-xs text-muted" aria-live="polite">
      <span class="status-dot"></span><span class="status-text"></span>
    </p>`;

  function heroCard(a) {
    return `
    <article data-league="${a.league}" class="card reveal group relative isolate flex overflow-hidden rounded-3xl bg-elevated ${HERO_SIZE}" style="--i:0">
      ${cover(a, { eager: true, layer: '-z-10' })}
      <div class="scrim" aria-hidden="true"></div>
      <div class="mt-auto w-full p-5 text-white sm:p-8 xl:p-10">
        <div class="mb-4 flex flex-wrap items-center gap-2">${leagueBadge(a, true)}${chips(a, true)}</div>
        <h2 class="font-display text-[1.75rem] font-extrabold leading-[1.06] tracking-tight text-balance sm:text-4xl xl:text-5xl 3xl:text-6xl">${titleLink(a)}</h2>
        ${a.summary ? `<p class="mt-3 max-w-3xl text-sm leading-relaxed text-white/75 line-clamp-3 sm:text-base">${esc(a.summary)}</p>` : ''}
        <div class="mt-5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-white/60 sm:text-sm">
          ${timeTag(a)}
          ${a.byline ? `<span aria-hidden="true">•</span><span>${esc(a.byline)}</span>` : ''}
          ${a.credit ? `<span class="hidden xl:inline" aria-hidden="true">•</span><span class="hidden xl:inline">Foto: ${esc(a.credit)}</span>` : ''}
          <span class="ml-auto hidden items-center gap-1 font-semibold text-white/85 sm:inline-flex">Ler na ${esc(a.source)} ${ICONS.arrow}</span>
        </div>
      </div>
    </article>`;
  }

  function tileCard(a, i) {
    return `
    <article data-league="${a.league}" class="card reveal group relative isolate flex overflow-hidden rounded-3xl bg-elevated ${TILE_SIZE}" style="--i:${i}">
      ${cover(a, { layer: '-z-10' })}
      <div class="scrim" aria-hidden="true"></div>
      <div class="mt-auto w-full p-5 text-white xl:p-6">
        <div class="mb-3 flex flex-wrap items-center gap-2">${leagueBadge(a, true)}${chips(a, true)}</div>
        <h3 class="font-display text-lg font-bold leading-snug tracking-tight text-balance line-clamp-3 xl:text-xl">${titleLink(a)}</h3>
        <div class="mt-2 text-xs text-white/60">${timeTag(a)}</div>
      </div>
    </article>`;
  }

  function feedCard(a, i) {
    return `
    <article data-league="${a.league}" class="card card--panel reveal group relative flex flex-col overflow-hidden rounded-2xl border border-line bg-surface" style="--i:${i}">
      <div class="relative aspect-[16/9] overflow-hidden bg-elevated">
        ${cover(a)}
        ${a.kind === 'video' ? `<span class="play-btn" aria-hidden="true">${ICONS.play}</span>` : ''}
      </div>
      <div class="flex flex-1 flex-col p-5">
        <div class="mb-3 flex flex-wrap items-center gap-2">
          ${leagueBadge(a)}${chips(a)}
          ${timeTag(a, 'ml-auto text-xs text-subtle')}
        </div>
        <h3 class="card-title font-display text-lg font-bold leading-snug tracking-tight line-clamp-3">${titleLink(a)}</h3>
        ${a.summary ? `<p class="mt-2 text-sm leading-relaxed text-muted line-clamp-3">${esc(a.summary)}</p>` : ''}
        <div class="mt-auto flex items-center justify-between gap-3 pt-5 text-xs text-subtle">
          <span class="truncate">${esc(a.byline || a.label)}</span>
          <span class="go inline-flex shrink-0 items-center gap-1 font-semibold">${esc(a.source)} ${ICONS.arrow}</span>
        </div>
      </div>
    </article>`;
  }

  function railItem(a) {
    return `
    <li class="rail-item group relative flex gap-3 py-3 first:pt-0 last:pb-0">
      <div class="relative aspect-[4/3] w-24 shrink-0 overflow-hidden rounded-xl bg-elevated">${cover(a)}</div>
      <div class="min-w-0">
        <h3 class="rail-title text-sm font-semibold leading-snug line-clamp-3">${titleLink(a)}</h3>
        <p class="mt-1.5 text-xs text-subtle">${a.kind === 'video' ? 'Vídeo · ' : ''}${timeTag(a)}</p>
      </div>
    </li>`;
  }

  function bentoSection(hero, tiles) {
    return `
    <section aria-label="Destaques" class="${BENTO_GRID}">
      ${heroCard(hero)}
      ${tiles.map((a, i) => tileCard(a, i + 1)).join('')}
    </section>`;
  }

  function railsSection(rails) {
    const filled = rails.filter((r) => r.items.length);
    if (!filled.length) return '';
    return `
    <section class="mt-16" aria-labelledby="rails-title">
      ${sectionHead('Por liga', 'rails-title')}
      <div class="grid gap-4 sm:grid-cols-2 lg:gap-5 xl:grid-cols-4">
        ${filled.map((r, i) => `
          <div data-league="${r.id}" class="rail reveal relative overflow-hidden rounded-2xl border border-line bg-surface p-5" style="--i:${i}">
            <div class="mb-4 flex items-center justify-between gap-3">
              <a href="#/${r.id}" class="flex items-center gap-2.5 font-display text-xl font-extrabold tracking-tight"><span class="dot dot--lg"></span>${LEAGUES[r.id].name}</a>
              <a href="#/${r.id}" class="see-all inline-flex items-center gap-1 text-xs font-semibold text-muted">Ver tudo ${ICONS.chevron}</a>
            </div>
            <ol class="divide-y divide-line">${r.items.map(railItem).join('')}</ol>
          </div>`).join('')}
      </div>
    </section>`;
  }

  const feedCount = (shown, total) => `${shown} de ${total}`;

  function feedSection(list, title) {
    state.feed = list;
    if (!list.length) return '';
    const first = list.slice(0, pageSize());
    return `
    <section class="mt-16" aria-labelledby="feed-title">
      ${sectionHead(title, 'feed-title', `<span id="feed-count" class="pb-1 text-sm text-subtle">${feedCount(first.length, list.length)}</span>`)}
      <div id="feed-grid" class="${FEED_GRID}">${first.map(feedCard).join('')}</div>
      <div class="mt-10 flex justify-center">
        <button type="button" data-action="load-more" class="btn btn--ghost" ${first.length >= list.length ? 'hidden' : ''}>Carregar mais ${ICONS.down}</button>
      </div>
    </section>`;
  }

  function messageBox(title, text, retry = true) {
    return `
    <div class="reveal mx-auto mt-12 max-w-lg rounded-3xl border border-line bg-surface p-8 text-center">
      <div class="mx-auto mb-4 grid size-12 place-items-center rounded-full bg-elevated text-muted">${ICONS.signal}</div>
      <h2 class="font-display text-2xl font-bold tracking-tight">${title}</h2>
      <p class="mt-2 text-muted">${text}</p>
      ${retry ? '<button type="button" data-action="retry" class="btn mt-6">Tentar novamente</button>' : ''}
    </div>`;
  }

  // ------------------------------------------------------------------------
  // 6. Views
  // ------------------------------------------------------------------------
  function homeView() {
    const list = allArticles();
    const today = capitalize(new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date()));
    const intro = `
      <section class="reveal pt-8 sm:pt-12">
        <p class="text-xs font-semibold uppercase tracking-[0.2em] text-muted">${today}</p>
        <div class="mt-2 flex flex-wrap items-end justify-between gap-x-8 gap-y-3">
          <h1 class="font-display text-4xl font-black tracking-tight sm:text-5xl xl:text-6xl">Breaking News<span class="text-live">.</span></h1>
          <p class="max-w-md text-sm leading-relaxed text-muted sm:text-base lg:text-right">
            O essencial de <span class="font-semibold text-fg">NBA, NFL, NHL e MLB</span>, direto das fontes e atualizado em tempo real.
          </p>
        </div>
        ${statusLine('mt-3 sm:hidden')}
      </section>`;

    if (!list.length) return intro + messageBox('Sem notícias no momento', 'Não conseguimos carregar as manchetes agora. Verifique sua conexão e tente de novo.');

    const hero = pickHero(list);
    const tiles = pickBento(list, hero, true);
    const used = new Set([hero.id, ...tiles.map((a) => a.id)]);
    const rails = LEAGUE_IDS.map((id) => ({ id, items: list.filter((a) => a.league === id && !used.has(a.id)).slice(0, 4) }));
    rails.forEach((r) => r.items.forEach((a) => used.add(a.id)));

    return intro + bentoSection(hero, tiles) + railsSection(rails) + feedSection(list.filter((a) => !used.has(a.id)), 'Mais notícias');
  }

  function leagueView(id) {
    const L = LEAGUES[id];
    const list = state.data.leagues[id] || [];
    const banner = `
      <section data-league="${id}" class="league-banner reveal relative mt-6 overflow-hidden rounded-3xl border border-line px-6 py-10 sm:mt-8 sm:px-10 sm:py-14">
        <span class="watermark" aria-hidden="true">${L.name}</span>
        <p class="relative flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-muted"><span class="dot"></span>${L.sportPt} · ${L.full}</p>
        <h1 class="relative mt-3 font-display text-5xl font-black tracking-tight sm:text-7xl">${L.name}<span class="accent">.</span></h1>
        <p class="relative mt-3 max-w-xl text-sm text-muted sm:text-base">${plural(list.length, 'notícia recente', 'notícias recentes')}, atualizadas automaticamente.</p>
        ${statusLine('relative mt-4')}
      </section>`;

    if (!list.length) {
      return banner + messageBox(`Não foi possível carregar a ${L.name}`, 'A fonte de notícias não respondeu. Tente novamente em instantes.');
    }

    const hero = pickHero(list);
    const tiles = pickBento(list, hero, false);
    const used = new Set([hero.id, ...tiles.map((a) => a.id)]);
    return banner + bentoSection(hero, tiles) + feedSection(list.filter((a) => !used.has(a.id)), `Mais da ${L.name}`);
  }

  function skeletonView() {
    const card = `
      <div class="overflow-hidden rounded-2xl border border-line bg-surface">
        <div class="skeleton aspect-[16/9]"></div>
        <div class="space-y-3 p-5">
          <div class="skeleton h-5 w-16 rounded-full"></div>
          <div class="skeleton h-5 w-11/12 rounded-md"></div>
          <div class="skeleton h-5 w-3/4 rounded-md"></div>
          <div class="skeleton h-4 w-full rounded-md"></div>
        </div>
      </div>`;
    return `
      <div aria-busy="true" aria-label="Carregando notícias">
        <div class="pt-8 sm:pt-12">
          <div class="skeleton h-3 w-44 rounded-full"></div>
          <div class="skeleton mt-4 h-12 w-80 max-w-full rounded-xl"></div>
        </div>
        <div class="${BENTO_GRID}">
          <div class="skeleton rounded-3xl ${HERO_SIZE}"></div>
          ${'<div class="skeleton rounded-3xl ' + TILE_SIZE + '"></div>'.repeat(4)}
        </div>
        <div class="mt-16 ${FEED_GRID}">${card.repeat(pageSize())}</div>
      </div>`;
  }

  // ------------------------------------------------------------------------
  // 7. Renderização e pequenos componentes da interface
  // ------------------------------------------------------------------------
  const app = $('#app');

  function render({ animate = true } = {}) {
    if (!state.data) {
      app.innerHTML = skeletonView();
      return;
    }
    app.classList.toggle('no-anim', !animate);
    app.innerHTML = state.route === 'home' ? homeView() : leagueView(state.route);
    markLoadedImages(app);
    updateStatus();
  }

  function loadMore(button) {
    const grid = $('#feed-grid');
    if (!grid) return;
    const shown = grid.children.length;
    const next = state.feed.slice(shown, shown + pageSize());
    app.classList.remove('no-anim');
    grid.insertAdjacentHTML('beforeend', next.map(feedCard).join(''));
    markLoadedImages(grid);
    const total = shown + next.length;
    button.hidden = total >= state.feed.length;
    $('#feed-count').textContent = feedCount(total, state.feed.length);
  }

  function renderTicker() {
    const ticker = $('#ticker');
    const items = allArticles().slice(0, 15);
    if (!items.length) {
      ticker.hidden = true;
      return;
    }
    const html = (hidden) => items.map((a) => `
      <a href="${esc(a.url)}" target="_blank" rel="noopener noreferrer" data-league="${a.league}" class="ticker-item" ${hidden ? 'aria-hidden="true" tabindex="-1"' : ''}>
        <span class="dot"></span><strong>${LEAGUES[a.league].name}</strong><span>${esc(a.title)}</span>
      </a>`).join('');
    const track = $('#ticker-track');
    track.innerHTML = html(false) + html(true); // duas cópias = loop contínuo
    track.style.setProperty('--duration', `${Math.max(40, items.length * 7)}s`);
    ticker.hidden = false;
  }

  function updateStatus() {
    const d = state.data;
    let text = 'Carregando…';
    let mode = 'loading';
    if (d) {
      const ago = timeAgo(d.fetchedAt);
      const when = ago === 'Agora mesmo' ? 'agora' : ago.toLowerCase();
      const sources = Object.values(d.sources || {});
      if (state.failed) {
        mode = 'error';
        text = `Sem conexão · atualizado ${when}`;
      } else if (d.fromCache) {
        mode = 'stale';
        text = state.loading ? 'Atualizando…' : `Atualizado ${when}`;
      } else if (sources.some((s) => s !== 'live')) {
        mode = 'stale';
        text = d.snapshotAt ? `Modo reserva · snapshot das ${clock.format(d.snapshotAt)}` : `Modo reserva · ${when}`;
      } else {
        mode = 'live';
        text = `Ao vivo · atualizado ${when}`;
      }
    }
    $$('[data-status]').forEach((el) => {
      el.dataset.state = mode;
      $('.status-text', el).textContent = text;
    });
  }

  /** Atualiza "Há X minutos" e remove selos "Novo" vencidos, sem re-renderizar. */
  function tick() {
    const now = Date.now();
    $$('time[data-ts]').forEach((el) => { el.textContent = timeAgo(Number(el.dataset.ts), now); });
    $$('[data-new-until]').forEach((el) => { if (now > Number(el.dataset.newUntil)) el.remove(); });
    updateStatus();
  }

  function markLoadedImages(root) {
    $$('img.cover:not(.is-loaded)', root).forEach((img) => {
      if (img.complete && img.naturalWidth) img.classList.add('is-loaded');
    });
  }

  let toastTimer;
  function toast(message) {
    const el = $('#toast');
    el.textContent = message;
    el.dataset.show = 'true';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.dataset.show = 'false'; }, 3500);
  }

  function showNewPill(count) {
    const pill = $('#new-pill');
    $('span', pill).textContent = plural(count, 'notícia nova', 'notícias novas');
    pill.dataset.show = 'true';
  }

  function hideNewPill() {
    $('#new-pill').dataset.show = 'false';
  }

  // ------------------------------------------------------------------------
  // 8. Carregamento e atualização automática
  // ------------------------------------------------------------------------
  const totalArticles = (d) => LEAGUE_IDS.reduce((n, id) => n + (d.leagues[id]?.length || 0), 0);
  const gotFreshData = (d) => Object.values(d.sources).some((s) => s === 'live' || s === 'snapshot');

  function countNew(prev, next) {
    const known = new Set(LEAGUE_IDS.flatMap((id) => (prev.leagues[id] || []).map((a) => a.id)));
    return new Set(LEAGUE_IDS.flatMap((id) => next.leagues[id].map((a) => a.id).filter((x) => !known.has(x)))).size;
  }

  function applyData(data, { animate = true, scrollTop = false } = {}) {
    state.data = data;
    state.pending = null;
    hideNewPill();
    render({ animate });
    renderTicker();
    if (scrollTop) window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /**
   * mode: 'initial'    → primeira busca ao abrir a página
   *       'background' → checagem periódica (mostra aviso se houver novidades)
   *       'manual'     → botão de atualizar
   */
  async function refresh(mode = 'background') {
    if (state.loading) return;
    state.loading = true;
    $('#refresh-btn').classList.add('is-spinning');
    updateStatus();

    try {
      const next = await fetchAllLeagues();

      if (!gotFreshData(next)) {
        // Nenhuma fonte respondeu: mantém a tela como está e sinaliza o erro
        state.failed = true;
        if (!state.data) {
          state.data = { ...next };
          render();
        } else if (mode === 'manual') {
          toast('Não foi possível atualizar agora. Tente de novo em instantes.');
        }
        return;
      }

      state.failed = false;
      storage.set(CACHE_KEY, { leagues: next.leagues, fetchedAt: next.fetchedAt });

      if (!state.data || !totalArticles(state.data)) {
        applyData(next);
        return;
      }

      const fresh = countNew(state.data, next);
      if (fresh === 0) {
        // Nada novo: só atualiza os metadados, sem mexer na tela
        Object.assign(state.data, { fetchedAt: next.fetchedAt, sources: next.sources, errors: next.errors, snapshotAt: next.snapshotAt, fromCache: false });
        if (mode === 'manual') toast('Tudo em dia: nenhuma notícia nova por enquanto.');
      } else if (mode === 'manual') {
        applyData(next, { scrollTop: true });
        toast(`${plural(fresh, 'notícia nova carregada', 'notícias novas carregadas')}.`);
      } else if (mode === 'initial' && window.scrollY < 120) {
        applyData(next, { animate: false }); // troca o cache pelos dados ao vivo sem "piscar"
      } else {
        state.pending = next;
        state.data.fromCache = false;
        showNewPill(fresh);
      }
    } catch (err) {
      console.error('[big4] erro inesperado ao atualizar:', err);
    } finally {
      state.loading = false;
      $('#refresh-btn').classList.remove('is-spinning');
      updateStatus();
    }
  }

  // ------------------------------------------------------------------------
  // 9. Rotas, navegação e tema
  // ------------------------------------------------------------------------
  function parseRoute() {
    const slug = location.hash.replace(/^#\/?/, '').split(/[/?]/)[0].toLowerCase();
    return LEAGUES[slug] ? slug : 'home';
  }

  function moveNavIndicator() {
    const active = $('.nav-link[aria-current="page"]');
    const indicator = $('#nav-indicator');
    if (!active) return;
    Object.assign(indicator.style, {
      width: `${active.offsetWidth}px`,
      height: `${active.offsetHeight}px`,
      transform: `translate(${active.offsetLeft}px, ${active.offsetTop}px)`,
    });
    if (active.dataset.league) indicator.dataset.league = active.dataset.league;
    else delete indicator.dataset.league;
  }

  function updateNav() {
    $$('.nav-link').forEach((link) => {
      if (link.dataset.route === state.route) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
    moveNavIndicator();
    const active = $('.nav-link[aria-current="page"]');
    const track = $('#nav-track');
    if (active && track.scrollWidth > track.clientWidth) {
      track.scrollTo({ left: active.offsetLeft - (track.clientWidth - active.offsetWidth) / 2, behavior: 'smooth' });
    }
    const ambient = $('#ambient');
    if (state.route === 'home') delete ambient.dataset.league;
    else ambient.dataset.league = state.route;
    document.title = state.route === 'home' ? DEFAULT_TITLE : `${LEAGUES[state.route].name} · Big Four Breaking`;
  }

  function onHashChange() {
    // Âncoras internas (ex.: o link "Pular para o conteúdo") não são rotas
    if (location.hash && !location.hash.startsWith('#/')) return;
    const next = parseRoute();
    if (next === state.route) return;
    state.route = next;
    updateNav();
    render();
    window.scrollTo({ top: 0, behavior: 'instant' });
  }

  function setTheme(mode) {
    const root = document.documentElement;
    root.classList.toggle('light', mode === 'light');
    root.classList.toggle('dark', mode !== 'light');
    $('meta[name="theme-color"]').setAttribute('content', mode === 'light' ? '#f4f5f8' : '#07080c');
    $('#theme-btn').setAttribute('aria-label', mode === 'light' ? 'Ativar modo escuro' : 'Ativar modo claro');
  }

  function toggleTheme() {
    const next = document.documentElement.classList.contains('light') ? 'dark' : 'light';
    try { localStorage.setItem(THEME_KEY, next); } catch { /* sem persistência */ }
    // View Transitions faz um cross-fade suave onde o navegador suporta
    if (document.startViewTransition && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      document.startViewTransition(() => setTheme(next));
    } else {
      setTheme(next);
    }
  }

  // ------------------------------------------------------------------------
  // 10. Eventos e inicialização
  // ------------------------------------------------------------------------
  function bindEvents() {
    window.addEventListener('hashchange', onHashChange);

    document.addEventListener('click', (e) => {
      const target = e.target.closest('[data-action], #new-pill, #refresh-btn, #theme-btn, #skip-link');
      if (!target) return;
      if (target.id === 'skip-link') {
        e.preventDefault();
        app.focus({ preventScroll: true });
        app.scrollIntoView({ behavior: 'smooth' });
      } else if (target.id === 'new-pill' && state.pending) {
        applyData(state.pending, { scrollTop: true });
      } else if (target.id === 'refresh-btn') {
        refresh('manual');
      } else if (target.id === 'theme-btn') {
        toggleTheme();
      } else if (target.dataset.action === 'load-more') {
        loadMore(target);
      } else if (target.dataset.action === 'retry') {
        refresh('manual');
      }
    });

    // Fade-in das capas quando carregam; capa reserva quando falham
    document.addEventListener('load', (e) => {
      if (e.target.matches?.('img.cover')) e.target.classList.add('is-loaded');
    }, true);
    document.addEventListener('error', (e) => {
      const img = e.target;
      if (!(img instanceof HTMLImageElement) || !img.classList.contains('cover')) return;
      const league = img.closest('[data-league]')?.dataset.league;
      img.insertAdjacentHTML('afterend', fallbackCover(league, img.classList.contains('-z-10') ? '-z-10' : ''));
      img.remove();
    }, true);

    // Altura do cabeçalho (o aviso de novidades fica logo abaixo dele)
    const header = $('#site-header');
    new ResizeObserver(() => {
      document.documentElement.style.setProperty('--header-h', `${header.offsetHeight}px`);
      moveNavIndicator();
    }).observe(header);
    document.fonts?.ready.then(moveNavIndicator);

    // Ao voltar para a aba depois de um tempo, procura novidades
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible' || !state.data) return;
      if (Date.now() - state.data.fetchedAt > REFRESH_MS) refresh('background');
    });
    window.addEventListener('online', () => refresh('background'));
  }

  function init() {
    setTheme(document.documentElement.classList.contains('light') ? 'light' : 'dark');
    bindEvents();
    if (location.hash && !location.hash.startsWith('#/')) history.replaceState(null, '', location.pathname + location.search);
    state.route = parseRoute();
    updateNav();
    requestAnimationFrame(() => $('#nav-indicator').classList.remove('no-transition'));

    // Mostra o último resultado salvo enquanto busca o novo (stale-while-revalidate)
    const cached = storage.get(CACHE_KEY);
    const cacheOk = cached?.leagues && Date.now() - cached.fetchedAt < CACHE_MAX_AGE
      && LEAGUE_IDS.every((id) => Array.isArray(cached.leagues[id]));
    if (cacheOk) {
      state.data = { leagues: cached.leagues, fetchedAt: cached.fetchedAt, sources: {}, errors: {}, fromCache: true };
      render();
      renderTicker();
    } else {
      render(); // skeleton
    }

    refresh('initial');
    setInterval(() => refresh('background'), REFRESH_MS);
    setInterval(tick, 30000);
  }

  init();
})();
