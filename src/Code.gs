/**
 * LINE予約システム v16
 * フロー(この順番で質問):
 *   予約 → 講座 → 日付 → 時間 →(空きが取れてから)→ 人数 → 受講者名(全員まとめて自由記述)
 *        → 学年 → 住所 → 連絡先(電話/メール/両方) → 確定
 * キャンセル:
 *   「キャンセル」送信 → 自分の予約一覧(前日まで有効) → 選択 → 確認(はい/いいえ)
 *   → ステータスを「キャンセル」に更新(行は消さない) → 本人へ完了/管理者へ通知 → 枠は自動で空きに戻る
 * オーナーの予定に合わせた予約枠制御(グリッド方式):
 *   「予約不可設定」シート … A列=日付 / 横軸=各開始時刻 / 印を付けたセル=予約不可
 *   一番右の「終日休み」列に印を付けるとその日は終日 予約不可。
 *   予約は2日前まで(LEAD_DAYS)。
 * 予約ルール:
 *  - 開始時刻は全講座 共通の30分刻みグリッド(10:00〜)
 *  - 所要時間: 講座A=60分 / 講座B=45分 / 両方=90分
 *  - 各予約の前後に30分のバッファを確保。重なる開始時刻は「非表示」
 *  - 開始時刻は最大19:00まで(終了時刻の上限なし)
 *  - 月カレンダー(〇=空きあり / △=残りわずか / ×=満、×はタップ不可)
 *  - 今日〜2か月先まで / 予約完了時に管理者へ メール + LINE 通知
 * 料金:
 *  - 初回 = 1人あたり単価 × 人数
 *  - 2回目以降 = 1人目が単価 + 2人目以降は1人ごとに EXTRA_PER_PERSON 加算
 *
 * スクリプトプロパティ: CHANNEL_ACCESS_TOKEN / SPREADSHEET_ID / SHEET_NAME(任意)
 *                      ADMIN_EMAIL(任意) / ADMIN_USER_ID(任意)
 */

// ===== 管理者設定(通知先) =====
var ADMIN_EMAIL = PropertiesService.getScriptProperties().getProperty('ADMIN_EMAIL') || ''; // 各自の環境に合わせて設定
var ADMIN_USER_ID = PropertiesService.getScriptProperties().getProperty('ADMIN_USER_ID') || ''; // 各自の環境に合わせて設定
var ADMIN_LINE_NOTIFY = false; // 管理者へのLINE通知(false=メールのみ。LINE無料枠を節約)

// ===== お支払い案内(各自の環境に合わせて設定: ダミー値。自分の口座に書き換えてください) =====
var PAYMENT_INFO =
  'お支払いは前日までに下記口座へお振込ください。\n' +
  'ご入金がない場合は当日現金でお願いいたします。\n' +
  '〔振込先〕〇〇銀行 〇〇支店 普通 0000000 ナマエ';

// ===== リマインダー設定 =====
var REMINDER_HOUR = 9; // 前日の何時に送るか(24時間表記)

// ===== Googleカレンダー連携設定 =====
// 予約完了時にカレンダーへ自動登録。空('')なら本人のメインカレンダーに作成。
// 専用カレンダーに入れたい場合は、そのカレンダーIDを '' の中に貼る。
var CALENDAR_ID = '';

// ===== 営業・予約ルール設定 =====
var TZ = 'Asia/Tokyo';
var SLOT_START_MIN = 600;    // 開始グリッドの最初 = 10:00 (分)
var SLOT_MINUTES = 30;       // 30分刻みグリッド
var SLOTS_PER_DAY = 19;      // 開始グリッド数(10:00〜19:00)
var BUFFER_MIN = 30;         // 各予約の前後に空ける時間(分)
var MONTHS_AHEAD = 2;        // 何か月先まで予約可能か
var LEAD_DAYS = 2;           // 予約は「何日前まで」に必要か(2=今日/明日は不可、明後日以降のみ)
var TRIANGLE_THRESHOLD = 10; // その日の予約可能な開始数がこれ以下で△
var WD = ['日', '月', '火', '水', '木', '金', '土'];

// 講座ごとの所要時間(分)
var COURSE_MIN = { 'A': 60, 'B': 45, 'BOTH': 90 };
function courseMin(c) { return COURSE_MIN[c] || 60; }
function courseLabel(c) {
  if (c === 'A') return '講座A';
  if (c === 'B') return '講座B';
  if (c === 'BOTH') return '両方(A+B)';
  return '講座';
}
// スプレッドシートの講座表記 -> 所要時間(分)
function courseCellToMin(label) {
  var s = String(label || '');
  if (s.indexOf('両方') >= 0) return 90;
  if (s.indexOf('B') >= 0) return 45;
  return 60; // 講座A / 旧データ(空欄)
}

var CONFIG = (function () {
  var props = PropertiesService.getScriptProperties();
  return {
    CHANNEL_ACCESS_TOKEN: props.getProperty('CHANNEL_ACCESS_TOKEN'),
    SPREADSHEET_ID: props.getProperty('SPREADSHEET_ID'),
    SHEET_NAME: props.getProperty('SHEET_NAME') || '予約一覧',
    REPLY: 'https://api.line.me/v2/bot/message/reply',
    PUSH: 'https://api.line.me/v2/bot/message/push'
  };
})();

// ===== シート列(11列) =====
var HEADERS = ['受付日時', 'ユーザーID', '予約日時', '講座', '受講者数', '受講者名', '学年', '住所', '連絡先', '料金', 'ステータス'];

// ===== 予約不可設定(グリッド方式)シート =====
//   A列=日付 / 横軸=各開始時刻(10:00〜) / 印を付けたセル=予約不可 / 末尾列=終日休み
var BLOCK_SHEET_NAME = '予約不可設定';
var FULLDAY_LABEL = '終日休み';

// ===== 料金設定 =====
var PRICE_FIRST = { 'A': 500, 'B': 0, 'BOTH': 500 };       // 初回1人あたり(×人数)
var PRICE_REPEAT = { 'A': 3000, 'B': 1000, 'BOTH': 4000 }; // 2回目以降 1人目
var EXTRA_PER_PERSON = 1000;                               // 2回目以降 2人目以降の加算

/* ================================================================
 * エントリポイント
 * ================================================================ */
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return ContentService.createTextOutput('no data');
    }
    var body = JSON.parse(e.postData.contents);
    (body.events || []).forEach(function (event) { handleEvent(event); });
  } catch (err) {
    console.error('doPost error: ' + err + '\n' + (err.stack || ''));
  }
  return ContentService.createTextOutput(JSON.stringify({ status: 'ok' }))
    .setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  // ?setup=reminder でリマインダーの定期実行トリガーを作成(1回アクセスするだけ)
  if (e && e.parameter && e.parameter.setup === 'reminder') {
    return ContentService.createTextOutput(setupReminderTrigger());
  }
  return ContentService.createTextOutput('LINE 予約システム v16: 稼働中です。');
}

