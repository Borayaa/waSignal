import type { CostLine, CostsResponse, Env } from '../types';

// Cloudflare pricing used for the estimate (USD). The Cloudflare dashboard is authoritative.
const PLAN = {
  free: { name: 'Workers Free' as const, monthly: 0 },
  paid: { name: 'Workers Paid' as const, monthly: 5 },
};
const WORKER_REQ = { freePerDay: 100_000, paidPerMonth: 10_000_000, paidPerM: 0.3 };
const QUEUE = { freePerDay: 10_000, paidPerMonth: 1_000_000, paidPerM: 0.4, opsPerMessage: 3 };
const CLAIRIC_PER_M_INPUT = 0.1; // Workers AI, USD per 1M input tokens
const TOKENS_OVERHEAD_PER_CALL = 400;
const BRIDGE_POLLS_PER_DAY = 86_400 / 3; // bridge long-polls /api/bridge/sync every ~3 s while running
const D1_FREE_WRITES_PER_DAY = 100_000;

const r4 = (n: number) => Math.round(n * 10_000) / 10_000;

export async function computeCosts(env: Env, _accountId: string, monthParam?: string): Promise<CostsResponse> {
  const paid = (env.WORKERS_PLAN ?? 'free').toLowerCase() === 'paid';
  const plan = paid ? PLAN.paid : PLAN.free;
  const now = Date.now();
  const cur = new Date(now);
  let year = cur.getUTCFullYear();
  let mon = cur.getUTCMonth();
  if (monthParam && /^\d{4}-(0[1-9]|1[0-2])$/.test(monthParam)) {
    year = Number(monthParam.slice(0, 4));
    mon = Number(monthParam.slice(5)) - 1;
  }
  const month = `${year}-${String(mon + 1).padStart(2, '0')}`;
  const start = Date.UTC(year, mon, 1);
  const end = Date.UTC(year, mon + 1, 1);
  const daysInMonth = Math.round((end - start) / 86_400_000);
  const isCurrent = now >= start && now < end;
  const daysElapsed = now >= end ? daysInMonth : now < start ? 0 : Math.max(1, Math.ceil((now - start) / 86_400_000));

  const [counts, ex, daySig, dayTr, bridge] = await env.DB.batch([
    env.DB.prepare('SELECT COUNT(*) AS n FROM signals WHERE received_at >= ?1 AND received_at < ?2').bind(start, end),
    env.DB.prepare('SELECT COUNT(*) AS calls, COALESCE(SUM(LENGTH(text)), 0) AS chars FROM signals WHERE extraction IS NOT NULL AND received_at >= ?1 AND received_at < ?2').bind(start, end),
    env.DB.prepare("SELECT strftime('%Y-%m-%d', received_at / 1000, 'unixepoch') AS d, COUNT(*) AS n FROM signals WHERE received_at >= ?1 AND received_at < ?2 GROUP BY d").bind(start, end),
    env.DB.prepare("SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') AS d, COUNT(*) AS n FROM trades WHERE created_at >= ?1 AND created_at < ?2 GROUP BY d").bind(start, end),
    env.DB.prepare("SELECT COUNT(*) AS n FROM wa_state WHERE desired != 'disconnected' OR status != 'disconnected'"),
  ]);
  const signals = (counts.results[0] as { n: number }).n;
  const exr = ex.results[0] as { calls: number; chars: number };
  const tradeRows = dayTr.results as { d: string; n: number }[];
  const trades = tradeRows.reduce((a, r) => a + r.n, 0);
  const bridgeActive = (bridge.results[0] as { n: number }).n > 0;

  const extractions = exr.calls;
  const estTokens = Math.round(exr.chars / 4 + TOKENS_OVERHEAD_PER_CALL * extractions);

  // Worker requests: bridge polls (only while a WhatsApp session is wanted), one POST per message, dashboard use unknown.
  const bridgeDays = bridgeActive ? daysElapsed : 0;
  const polls = Math.round(BRIDGE_POLLS_PER_DAY * bridgeDays);
  const requests = polls + signals + Math.round(daysElapsed * 50); // ~50 dashboard/API requests per day (rough)
  const reqIncluded = paid ? WORKER_REQ.paidPerMonth : WORKER_REQ.freePerDay * daysInMonth;
  const reqCost = paid ? (Math.max(0, requests - reqIncluded) / 1e6) * WORKER_REQ.paidPerM : 0;

  const queueOps = signals * QUEUE.opsPerMessage;
  const qIncluded = paid ? QUEUE.paidPerMonth : QUEUE.freePerDay * daysInMonth;
  const qCost = paid ? (Math.max(0, queueOps - qIncluded) / 1e6) * QUEUE.paidPerM : 0;

  const aiCost = (estTokens / 1e6) * CLAIRIC_PER_M_INPUT;

  const d1Writes = signals * 2 + trades + Math.round(daysElapsed * (bridgeActive ? 24 : 0)); // signal insert+update, trade log, hourly-ish state
  const d1Included = D1_FREE_WRITES_PER_DAY * daysInMonth;

  // unitPrice is USD per 1,000,000 units.
  const lines: CostLine[] = [
    {
      item: 'Worker requests (est.)', usage: requests, unit: 'requests', included: reqIncluded, unitPrice: paid ? WORKER_REQ.paidPerM : 0, cost: r4(reqCost),
      note: paid
        ? `Paid: 10M/month included, then $0.30 per 1M. Bridge polling ~${BRIDGE_POLLS_PER_DAY.toLocaleString('en-US')} requests/day while the bridge runs.`
        : `Free: 100,000 requests/day included (hard daily limit, shown as ${daysInMonth} days). Bridge polling ~${BRIDGE_POLLS_PER_DAY.toLocaleString('en-US')} requests/day while the bridge runs.`,
    },
    {
      item: 'Queue operations', usage: queueOps, unit: 'operations', included: qIncluded, unitPrice: paid ? QUEUE.paidPerM : 0, cost: r4(qCost),
      note: paid ? '3 operations per signal (write, read, ack). Paid: 1M/month included, then $0.40 per 1M.' : '3 operations per signal. Free: 10,000 operations/day included.',
    },
    {
      item: 'Clairic extraction (Workers AI input tokens)', usage: estTokens, unit: 'tokens', included: 0, unitPrice: CLAIRIC_PER_M_INPUT, cost: r4(aiCost),
      note: 'Estimated as characters/4 + 400 tokens per call, $0.10 per 1M input tokens. Workers AI includes a free allocation of 10,000 neurons/day, which typically covers light use, so the real charge is often $0.',
    },
    {
      item: 'D1 rows written (est.)', usage: d1Writes, unit: 'rows', included: d1Included, unitPrice: 0, cost: 0,
      note: 'Free: 100,000 rows written/day included. Light signal volume stays far below this.',
    },
    { item: 'cTrader Open API', usage: trades, unit: 'orders', included: 0, unitPrice: 0, cost: 0, note: 'Free: no per-request charge from Spotware or IC Markets for Open API access.' },
  ];

  const usageCost = r4(lines.reduce((a, l) => a + l.cost, 0));
  const total = r4(usageCost + plan.monthly);
  const projected = isCurrent && daysElapsed > 0 ? r4(plan.monthly + (usageCost / daysElapsed) * daysInMonth) : total;

  const sigMap = new Map((daySig.results as { d: string; n: number }[]).map((r) => [r.d, r.n]));
  const trMap = new Map(tradeRows.map((r) => [r.d, r.n]));
  const daily: CostsResponse['daily'] = [];
  for (let d = 0; d < daysInMonth; d++) {
    const date = new Date(start + d * 86_400_000).toISOString().slice(0, 10);
    daily.push({ date, signals: sigMap.get(date) ?? 0, trades: trMap.get(date) ?? 0 });
  }

  return {
    month,
    plan: { name: plan.name, monthly: plan.monthly },
    lines,
    totals: { usage: usageCost, plan: plan.monthly, total, projectedMonthEnd: projected },
    counts: { signals, extractions, trades, daysElapsed, daysInMonth },
    daily,
    notes: [
      'All figures are estimates computed from this app\'s database. The Cloudflare dashboard (Billing and Analytics) is authoritative.',
      'unitPrice is USD per 1,000,000 units. Counts cover the whole deployment, not only this account.',
      `Plan is read from the WORKERS_PLAN variable ("${paid ? 'paid' : 'free'}"). Workers Paid costs $5/month including 10M requests and 1M queue operations.`,
      'Worker requests include an assumed ~50 dashboard/API requests per day; the Baileys bridge is assumed to run 24/7 whenever a WhatsApp session is enabled.',
      'No containers are used any more: there is no compute-time charge for a trading terminal.',
    ],
  };
}
