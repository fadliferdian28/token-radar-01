// token-radar-01 v4 — launch odds as a ridge logistic model.
//
//   logit(odds) = intercept + category effect + age-band effect
//
// fitted on all 758 protocols (has-token as the label), with an L2
// penalty (lambda) on every effect and a free intercept. The effects are
// estimated JOINTLY — unlike v3, which multiplied two separately-shrunk
// rates (a category rate times an age factor). A protocol with no
// listing date takes no age term at all: the fitted intercept already
// reflects the undated protocols (79% of them record a token), so no
// further effect is added for a missing date.
//
// The model is validated by 5-fold cross-fitting (protocols sorted by
// slug, fold = index mod 5): fit on four folds, predict the held-out
// fold, and score Brier / log-loss / AUC / calibration error. The
// honest limit, stated on the board: the cross-fit tests prediction of
// has-token status TODAY, which is the only observable proxy for a
// future launch — the odds are base rates, not forecasts about any one
// protocol.

import {
  categoryOf,
  hasTokenRecord,
  medianOf,
  protocolAge,
  type Protocol,
} from "./snapshot.ts";

/** Launch odds are clamped to this band. */
export const ODDS_LOW = 0.05;
export const ODDS_HIGH = 0.9;
/** The penalty grid the cross-fit searches (lambda is picked by Brier). */
export const LAMBDA_GRID = [1, 2, 3, 5, 10];
/** Cross-fit folds. */
export const ODDS_FOLDS = 5;
/** IRLS stops here (max coefficient step) or after this many rounds. */
const IRLS_TOL = 1e-7;
const IRLS_MAX_ROUNDS = 30;

export const AGE_BANDS = ["<1y", "1–2y", "2–3y", "3y+"] as const;
export type AgeBand = (typeof AGE_BANDS)[number] | "unknown";

/** A protocol's age band at the snapshot date. */
export function ageBand(p: Protocol, asOf: string): AgeBand {
  const age = protocolAge(p, asOf);
  if (age === null) return "unknown";
  if (age < 365) return "<1y";
  if (age < 730) return "1–2y";
  if (age < 1095) return "2–3y";
  return "3y+";
}

export interface LogitOdds {
  intercept: number;
  catEffects: Map<string, number>;
  ageEffects: Map<string, number>;
  lambda: number;
  /** Protocols per age band in the training set (for the board). */
  bandCounts: Map<string, { launched: number; total: number }>;
  /** Protocols per category in the training set (for the board). */
  catCounts: Map<string, { launched: number; total: number }>;
  globalLaunched: number;
  globalTotal: number;
  typicalWaitDays: number;
}

const sigmoid = (z: number): number =>
  1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));

/** Solve A x = b by Gaussian elimination with partial pivoting. */
function solveDense(aIn: number[][], bIn: number[]): number[] {
  const n = bIn.length;
  const m = aIn.map((row, i) => [...row, bIn[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    }
    [m[col], m[pivot]] = [m[pivot], m[col]];
    const diag = m[col][col];
    if (Math.abs(diag) < 1e-12) continue;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = m[r][col] / diag;
      if (factor === 0) continue;
      for (let cc = col; cc <= n; cc++) m[r][cc] -= factor * m[col][cc];
    }
  }
  return m.map((row, i) =>
    Math.abs(row[i]) < 1e-12 ? 0 : row[n] / row[i],
  );
}

/**
 * Fit the ridge logistic model by IRLS. Each protocol contributes at
 * most three non-zero design entries (intercept, its category, its age
 * band), so the X'WX accumulation touches only the small non-zero block
 * of each row instead of the whole matrix.
 */