function authorizeOnce() {
  MailApp.getRemainingDailyQuota();
  SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  return 'ok';
}

// テストデータ全消去 + タイムゾーン/書式を正す(エディタで1回実行)
function resetData() {
  var ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  try { ss.setSpreadsheetTimeZone(TZ); } catch (e) {}
  var old = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (old) ss.deleteSheet(old);
  var sh = ss.insertSheet(CONFIG.SHEET_NAME);
  sh.getRange(1, 3, sh.getMaxRows(), 1).setNumberFormat('@');
  sh.appendRow(HEADERS);
  return 'reset done';
}

/* ================================================================
 * イベント処理
 * ================================================================ */
function handleEvent(event) {
  var replyToken = event.replyToken;
  var userId = (event.source && event.source.userId) || 'unknown';

  if (event.type === 'message' && event.message && event.message.type === 'text') {
    var text = (event.message.text || '').trim();

    // 予約開始 → まず講座から
    if (text === '予約' || text.toLowerCase() === 'reserve') {
      clearState(userId);
      reply(replyToken, [buildCourseFlex()]);
      return;
    }

    // キャンセル → 自分の(前日まで有効な)予約一覧を表示
    if (text === 'キャンセル' || text.toLowerCase() === 'cancel') {
      clearState(userId);
      var mine = getMyReservations(userId);
      if (mine.length === 0) {
        reply(replyToken, [{ type: 'text', text: '現在キャンセルできるご予約はありません。\n（キャンセルは前日まで受け付けています。当日・過去の予約は対象外です。）' }]);
      } else {
        reply(replyToken, [buildCancelListFlex(mine)]);
      }
      return;
    }

    var stm = getState(userId);
    if (stm) {
      if (stm.step === 'name') {
        stm.name = text; stm.step = 'grade'; setState(userId, stm);
        reply(replyToken, [{ type: 'text', text: '受講者の学年を入力してください。\n複数の場合は全員分をまとめてご記入ください（例: 小3、中1）。' }]);
        return;
      }
      if (stm.step === 'grade') {
        stm.grade = text; stm.step = 'address'; setState(userId, stm);
        reply(replyToken, [{ type: 'text', text: 'ご住所を入力してください（家庭教師がお伺いします）。' }]);
        return;
      }
      if (stm.step === 'address') {
        stm.address = text; stm.step = 'contact'; setState(userId, stm);
        reply(replyToken, [{ type: 'text', text: '連絡の取れる電話番号またはメールアドレスをご入力ください（両方でも構いません）。' }]);
        return;
      }
      if (stm.step === 'contact') {
        stm.contact = text; setState(userId, stm);
        finalizeReservation(replyToken, userId, stm);
        return;
      }
      if (stm.step === 'count') {
        reply(replyToken, [{ type: 'text', text: '受講者数はボタンから選んでください。' }, buildCountFlex()]);
        return;
      }
      // 講座・日付・時間の選択待ち
      reply(replyToken, [{ type: 'text', text: '画面のボタンから選択してください。' }]);
      return;
    }

    reply(replyToken, [{ type: 'text', text: '「予約」と送信すると予約を開始できます。' }]);
    return;
  }

  if (event.type === 'postback' && event.postback && event.postback.data) {
    handlePostback(replyToken, userId, event.postback.data);
    return;
  }
  if (event.type === 'follow') {
    reply(replyToken, [{ type: 'text', text: 'ご登録ありがとうございます!「予約」と送信すると予約を開始できます。' }]);
  }
}

function handlePostback(replyToken, userId, data) {
  var p = parseQuery(data);

  // 講座選択 → カレンダーへ
  if (p.action === 'course') {
    setState(userId, { course: p.value, step: 'pickdate' });
    reply(replyToken, [buildCalendarFlex(currentMonthYm(), p.value)]);
    return;
  }
  if (p.action === 'month') {
    reply(replyToken, [buildCalendarFlex(p.ym, p.course)]);
    return;
  }
  if (p.action === 'date') {
    reply(replyToken, [buildTimeFlex(p.value, p.course)]);
    return;
  }
  if (p.action === 'time') {
    // 空きを再確認してから、人数・個人情報の収集へ
    var dnT = courseMin(p.course);
    var idxT = (timeToMin(p.value) - SLOT_START_MIN) / SLOT_MINUTES;
    var startsT = validStarts(p.date, getBookedMap(), new Date(), dnT);
    if (startsT.indexOf(idxT) < 0) {
      clearState(userId);
      reply(replyToken, [{ type: 'text', text: '申し訳ありません。その時間は選べなくなりました。もう一度「予約」からお試しください。' }]);
      return;
    }
    var st = getState(userId) || {};
    st.course = p.course; st.date = p.date; st.time = p.value; st.step = 'count';
    setState(userId, st);
    reply(replyToken, [buildCountFlex()]);
    return;
  }
  if (p.action === 'count') {
    var stc = getState(userId);
    if (!stc || !stc.time) {
      reply(replyToken, [{ type: 'text', text: '恐れ入りますが、もう一度「予約」から始めてください。' }]);
      return;
    }
    stc.count = Number(p.value) || 1;
    stc.step = 'name';
    setState(userId, stc);
    reply(replyToken, [{ type: 'text', text: '受講者のお名前を入力してください（フルネーム）。\n複数の場合は全員のお名前をまとめてご記入ください。' }]);
    return;
  }

  // ===== キャンセル: 確認画面を出す =====
  if (p.action === 'cancelask') {
    var row = Number(p.row);
    var info = getReservationAt(row);
    if (!info || info.userId !== userId || info.status !== '予約完了') {
      reply(replyToken, [{ type: 'text', text: 'そのご予約は見つからないか、すでにキャンセル済みです。' }]);
      return;
    }
    if (!isCancellable(info.dateStr)) {
      reply(replyToken, [{ type: 'text', text: '申し訳ありません。キャンセルは前日まで受け付けています。この予約はキャンセルできません。' }]);
      return;
    }
    reply(replyToken, [buildCancelConfirmFlex(row, info)]);
    return;
  }
  // ===== キャンセル: 「はい」で確定 =====
  if (p.action === 'cancelyes') {
    var row2 = Number(p.row);
    var info2 = getReservationAt(row2);
    if (!info2 || info2.userId !== userId || info2.status !== '予約完了') {
      reply(replyToken, [{ type: 'text', text: 'そのご予約は見つからないか、すでにキャンセル済みです。' }]);
      return;
    }
    if (!isCancellable(info2.dateStr)) {
      reply(replyToken, [{ type: 'text', text: '申し訳ありません。キャンセルは前日まで受け付けています。この予約はキャンセルできません。' }]);
      return;
    }
    setStatus(row2, 'キャンセル');
    removeCalendarEvent(info2);
    var label2 = formatJapaneseDatetime(info2.dateStr, info2.timeStr);
    reply(replyToken, [{ type: 'text', text: 'ご予約をキャンセルしました。\n\n【講座】' + info2.course + '\n【予約日時】' + label2 + '\n\nまたのご利用をお待ちしております。「予約」と送信すると新しくご予約いただけます。' }]);
    notifyAdminCancel(userId, info2, label2);
    return;
  }
  // ===== キャンセル: 「いいえ」 =====
  if (p.action === 'cancelno') {
    reply(replyToken, [{ type: 'text', text: 'キャンセルを中止しました。ご予約はそのまま有効です。' }]);
    return;
  }
}

