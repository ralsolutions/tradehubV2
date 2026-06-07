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

  // d) Icon services that fetch server-side (bypass sites that block bots, e.g. 403/Cloudflare).
  candidates.push({ source: 'duckduckgo', url: `https://icons.duckduckgo.com/ip3/${domain}.ico` });
  candidates.push({ source: 'favicon', url: `https://www.google.com/s2/favicons?domain=${domain}&sz=128` });

  const best = await downloadFirstValidImage(candidates);
  if (!best) {
    // Nothing valid (site may block bots). Still hand back the name so the user only uploads a logo.
    return res.status(200).json({ ok: false, reason: 'not_found', domain, name, message: 'Could not fetch a logo (the site may block it). Upload it below.' });
  }
  return res.status(200).json({ ok: true, domain, name, bestSource: best.source, dataUrl: best.dataUrl, bytes: best.bytes });
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

function decodeEntities(str) {
  return String(str)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return _; } })
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(parseInt(n, 10)); } catch { return _; } })
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function cleanName(raw) {
  const filler = /^(home|homepage|official site|official website|welcome|index)$/i;
  const s = decodeEntities(raw).replace(/\s+/g, ' ').trim();
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

// Reject HTML/JSON error pages and confirm real image bytes (magic numbers).
function looksLikeImage(buf, type) {
  if (!buf || buf.length < 60) return false;
  const head = buf.slice(0, 16);
  const b = [...head];
  const ascii = head.toString('latin1');
  const start = buf.slice(0, 256).toString('latin1').replace(/^\s+/, '').toLowerCase();
  if (start.startsWith('<!doctype') || start.startsWith('<html') || start.startsWith('{') || start.startsWith('<head')) return false;
  if ((type && type.includes('svg')) || start.startsWith('<svg') || (start.startsWith('<?xml') && start.includes('<svg'))) return true;
  if (b[0]===0x89 && b[1]===0x50 && b[2]===0x4e && b[3]===0x47) return true; // PNG
  if (b[0]===0xff && b[1]===0xd8 && b[2]===0xff) return true;               // JPEG
  if (ascii.startsWith('GIF8')) return true;                                 // GIF
  if (ascii.startsWith('RIFF') && buf.slice(8,12).toString('latin1')==='WEBP') return true; // WEBP
  if (b[0]===0x00 && b[1]===0x00 && b[2]===0x01 && b[3]===0x00) return true; // ICO
  if (b[0]===0x42 && b[1]===0x4d) return true;                               // BMP
  return false;
}

// Try each candidate: download, validate it's a real image, return the first good one.
async function downloadFirstValidImage(candidates) {
  for (const c of candidates) {
    try {
      const img = await fetch(c.url, { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TradeHubBot/1.0)', 'Accept': 'image/avif,image/webp,image/png,image/svg+xml,image/*,*/*' } });
      if (!img.ok) continue;
      const rawType = (img.headers.get('content-type') || '').toLowerCase();
      const buf = Buffer.from(await img.arrayBuffer());
      if (buf.length > 500 * 1024) continue; // too big — try next
      if (!looksLikeImage(buf, rawType)) continue;
      let outType = rawType.split(';')[0].trim();
      if (!outType.startsWith('image/')) outType = rawType.includes('svg') ? 'image/svg+xml' : 'image/png';
      return { dataUrl: `data:${outType};base64,${buf.toString('base64')}`, source: c.source, bytes: buf.length };
    } catch (_) {}
  }
  return null;
}
