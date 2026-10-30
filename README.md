# Big Four Breaking

Portal de notícias em tempo real das ligas **NBA, NFL, NHL e MLB**.
HTML + Tailwind CSS v4 + JavaScript puro: sem build obrigatório, sem dependências, pronto para GitHub Pages e Vercel.

- **Dados reais, sem chave:** usa a API pública da ESPN, que libera CORS e responde direto no navegador.
- **Sempre atualizado:** busca ao abrir a página, verifica novidades a cada 5 min e mostra o aviso "N notícias novas".
- **Resiliente:** se a API falhar, usa o snapshot `data/news.json`, que a GitHub Action regenera a cada hora.
- **UI:** dark mode (com tema claro opcional), Bento Grid na Home, ticker de últimas, skeletons, animações que respeitam `prefers-reduced-motion`, layout de 320px até ultrawide.

---

## Estrutura

```
website_big_four/
├── index.html                  ← estrutura da página + tema do Tailwind
├── css/styles.css              ← cores (dark/light), cores das ligas e animações
├── js/config.js                ← ⚙️ CONFIGURAÇÕES e 🔑 chave de API (opcional)
├── js/app.js                   ← busca, rotas (#/nba…), renderização e auto-refresh
├── data/news.json              ← snapshot de reserva (gerado automaticamente)
├── scripts/fetch-news.mjs      ← gera o snapshot (Node 18+)
├── .github/workflows/
│   ├── deploy-pages.yml        ← publica no GitHub Pages a cada push e a cada hora
│   └── vercel-hourly.yml       ← força rebuild na Vercel a cada hora (opcional)
├── vercel.json                 ← build da Vercel (gera o snapshot)
└── favicon.svg
```

## Rodar localmente

Dá para abrir o `index.html` direto com dois cliques e as notícias ao vivo já carregam.
Para testar também o snapshot de reserva, sirva a pasta com um servidor local:

```bash
python -m http.server 5173
```

Depois abra http://localhost:5173. (Alternativa com Node: `npx serve .`)

Para atualizar o snapshot manualmente:

```bash
node scripts/fetch-news.mjs
```

## 🔑 Onde colocar a chave de API

**A configuração padrão não precisa de chave.** A ESPN é a fonte principal.