/* ================================================================
 * 時刻・日付ユーティリティ
 * ================================================================ */
function pad2(n) { return (n < 10 ? '0' : '') + n; }
function indexToMin(i) { return SLOT_START_MIN + i * SLOT_MINUTES; }
function minToTime(m) { return pad2(Math.floor(m / 60)) + ':' + pad2(m % 60); }
function indexToTime(i) { return minToTime(indexToMin(i)); }
function timeToMin(t) { var sp = String(t).split(':'); return Number(sp[0]) * 60 + Number(sp[1]); }
function dateKey(d) { return Utilities.formatDate(d, TZ, 'yyyy-MM-dd'); }
function todayStart() { var n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); }
function minBookDate() { var t = todayStart(); return new Date(t.getFullYear(), t.getMonth(), t.getDate() + LEAD_DAYS); }
function maxDate() { var t = todayStart(); return new Date(t.getFullYear(), t.getMonth() + MONTHS_AHEAD, t.getDate()); }
function currentMonthYm() { return Utilities.formatDate(todayStart(), TZ, 'yyyy-MM'); }
function maxMonthYm() { return Utilities.formatDate(maxDate(), TZ, 'yyyy-MM'); }
function shiftMonth(ym, delta) {
  var p = ym.split('-');
  var d = new Date(Number(p[0]), Number(p[1]) - 1 + delta, 1);
  return Utilities.formatDate(d, TZ, 'yyyy-MM');
}

/* ================================================================
 * 予約データ(スプレッドシート)
 * ================================================================ */
function openSheet() {
  var ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  try { if (ss.getSpreadsheetTimeZone() !== TZ) ss.setSpreadsheetTimeZone(TZ); } catch (e) {}
  var sh = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(CONFIG.SHEET_NAME);
    sh.appendRow(HEADERS);
  } else if (sh.getLastRow() === 0) {
    sh.appendRow(HEADERS);
  }
  // 予約日時列(C)を文字列書式にして、日付の自動変換(タイムゾーンずれ)を防ぐ
  try { sh.getRange(1, 3, sh.getMaxRows(), 1).setNumberFormat('@'); } catch (e) {}
  return sh;
}

// { 'YYYY-MM-DD': [ {startMin, durMin}, ... ] }  ステータスは K列(11列目)
function getBookedMap() {
  var map = {};
  var ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  var ssTz = ss.getSpreadsheetTimeZone();
  var sh = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (!sh) return map;
  var last = sh.getLastRow();
  if (last < 2) return map;
  var vals = sh.getRange(2, 1, last - 1, 11).getValues();
  vals.forEach(function (r) {
    var status = (r[10] !== '' && r[10] != null) ? r[10]
               : ((r[9] !== '' && r[9] != null) ? r[9] : r[4]);
    var courseCell = r[3];
    if (status !== '予約完了') return;

    var dt = r[2], dateStr, timeStr;
    if (dt instanceof Date) {
      dateStr = Utilities.formatDate(dt, ssTz, 'yyyy-MM-dd');
      timeStr = Utilities.formatDate(dt, ssTz, 'HH:mm');
    } else {
      var sp = String(dt).trim().split(' ');
      dateStr = sp[0]; timeStr = sp[1];
    }
    if (!timeStr) return;
    if (!map[dateStr]) map[dateStr] = [];
    map[dateStr].push({ startMin: timeToMin(timeStr), durMin: courseCellToMin(courseCell) });
  });
  return map;
}

// 既存予約が占有する時間帯(前後バッファ込み)の一覧 [ [start,end], ... ]
function blockedIntervals(list) {
  return (list || []).map(function (b) {
    return [b.startMin - BUFFER_MIN, b.startMin + b.durMin + BUFFER_MIN];
  });
}
function rangesOverlap(aS, aE, bS, bE) { return aS < bE && bS < aE; } // 端が接するのはOK

// 指定講座を予約できる「開始グリッドindex」の一覧
function validStarts(dateStr, bookedMap, now, durMin) {
  // 予約は2日前まで(明後日以降のみ)。当日・明日は選べない。
  var minKey = Utilities.formatDate(minBookDate(), TZ, 'yyyy-MM-dd');
  if (dateStr < minKey) return [];
  // オーナーの予約不可設定(全休/時間帯/曜日)を反映
  var sched = getScheduleBlocks(dateStr);
  if (sched.fullClosed) return [];
  var blocks = blockedIntervals(bookedMap[dateStr] || []);
  var todayKey = dateKey(now);
  var nowMin = now.getHours() * 60 + now.getMinutes();
  var res = [];
  for (var i = 0; i < SLOTS_PER_DAY; i++) {
    var s = indexToMin(i);
    var e = s + durMin;
    if (dateStr === todayKey && s <= nowMin) continue;    // 過去の時間
    var ok = true;
    for (var k = 0; k < blocks.length; k++) {
      if (rangesOverlap(s, e, blocks[k][0], blocks[k][1])) { ok = false; break; }
    }
    if (ok) {
      // 予約不可の時間帯(オーナー設定)と重なる開始も除外
      for (var m = 0; m < sched.intervals.length; m++) {
        if (rangesOverlap(s, e, sched.intervals[m][0], sched.intervals[m][1])) { ok = false; break; }
      }
    }
    if (ok) res.push(i);
  }
  return res;
}

/* ================================================================
 * オーナーの予約不可設定(「予約不可設定」シート / グリッド方式)
 *   1行目(ヘッダー): A列='日付' / B列以降=各開始時刻(10:00,10:30,…) / 末尾列='終日休み'
 *   2行目以降: A列に「日付(yyyy-MM-dd)」または「曜日(日/月/火/水/木/金/土)」を入れる。
 *     予約を受けたくない時間のセルに印(×など)を入れる。
 *   - 日付を入れた行 … その日だけに適用
 *   - 曜日を入れた行 … 毎週その曜日に適用(例: A列に「月」で毎週月曜)
 *   - 時間セルに印 → その30分枠は予約不可(その枠に重なる予約は選べなくなる)
 *   - 末尾「終日休み」列に印 → 終日 予約不可
 * ================================================================ */
