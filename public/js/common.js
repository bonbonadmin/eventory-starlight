const idr = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 });
const formatIDR = (n) => idr.format(n);

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// Stable hue per performance id so each star gets its own colour, like the division stars.
const HUES = [275, 42, 320, 160, 210, 18, 95, 190, 345, 255];
function hueFor(id) {
  let h = 0;
  for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return HUES[h % HUES.length];
}

// Artwork for a performance: its photo if provided, otherwise a glowing star with its initial.
function artHtml(p) {
  if (p.image) return `<img class="photo" src="${escapeHtml(p.image)}" alt="" loading="lazy">`;
  const initial = escapeHtml((p.name || '?').trim().charAt(0).toUpperCase());
  return `<div class="star-wrap"><div class="star">${initial}</div></div>`;
}

function sparkles(count = 40) {
  const layer = document.createElement('div');
  layer.className = 'sparkles';
  layer.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < count; i++) {
    const s = document.createElement('i');
    s.style.left = Math.random() * 100 + '%';
    s.style.top = Math.random() * 100 + '%';
    s.style.setProperty('--d', 3 + Math.random() * 5 + 's');
    s.style.setProperty('--delay', Math.random() * 6 + 's');
    layer.appendChild(s);
  }
  document.body.prepend(layer);
}
