const idr = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 });
const formatIDR = (n) => idr.format(n);
const formatVotes = (n) => `${Number(n).toLocaleString('id-ID')} suara`;

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// API-nya jawab dalam bahasa Inggris; pengunjung bacanya bahasa Indonesia.
const MESSAGES = [
  [/valid performance|performance not found/i, 'Penampil tidak ditemukan atau sudah tidak dapat dipilih.'],
  [/order not found/i, 'Pesanan tidak ditemukan.'],
  [/whole number between (\d+) and (\d+)/i, (m) => `Jumlah suara harus berupa angka bulat antara ${m[1]} dan ${m[2]}.`],
  // Pesan dari backend Eventory yang baru (checkout berkunci & Virtual Account).
  [/valid checkout key/i, 'Kunci pembayaran tidak valid. Muat ulang halaman, lalu coba lagi.'],
  [/checkout is currently unavailable/i, 'Pembayaran suara sedang tidak tersedia.'],
  [/checkout was opened for (\d+) vote/i, (m) => `Pembayaran ini sudah dibuka untuk ${m[1]} suara. Gunakan jumlah yang sama untuk melanjutkan.`],
  [/valid email/i, 'Format email tidak valid. Kosongkan jika tidak diperlukan.'],
  [/available payment method/i, 'Pilih metode pembayaran yang tersedia.'],
  [/different payment method/i, 'Pembayaran ini memakai metode lain. Lanjutkan pembayaran sebelumnya.'],
  [/phone number registered with OVO/i, 'Masukkan nomor Indonesia yang terdaftar di OVO.'],
  [/too many requests/i, 'Terlalu banyak percobaan. Mohon tunggu sebentar, lalu coba lagi.'],
  [/could not start payment/i, 'Pembayaran gagal dimulai. Silakan coba lagi.'],
];
// Pesan validasi yang spesifik dulu; selain itu lihat status HTTP-nya.
function translateError(message, status) {
  for (const [pattern, text] of MESSAGES) {
    const m = String(message).match(pattern);
    if (m) return typeof text === 'function' ? text(m) : text;
  }
  if (status === 429) return 'Terlalu banyak percobaan. Mohon tunggu sebentar, lalu coba lagi.';
  if (status === 404) return 'Data tidak ditemukan.';
  if (status === 400) return 'Data yang dikirim tidak valid. Periksa kembali isian Anda.';
  if (status >= 500) return 'Server sedang bermasalah. Silakan coba beberapa saat lagi.';
  return 'Terjadi kesalahan. Silakan coba lagi.';
}

async function api(path, options = {}) {
  // Request yang nggantung (sinyal jelek di venue) jangan sampai bikin halaman
  // nunggu selamanya, mis. nyangkut di "Menyiapkan pembayaran…".
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  let res, data;
  try {
    res = await fetch(path, {
      ...options,
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    });
    data = await res.json().catch((e) => { if (e.name === 'AbortError') throw e; return {}; });
  } catch (e) {
    throw new Error(e.name === 'AbortError'
      ? 'Koneksi terlalu lambat. Periksa jaringan Anda, lalu coba lagi.'
      : 'Koneksi terputus. Periksa jaringan Anda, lalu coba lagi.');
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const err = new Error(translateError(data.error || '', res.status));
    err.status = res.status;
    throw err;
  }
  return data;
}

// Tombol "Bagikan" (markup-nya di vote.html / status.html): di HP pakai lembar
// share bawaan, selain itu link penampilnya disalin.
function setupShare(btn, getPerformer) {
  const label = btn.querySelector('.share-label');
  const arrow = btn.querySelector('.share-arrow');
  const tick = btn.querySelector('.share-tick');
  const sheet = typeof navigator.share === 'function' && matchMedia('(pointer: coarse)').matches;
  let timer;
  const copied = (on) => {
    label.textContent = on ? 'Tautan disalin' : 'Bagikan';
    arrow.style.display = on ? 'none' : '';
    tick.style.display = on ? '' : 'none';
  };
  btn.addEventListener('click', async () => {
    const p = getPerformer();
    if (!p) return;
    const url = `${location.origin}/vote?id=${encodeURIComponent(p.id)}`;
    if (sheet) {
      try { await navigator.share({ title: `Dukung ${p.name} · Starlight UMN 2026`, url }); } catch { /* dibatalin orangnya */ }
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      copied(true);
      clearTimeout(timer);
      timer = setTimeout(() => copied(false), 2200);
    } catch {
      window.prompt('Salin tautan penampil ini:', url);
    }
  });
}

// Foto penampil, atau placeholder kalem kalau nggak ada (atau gagal dimuat).
function coverHtml(p) {
  return p.image
    ? `<img src="${escapeHtml(p.image)}" alt="" loading="lazy" onerror="this.parentNode.classList.add('broken');this.remove()">`
    : '<span class="no-photo">Tanpa foto</span>';
}

// Lukisan berbingkai: foto di lubang bingkai emas Starlight, bingkainya
// ditumpuk di atas (gayanya di .plate). `big` = bingkai ukuran penuh buat
// poster di halaman beli.
const FRAME = { small: '/assets/starlight/bingkai-540.webp', big: '/assets/starlight/bingkai.webp' };
function plateHtml(p, big) {
  return `<span class="photo">${coverHtml(p)}</span>`
    + `<img class="frame" src="${big ? FRAME.big : FRAME.small}" alt="" aria-hidden="true" width="780" height="1040"${big ? '' : ' loading="lazy"'}>`;
}