export function fitLogitOdds(
  protocols: Protocol[],
  lambda: number,
  asOf: string,
): LogitOdds {
  const categories = [
    ...new Set(protocols.map((p) => categoryOf(p))),
  ].sort();
  const catIndex = new Map(categories.map((c, i) => [c, 1 + i]));
  const ageIndex = new Map(
    AGE_BANDS.map((b, i) => [b, 1 + categories.length + i]),
  );
  const npar = 1 + categories.length + AGE_BANDS.length;

  // Sparse rows: the non-zero column indices per protocol.
  const rows: number[][] = protocols.map((p) => {
    const idx = [0, catIndex.get(categoryOf(p))!];
    const band = ageBand(p, asOf);
    if (band !== "unknown") idx.push(ageIndex.get(band)!);
    return idx;
  });
  const y = protocols.map((p) => (hasTokenRecord(p) ? 1 : 0));

  let beta = new Array<number>(npar).fill(0);
  const positives = y.reduce((a, b) => a + b, 0);
  beta[0] = Math.log(
    (positives + 0.5) / (y.length - positives + 0.5),
  );
  for (let round = 0; round < IRLS_MAX_ROUNDS; round++) {
    const xtwx: number[][] = Array.from({ length: npar }, () =>
      new Array<number>(npar).fill(0),
    );
    const xtwz = new Array<number>(npar).fill(0);
    let biggestStep = 0;
    for (let i = 0; i < rows.length; i++) {
      let z = 0;
      for (const j of rows[i]) z += beta[j];
      const pr = sigmoid(z);
      const w = Math.max(pr * (1 - pr), 1e-6);
      const zAdj = z + (y[i] - pr) / w;
      for (const r of rows[i]) {
        xtwz[r] += w * zAdj;
        for (const c of rows[i]) xtwx[r][c] += w;
      }
    }
    for (let j = 1; j < npar; j++) xtwx[j][j] += lambda;
    const next = solveDense(xtwx, xtwz);
    for (let j = 0; j < npar; j++) {
      biggestStep = Math.max(biggestStep, Math.abs(next[j] - beta[j]));
    }
    beta = next;
    if (biggestStep < IRLS_TOL) break;
  }

  const catEffects = new Map<string, number>();
  for (const c of categories) catEffects.set(c, beta[catIndex.get(c)!]);
  const ageEffects = new Map<string, number>();
  for (const b of AGE_BANDS) ageEffects.set(b, beta[ageIndex.get(b)!]);

  const bandCounts = new Map<string, { launched: number; total: number }>();
  const catCounts = new Map<string, { launched: number; total: number }>();
  for (const p of protocols) {
    const band = ageBand(p, asOf);
    const bc = bandCounts.get(band) ?? { launched: 0, total: 0 };
    bc.total += 1;
    if (hasTokenRecord(p)) bc.launched += 1;
    bandCounts.set(band, bc);
    const cat = categoryOf(p);
    const cc = catCounts.get(cat) ?? { launched: 0, total: 0 };
    cc.total += 1;
    if (hasTokenRecord(p)) cc.launched += 1;
    catCounts.set(cat, cc);
  }
  const tradedAges = protocols
    .filter((p) => hasTokenRecord(p) && p.listed_at !== null)
    .map((p) => protocolAge(p, asOf) as number);

  return {
    intercept: beta[0],
    catEffects,
    ageEffects,
    lambda,
    bandCounts,
    catCounts,
    globalLaunched: positives,
    globalTotal: protocols.length,
    typicalWaitDays: Math.round(medianOf(tradedAges)),
  };
}

/** One protocol's odds from a fitted model, with its log-odds parts. */
export function oddsFromLogit(
  model: LogitOdds,
  p: Protocol,
  asOf: string,
): { odds: number; catEffect: number; ageEffect: number; ageBucket: string } {
  const band = ageBand(p, asOf);
  const catEffect = model.catEffects.get(categoryOf(p)) ?? 0;
  const ageEffect = band === "unknown" ? 0 : (model.ageEffects.get(band) ?? 0);
  const z = model.intercept + catEffect + ageEffect;
  return {
    odds: Math.max(ODDS_LOW, Math.min(ODDS_HIGH, sigmoid(z))),
    catEffect,
    ageEffect,
    ageBucket: band,
  };
}

/* ---- Cross-fit calibration ---- */

export interface CalibrationBin {
  bin: number;
  n: number;
  pred: number;
  obs: number;
}

export interface OddsScores {
  brier: number;
  logloss: number;
  auc: number;
  ece: number;
}

export interface OddsCalibration extends OddsScores {
  curve: CalibrationBin[];
  lambdaGrid: Array<{ lambda: number; brier: number }>;
  lambdaPicked: number;
  baselines: Array<{ name: string } & OddsScores>;
  folds: number;
  n: number;
}

