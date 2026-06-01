// api/company-logo.js
// Vercel serverless function (Node 18+). Mismo patrón que tu Label Reader.
//
// Recibe lo que el manager pega al crear/editar una empresa (URL, dominio, IG o
// LinkedIn) y devuelve la mejor imagen de logo que encuentre, YA EN BASE64,
// para que el front la guarde igual que un upload manual (localStorage).
//
// Flujo:
//   1. Normaliza el input a un dominio.
//   2. Arma candidatos en orden de "parecido a logo":
//        a) Brandfetch (si hay BRANDFETCH_CLIENT_ID)  -- mejor calidad
//        b) apple-touch-icon / link rel=icon de la home (cuadrados, nítidos)
//        c) og:image (puede ser banner, va al final)
//        d) Google favicon (siempre responde algo)
//   3. Verifica cuál carga (HEAD), descarga la mejor y la devuelve como dataUrl.
//   4. IG/LinkedIn sin dominio -> avisa que hay que subir a mano.

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { input } = req.body || {};
  if (!input || typeof input !== 'string') return res.status(400).json({ error: 'Falta "input"' });

  const parsed = resolveDomain(input.trim());

  if (parsed.kind === 'social') {
    return res.status(200).json({
      ok: false, reason: 'social_no_domain',
      message: `Detecté un perfil de ${parsed.network}. No puedo sacar el logo de ahí — pasá la web de la empresa o subilo a mano.`,
    });
  }
  if (!parsed.domain) {
    return res.status(200).json({ ok: false, reason: 'no_domain', message: 'No identifiqué un dominio válido. Subí el logo a mano.' });
  }

  const domain = parsed.domain;
  const candidates = [];

  // a) Brandfetch (opcional). Confirmá el formato exacto en tu dashboard;
  //    si está mal, el HEAD lo descarta y cae al favicon -> no rompe nada.
  const bf = process.env.BRANDFETCH_CLIENT_ID;
  if (bf) candidates.push({ source: 'brandfetch', url: `https://cdn.brandfetch.io/${domain}/w/256/h/256?c=${bf}` });

  // b/c) Scrape liviano de la home
  try {
    const html = await fetchText(`https://${domain}`, 4000);
    for (const u of extractIconsFromHtml(html, domain)) candidates.push({ source: 'site', url: u });
  } catch (_) { /* sin web o bloqueada */ }

  // d) Google favicon
  candidates.push({ source: 'favicon', url: `https://www.google.com/s2/favicons?domain=${domain}&sz=128` });

  const best = await firstWorking(candidates);
  if (!best) {
    return res.status(200).json({ ok: false, reason: 'not_found', domain, message: 'No encontré un logo. Subilo a mano.' });
  }

  // Descarga server-side (sin CORS) y devuelve base64
  try {
    const img = await fetch(best.url, { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (TradeHub logo fetcher)' } });
    const type = img.headers.get('content-type') || 'image/png';
    const buf = Buffer.from(await img.arrayBuffer());
    if (buf.length > 500 * 1024) {
      return res.status(200).json({ ok: false, reason: 'too_big', domain, bestSource: best.source, url: best.url,
        message: 'Encontré el logo pero pesa >500KB. Subí una versión más chica a mano.' });
    }
    const dataUrl = `data:${type};base64,${buf.toString('base64')}`;
    return res.status(200).json({ ok: true, domain, bestSource: best.source, dataUrl, bytes: buf.length });
  } catch (e) {
    return res.status(200).json({ ok: false, reason: 'download_failed', domain, message: 'Encontré el logo pero no pude descargarlo. Subilo a mano.' });
  }
}

// ---------- helpers ----------

function resolveDomain(raw) {
  let str = raw.toLowerCase();
  if (/instagram\.com/.test(str)) return { kind: 'social', network: 'Instagram' };
  if (/linkedin\.com/.test(str)) return { kind: 'social', network: 'LinkedIn' };
  if (!/^https?:\/\//.test(str)) str = 'https://' + str;
  try {
    const host = new URL(str).hostname.replace(/^www\./, '');
    if (/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) return { kind: 'domain', domain: host };
  } catch (_) {}
  return { kind: 'unknown', domain: null };
}

async function fetchText(url, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (TradeHub logo fetcher)' } });
    return await r.text();
  } finally { clearTimeout(t); }
}

function extractIconsFromHtml(html, domain) {
  const urls = [];
  const push = (u) => { if (u) urls.push(absolutize(u, domain)); };
  // Orden = prioridad. apple-touch-icon e icon suelen ser más "logo" que og:image.
  const apple = html.match(/<link[^>]+rel=["'][^"']*apple-touch-icon[^"']*["'][^>]+href=["']([^"']+)["']/i);
  if (apple) push(apple[1]);
  const icon = html.match(/<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]+href=["']([^"']+)["']/i);
  if (icon) push(icon[1]);
  const og = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
  if (og) push(og[1]);
  return urls;
}

function absolutize(u, domain) {
  if (/^https?:\/\//.test(u)) return u;
  if (u.startsWith('//')) return 'https:' + u;
  if (u.startsWith('/')) return `https://${domain}${u}`;
  return `https://${domain}/${u}`;
}

async function firstWorking(candidates) {
  for (const c of candidates) {
    try {
      const r = await fetch(c.url, { method: 'HEAD', redirect: 'follow' });
      const type = r.headers.get('content-type') || '';
      if (r.ok && type.startsWith('image/')) return c;
    } catch (_) {}
  }
  return candidates[0] || null;
}
