// Probability functions needed for the adjustment statistics: the chi-square
// test of the a-posteriori variance factor and the normal-quantile used for
// confidence-level scaling. Pure maths, no dependencies.
//
// Everything is built on one primitive, the regularised lower incomplete gamma
// function P(a, x), because
//     chi-square CDF with k dof :  F(x; k) = P(k/2, x/2)
//     error function            :  erf(x)  = P(1/2, x^2)   (x >= 0)

/** ln Gamma(z) by the Lanczos approximation (g = 7, n = 9), z > 0. */
export function lnGamma(z) {
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (z < 0.5) {
    // Reflection formula for small arguments.
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - lnGamma(1 - z);
  }
  z -= 1;
  let x = c[0];
  const t = z + 7.5;
  for (let i = 1; i < 9; i++) x += c[i] / (z + i);
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

/** Regularised lower incomplete gamma P(a, x) = (1/Gamma(a)) * int_0^x t^(a-1) e^-t dt. */
export function gammaP(a, x) {
  if (x <= 0) return 0;
  const lead = Math.exp(-x + a * Math.log(x) - lnGamma(a));
  if (x < a + 1) {
    // Series: P = lead * sum_n x^n / (a (a+1) ... (a+n)) / ... converges fast for x < a+1.
    let term = 1 / a;
    let sum = term;
    for (let n = 1; n < 1000; n++) {
      term *= x / (a + n);
      sum += term;
      if (Math.abs(term) < Math.abs(sum) * 1e-16) break;
    }
    return lead * sum;
  }
  // Continued fraction for Q = 1 - P (modified Lentz), converges fast for x >= a+1.
  const tiny = 1e-300;
  let b = x + 1 - a;
  let c = 1 / tiny;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 1000; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < tiny) d = tiny;
    c = b + an / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 1e-16) break;
  }
  return 1 - lead * h;
}

/** Chi-square cumulative distribution function with k degrees of freedom. */
export function chiSquareCdf(x, k) {
  return gammaP(k / 2, x / 2);
}

/**
 * Chi-square quantile: the x with F(x; k) = p. Found by bracketing then
 * bisection (slow-but-certain; called a handful of times per run).
 */
export function chiSquareQuantile(p, k) {
  if (!(p > 0 && p < 1)) throw new RangeError('chiSquareQuantile: p must be in (0,1)');
  if (!(k > 0)) throw new RangeError('chiSquareQuantile: dof must be > 0');
  let lo = 0;
  let hi = Math.max(1, k);
  while (chiSquareCdf(hi, k) < p) hi *= 2;
  for (let i = 0; i < 200; i++) {
    const mid = 0.5 * (lo + hi);
    if (chiSquareCdf(mid, k) < p) lo = mid; else hi = mid;
  }
  return 0.5 * (lo + hi);
}

/** Standard normal CDF. */
export function normalCdf(z) {
  const erf = Math.sign(z) * gammaP(0.5, 0.5 * z * z);  // erf(z/sqrt2)
  return 0.5 * (1 + erf);
}

/** Standard normal quantile (inverse CDF) by bisection. */
export function normalQuantile(p) {
  if (!(p > 0 && p < 1)) throw new RangeError('normalQuantile: p must be in (0,1)');
  let lo = -40;
  let hi = 40;
  for (let i = 0; i < 200; i++) {
    const mid = 0.5 * (lo + hi);
    if (normalCdf(mid) < p) lo = mid; else hi = mid;
  }
  return 0.5 * (lo + hi);
}

/**
 * Two-sided chi-square test on the a-posteriori variance factor.
 *
 *   T = v^T P v  ~  chi-square(dof)    if the a-priori weights are right.
 *
 * Accept if chi2(alpha/2) <= T <= chi2(1 - alpha/2). STAR*NET prints the
 * bounds as *error-factor* bounds, i.e. sqrt(chi2_bound / dof), so that they
 * can be compared directly with the total error factor sqrt(T / dof).
 */
export function chiSquareTest(sumSqStdRes, dof, alpha) {
  const lowerChi2 = chiSquareQuantile(alpha / 2, dof);
  const upperChi2 = chiSquareQuantile(1 - alpha / 2, dof);
  const errorFactor = Math.sqrt(sumSqStdRes / dof);
  const lowerBound = Math.sqrt(lowerChi2 / dof);
  const upperBound = Math.sqrt(upperChi2 / dof);
  let verdict = 'passed';
  if (errorFactor > upperBound) verdict = 'above-upper';
  else if (errorFactor < lowerBound) verdict = 'below-lower';
  return { alpha, dof, lowerChi2, upperChi2, lowerBound, upperBound, errorFactor, passed: verdict === 'passed', verdict };
}
