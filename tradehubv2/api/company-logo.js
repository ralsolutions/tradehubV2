// api/company-logo.js
// Vercel serverless function (Node 18+). Mismo patrón que tu Label Reader.
//
// Takes whatever the manager pastes when creating/editing a company (URL, domain,
// IG or LinkedIn) and returns the best logo image found, ALREADY AS BASE64,
// so the front-end stores it just like a manual upload (localStorage).
//
// Flow:
//   1. Normalize the input to a domain.
//   2. Build candidates in "most logo-like" order:
//        a) Brandfetch (if BRANDFETCH_CLIENT_ID is set)  -- best quality
//        b) apple-touch-icon / link rel=icon from the home page (square, sharp)
//        c) og:image (may be a banner, goes last)
//        d) Google favicon (always returns something)
//   3. Check which one loads (HEAD), download the best and return it as dataUrl.
//   4. IG/LinkedIn with no domain -> tells the user to upload manually.

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { input } = req.body || {};
  if (!input || typeof input !== 'string') return res.status(400).json({ error: 'Falta "input"' });

  const parsed = resolveDomain(input.trim());

  if (parsed.kind === 'social') {
    return res.status(200).json({
      ok: false, reason: 'social_no_domain',
      message: `${parsed.network} won't work for the logo. Try the company website (e.g. company.co.nz) or upload the logo photo below.`,
    });
  }
  if (!parsed.domain) {
    return res.status(200).json({ ok: false, reason: 'no_domain', message: 'Could not read a valid website. Try the domain (e.g. company.co.nz) or upload the logo photo below.' });
  }

  const domain = parsed.domain;
  const candidates = [];

  // a) Brandfetch (optional). Confirm the exact URL format in your dashboard;
  //    if wrong, the HEAD check drops it and falls back to favicon -> no breakage.
  const bf = process.env.BRANDFETCH_CLIENT_ID;
  if (bf) candidates.push({ source: 'brandfetch', url: `https://cdn.brandfetch.io/${domain}/w/256/h/256?c=${bf}` });

  // b/c) Lightweight scrape of the home page
  try {
    const html = await fetchText(`https://${domain}`, 4000);
    for (const u of extractIconsFromHtml(html, domain)) candidates.push({ source: 'site', url: u });
  } catch (_) { /* no website or blocked */ }

  // d) Google favicon
  candidates.push({ source: 'favicon', url: `https://www.google.com/s2/favicons?domain=${domain}&sz=128` });

  const best = await firstWorking(candidates);
  if (!best) {
    return res.status(200).json({ ok: false, reason: 'not_found', domain, message: 'No logo found. Upload it manually below.' });
  }

  // Server-side download (no CORS) and return base64
  try {
    const img = await fetch(best.url, { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (TradeHub logo fetcher)' } });
    const type = img.headers.get('content-type') || 'image/png';
    const buf = Buffer.from(await img.arrayBuffer());
    if (buf.length > 500 * 1024) {
      return res.status(200).json({ ok: false, reason: 'too_big', domain, bestSource: best.source, url: best.url,
        message: 'Found the logo but it is >500KB. Upload a smaller version below.' });
    }
    const dataUrl = `data:${type};base64,${buf.toString('base64')}`;
    return res.status(200).json({ ok: true, domain, bestSource: best.source, dataUrl, bytes: buf.length });
  } catch (e) {
    return res.status(200).json({ ok: false, reason: 'download_failed', domain, message: 'Found the logo but could not download it. Upload it manually below.' });
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
  // Order = priority. apple-touch-icon and icon are usually more "logo" than og:image.
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
