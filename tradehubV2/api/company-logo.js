// api/company-logo.js
// Vercel serverless function (Node 18+).
//
// Takes a company website (URL or domain) and returns:
//   - a suggested company name (from og:site_name / <title> / the domain), and
//   - the best logo found, ALREADY AS BASE64 (dataUrl), so the front-end
//     stores it just like a manual upload (localStorage).
//
// Flow:
//   1. Normalize the input to a domain.
//   2. Fetch the home page once, then from that HTML pull:
//        - a suggested company name
//        - candidate icon URLs (apple-touch-icon, link rel=icon, og:image)
//   3. Build logo candidates in "most logo-like" order and pick the first
//      that actually loads.
//   4. Download the best one and return it as a dataUrl.
//   5. Even if no logo is found, still return the suggested name.

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { input } = req.body || {};
  if (!input || typeof input !== 'string') return res.status(400).json({ error: 'Missing "input"' });

  const parsed = resolveDomain(input.trim());

  if (parsed.kind === 'social') {
    return res.status(200).json({
      ok: false, reason: 'social_link',
      message: 'Please paste the company website (e.g. company.co.nz), not a social media link.',
    });
  }
  if (!parsed.domain) {
    return res.status(200).json({ ok: false, reason: 'no_domain', message: 'Could not read a valid website. Try the domain (e.g. company.co.nz) or upload the logo below.' });
  }

  const domain = parsed.domain;

  // Always have a name fallback derived from the domain itself.
  let name = nameFromDomain(domain);
  const candidates = [];

  // a) Brandfetch (optional). If the URL format is wrong, the HEAD check drops
  //    it and we fall back to favicon -> no breakage.
  const bf = process.env.BRANDFETCH_CLIENT_ID;
  if (bf) candidates.push({ source: 'brandfetch', url: `https://cdn.brandfetch.io/${domain}/w/256/h/256?c=${bf}` });

  // b/c) Lightweight scrape of the home page: name + icons.
  try {
    const html = await fetchText(`https://${domain}`, 4000);
    const scrapedName = extractName(html);
    if (scrapedName) name = scrapedName;
    for (const u of extractIconsFromHtml(html, domain)) candidates.push({ source: 'site', url: u });
  } catch (_) { /* no website or blocked -- keep the domain-based name */ }

  // d) Google favicon (always returns something)
  candidates.push({ source: 'favicon', url: `https://www.google.com/s2/favicons?domain=${domain}&sz=128` });

  const best = await firstWorking(candidates);
  if (!best) {
    // No logo, but we can still hand back the name.
    return res.status(200).json({ ok: false, reason: 'not_found', domain, name, message: 'No logo found. Upload it below.' });
  }

  // Server-side download (no CORS) and return base64
  try {
    const img = await fetch(best.url, { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (TradeHub logo fetcher)' } });
    const type = img.headers.get('content-type') || 'image/png';
    const buf = Buffer.from(await img.arrayBuffer());
    if (buf.length > 500 * 1024) {
      return res.status(200).json({ ok: false, reason: 'too_big', domain, name, bestSource: best.source, url: best.url,
        message: 'Found the logo but it is >500KB. Upload a smaller version below.' });
    }
    const dataUrl = `data:${type};base64,${buf.toString('base64')}`;
    return res.status(200).json({ ok: true, domain, name, bestSource: best.source, dataUrl, bytes: buf.length });
  } catch (e) {
    return res.status(200).json({ ok: false, reason: 'download_failed', domain, name, message: 'Found the logo but could not download it. Upload it below.' });
  }
}

// ---------- helpers ----------

function resolveDomain(raw) {
  let str = raw.toLowerCase();
  // Guard: a social link can't give us the company logo, so ask for the website.
  if (/(instagram|linkedin|facebook|twitter|x\.com|tiktok)\./.test(str)) return { kind: 'social' };
  if (!/^https?:\/\//.test(str)) str = 'https://' + str;
  try {
    const host = new URL(str).hostname.replace(/^www\./, '');
    if (/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) return { kind: 'domain', domain: host };
  } catch (_) {}
  return { kind: 'unknown', domain: null };
}

// "geovert.com" -> "Geovert" ; "my-company.co.nz" -> "My Company"
function nameFromDomain(domain) {
  const label = domain.split('.')[0] || domain;
  return label
    .replace(/[-_]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function extractName(html) {
  // 1) og:site_name is the cleanest signal.
  let m = html.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i);
  if (m && m[1].trim()) return cleanName(m[1]);
  // 2) application-name
  m = html.match(/<meta[^>]+name=["']application-name["'][^>]+content=["']([^"']+)["']/i);
  if (m && m[1].trim()) return cleanName(m[1]);
  // 3) <title>, trimmed to the brand portion.
  m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (m && m[1].trim()) return cleanName(m[1]);
  return null;
}

function cleanName(raw) {
  const filler = /^(home|homepage|official site|official website|welcome|index)$/i;
  const s = raw.replace(/\s+/g, ' ').trim();
  // Titles are usually "Brand | Tagline" or "Home - Brand". Split on common
  // separators, drop pure-filler chunks, then take the first real one.
  const chunks = s.split(/\s*[|\u2013\u2014\-:\u00b7]\s*/).map(c => c.trim()).filter(Boolean);
  const real = chunks.filter(c => !filler.test(c));
  return (real[0] || chunks[0] || s);
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
