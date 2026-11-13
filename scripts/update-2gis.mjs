// Обновляет reviews.json данными из официального API 2ГИС (Places API, catalog.api.2gis.com).
// Ключ берётся из переменной окружения GIS_KEY (секрет репозитория на GitHub).
// Запуск: GIS_KEY=... node scripts/update-2gis.mjs [reviews.json]
import { readFile, writeFile } from 'node:fs/promises';

const OUT = process.argv[2] || 'reviews.json';
const KEY = process.env.GIS_KEY;
const API = 'https://catalog.api.2gis.com/3.0';
// Сети по городам: org_id из ссылок вида 2gis.kz/<город>/branches/<org_id>.
// Для города без известного org_id указываем одну кофейню (firm) — org_id узнаем из неё.
const CITIES = [
  { name: 'Павлодар', slug: 'pavlodar', org: '70000001030973689', firm: '70000001030973690' },
  { name: 'Астана', slug: 'astana', org: '70000001019143867' },
  { name: 'Тараз', slug: 'taraz', firm: '70000001055154589' },
];
const FIELDS = [
  'items.reviews', 'items.address', 'items.schedule', 'items.point', 'items.org', 'items.contact_groups',
].join(',');

if (!KEY) {
  console.log('GIS_KEY не задан — пропускаю обновление. Добавьте секрет GIS_KEY в настройках репозитория.');
  process.exit(0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(path, params) {
  const q = new URLSearchParams({ ...params, key: KEY, locale: 'ru_KZ' });
  const url = `${API}/${path}?${q}`;
  for (let i = 0; i < 3; i++) {
    const res = await fetch(url);
    const body = await res.json().catch(() => ({}));
    const code = body.meta && body.meta.code;
    if (res.ok && (code === 200 || code === 404)) return body;
    const msg = (body.meta && body.meta.error && body.meta.error.message) || res.status;
    if (res.status === 403 || code === 403 || code === 400) throw new Error(`2ГИС: ${msg}`);
    if (i === 2) throw new Error(`2ГИС: ${msg}`);
    await sleep(1500 * (i + 1));
  }
}

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
function hours(s) {
  if (!s) return '';
  if (s.is_24x7) return 'круглосуточно';
  const spans = DAYS.map((d) => s[d] && s[d].working_hours && s[d].working_hours.map((h) => `${h.from}–${h.to === '00:00' ? '24:00' : h.to}`).join(', '));
  if (spans.every((x) => x && x === spans[0])) return `ежедневно ${spans[0]}`;
  return '';
}
function phone(item) {
  for (const g of item.contact_groups || []) for (const c of g.contacts || []) if (c.type === 'phone') return c.text || c.value;
  return '';
}

async function branchesOf(city) {
  let org = city.org;
  if (!org && city.firm) {
    const one = await api('items/byid', { id: city.firm, fields: 'items.org' });
    org = one.result && one.result.items[0] && one.result.items[0].org && one.result.items[0].org.id;
  }
  const items = [];
  if (org) {
    for (let page = 1; page <= 5; page++) {
      const r = await api('items', { org_id: org, fields: FIELDS, page_size: '50', page: String(page) });
      const got = (r.result && r.result.items) || [];
      items.push(...got);
      if (!r.result || items.length >= r.result.total || !got.length) break;
      await sleep(300);
    }
  }
  if (!items.length && city.firm) {
    const r = await api('items/byid', { id: city.firm, fields: FIELDS });
    items.push(...((r.result && r.result.items) || []));
  }
  if (items[0]) console.log(`${city.name}: org ${org}, поля ответа:`, Object.keys(items[0]).join(','), '| reviews:', JSON.stringify(items[0].reviews || null).slice(0, 300));
  return { org, items };
}

async function main() {
  const cities = [];
  const flat = [];
  let reviews = [];
  for (const c of CITIES) {
    try {
      const { org, items } = await branchesOf(c);
      const list = items.map((it) => {
        const rv = it.reviews || {};
        const rating = Number(rv.general_rating ?? rv.org_rating) || null;
        const count = Number(rv.general_review_count ?? rv.org_review_count) || 0;
        // Если API отдаёт тексты отзывов — забираем их тоже.
        for (const r of rv.items || rv.reviews || []) {
          if (r && r.text) reviews.push({
            id: String(r.id || ''), name: (r.user && r.user.name) || r.user_name || 'Гость', date: r.date_created || r.date || '',
            rating: Number(r.rating) || null, text: String(r.text).trim(), branch: it.address_name || '', branchId: it.id.split('_')[0],
            city: c.name, citySlug: c.slug,
          });
        }
        const b = {
          id: it.id.split('_')[0], name: it.name, address: it.address_name || '', comment: it.address_comment || '',
          rating, count, hours: hours(it.schedule), phone: phone(it),
        };
        flat.push(b);
        return b;
      }).sort((a, b) => a.address.localeCompare(b.address, 'ru'));
      cities.push({ name: c.name, slug: c.slug, org: org || null, branches: list });
      console.log(`${c.name}: ${list.length} кофеен`);
    } catch (e) {
      console.warn(`${c.name}: ${e.message}`);
      if (/key|ключ|Authorization/i.test(e.message)) throw e;
    }
    await sleep(400);
  }
  if (!flat.length) throw new Error('2ГИС не вернул ни одной кофейни — оставляю прежний файл');

  const rated = flat.filter((b) => b.rating && b.count);
  const count = rated.reduce((s, b) => s + b.count, 0);
  const rating = count ? Math.round((rated.reduce((s, b) => s + b.rating * b.count, 0) / count) * 10) / 10 : null;
  reviews.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  reviews = reviews.slice(0, 60);

  const out = { source: '2ГИС', rating, count, cities, branches: flat, reviews };
  let prev = null;
  try { prev = JSON.parse(await readFile(OUT, 'utf8')); } catch {}
  if (prev) { const { updated, ...rest } = prev; if (JSON.stringify(rest) === JSON.stringify(out)) { console.log('без изменений'); return; } }
  await writeFile(OUT, JSON.stringify({ updated: new Date().toISOString(), ...out }, null, 1) + '\n');
  console.log(`записан ${OUT}: рейтинг ${rating} (${count}), кофеен ${flat.length}, текстов отзывов ${reviews.length}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
