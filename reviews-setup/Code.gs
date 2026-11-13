/**
 * Отзывы Discovery Coffee — приёмник для формы на сайте.
 * Вставляется в Google Таблицу: Расширения → Apps Script. Инструкция: reviews-setup/README.md
 *
 * POST (с сайта) — новый отзыв попадает в лист «Отзывы» с пустой галочкой «Показывать».
 * GET  (с сайта) — отдаёт только отзывы, у которых галочка стоит.
 */
const SHEET = 'Отзывы';
const HEAD = ['Дата', 'Имя', 'Оценка', 'Кофейня', 'Отзыв', 'Показывать', 'Ответ кофейни'];
const NOTIFY = true; // письмо владельцу таблицы о каждом новом отзыве

function sheet_() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(SHEET);
  if (!sh) {
    sh = ss.insertSheet(SHEET);
    sh.appendRow(HEAD);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, HEAD.length).setFontWeight('bold');
    sh.setColumnWidth(5, 420);
  }
  return sh;
}

// Текст, начинающийся с = + - @, таблица приняла бы за формулу.
function safe_(s, max) {
  s = String(s == null ? '' : s).replace(/\r/g, '').trim().slice(0, max);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function out_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  let d;
  try { d = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (err) { return out_({ ok: false }); }
  if (d.website) return out_({ ok: true }); // ловушка для ботов
  const rating = Math.round(Number(d.rating));
  const name = safe_(d.name, 60);
  const text = safe_(d.text, 1000);
  const branch = safe_(d.branch, 80);
  if (!(rating >= 1 && rating <= 5) || !name || text.length < 10) return out_({ ok: false, error: 'invalid' });

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sh = sheet_();
    sh.appendRow([new Date(), name, rating, branch, text, false, '']);
    sh.getRange(sh.getLastRow(), 6).insertCheckboxes();
  } finally {
    lock.releaseLock();
  }
  if (NOTIFY) {
    try {
      MailApp.sendEmail(Session.getEffectiveUser().getEmail(),
        'Новый отзыв на сайте: ' + '★'.repeat(rating),
        name + (branch ? ' · ' + branch : '') + '\n\n' + text +
        '\n\nЧтобы опубликовать, поставьте галочку «Показывать»:\n' + SpreadsheetApp.getActive().getUrl());
    } catch (err) {}
  }
  return out_({ ok: true });
}

function doGet() {
  const rows = sheet_().getDataRange().getValues().slice(1);
  const list = rows
    .filter(function (r) { return r[5] === true || /^(да|yes|1)$/i.test(String(r[5]).trim()); })
    .map(function (r) {
      return {
        date: r[0] instanceof Date ? r[0].toISOString() : String(r[0]),
        name: String(r[1]),
        rating: Number(r[2]) || null,
        branch: String(r[3] || ''),
        text: String(r[4]),
        answer: r[6] ? String(r[6]) : null,
      };
    })
    .reverse()
    .slice(0, 100);
  return out_({ reviews: list });
}
