/* ============================================================================
 * CLOVER — 부부 공동 자산관리 앱
 *
 * 접속 흐름
 *   이메일 회원가입·로그인 → 기기 ID 자동 생성 → 공유공간 생성 또는 참여
 *   → 이후 재접속은 저장된 세션으로 바로 홈 진입
 *
 * 동기화
 *   Supabase Realtime(clv_spaces UPDATE) 우선 + 15초 폴링 백업
 *   저장은 clv_write_space RPC 단일 경로. version 낙관적 잠금으로 덮어쓰기 방지
 *
 * 변경 로그
 *   모든 추가·수정·삭제가 작업자·기기·시각·전값·후값과 함께 clv_audit_logs 에 기록
 * ========================================================================== */
(() => {
  'use strict';

  /* --- 0. 기본 유틸 ------------------------------------------------------- */

  const cfg = window.__CLOVER_CONFIG__ || {};
  const cloudReady =
    /^https:\/\/.+\.supabase\.co$/.test(cfg.supabaseUrl || '') &&
    String(cfg.supabasePublishableKey || '').length > 20 &&
    typeof window.supabase?.createClient === 'function';

  const db = cloudReady
    ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabasePublishableKey, {
        auth: { persistSession: true, autoRefreshToken: true, storageKey: 'clover-auth' }
      })
    : null;

  const DEVICE_KEY = 'clover-device';
  const CACHE_PREFIX = 'clover-cache-';
  const ACTORS = ['현조', '신영'];
  const OWNERS = ['현조', '신영', '공동'];

  const pad = n => String(n).padStart(2, '0');
  const today = () => new Date();
  const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const ym = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  const currentMonth = ym(today());

  const clone = v => JSON.parse(JSON.stringify(v));
  const uid = () =>
    crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const num = v => {
    const n = Number(String(v ?? '').replace(/[,\s]/g, ''));
    return Number.isFinite(n) ? n : 0;
  };
  const won = v => `${Math.round(num(v)).toLocaleString('ko-KR')}원`;
  const esc = v =>
    String(v ?? '').replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
  const monthLabel = m => {
    const [y, n] = String(m).split('-');
    return `${y}년 ${Number(n)}월`;
  };
  const shiftMonth = (m, delta) => {
    const [y, n] = String(m).split('-').map(Number);
    const d = new Date(y, n - 1 + delta, 1);
    return ym(d);
  };
  const monthsBetween = (from, to) => {
    const [fy, fm] = String(from).split('-').map(Number);
    const [ty, tm] = String(to).split('-').map(Number);
    return (ty - fy) * 12 + (tm - fm);
  };
  const monthOf = date => String(date || '').slice(0, 7);
  const randomText = len =>
    Array.from(crypto.getRandomValues(new Uint8Array(len)))
      .map(v => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[v % 32])
      .join('');
  const fmtTime = iso =>
    new Intl.DateTimeFormat('ko-KR', {
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
    }).format(new Date(iso));

  async function sha256(text) {
    const bytes = new TextEncoder().encode(text);
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
  }

  /* --- 1. 적용 시작월 이력 ------------------------------------------------ */
  /* 과거 금액을 유지한 채 특정 월부터 새 금액을 적용하기 위한 구조.
     history = [{ from: 'YYYY-MM', amount: number }, ...]                     */

  function historyValue(history, month) {
    const rows = (history || [])
      .filter(x => String(x.from) <= String(month))
      .sort((a, b) => String(a.from).localeCompare(String(b.from)));
    return rows.length ? num(rows[rows.length - 1].amount) : 0;
  }

  function historyFrom(history, month) {
    const rows = (history || [])
      .filter(x => String(x.from) <= String(month))
      .sort((a, b) => String(a.from).localeCompare(String(b.from)));
    return rows.length ? rows[rows.length - 1].from : (history?.[0]?.from ?? month);
  }

  function setHistory(history, from, amount) {
    const key = String(from || currentMonth).slice(0, 7);
    const row = history.find(x => x.from === key);
    if (row) row.amount = num(amount);
    else history.push({ from: key, amount: num(amount) });
    history.sort((a, b) => String(a.from).localeCompare(String(b.from)));
    return history;
  }

  /* --- 2. 상태 스키마 ----------------------------------------------------- */

  function emptyState() {
    return {
      schemaVersion: 3,
      recurringIncomes: [],  // 정기소득
      fixedCosts: [],        // 월 고정비
      utilities: [],         // 공과금 항목(예상금액 이력)
      savings: [],           // 적금·저축
      assets: [],            // 보유 자산·부채
      budgets: [],           // 생활비 예산
      bonuses: [],           // 보너스·상여금 (지급일 기준)
      transactions: [],      // 생활비 사용내역 (사용일 기준)
      scenarios: [],         // 포캐스팅 시나리오
      goals: [],             // 자산 목표
      monthly: {}            // { 'YYYY-MM': { utilityActuals: { [utilityId]: number } } }
    };
  }

  function seedState() {
    const s = emptyState();
    const h = amount => [{ from: currentMonth, amount }];
    s.recurringIncomes = [
      { id: uid(), name: '현조 월급', owner: '현조', history: h(0) },
      { id: uid(), name: '신영 월급', owner: '신영', history: h(0) }
    ];
    s.fixedCosts = [{ id: uid(), name: '월세', owner: '공동', history: h(0) }];
    s.utilities = [
      { id: uid(), name: '전기세', estimateHistory: h(0) },
      { id: uid(), name: '수도세', estimateHistory: h(0) },
      { id: uid(), name: '도시가스', estimateHistory: h(0) },
      { id: uid(), name: '관리비', estimateHistory: h(0) }
    ];
    s.savings = [{ id: uid(), name: '주택청약', owner: '공동', history: h(0) }];
    s.assets = [
      { id: uid(), name: '입출금 계좌', kind: 'asset', category: '현금', owner: '공동',
        amount: 0, asOf: ymd(today()), memo: '' }
    ];
    s.budgets = [
      { id: uid(), name: '현조 생활비', owner: '현조', history: h(0) },
      { id: uid(), name: '신영 생활비', owner: '신영', history: h(0) },
      { id: uid(), name: '공동 생활비', owner: '공동', history: h(0) }
    ];
    return s;
  }

  /* 과거 버전 데이터와 결측 필드를 안전하게 보정 */
  function migrate(raw) {
    const s = Object.assign(emptyState(), raw && typeof raw === 'object' ? clone(raw) : {});
    s.schemaVersion = 3;

    for (const key of ['recurringIncomes', 'fixedCosts', 'utilities', 'savings', 'assets',
                       'budgets', 'bonuses', 'transactions', 'scenarios', 'goals']) {
      if (!Array.isArray(s[key])) s[key] = [];
    }
    if (!s.monthly || typeof s.monthly !== 'object') s.monthly = {};

    const fixHistory = (x, field) => {
      if (!Array.isArray(x[field]) || !x[field].length) {
        x[field] = [{ from: currentMonth, amount: num(x.amount) }];
      }
      x[field] = x[field]
        .map(r => ({ from: String(r.from || currentMonth).slice(0, 7), amount: num(r.amount) }))
        .sort((a, b) => a.from.localeCompare(b.from));
    };

    for (const x of s.recurringIncomes) {
      x.id ||= uid(); x.name ||= '이름 없음';
      if (!OWNERS.includes(x.owner)) x.owner = '공동';
      fixHistory(x, 'history');
    }
    for (const x of s.fixedCosts) {
      x.id ||= uid(); x.name ||= '이름 없음';
      if (!OWNERS.includes(x.owner)) x.owner = '공동';
      fixHistory(x, 'history');
    }
    for (const x of s.utilities) {
      x.id ||= uid(); x.name ||= '이름 없음';
      fixHistory(x, 'estimateHistory');
      delete x.estimate;
    }
    for (const x of s.savings) {
      x.id ||= uid(); x.name ||= '이름 없음';
      if (!OWNERS.includes(x.owner)) x.owner = '공동';
      fixHistory(x, 'history');
    }
    for (const x of s.budgets) {
      x.id ||= uid(); x.name ||= '이름 없음';
      if (!OWNERS.includes(x.owner)) x.owner = '공동';
      fixHistory(x, 'history');
    }
    for (const x of s.assets) {
      x.id ||= uid(); x.name ||= '이름 없음';
      x.kind = x.kind === 'debt' ? 'debt' : 'asset';
      x.category ||= '기타';
      if (!OWNERS.includes(x.owner)) x.owner = '공동';
      x.amount = num(x.amount);
      x.asOf ||= ymd(today());
      x.memo ||= '';
    }
    for (const x of s.bonuses) {
      x.id ||= uid(); x.name ||= '보너스';
      if (!OWNERS.includes(x.owner)) x.owner = '공동';
      x.date ||= `${currentMonth}-01`;
      x.amount = num(x.amount);
      x.memo ||= '';
    }
    for (const x of s.transactions) {
      x.id ||= uid();
      if (!OWNERS.includes(x.owner)) x.owner = '공동';
      x.date ||= ymd(today());
      x.category ||= '기타';
      x.place ||= '';
      x.amount = num(x.amount);
      x.memo ||= '';
    }
    for (const x of s.scenarios) {
      x.id ||= uid(); x.name ||= '시나리오';
      x.startMonth = String(x.startMonth || currentMonth).slice(0, 7);
      x.months = Math.min(600, Math.max(1, num(x.months) || 12));
      x.annualReturn = num(x.annualReturn);
      x.monthlyAdjustment = num(x.monthlyAdjustment);
      if (!Array.isArray(x.savingIds)) x.savingIds = null;   // null = 전체 포함
      if (!Array.isArray(x.assetIds)) x.assetIds = null;
      if (!Array.isArray(x.debtIds)) x.debtIds = null;
      x.includeBonus = x.includeBonus === true;
      x.goalId ||= '';
    }
    for (const x of s.goals) {
      x.id ||= uid(); x.name ||= '목표';
      x.target = num(x.target);
      x.dueDate ||= '';
      x.scenarioId ||= '';
      x.memo ||= '';
    }
    for (const key of Object.keys(s.monthly)) {
      const m = s.monthly[key];
      if (!m || typeof m !== 'object') { delete s.monthly[key]; continue; }
      if (!m.utilityActuals || typeof m.utilityActuals !== 'object') m.utilityActuals = {};
      // 구버전(monthly 안에 보너스·거래가 들어있던 형태) 흡수
      if (Array.isArray(m.bonuses)) {
        for (const b of m.bonuses) {
          s.bonuses.push({ id: b.id || uid(), name: b.name || '보너스',
            owner: OWNERS.includes(b.owner) ? b.owner : '공동',
            date: b.date || `${key}-01`, amount: num(b.amount), memo: b.memo || '' });
        }
        delete m.bonuses;
      }
      if (Array.isArray(m.transactions)) {
        for (const t of m.transactions) {
          s.transactions.push({ id: t.id || uid(),
            owner: OWNERS.includes(t.owner) ? t.owner : '공동',
            date: t.date || `${key}-01`, category: t.category || '기타',
            place: t.place || '', amount: num(t.amount), memo: t.memo || '' });
        }
        delete m.transactions;
      }
    }
    return s;
  }

  /* --- 3. 앱 런타임 상태 -------------------------------------------------- */

  const app = {
    session: null,
    device: null,          // { id }
    space: null,           // { code, name, actor, secret? }
    state: emptyState(),
    version: 0,
    screen: 'boot',        // boot | auth | space | app
    authMode: 'login',     // login | signup
    tab: 'home',
    month: currentMonth,
    sync: '준비 중',
    syncTone: 'idle',      // idle | ok | busy | warn | error
    logs: [],
    logFilter: { actor: '', action: '', entityType: '' },
    busy: false,
    online: navigator.onLine,
    pending: [],           // 네트워크 실패로 아직 서버에 못 올린 변경
    expanded: new Set(),   // 로그 전후값 펼침
    channel: null,
    pollTimer: null,
    deferredRender: false,
    lastError: ''
  };

  function loadDevice() {
    try {
      const saved = JSON.parse(localStorage.getItem(DEVICE_KEY) || 'null');
      if (saved?.id) return saved;
    } catch { /* 손상된 값은 새로 만든다 */ }
    const fresh = { id: uid(), createdAt: new Date().toISOString() };
    localStorage.setItem(DEVICE_KEY, JSON.stringify(fresh));
    return fresh;
  }

  function setSync(text, tone = 'idle') {
    app.sync = text;
    app.syncTone = tone;
  }

  /* --- 4. 계산 ----------------------------------------------------------- */

  const sumHistory = (list, month) =>
    list.reduce((sum, x) => sum + historyValue(x.history, month), 0);

  const bonusesOf = month => app.state.bonuses.filter(b => monthOf(b.date) === month);
  const transactionsOf = month =>
    app.state.transactions.filter(t => monthOf(t.date) === month);

  const incomeBase = month => sumHistory(app.state.recurringIncomes, month);
  const bonusTotal = month => bonusesOf(month).reduce((s, b) => s + num(b.amount), 0);
  const incomeTotal = month => incomeBase(month) + bonusTotal(month);
  const fixedTotal = month => sumHistory(app.state.fixedCosts, month);
  const savingTotal = month => sumHistory(app.state.savings, month);

  function utilityAmount(utility, month) {
    const actual = app.state.monthly[month]?.utilityActuals?.[utility.id];
    return actual === undefined || actual === null || actual === ''
      ? historyValue(utility.estimateHistory, month)
      : num(actual);
  }
  const utilityTotal = month =>
    app.state.utilities.reduce((s, u) => s + utilityAmount(u, month), 0);
  const spendTotal = month =>
    transactionsOf(month).reduce((s, t) => s + num(t.amount), 0);
  const spendByOwner = (month, owner) =>
    transactionsOf(month).filter(t => t.owner === owner)
      .reduce((s, t) => s + num(t.amount), 0);
  const budgetByOwner = (month, owner) =>
    app.state.budgets.filter(b => b.owner === owner)
      .reduce((s, b) => s + historyValue(b.history, month), 0);

  const assetTotal = () =>
    app.state.assets.filter(a => a.kind === 'asset').reduce((s, a) => s + num(a.amount), 0);
  const debtTotal = () =>
    app.state.assets.filter(a => a.kind === 'debt').reduce((s, a) => s + num(a.amount), 0);
  const netAssets = () => assetTotal() - debtTotal();

  function summary(month = app.month) {
    const base = incomeBase(month);
    const bonus = bonusTotal(month);
    const income = base + bonus;
    const saving = savingTotal(month);
    const fixed = fixedTotal(month);
    const utility = utilityTotal(month);
    const spend = spendTotal(month);
    const expense = fixed + utility + spend;
    return {
      base, bonus, income, saving, fixed, utility, spend, expense,
      remaining: income - saving - expense,
      savingRate: income > 0 ? (saving / income) * 100 : 0
    };
  }

  /* 포캐스팅 — 월별로 그 시점의 실제 적금 설정값을 사용한다 */
  function runForecast(sc, maxMonths = null) {
    const start = String(sc.startMonth || currentMonth).slice(0, 7);
    const rate = num(sc.annualReturn) / 100 / 12;

    const savings = sc.savingIds
      ? app.state.savings.filter(x => sc.savingIds.includes(x.id))
      : app.state.savings;
    const assets = sc.assetIds
      ? app.state.assets.filter(x => x.kind === 'asset' && sc.assetIds.includes(x.id))
      : app.state.assets.filter(x => x.kind === 'asset');
    const debts = sc.debtIds
      ? app.state.assets.filter(x => x.kind === 'debt' && sc.debtIds.includes(x.id))
      : app.state.assets.filter(x => x.kind === 'debt');

    const startValue =
      assets.reduce((s, x) => s + num(x.amount), 0) -
      debts.reduce((s, x) => s + num(x.amount), 0);

    const total = maxMonths ?? Math.max(1, num(sc.months));
    let value = startValue;
    let contributions = 0;
    const series = [];

    for (let i = 0; i < total; i++) {
      const m = shiftMonth(start, i);
      const add =
        savings.reduce((s, x) => s + historyValue(x.history, m), 0) +
        num(sc.monthlyAdjustment) +
        (sc.includeBonus ? bonusTotal(m) : 0);
      value = value * (1 + rate) + add;
      contributions += add;
      series.push({ month: m, value });
    }

    return {
      startValue,
      future: value,
      contributions,
      returns: value - startValue - contributions,
      series
    };
  }

  /* 목표 도달 예상월 — 최대 50년까지 탐색 */
  function goalProjection(sc, target) {
    if (!(target > 0)) return null;
    const long = runForecast(sc, 600);
    if (long.startValue >= target) return { month: sc.startMonth, months: 0 };
    const hit = long.series.findIndex(p => p.value >= target);
    return hit === -1 ? null : { month: long.series[hit].month, months: hit + 1 };
  }

  /* --- 5. 서버 통신 ------------------------------------------------------- */

  const isNetworkError = e => {
    const m = String(e?.message || '').toLowerCase();
    return !navigator.onLine || m.includes('fetch') || m.includes('network') ||
           m.includes('failed to fetch') || m.includes('timeout');
  };

  function cacheState() {
    if (!app.space) return;
    try {
      localStorage.setItem(
        `${CACHE_PREFIX}${app.space.code}`,
        JSON.stringify({ state: app.state, version: app.version })
      );
    } catch { /* 저장공간 부족은 무시 — 서버가 원본이다 */ }
  }

  function restoreCache(code) {
    try {
      const raw = JSON.parse(localStorage.getItem(`${CACHE_PREFIX}${code}`) || 'null');
      if (raw?.state) {
        app.state = migrate(raw.state);
        app.version = num(raw.version);
        return true;
      }
    } catch { /* 손상 캐시는 무시 */ }
    return false;
  }

  async function readSpace({ force = false, quiet = false } = {}) {
    if (!app.space || !db) return;
    const { data, error } = await db.rpc('clv_read_space', { p_space_code: app.space.code });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) throw new Error('공유공간을 찾을 수 없습니다.');

    if (num(row.version) !== app.version || force) {
      const changedByOther = row.updated_by && row.updated_by !== app.space.actor;
      app.state = migrate(row.state);
      app.version = num(row.version);
      app.space.name = row.space_name || app.space.name;
      cacheState();
      if (!quiet) {
        setSync(changedByOther ? `${row.updated_by}님 변경 반영` : '동기화 완료', 'ok');
      }
      requestRender();
    } else if (!quiet) {
      setSync('동기화 완료', 'ok');
      requestRender();
    }
  }

  async function loadLogs() {
    if (!app.space || !db) return;
    const { data, error } = await db.rpc('clv_read_logs', {
      p_space_code: app.space.code,
      p_limit: 300,
      p_actor: app.logFilter.actor || null,
      p_action: app.logFilter.action || null,
      p_entity_type: app.logFilter.entityType || null
    });
    if (error) throw error;
    app.logs = data || [];
    requestRender();
  }

  /* 모든 쓰기의 단일 경로.
     mutator(state) 로 상태를 바꾸고, 그 결과를 로그와 함께 원자적으로 저장한다. */
  async function mutate(mutator, meta) {
    if (app.busy) return false;
    app.busy = true;

    const snapshot = clone(app.state);
    const snapVersion = app.version;
    const before = meta.pick ? meta.pick(snapshot) : null;

    mutator(app.state);
    app.state = migrate(app.state);
    const after = meta.pick ? meta.pick(app.state) : null;

    setSync('저장 중', 'busy');
    render();

    const payload = () => ({
      p_space_code: app.space.code,
      p_expected_version: app.version,
      p_state: app.state,
      p_actor: app.space.actor,
      p_device_id: app.device.id,
      p_action: meta.action,
      p_entity_type: meta.type,
      p_entity_id: meta.id || null,
      p_summary: meta.summary,
      p_before_data: before === undefined ? null : before,
      p_after_data: after === undefined ? null : after
    });

    try {
      if (!db || !app.space) throw new Error('공유공간이 연결되지 않았습니다.');

      let { data, error } = await db.rpc('clv_write_space', payload());
      if (error) throw error;
      let row = Array.isArray(data) ? data[0] : data;

      // 상대방이 먼저 저장한 경우: 최신 상태 위에 내 변경만 다시 얹어 한 번 재시도
      if (row?.conflict) {
        setSync('상대방 변경과 충돌 — 병합 중', 'warn');
        render();

        app.state = migrate(row.state);
        app.version = num(row.version);
        const mergedBefore = meta.pick ? meta.pick(clone(app.state)) : null;
        mutator(app.state);
        app.state = migrate(app.state);
        const mergedAfter = meta.pick ? meta.pick(app.state) : null;

        const retry = payload();
        retry.p_before_data = mergedBefore === undefined ? null : mergedBefore;
        retry.p_after_data = mergedAfter === undefined ? null : mergedAfter;

        ({ data, error } = await db.rpc('clv_write_space', retry));
        if (error) throw error;
        row = Array.isArray(data) ? data[0] : data;

        if (row?.conflict) {
          app.state = snapshot;
          app.version = snapVersion;
          setSync('충돌로 저장 실패 — 다시 시도해주세요', 'error');
          toast('상대방이 같은 시각에 수정했습니다. 화면을 확인하고 다시 시도해주세요.');
          return false;
        }
      }

      app.version = num(row.version);
      cacheState();
      setSync('동기화 완료', 'ok');
      toast(meta.success || '저장했습니다.');
      if (app.tab === 'logs') await loadLogs().catch(() => {});
      return true;

    } catch (e) {
      if (isNetworkError(e)) {
        // 네트워크 장애: 화면의 변경은 유지하고 캐시에 남긴 뒤 복구 시 재전송한다
        app.pending.push({ mutator, meta });
        cacheState();
        setSync(`오프라인 — 미저장 ${app.pending.length}건`, 'warn');
        toast('네트워크가 끊겼습니다. 연결되면 자동으로 다시 저장합니다.');
        return false;
      }
      app.state = snapshot;
      app.version = snapVersion;
      app.lastError = e.message || String(e);
      setSync('저장 실패', 'error');
      toast(app.lastError);
      return false;

    } finally {
      app.busy = false;
      render();
    }
  }

  /* 온라인 복귀 시 밀린 변경 재전송 */
  async function flushPending() {
    if (!app.pending.length || !db || !app.space) return;
    setSync(`재동기화 중 (${app.pending.length}건)`, 'busy');
    render();
    try {
      await readSpace({ force: true, quiet: true });
    } catch { /* 읽기 실패 시에도 아래에서 저장을 시도한다 */ }

    const queue = app.pending.slice();
    app.pending = [];
    for (const job of queue) {
      const ok = await mutate(job.mutator, job.meta);
      if (!ok) break;   // 실패 시 mutate 가 다시 큐에 넣는다
    }
    if (!app.pending.length) {
      setSync('재동기화 완료', 'ok');
      render();
    }
  }

  /* --- 6. 실시간 동기화 --------------------------------------------------- */

  function startRealtime() {
    stopRealtime();
    if (!db || !app.space) return;

    app.channel = db
      .channel(`clover-${app.space.code}`)
      .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'clv_spaces',
          filter: `space_code=eq.${app.space.code}` },
        payload => {
          const next = payload?.new;
          if (!next || num(next.version) <= app.version) return;
          const byOther = next.updated_by && next.updated_by !== app.space.actor;
          app.state = migrate(next.state);
          app.version = num(next.version);
          cacheState();
          setSync(byOther ? `${next.updated_by}님 변경 반영` : '동기화 완료', 'ok');
          requestRender();
          if (app.tab === 'logs') loadLogs().catch(() => {});
        })
      .subscribe(status => {
        if (status === 'SUBSCRIBED') setSync('실시간 연결됨', 'ok');
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          setSync('실시간 끊김 — 주기 확인으로 전환', 'warn');
        }
        requestRender();
      });

    // Realtime 이 끊겨도 데이터가 밀리지 않도록 하는 백업 경로
    clearInterval(app.pollTimer);
    app.pollTimer = setInterval(() => {
      if (!app.online || app.busy) return;
      readSpace({ quiet: true }).catch(() => {
        setSync('연결 확인 중', 'warn');
        requestRender();
      });
    }, 15000);
  }

  function stopRealtime() {
    if (app.channel) { try { db.removeChannel(app.channel); } catch {} app.channel = null; }
    clearInterval(app.pollTimer);
    app.pollTimer = null;
  }

  window.addEventListener('online', () => {
    app.online = true;
    setSync('연결 복구 — 재동기화', 'busy');
    render();
    flushPending().catch(() => {});
  });
  window.addEventListener('offline', () => {
    app.online = false;
    setSync('오프라인', 'warn');
    render();
  });

  /* --- 7. 라벨 ------------------------------------------------------------ */

  const ENTITY_LABEL = {
    income: '정기소득', bonus: '보너스·상여금', fixed: '월 고정비',
    utility: '공과금 항목', utilityActual: '공과금 실제금액', saving: '적금·저축',
    asset: '자산·부채', budget: '생활비 예산', transaction: '생활비 내역',
    scenario: '포캐스팅 시나리오', goal: '자산 목표', settings: '설정',
    space: '공유공간', device: '기기'
  };
  const ACTION_LABEL = {
    create: '추가', update: '수정', delete: '삭제', connect: '접속', system: '시스템'
  };
  const FIELD_LABEL = {
    name: '항목명', owner: '소유자', amount: '금액', date: '일자', memo: '메모',
    category: '카테고리', place: '사용처', kind: '구분', asOf: '기준일',
    target: '목표 금액', dueDate: '목표일', months: '기간(개월)',
    annualReturn: '연 기대수익률(%)', monthlyAdjustment: '월 추가 저축·조정액',
    startMonth: '기준 시작월', history: '금액 이력', estimateHistory: '예상금액 이력',
    includeBonus: '보너스 포함', goalId: '연결 목표', scenarioId: '연결 시나리오',
    savingIds: '포함 적금', assetIds: '포함 자산', debtIds: '포함 부채', actor: '사용자'
  };

  const listOf = (kind, state = app.state) => ({
    income: state.recurringIncomes, fixed: state.fixedCosts, utility: state.utilities,
    saving: state.savings, asset: state.assets, budget: state.budgets,
    bonus: state.bonuses, transaction: state.transactions,
    scenario: state.scenarios, goal: state.goals
  }[kind] || null);

  const findEntity = (kind, id, state = app.state) =>
    listOf(kind, state)?.find(x => x.id === id) || null;

  const entityName = (kind, id, state = app.state) =>
    findEntity(kind, id, state)?.name || '(삭제됨)';

  /* --- 8. 렌더 보조 ------------------------------------------------------- */

  function requestRender() {
    // 입력 중에 화면을 통째로 다시 그리면 타이핑이 끊긴다. 포커스가 있으면 미룬다.
    const active = document.activeElement;
    if (active && ['INPUT', 'SELECT', 'TEXTAREA'].includes(active.tagName)) {
      app.deferredRender = true;
      showLiveBanner(true);
      return;
    }
    render();
  }

  function showLiveBanner(show) {
    const el = document.querySelector('#liveBanner');
    if (el) el.classList.toggle('show', show);
  }

  function toast(message) {
    const n = document.querySelector('#toast');
    if (!n) return;
    n.textContent = message;
    n.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => n.classList.remove('show'), 2600);
  }

  const ownerSelect = (name, value) =>
    `<select name="${name}">${OWNERS.map(o =>
      `<option value="${o}" ${value === o ? 'selected' : ''}>${o}</option>`).join('')}</select>`;

  const monthNav = () => `
    <div class="month-nav">
      <button type="button" class="icon-btn" data-shift="-1" aria-label="이전 달">‹</button>
      <input id="monthPicker" type="month" value="${app.month}" aria-label="조회 월">
      <button type="button" class="icon-btn" data-shift="1" aria-label="다음 달">›</button>
    </div>`;

  const emptyRow = text => `<p class="empty">${esc(text)}</p>`;

  /* --- 9. 화면: 로그인 ---------------------------------------------------- */

  function authView() {
    const signup = app.authMode === 'signup';
    return `
      <main class="center">
        <section class="center-card">
          <div class="logo">🍀</div>
          <h1>CLOVER</h1>
          <p class="lead">부부가 함께 쓰는 자산관리 앱입니다.<br>
            ${signup ? '이메일과 비밀번호로 계정을 만듭니다.' : '가입한 이메일로 로그인합니다.'}</p>
          ${app.lastError ? `<p class="alert">${esc(app.lastError)}</p>` : ''}
          <form id="authForm" class="stack">
            <label class="field">
              <span>이메일</span>
              <input name="email" type="email" autocomplete="email" required
                     placeholder="example@mail.com">
            </label>
            <label class="field">
              <span>비밀번호</span>
              <input name="password" type="password" minlength="6" required
                     autocomplete="${signup ? 'new-password' : 'current-password'}"
                     placeholder="6자 이상">
            </label>
            <button class="primary" type="submit">
              ${signup ? '가입하고 시작하기' : '로그인'}
            </button>
          </form>
          <button class="link" type="button" data-auth-mode="${signup ? 'login' : 'signup'}">
            ${signup ? '이미 계정이 있습니다 · 로그인' : '처음이신가요? 계정 만들기'}
          </button>
        </section>
      </main>`;
  }

  /* --- 10. 화면: 공유공간 연결 -------------------------------------------- */

  function spaceView() {
    return `
      <main class="center">
        <section class="center-card wide">
          <div class="logo">🏠</div>
          <h1>공유공간 연결</h1>
          <p class="lead">첫 번째 휴대폰에서 공유공간을 만들고,<br>
            두 번째 휴대폰에서 발급된 연결코드를 한 번만 입력합니다.</p>
          ${app.lastError ? `<p class="alert">${esc(app.lastError)}</p>` : ''}

          <div class="grid two">
            <form id="createSpaceForm" class="card stack">
              <h3>새 공유공간 만들기</h3>
              <label class="field"><span>공간 이름</span>
                <input name="spaceName" value="우리집" required></label>
              <label class="field"><span>이 휴대폰 사용자</span>
                <select name="actor">${ACTORS.map(a =>
                  `<option>${a}</option>`).join('')}</select></label>
              <button class="primary" type="submit">공유공간 생성</button>
            </form>

            <form id="joinSpaceForm" class="card stack">
              <h3>기존 공유공간 참여</h3>
              <label class="field"><span>이 휴대폰 사용자</span>
                <select name="actor">${ACTORS.map(a =>
                  `<option ${a === '신영' ? 'selected' : ''}>${a}</option>`).join('')}</select></label>
              <label class="field"><span>공유코드</span>
                <input name="code" placeholder="예: ABC123" required></label>
              <label class="field"><span>연결키</span>
                <input name="secret" placeholder="발급된 연결키" required></label>
              <button class="secondary" type="submit">연결하기</button>
            </form>
          </div>

          <p class="hint">코드와 연결키를 함께 붙여넣어도 됩니다. 예) <b>ABC123.KEY...</b></p>
          <button class="link" type="button" data-signout>다른 계정으로 로그인</button>
        </section>
      </main>`;
  }

  /* --- 11. 화면: 홈 ------------------------------------------------------- */

  function homeView() {
    const s = summary();
    const budgetRows = OWNERS.map(owner => {
      const budget = budgetByOwner(app.month, owner);
      const used = spendByOwner(app.month, owner);
      const rate = budget > 0 ? Math.round((used / budget) * 100) : 0;
      const tone = budget > 0 && used > budget ? 'over' : '';
      return `
        <div class="budget-row ${tone}">
          <div class="budget-top"><span>${owner}</span>
            <b>${won(used)}${budget > 0 ? ` / ${won(budget)}` : ''}</b></div>
          <div class="bar"><i style="width:${Math.min(100, rate)}%"></i></div>
          <small>${budget > 0 ? `예산의 ${rate}% 사용` : '예산 미설정 — 설정 탭에서 추가'}</small>
        </div>`;
    }).join('');

    return `
      <section class="page">
        <div class="page-head">
          <div><span class="eyebrow">홈</span><h2>${monthLabel(app.month)}</h2></div>
          ${monthNav()}
        </div>

        <div class="hero">
          <div class="hero-item">
            <small>이번 달 남는 금액</small>
            <strong class="${s.remaining < 0 ? 'minus' : ''}">${won(s.remaining)}</strong>
            <small>총수입 − 적금·저축 − 총지출</small>
          </div>
          <div class="hero-item">
            <small>현재 순자산</small>
            <strong>${won(netAssets())}</strong>
            <small>자산 ${won(assetTotal())} − 부채 ${won(debtTotal())}</small>
          </div>
        </div>

        <div class="grid three">
          <article class="card metric"><small>총수입</small><strong>${won(s.income)}</strong>
            <small>정기 ${won(s.base)} + 보너스 ${won(s.bonus)}</small></article>
          <article class="card metric"><small>적금·저축</small><strong>${won(s.saving)}</strong>
            <small>저축률 ${s.savingRate.toFixed(1)}%</small></article>
          <article class="card metric"><small>총지출</small><strong>${won(s.expense)}</strong>
            <small>고정비·공과금·생활비</small></article>
        </div>

        <div class="grid two">
          <article class="card">
            <div class="card-head"><h3>이번 달 돈의 흐름</h3></div>
            <div class="flow">
              <div><span>정기소득</span><b>${won(s.base)}</b></div>
              <div><span>보너스·상여금</span><b>${won(s.bonus)}</b></div>
              <div class="sum"><span>총수입</span><b>${won(s.income)}</b></div>
              <div><span>적금·저축</span><b class="minus">−${won(s.saving)}</b></div>
              <div><span>월 고정비</span><b class="minus">−${won(s.fixed)}</b></div>
              <div><span>공과금</span><b class="minus">−${won(s.utility)}</b></div>
              <div><span>생활비 사용</span><b class="minus">−${won(s.spend)}</b></div>
              <div class="sum"><span>남는 금액</span>
                <b class="${s.remaining < 0 ? 'minus' : 'plus'}">${won(s.remaining)}</b></div>
            </div>
          </article>

          <article class="card">
            <div class="card-head"><h3>생활비 예산 대비 사용</h3></div>
            <div class="budget-list">${budgetRows}</div>
          </article>
        </div>
      </section>`;
  }

  /* --- 12. 화면: 월별 ----------------------------------------------------- */

  function bonusRows() {
    const list = bonusesOf(app.month)
      .sort((a, b) => String(a.date).localeCompare(String(b.date)));
    if (!list.length) return emptyRow('이 달에 등록된 보너스·상여금이 없습니다.');
    return list.map(x => `
      <form class="item" data-row="bonus" data-id="${x.id}">
        <label class="field"><span>항목명</span><input name="name" value="${esc(x.name)}"></label>
        <label class="field"><span>수령자</span>${ownerSelect('owner', x.owner)}</label>
        <label class="field"><span>지급일</span>
          <input name="date" type="date" value="${esc(x.date)}"></label>
        <label class="field"><span>금액</span>
          <input name="amount" inputmode="numeric" value="${num(x.amount)}"></label>
        <label class="field wide"><span>메모</span>
          <input name="memo" value="${esc(x.memo)}"></label>
        <div class="item-actions">
          <button class="secondary" type="submit">수정 저장</button>
          <button class="danger" type="button" data-delete="bonus" data-id="${x.id}">삭제</button>
        </div>
      </form>`).join('');
  }

  function transactionRows() {
    const filter = app.txFilter || { owner: '', category: '' };
    let list = transactionsOf(app.month);
    if (filter.owner) list = list.filter(t => t.owner === filter.owner);
    if (filter.category) list = list.filter(t => t.category === filter.category);
    list = list.sort((a, b) => String(b.date).localeCompare(String(a.date)));

    if (!list.length) return emptyRow('조건에 맞는 사용내역이 없습니다.');
    return list.map(x => `
      <form class="item" data-row="transaction" data-id="${x.id}">
        <label class="field"><span>사용일</span>
          <input name="date" type="date" value="${esc(x.date)}"></label>
        <label class="field"><span>사용자</span>${ownerSelect('owner', x.owner)}</label>
        <label class="field"><span>카테고리</span>
          <input name="category" value="${esc(x.category)}" list="categoryList"></label>
        <label class="field"><span>사용처</span>
          <input name="place" value="${esc(x.place)}"></label>
        <label class="field"><span>금액</span>
          <input name="amount" inputmode="numeric" value="${num(x.amount)}"></label>
        <label class="field wide"><span>메모</span>
          <input name="memo" value="${esc(x.memo)}"></label>
        <div class="item-actions">
          <button class="secondary" type="submit">수정 저장</button>
          <button class="danger" type="button" data-delete="transaction" data-id="${x.id}">삭제</button>
        </div>
      </form>`).join('');
  }

  function monthlyView() {
    const filter = app.txFilter || { owner: '', category: '' };
    const categories = [...new Set(app.state.transactions.map(t => t.category).filter(Boolean))];
    const monthSpend = spendTotal(app.month);

    return `
      <section class="page">
        <div class="page-head">
          <div><span class="eyebrow">월별</span><h2>${monthLabel(app.month)} 변동 입력</h2></div>
          ${monthNav()}
        </div>

        <article class="card">
          <div class="card-head">
            <h3>보너스·상여금</h3>
            <button class="secondary" type="button" data-add="bonus">추가</button>
          </div>
          <div class="list">${bonusRows()}</div>
        </article>

        <article class="card">
          <div class="card-head"><h3>공과금 실제 금액</h3>
            <span class="note">비우면 예상금액으로 계산합니다</span></div>
          <div class="list">
            ${app.state.utilities.length ? app.state.utilities.map(u => {
              const actual = app.state.monthly[app.month]?.utilityActuals?.[u.id];
              const estimate = historyValue(u.estimateHistory, app.month);
              return `
                <form class="item compact" data-row="utility-actual" data-id="${u.id}">
                  <label class="field"><span>항목</span>
                    <input value="${esc(u.name)}" disabled></label>
                  <label class="field"><span>실제 금액</span>
                    <input name="amount" inputmode="numeric"
                           value="${actual === undefined || actual === null ? '' : num(actual)}"
                           placeholder="예상 ${estimate.toLocaleString('ko-KR')}"></label>
                  <div class="item-actions">
                    <button class="secondary" type="submit">저장</button>
                    <button class="ghost" type="button"
                            data-clear-utility="${u.id}">비우기</button>
                  </div>
                </form>`;
            }).join('') : emptyRow('공과금 항목이 없습니다. 설정 탭에서 추가해주세요.')}
          </div>
        </article>

        <article class="card">
          <div class="card-head">
            <h3>생활비 사용내역</h3>
            <button class="secondary" type="button" data-add="transaction">추가</button>
          </div>

          <div class="filter-bar">
            <label class="field"><span>사용자</span>
              <select data-tx-filter="owner">
                <option value="">전체</option>
                ${OWNERS.map(o => `<option ${filter.owner === o ? 'selected' : ''}>${o}</option>`).join('')}
              </select></label>
            <label class="field"><span>카테고리</span>
              <select data-tx-filter="category">
                <option value="">전체</option>
                ${categories.map(c =>
                  `<option ${filter.category === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}
              </select></label>
          </div>

          <div class="totals">
            <div><span>이 달 총 사용액</span><b>${won(monthSpend)}</b></div>
            ${OWNERS.map(o =>
              `<div><span>${o}</span><b>${won(spendByOwner(app.month, o))}</b></div>`).join('')}
          </div>

          <div class="list">${transactionRows()}</div>
        </article>

        <datalist id="categoryList">
          ${categories.map(c => `<option value="${esc(c)}">`).join('')}
        </datalist>
      </section>`;
  }

  /* --- 13. 화면: 자산·설정 항목 ------------------------------------------- */

  /* 적용 시작월이 있는 항목(정기소득·고정비·적금·예산·공과금 예상값) 공통 행 */
  function historyRows(kind, list, opts = {}) {
    if (!list.length) return emptyRow('등록된 항목이 없습니다. 오른쪽 위 추가 버튼을 눌러주세요.');
    const field = kind === 'utility' ? 'estimateHistory' : 'history';
    return list.map(x => {
      const history = x[field];
      const applied = historyFrom(history, app.month);
      const value = historyValue(history, app.month);
      const past = history.filter(r => r.from !== applied);
      return `
        <form class="item" data-row="${kind}" data-id="${x.id}">
          <label class="field"><span>항목명</span>
            <input name="name" value="${esc(x.name)}"></label>
          ${opts.owner ? `<label class="field"><span>${opts.ownerLabel || '소유자'}</span>
            ${ownerSelect('owner', x.owner)}</label>` : ''}
          <label class="field"><span>적용 시작월</span>
            <input name="from" type="month" value="${esc(applied)}"></label>
          <label class="field"><span>${opts.amountLabel || '월 금액'}</span>
            <input name="amount" inputmode="numeric" value="${value}"></label>
          <div class="item-actions">
            <button class="secondary" type="submit">수정 저장</button>
            <button class="danger" type="button" data-delete="${kind}" data-id="${x.id}">삭제</button>
          </div>
          ${past.length ? `<details class="history"><summary>이전 이력 ${past.length}건</summary>
            <ul>${history.map(r =>
              `<li>${monthLabel(r.from)}부터 <b>${won(r.amount)}</b></li>`).join('')}</ul>
            </details>` : ''}
        </form>`;
    }).join('');
  }

  function assetRows() {
    if (!app.state.assets.length)
      return emptyRow('등록된 자산·부채가 없습니다. 추가 버튼을 눌러주세요.');
    return app.state.assets.map(x => `
      <form class="item" data-row="asset" data-id="${x.id}">
        <label class="field"><span>항목명</span>
          <input name="name" value="${esc(x.name)}"></label>
        <label class="field"><span>종류</span>
          <select name="kind">
            <option value="asset" ${x.kind === 'asset' ? 'selected' : ''}>자산</option>
            <option value="debt" ${x.kind === 'debt' ? 'selected' : ''}>부채</option>
          </select></label>
        <label class="field"><span>카테고리</span>
          <input name="category" value="${esc(x.category)}" list="assetCategoryList"></label>
        <label class="field"><span>소유자</span>${ownerSelect('owner', x.owner)}</label>
        <label class="field"><span>현재 금액</span>
          <input name="amount" inputmode="numeric" value="${num(x.amount)}"></label>
        <label class="field"><span>기준일</span>
          <input name="asOf" type="date" value="${esc(x.asOf)}"></label>
        <label class="field wide"><span>메모</span>
          <input name="memo" value="${esc(x.memo)}"></label>
        <div class="item-actions">
          <button class="secondary" type="submit">수정 저장</button>
          <button class="danger" type="button" data-delete="asset" data-id="${x.id}">삭제</button>
        </div>
      </form>`).join('');
  }

  function assetsView() {
    const categories = [...new Set(app.state.assets.map(a => a.category).filter(Boolean))];
    return `
      <section class="page">
        <div class="page-head">
          <div><span class="eyebrow">자산</span><h2>보유 자산·부채</h2></div>
          <button class="secondary" type="button" data-add="asset">항목 추가</button>
        </div>

        <div class="grid three">
          <article class="card metric"><small>총자산</small>
            <strong>${won(assetTotal())}</strong></article>
          <article class="card metric"><small>총부채</small>
            <strong class="minus">${won(debtTotal())}</strong></article>
          <article class="card metric"><small>순자산</small>
            <strong>${won(netAssets())}</strong></article>
        </div>

        <article class="card">
          <div class="card-head"><h3>항목별 관리</h3>
            <span class="note">자산 합계 − 부채 합계 = 순자산</span></div>
          <div class="list">${assetRows()}</div>
        </article>

        <datalist id="assetCategoryList">
          ${categories.map(c => `<option value="${esc(c)}">`).join('')}
        </datalist>
      </section>`;
  }

  /* --- 14. 화면: 포캐스팅 ------------------------------------------------- */

  function checkboxGroup(name, items, selected) {
    if (!items.length) return '<p class="note">선택할 항목이 없습니다.</p>';
    const all = selected === null;
    return `<div class="check-group">
      ${items.map(x => `
        <label class="check">
          <input type="checkbox" name="${name}" value="${x.id}"
                 ${all || selected.includes(x.id) ? 'checked' : ''}>
          <span>${esc(x.name)}</span>
        </label>`).join('')}
    </div>`;
  }

  function scenarioCard(sc) {
    const r = runForecast(sc);
    const goal = app.state.goals.find(g => g.id === sc.goalId);
    const target = goal ? num(goal.target) : 0;
    const projection = target > 0 ? goalProjection(sc, target) : null;
    const rate = target > 0 ? (r.future / target) * 100 : 0;

    return `
      <form class="card scenario" data-row="scenario" data-id="${sc.id}">
        <div class="card-head">
          <label class="field grow"><span>시나리오명</span>
            <input name="name" value="${esc(sc.name)}"></label>
          <button class="danger" type="button" data-delete="scenario" data-id="${sc.id}">삭제</button>
        </div>

        <div class="grid two">
          <label class="field"><span>기준 시작월</span>
            <input name="startMonth" type="month" value="${esc(sc.startMonth)}"></label>
          <label class="field"><span>예측 기간(개월)</span>
            <input name="months" inputmode="numeric" value="${num(sc.months)}"
                   list="monthPresets"></label>
          <label class="field"><span>연 기대수익률(%)</span>
            <input name="annualReturn" inputmode="decimal" value="${num(sc.annualReturn)}"></label>
          <label class="field"><span>월 추가 저축·조정액</span>
            <input name="monthlyAdjustment" inputmode="numeric"
                   value="${num(sc.monthlyAdjustment)}"></label>
        </div>

        <label class="check standalone">
          <input type="checkbox" name="includeBonus" ${sc.includeBonus ? 'checked' : ''}>
          <span>보너스·상여금을 저축에 포함</span>
        </label>

        <label class="field"><span>목표 금액 선택</span>
          <select name="goalId">
            <option value="">선택 안 함</option>
            ${app.state.goals.map(g =>
              `<option value="${g.id}" ${sc.goalId === g.id ? 'selected' : ''}>
                 ${esc(g.name)} · ${won(g.target)}</option>`).join('')}
          </select></label>

        <details class="picker">
          <summary>포함 항목 선택</summary>
          <div class="picker-body">
            <p class="note">포함할 적금</p>
            ${checkboxGroup('savingIds', app.state.savings, sc.savingIds)}
            <p class="note">포함할 자산</p>
            ${checkboxGroup('assetIds',
              app.state.assets.filter(a => a.kind === 'asset'), sc.assetIds)}
            <p class="note">포함할 부채</p>
            ${checkboxGroup('debtIds',
              app.state.assets.filter(a => a.kind === 'debt'), sc.debtIds)}
          </div>
        </details>

        <div class="result">
          <div class="result-main">
            <small>${num(sc.months)}개월 뒤 예상 순자산</small>
            <strong>${won(r.future)}</strong>
          </div>
          <div class="result-grid">
            <div><span>시작 순자산</span><b>${won(r.startValue)}</b></div>
            <div><span>누적 납입 원금</span><b>${won(r.contributions)}</b></div>
            <div><span>예상 운용수익</span><b>${won(r.returns)}</b></div>
            ${goal ? `
              <div><span>목표까지 남은 금액</span>
                <b>${won(Math.max(0, target - r.future))}</b></div>
              <div><span>목표 달성률</span><b>${rate.toFixed(1)}%</b></div>
              <div><span>목표 예상 달성월</span>
                <b>${projection ? monthLabel(projection.month) : '기간 내 미달성'}</b></div>` : ''}
          </div>
        </div>

        <button class="secondary" type="submit">시나리오 저장</button>
      </form>`;
  }

  function goalRows() {
    if (!app.state.goals.length) return emptyRow('등록된 목표가 없습니다.');
    const net = netAssets();
    return app.state.goals.map(g => {
      const pct = g.target > 0 ? Math.min(100, (net / g.target) * 100) : 0;
      return `
        <form class="item" data-row="goal" data-id="${g.id}">
          <label class="field"><span>목표명</span>
            <input name="name" value="${esc(g.name)}"></label>
          <label class="field"><span>목표 금액</span>
            <input name="target" inputmode="numeric" value="${num(g.target)}"></label>
          <label class="field"><span>목표일</span>
            <input name="dueDate" type="date" value="${esc(g.dueDate)}"></label>
          <label class="field"><span>연결 시나리오</span>
            <select name="scenarioId">
              <option value="">선택 안 함</option>
              ${app.state.scenarios.map(s =>
                `<option value="${s.id}" ${g.scenarioId === s.id ? 'selected' : ''}>
                   ${esc(s.name)}</option>`).join('')}
            </select></label>
          <label class="field wide"><span>메모</span>
            <input name="memo" value="${esc(g.memo)}"></label>
          <div class="item-actions">
            <button class="secondary" type="submit">수정 저장</button>
            <button class="danger" type="button" data-delete="goal" data-id="${g.id}">삭제</button>
          </div>
          <div class="wide">
            <div class="bar"><i style="width:${pct}%"></i></div>
            <small>현재 순자산 기준 ${pct.toFixed(1)}% 달성</small>
          </div>
        </form>`;
    }).join('');
  }

  function forecastView() {
    return `
      <section class="page">
        <div class="page-head">
          <div><span class="eyebrow">포캐스팅</span><h2>자산 예측</h2></div>
          <div class="head-actions">
            <button class="secondary" type="button" data-add="scenario">시나리오 추가</button>
            <button class="secondary" type="button" data-add="goal">목표 추가</button>
          </div>
        </div>

        ${app.state.scenarios.length
          ? app.state.scenarios.map(scenarioCard).join('')
          : `<article class="card">${emptyRow('시나리오를 추가해 예측을 시작해주세요.')}</article>`}

        <article class="card">
          <div class="card-head"><h3>자산 목표</h3></div>
          <div class="list">${goalRows()}</div>
        </article>

        <datalist id="monthPresets">
          ${[6, 12, 18, 24, 36, 60].map(m => `<option value="${m}">`).join('')}
        </datalist>
      </section>`;
  }

  /* --- 15. 화면: 설정 ----------------------------------------------------- */

  function settingsView() {
    const groups = [
      ['income', '정기소득', app.state.recurringIncomes,
        { owner: true, ownerLabel: '소유자', amountLabel: '월 금액' }],
      ['fixed', '월 고정비', app.state.fixedCosts,
        { owner: true, ownerLabel: '부담자', amountLabel: '월 금액' }],
      ['utility', '공과금 항목', app.state.utilities,
        { owner: false, amountLabel: '월 예상금액' }],
      ['saving', '적금·저축', app.state.savings,
        { owner: true, ownerLabel: '소유자', amountLabel: '월 납입금' }],
      ['budget', '생활비 예산', app.state.budgets,
        { owner: true, ownerLabel: '대상', amountLabel: '월 예산' }]
    ];

    return `
      <section class="page">
        <div class="page-head">
          <div><span class="eyebrow">설정</span><h2>항목·기기 설정</h2></div>
          ${monthNav()}
        </div>

        <p class="note lead-note">금액을 바꾸면 위에서 고른 <b>적용 시작월</b>부터 반영되고,
          그 이전 달의 금액은 그대로 유지됩니다.</p>

        ${groups.map(([kind, title, list, opts]) => `
          <article class="card">
            <div class="card-head"><h3>${title}</h3>
              <button class="secondary" type="button" data-add="${kind}">항목 추가</button></div>
            <div class="list">${historyRows(kind, list, opts)}</div>
          </article>`).join('')}

        <article class="card">
          <div class="card-head"><h3>이 휴대폰</h3></div>
          <div class="settings-grid">
            <div>
              <p class="note">현재 사용자</p>
              <div class="choice-row">
                ${ACTORS.map(a => `
                  <button type="button" class="choice ${app.space.actor === a ? 'active' : ''}"
                          data-change-actor="${a}">${a}</button>`).join('')}
              </div>
            </div>
            <div>
              <p class="note">계정 · 기기 ID</p>
              <div class="mono-box">${esc(app.session?.user?.email || '')}</div>
              <div class="mono-box">${esc(app.device.id)}</div>
            </div>
          </div>
        </article>

        <article class="card">
          <div class="card-head"><h3>공유공간</h3></div>
          <div class="settings-grid">
            <div>
              <p class="note">공유코드</p>
              <div class="mono-box big">${esc(app.space.code)}</div>
              <button class="secondary" type="button" data-copy="code">공유코드 복사</button>
            </div>
            <div>
              <p class="note">연결키 ${app.space.secret ? '' : '(이 기기에는 저장되어 있지 않습니다)'}</p>
              <div class="mono-box">${app.space.secret ? esc(app.space.secret) : '—'}</div>
              <div class="row">
                <button class="secondary" type="button" data-copy="secret"
                  ${app.space.secret ? '' : 'disabled'}>연결키 복사</button>
                <button class="secondary" type="button" data-qr
                  ${app.space.secret ? '' : 'disabled'}>QR 공유</button>
              </div>
            </div>
          </div>
          <div class="row wrap">
            <button class="secondary" type="button" data-manual-sync>수동 동기화</button>
            <button class="secondary" type="button" data-clear-cache>로컬 캐시 초기화</button>
            <button class="danger" type="button" data-disconnect>공유공간 연결 해제</button>
            <button class="ghost" type="button" data-signout>로그아웃</button>
          </div>
          <p class="note">연결 해제와 로그아웃은 이 휴대폰에만 적용되며 서버 데이터는 그대로 남습니다.</p>
        </article>
      </section>`;
  }

  /* --- 16. 화면: 변경 로그 ------------------------------------------------ */

  function valueTable(data) {
    if (data === null || data === undefined) return '<span class="none">없음</span>';
    if (typeof data !== 'object') return `<span>${esc(String(data))}</span>`;
    const rows = Object.entries(data)
      .filter(([k]) => k !== 'id')
      .map(([k, v]) => {
        let text;
        if (Array.isArray(v)) {
          text = v.length && v[0] && typeof v[0] === 'object' && 'from' in v[0]
            ? v.map(r => `${r.from} → ${won(r.amount)}`).join(', ')
            : v.join(', ') || '없음';
        } else if (v === null || v === '') text = '없음';
        else if (typeof v === 'boolean') text = v ? '예' : '아니오';
        else if (typeof v === 'number') text = v.toLocaleString('ko-KR');
        else text = String(v);
        return `<tr><th>${esc(FIELD_LABEL[k] || k)}</th><td>${esc(text)}</td></tr>`;
      });
    return rows.length ? `<table class="kv">${rows.join('')}</table>`
                       : '<span class="none">내용 없음</span>';
  }

  function logsView() {
    const types = [...new Set(app.logs.map(l => l.entity_type))];
    return `
      <section class="page">
        <div class="page-head">
          <div><span class="eyebrow">변경 로그</span><h2>모든 변경 이력</h2></div>
          <button class="secondary" type="button" data-refresh-logs>새로고침</button>
        </div>

        <article class="card">
          <div class="filter-bar">
            <label class="field"><span>작업자</span>
              <select data-log-filter="actor">
                <option value="">전체</option>
                ${ACTORS.map(a =>
                  `<option ${app.logFilter.actor === a ? 'selected' : ''}>${a}</option>`).join('')}
              </select></label>
            <label class="field"><span>작업 유형</span>
              <select data-log-filter="action">
                <option value="">전체</option>
                ${['create', 'update', 'delete', 'connect'].map(a =>
                  `<option value="${a}" ${app.logFilter.action === a ? 'selected' : ''}>
                     ${ACTION_LABEL[a]}</option>`).join('')}
              </select></label>
            <label class="field"><span>항목 종류</span>
              <select data-log-filter="entityType">
                <option value="">전체</option>
                ${Object.entries(ENTITY_LABEL).map(([k, v]) =>
                  `<option value="${k}" ${app.logFilter.entityType === k ? 'selected' : ''}>
                     ${v}</option>`).join('')}
              </select></label>
          </div>
          <p class="note">최신순 · ${app.logs.length}건 표시 (최대 300건)</p>
        </article>

        <div class="log-list">
          ${app.logs.length ? app.logs.map(l => {
            const open = app.expanded.has(String(l.id));
            return `
              <article class="card log">
                <div class="log-head">
                  <div class="log-who">
                    <span class="badge">${esc(l.actor)}</span>
                    <span class="tag tag-${esc(l.action)}">${esc(ACTION_LABEL[l.action] || l.action)}</span>
                    <span class="tag">${esc(ENTITY_LABEL[l.entity_type] || l.entity_type)}</span>
                  </div>
                  <small>${fmtTime(l.created_at)}</small>
                </div>
                <p class="log-summary">${esc(l.summary)}</p>
                <small class="log-meta">기기 ${esc(String(l.device_id || '—').slice(0, 8))}
                  ${l.entity_id ? ` · 항목 ${esc(String(l.entity_id).slice(0, 8))}` : ''}</small>
                <button class="link" type="button" data-toggle-log="${l.id}">
                  ${open ? '변경 전후 접기' : '변경 전후 보기'}
                </button>
                ${open ? `
                  <div class="diff">
                    <div><h4>변경 전</h4>${valueTable(l.before_data)}</div>
                    <div><h4>변경 후</h4>${valueTable(l.after_data)}</div>
                  </div>` : ''}
              </article>`;
          }).join('') : `<article class="card">${emptyRow('기록이 없습니다.')}</article>`}
        </div>
      </section>`;
  }

  /* --- 17. 셸 ------------------------------------------------------------- */

  function appShell() {
    const tabs = [
      ['home', '홈'], ['monthly', '월별'], ['assets', '자산'],
      ['forecast', '예측'], ['settings', '설정'], ['logs', '로그']
    ];
    const content = {
      home: homeView, monthly: monthlyView, assets: assetsView,
      forecast: forecastView, settings: settingsView, logs: logsView
    }[app.tab]();

    return `
      <div class="app">
        <header class="topbar">
          <div class="brand"><span class="mark">🍀</span>
            <div><b>CLOVER</b><small>${esc(app.space.name || '우리집')}</small></div></div>
          <div class="status">
            <span class="sync sync-${app.syncTone}">${esc(app.sync)}</span>
            <span class="badge">${esc(app.space.actor)}</span>
          </div>
        </header>

        <button id="liveBanner" type="button" data-apply-live>
          상대방이 방금 변경했습니다 · 눌러서 반영
        </button>

        ${content}

        <nav class="bottom-nav">
          ${tabs.map(([k, t]) =>
            `<button type="button" data-tab="${k}"
                     class="${app.tab === k ? 'active' : ''}">${t}</button>`).join('')}
        </nav>
        <div id="toast" class="toast" role="status"></div>
      </div>`;
  }

  function render() {
    app.deferredRender = false;
    const root = document.querySelector('#app');
    if (!root) return;

    if (app.screen === 'boot') {
      root.innerHTML = `<main class="center"><section class="center-card">
        <div class="logo">🍀</div><h1>CLOVER</h1><p class="lead">불러오는 중입니다…</p>
        </section></main>`;
    } else if (app.screen === 'auth') {
      root.innerHTML = authView();
    } else if (app.screen === 'space') {
      root.innerHTML = spaceView();
    } else {
      root.innerHTML = appShell();
    }
  }

  /* --- 18. 변경 동작 ------------------------------------------------------ */

  function newEntity(kind) {
    const id = uid();
    const h = [{ from: app.month, amount: 0 }];

    // 보고 있는 달 안에서 기본 날짜를 정한다. 이번 달이면 오늘, 다른 달이면 1일.
    const [my, mm] = app.month.split('-').map(Number);
    const lastDay = new Date(my, mm, 0).getDate();
    const defaultDay = app.month === currentMonth
      ? pad(Math.min(today().getDate(), lastDay))
      : '01';
    const defaultDate = `${app.month}-${defaultDay}`;
    const map = {
      income: { id, name: '새 정기소득', owner: '공동', history: h },
      fixed: { id, name: '새 고정비', owner: '공동', history: h },
      utility: { id, name: '새 공과금', estimateHistory: h },
      saving: { id, name: '새 적금', owner: '공동', history: h },
      budget: { id, name: '새 예산', owner: '공동', history: h },
      asset: { id, name: '새 자산', kind: 'asset', category: '기타', owner: '공동',
               amount: 0, asOf: ymd(today()), memo: '' },
      bonus: { id, name: '새 보너스', owner: app.space.actor,
               date: defaultDate, amount: 0, memo: '' },
      transaction: { id, date: defaultDate, owner: app.space.actor,
                     category: '기타', place: '', amount: 0, memo: '' },
      scenario: { id, name: '새 시나리오', startMonth: app.month, months: 12,
                  annualReturn: 3, monthlyAdjustment: 0, savingIds: null,
                  assetIds: null, debtIds: null, includeBonus: false, goalId: '' },
      goal: { id, name: '새 목표', target: 0, dueDate: '', scenarioId: '', memo: '' }
    };
    return map[kind] || null;
  }

  async function addEntity(kind) {
    const entity = newEntity(kind);
    if (!entity) return;
    await mutate(
      state => { listOf(kind, state).push(clone(entity)); },
      {
        action: 'create', type: kind, id: entity.id,
        summary: `${ENTITY_LABEL[kind]} "${entity.name || '새 항목'}" 추가`,
        pick: s => findEntity(kind, entity.id, s),
        success: '항목을 추가했습니다.'
      }
    );
  }

  async function deleteEntity(kind, id) {
    const name = entityName(kind, id);
    if (!confirm(`${ENTITY_LABEL[kind]} "${name}" 항목을 삭제할까요?\n삭제 기록은 로그에 남습니다.`))
      return;
    await mutate(
      state => {
        const list = listOf(kind, state);
        const idx = list.findIndex(x => x.id === id);
        if (idx >= 0) list.splice(idx, 1);
      },
      {
        action: 'delete', type: kind, id,
        summary: `${ENTITY_LABEL[kind]} "${name}" 삭제`,
        pick: s => findEntity(kind, id, s),
        success: '삭제했습니다.'
      }
    );
  }

  const readCheckboxes = (form, name) => {
    const boxes = [...form.querySelectorAll(`input[name="${name}"]`)];
    if (!boxes.length) return null;
    const checked = boxes.filter(b => b.checked).map(b => b.value);
    return checked.length === boxes.length ? null : checked;   // 전체 선택 = null(전체 포함)
  };

  async function saveRow(form) {
    const kind = form.dataset.row;
    const id = form.dataset.id;
    const d = new FormData(form);

    if (kind === 'utility-actual') {
      const raw = String(d.get('amount') ?? '').trim();
      const utility = findEntity('utility', id);
      await mutate(
        state => {
          state.monthly[app.month] ||= { utilityActuals: {} };
          state.monthly[app.month].utilityActuals ||= {};
          if (raw === '') delete state.monthly[app.month].utilityActuals[id];
          else state.monthly[app.month].utilityActuals[id] = num(raw);
        },
        {
          action: 'update', type: 'utilityActual', id,
          summary: `${monthLabel(app.month)} ${utility?.name || '공과금'} 실제금액 ` +
                   (raw === '' ? '비움' : won(num(raw))),
          pick: s => {
            const v = s.monthly[app.month]?.utilityActuals?.[id];
            return v === undefined ? null : { amount: v };
          },
          success: '공과금을 저장했습니다.'
        }
      );
      return;
    }

    const target = findEntity(kind, id);
    if (!target) return;
    const name = String(d.get('name') ?? target.name ?? '').trim() || '이름 없음';

    await mutate(
      state => {
        const x = findEntity(kind, id, state);
        if (!x) return;

        if (['income', 'fixed', 'saving', 'budget'].includes(kind)) {
          x.name = name;
          x.owner = d.get('owner') || x.owner;
          setHistory(x.history, d.get('from') || app.month, d.get('amount'));

        } else if (kind === 'utility') {
          x.name = name;
          setHistory(x.estimateHistory, d.get('from') || app.month, d.get('amount'));

        } else if (kind === 'asset') {
          x.name = name;
          x.kind = d.get('kind') === 'debt' ? 'debt' : 'asset';
          x.category = String(d.get('category') || '기타').trim();
          x.owner = d.get('owner') || x.owner;
          x.amount = num(d.get('amount'));
          x.asOf = d.get('asOf') || x.asOf;
          x.memo = String(d.get('memo') || '').trim();

        } else if (kind === 'bonus') {
          x.name = name;
          x.owner = d.get('owner') || x.owner;
          x.date = d.get('date') || x.date;
          x.amount = num(d.get('amount'));
          x.memo = String(d.get('memo') || '').trim();

        } else if (kind === 'transaction') {
          x.date = d.get('date') || x.date;
          x.owner = d.get('owner') || x.owner;
          x.category = String(d.get('category') || '기타').trim();
          x.place = String(d.get('place') || '').trim();
          x.amount = num(d.get('amount'));
          x.memo = String(d.get('memo') || '').trim();

        } else if (kind === 'scenario') {
          x.name = name;
          x.startMonth = d.get('startMonth') || x.startMonth;
          x.months = Math.min(600, Math.max(1, num(d.get('months'))));
          x.annualReturn = num(d.get('annualReturn'));
          x.monthlyAdjustment = num(d.get('monthlyAdjustment'));
          x.includeBonus = d.get('includeBonus') === 'on';
          x.goalId = d.get('goalId') || '';
          x.savingIds = readCheckboxes(form, 'savingIds');
          x.assetIds = readCheckboxes(form, 'assetIds');
          x.debtIds = readCheckboxes(form, 'debtIds');

        } else if (kind === 'goal') {
          x.name = name;
          x.target = num(d.get('target'));
          x.dueDate = d.get('dueDate') || '';
          x.scenarioId = d.get('scenarioId') || '';
          x.memo = String(d.get('memo') || '').trim();
        }
      },
      {
        action: 'update', type: kind, id,
        summary: `${ENTITY_LABEL[kind]} "${name}" 수정`,
        pick: s => findEntity(kind, id, s),
        success: '수정했습니다.'
      }
    );
  }

  /* --- 19. 인증·공간 연결 ------------------------------------------------- */

  async function handleAuth(form) {
    const d = new FormData(form);
    const email = String(d.get('email') || '').trim();
    const password = String(d.get('password') || '');
    app.lastError = '';

    if (!db) throw new Error('Supabase 설정이 없습니다. config.js를 확인해주세요.');

    if (app.authMode === 'signup') {
      const { data, error } = await db.auth.signUp({ email, password });
      if (error) throw error;
      if (!data.session) {
        // 이메일 확인이 켜져 있으면 세션이 바로 생기지 않는다
        const retry = await db.auth.signInWithPassword({ email, password });
        if (retry.error) {
          throw new Error(
            '가입은 되었으나 바로 로그인되지 않았습니다. ' +
            'Supabase 설정에서 이메일 확인(Confirm email)을 꺼주세요.'
          );
        }
      }
    } else {
      const { error } = await db.auth.signInWithPassword({ email, password });
      if (error) {
        throw new Error(
          error.message.includes('Invalid login')
            ? '이메일 또는 비밀번호가 올바르지 않습니다.'
            : error.message
        );
      }
    }
    await afterLogin();
  }

  async function afterLogin() {
    const { data } = await db.auth.getSession();
    app.session = data.session;
    if (!app.session) { app.screen = 'auth'; render(); return; }

    const { data: rows, error } = await db.rpc('clv_my_membership');
    if (error) throw error;
    const row = Array.isArray(rows) ? rows[0] : rows;

    if (!row) {
      app.screen = 'space';
      app.lastError = '';
      render();
      return;
    }

    const savedSecret = localStorage.getItem(`clover-secret-${row.space_code}`) || '';
    app.space = { code: row.space_code, name: row.space_name, actor: row.actor,
                  secret: savedSecret };
    restoreCache(row.space_code);
    app.screen = 'app';
    render();

    try {
      await readSpace({ force: true });
      startRealtime();
      await flushPending();
    } catch (e) {
      setSync(isNetworkError(e) ? '오프라인 — 저장된 내용 표시 중' : '연결 오류', 'warn');
      app.lastError = e.message || String(e);
      render();
    }
  }

  async function createSpace(form) {
    const d = new FormData(form);
    const spaceName = String(d.get('spaceName') || '우리집').trim();
    const actor = String(d.get('actor') || ACTORS[0]);
    const code = randomText(6);
    const secret = randomText(20);

    const { error } = await db.rpc('clv_create_space', {
      p_space_code: code,
      p_secret_hash: await sha256(secret),
      p_space_name: spaceName,
      p_actor: actor,
      p_device_id: app.device.id,
      p_initial_state: seedState()
    });
    if (error) throw error;

    localStorage.setItem(`clover-secret-${code}`, secret);
    app.space = { code, name: spaceName, actor, secret };
    app.screen = 'app';
    app.tab = 'settings';
    await readSpace({ force: true });
    startRealtime();
    render();
    alert(
      `공유공간을 만들었습니다.\n\n` +
      `공유코드: ${code}\n연결키: ${secret}\n\n` +
      `배우자 휴대폰에서 이 두 값을 입력하면 연결됩니다.\n` +
      `설정 탭에서 언제든 다시 확인·복사할 수 있습니다.`
    );
  }

  async function joinSpace(form) {
    const d = new FormData(form);
    const actor = String(d.get('actor') || ACTORS[1]);
    let code = String(d.get('code') || '').trim().toUpperCase();
    let secret = String(d.get('secret') || '').trim();

    // "코드.연결키" 형태로 한 번에 붙여넣은 경우도 받아준다
    if (code.includes('.') && !secret) {
      [code, secret] = code.split('.');
      secret = (secret || '').trim();
    }
    if (!code || !secret) throw new Error('공유코드와 연결키를 모두 입력해주세요.');

    const { data, error } = await db.rpc('clv_join_space', {
      p_space_code: code,
      p_secret_hash: await sha256(secret),
      p_actor: actor,
      p_device_id: app.device.id
    });
    if (error) throw error;
    if (data !== true) throw new Error('공유코드 또는 연결키가 올바르지 않습니다.');

    localStorage.setItem(`clover-secret-${code}`, secret);
    app.space = { code, name: '우리집', actor, secret };
    app.screen = 'app';
    await readSpace({ force: true });
    startRealtime();
    render();
    toast('공유공간에 연결했습니다.');
  }

  /* --- 20. 이벤트 --------------------------------------------------------- */

  document.addEventListener('click', async e => {
    const t = e.target;

    const authMode = t.closest('[data-auth-mode]');
    if (authMode) {
      app.authMode = authMode.dataset.authMode;
      app.lastError = '';
      render();
      return;
    }

    if (t.closest('[data-signout]')) {
      if (!confirm('로그아웃할까요? 이 휴대폰에서만 로그아웃됩니다.')) return;
      stopRealtime();
      await db.auth.signOut();
      app.session = null; app.space = null; app.state = emptyState(); app.version = 0;
      app.screen = 'auth'; app.lastError = '';
      render();
      return;
    }

    const tab = t.closest('[data-tab]');
    if (tab) {
      app.tab = tab.dataset.tab;
      render();
      if (app.tab === 'logs') loadLogs().catch(err => toast(err.message));
      return;
    }

    const shift = t.closest('[data-shift]');
    if (shift) { app.month = shiftMonth(app.month, num(shift.dataset.shift)); render(); return; }

    if (t.closest('[data-apply-live]')) { render(); return; }

    const add = t.closest('[data-add]');
    if (add) { await addEntity(add.dataset.add); return; }

    const del = t.closest('[data-delete]');
    if (del) { await deleteEntity(del.dataset.delete, del.dataset.id); return; }

    const clearUtil = t.closest('[data-clear-utility]');
    if (clearUtil) {
      const id = clearUtil.dataset.clearUtility;
      const utility = findEntity('utility', id);
      await mutate(
        state => {
          if (state.monthly[app.month]?.utilityActuals)
            delete state.monthly[app.month].utilityActuals[id];
        },
        {
          action: 'delete', type: 'utilityActual', id,
          summary: `${monthLabel(app.month)} ${utility?.name || '공과금'} 실제금액 비움`,
          pick: s => {
            const v = s.monthly[app.month]?.utilityActuals?.[id];
            return v === undefined ? null : { amount: v };
          },
          success: '실제 금액을 비웠습니다.'
        }
      );
      return;
    }

    const changeActor = t.closest('[data-change-actor]');
    if (changeActor) {
      const actor = changeActor.dataset.changeActor;
      if (actor === app.space.actor) return;
      try {
        const { error } = await db.rpc('clv_set_actor', {
          p_space_code: app.space.code, p_actor: actor, p_device_id: app.device.id
        });
        if (error) throw error;
        app.space.actor = actor;
        toast(`이 휴대폰 사용자를 ${actor}님으로 변경했습니다.`);
        render();
        if (app.tab === 'logs') loadLogs().catch(() => {});
      } catch (err) { toast(err.message || '변경하지 못했습니다.'); }
      return;
    }

    const copy = t.closest('[data-copy]');
    if (copy) {
      const value = copy.dataset.copy === 'code' ? app.space.code : app.space.secret;
      if (!value) return;
      try {
        await navigator.clipboard.writeText(value);
        toast('복사했습니다.');
      } catch { prompt('아래 값을 길게 눌러 복사해주세요.', value); }
      return;
    }

    if (t.closest('[data-qr]')) {
      const payload = `${app.space.code}.${app.space.secret}`;
      const url = `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(payload)}`;
      const w = window.open('', '_blank', 'width=320,height=420');
      if (w) {
        w.document.write(
          `<title>CLOVER 연결코드</title>` +
          `<body style="font-family:sans-serif;text-align:center;padding:20px;background:#fff">` +
          `<h3 style="color:#1f2a44">배우자 휴대폰으로 스캔</h3>` +
          `<img src="${url}" alt="연결 QR" style="width:240px;height:240px">` +
          `<p style="font-family:monospace;font-size:13px;word-break:break-all;color:#4b5563">${esc(payload)}</p>` +
          `</body>`
        );
      } else {
        prompt('연결코드를 복사해 전달해주세요.', payload);
      }
      return;
    }

    if (t.closest('[data-manual-sync]')) {
      setSync('수동 동기화 중', 'busy'); render();
      try { await readSpace({ force: true }); await flushPending(); toast('최신 상태로 맞췄습니다.'); }
      catch (err) { setSync('동기화 실패', 'error'); toast(err.message); render(); }
      return;
    }

    if (t.closest('[data-clear-cache]')) {
      if (!confirm('이 휴대폰에 저장된 로컬 캐시를 지울까요?\n서버 데이터는 그대로이며 즉시 다시 내려받습니다.'))
        return;
      Object.keys(localStorage).filter(k => k.startsWith(CACHE_PREFIX))
        .forEach(k => localStorage.removeItem(k));
      try { await readSpace({ force: true }); toast('캐시를 비우고 다시 받았습니다.'); }
      catch (err) { toast(err.message); }
      return;
    }

    if (t.closest('[data-disconnect]')) {
      if (!confirm('이 휴대폰의 공유공간 연결을 해제할까요?\n서버 데이터는 남으며 연결코드로 다시 참여할 수 있습니다.'))
        return;
      try {
        await db.rpc('clv_leave_space', { p_space_code: app.space.code });
        localStorage.removeItem(`${CACHE_PREFIX}${app.space.code}`);
        localStorage.removeItem(`clover-secret-${app.space.code}`);
        stopRealtime();
        app.space = null; app.state = emptyState(); app.version = 0;
        app.screen = 'space';
        render();
      } catch (err) { toast(err.message); }
      return;
    }

    if (t.closest('[data-refresh-logs]')) {
      loadLogs().then(() => toast('로그를 새로 불러왔습니다.')).catch(err => toast(err.message));
      return;
    }

    const toggleLog = t.closest('[data-toggle-log]');
    if (toggleLog) {
      const id = String(toggleLog.dataset.toggleLog);
      if (app.expanded.has(id)) app.expanded.delete(id); else app.expanded.add(id);
      render();
      return;
    }
  });

  document.addEventListener('change', e => {
    const t = e.target;

    if (t.id === 'monthPicker') {
      app.month = t.value || currentMonth;
      render();
      return;
    }

    const logFilter = t.closest('[data-log-filter]');
    if (logFilter) {
      app.logFilter[logFilter.dataset.logFilter] = t.value;
      loadLogs().catch(err => toast(err.message));
      return;
    }

    const txFilter = t.closest('[data-tx-filter]');
    if (txFilter) {
      app.txFilter = app.txFilter || { owner: '', category: '' };
      app.txFilter[txFilter.dataset.txFilter] = t.value;
      render();
    }
  });

  // 입력을 마치고 포커스가 빠지면, 미뤄둔 실시간 반영을 적용한다
  document.addEventListener('focusout', () => {
    setTimeout(() => {
      const active = document.activeElement;
      const typing = active && ['INPUT', 'SELECT', 'TEXTAREA'].includes(active.tagName);
      if (app.deferredRender && !typing) { showLiveBanner(false); render(); }
    }, 150);
  });

  document.addEventListener('submit', async e => {
    e.preventDefault();
    const form = e.target;
    try {
      if (form.id === 'authForm') { await handleAuth(form); return; }
      if (form.id === 'createSpaceForm') { await createSpace(form); return; }
      if (form.id === 'joinSpaceForm') { await joinSpace(form); return; }
      if (form.dataset.row) { await saveRow(form); return; }
    } catch (err) {
      app.lastError = err.message || String(err);
      if (app.screen === 'auth' || app.screen === 'space') render();
      toast(app.lastError);
    }
  });

  /* --- 21. 부팅 ----------------------------------------------------------- */

  async function boot() {
    app.device = loadDevice();
    render();

    if (!db) {
      app.screen = 'auth';
      app.lastError = 'Supabase 설정을 찾을 수 없습니다. config.js를 확인해주세요.';
      render();
      return;
    }

    db.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') {
        stopRealtime();
        app.session = null; app.space = null;
        app.screen = 'auth';
        render();
      }
    });

    try {
      const { data } = await db.auth.getSession();
      if (!data.session) { app.screen = 'auth'; render(); return; }
      app.session = data.session;
      await afterLogin();
    } catch (e) {
      app.screen = 'auth';
      app.lastError = e.message || String(e);
      render();
    }
  }

  boot();
})();
