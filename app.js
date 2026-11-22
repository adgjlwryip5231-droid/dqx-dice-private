const cfg = window.DQX_CONFIG || {};
const configured = /^https:\/\/[\w.-]+\.supabase\.co\/?$/.test(cfg.SUPABASE_URL || '') && !!cfg.SUPABASE_ANON_KEY;
const base = (cfg.SUPABASE_URL || '').replace(/\/$/, '');
const $ = (id) => document.getElementById(id);
let session = null;
let isAdmin = false;
let records = [];
let slots = [];
let selectedSlot = 1;
let displayLimit = 30;
let refreshing = false;
let refreshTimer = null;
let slotLoadError = '';
let slotsReady = false;
const formatter = new Intl.NumberFormat('ja-JP');
const money = (n) => formatter.format(n);
const STORAGE_KEY = 'dqx_dice_session_v1';

function notify(message, error = false) {
  const el = $('notice');
  el.textContent = message;
  el.className = `notice${error ? ' error' : ''}`;
}
function clearNotice() { $('notice').classList.add('hidden'); }
function setConnection(state, text) {
  $('connectionBadge').className = `status ${state}`;
  $('connectionBadge').textContent = text;
}
function dateInputNow() {
  const d = new Date();
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}
function loadSession() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); }
  catch { localStorage.removeItem(STORAGE_KEY); return null; }
}
function saveSession(value) {
  session = value;
  if (value) localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  else localStorage.removeItem(STORAGE_KEY);
}
async function request(path, { method = 'GET', body = undefined, token = null, headers = {} } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      apikey: cfg.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token || cfg.SUPABASE_ANON_KEY}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...headers
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  let data = null;
  const raw = await response.text();
  if (raw) {
    try { data = JSON.parse(raw); }
    catch { throw new Error('サーバーの返答を読み取れませんでした。'); }
  }
  if (!response.ok) throw new Error(data?.msg || data?.message || data?.error_description || `通信エラー（${response.status}）`);
  return data;
}
async function updateToken() {
  if (!session?.refresh_token) return false;
  try {
    const updated = await request('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: session.refresh_token } });
    saveSession(updated);
    return true;
  } catch {
    saveSession(null);
    isAdmin = false;
    updateAuthUI();
    return false;
  }
}
async function adminRequest(path, options = {}) {
  if (!session?.access_token) throw new Error('ログインが必要です。');
  if (session.expires_at && Date.now() / 1000 > session.expires_at - 60) {
    if (!(await updateToken())) throw new Error('ログイン期限が切れました。');
  }
  return request(path, { ...options, token: session.access_token });
}
async function checkAdmin() {
  isAdmin = false;
  if (!session?.user?.id) { updateAuthUI(); return; }
  try {
    const rows = await adminRequest(`/rest/v1/admin_users?select=id&id=eq.${encodeURIComponent(session.user.id)}&limit=1`);
    isAdmin = Array.isArray(rows) && rows.length === 1;
  } catch {
    isAdmin = false;
  }
  updateAuthUI();
}
function updateSlotUI() {
  const root = $('slotButtons');
  root.replaceChildren();
  for (let i = 1; i <= 10; i++) {
    const entry = slots.find(s => Number(s.slot) === i);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `slot-button${selectedSlot === i ? ' active' : ''}`;
    btn.textContent = entry?.name || `プレイヤー${i}`;
    btn.disabled = !isAdmin || !slotsReady;
    btn.title = !isAdmin ? 'ログイン後に選択できます' : !slotsReady ? '10人分の設定を確認してください' : `${btn.textContent}の収支を表示`;
    btn.addEventListener('click', async () => {
      if (selectedSlot === i || !isAdmin) return;
      selectedSlot = i;
      records = [];
      displayLimit = 30;
      updateSlotUI();
      render();
      if (refreshing) {
        const waitUntilFree = async () => {
          if (refreshing) { window.setTimeout(waitUntilFree, 100); return; }
          await refresh();
        };
        window.setTimeout(waitUntilFree, 100);
      } else await refresh();
    });
    root.append(btn);
  }
  $('slotEdit').classList.toggle('hidden', !isAdmin || !slotsReady);
  const message = $('slotStatus');
  if (message) {
    message.textContent = !isAdmin ? 'ログインすると10人分の記録を切り替えられます。' : slotLoadError ? `切り替え設定エラー：${slotLoadError}` : slotsReady ? `現在の選択：${slots.find(s => Number(s.slot) === selectedSlot)?.name || `プレイヤー${selectedSlot}`}` : '10人分の設定を確認中…';
    message.classList.toggle('slot-error', Boolean(slotLoadError));
  }
  $('slotName').value = slots.find(s => Number(s.slot) === selectedSlot)?.name || `プレイヤー${selectedSlot}`;
}
async function loadSlots() {
  if (!isAdmin) { slots = []; slotsReady = false; slotLoadError = ''; updateSlotUI(); return; }
  slotsReady = false;
  slotLoadError = '';
  updateSlotUI();
  try {
    const data = await adminRequest('/rest/v1/dice_profiles?select=slot,name&order=slot.asc');
    if (!Array.isArray(data) || data.length !== 10 || Array.from({length:10}, (_,i) => i + 1).some(i => !data.some(s => Number(s.slot) === i))) {
      throw new Error('10人分のデータがありません。setup_ten_slots.sqlを実行してください。');
    }
    slots = data;
    slotsReady = true;
    slotLoadError = '';
  } catch (error) {
    slots = [];
    slotLoadError = error.message || '取得に失敗しました。';
    notify(`10人の切り替えが使えません。${slotLoadError}`, true);
  }
  updateSlotUI();
}
function updateAuthUI() {
  $('entryPanel').classList.toggle('hidden', !isAdmin);
  $('viewerLabel').textContent = isAdmin ? `${session.user.email || 'ユーザー'}でログイン中` : 'ログインが必要';
  $('authBtn').textContent = session ? 'ログアウト' : 'ユーザーログイン';
  updateSlotUI();
  render();
}
async function fetchAll() {
  const result = [];
  const pageSize = 1000;
  for (let offset = 0; offset < 20000; offset += pageSize) {
    const chunk = await adminRequest(`/rest/v1/dice_entries?select=id,result,amount,mode,memo,played_at,created_at&profile_slot=eq.${selectedSlot}&order=played_at.desc,id.desc&limit=${pageSize}&offset=${offset}`);
    if (!Array.isArray(chunk)) throw new Error('記録データの形式が不正です。');
    result.push(...chunk);
    if (chunk.length < pageSize) return { records: result, truncated: false };
  }
  return { records: result, truncated: true };
}
async function refresh(showError = true) {
  if (!configured || refreshing) return;
  if (!isAdmin) { records = []; render(); setConnection('offline', 'ログイン待ち'); $('lastUpdated').textContent = 'ログイン後に表示'; return; }
  refreshing = true;
  const requestedSlot = selectedSlot;
  $('refreshBtn').disabled = true;
  try {
    const fetched = await fetchAll();
    if (requestedSlot !== selectedSlot) return;
    records = fetched.records;
    setConnection('online', '非公開データ接続中');
    if (slotLoadError) notify(`10人の切り替えが使えません。${slotLoadError}`, true);
    else if (fetched.truncated) notify('記録が20,000件を超えたため、一部の履歴が集計対象外です。', true);
    else clearNotice();
    $('lastUpdated').textContent = `${new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })} 更新`;
    render();
  } catch (error) {
    if (requestedSlot !== selectedSlot) return;
    setConnection('offline', '取得エラー');
    if (showError) notify(`データを取得できません。${error.message}`, true);
  } finally {
    refreshing = false;
    $('refreshBtn').disabled = false;
  }
}
function filteredRecords() {
  const period = $('periodFilter').value;
  const mode = $('modeFilter').value;
  const result = $('resultFilter').value;
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startWeek = new Date(now.getTime() - 7 * 86400000);
  return records.filter((record) => {
    const at = new Date(record.played_at);
    if (!Number.isFinite(at.getTime())) return false;
    if (period === 'today' && at < startToday) return false;
    if (period === 'week' && at < startWeek) return false;
    if (period === 'month' && at < startMonth) return false;
    if (mode !== 'all' && record.mode !== mode) return false;
    if (result !== 'all' && record.result !== result) return false;
    return true;
  });
}
function render() {
  if (!configured) return;
  const allWins = records.filter((r) => r.result === 'win');
  const allLosses = records.filter((r) => r.result === 'loss');
  const won = allWins.reduce((s, r) => s + Number(r.amount), 0);
  const lost = allLosses.reduce((s, r) => s + Number(r.amount), 0);
  const net = won - lost;
  $('netTotal').innerHTML = `${net >= 0 ? '+' : '−'}${money(Math.abs(net))} <em>G</em>`;
  $('netTotal').className = `huge ${net >= 0 ? 'positive' : 'negative'}`;
  $('winTotal').innerHTML = `${money(won)} <em>G</em>`;
  $('lossTotal').innerHTML = `${money(lost)} <em>G</em>`;
  $('winCount').textContent = `${money(allWins.length)}勝`;
  $('lossCount').textContent = `${money(allLosses.length)}敗`;
  $('winRate').innerHTML = `${records.length ? ((allWins.length / records.length) * 100).toFixed(1) : '—'}<em>%</em>`;
  $('gameCount').textContent = `対戦 ${money(records.length)} 回`;
  const visible = filteredRecords();
  const filteredNet = visible.reduce((sum, r) => sum + (r.result === 'win' ? 1 : -1) * Number(r.amount), 0);
  $('filterSummary').textContent = `絞り込み：${money(visible.length)}件 / 収支 ${filteredNet >= 0 ? '+' : '−'}${money(Math.abs(filteredNet))} G`;
  $('recordCount').textContent = `${money(visible.length)}件中 ${money(Math.min(visible.length, displayLimit))}件表示`;
  $('moreBtn').classList.toggle('hidden', visible.length <= displayLimit);
  const root = $('history');
  root.replaceChildren();
  if (!visible.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'この条件の記録はありません。';
    root.append(empty);
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const r of visible.slice(0, displayLimit)) {
    const row = document.createElement('div');
    row.className = 'history-item';
    const symbol = document.createElement('div');
    symbol.className = `result-symbol ${r.result}`;
    symbol.textContent = r.result === 'win' ? '+' : '−';
    const middle = document.createElement('div');
    middle.className = 'record-main';
    const title = document.createElement('div');
    title.className = 'record-heading';
    title.textContent = `${r.result === 'win' ? 'WIN / 勝ち' : 'LOSE / 負け'}  ·  ${r.mode}`;
    const sub = document.createElement('div');
    sub.className = 'record-sub';
    sub.textContent = `${new Date(r.played_at).toLocaleString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}${r.memo ? ` · ${r.memo}` : ''}`;
    middle.append(title, sub);
    const amount = document.createElement('div');
    amount.className = `record-amount ${r.result === 'win' ? 'positive' : 'negative'}`;
    amount.textContent = `${r.result === 'win' ? '+' : '−'}${money(r.amount)} G`;
    row.append(symbol, middle, amount);
    if (isAdmin) {
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'delete-button';
      del.textContent = '×';
      del.setAttribute('aria-label', 'この記録を削除');
      del.addEventListener('click', () => deleteEntry(r));
      row.append(del);
    }
    fragment.append(row);
  }
  root.append(fragment);
}
async function deleteEntry(entry) {
  if (!isAdmin || !confirm(`${entry.mode} / ${entry.result === 'win' ? '勝ち' : '負け'} ${money(entry.amount)} G を削除しますか？`)) return;
  try {
    await adminRequest(`/rest/v1/dice_entries?id=eq.${encodeURIComponent(entry.id)}`, { method: 'DELETE' });
    await refresh();
  } catch (e) { notify(`削除できません。${e.message}`, true); }
}
// Quick amount buttons fill the existing manual input; manual edits remain possible.
const amountField = $('amount');
const quickAmountButtons = [...document.querySelectorAll('.quick-amount-button')];
function syncQuickAmountSelection() {
  for (const button of quickAmountButtons) {
    button.setAttribute('aria-pressed', String(button.dataset.amount === amountField.value));
  }
}
const quickAmountGroup = document.querySelector('.quick-amount-buttons');
quickAmountGroup?.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-amount]');
  if (!button || !quickAmountGroup.contains(button)) return;
  amountField.value = button.dataset.amount;
  amountField.dispatchEvent(new Event('input', { bubbles: true }));
  amountField.focus({ preventScroll: true });
});
amountField.addEventListener('input', syncQuickAmountSelection);
$('entryForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!isAdmin) return;
  if (!slotsReady) { notify('10人の設定が未完了です。setup_ten_slots.sqlを実行してください。', true); return; }
  const amount = Number($('amount').value);
  const played = new Date($('playedAt').value);
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > 999999999999 || !Number.isFinite(played.getTime())) {
    notify('金額または日時を確認してください。', true);
    return;
  }
  const button = $('saveBtn');
  button.disabled = true;
  try {
    await adminRequest('/rest/v1/dice_entries', {
      method: 'POST',
      body: {
        result: document.querySelector('input[name="result"]:checked').value,
        amount,
        mode: $('entryMode').value,
        memo: $('memo').value.trim(),
        played_at: played.toISOString(),
        profile_slot: selectedSlot
      },
      headers: { Prefer: 'return=minimal' }
    });
    $('amount').value = '';
    syncQuickAmountSelection();
    $('memo').value = '';
    $('playedAt').value = dateInputNow();
    await refresh();
    notify('記録を保存しました。');
  } catch (e) { notify(`保存できません。${e.message}`, true); }
  finally { button.disabled = false; }
});
$('loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('loginError').textContent = '';
  $('loginBtn').disabled = true;
  try {
    const auth = await request('/auth/v1/token?grant_type=password', { method: 'POST', body: { email: $('email').value.trim(), password: $('password').value } });
    saveSession(auth);
    await checkAdmin();
    if (!isAdmin) {
      saveSession(null);
      updateAuthUI();
      throw new Error('このアカウントは利用許可されていません。');
    }
    $('password').value = '';
    $('loginDialog').close();
    await loadSlots();
    await refresh();
    notify('ログインしました。');
  } catch (e) { $('loginError').textContent = e.message; }
  finally { $('loginBtn').disabled = false; }
});
$('authBtn').addEventListener('click', async () => {
  if (session) {
    try { await adminRequest('/auth/v1/logout', { method: 'POST' }); } catch { /* local logout always works */ }
    saveSession(null);
    isAdmin = false;
    records = [];
    slots = [];
    slotsReady = false;
    slotLoadError = '';
    updateAuthUI();
    setConnection('offline', 'ログイン待ち');
    notify('ログアウトしました。');
  } else $('loginDialog').showModal();
});
$('closeLogin').addEventListener('click', () => $('loginDialog').close());
$('loginDialog').addEventListener('click', (event) => { if (event.target === $('loginDialog')) $('loginDialog').close(); });
$('refreshBtn').addEventListener('click', () => refresh());
$('shareBtn').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(location.href.split('?')[0].split('#')[0]);
    notify('URLをコピーしました。データを見るには共通アカウントでログインが必要です。');
  } catch { notify('URLをコピーできません。ブラウザのアドレス欄からコピーしてください。', true); }
});
for (const id of ['periodFilter', 'modeFilter', 'resultFilter']) {
  $(id).addEventListener('change', () => { displayLimit = 30; render(); });
}
$('moreBtn').addEventListener('click', () => { displayLimit += 30; render(); });
$('renameSlot').addEventListener('click', async () => {
  if (!isAdmin || !slotsReady) return;
  const name = $('slotName').value.trim();
  if (!name || name.length > 30) { notify('名前は1〜30文字で入力してください。', true); return; }
  const button = $('renameSlot');
  button.disabled = true;
  try {
    await adminRequest(`/rest/v1/dice_profiles?slot=eq.${selectedSlot}`, {
      method: 'PATCH', body: { name }, headers: { Prefer: 'return=minimal' }
    });
    await loadSlots();
    notify('名前を保存しました。');
  } catch (error) { notify(`名前を変更できません。${error.message}`, true); }
  finally { button.disabled = false; }
});
$('playedAt').value = dateInputNow();
updateSlotUI();
if (!configured) {
  setConnection('offline', '初期設定が必要');
  $('history').replaceChildren();
  notify('公開前の設定が必要です。config.jsにSupabaseのURLと公開用キーを入力してください。', true);
  $('history').textContent = 'データベースの接続設定後に記録が表示されます。';
  $('authBtn').disabled = true;
} else {
  saveSession(loadSession());
  await checkAdmin();
  if (isAdmin) {
    await loadSlots();
  }
  await refresh();
  refreshTimer = setInterval(() => { if (!document.hidden) refresh(false); }, 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(false); });
}