var _scheduleGridCache = null;
// { byDate:{ 'yyyy-MM-dd':{fullClosed,intervals} }, byWeekday:{ 0..6:{fullClosed,intervals} } }
function getScheduleGrid() {
  if (_scheduleGridCache) return _scheduleGridCache;
  var grid = { byDate: {}, byWeekday: {} };
  try {
    var ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    var sh = ss.getSheetByName(BLOCK_SHEET_NAME);
    if (!sh) { try { initBlockSheet(); sh = ss.getSheetByName(BLOCK_SHEET_NAME); } catch (e0) {} }
    if (sh) {
      var lastRow = sh.getLastRow();
      var lastCol = sh.getLastColumn();
      if (lastRow >= 2 && lastCol >= 2) {
        var vals = sh.getRange(1, 1, lastRow, lastCol).getValues();
        var header = vals[0];
        // 各列(B列以降)が表す開始時刻(分)。終日休み列は fullCol に記録
        var colMin = [];   // colMin[c] = 分 or null
        var fullCol = -1;
        for (var c = 1; c < header.length; c++) {
          var h = String(header[c] || '').trim();
          if (h === FULLDAY_LABEL) { fullCol = c; colMin[c] = null; continue; } // 完全一致のみ(使い方メモの誤検知を防ぐ)
          colMin[c] = timeCellToMin(header[c]); // 時刻でなければ null(=無視)
        }
        for (var r = 1; r < vals.length; r++) {
          var raw = vals[r][0];
          var ds = cellToDateStr(raw);
          var wd = ds ? -1 : parseWeekday(raw);   // 日付優先。日付でなければ曜日を判定
          var entry;
          if (ds) { entry = grid.byDate[ds] || { fullClosed: false, intervals: [] }; }
          else if (wd >= 0) { entry = grid.byWeekday[wd] || { fullClosed: false, intervals: [] }; }
          else { continue; }
          for (var c2 = 1; c2 < vals[r].length; c2++) {
            var cell = vals[r][c2];
            if (cell === '' || cell == null || String(cell).trim() === '') continue; // 印なし
            if (c2 === fullCol) { entry.fullClosed = true; continue; }
            var sm = colMin[c2];
            if (sm == null) continue;
            entry.intervals.push([sm, sm + SLOT_MINUTES]);
          }
          if (ds) { grid.byDate[ds] = entry; } else { grid.byWeekday[wd] = entry; }
        }
      }
    }
  } catch (e) { console.error('getScheduleGrid error: ' + e); }
  _scheduleGridCache = grid;
  return grid;
}

// '日'..'土' / '日曜'..'土曜日' / '毎週月曜' → 0..6。該当しなければ -1
function parseWeekday(cell) {
  var s = String(cell || '').trim();
  if (!s) return -1;
  s = s.replace(/毎週/g, '').replace(/曜日/g, '').replace(/曜/g, '').trim();
  return WD.indexOf(s); // WD = ['日','月','火','水','木','金','土'] → 0..6 / -1
}

// 指定日の予約不可情報(その日付ぶん + その曜日ぶん を合算)
function getScheduleBlocks(dateStr) {
  var grid = getScheduleGrid();
  var out = { fullClosed: false, intervals: [] };
  var byD = grid.byDate[dateStr];
  if (byD) { if (byD.fullClosed) out.fullClosed = true; out.intervals = out.intervals.concat(byD.intervals); }
  var p = dateStr.split('-');
  var wd = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2])).getDay();
  var byW = grid.byWeekday[wd];
  if (byW) { if (byW.fullClosed) out.fullClosed = true; out.intervals = out.intervals.concat(byW.intervals); }
  return out;
}

// 日付セル(文字列 or Date) → 'yyyy-MM-dd'。日付でなければ ''
function cellToDateStr(cell) {
  if (cell instanceof Date) {
    return Utilities.formatDate(cell, TZ, 'yyyy-MM-dd');
  }
  var s = String(cell || '').trim();
  var m = s.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
  if (m) {
    return m[1] + '-' + pad2(Number(m[2])) + '-' + pad2(Number(m[3]));
  }
  return '';
}

// 時刻セル(文字列 'HH:mm' or Date) → 分。空なら null
function timeCellToMin(cell) {
  if (cell === '' || cell == null) return null;
  if (cell instanceof Date) {
    return cell.getHours() * 60 + cell.getMinutes();
  }
  var s = String(cell).trim();
  var m = s.match(/^(\d{1,2}):(\d{2})/);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  return null;
}

// 「予約不可設定」シートをグリッドで用意(なければ作成。既存なら何もしない)
function initBlockSheet() {
  var ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  var sh = ss.getSheetByName(BLOCK_SHEET_NAME);
  if (sh) return 'already exists';
  sh = ss.insertSheet(BLOCK_SHEET_NAME);

  // ヘッダー: 日付 / 10:00 / 10:30 / … / 終日休み
  var header = ['日付'];
  for (var i = 0; i < SLOTS_PER_DAY; i++) header.push(indexToTime(i));
  header.push(FULLDAY_LABEL);
  sh.getRange(1, 1, 1, header.length).setValues([header]);

  // 見た目・使い勝手
  sh.setFrozenRows(1);
  sh.setFrozenColumns(1);
  sh.getRange(1, 1, 1, header.length).setFontWeight('bold').setBackground('#E8F5E9');
  sh.getRange(1, header.length).setBackground('#FCE4EC'); // 終日休み列を目立たせる
  sh.getRange(1, 1, sh.getMaxRows(), 1).setNumberFormat('@'); // A列(日付)は文字列書式
  try { sh.setColumnWidth(1, 110); } catch (e) {}

  // 使い方メモ(データ範囲の外=末尾列の2つ右。予約処理は時刻/終日列だけ読むので影響なし)
  var noteCol = header.length + 2;
  sh.getRange(1, noteCol).setValue('【使い方】A列に「日付(例: 2026-10-05)」または「曜日(月/火/…)」を入力し、予約を受けたくない時間のセルに × を入れてください。丸ごと休みにするときは一番右の「終日休み」列に × を入れます。曜日を入れた行は毎週その曜日に適用されます(例: A列に「月」で毎週月曜が休み)。');
  return 'created';
}

function daySymbol(dateStr, bookedMap, now, durMin) {
  var count = validStarts(dateStr, bookedMap, now, durMin).length;
  if (count === 0) return { symbol: '×', count: 0 };
  if (count <= TRIANGLE_THRESHOLD) return { symbol: '△', count: count };
  return { symbol: '〇', count: count };
}

/* ================================================================
 * Flex: 受講者数選択(1〜5)
 * ================================================================ */
