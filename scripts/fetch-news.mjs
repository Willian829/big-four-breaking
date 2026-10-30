#!/usr/bin/env node
/**
 * Gera data/news.json: um "snapshot" das notícias das 4 ligas.
 *
 * O site sempre busca as notícias ao vivo no navegador; este arquivo é a
 * reserva caso a API não responda. Ele é atualizado:
 *   - na GitHub Action horária (.github/workflows/deploy-pages.yml)
 *   - no build da Vercel (vercel.json → buildCommand)
 *   - manualmente: `node scripts/fetch-news.mjs`
 *
 * Requer Node 18+ (fetch nativo). Sem dependências.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'data/news.json');
const LIMIT = 50;
const LEAGUES = { nba: 'basketball', nfl: 'football', nhl: 'hockey', mlb: 'baseball' };

/** Mantém só os campos que o front-end usa (o arquivo fica bem menor). */
const slim = (a) => ({
  id: a.id,
  type: a.type,
  headline: a.headline,
  description: a.description,
  published: a.published,
  byline: a.byline,
  premium: a.premium,
  links: { web: { href: a.links?.web?.href } },
  images: (a.images || [])
    .filter((img) => img.url)
    .map(({ type, width, height, url, credit }) => ({ type, width, height, url, credit })),
});

async function fetchLeague(id, sport) {
  const url = `https://site.api.espn.com/apis/site/v2/sports/${sport}/${id}/news?limit=${LIMIT}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  return (json.articles || []).map(slim);
}

const previous = await readFile(OUT, 'utf8').then(JSON.parse).catch(() => null);
const leagues = {};
let ok = 0;

for (const [id, sport] of Object.entries(LEAGUES)) {
  try {
    leagues[id] = await fetchLeague(id, sport);
    ok++;
    console.log(`✔ ${id.toUpperCase()}: ${leagues[id].length} notícias`);
  } catch (err) {
    leagues[id] = previous?.leagues?.[id] ?? [];
    console.warn(`✖ ${id.toUpperCase()}: ${err.message} (mantendo os dados anteriores)`);
  }
}

if (!ok) {
  // Sem nenhuma liga: não sobrescreve o arquivo. Só falha o build se não houver snapshot algum.
  console.error('Nenhuma liga respondeu.');
  process.exit(previous ? 0 : 1);
}

if (previous && JSON.stringify(previous.leagues) === JSON.stringify(leagues)) {
  console.log('Sem novidades: data/news.json mantido.');
} else {
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, `${JSON.stringify({ generatedAt: new Date().toISOString(), source: 'espn', leagues })}\n`);
  console.log(`Snapshot salvo em ${OUT}`);
}