function scorePredictions(
  preds: number[],
  labels: number[],
): OddsScores & { curve: CalibrationBin[] } {
  const n = preds.length;
  let brier = 0;
  let logloss = 0;
  for (let i = 0; i < n; i++) {
    brier += (preds[i] - labels[i]) ** 2;
    const q = Math.max(1e-9, Math.min(1 - 1e-9, preds[i]));
    logloss += labels[i] ? Math.log(q) : Math.log(1 - q);
  }
  brier /= n;
  logloss = -logloss / n;

  // AUC by Mann-Whitney (no ties handling beyond the 0.5 credit).
  const pos: number[] = [];
  const neg: number[] = [];
  preds.forEach((pr, i) => (labels[i] ? pos : neg).push(pr));
  let wins = 0;
  let ties = 0;
  for (const a of pos) {
    for (const b of neg) {
      if (a > b) wins += 1;
      else if (a === b) ties += 1;
    }
  }
  const auc = (wins + 0.5 * ties) / (pos.length * neg.length);

  // Calibration curve + ECE on ten equal-count bins.
  const order = preds.map((_, i) => i).sort((a, b) => preds[a] - preds[b]);
  const curve: CalibrationBin[] = [];
  let ece = 0;
  for (let b = 0; b < 10; b++) {
    const chunk = order.slice(
      Math.floor((b * n) / 10),
      Math.floor(((b + 1) * n) / 10),
    );
    if (chunk.length === 0) continue;
    const pred =
      chunk.reduce((s, i) => s + preds[i], 0) / chunk.length;
    const obs =
      chunk.reduce((s, i) => s + labels[i], 0) / chunk.length;
    curve.push({ bin: b + 1, n: chunk.length, pred, obs });
    ece += (chunk.length / n) * Math.abs(obs - pred);
  }
  return { brier, logloss, auc, ece, curve };
}

/** Five-fold cross-fitted predictions from a fit/predict pair. */
function crossFit<T>(
  ordered: Protocol[],
  fit: (train: Protocol[]) => T,
  predict: (model: T, p: Protocol) => number,
): number[] {
  const preds = new Array<number>(ordered.length).fill(0);
  for (let f = 0; f < ODDS_FOLDS; f++) {
    const train = ordered.filter((_, i) => i % ODDS_FOLDS !== f);
    const model = fit(train);
    ordered.forEach((p, i) => {
      if (i % ODDS_FOLDS === f) preds[i] = predict(model, p);
    });
  }
  return preds;
}

/* ---- The multiplicative odds model (v3), as a baseline ---- */

interface Multiplicative {
  globalRate: number;
  catRate: Map<string, number>;
  bandFactor: Map<string, number>;
  datedRate: number;
}

function fitMultiplicative(
  train: Protocol[],
  asOf: string,
): Multiplicative {
  const globalRate =
    train.filter(hasTokenRecord).length / train.length;
  const cats = new Map<string, { launched: number; total: number }>();
  for (const p of train) {
    const cat = categoryOf(p);
    const s = cats.get(cat) ?? { launched: 0, total: 0 };
    s.total += 1;
    if (hasTokenRecord(p)) s.launched += 1;
    cats.set(cat, s);
  }
  const catRate = new Map<string, number>();
  for (const [cat, s] of cats) {
    catRate.set(cat, (s.launched + 10 * globalRate) / (s.total + 10));
  }
  const dated = train.filter((p) => p.listed_at !== null);
  const datedRate =
    dated.filter(hasTokenRecord).length / Math.max(1, dated.length);
  const bandFactor = new Map<string, number>();
  for (const band of AGE_BANDS) {
    const members = dated.filter((p) => ageBand(p, asOf) === band);
    const rate = members.length
      ? members.filter(hasTokenRecord).length / members.length
      : datedRate;
    bandFactor.set(band, rate / datedRate);
  }
  return { globalRate, catRate, bandFactor, datedRate };
}

const predictMultiplicative =
  (asOf: string) =>
  (m: Multiplicative, p: Protocol): number => {
    const cat = m.catRate.get(categoryOf(p)) ?? m.globalRate;
    const factor = m.bandFactor.get(ageBand(p, asOf)) ?? 1;
    return Math.max(ODDS_LOW, Math.min(ODDS_HIGH, cat * factor));
  };