function buildCountFlex() {
  var btns = [];
  for (var i = 1; i <= 5; i++) {
    btns.push({
      type: 'button', style: (i === 1 ? 'primary' : 'secondary'), color: (i === 1 ? '#06C755' : '#EEEEEE'),
      height: 'sm', margin: 'sm',
      action: { type: 'postback', label: i + '名', data: 'action=count&value=' + i, displayText: i + '名' }
    });
  }
  return {
    type: 'flex', altText: '受講者数を選択してください',
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: '#06C755', paddingAll: '14px',
        contents: [
          { type: 'text', text: '受講者数', weight: 'bold', size: 'lg', color: '#ffffff' },
          { type: 'text', text: '受講される人数を選んでください', size: 'sm', color: '#ffffff' }
        ]
      },
      body: { type: 'box', layout: 'vertical', contents: btns }
    }
  };
}

/* ================================================================
 * Flex: 講座選択
 * ================================================================ */
function buildCourseFlex() {
  function btn(label, value, sub) {
    return {
      type: 'box', layout: 'vertical', spacing: 'xs', margin: 'md',
      contents: [
        { type: 'button', style: 'primary', color: '#06C755', height: 'sm',
          action: { type: 'postback', label: label, data: 'action=course&value=' + value, displayText: label + ' を選択' } },
        { type: 'text', text: sub, size: 'xxs', color: '#888888', align: 'center' }
      ]
    };
  }
  return {
    type: 'flex',
    altText: '講座を選択してください',
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: '#06C755', paddingAll: '14px',
        contents: [
          { type: 'text', text: 'ご予約', weight: 'bold', size: 'lg', color: '#ffffff' },
          { type: 'text', text: 'まず講座を選んでください', size: 'sm', color: '#ffffff' }
        ]
      },
      body: {
        type: 'box', layout: 'vertical',
        contents: [
          btn('講座A', 'A', '所要時間 約1時間'),
          btn('講座B', 'B', '所要時間 約45分'),
          btn('両方(A+B)', 'BOTH', '所要時間 約1時間半')
        ]
      }
    }
  };
}

/* ================================================================
 * Flex: 月カレンダー
 * ================================================================ */
function symbolColor(sym) {
  if (sym === '〇') return '#06C755';
  if (sym === '△') return '#E8A100';
  if (sym === '×') return '#E03030';
  return '#BBBBBB';
}

function buildCalendarFlex(ym, course) {
  var durMin = courseMin(course);
  var p = ym.split('-');
  var year = Number(p[0]), mon = Number(p[1]);
  var first = new Date(year, mon - 1, 1);
  var startWd = first.getDay();
  var daysInMonth = new Date(year, mon, 0).getDate();

  var now = new Date();
  var minBook = minBookDate();
  var max = maxDate();
  var bookedMap = getBookedMap();

  var wdRow = { type: 'box', layout: 'horizontal', contents: WD.map(function (w, i) {
    return { type: 'text', text: w, size: 'xs', align: 'center', flex: 1,
             color: (i === 0 ? '#E03030' : (i === 6 ? '#2277DD' : '#888888')) };
  }) };

  var weeks = [], cells = [], c;
  for (c = 0; c < startWd; c++) cells.push(emptyCell());
  for (var day = 1; day <= daysInMonth; day++) {
    var d = new Date(year, mon - 1, day);
    var ds = dateKey(d);
    if (d < minBook || d > max) {
      cells.push(grayDayCell(day));
    } else {
      var info = daySymbol(ds, bookedMap, now, durMin);
      var selectable = info.symbol !== '×';
      cells.push(dayCell(day, info.symbol, selectable ? ds : null, course));
    }
    if (cells.length === 7) { weeks.push({ type: 'box', layout: 'horizontal', spacing: 'xs', contents: cells }); cells = []; }
  }
  if (cells.length > 0) {
    while (cells.length < 7) cells.push(emptyCell());
    weeks.push({ type: 'box', layout: 'horizontal', spacing: 'xs', contents: cells });
  }

  var curYm = currentMonthYm(), maxYm = maxMonthYm();
  var prevCell = (ym > curYm)
    ? { type: 'text', text: '◀ 前月', size: 'sm', color: '#ffffff', align: 'start', flex: 2,
        action: { type: 'postback', data: 'action=month&ym=' + shiftMonth(ym, -1) + '&course=' + course, displayText: '前月へ' } }
    : { type: 'text', text: ' ', size: 'sm', flex: 2 };
  var nextCell = (ym < maxYm)
    ? { type: 'text', text: '翌月 ▶', size: 'sm', color: '#ffffff', align: 'end', flex: 2,
        action: { type: 'postback', data: 'action=month&ym=' + shiftMonth(ym, 1) + '&course=' + course, displayText: '翌月へ' } }
    : { type: 'text', text: ' ', size: 'sm', flex: 2 };

  var header = {
    type: 'box', layout: 'vertical', backgroundColor: '#06C755', paddingAll: '12px', spacing: 'sm',
    contents: [
      { type: 'text', text: courseLabel(course) + ' を予約', size: 'xs', color: '#ffffff' },
      { type: 'box', layout: 'horizontal', contents: [
        prevCell,
        { type: 'text', text: year + '年' + mon + '月', weight: 'bold', size: 'md', color: '#ffffff', align: 'center', flex: 3 },
        nextCell
      ] },
      { type: 'text', text: '〇空きあり  △残りわずか  ×満(選択不可)', size: 'xxs', color: '#ffffff', align: 'center', wrap: true },
      { type: 'text', text: 'ご予約は2日前まで(明後日以降)にお願いします', size: 'xxs', color: '#ffffff', align: 'center', wrap: true }
    ]
  };
  var body = { type: 'box', layout: 'vertical', spacing: 'xs',
    contents: [wdRow, { type: 'separator', margin: 'sm' }].concat(weeks) };

  return {
    type: 'flex',
    altText: year + '年' + mon + '月の予約カレンダー',
    contents: { type: 'bubble', header: header, body: body }
  };
}

function emptyCell() {
  return { type: 'box', layout: 'vertical', flex: 1, contents: [{ type: 'text', text: ' ', size: 'xs' }] };
}
function grayDayCell(day) {
  return { type: 'box', layout: 'vertical', flex: 1, paddingAll: '2px', contents: [
    { type: 'text', text: String(day), size: 'xs', align: 'center', color: '#DDDDDD' },
    { type: 'text', text: ' ', size: 'xxs', align: 'center' }
  ] };
}
function dayCell(day, symbol, ds, course) {
  var box = {
    type: 'box', layout: 'vertical', flex: 1, paddingAll: '2px', cornerRadius: '4px',
    backgroundColor: ds ? '#F1FBF4' : '#FFFFFF',
    contents: [
      { type: 'text', text: String(day), size: 'xs', align: 'center', color: ds ? '#333333' : '#BBBBBB' },
      { type: 'text', text: symbol, size: 'sm', align: 'center', color: symbolColor(symbol) }
    ]
  };
  if (ds) {
    box.action = { type: 'postback', data: 'action=date&value=' + ds + '&course=' + course, displayText: ds + ' を選択' };
  }
  return box;
}

/* ================================================================
 * Flex: 時間選択(予約可能な開始時刻だけを表示)
 * ================================================================ */
