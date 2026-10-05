'use strict';

/**
 * FinWare behavioural insight engine.
 *
 * Every value produced here is derived from real rows already loaded from the
 * SQLite warehouse. There are no hardcoded customer results, category names or
 * scores in this file - only deterministic arithmetic and business thresholds.
 *
 * All functions are pure so they can be unit tested without a database or HTTP.
 */

// ---------------------------------------------------------------------------
// generic helpers
// ---------------------------------------------------------------------------

const sum = (list) => list.reduce((total, value) => total + value, 0);

const mean = (list) => (list.length ? sum(list) / list.length : 0);

function median(list) {
  if (!list.length) return 0;
  const sorted = [...list].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Population standard deviation. Returns 0 for degenerate input. */
function stddev(list) {
  if (list.length < 2) return 0;
  const avg = mean(list);
  return Math.sqrt(sum(list.map((value) => (value - avg) ** 2)) / list.length);
}

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

const round2 = (value) => Math.round(value * 100) / 100;
const round1 = (value) => Math.round(value * 10) / 10;

const MS_PER_DAY = 86400000;
const toDay = (isoDate) => Date.parse(`${isoDate}T00:00:00Z`) / MS_PER_DAY;

// Transaction dates arrive as 'YYYY-MM-DD' from dim_date.full_date.
function sortByDate(transactions) {
  return [...transactions].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------------------
// configuration (business rules, not results)
// ---------------------------------------------------------------------------

const CONFIG = {
  // Below this many transactions a customer profile is not trustworthy.
  MIN_HISTORY: 8,
  // A category needs at least this many of the customer's transactions before it
  // can act as its own comparison baseline.
  MIN_CATEGORY_BASELINE: 3,
  // Transaction rate change (fraction) required before we claim a trend.
  FREQUENCY_SHIFT: 0.2,
  // Average amount change (fraction) required before we claim a trend.
  AMOUNT_SHIFT: 0.1,
  // Activity level is judged relative to the rest of the warehouse.
  ACTIVITY_HIGH_AT: 1.25,
  ACTIVITY_LOW_AT: 0.7,
  ACTIVITY_AMOUNT_WEIGHT: 0.6,
  ACTIVITY_FREQUENCY_WEIGHT: 0.4,
  // Weighted contributions to the 0-100 risk score.
  // Amount evidence carries 0.75 of the weight because it is the only signal
  // that reliably indicates an unusual transaction. Burst and type familiarity
  // are intentionally small: for a regularly transacting customer they are
  // neutral, and they must not dilute genuine amount evidence.
  WEIGHTS: {
    categoryDeviation: 0.5,
    amountDeviation: 0.25,
    concentration: 0.15,
    frequency: 0.05,
    typeUnfamiliarity: 0.05
  },
  // Credits are inflows, not outflows, so they cannot carry full amount risk.
  CREDIT_DAMPING: 0.45,
  // Score at which a transaction is raised for review.
  ANOMALY_AT: 61,
  RISK_HIGH_AT: 71,
  RISK_MEDIUM_AT: 31,
  // A transaction must be this far from its own baseline before we will call it
  // unusual, otherwise ordinary noise would be reported as an alert.
  MIN_RATIO_FOR_ANOMALY: 1.8
};

const INSUFFICIENT_HISTORY_MESSAGE =
  'Insufficient transaction history for a reliable behavioural prediction.';

// ---------------------------------------------------------------------------
// timeline helpers
// ---------------------------------------------------------------------------

/**
 * Split a customer's transactions into an earlier and a more recent window.
 * The split point is the midpoint of the customer's own active span, so it
 * always reflects real recorded dates rather than an arbitrary constant.
 */
function splitTimeline(transactions) {
  const ordered = sortByDate(transactions);
  const first = toDay(ordered[0].date);
  const last = toDay(ordered[ordered.length - 1].date);
  const midpoint = (first + last) / 2;

  const earlier = [];
  const recent = [];
  for (const txn of ordered) {
    (toDay(txn.date) < midpoint ? earlier : recent).push(txn);
  }
  return {
    ordered,
    earlier,
    recent,
    earlierDays: Math.max(1, midpoint - first),
    recentDays: Math.max(1, last - midpoint + 1),
    firstDate: ordered[0].date,
    lastDate: ordered[ordered.length - 1].date,
    spanDays: last - first
  };
}

/** Transactions per active day in the earlier window. */
function frequencyTrend(transactions) {
  const { earlier, recent, earlierDays, recentDays, firstDate, lastDate, spanDays } = splitTimeline(transactions);
  const earlierRate = earlier.length / earlierDays;
  const recentRate = recent.length / recentDays;

  // No earlier activity means we cannot express a percentage change honestly.
  const changePct = earlierRate > 0 ? (recentRate - earlierRate) / earlierRate : recentRate > 0 ? 1 : 0;
  const shift = CONFIG.FREQUENCY_SHIFT;
  const label = changePct >= shift ? 'Increasing' : changePct <= -shift ? 'Decreasing' : 'Stable';

  return {
    label,
    changePct: round1(changePct * 100),
    earlierRate: round2(earlierRate),
    recentRate: round2(recentRate),
    earlierCount: earlier.length,
    recentCount: recent.length,
    earlierDays: round1(earlierDays),
    recentDays: round1(recentDays),
    firstDate,
    lastDate,
    spanDays
  };
}

/** Change in the average value of a customer's transactions over time. */
function amountTrend(transactions) {
  const { earlier, recent } = splitTimeline(transactions);
  const earlierAvg = earlier.length ? sum(earlier.map((t) => t.amount)) / earlier.length : 0;
  const recentAvg = recent.length ? sum(recent.map((t) => t.amount)) / recent.length : 0;
  const changePct = earlierAvg > 0 ? (recentAvg - earlierAvg) / earlierAvg : recentAvg > 0 ? 1 : 0;
  const shift = CONFIG.AMOUNT_SHIFT;
  const label = changePct >= shift ? 'RISING' : changePct <= -shift ? 'DECLINING' : 'STABLE';

  return {
    label,
    changePct: round1(changePct * 100),
    earlierAvg: round2(earlierAvg),
    recentAvg: round2(recentAvg)
  };
}

// ---------------------------------------------------------------------------
// category breakdown
// ---------------------------------------------------------------------------

/**
 * Aggregate a customer's transactions per category.
 * Sorting is fully deterministic: amount desc, then count desc, then name asc.
 */
function categoryBreakdown(transactions, categoryLookup) {
  const buckets = new Map();
  for (const txn of transactions) {
    if (!buckets.has(txn.categoryId)) buckets.set(txn.categoryId, []);
    buckets.get(txn.categoryId).push(txn);
  }

  const totalSpend = sum(transactions.map((t) => t.amount)) || 1;
  const rows = [...buckets.entries()].map(([categoryId, txns]) => {
    const meta = categoryLookup(categoryId);
    const amounts = txns.map((t) => t.amount);
    const categoryTotal = sum(amounts);
    return {
      categoryId,
      name: meta ? meta.name : `Category ${categoryId}`,
      group: meta ? meta.group : 'Uncategorised',
      transactionCount: txns.length,
      totalSpend: round2(categoryTotal),
      averageAmount: round2(mean(amounts)),
      medianAmount: round2(median(amounts)),
      highestAmount: round2(Math.max(...amounts)),
      shareOfSpend: round1((categoryTotal / totalSpend) * 100)
    };
  });

  rows.sort(
    (a, b) => b.totalSpend - a.totalSpend || b.transactionCount - a.transactionCount || a.name.localeCompare(b.name)
  );
  return rows;
}

// ---------------------------------------------------------------------------
// activity level
// ---------------------------------------------------------------------------

/**
 * LOW / MODERATE / HIGH spending activity.
 *
 * Judged against the other customers in the same warehouse rather than a fixed
 * rupee threshold, because customers here differ by an order of magnitude in
 * size. Both components (average ticket size and transaction rate) are returned
 * so the result can be explained instead of being a bare label.
 */
function activityLevel(transactions, cohort) {
  const avgAmount = mean(transactions.map((t) => t.amount));
  const spanDays = Math.max(1, toDay(sortByDate(transactions)[transactions.length - 1].date) - toDay(sortByDate(transactions)[0].date) + 1);
  const rate = transactions.length / spanDays;

  const amountRatio = cohort.avgAmount > 0 ? avgAmount / cohort.avgAmount : 1;
  const frequencyRatio = cohort.avgRate > 0 ? rate / cohort.avgRate : 1;
  const score = CONFIG.ACTIVITY_AMOUNT_WEIGHT * amountRatio + CONFIG.ACTIVITY_FREQUENCY_WEIGHT * frequencyRatio;

  const label =
    score >= CONFIG.ACTIVITY_HIGH_AT
      ? 'HIGH SPENDING ACTIVITY'
      : score <= CONFIG.ACTIVITY_LOW_AT
        ? 'LOW SPENDING ACTIVITY'
        : 'MODERATE SPENDING ACTIVITY';

  return {
    label,
    score: round2(score),
    amountRatio: round2(amountRatio),
    frequencyRatio: round2(frequencyRatio),
    averageAmount: round2(avgAmount),
    transactionsPerDay: round2(rate),
    cohortAverageAmount: round2(cohort.avgAmount),
    cohortRate: round2(cohort.avgRate)
  };
}

// ---------------------------------------------------------------------------
// behavioural profile
// ---------------------------------------------------------------------------

/**
 * Build the complete behavioural picture for one customer.
 * `transactions` must be that customer's real rows.
 */
function behaviouralProfile(customer, transactions, cohort, categoryLookup) {
  const totalTransactions = transactions.length;
  const base = {
    userId: customer.id,
    userName: customer.name,
    sufficientHistory: totalTransactions >= CONFIG.MIN_HISTORY,
    message: null
  };

  if (!base.sufficientHistory) {
    // Deliberately return the honest answer rather than a weak prediction.
    return {
      ...base,
      totalTransactions,
      totalSpending: 0,
      averageTransaction: 0,
      highestTransaction: 0,
      primaryCategory: null,
      categories: [],
      debitCount: 0,
      creditCount: 0,
      transactionFrequency: 'Stable',
      spendingTrend: 'STABLE',
      behaviour: null,
      insight: INSUFFICIENT_HISTORY_MESSAGE
    };
  }

  const amounts = transactions.map((t) => t.amount);
  const categories = categoryBreakdown(transactions, categoryLookup);
  const frequency = frequencyTrend(transactions);
  const trend = amountTrend(transactions);
  const activity = activityLevel(transactions, cohort);

  return {
    ...base,
    totalTransactions,
    totalSpending: round2(sum(amounts)),
    averageTransaction: round2(mean(amounts)),
    highestTransaction: round2(Math.max(...amounts)),
    lowestTransaction: round2(Math.min(...amounts)),
    primaryCategory: categories[0]
      ? {
          categoryId: categories[0].categoryId,
          name: categories[0].name,
          group: categories[0].group,
          totalSpend: categories[0].totalSpend,
          shareOfSpend: categories[0].shareOfSpend,
          transactionCount: categories[0].transactionCount
        }
      : null,
    categories,
    debitCount: transactions.filter((t) => t.type === 'DEBIT').length,
    creditCount: transactions.filter((t) => t.type === 'CREDIT').length,
    transactionFrequency: frequency.label,
    frequencyDetail: frequency,
    spendingTrend: trend.label,
    trendDetail: trend,
    behaviour: activity.label,
    activityDetail: activity,
    firstDate: frequency.firstDate,
    lastDate: frequency.lastDate,
    spanDays: frequency.spanDays
  };
}

// ---------------------------------------------------------------------------
// transaction risk
// ---------------------------------------------------------------------------

/**
 * Normalise "how many times the customer's own baseline" into 0..1.
 * 1x baseline -> 0, 2x -> 0.40, 3x -> 0.70, 5x -> 0.90, 10x+ -> 1.
 */
function ratioToUnit(ratio) {
  if (!Number.isFinite(ratio) || ratio <= 1) return 0;
  if (ratio <= 2) return (ratio - 1) * 0.4;
  if (ratio <= 3) return 0.4 + (ratio - 2) * 0.3;
  if (ratio <= 5) return 0.7 + ((ratio - 3) / 2) * 0.2;
  if (ratio <= 10) return 0.9 + ((ratio - 5) / 5) * 0.1;
  return 1;
}

/**
 * Compare a transaction against the customer's baseline for that same
 * category. A customer's overall median is the wrong baseline when they split
 * spending across categories - a regular monthly rent looks enormous next to a
 * customer whose other category is groceries. When a category has too few of
 * the customer's transactions to be a baseline, we fall back to the customer's
 * overall median and say so.
 */
function categoryBaseline(txn, profileByCategory, allAmounts) {
  const stats = profileByCategory.get(txn.categoryId);
  if (stats && stats.count >= CONFIG.MIN_CATEGORY_BASELINE) {
    return { baseline: stats.median, source: 'category', sampleSize: stats.count };
  }
  return { baseline: median(allAmounts), source: 'overall', sampleSize: stats ? stats.count : 0 };
}

/**
 * Score one transaction 0-100 and explain it in business terms.
 * Deliberately avoids verdict or accusatory language: this is a review
 * indicator for a human to assess, not a conclusion about the customer.
 */
function scoreTransaction(txn, context) {
  const { userStats, allAmounts, previousGap, baselineGap } = context;

  const baseline = categoryBaseline(txn, userStats.byCategory, allAmounts);
  const safeBaseline = baseline.baseline > 0 ? baseline.baseline : txn.amount;
  const ratio = safeBaseline > 0 ? txn.amount / safeBaseline : 1;

  const categorySignal = ratioToUnit(ratio);

  const userMean = userStats.mean;
  const userStd = userStats.stddev;
  const zScore = userStd > 0 ? (txn.amount - userMean) / userStd : 0;
  const amountSignal = clamp(zScore, 0, 3) / 3;

  const lifetimeTotal = userStats.total || 1;
  const share = txn.amount / lifetimeTotal;
  const concentrationSignal = clamp(share / 0.25, 0, 1);

  // Burst signal: this gap is much tighter than the customer's usual spacing.
  const burst = previousGap > 0 && baselineGap > 0 ? baselineGap / previousGap : 1;
  const frequencySignal = clamp((1 - burst) / 0.5, 0, 1);

  // How unusual is this transaction type for this customer?
  const typeShare = userStats.typeCounts[txn.type] || 0;
  const typeSignal = clamp(1 - typeShare, 0, 1);

  const w = CONFIG.WEIGHTS;
  let score =
    100 *
    (w.categoryDeviation * categorySignal +
      w.amountDeviation * amountSignal +
      w.concentration * concentrationSignal +
      w.frequency * frequencySignal +
      w.typeUnfamiliarity * typeSignal);

  // An inflow cannot represent the same outflow exposure as a debit.
  const isCredit = txn.type === 'CREDIT';
  if (isCredit) score *= CONFIG.CREDIT_DAMPING;

  const finalScore = Math.round(clamp(score, 0, 100));
  const level = finalScore >= CONFIG.RISK_HIGH_AT ? 'HIGH' : finalScore >= CONFIG.RISK_MEDIUM_AT ? 'MEDIUM' : 'LOW';

  // Must clear both the score bar and a minimum distance from the baseline,
  // so that ordinary variation is never presented as an alert.
  const anomalous =
    finalScore >= CONFIG.ANOMALY_AT && (ratio >= CONFIG.MIN_RATIO_FOR_ANOMALY || share >= 0.25);
  const status = anomalous ? 'ANOMALOUS' : 'NORMAL';

  return {
    txnId: txn.id,
    score: finalScore,
    level,
    status,
    ratio: round2(ratio),
    baseline: round2(safeBaseline),
    baselineSource: baseline.source,
    baselineSample: baseline.sampleSize,
    shareOfLifetimeSpend: round1(share * 100),
    zScore: round2(zScore),
    categoryId: txn.categoryId,
    signals: {
      categoryDeviation: round2(categorySignal),
      amountDeviation: round2(amountSignal),
      concentration: round2(concentrationSignal),
      frequency: round2(frequencySignal),
      typeUnfamiliarity: round2(typeSignal)
    },
    reason: explainTransaction({
      status,
      level,
      ratio,
      baselineSource: baseline.source,
      baselineSample: baseline.sampleSize,
      share,
      zScore,
      txn,
      isCredit
    })
  };
}

/** Build the customer explanation from whichever signal actually dominated. */
function explainTransaction(ctx) {
  const { status, ratio, baselineSource, baselineSample, share, zScore, txn, isCredit } = ctx;

  if (status === 'NORMAL') {
    if (ratio <= 1.15) {
      return `Amount of INR ${txn.amount.toLocaleString('en-IN')} sits at or below this customer's usual transaction level for this type of spend.`;
    }
    return `Amount of INR ${txn.amount.toLocaleString('en-IN')} is within this customer's normal range for this category.`;
  }

  const relative = `${round2(ratio)}x this customer's ${baselineSource === 'category' ? `${baselineSample}-transaction category baseline` : 'overall average'}`;
  const concentration = share >= 0.2 ? ` It also represents ${round1(share * 100)}% of their recorded spending.` : '';
  const direction = isCredit ? 'inflow' : 'outflow';

  if (ratio >= 5) {
    return `This ${direction} of INR ${txn.amount.toLocaleString('en-IN')} is ${relative}, well above their established pattern.${concentration}`;
  }
  if (zScore >= 2) {
    return `This ${direction} of INR ${txn.amount.toLocaleString('en-IN')} is ${relative} and far above their typical transaction size.${concentration}`;
  }
  return `This ${direction} of INR ${txn.amount.toLocaleString('en-IN')} is ${relative}, a clear deviation from their recent spending.${concentration}`;
}

// ---------------------------------------------------------------------------
// natural language insight
// ---------------------------------------------------------------------------

/** Compose one short sentence describing what the numbers actually show. */
function buildSpendingInsight(profile, activity) {
  if (!profile.sufficientHistory) return INSUFFICIENT_HISTORY_MESSAGE;

  const parts = [];
  const name = profile.userName ? profile.userName.split(' ')[0] : 'This customer';
  const frequency = profile.transactionFrequency;
  const trend = profile.spendingTrend;

  if (frequency === 'Increasing') {
    parts.push(`${name} is transacting more often than in the earlier part of the recorded period`);
  } else if (frequency === 'Decreasing') {
    parts.push(`${name} is transacting less often than in the earlier part of the recorded period`);
  } else {
    parts.push(`${name}'s transaction frequency is steady across the recorded period`);
  }

  if (trend === 'RISING') {
    parts.push(`with the average transaction up ${Math.abs(profile.trendDetail.changePct)}%`);
  } else if (trend === 'DECLINING') {
    parts.push(`with the average transaction down ${Math.abs(profile.trendDetail.changePct)}%`);
  } else {
    parts.push('at a consistent average transaction value');
  }

  const primary = profile.primaryCategory;
  let sentence = `${parts.join(' ')}.`;

  if (primary) {
    if (primary.shareOfSpend >= 60) {
      sentence += ` Spending is heavily concentrated in ${primary.name}, which accounts for ${primary.shareOfSpend}% of their total.`;
    } else if (primary.shareOfSpend >= 40) {
      sentence += ` ${primary.name} is their leading category at ${primary.shareOfSpend}% of their total spending.`;
    } else {
      sentence += ` Spending is spread fairly evenly, led by ${primary.name} at ${primary.shareOfSpend}%.`;
    }

    const top = profile.categories[1];
    if (top && primary.shareOfSpend >= 45 && top.shareOfSpend >= 15) {
      // Phrased without a verb so plural category names stay grammatical.
      sentence += ` Next most significant: ${top.name} at ${top.shareOfSpend}%.`;
    }
  }

  if (activity.amountRatio >= 1.5) {
    sentence += ` Their average transaction is well above the typical customer in this portfolio.`;
  } else if (activity.amountRatio <= 0.6) {
    sentence += ` Their average transaction is considerably below the typical customer in this portfolio.`;
  }

  if (profile.creditCount === 0) {
    sentence += ' All recorded activity is outgoing, with no credits in this period.';
  }

  return sentence;
}

/**
 * Category specific advice, keyed by the real category names held in
 * dim_category. The advice text is fixed, but every reason quoted alongside it
 * is built from that customer's own numbers. Categories with no entry fall back
 * to a generic rule derived from the actual category name.
 */
const CATEGORY_RULES = {
  travel: { recommendation: 'Consider exploring travel-focused benefits.', offer: 'Travel Cashback Offer' },
  shopping: { recommendation: 'Review shopping expenses and consider setting a monthly spending limit.', offer: 'Shopping Cashback Offer' },
  food: { recommendation: 'Consider setting a monthly food spending limit.', offer: 'Dining Cashback Offer' },
  groceries: { recommendation: 'Plan grocery spending against a weekly budget.', offer: 'Groceries Cashback Offer' },
  rent: { recommendation: 'Review housing commitments ahead of your next renewal.', offer: 'Rent Payment Reward' },
  investment: { recommendation: 'Review investment contributions and confirm they still match your goals.', offer: 'Investment Review Session' },
  salary: { recommendation: 'Consider directing a portion of recurring income into savings.', offer: 'Savings Accelerator' },
  bills: { recommendation: 'Audit recurring bills for avoidable charges.', offer: 'Bill Payment Reward' },
  utilities: { recommendation: 'Review utility usage for savings opportunities.', offer: 'Utility Bill Reward' },
  transfer: { recommendation: 'Confirm recurring transfers are still required as intended.', offer: null },
  insurance: { recommendation: 'Confirm your insurance cover still matches your current commitments.', offer: 'Policy Review' }
};

// A recommendation is only worth making when the evidence is strong enough.
const OFFER_MIN_SHARE = 25;
const OFFER_MIN_COUNT = 3;

/**
 * Deterministic recommendation rules.
 * Every recommendation carries the figures that produced it, and nothing is
 * emitted when the underlying history is too thin to justify advice.
 */
function buildRecommendations(profile, anomalySummary) {
  if (!profile.sufficientHistory) {
    return { sufficientHistory: false, recommendations: [], disclaimer: DISCLAIMER };
  }

  const out = [];
  const push = (rec) => out.push({ id: `${rec.key}`, ...rec });

  const primary = profile.primaryCategory;

  // Rule 1: a dominant, frequently used category.
  if (primary && primary.shareOfSpend >= OFFER_MIN_SHARE && primary.transactionCount >= OFFER_MIN_COUNT) {
    const key = String(primary.name).toLowerCase();
    const rule = CATEGORY_RULES[key];
    push({
      key: `category-${primary.categoryId}`,
      title: 'Spending focus',
      recommendation: rule
        ? rule.recommendation
        : `Review ${primary.name} spending, which represents ${primary.shareOfSpend}% of this customer's recorded outflow.`,
      offer: rule ? rule.offer : null,
      reason: `${primary.name} accounts for ${primary.shareOfSpend}% of recorded spending across ${primary.transactionCount} transactions, the largest share of any category.`
    });
  }

  // Rule 2: spending trend direction.
  if (profile.spendingTrend === 'RISING') {
    push({
      key: 'trend-rising',
      title: 'Rising spend',
      recommendation: 'Your spending activity is increasing. Consider reviewing discretionary expenses.',
      offer: null,
      reason: `The average transaction rose ${Math.abs(profile.trendDetail.changePct)}% between the earlier and more recent halves of the recorded period.`
    });
  } else if (profile.spendingTrend === 'DECLINING') {
    push({
      key: 'trend-declining',
      title: 'Declining spend',
      recommendation: 'Spending has reduced over the recorded period. Consider directing the difference to savings.',
      offer: 'Savings Accelerator',
      reason: `The average transaction fell ${Math.abs(profile.trendDetail.changePct)}% between the earlier and more recent halves of the recorded period.`
    });
  }

  // Rule 3: transaction frequency.
  if (profile.transactionFrequency === 'Increasing') {
    push({
      key: 'frequency-increasing',
      title: 'Higher transaction frequency',
      recommendation: 'Transactions are becoming more frequent. Consider consolidating smaller payments.',
      offer: null,
      reason: `Transaction rate increased ${Math.abs(profile.frequencyDetail.changePct)}%, from ${profile.frequencyDetail.earlierCount} to ${profile.frequencyDetail.recentCount} transactions across the two halves of the period.`
    });
  }

  // Rule 4: repeated anomalies for this customer.
  if (anomalySummary && anomalySummary.anomalousCount >= 2) {
    push({
      key: 'repeated-anomalies',
      title: 'Unusual activity to review',
      recommendation: 'Review recent high-value transactions for unusual activity.',
      offer: null,
      reason: `${anomalySummary.anomalousCount} transactions in this period were flagged for exceeding this customer's usual pattern by a wide margin.`
    });
  } else if (anomalySummary && anomalySummary.anomalousCount === 1) {
    push({
      key: 'single-anomaly',
      title: 'Unusual activity to review',
      recommendation: 'Review the flagged high-value transaction to confirm it was expected.',
      offer: null,
      reason: `1 transaction reached a review threshold, exceeding this customer's usual amount for that category.`
    });
  }

  // Rule 5: heavy concentration in a single category.
  if (primary && primary.shareOfSpend >= 70) {
    push({
      key: 'concentration',
      title: 'Concentrated spending',
      recommendation: 'Spending is concentrated in one category. Consider balancing it with other priorities.',
      offer: null,
      reason: `${primary.name} represents ${primary.shareOfSpend}% of total recorded spending, leaving limited room for other categories.`
    });
  }

  // Rule 6: activity level relative to the rest of the portfolio.
  const activity = profile.activityDetail;
  if (activity && activity.amountRatio >= 1.5) {
    push({
      key: 'above-peer-spend',
      title: 'Above average transaction size',
      recommendation: 'Consider reviewing the largest recurring transactions for savings opportunities.',
      offer: null,
      reason: `The average transaction of ${Math.round(activity.averageAmount).toLocaleString('en-IN')} is ${activity.amountRatio}x the typical customer average of ${Math.round(activity.cohortAverageAmount).toLocaleString('en-IN')}.`
    });
  } else if (activity && activity.amountRatio <= 0.6) {
    push({
      key: 'below-peer-spend',
      recommendation: 'Spending is well below the typical customer in this portfolio. Consider saving the difference.',
      title: 'Below average transaction size',
      offer: 'Small Savings Bonus',
      reason: `The average transaction of ${Math.round(activity.averageAmount).toLocaleString('en-IN')} is ${activity.amountRatio}x the typical customer average of ${Math.round(activity.cohortAverageAmount).toLocaleString('en-IN')}.`
    });
  }

  // Stable ordering so the same customer always renders the same order.
  const order = ['category', 'concentration', 'trend-rising', 'trend-declining', 'frequency-increasing', 'repeated-anomalies', 'single-anomaly', 'above-peer-spend', 'below-peer-spend'];
  out.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));

  return { sufficientHistory: true, recommendations: out, disclaimer: DISCLAIMER };
}

const DISCLAIMER =
  'These are project-generated recommendations, not guaranteed financial advice.';

module.exports = {
  CONFIG,
  INSUFFICIENT_HISTORY_MESSAGE,
  DISCLAIMER,
  CATEGORY_RULES,
  sum,
  mean,
  median,
  stddev,
  clamp,
  round1,
  round2,
  sortByDate,
  splitTimeline,
  frequencyTrend,
  amountTrend,
  categoryBreakdown,
  activityLevel,
  behaviouralProfile,
  ratioToUnit,
  scoreTransaction,
  categoryBaseline,
  buildSpendingInsight,
  buildRecommendations
};