/**
 * Pick lambda by cross-fitted Brier, then calibrate the picked model.
 * Rule: the smallest Brier wins; among lambdas within 0.0005 of it, the
 * largest (most regularized) wins. The full grid is returned for the
 * board, so the pick is auditable.
 */
export function calibrateOdds(
  protocols: Protocol[],
  asOf: string,
): { calibration: OddsCalibration; finalModel: LogitOdds } {
  const ordered = [...protocols].sort((a, b) =>
    a.slug.localeCompare(b.slug),
  );
  const labels = ordered.map((p) => (hasTokenRecord(p) ? 1 : 0));

  const lambdaGrid = LAMBDA_GRID.map((lambda) => {
    const preds = crossFit(
      ordered,
      (train) => fitLogitOdds(train, lambda, asOf),
      (m, p) => oddsFromLogit(m, p, asOf).odds,
    );
    const brier =
      preds.reduce((s, pr, i) => s + (pr - labels[i]) ** 2, 0) / preds.length;
    return { lambda, brier };
  });
  const best = Math.min(...lambdaGrid.map((g) => g.brier));
  const near = lambdaGrid
    .filter((g) => g.brier <= best + 0.0005)
    .sort((a, b) => b.lambda - a.lambda);
  const lambdaPicked = near[0].lambda;

  const logitPreds = crossFit(
    ordered,
    (train) => fitLogitOdds(train, lambdaPicked, asOf),
    (m, p) => oddsFromLogit(m, p, asOf).odds,
  );
  const scored = scorePredictions(logitPreds, labels);

  const baselineDefs: Array<{
    name: string;
    fit: (train: Protocol[]) => Multiplicative;
    predict: (m: Multiplicative, p: Protocol) => number;
  }> = [
    {
      name: "Multiplicative (category rate × age factor)",
      fit: (t) => fitMultiplicative(t, asOf),
      predict: predictMultiplicative(asOf),
    },
    {
      name: "Category rate only",
      fit: (t) => fitMultiplicative(t, asOf),
      predict: (m, p) =>
        Math.max(
          ODDS_LOW,
          Math.min(
            ODDS_HIGH,
            m.catRate.get(categoryOf(p)) ?? m.globalRate,
          ),
        ),
    },
    {
      name: "Age band only",
      fit: (t) => fitMultiplicative(t, asOf),
      predict: (m, p) => {
        const rate = (m.bandFactor.get(ageBand(p, asOf)) ?? 1) * m.datedRate;
        return Math.max(ODDS_LOW, Math.min(ODDS_HIGH, rate));
      },
    },
  ];
  const baselines = baselineDefs.map(({ name, fit, predict }) => {
    const preds = crossFit(ordered, fit, predict);
    const { brier, logloss, auc, ece } = scorePredictions(preds, labels);
    return { name, brier, logloss, auc, ece };
  });
  /* The global-rate baseline is a constant: it has no ranking power, so
   * its AUC is 0.5 by construction. Cross-fitting it would give each fold
   * its own train rate — five slightly different constants whose ordering
   * anti-correlates with the held-out labels (AUC 0.448), an artefact of
   * the procedure, not of the model. Score the constant full-sample rate
   * instead; with 758 protocols the in-sample optimism is ~1/n. */
  const globalRate =
    labels.reduce((a, b) => a + b, 0) / labels.length;
  const globalScores = scorePredictions(
    ordered.map(() => globalRate),
    labels,
  );
  baselines.push({
    name: "Global rate only (constant)",
    brier: globalScores.brier,
    logloss: globalScores.logloss,
    auc: globalScores.auc,
    ece: globalScores.ece,
  });

  return {
    calibration: {
      brier: scored.brier,
      logloss: scored.logloss,
      auc: scored.auc,
      ece: scored.ece,
      curve: scored.curve,
      lambdaGrid,
      lambdaPicked,
      baselines,
      folds: ODDS_FOLDS,
      n: ordered.length,
    },
    finalModel: fitLogitOdds(protocols, lambdaPicked, asOf),
  };
}