Se quiser usar a [NewsAPI.org](https://newsapi.org/register), abra `js/config.js`:

```js
provider: 'newsapi',
newsApiKey: 'COLE_SUA_CHAVE_AQUI',
```

Limitações da NewsAPI no plano gratuito:
- Só aceita chamadas do navegador em `localhost`. No GitHub Pages ou na Vercel ela recusa a chamada e o site volta para a ESPN automaticamente.
- Tudo o que está em `js/config.js` é público. Qualquer visitante vê a chave, então nunca use uma chave paga ou sensível ali.
  (Em um gerador de sites estáticos, a chave fica protegida nos Secrets do GitHub; veja a seção de build automático.)

---

## Hospedagem gratuita

### Opção A: GitHub Pages

1. Crie um repositório no GitHub, por exemplo `big-four-breaking`. No plano gratuito, o Pages exige repositório **público**.
2. Envie o projeto:

   ```bash
   git init
   git add .
   git commit -m "Big Four Breaking"
   git branch -M main
   git remote add origin https://github.com/SEU-USUARIO/big-four-breaking.git
   git push -u origin main
   ```

3. No repositório, vá em **Settings → Pages → Build and deployment → Source** e escolha **GitHub Actions**.
4. Abra a aba **Actions**, clique em **Deploy GitHub Pages (a cada hora)** e depois em **Run workflow**. Depois disso, ele também roda sozinho a cada push e a cada hora.
5. Em 1–2 minutos o site estará em `https://SEU-USUARIO.github.io/big-four-breaking/`.

> **Opção mais simples, sem Actions:** em *Source*, escolha **Deploy from a branch → main → / (root)** e apague `.github/workflows/deploy-pages.yml`.
> As notícias continuam ao vivo no navegador; só o snapshot de reserva deixa de ser renovado.

### Opção B: Vercel

1. Envie o projeto para o GitHub (passo 2 acima).
2. Em [vercel.com](https://vercel.com), entre com o GitHub e clique em **Add New… → Project**. Escolha o repositório e clique em **Import**.
3. Não precisa mudar nada, porque o `vercel.json` já define preset *Other* e o build `node scripts/fetch-news.mjs`. Clique em **Deploy**.
4. O site fica em `https://big-four-breaking.vercel.app` (ou parecido). Cada `git push` gera um novo deploy.

Para o rebuild horário na Vercel:

1. Na Vercel: **Project → Settings → Git → Deploy Hooks**. Crie um hook (nome `hourly`, branch `main`) e copie a URL.
2. No GitHub: **Settings → Secrets and variables → Actions → New repository secret**. Use o nome `VERCEL_DEPLOY_HOOK` e cole a URL como valor.
3. Pronto: `.github/workflows/vercel-hourly.yml` chama o hook a cada hora.

> No plano Hobby (grátis), os *Cron Jobs* nativos da Vercel rodam **no máximo 1x por dia**.
> Por isso o agendamento horário fica no GitHub Actions, que apenas chama o Deploy Hook.

---

## ⏱️ Build automático a cada hora

### Como funciona neste projeto

| Peça | O que faz |
|---|---|
| `deploy-pages.yml` | `cron: '17 * * * *'`: gera o snapshot e publica no GitHub Pages a cada hora |
| `vercel-hourly.yml` | `cron: '23 * * * *'`: chama o Deploy Hook; a Vercel roda o build e gera o snapshot |
| Navegador | Busca ao vivo ao abrir a página e verifica novidades a cada 5 min |

### Se você migrar para um gerador de sites estáticos (Next.js, Astro, Eleventy…)

No modelo estático, as notícias são buscadas **durante o build**. Assim a chave de API fica nos Secrets e nunca chega ao navegador.
O workflow abaixo reconstrói e publica no GitHub Pages a cada hora:

```yaml
# .github/workflows/build-hourly.yml
name: Build estático a cada hora
on:
  push:
    branches: [main]
  schedule:
    - cron: '0 * * * *'   # toda hora cheia (UTC)
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: false

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - run: npm run build
        env:
          NEWS_API_KEY: ${{ secrets.NEWS_API_KEY }}   # lida no build (process.env.NEWS_API_KEY)
      - uses: actions/upload-pages-artifact@v5
        with:
          path: out    # Next.js com output: 'export' → out/ | Astro e Vite → dist/ | Eleventy → _site/

  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - id: deployment
        uses: actions/deploy-pages@v5
```

Na Vercel, o caminho é o mesmo de cima: Deploy Hook + `vercel-hourly.yml`.
Sem GitHub Actions, dá para usar um serviço de cron externo gratuito, como o [cron-job.org](https://cron-job.org). Agende um `POST` para a URL do Deploy Hook a cada hora.

### Cuidados com o cron do GitHub

- O horário é sempre **UTC**. O minuto 17 (`17 * * * *`) é igual em qualquer fuso.
- Em horários de pico a execução pode atrasar alguns minutos. Evitar o minuto `0` ajuda.
- Em repositórios públicos, o GitHub **desativa workflows agendados após 60 dias sem atividade** no repositório e avisa por e-mail. Para reativar, basta um commit ou clicar em *Enable workflow* na aba Actions.

---

## Personalização rápida

| O quê | Onde |
|---|---|
| Intervalo de atualização, nº de notícias, fonte | `js/config.js` |
| Cores do tema e das ligas | `css/styles.css` (topo do arquivo) |
| Fontes | `index.html` (link do Google Fonts) + bloco `@theme` |
| Tema padrão claro | `index.html`: troque `class="dark"` por `class="light"` na tag `<html>` |
| Textos e layout dos cards | `js/app.js`, seção "5. Templates" |

## Avisos

- A API da ESPN (`site.api.espn.com`) é pública, mas **não é oficial nem documentada** e pode mudar sem aviso. O site já tem reservas (snapshot e cache local) para esses casos.
- Manchetes, resumos e imagens pertencem aos autores originais; os cards levam o leitor à matéria completa na fonte.
- Projeto independente, sem afiliação com NBA, NFL, NHL, MLB ou ESPN.
- O Tailwind é carregado pelo CDN (`@tailwindcss/browser`), o que dispensa build. Se o tráfego crescer, compile o CSS com o [Tailwind CLI](https://tailwindcss.com/docs/installation/tailwind-cli) para ganhar alguns milissegundos no carregamento.
