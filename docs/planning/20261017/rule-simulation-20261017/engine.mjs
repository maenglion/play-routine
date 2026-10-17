/*
 * Play Routine 규칙 시뮬레이터 (테스트 전용)
 * CLI: node engine.mjs <scenarios.json> <outDir>
 * 운영 DB·RPC·RLS·인증에는 접속하지 않는다. 모든 판정은 인메모리 PGlite의 pr_model 행을
 * INSERT/SELECT 하여 수행하며, 원본 DDL의 append-only / FK / CHECK / UNIQUE 제약을 우회하지 않는다.
 */
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const ENGINE_VERSION = 'rule-simulation-adapter/0.1';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const KST = 'Asia/Seoul';
const EVENT_START = '2026-11-01';
const EVENT_END = '2026-11-04';
const ASSET_CONFIG = {
  MIN: { unit: 'MIN', provider: 'PLAY_ROUTINE', route: 'INTERNAL_LEDGER' },
  WON: { unit: 'WON', provider: 'MANUAL', route: 'EXTERNAL_FULFILLMENT' },
  COUPAY_POINT: { unit: 'POINT', provider: 'COUPAY', route: 'EXTERNAL_FULFILLMENT' },
  WISH: { unit: 'WISH', provider: 'MANUAL', route: 'EXTERNAL_FULFILLMENT' },
};
const numericAssets = new Set(['MIN', 'WON', 'COUPAY_POINT']);