function buildTimeFlex(dateStr, course) {
  var durMin = courseMin(course);
  var now = new Date();
  var starts = validStarts(dateStr, getBookedMap(), now, durMin);

  var p = dateStr.split('-');
  var d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  var title = Number(p[1]) + '月' + Number(p[2]) + '日(' + WD[d.getDay()] + ') / ' + courseLabel(course);

  var bodyContents;
  if (starts.length === 0) {
    bodyContents = [{ type: 'text', text: 'この日は予約できる時間がありません。別の日をお選びください。', size: 'sm', wrap: true, color: '#888888' }];
  } else {
    var rows = [];
    for (var i = 0; i < starts.length; i += 3) {
      var cells = [];
      for (var j = i; j < i + 3 && j < starts.length; j++) {
        var t = indexToTime(starts[j]);
        cells.push({
          type: 'button', style: 'primary', color: '#06C755', height: 'sm', flex: 1,
          action: { type: 'postback', label: t, data: 'action=time&date=' + dateStr + '&value=' + t + '&course=' + course, displayText: t + ' を選択' }
        });
      }
      while (cells.length < 3) cells.push({ type: 'box', layout: 'vertical', flex: 1, contents: [{ type: 'text', text: ' ' }] });
      rows.push({ type: 'box', layout: 'horizontal', spacing: 'sm', margin: 'sm', contents: cells });
    }
    bodyContents = [{ type: 'text', text: '開始時刻を選んでください', size: 'xxs', color: '#888888' }].concat(rows);
  }

  return {
    type: 'flex',
    altText: title + ' の空き時間',
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: '#06C755', paddingAll: '14px',
        contents: [
          { type: 'text', text: '開始時刻を選択', weight: 'bold', size: 'lg', color: '#ffffff' },
          { type: 'text', text: title, size: 'sm', color: '#ffffff', wrap: true }
        ]
      },
      body: { type: 'box', layout: 'vertical', spacing: 'none', contents: bodyContents }
    }
  };
}

/* ================================================================
 * 予約確定(全情報入力後)
 * ================================================================ */
function finalizeReservation(replyToken, userId, st) {
  var dn = courseMin(st.course);
  var idx = (timeToMin(st.time) - SLOT_START_MIN) / SLOT_MINUTES;
  var starts = validStarts(st.date, getBookedMap(), new Date(), dn);
  if (starts.indexOf(idx) < 0) {
    clearState(userId);
    reply(replyToken, [{ type: 'text', text: '申し訳ありません。入力中にその時間が埋まってしまいました。もう一度「予約」からお願いします。' }]);
    return;
  }
  var first = isFirstTime(userId);
  var price = calcPrice(st.course, st.count, first);
  var sh = openSheet();
  var nowStr = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss');
  sh.appendRow([nowStr, userId, st.date + ' ' + st.time, courseLabel(st.course),
                st.count + '名', st.name, st.grade, st.address, st.contact, price, '予約完了']);

  var label = formatJapaneseDatetime(st.date, st.time);
  var priceStr = priceLabel(price) + '（' + (first ? '初回' : '2回目以降') + '）';
  reply(replyToken, [{
    type: 'text',
    text: 'ご予約ありがとうございます。以下の内容で承りました。\n\n' +
          '【講座】' + courseLabel(st.course) + '\n' +
          '【予約日時】' + label + '\n' +
          '【受講者数】' + st.count + '名\n' +
          '【受講者名】' + st.name + '\n' +
          '【学年】' + st.grade + '\n' +
          '【ご住所】' + st.address + '\n' +
          '【連絡先】' + st.contact + '\n' +
          '【料金】' + priceStr + '\n\n' +
          PAYMENT_INFO + '\n\n' +
          '当日は家庭教師がご自宅へお伺いします。どうぞよろしくお願いいたします。'
  }]);
  notifyAdminFull(userId, st, label, price, first);
  addCalendarEvent(st, price, first);
  clearState(userId);
}

/* ================================================================
 * 料金計算
 *  - 初回      = 単価 × 人数
 *  - 2回目以降 = 単価 + (人数-1) × EXTRA_PER_PERSON
 * ================================================================ */
function calcPrice(course, count, isFirst) {
  var n = Number(count) || 1;
  if (isFirst) {
    var baseF = PRICE_FIRST[course];
    if (baseF == null) baseF = 0;
    return baseF * n;
  }
  var baseR = PRICE_REPEAT[course];
  if (baseR == null) baseR = 0;
  return baseR + Math.max(0, n - 1) * EXTRA_PER_PERSON;
}
function formatYen(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '円';
}
function priceLabel(n) { return (Number(n) === 0) ? '無料' : formatYen(n); }

// その予約者が初回かどうか(過去に予約完了があるか)
function isFirstTime(userId) {
  var ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  var sh = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (!sh) return true;
  var last = sh.getLastRow();
  if (last < 2) return true;
  var vals = sh.getRange(2, 2, last - 1, 10).getValues(); // B(userId)..K(status)
  for (var i = 0; i < vals.length; i++) {
    if (vals[i][0] === userId && (vals[i][9] === '予約完了' || vals[i][8] === '予約完了')) return false;
  }
  return true;
}

/* ================================================================
 * 会話状態(キャッシュ, ユーザー単位, 6時間保持)
 * ================================================================ */
function stateKey(uid) { return 'st_' + uid; }
function getState(uid) {
  try { var c = CacheService.getScriptCache().get(stateKey(uid)); return c ? JSON.parse(c) : null; }
  catch (e) { return null; }
}
function setState(uid, obj) {
  try { CacheService.getScriptCache().put(stateKey(uid), JSON.stringify(obj), 21600); } catch (e) {}
}
function clearState(uid) {
  try { CacheService.getScriptCache().remove(stateKey(uid)); } catch (e) {}
}

/* ================================================================
 * 管理者への通知(メール + LINE)
 * ================================================================ */
function notifyAdminFull(userId, st, label, price, first) {
  var nowStr = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss');
  var body = '新しい予約が入りました。\n\n' +
    '講座: ' + courseLabel(st.course) + '\n' +
    '予約日時: ' + label + '\n' +
    '受講者数: ' + st.count + '名\n' +
    '受講者名: ' + st.name + '\n' +
    '学年: ' + st.grade + '\n' +
    '住所: ' + st.address + '\n' +
    '連絡先: ' + st.contact + '\n' +
    '料金: ' + priceLabel(price) + '（' + (first ? '初回' : '2回目以降') + '）\n' +
    '予約者ID: ' + userId + '\n' +
    '受付: ' + nowStr;
  try { if (ADMIN_EMAIL) MailApp.sendEmail(ADMIN_EMAIL, '【新規予約】' + courseLabel(st.course) + ' ' + label, body); }
  catch (e) { console.error('mail notify error: ' + e); }
  try { if (ADMIN_LINE_NOTIFY && ADMIN_USER_ID) push(ADMIN_USER_ID, [{ type: 'text', text: '【新規予約】\n' + body }]); }
  catch (e) { console.error('line notify error: ' + e); }
}

