/* ==========================================================================
   CONFIGURAÇÃO DO SITE — este é o único arquivo que você precisa editar.
   ========================================================================== */
window.BIG4_CONFIG = {
  /**
   * Fonte das notícias:
   *   'espn'    → API pública da ESPN. Não precisa de chave e funciona em
   *               qualquer hospedagem (GitHub Pages, Vercel, localhost). ✅ Recomendado.
   *   'newsapi' → NewsAPI.org. Exige a chave abaixo.
   *
   * Se a fonte escolhida falhar, o site tenta a ESPN automaticamente e,
   * por último, o snapshot em data/news.json (gerado a cada hora pela GitHub Action).
   */
  provider: 'espn',

  /**
   * 🔑 SUA CHAVE DA NEWSAPI: cole entre as aspas (só é usada se provider = 'newsapi').
   *    Crie uma grátis em https://newsapi.org/register
   *
   * ⚠️ O plano gratuito (Developer) só aceita chamadas do navegador em
   *    http://localhost. No GitHub Pages ou na Vercel a NewsAPI recusa a chamada
   *    e o site volta para a ESPN sozinho.
   * ⚠️ Tudo neste arquivo fica público (é código front-end): qualquer visitante
   *    consegue ver a chave. Nunca coloque aqui uma chave paga ou sensível.
   */
  newsApiKey: '',

  /** Quantas notícias buscar por liga (a ESPN aceita até 50). */
  articlesPerLeague: 50,

  /** De quantos em quantos minutos o site procura novidades com a página aberta. */
  refreshIntervalMinutes: 5,

  /** Arquivo de reserva gerado por scripts/fetch-news.mjs. */
  snapshotUrl: 'data/news.json',
};