function usage() { console.error('사용법: node engine.mjs <scenarios.json> <outDir>'); }
function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
}
function digest(value) { return crypto.createHash('sha256').update(typeof value === 'string' ? value : stable(value)).digest('hex'); }
function escCsv(v) { const s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v); return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s; }
function asNumber(value, label = '수치') {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) throw new Error(`${label}은(는) 유한 정수여야 합니다`);
  return n;
}
function iso(at, fallbackDate = '2026-10-17', hour = '12:00:00') { return at || `${fallbackDate}T${hour}+09:00`; }
function dateOnly(value) { return String(value).slice(0, 10); }
function isoDate(instant) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: KST, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(instant));
}
function addDays(date, n) { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function monday(date) { const d = new Date(`${date}T00:00:00Z`); const day = d.getUTCDay() || 7; d.setUTCDate(d.getUTCDate() - day + 1); return d.toISOString().slice(0, 10); }
function monthStart(date) { return `${date.slice(0, 7)}-01`; }
function nextMonth(date) { const [y, m] = date.slice(0, 7).split('-').map(Number); return `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}-01`; }
function uuidFrom(s) { const h = crypto.createHash('sha256').update(String(s)).digest('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`; }
function equal(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function normalizeOp(op) { return String(op || '').toUpperCase().replaceAll('-', '_'); }

class Simulation {
  constructor(db, input, outDir) {
    this.db = db; this.input = input; this.outDir = outDir;
    this.rules = new Map((input.rules || []).map(r => [r.id, r]));
    this.trace = []; this.relations = []; this.results = []; this.familyScenario = new Map();
    this.n = 0;
  }
  uid(label) { this.n += 1; return uuidFrom(`${label}:${this.n}`); }
  async q(sql, params = []) { return this.db.query(sql, params); }
  async insert(table, row) {
    // undefined는 DB DEFAULT가 적용되도록 열 자체를 제외한다.
    const values = Object.fromEntries(Object.entries({ id: row.id || this.uid(table), ...row }).filter(([, value]) => value !== undefined));
    const keys = Object.keys(values); const params = Object.values(values);
    const result = await this.q(`insert into pr_model.${table} (${keys.join(',')}) values (${keys.map((_, i) => `$${i + 1}`).join(',')}) returning id`, params);
    this.relations.push({ family: row.family_id || '', table, id: result.rows[0].id });
    return result.rows[0].id;
  }
  async one(sql, params = []) { const r = await this.q(sql, params); return r.rows[0] || null; }
  async all(sql, params = []) { return (await this.q(sql, params)).rows; }
  log(scenario, step, status, detail = {}) { this.trace.push({ scenario: scenario.id, step, status, ...detail }); }

  async setUpScenario(scenario) {
    const family = await this.insert('families', { name: `시뮬레이션 ${scenario.id}`, timezone: KST });
    this.familyScenario.set(family, scenario.id);
    const parent = await this.insert('principals', { auth_user_id: this.uid(`${scenario.id}:parent-auth`) });
    const childPrincipal = await this.insert('principals', { auth_user_id: this.uid(`${scenario.id}:child-auth`) });
    const child = await this.insert('child_profiles', { family_id: family, principal_id: childPrincipal });
    const ctx = { scenario, family, parent, childPrincipal, child, assets: {}, effects: {}, rules: new Map(), records: new Map(), recordPayloads: new Map(), sequences: new Map(), snapshots: [], initialGrants: [], rejected: 0, blocked: 0, limited: 0 };
    for (const [code, cfg] of Object.entries(ASSET_CONFIG)) {
      ctx.assets[code] = await this.insert('asset_types', { family_id: family, code, unit: cfg.unit, provider_code: cfg.provider, route: cfg.route });
      ctx.effects[`REWARD:${code}`] = await this.insert('effect_types', { family_id: family, code: `REWARD_${code}`, name: `${code} 보상`, direction: 'REWARD', asset_id: ctx.assets[code] });
      ctx.effects[`PENALTY:${code}`] = await this.insert('effect_types', { family_id: family, code: `PENALTY_${code}`, name: `${code} 차감`, direction: 'PENALTY', asset_id: ctx.assets[code] });
    }
    await this.seedInitialBonus(ctx);
    const ruleIds = scenario.ruleIds || [...this.rules.keys()];
    for (const ruleId of ruleIds) { const rule = this.rules.get(ruleId); if (rule) await this.materializeRule(ctx, rule); }
    await this.attachSharedLimitPolicies(ctx);
    return ctx;
  }

  async attachSharedLimitPolicies(ctx) {
    // sharedRules에 든 상대 규칙도 반드시 같은 stable policy와 scope를 사용한다.
    for (const [ruleId, mr] of ctx.rules) for (const condition of mr.conditions) for (const lim of condition.limits) {
      const shared = new Set([ruleId, ...(lim.sharedRules || [])]);
      for (const targetId of shared) {
        const target = ctx.rules.get(targetId); if (!target) continue;
        const scopeExists = await this.one('select id from pr_model.scope_members where family_id=$1 and scope_id=$2 and series_id=$3', [ctx.family, lim.scope, target.series]);
        if (!scopeExists) await this.insert('scope_members', { family_id: ctx.family, scope_id: lim.scope, series_id: target.series });
        for (const tc of target.conditions.filter(c => c.direction === condition.direction)) {
          const has = await this.one('select id from pr_model.condition_limits where family_id=$1 and condition_id=$2 and limit_policy_id=$3', [ctx.family, tc.id, lim.id]);
          if (!has) { await this.insert('condition_limits', { family_id: ctx.family, condition_id: tc.id, limit_policy_id: lim.id, priority: 1 }); tc.limits.push({ ...lim }); }
        }
      }
    }
  }

  async seedInitialBonus(ctx) {
    const seeds = [];
    if (ctx.scenario.initial_balance_minutes != null) seeds.push({ asset: 'MIN', amount: ctx.scenario.initial_balance_minutes, reason: '입력에 명시된 테스트 초기 보너스(실제 잔액 아님)' });
    for (const b of ctx.scenario.initialBalances || ctx.scenario.initial_bonuses || []) seeds.push(b);
    for (const b of seeds) await this.createManualBonus(ctx, { ...b, at: '2026-10-01T00:00:00+09:00', reason: b.reason || '입력에 명시된 테스트 보너스' }, true);
  }

  valueKind(metric) {
    const u = String(metric.unit || '').toUpperCase();
    if (u === 'BOOLEAN') return 'BOOLEAN'; if (u === 'LOCAL_TIME') return 'LOCAL_TIME'; if (u === 'INSTANT') return 'INSTANT'; return 'NUMBER';
  }
  async materializeRule(ctx, rule) {
    const activity = await this.insert('ref_concepts', { family_id: ctx.family, name: rule.name || rule.id, category_code: rule.flow || 'DAILY' });
    const series = await this.insert('rule_series', { family_id: ctx.family, activity_id: activity, stable_key: this.uid(`${rule.id}:series`), flow: rule.flow || 'DAILY' });
    const version = await this.insert('rule_versions', { family_id: ctx.family, series_id: series, version_no: 1, effective_from: '2026-01-01', published_by: ctx.parent, criteria: rule.source_note || `입력 규칙 ${rule.id}`, engine_version: ENGINE_VERSION });
    const assignment = await this.insert('assignments', { family_id: ctx.family, child_id: ctx.child, series_id: series, rule_version_id: version, recording_kind: 'ON_DEMAND', starts_on: '2026-01-01', created_by: ctx.parent });
    const mr = { rule, activity, series, version, assignment, metrics: {}, conditions: [], sticker: null, aggregation: null, periodPolicies: new Map(), limitPolicies: new Map() };
    const defs = rule.metricDefs || [];
    for (const def of defs) {
      const min = def.min ?? (String(def.unit).toUpperCase() === 'PERCENT' ? 0 : null);
      const max = def.max ?? (String(def.unit).toUpperCase() === 'PERCENT' ? 100 : null);
      mr.metrics[def.code] = await this.insert('metric_definitions', { family_id: ctx.family, rule_version_id: version, code: def.code, value_kind: this.valueKind(def), unit_code: def.unit, min_value: min, max_value: max });
    }
    if (rule.sticker) {
      mr.sticker = await this.insert('sticker_types', { family_id: ctx.family, code: String(rule.sticker.code || `${rule.id}_STICKER`).slice(0, 100), name: `${rule.name || rule.id} 스티커`, direction: 'POSITIVE', icon_code: rule.sticker.icon || 'STAR' });
    }
    const aggregateNeeded = (rule.conditions || []).some(c => (c.groups || []).flat().some(p => p.aggregate || p.metric === 'aggregate' || p.metric === 'stickers' || p.metric === 'completed'));
    if (rule.aggregate || aggregateNeeded || ['DAY','WEEK','MONTH','EVENT'].includes(rule.period)) {
      const period = await this.periodPolicy(ctx, mr, rule.period || 'DAY', `AGG_${rule.id}`);
      const scope = await this.insert('scope_sets', { family_id: ctx.family, name: `집계 ${rule.id}`, version_no: 1 });
      await this.insert('scope_members', { family_id: ctx.family, scope_id: scope, series_id: series });
      if (mr.sticker) await this.insert('scope_members', { family_id: ctx.family, scope_id: scope, sticker_type_id: mr.sticker });
      const ag = rule.aggregate || {};
      mr.aggregation = await this.insert('aggregation_specs', { family_id: ctx.family, scope_id: scope, period_policy_id: period, special_event_id: String(rule.period).toUpperCase() === 'EVENT' ? await this.specialEvent(ctx) : null, operation: ag.operation || 'COUNT', input_metric_code: ag.metric && !['stickers','completed'].includes(ag.metric) ? ag.metric : null, source_kind: ag.metric === 'stickers' ? 'STICKER_EVENT' : (ag.metric === 'completed' || !ag.metric ? 'VERIFIED_OCCURRENCE' : 'VERIFIED_VALUE'), denominator_mode: (ag.operation || '').toUpperCase() === 'PERCENT' ? 'CONFIRMED_ELIGIBLE' : null });
    }
    let ci = 0;
    for (const c of rule.conditions || []) {
      ci += 1;
      const mode = (c.mode || (mr.aggregation ? 'PER_PERIOD' : 'PER_OCCURRENCE')).toUpperCase();
      const condition = await this.insert('conditions', { family_id: ctx.family, rule_version_id: version, stable_key: this.uid(`${rule.id}:condition:${c.key || ci}`), label: c.label || c.key || `조건 ${ci}`, direction: c.direction || 'NEUTRAL', mode, aggregation_id: mode === 'PER_PERIOD' ? mr.aggregation : null, conflict_group: c.conflictGroup || c.conflict_group || null, match_policy: c.matchPolicy || c.match_policy || 'CUMULATIVE' });
      const mc = { ...c, id: condition, effects: [], limits: [] };
      let gi = 0;
      for (const group of c.groups || []) {
        gi += 1;
        const pg = await this.insert('predicate_groups', { family_id: ctx.family, condition_id: condition, rule_version_id: version, group_no: gi });
        for (const p of group) {
          const aggregate = Boolean(p.aggregate || p.metric === 'aggregate' || p.metric === 'stickers' || p.metric === 'completed');
          const metricId = aggregate ? null : mr.metrics[p.metric];
          if (!aggregate && !metricId) throw new Error(`${rule.id}/${c.key || ci}: 정의되지 않은 metric ${p.metric}`);
          const rhs = this.rhs(p.value);
          await this.insert('predicates', { family_id: ctx.family, group_id: pg, rule_version_id: version, metric_id: metricId, aggregate_result: aggregate, operator: p.op || p.operator || 'EQ', ...rhs });
        }
      }
      let ei = 0;
      for (const e of c.effects || []) {
        ei += 1; const asset = e.asset || 'MIN';
        if (!ctx.assets[asset]) throw new Error(`지원하지 않는 자산: ${asset}`);
        const isWish = asset === 'WISH';
        if (isWish ? !(e.text || e.text_value) : e.amount == null) throw new Error(`${rule.id}/${c.key || ci}: ${asset} 효과 값 누락`);
        const effect = await this.insert('condition_effects', { family_id: ctx.family, condition_id: condition, stable_key: this.uid(`${rule.id}:effect:${c.key || ci}:${ei}`), position: ei, effect_type_id: ctx.effects[`${c.direction || 'REWARD'}:${asset}`], direction: c.direction || 'REWARD', asset_id: ctx.assets[asset], amount: isWish ? null : asNumber(e.amount, '효과량'), text_value: isWish ? (e.text || e.text_value) : null, name_snapshot: `${asset} ${c.direction || 'REWARD'}` });
        mc.effects.push({ ...e, id: effect, assetId: ctx.assets[asset] });
      }
      for (const lim of c.limits || []) {
        const lp = await this.limitPolicy(ctx, mr, rule, lim, c.direction || 'REWARD');
        await this.insert('condition_limits', { family_id: ctx.family, condition_id: condition, limit_policy_id: lp.id, priority: lim.priority || 1 });
        mc.limits.push({ spec: lim, ...lp });
      }
      mr.conditions.push(mc);
    }
    ctx.rules.set(rule.id, mr);
  }
  rhs(value) {
    if (typeof value === 'boolean') return { rhs_number: null, rhs_boolean: value, rhs_time: null, rhs_instant: null };
    if (typeof value === 'number') return { rhs_number: asNumber(value), rhs_boolean: null, rhs_time: null, rhs_instant: null };
    if (/^\d{2}:\d{2}/.test(String(value))) return { rhs_number: null, rhs_boolean: null, rhs_time: value, rhs_instant: null };
    return { rhs_number: null, rhs_boolean: null, rhs_time: null, rhs_instant: value };
  }
  async specialEvent(ctx) {
    if (ctx.specialEvent) return ctx.specialEvent;
    ctx.specialEvent = await this.insert('special_events', { family_id: ctx.family, name: '테스트 EVENT 2026-11-01~04', starts_at: `${EVENT_START}T00:00:00+09:00`, ends_at: `${EVENT_END}T00:00:00+09:00`, timezone: KST });
    return ctx.specialEvent;
  }
  async periodPolicy(ctx, mr, raw, prefix) {
    const period = String(raw || 'DAY').toUpperCase(); const key = `${prefix}:${period}`;
    if (mr.periodPolicies.has(key)) return mr.periodPolicies.get(key);
    const kind = period === 'MONTH' ? 'CALENDAR_MONTH' : period;
    const id = await this.insert('period_policies', { family_id: ctx.family, code: `${prefix}_${period}`.slice(0, 100), kind, timezone: KST, week_start: kind === 'WEEK' ? 1 : null, anchor_on: null, custom_days: null });
    mr.periodPolicies.set(key, id); return id;
  }
  sharedLimitKey(rule, lim) {
    const shared = [...(lim.sharedRules || []), rule.id].sort().join('|');
    return `${lim.key || `${lim.kind}:${lim.period}:${lim.asset || ''}`}:${shared}:${lim.kind}:${lim.asset || ''}`;
  }
  async limitPolicy(ctx, mr, rule, lim, direction) {
    const key = this.sharedLimitKey(rule, lim);
    if (ctx.sharedLimitPolicies?.has(key)) {
      const prior = ctx.sharedLimitPolicies.get(key);
      const exists = await this.one('select id from pr_model.scope_members where family_id=$1 and scope_id=$2 and series_id=$3', [ctx.family, prior.scope, mr.series]);
      if (!exists) await this.insert('scope_members', { family_id: ctx.family, scope_id: prior.scope, series_id: mr.series });
      return prior;
    }
    ctx.sharedLimitPolicies ||= new Map();
    const scope = await this.insert('scope_sets', { family_id: ctx.family, name: `한도 ${key}`.slice(0, 180), version_no: 1 });
    const included = new Set([rule.id, ...(lim.sharedRules || [])]);
    // 이후 규칙이 아직 materialize 되지 않았어도, 안정 policy는 현재 조건에 연결되고 scope 목적은 감사용이다.
    for (const id of included) { const target = ctx.rules.get(id); if (target) await this.insert('scope_members', { family_id: ctx.family, scope_id: scope, series_id: target.series }); }
    const policySeries = await this.insert('limit_policy_series', { family_id: ctx.family, stable_key: this.uid(`limit:${key}`), name: `한도 ${lim.key || key}` });
    const ppid = await this.periodPolicy(ctx, mr, lim.period || 'DAY', `LIMIT_${key}`);
    const lp = { id: await this.insert('limit_policies', { family_id: ctx.family, policy_series_id: policySeries, version_no: 1, scope_id: scope, period_policy_id: ppid, direction, limit_kind: lim.kind || 'COUNT', asset_id: (lim.kind || 'COUNT') === 'AMOUNT' ? ctx.assets[lim.asset || 'MIN'] : null, max_value: asNumber(lim.max, '한도'), allocation_mode: lim.allocation || 'WHOLE_CONDITION', effective_from: '2026-01-01' }), scope, policySeries, period: lim.period || 'DAY', specialEvent: String(lim.period).toUpperCase() === 'EVENT' ? await this.specialEvent(ctx) : null, ...lim };
    ctx.sharedLimitPolicies.set(key, lp); return lp;
  }

  async request(ctx, key, action, payload, fn) {
    const requestKey = uuidFrom(`${ctx.scenario.id}:request:${key}`); const hash = digest(payload);
    const existing = await this.one('select payload_hash,response_payload from pr_model.request_events where family_id=$1 and actor_id=$2 and request_key=$3', [ctx.family, ctx.parent, requestKey]);
    if (existing) {
      if (existing.payload_hash !== hash) { ctx.rejected++; return { replay: false, rejected: true, reason: '같은 key의 다른 payload 재전송' }; }
      return { replay: true, value: existing.response_payload };
    }
    const value = await fn();
    await this.insert('request_events', { family_id: ctx.family, actor_id: ctx.parent, request_key: requestKey, action, payload_hash: hash, response_payload: JSON.stringify(value) });
    return { replay: false, value };
  }

  validateValues(rule, values = {}) {
    const defs = new Map((rule.metricDefs || []).map(d => [d.code, d]));
    for (const [code, value] of Object.entries(values)) {
      const def = defs.get(code); if (!def) throw new Error(`정의되지 않은 측정값 ${code}`);
      const kind = this.valueKind(def);
      if (kind === 'BOOLEAN' && typeof value !== 'boolean') throw new Error(`${code}: BOOLEAN 값 필요`);
      if (kind === 'NUMBER') {
        if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${code}: 유한 NUMBER 필요`);
        const min = def.min ?? (String(def.unit).toUpperCase() === 'PERCENT' ? 0 : -1000000); const max = def.max ?? (String(def.unit).toUpperCase() === 'PERCENT' ? 100 : 1000000);
        if (value < min || value > max) throw new Error(`${code}: 범위 ${min}~${max} 위반`);
      }
      if (kind === 'LOCAL_TIME' && !/^\d{2}:\d{2}(:\d{2})?$/.test(String(value))) throw new Error(`${code}: LOCAL_TIME 형식 필요`);
      if (kind === 'INSTANT' && Number.isNaN(Date.parse(value))) throw new Error(`${code}: INSTANT 형식 필요`);
    }
  }
  async record(ctx, step, idx) {
    const key = step.key || `record-${idx}`; const rule = this.rules.get(step.rule); const mr = ctx.rules.get(step.rule);
    if (!rule || !mr) throw new Error(`알 수 없는 rule: ${step.rule}`);
    const replay = await this.request(ctx, `record:${key}`, 'RECORD', step, async () => {
      this.validateValues(rule, step.values || {});
      if (step.revisionOf) return this.recordRevision(ctx, step, mr, key);
      const existing = ctx.records.get(key); if (existing) return { occurrence_id: existing.occurrence, record_key: key };
      const date = step.date; if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) throw new Error('record.date는 YYYY-MM-DD 필요');
      const sequenceKey = `${mr.assignment}:${date}`; const sequence = (ctx.sequences.get(sequenceKey) || 0) + 1; ctx.sequences.set(sequenceKey, sequence);
      const occurredAt = iso(step.at, date, '12:00:00');
      const occurrence = await this.insert('occurrences', { family_id: ctx.family, assignment_id: mr.assignment, child_id: ctx.child, series_id: mr.series, business_date: date, sequence_no: sequence, occurred_at: iso(step.occurredAt, date, '12:00:00'), recorded_at: occurredAt, kind: step.kind || 'PERFORMANCE', origin_key: uuidFrom(`${ctx.scenario.id}:origin:${key}`), rule_version_id: mr.version });
      await this.insert('observations', { family_id: ctx.family, occurrence_id: occurrence, actor_id: ctx.childPrincipal, actor_role: 'CHILD', payload: JSON.stringify({ childValues: step.childValues || step.values || {}, recordKey: key }), request_key: uuidFrom(`${ctx.scenario.id}:observation:${key}`), recorded_at: occurredAt });
      const rec = { key, occurrence, ruleId: step.rule, date, at: occurredAt, verification: null, values: step.values || {}, decision: step.decision || 'HOLD', stickerEvents: [] };
      ctx.records.set(key, rec); ctx.recordPayloads.set(key, stable(step));
      if (step.decision && step.decision !== 'HOLD') await this.confirmRecord(ctx, rec, step.decision, step.values || {}, step.stickers, occurredAt, '입력 record 부모 확인');
      return { occurrence_id: occurrence, record_key: key };
    });
    if (replay.rejected) { this.log(ctx.scenario, idx, 'REJECTED', { op: 'record', key, reason: replay.reason }); return; }
    this.log(ctx.scenario, idx, replay.replay ? 'IDEMPOTENT_REPLAY' : 'RECORDED', { op: 'record', key });
  }
  async recordRevision(ctx, step, mr, key) {
    const rec = ctx.records.get(step.revisionOf); if (!rec) throw new Error(`revisionOf 대상 없음: ${step.revisionOf}`);
    const latest = await this.one('select id,revision_no from pr_model.verifications where family_id=$1 and occurrence_id=$2 order by revision_no desc limit 1', [ctx.family, rec.occurrence]);
    const values = step.values || rec.values;
    this.validateValues(this.rules.get(rec.ruleId), values);
    await this.insert('observations', { family_id: ctx.family, occurrence_id: rec.occurrence, actor_id: ctx.parent, actor_role: 'PARENT', payload: JSON.stringify({ revisionOf: step.revisionOf, values }), request_key: uuidFrom(`${ctx.scenario.id}:revision-observation:${key}`), recorded_at: iso(step.at,step.date || rec.date,'12:00:00') });
    await this.confirmRecord(ctx, rec, step.decision === 'HOLD' ? null : (step.decision || 'CONFIRMED'), values, step.stickers, iso(step.at, step.date || rec.date, '12:00:00'), step.reason || `원 기록 ${step.revisionOf} 정정`, latest?.id || null);
    rec.values = values; rec.decision = step.decision || 'CONFIRMED'; return { occurrence_id: rec.occurrence, revision_of: step.revisionOf };
  }
  async confirmRecord(ctx, rec, decision, values, stickers, at, reason, supersedes = undefined) {
    if (!decision || decision === 'HOLD') return null;
    const mr = ctx.rules.get(rec.ruleId); const previous = supersedes === undefined ? await this.one('select id,revision_no from pr_model.verifications where family_id=$1 and occurrence_id=$2 order by revision_no desc limit 1', [ctx.family, rec.occurrence]) : (supersedes ? await this.one('select id,revision_no from pr_model.verifications where id=$1', [supersedes]) : null);
    const verification = await this.insert('verifications', { family_id: ctx.family, occurrence_id: rec.occurrence, rule_version_id: mr.version, revision_no: (previous?.revision_no || 0) + 1, actor_id: ctx.parent, supersedes_id: previous?.id || null, decision: decision === 'HOLD' ? 'CONFIRMED' : decision, reason: reason || '부모 확인', recorded_at:at });
    for (const [code, value] of Object.entries(values || {})) {
      const def = (this.rules.get(rec.ruleId).metricDefs || []).find(m => m.code === code); const kind = this.valueKind(def);
      await this.insert('verified_values', { family_id: ctx.family, verification_id: verification, rule_version_id: mr.version, metric_id: mr.metrics[code], number_value: kind === 'NUMBER' ? value : null, boolean_value: kind === 'BOOLEAN' ? value : null, time_value: kind === 'LOCAL_TIME' ? value : null, instant_value: kind === 'INSTANT' ? value : null, recorded_at:at });
    }
    rec.verification = verification; rec.values = values; rec.decision = decision;
    // 같은 원회차의 부모 revision이 새 스티커 수를 정하면 이전 스티커 원본은 보존하고 상쇄한다.
    if (supersedes && rec.stickerEvents?.length && mr.sticker) {
      for (const oldId of rec.stickerEvents) {
        const old = await this.one('select delta from pr_model.sticker_events where id=$1', [oldId]);
        if (old) await this.insert('sticker_events', { family_id: ctx.family, child_id: ctx.child, occurrence_id: rec.occurrence, verification_id: verification, sticker_type_id: mr.sticker, delta: -Number(old.delta), reason: '부모 revision의 기존 스티커 상쇄', reversal_of_id: oldId, dedupe_key: `sticker-reversal:${oldId}:${verification}`, recorded_at: at });
      }
      rec.stickerEvents = [];
    }
    if (stickers && mr.sticker && decision === 'CONFIRMED') {
      const count = asNumber(stickers, '스티커');
      if (count) { const id = await this.insert('sticker_events', { family_id: ctx.family, child_id: ctx.child, occurrence_id: rec.occurrence, verification_id: verification, sticker_type_id: mr.sticker, delta: count, reason: '입력 record sticker', reversal_of_id: null, dedupe_key: `sticker:${rec.key}:${verification}`, recorded_at: at }); rec.stickerEvents.push(id); }
    }
    return verification;
  }

  periodBounds(period, date) {
    const p = String(period || 'DAY').toUpperCase();
    if (p === 'OCCURRENCE') return { start: date, end: addDays(date, 1) };
    if (p === 'DAY') return { start: date, end: addDays(date, 1) };
    if (p === 'WEEK') { const start = monday(date); return { start, end: addDays(start, 7) }; }
    if (p === 'MONTH') { const start = monthStart(date); return { start, end: nextMonth(start) }; }
    if (p === 'EVENT') return { start: EVENT_START, end: EVENT_END };
    throw new Error(`지원하지 않는 기간: ${period}`);
  }
  async latestRecords(ctx, ruleId, start, end) {
    const mr = ctx.rules.get(ruleId);
    return this.all(`select o.id as occurrence_id,o.business_date,v.id as verification_id,v.decision,v.revision_no
      from pr_model.occurrences o left join lateral (select * from pr_model.verifications v where v.family_id=o.family_id and v.occurrence_id=o.id order by revision_no desc limit 1) v on true
      where o.family_id=$1 and o.series_id=$2 and o.business_date >= $3 and o.business_date < $4 order by o.business_date,o.sequence_no`, [ctx.family, mr.series, start, end]);
  }
  compare(actual, op, rhs) { const o = String(op || 'EQ').toUpperCase(); if (o === 'EQ') return actual === rhs; if (o === 'NE') return actual !== rhs; if (o === 'GT') return actual > rhs; if (o === 'GTE') return actual >= rhs; if (o === 'LT') return actual < rhs; if (o === 'LTE') return actual <= rhs; throw new Error(`지원하지 않는 비교연산자: ${op}`); }
  async aggregateValue(ctx, ruleId, condition, date) {
    const rule = this.rules.get(ruleId); const bounds = this.periodBounds(rule.period === 'OCCURRENCE' ? 'DAY' : rule.period, date);
    const records = await this.latestRecords(ctx, ruleId, bounds.start, bounds.end);
    const confirmed = records.filter(r => r.decision === 'CONFIRMED');
    const metric = (rule.aggregate || {}).metric;
    if (metric === 'stickers') {
      const mr = ctx.rules.get(ruleId); const r = await this.one(`select coalesce(sum(se.delta),0)::text as n from pr_model.sticker_events se join pr_model.occurrences o on o.id=se.occurrence_id where se.family_id=$1 and o.series_id=$2 and o.business_date >= $3 and o.business_date < $4`, [ctx.family, mr.series, bounds.start, bounds.end]); return Number(r.n);
    }
    if (metric === 'completed' || !metric) return confirmed.length;
    let sum = 0;
    for (const row of confirmed) {
      const vv=await this.one('select vv.number_value,vv.boolean_value from pr_model.verified_values vv join pr_model.metric_definitions m on m.id=vv.metric_id where vv.verification_id=$1 and m.code=$2',[row.verification_id,metric]);
      sum += Number(vv?.number_value ?? vv?.boolean_value ?? 0);
    }
    if ((rule.aggregate || {}).operation === 'PERCENT') return records.length ? (confirmed.length * 100 / records.length) : 0;
    return sum;
  }
  async evalCondition(ctx, ruleId, condition, subjectRec, date) {
    const stored=await this.all('select pg.group_no,p.*,m.code as metric_code from pr_model.predicate_groups pg join pr_model.predicates p on p.group_id=pg.id left join pr_model.metric_definitions m on m.id=p.metric_id where pg.family_id=$1 and pg.condition_id=$2 order by pg.group_no,p.id',[ctx.family,condition.id]);
    const gm=new Map();
    for(const p of stored){if(!gm.has(p.group_no))gm.set(p.group_no,[]);gm.get(p.group_no).push(p);}
    const groups=[...gm.values()];
    if (!groups.length) return { result: 'HOLD', measured: null, reason: '조건 원자가 없어 정책 완전성 검토 필요' };
    let aggregate = null;
    const passes = [];
    for (const group of groups) {
      let ok = true;
      for (const p of group) {
        const isAgg = p.aggregate_result;
        let actual=null;
        if(isAgg) actual=await this.aggregateValue(ctx,ruleId,condition,date);
        else if(subjectRec?.verification){
          const vv=await this.one('select * from pr_model.verified_values where verification_id=$1 and metric_id=$2',[subjectRec.verification,p.metric_id]);
          if(vv)actual=vv.number_value!==null?Number(vv.number_value):(vv.boolean_value??vv.time_value??vv.instant_value);
        }
        const rhs=p.rhs_number!==null?Number(p.rhs_number):(p.rhs_boolean??p.rhs_time??p.rhs_instant);
        if (isAgg) aggregate = actual;
        if (actual === undefined || actual === null || !this.compare(actual, p.operator, rhs)) ok = false;
      }
      passes.push(ok);
    }
    return { result: passes.some(Boolean) ? 'MATCH' : 'NO_MATCH', measured: aggregate, reason: passes.some(Boolean) ? 'OR 그룹 중 하나의 AND 원자 전체 충족' : '모든 OR 그룹 불충족' };
  }
  exclusiveConditions(conditions, matching) {
    const selected = new Set(matching.map(c => c.id));
    const groups = new Map();
    for (const c of conditions.filter(c => c.match_policy === 'EXCLUSIVE' && c.conflict_group)) { if (!groups.has(c.conflict_group)) groups.set(c.conflict_group, []); groups.get(c.conflict_group).push(c); }
    for (const list of groups.values()) {
      const hits = list.filter(c => selected.has(c.id)); if (hits.length > 1) {
        // 미승인 우선순위를 추정하지 않는다. 겹친 배타 조건 전체를 보류한다.
        for (const c of hits) selected.delete(c.id);
      }
    }
    return selected;
  }
  async evaluate(ctx, step, idx) {
    const rule = this.rules.get(step.rule); const mr = ctx.rules.get(step.rule); if (!rule || !mr) throw new Error(`알 수 없는 rule: ${step.rule}`);
    if (['INACTIVE','EXCLUDED','UNRESOLVED'].includes(rule.status)) { ctx.blocked++; this.log(ctx.scenario, idx, 'BLOCKED', { op:'evaluate', rule:rule.id, status:rule.status }); return; }
    const date = step.date; const period = rule.period || 'OCCURRENCE'; const bounds = this.periodBounds(period, date);
    const subjectOcc = period === 'OCCURRENCE' ? await this.one('select id from pr_model.occurrences where family_id=$1 and series_id=$2 and business_date=$3 order by sequence_no desc limit 1', [ctx.family, mr.series, date]) : null;
    if (period === 'OCCURRENCE' && !subjectOcc) { this.log(ctx.scenario, idx, 'NO_OCCURRENCE', { op:'evaluate', rule:rule.id, reason:'거절되거나 아직 기록되지 않은 회차는 판정·지급하지 않음' }); return; }
    const origin = period === 'OCCURRENCE' ? `occurrence:${subjectOcc.id}` : `period:${mr.aggregation}:${bounds.start}:${bounds.end}`;
    let subject = await this.one('select id from pr_model.evaluation_subjects where family_id=$1 and child_id=$2 and series_id=$3 and origin_key=$4', [ctx.family, ctx.child, mr.series, origin]);
    if (!subject) {
      subject = { id: await this.insert('evaluation_subjects', { family_id: ctx.family, child_id: ctx.child, series_id: mr.series, kind: period === 'OCCURRENCE' ? 'OCCURRENCE' : 'PERIOD', occurrence_id: period === 'OCCURRENCE' ? subjectOcc.id : null, aggregation_id: period === 'OCCURRENCE' ? null : mr.aggregation, period_start: period === 'OCCURRENCE' ? null : bounds.start, period_end: period === 'OCCURRENCE' ? null : bounds.end, timezone_snapshot: KST, special_event_id: period === 'EVENT' ? await this.specialEvent(ctx) : null, origin_key: origin }) };
    }
    const inputs = await this.latestRecords(ctx, rule.id, bounds.start, bounds.end);
    const eligible = inputs.filter(x => x.decision !== 'EXEMPT' && x.decision !== 'VOID'); const confirmed = eligible.filter(x => x.decision === 'CONFIRMED'); const held = inputs.filter(x => !x.verification_id).length;
    const completeness = held ? 'HOLD' : 'FINAL';
    const rev = await this.one('select coalesce(max(revision_no),0)::int as n from pr_model.evaluations where family_id=$1 and subject_id=$2', [ctx.family, subject.id]);
    const evalId = await this.insert('evaluations', { family_id: ctx.family, subject_id: subject.id, rule_version_id: mr.version, revision_no: rev.n + 1, completeness, eligible_count: eligible.length, confirmed_count: confirmed.length, hold_count: held, excluded_count: inputs.length - eligible.length, engine_version: ENGINE_VERSION, input_digest: digest(inputs) });
    for (const r of inputs) if (r.verification_id) await this.insert('evaluation_inputs', { family_id: ctx.family, evaluation_id: evalId, verification_id: r.verification_id, included: r.decision === 'CONFIRMED', exclusion_reason: r.decision === 'CONFIRMED' ? null : r.decision });
    const subjectRec = period === 'OCCURRENCE' ? [...ctx.records.values()].find(x => x.occurrence === subjectOcc.id) : null;
    const matches = [];
    for (const condition of mr.conditions) {
      // OCCURRENCE는 하나의 사실 확인이 기준이다. 미확인 회차에서 보상·중립·패널티를 모두
      // 잠정 HOLD로 남겨 이후 부모 revision에만 새 판정·권리가 생기게 한다.
      const outcome = held && period === 'OCCURRENCE' ? { result: 'HOLD', measured: null, reason: '미확인 회차: 모든 조건 최종 판정 보류' } : (held && condition.direction === 'PENALTY' ? { result: 'HOLD', measured: null, reason: '미확인 사실이 있어 패널티 최종 판정 보류' } : (subjectRec?.decision === 'EXEMPT' ? { result: 'EXEMPT', measured: null, reason: '확인 EXEMPT' } : await this.evalCondition(ctx, rule.id, condition, subjectRec, date)));
      const resultId = await this.insert('condition_results', { family_id: ctx.family, evaluation_id: evalId, rule_version_id: mr.version, condition_id: condition.id, result: outcome.result, measured_value: outcome.measured, reason: outcome.reason });
      if (outcome.result === 'MATCH') matches.push({ condition, resultId });
      else if (outcome.result === 'HOLD') await this.insert('admissions', { family_id: ctx.family, condition_result_id: resultId, status: 'HELD', reason: outcome.reason, supersedes_id: null });
    }
    const selection = this.exclusiveConditions(mr.conditions, matches.map(m => m.condition));
    const evaluatedAt = iso(step.at, date, '18:00:00');
    for (const m of matches) {
      if (!selection.has(m.condition.id)) { ctx.blocked++; await this.insert('admissions', { family_id: ctx.family, condition_result_id: m.resultId, status: 'HELD', reason: '배타 조건이 겹침: 정책 충돌을 검토하기 전 발행 보류', supersedes_id: null }); continue; }
      await this.admit(ctx, mr, m.condition, m.resultId, date, idx, evaluatedAt);
    }
    this.log(ctx.scenario, idx, 'EVALUATED', { op:'evaluate', rule:rule.id, subject:subject.id, evaluation:evalId });
  }

  async admissionAlreadyGranted(ctx, conditionResultId) {
    return this.one(`select g.id from pr_model.admissions a join pr_model.admission_effects ae on ae.admission_id=a.id join pr_model.grants g on g.admission_effect_id=ae.id where a.family_id=$1 and a.condition_result_id=$2 limit 1`, [ctx.family, conditionResultId]);
  }
  async quotaBucket(ctx, limit, date) {
    const b = this.periodBounds(limit.period, date);
    let bucket = await this.one(`select id from pr_model.limit_buckets where family_id=$1 and child_id=$2 and policy_series_id=$3 and period_start=$4 and period_end=$5 and special_event_id is not distinct from $6`, [ctx.family, ctx.child, limit.policySeries, b.start, b.end, limit.specialEvent || null]);
    if (!bucket) bucket = { id: await this.insert('limit_buckets', { family_id: ctx.family, child_id: ctx.child, limit_policy_id: limit.id, policy_series_id: limit.policySeries, period_start: b.start, period_end: b.end, special_event_id: limit.specialEvent || null }) };
    return bucket.id;
  }
  async admit(ctx, mr, condition, resultId, date, idx, evaluatedAt) {
    // 새 evaluation revision의 새 condition_result라도 subject+condition의 활성 권리는 하나다.
    const subjectGrant = await this.one(`select g.id from pr_model.grants g join pr_model.admission_effects ae on ae.id=g.admission_effect_id join pr_model.admissions a on a.id=ae.admission_id join pr_model.condition_results oldcr on oldcr.id=a.condition_result_id join pr_model.evaluations ev on ev.id=oldcr.evaluation_id join pr_model.condition_results cr on cr.id=$2 where g.family_id=$1 and oldcr.condition_id=cr.condition_id and ev.subject_id=(select subject_id from pr_model.evaluations where id=cr.evaluation_id) and not exists(select 1 from pr_model.grant_events cancel where cancel.grant_id=g.id and cancel.kind='CANCELED') limit 1`, [ctx.family, resultId]);
    const existingGrant = subjectGrant || await this.admissionAlreadyGranted(ctx, resultId);
    if (existingGrant) { this.log(ctx.scenario, idx, 'DUPLICATE_RIGHT_SUPPRESSED', { condition: condition.key, grant: existingGrant.id }); return; }
    const required = [];
    for (const l of condition.limits || []) {
      const requested = String(l.kind || 'COUNT') === 'COUNT' ? 1 : condition.effects.filter(e => (e.asset || 'MIN') === l.asset).reduce((n, e) => n + Number(e.amount || 0), 0);
      const bucket = await this.quotaBucket(ctx, l, date);
      const used = await this.one('select coalesce(sum(delta),0)::text as n from pr_model.quota_entries where family_id=$1 and bucket_id=$2', [ctx.family, bucket]);
      required.push({ ...l, bucket, requested, used: Number(used.n) });
    }
    const wholeFail = required.find(x => x.used + x.requested > Number(x.max) && x.allocation !== 'PARTIAL_ASSET');
    const partialCaps = new Map(required.filter(x => x.used + x.requested > Number(x.max) && x.allocation === 'PARTIAL_ASSET').map(x => [x.id, Math.max(0, Number(x.max) - x.used)]));
    const limitFail = wholeFail;
    const status = limitFail ? 'LIMITED' : (condition.direction === 'PENALTY' ? 'HELD' : 'ADMITTED');
    const admission = await this.insert('admissions', { family_id: ctx.family, condition_result_id: resultId, status, reason: limitFail ? `한도 초과: ${limitFail.key || limitFail.id}, ${limitFail.used}+${limitFail.requested}>${limitFail.max}` : (partialCaps.size ? 'PARTIAL_ASSET 잔여 한도만 예약' : (condition.direction === 'PENALTY' ? '패널티 후보: 부모 승인 대기' : '조건 충족 및 한도 예약')), supersedes_id: null });
    if (limitFail) { ctx.limited++; for (const e of condition.effects) await this.insert('admission_effects', { family_id: ctx.family, admission_id: admission, effect_id: e.id, asset_id: e.assetId, allowed_amount: e.asset === 'WISH' ? null : 0, allowed_text: e.asset === 'WISH' ? '' : null, status: 'BLOCKED' }); return; }
    const allocated = [];
    for (const e of condition.effects) {
      let allowed = e.asset === 'WISH' ? e.text : Number(e.amount);
      for (const l of required.filter(x => x.kind === 'AMOUNT' && x.asset === e.asset && x.allocation === 'PARTIAL_ASSET')) {
        const cap = partialCaps.get(l.id);
        if (cap !== undefined) { const use = Math.min(Number(allowed), cap); partialCaps.set(l.id, cap - use); allowed = use; }
      }
      allocated.push({ effect: e, allowed });
    }
    for (const l of required) {
      const delta = l.kind === 'COUNT' ? 1 : (l.allocation === 'PARTIAL_ASSET' ? allocated.filter(x => x.effect.asset === l.asset).reduce((n, x) => n + Number(x.allowed || 0), 0) : l.requested);
      if (delta) await this.insert('quota_entries', { family_id: ctx.family, bucket_id: l.bucket, admission_id: admission, delta, phase: 'RESERVE', reversal_of_id: null, dedupe_key: `reserve:${admission}:${l.bucket}` });
    }
    for (const allocation of allocated) {
      const e = allocation.effect;
      const isWish = e.asset === 'WISH';
      const isBlocked = !isWish && Number(allocation.allowed) === 0;
      const ae = await this.insert('admission_effects', { family_id: ctx.family, admission_id: admission, effect_id: e.id, asset_id: e.assetId, allowed_amount: isWish ? null : Number(allocation.allowed), allowed_text: isWish ? allocation.allowed : null, status: isBlocked ? 'BLOCKED' : (condition.direction === 'PENALTY' ? 'HELD' : 'ALLOWED') });
      if (isBlocked) { ctx.limited++; continue; }
      if (condition.direction === 'PENALTY') {
        // 차감은 부모 승인 전에도 권리 후보(grant)를 보존한다. 승인 전 정산에는 포함되지 않는다.
        const grant = await this.insert('grants', { family_id: ctx.family, child_id: ctx.child, admission_effect_id: ae, manual_award_id: null, asset_id: e.assetId, direction: 'PENALTY', amount: isWish ? null : Number(allocation.allowed), text_value: isWish ? allocation.allowed : null, business_date: date, dedupe_key: `grant:${ae}` });
        await this.grantEvent(ctx, grant, 'PROPOSED', '패널티 후보: 부모 승인 대기', `proposed:${grant}`, evaluatedAt);
        continue;
      }
      const grant = await this.insert('grants', { family_id: ctx.family, child_id: ctx.child, admission_effect_id: ae, manual_award_id: null, asset_id: e.assetId, direction: 'REWARD', amount: isWish ? null : Number(allocation.allowed), text_value: isWish ? allocation.allowed : null, business_date: date, dedupe_key: `grant:${ae}` });
      await this.grantEvent(ctx, grant, 'PROPOSED', '확정 보상권', `proposed:${grant}`, evaluatedAt);
      await this.grantEvent(ctx, grant, 'APPROVED', '확정 보상 자동 승인', `approved:${grant}`, evaluatedAt);
    }
  }
  async grantEvent(ctx, grant, kind, reason, suffix, at = null) {
    return this.insert('grant_events', { family_id: ctx.family, grant_id: grant, actor_id: ctx.parent, kind, reason, request_key: uuidFrom(`${ctx.scenario.id}:${suffix}:${at || ''}`), ...(at ? { recorded_at: at } : {}) });
  }
  async approve(ctx, step, idx) {
    const rules = step.rule ? [step.rule] : [...ctx.rules.keys()]; let n = 0;
    for (const ruleId of rules) {
      const mr = ctx.rules.get(ruleId); if (!mr) continue;
      const rows = await this.all(`select a.id as admission_id, ae.id as ae_id,ae.asset_id,ae.allowed_amount,ae.allowed_text,c.direction,o.business_date
      from pr_model.admissions a join pr_model.condition_results cr on cr.id=a.condition_result_id join pr_model.conditions c on c.id=cr.condition_id join pr_model.evaluation_inputs ei on ei.evaluation_id=cr.evaluation_id
      join pr_model.verifications v on v.id=ei.verification_id join pr_model.occurrences o on o.id=v.occurrence_id
      join pr_model.admission_effects ae on ae.admission_id=a.id
      where a.family_id=$1 and c.rule_version_id=$2 and a.status='HELD' and c.direction='PENALTY' and ae.status='HELD'`, [ctx.family, mr.version]);
      for (const r of rows) {
      const existing = await this.one('select id from pr_model.grants where family_id=$1 and admission_effect_id=$2', [ctx.family, r.ae_id]);
      if (existing) { await this.grantEvent(ctx, existing.id, 'APPROVED', '부모 패널티 승인', `approved:${existing.id}`, step.at); n++; continue; }
        const asset = await this.one('select code from pr_model.asset_types where id=$1', [r.asset_id]);
        const g = await this.insert('grants', { family_id: ctx.family, child_id: ctx.child, admission_effect_id: r.ae_id, manual_award_id: null, asset_id: r.asset_id, direction: 'PENALTY', amount: r.allowed_amount, text_value: r.allowed_text, business_date: r.business_date, dedupe_key: `grant:${r.ae_id}` });
        await this.grantEvent(ctx, g, 'PROPOSED', '패널티 후보', `proposed:${g}`, step.at);
        await this.grantEvent(ctx, g, 'APPROVED', '부모 패널티 승인', `approved:${g}`, step.at); n++;
      }
    }
    this.log(ctx.scenario, idx, 'APPROVED', { op:'approve', count:n });
  }
  async createManualBonus(ctx, step, seed = false) {
    const assetCode = step.asset || 'MIN'; const asset = ctx.assets[assetCode]; if (!asset) throw new Error(`bonus 자산 미지원: ${assetCode}`);
    const isWish = assetCode === 'WISH'; const amount = isWish ? null : asNumber(step.amount, 'bonus.amount'); const text = isWish ? (step.text || step.text_value) : null;
    if (isWish ? !text : amount <= 0) throw new Error('bonus 값이 유효하지 않음');
    const manual = await this.insert('manual_awards', { family_id: ctx.family, child_id: ctx.child, effect_type_id: ctx.effects[`REWARD:${assetCode}`], asset_id: asset, amount, text_value: text, reason: step.reason || '테스트 자유보너스', actor_id: ctx.parent, request_key: uuidFrom(`${ctx.scenario.id}:manual:${seed ? 'initial' : this.n}`) });
    const grant = await this.insert('grants', { family_id: ctx.family, child_id: ctx.child, admission_effect_id: null, manual_award_id: manual, asset_id: asset, direction: 'REWARD', amount, text_value: text, business_date: dateOnly(step.at || '2026-10-01'), dedupe_key: `manual-grant:${manual}` });
    await this.grantEvent(ctx, grant, 'PROPOSED', step.reason || '테스트 자유보너스', `manual-proposed:${grant}`, step.at);
    await this.grantEvent(ctx, grant, 'APPROVED', step.reason || '테스트 자유보너스', `manual-approved:${grant}`, step.at);
    return grant;
  }
  async settle(ctx, step, idx) {
    const cutoff = step.cutoff || step.at; const effective = step.effective || cutoff; if (!cutoff || !effective) throw new Error('settle.cutoff/effective 필요');
    const runKey = `settle:${cutoff}:${effective}`;
    let run = await this.one('select id from pr_model.settlement_runs where family_id=$1 and run_key=$2', [ctx.family, runKey]);
    if (!run) run = { id: await this.insert('settlement_runs', { family_id: ctx.family, run_key: runKey, cutoff_at: cutoff, effective_at: effective, engine_version: ENGINE_VERSION, status: 'STARTED' }) };
    const grants = await this.all(`select g.*,a.route from pr_model.grants g join pr_model.asset_types a on a.id=g.asset_id
      where g.family_id=$1 and a.route='INTERNAL_LEDGER' and not exists (select 1 from pr_model.ledger_entries le where le.family_id=g.family_id and le.grant_id=g.id)
      and exists (select 1 from pr_model.grant_events ge where ge.family_id=g.family_id and ge.grant_id=g.id and ge.kind='APPROVED' and ge.recorded_at <= $2)
      and not exists (select 1 from pr_model.grant_events cancel where cancel.family_id=g.family_id and cancel.grant_id=g.id and cancel.kind='CANCELED')`, [ctx.family, cutoff]);
    let posted = 0;
    for (const g of grants) {
      await this.insert('ledger_entries', { family_id: ctx.family, child_id: g.child_id, asset_id: g.asset_id, grant_id: g.id, usage_item_id: null, reversal_of_id: null, settlement_run_id: run.id, kind: g.direction, delta: g.direction === 'REWARD' ? Number(g.amount) : -Number(g.amount), business_date: g.business_date, effective_at: effective, reason: '테스트 정산', dedupe_key: `ledger:${g.id}` });
      await this.grantEvent(ctx, g.id, 'POSTED', '내부원장 정산 반영', `posted:${g.id}`, effective); posted++;
    }
    // settlement_runs는 append-only but no update trigger; 상태 전이는 원 DDL에 이벤트 테이블이 없으므로 테스트상 STARTED 보존.
    this.log(ctx.scenario, idx, 'SETTLED', { op:'settle', run:run.id, posted });
  }
  async fulfill(ctx, step, idx) {
    const ruleFilter = step.rule ? ctx.rules.get(step.rule)?.version : null;
    const rows = await this.all(`select g.id,g.amount,g.text_value,a.code from pr_model.grants g join pr_model.asset_types a on a.id=g.asset_id
       where g.family_id=$1 and a.route='EXTERNAL_FULFILLMENT' and exists(select 1 from pr_model.grant_events e where e.grant_id=g.id and e.kind='APPROVED')
       and ($2::uuid is null or exists(select 1 from pr_model.admission_effects ae join pr_model.admissions ad on ad.id=ae.admission_id join pr_model.condition_results cr on cr.id=ad.condition_result_id join pr_model.conditions c on c.id=cr.condition_id where ae.id=g.admission_effect_id and c.rule_version_id=$2))
       and not exists(select 1 from pr_model.grant_events e where e.grant_id=g.id and e.kind='CANCELED')
       and not exists(select 1 from pr_model.fulfillments f where f.grant_id=g.id)`, [ctx.family, ruleFilter]);
    let n=0;
    for (const r of rows) { await this.insert('fulfillments', { family_id: ctx.family, grant_id:r.id, actor_id:ctx.parent, amount:r.amount, note:'테스트 외부 이행 기록', dedupe_key:`fulfill:${r.id}`, recorded_at: step.at || undefined }); await this.grantEvent(ctx,r.id,'FULFILLED','외부 자동지급 아님: 테스트 이행 기록',`fulfilled:${r.id}`,step.at); n++; }
    this.log(ctx.scenario,idx,'FULFILLED',{op:'fulfill',count:n,ruleVersion:ruleFilter});
  }
  async repair(ctx, step, idx) {
    const mr=ctx.rules.get(step.rule); if (!mr) throw new Error(`알 수 없는 rule: ${step.rule}`);
    const rows=await this.all(`select distinct g.id,g.asset_id,g.child_id,g.amount,g.direction,g.business_date,le.id as ledger_id,le.delta from pr_model.grants g
      join pr_model.admission_effects ae on ae.id=g.admission_effect_id join pr_model.admissions a on a.id=ae.admission_id join pr_model.condition_results cr on cr.id=a.condition_result_id
      join pr_model.conditions c on c.id=cr.condition_id left join pr_model.ledger_entries le on le.grant_id=g.id
      where g.family_id=$1 and c.rule_version_id=$2 and g.business_date=$3 and not exists(select 1 from pr_model.grant_events e where e.grant_id=g.id and e.kind='CANCELED')`,[ctx.family,mr.version,step.date]);
    if (!step.approve) { for(const r of rows) await this.grantEvent(ctx,r.id,'REVIEW_REQUIRED','정정은 부모 승인 필요',`repair-review:${r.id}`,step.at); this.log(ctx.scenario,idx,'REVIEW_REQUIRED',{op:'repair',count:rows.length}); return; }
    for (const r of rows) {
      const paid = await this.one('select id from pr_model.fulfillments where grant_id=$1', [r.id]);
      if (paid) { await this.grantEvent(ctx,r.id,'REVIEW_REQUIRED','이미 외부 이행됨: 자동 회수·취소하지 않고 검토',`repair-external-review:${r.id}`,step.at); continue; }
      if (r.ledger_id) await this.insert('ledger_entries',{family_id:ctx.family,child_id:r.child_id,asset_id:r.asset_id,grant_id:null,usage_item_id:null,reversal_of_id:r.ledger_id,settlement_run_id:null,kind:'REVERSAL',delta:-Number(r.delta),business_date:r.business_date,effective_at:step.at||iso(null,step.date,'18:00:00'),reason:'부모 승인 정정 상쇄',dedupe_key:`reverse:${r.ledger_id}`});
      await this.grantEvent(ctx,r.id,'CANCELED','부모 승인 정정: 원 권리 취소, 원장 상쇄',`repair-cancel:${r.id}`,step.at);
      const admission=await this.one('select a.id from pr_model.admissions a join pr_model.admission_effects ae on ae.admission_id=a.id join pr_model.grants g on g.admission_effect_id=ae.id where g.id=$1',[r.id]);
      const quotas=await this.all('select * from pr_model.quota_entries where family_id=$1 and admission_id=$2 and delta>0',[ctx.family,admission.id]);
      for(const q of quotas) {
        const released=await this.one('select id from pr_model.quota_entries where family_id=$1 and reversal_of_id=$2',[ctx.family,q.id]);
        if(!released) await this.insert('quota_entries',{family_id:ctx.family,bucket_id:q.bucket_id,admission_id:admission.id,delta:-Number(q.delta),phase:'RELEASE',reversal_of_id:q.id,dedupe_key:`release:${q.id}`});
      }
    }
    this.log(ctx.scenario,idx,'REPAIRED',{op:'repair',count:rows.length});
  }
  async snapshot(ctx, step, idx) {
    if(!step.at && !step.date) throw new Error('스냅샷은 관측 시각 또는 날짜를 명시해야 함');
    const at=step.at||iso(null,step.date,'23:59:00'); const day=step.date||isoDate(at);
    const prev=await this.one('select coalesce(max(revision_no),0)::int as n from pr_model.daily_snapshots where family_id=$1 and child_id=$2 and business_date=$3',[ctx.family,ctx.child,day]);
    const holds=await this.one(`select count(*)::int as n from pr_model.occurrences o where o.family_id=$1 and not exists(select 1 from pr_model.verifications v where v.occurrence_id=o.id)`,[ctx.family]);
    const pending=await this.one(`select count(*)::int as n from pr_model.grants g where g.family_id=$1 and g.direction='PENALTY' and not exists(select 1 from pr_model.grant_events e where e.grant_id=g.id and e.kind in ('APPROVED','CANCELED'))`,[ctx.family]);
    const snap=await this.insert('daily_snapshots',{family_id:ctx.family,child_id:ctx.child,business_date:day,revision_no:prev.n+1,observed_at:at,hold_count:holds.n,residual_count:0,pending_penalty_count:pending.n,settlement_run_id:null});
    for(const [code,asset] of Object.entries(ctx.assets)) { const route=ASSET_CONFIG[code].route; const av=route==='INTERNAL_LEDGER' ? await this.one('select coalesce(sum(delta),0)::text as n from pr_model.ledger_entries where family_id=$1 and child_id=$2 and asset_id=$3 and effective_at <= $4',[ctx.family,ctx.child,asset,at]) : {n:'0'}; const pend=await this.one(`select coalesce(sum(g.amount),0)::text as n from pr_model.grants g where g.family_id=$1 and g.asset_id=$2 and g.direction='REWARD' and exists(select 1 from pr_model.grant_events e where e.grant_id=g.id and e.kind='APPROVED' and e.recorded_at <= $3) and not exists(select 1 from pr_model.grant_events e where e.grant_id=g.id and e.kind='CANCELED') and not exists(select 1 from pr_model.fulfillments f where f.grant_id=g.id) and not exists(select 1 from pr_model.ledger_entries le where le.grant_id=g.id)`,[ctx.family,asset,at]); await this.insert('snapshot_assets',{family_id:ctx.family,snapshot_id:snap,asset_id:asset,available_amount:Number(av.n),pending_amount:Number(pend.n)}); }
    const actual = await this.summary(ctx, at, false);
    ctx.snapshots.push({name:step.name||`snapshot-${idx}`,at,snapshot_id:snap,actual}); this.log(ctx.scenario,idx,'SNAPSHOT',{op:'snapshot',snapshot:snap});
  }
  async summary(ctx, asOf = null, includeSnapshots = true) {
    const c=async (sql,p=[])=>Number((await this.one(sql,p)).n);
    const active=`not exists(select 1 from pr_model.grant_events e where e.family_id=g.family_id and e.grant_id=g.id and e.kind='CANCELED')`;
    const asset=(code)=>ctx.assets[code];
    const balance=async code=>c(`select coalesce(sum(delta),0)::text as n from pr_model.ledger_entries where family_id=$1 and child_id=$2 and asset_id=$3 ${asOf ? 'and effective_at <= $4' : ''}`,[ctx.family,ctx.child,asset(code),...(asOf?[asOf]:[])]);
    const entitlement=async code=>c(`select coalesce(sum(g.amount),0)::text as n from pr_model.grants g where g.family_id=$1 and g.asset_id=$2 and g.direction='REWARD' and ${active} ${asOf ? "and exists(select 1 from pr_model.grant_events approved where approved.grant_id=g.id and approved.kind='APPROVED' and approved.recorded_at <= $3)" : ''}`,[ctx.family,asset(code),...(asOf?[asOf]:[])]);
    const external=async code=>c(`select coalesce(sum(f.amount),0)::text as n from pr_model.fulfillments f join pr_model.grants g on g.id=f.grant_id where f.family_id=$1 and g.asset_id=$2 ${asOf ? 'and f.recorded_at <= $3' : ''}`,[ctx.family,asset(code),...(asOf?[asOf]:[])]);
    const school=await this.one(`select coalesce(sum(se.delta),0)::text as n from pr_model.sticker_events se join pr_model.sticker_types st on st.id=se.sticker_type_id where se.family_id=$1 and st.code like '%SCHOOL%'`,[ctx.family]);
    const study=await this.one(`select coalesce(sum(se.delta),0)::text as n from pr_model.sticker_events se join pr_model.sticker_types st on st.id=se.sticker_type_id where se.family_id=$1 and (st.code like '%STUDY%' or st.code like '%GITAN%')`,[ctx.family]);
    return {occurrences:await c('select count(*)::int as n from pr_model.occurrences where family_id=$1',[ctx.family]),verifications:await c('select count(*)::int as n from pr_model.verifications where family_id=$1',[ctx.family]),holdRecords:await c(`select count(*)::int as n from pr_model.occurrences o where o.family_id=$1 and not exists(select 1 from pr_model.verifications v where v.occurrence_id=o.id)`,[ctx.family]),grants:await c('select count(*)::int as n from pr_model.grants where family_id=$1',[ctx.family]),activeGrants:await c(`select count(*)::int as n from pr_model.grants g where g.family_id=$1 and ${active}`,[ctx.family]),pendingPenalties:await c(`select count(*)::int as n from pr_model.grants g where g.family_id=$1 and g.direction='PENALTY' and not exists(select 1 from pr_model.grant_events e where e.grant_id=g.id and e.kind='APPROVED')`,[ctx.family]),reviewRequired:await c(`select count(distinct g.id)::int as n from pr_model.grants g join pr_model.grant_events e on e.grant_id=g.id where g.family_id=$1 and e.kind='REVIEW_REQUIRED'`,[ctx.family]),limited:ctx.limited,ledgerEntries:await c('select count(*)::int as n from pr_model.ledger_entries where family_id=$1',[ctx.family]),ledgerMIN:await balance('MIN'),externalWON:await external('WON'),externalPOINT:await external('COUPAY_POINT'),externalWISH:await c(`select count(*)::int as n from pr_model.fulfillments f join pr_model.grants g on g.id=f.grant_id where f.family_id=$1 and g.asset_id=$2 ${asOf ? 'and f.recorded_at <= $3' : ''}`,[ctx.family,asset('WISH'),...(asOf?[asOf]:[])]),entitledWON:await entitlement('WON'),entitledPOINT:await entitlement('COUPAY_POINT'),entitledMIN:await entitlement('MIN'),quotaCount:await c(`select coalesce(sum(q.delta),0)::text as n from pr_model.quota_entries q join pr_model.limit_policies lp on lp.id=(select limit_policy_id from pr_model.limit_buckets b where b.id=q.bucket_id) where q.family_id=$1 and lp.limit_kind='COUNT'`,[ctx.family]),blocked:ctx.blocked,rejected:ctx.rejected,schoolStickerTotal:Number(school.n),studyStickerTotal:Number(study.n),snapshots:includeSnapshots ? ctx.snapshots : undefined};
  }
  checkExpected(expected, actual) { const checks=[]; for(const [k,v] of Object.entries(expected||{})){const ok=equal(actual[k],v);checks.push({field:k,expected:v,actual:actual[k],passed:ok});} return checks; }
  async runScenario(scenario) {
    const ctx=await this.setUpScenario(scenario); let error=null;
    for(let i=0;i<(scenario.steps||[]).length;i++){
      const step=scenario.steps[i];const op=normalizeOp(step.op);
      try{
        if(op==='RECORD') await this.record(ctx,step,i+1);
        else if(op==='EVALUATE') await this.evaluate(ctx,step,i+1);
        else if(op==='APPROVE') await this.approve(ctx,step,i+1);
        else if(op==='SETTLE') await this.settle(ctx,step,i+1);
        else if(op==='FULFILL') await this.fulfill(ctx,step,i+1);
        else if(op==='SNAPSHOT') await this.snapshot(ctx,step,i+1);
        else if(op==='REPAIR') await this.repair(ctx,step,i+1);
        else if(op==='BONUS'){await this.createManualBonus(ctx,step);this.log(scenario,i+1,'BONUS',{op:'bonus'});}
        else throw new Error(`지원하지 않는 op: ${step.op}`);
      }catch(e){
        if(op==='RECORD' && (scenario.expected?.rejected||0)>ctx.rejected){ctx.rejected++;this.log(scenario,i+1,'REJECTED',{op:step.op,reason:e.message});}
        else{error=e.message;this.log(scenario,i+1,'ERROR',{op:step.op,message:e.message,code:e.code||null});}
      }
    }
    const actual=await this.summary(ctx);
    const checks=this.checkExpected(scenario.expected||{},actual);
    for(const [name,expected] of Object.entries(scenario.expectedSnapshots||{})){
      const snap=ctx.snapshots.find(x=>x.name===name);
      for(const chk of this.checkExpected(expected,snap?.actual||{}))checks.push({...chk,field:`snapshot:${name}:${chk.field}`});
    }
    return {id:scenario.id,title:scenario.title||scenario.id,passed:checks.every(x=>x.passed)&&!error,error,expected:scenario.expected||{},actual,checks,trace:this.trace.filter(x=>x.scenario===scenario.id),snapshots:ctx.snapshots};
  }
  async dump(outDir) {
    const tables=(await this.all(`select table_name from information_schema.tables where table_schema='pr_model' and table_type='BASE TABLE' order by table_name`)).map(x=>x.table_name);
    const lines=['-- 테스트 전용 PGlite 상태 덤프 (식별자는 결정적 가짜 UUID, 비밀/credential 없음)']; const state={};
    for(const t of tables){const rows=await this.all(`select * from pr_model.${t} order by id`);state[t]=rows; for(const r of rows){const keys=Object.keys(r);const vals=keys.map(k=>r[k]===null?'NULL':`'${String(typeof r[k]==='object'?JSON.stringify(r[k]):r[k]).replaceAll("'","''")}'`).join(',');lines.push(`insert into pr_model.${t} (${keys.join(',')}) values (${vals});`);}}
    await fs.writeFile(path.join(outDir,'DB-state.json'),JSON.stringify(state,null,2)+'\n'); await fs.writeFile(path.join(outDir,'DB-dump.sql'),lines.join('\n')+'\n');
  }
}

async function main() {
  const [, , inputFile, outDir] = process.argv; if (!inputFile || !outDir) { usage(); process.exitCode=2; return; }
  await fs.mkdir(outDir,{recursive:true}); const input=JSON.parse(await fs.readFile(inputFile,'utf8'));
  let sql; for (const candidate of [path.join(HERE,'reference-model.sql'),'/home/ubuntu/deliverables/relational-model-20261016/Play-Routine-Relational-Reference-v0.1.sql']) try{sql=await fs.readFile(candidate,'utf8');break;}catch{}
  if(!sql) throw new Error('reference-model.sql 또는 원본 참조 SQL을 찾지 못했습니다'); const db=new PGlite(); await db.exec(sql);
  const sim=new Simulation(db,input,outDir); for(const scenario of input.scenarios||[]) sim.results.push(await sim.runScenario(scenario));
  const totals={scenarios:sim.results.length,passed:sim.results.filter(x=>x.passed).length,failed:sim.results.filter(x=>!x.passed).length};
  const result={environment:'독립 인메모리 PostgreSQL(PGlite); 운영 Supabase/credentials/git/배포 미접속',assumptions:[...(input.metadata?.commonAssumptions||[]),'EXCLUSIVE 충돌은 임의 우선순위로 선택하지 않고 해당 조건 발행을 모두 보류.','정산은 cutoff 이전 APPROVED 내부 grant만 INSERT/SELECT로 반영; 운영 RPC/RLS/다중세션 직렬화는 검증하지 않음.'],scenarios:sim.results,totals,limitations:['테스트 어댑터이며 운영 RPC·RLS·권한·다중세션 한도 잠금 증명 미포함','정산 실행의 COMMITTED 상태 UPDATE는 append-only 계약을 존중해 수행하지 않음','repair는 승인 시 원장 상쇄+grant CANCELED+quota RELEASE를 지원하며 정확한 정정 새권리 산출은 입력에 별도 record/evaluate가 필요','DB-dump.sql은 조회용 행 목록이며 FK순서 복원 스크립트가 아님. 재현은 engine.mjs와 입력파일로 수행.']};
  await fs.writeFile(path.join(outDir,'results.json'),JSON.stringify(result,null,2)+'\n'); await fs.writeFile(path.join(outDir,'trace.json'),JSON.stringify(sim.trace,null,2)+'\n');
  await fs.writeFile(path.join(outDir,'relations.csv'),'scenario,table,id\n'+sim.relations.map(r=>[sim.familyScenario.get(r.family)||'ANCHOR',r.table,r.id].map(escCsv).join(',')).join('\n')+'\n');
  const ledger=await sim.all(`select le.*,g.direction as grant_direction,a.code as asset_code from pr_model.ledger_entries le left join pr_model.grants g on g.id=le.grant_id join pr_model.asset_types a on a.id=le.asset_id order by le.recorded_at,le.id`); const cols=['id','family_id','child_id','asset_code','kind','delta','business_date','effective_at','grant_id','usage_item_id','reversal_of_id','settlement_run_id','reason','dedupe_key']; await fs.writeFile(path.join(outDir,'ledger.csv'),cols.join(',')+'\n'+ledger.map(r=>cols.map(k=>escCsv(r[k])).join(',')).join('\n')+'\n');
  await sim.dump(outDir); console.log(`완료: ${totals.scenarios}개 시나리오 / 통과 ${totals.passed} / 실패 ${totals.failed}`); await db.close(); if(totals.failed) process.exitCode=1;
}
main().catch(e=>{console.error('엔진 실패:',e.stack||e);process.exitCode=1;});