/* ================================================================
 * v16 追加: Googleカレンダー連携
 *  - 予約完了時にカレンダーへ予定を自動作成(addCalendarEvent)
 *  - キャンセル時に該当予定を自動削除(removeCalendarEvent)
 *  - CALENDAR_ID が空なら本人のメインカレンダーに作成
 *  - 初回のみ、エディタで authorizeCalendar を1回実行して権限を許可する
 * ================================================================ */

// 使用するカレンダーを取得(IDが空/無効ならメインカレンダー)
function getBookingCalendar() {
  try {
    if (CALENDAR_ID) {
      var c = CalendarApp.getCalendarById(CALENDAR_ID);
      if (c) return c;
    }
  } catch (e) { console.error('calendar id error: ' + e); }
  return CalendarApp.getDefaultCalendar();
}

// 予約日時から予定の開始・終了 Date を作る(所要時間は講座から算出)
function bookingEventTimes(dateStr, timeStr, course) {
  var dp = String(dateStr).split('-');
  var tp = String(timeStr).split(':');
  var start = new Date(Number(dp[0]), Number(dp[1]) - 1, Number(dp[2]),
                       Number(tp[0]), Number(tp[1]) || 0, 0);
  var end = new Date(start.getTime() + courseMin(course) * 60 * 1000);
  return { start: start, end: end };
}

// 予約完了時にカレンダーへ予定を作成
function addCalendarEvent(st, price, first) {
  try {
    var cal = getBookingCalendar();
    var t = bookingEventTimes(st.date, st.time, st.course);
    var title = '【予約】' + st.name + '様 ' + courseLabel(st.course) + '（' + st.count + '名）';
    var desc =
      '受講者名: ' + st.name + '\n' +
      '講座: ' + courseLabel(st.course) + '\n' +
      '受講者数: ' + st.count + '名\n' +
      '学年: ' + st.grade + '\n' +
      '住所: ' + st.address + '\n' +
      '連絡先: ' + st.contact + '\n' +
      '料金: ' + priceLabel(price) + '（' + (first ? '初回' : '2回目以降') + '）';
    cal.createEvent(title, t.start, t.end, { location: st.address || '', description: desc });
  } catch (e) {
    console.error('calendar add error: ' + e);
  }
}

// キャンセル時に該当する予定を削除(同じ開始時刻・同じ受講者名の【予約】予定)
function removeCalendarEvent(info) {
  try {
    var cal = getBookingCalendar();
    var t = bookingEventTimes(info.dateStr, info.timeStr, info.course);
    var evs = cal.getEvents(new Date(t.start.getTime() - 60000), new Date(t.start.getTime() + 60000));
    for (var i = 0; i < evs.length; i++) {
      var title = evs[i].getTitle();
      if (title.indexOf('【予約】') === 0 && info.name && title.indexOf(info.name) >= 0) {
        evs[i].deleteEvent();
      }
    }
  } catch (e) {
    console.error('calendar remove error: ' + e);
  }
}

// 初回のみ実行: カレンダーへのアクセス権限を許可するための関数
function authorizeCalendar() {
  var name = getBookingCalendar().getName();
  return 'カレンダー連携OK: ' + name;
}

/* ================================================================
 * LINE送信 & 共通ユーティリティ
 * ================================================================ */
function reply(replyToken, messages) {
  if (!CONFIG.CHANNEL_ACCESS_TOKEN) { console.error('CHANNEL_ACCESS_TOKEN 未設定'); return; }
  var res = UrlFetchApp.fetch(CONFIG.REPLY, {
    method: 'post', contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + CONFIG.CHANNEL_ACCESS_TOKEN },
    payload: JSON.stringify({ replyToken: replyToken, messages: messages }),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) console.error('reply error: ' + res.getResponseCode() + ' ' + res.getContentText());
}
function push(to, messages) {
  if (!CONFIG.CHANNEL_ACCESS_TOKEN) { console.error('CHANNEL_ACCESS_TOKEN 未設定'); return; }
  var res = UrlFetchApp.fetch(CONFIG.PUSH, {
    method: 'post', contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + CONFIG.CHANNEL_ACCESS_TOKEN },
    payload: JSON.stringify({ to: to, messages: messages }),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) console.error('push error: ' + res.getResponseCode() + ' ' + res.getContentText());
}
function parseQuery(str) {
  var obj = {};
  (str || '').split('&').forEach(function (pair) {
    var kv = pair.split('=');
    if (kv.length === 2) obj[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1]);
  });
  return obj;
}
function formatJapaneseDatetime(dateStr, timeStr) {
  var p = dateStr.split('-');
  var d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  return Number(p[0]) + '年' + Number(p[1]) + '月' + Number(p[2]) + '日(' + WD[d.getDay()] + ') ' + timeStr;
}

/* ================================================================
 * v10 追加: 予約キャンセル
 *  - 前日まで受付(予約日が明日以降の「予約完了」だけ対象)
 *  - キャンセルは行を消さず ステータス を「キャンセル」に更新
 * ================================================================ */

// 予約日時セル(文字列 or 日付)を {dateStr, timeStr} に正規化
function splitReservedDateTime(cell) {
  if (cell instanceof Date) {
    return {
      dateStr: Utilities.formatDate(cell, TZ, 'yyyy-MM-dd'),
      timeStr: Utilities.formatDate(cell, TZ, 'HH:mm')
    };
  }
  var sp = String(cell).trim().split(' ');
  return { dateStr: sp[0] || '', timeStr: sp[1] || '' };
}

// 前日まで(予約日が今日より後)ならキャンセル可
function isCancellable(dateStr) {
  var todayStr = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  return dateStr > todayStr;
}

// 指定ユーザーの「キャンセル可能な予約」一覧(行番号付き)
function getMyReservations(userId) {
  var res = [];
  var sh = openSheet();
  var last = sh.getLastRow();
  if (last < 2) return res;
  var vals = sh.getRange(2, 1, last - 1, 11).getValues();
  for (var i = 0; i < vals.length; i++) {
    var r = vals[i];
    if (r[1] !== userId) continue;
    if (r[10] !== '予約完了') continue;
    var dt = splitReservedDateTime(r[2]);
    if (!dt.dateStr || !isCancellable(dt.dateStr)) continue;
    res.push({
      row: i + 2,
      dateStr: dt.dateStr, timeStr: dt.timeStr,
      course: r[3], count: r[4], name: r[5]
    });
  }
  // 日時が近い順
  res.sort(function (a, b) { return (a.dateStr + a.timeStr) < (b.dateStr + b.timeStr) ? -1 : 1; });
  return res;
}

// 指定行の予約情報を取得
function getReservationAt(row) {
  if (!row || row < 2) return null;
  var sh = openSheet();
  if (row > sh.getLastRow()) return null;
  var r = sh.getRange(row, 1, 1, 11).getValues()[0];
  var dt = splitReservedDateTime(r[2]);
  return {
    row: row, userId: r[1], dateStr: dt.dateStr, timeStr: dt.timeStr,
    course: r[3], count: r[4], name: r[5], grade: r[6], address: r[7],
    contact: r[8], price: r[9], status: r[10]
  };
}

// ステータス更新(K列=11列目)
function setStatus(row, status) {
  var sh = openSheet();
  sh.getRange(row, 11).setValue(status);
}

// Flex: キャンセルできる予約の一覧
function buildCancelListFlex(list) {
  var items = [];
  var max = Math.min(list.length, 10);
  for (var i = 0; i < max; i++) {
    var res = list[i];
    var label = formatJapaneseDatetime(res.dateStr, res.timeStr);
    items.push({
      type: 'box', layout: 'vertical', margin: 'md', paddingAll: '10px',
      backgroundColor: '#F7F7F7', cornerRadius: '6px', spacing: 'sm',
      contents: [
        { type: 'text', text: res.course + '  ' + res.count, size: 'sm', color: '#333333', wrap: true },
        { type: 'text', text: label, size: 'sm', weight: 'bold', color: '#333333', wrap: true },
        { type: 'button', style: 'primary', color: '#E03030', height: 'sm',
          action: { type: 'postback', label: 'この予約をキャンセル', data: 'action=cancelask&row=' + res.row, displayText: 'この予約をキャンセル' } }
      ]
    });
  }
  return {
    type: 'flex', altText: 'キャンセルするご予約を選んでください',
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: '#E03030', paddingAll: '14px',
        contents: [
          { type: 'text', text: '予約のキャンセル', weight: 'bold', size: 'lg', color: '#ffffff' },
          { type: 'text', text: 'キャンセルするご予約を選んでください', size: 'sm', color: '#ffffff', wrap: true }
        ]
      },
      body: { type: 'box', layout: 'vertical', contents: items }
    }
  };
}

// Flex: キャンセル確認(はい/いいえ)
function buildCancelConfirmFlex(row, info) {
  var label = formatJapaneseDatetime(info.dateStr, info.timeStr);
  return {
    type: 'flex', altText: 'キャンセルの確認',
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: '#E03030', paddingAll: '14px',
        contents: [{ type: 'text', text: '本当にキャンセルしますか？', weight: 'bold', size: 'md', color: '#ffffff', wrap: true }]
      },
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm',
        contents: [
          { type: 'text', text: '【講座】' + info.course, size: 'sm', wrap: true },
          { type: 'text', text: '【予約日時】' + label, size: 'sm', wrap: true },
          { type: 'text', text: '【受講者数】' + info.count, size: 'sm', wrap: true }
        ]
      },
      footer: {
        type: 'box', layout: 'horizontal', spacing: 'sm',
        contents: [
          { type: 'button', style: 'secondary', height: 'sm', flex: 1,
            action: { type: 'postback', label: 'いいえ', data: 'action=cancelno', displayText: 'いいえ（キャンセルしない）' } },
          { type: 'button', style: 'primary', color: '#E03030', height: 'sm', flex: 1,
            action: { type: 'postback', label: 'はい', data: 'action=cancelyes&row=' + row, displayText: 'はい（キャンセルする）' } }
        ]
      }
    }
  };
}

// 管理者へキャンセル通知(メール + LINE)
function notifyAdminCancel(userId, info, label) {
  var nowStr = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss');
  var body = '予約がキャンセルされました。\n\n' +
    '講座: ' + info.course + '\n' +
    '予約日時: ' + label + '\n' +
    '受講者数: ' + info.count + '\n' +
    '受講者名: ' + info.name + '\n' +
    '予約者ID: ' + userId + '\n' +
    'キャンセル日時: ' + nowStr;
  try { if (ADMIN_EMAIL) MailApp.sendEmail(ADMIN_EMAIL, '【予約キャンセル】' + info.course + ' ' + label, body); }
  catch (e) { console.error('mail cancel notify error: ' + e); }
  try { if (ADMIN_LINE_NOTIFY && ADMIN_USER_ID) push(ADMIN_USER_ID, [{ type: 'text', text: '【予約キャンセル】\n' + body }]); }
  catch (e) { console.error('line cancel notify error: ' + e); }
}

/* ================================================================
 * v14 追加: 前日リマインダー
 *  - 毎日1回(REMINDER_HOUR時)動くトリガーで、翌日が予約日の
 *    「予約完了」のお客さんへ、確認+お支払いの念押しをプッシュ送信
 *  - トリガー作成は /exec?setup=reminder に1回アクセスするだけ
 * ================================================================ */

// 翌日の予約者へリマインダーを送る(トリガーから毎日呼ばれる)
function sendReminders() {
  var t = todayStart();
  var tomorrow = new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1);
  var targetStr = Utilities.formatDate(tomorrow, TZ, 'yyyy-MM-dd');

  var sh = openSheet();
  var last = sh.getLastRow();
  if (last < 2) return 'no rows';
  var vals = sh.getRange(2, 1, last - 1, 11).getValues();
  var sent = 0;
  for (var i = 0; i < vals.length; i++) {
    var r = vals[i];
    var userId = r[1];
    if (r[10] !== '予約完了') continue;
    var dt = splitReservedDateTime(r[2]);
    if (dt.dateStr !== targetStr) continue;
    var label = formatJapaneseDatetime(dt.dateStr, dt.timeStr);
    var msg = '【明日のご予約リマインド】\n\n' +
      '明日 ' + label + ' からご予約です。\n' +
      '【講座】' + r[3] + '\n' +
      '【受講者数】' + r[4] + '\n' +
      '【料金】' + priceLabel(r[9]) + '\n\n' +
      PAYMENT_INFO + '\n\n' +
      'お気をつけてお越しをお待ちしております。';
    try { push(userId, [{ type: 'text', text: msg }]); sent++; }
    catch (e) { console.error('reminder push error: ' + e); }
  }
  return 'reminders sent: ' + sent;
}

// リマインダーの定期実行トリガーを用意(重複作成を避けて作り直す)
function setupReminderTrigger() {
  try {
    var trigs = ScriptApp.getProjectTriggers();
    for (var i = 0; i < trigs.length; i++) {
      if (trigs[i].getHandlerFunction() === 'sendReminders') ScriptApp.deleteTrigger(trigs[i]);
    }
    ScriptApp.newTrigger('sendReminders').timeBased().atHour(REMINDER_HOUR).everyDays(1).inTimezone(TZ).create();
    return 'リマインダーの定期実行を設定しました(毎日 ' + REMINDER_HOUR + ':00 ごろ、前日の予約者へ送信)。';
  } catch (e) {
    return 'トリガー設定に失敗しました: ' + e;
  }
}
