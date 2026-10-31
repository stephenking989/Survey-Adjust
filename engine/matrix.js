// Small dense linear-algebra kernel for least-squares adjustment.
//
// Written from scratch (textbook Cholesky) - no third-party or GPL code.
// Everything here is a pure function / plain class: no DOM, no I/O.
//
// Why Cholesky? The normal-equation matrix N = A^T P A of a least-squares
// problem is symmetric positive definite (SPD) whenever the network has a
// valid datum (enough fixed/weighted control). An SPD matrix factors as
//
//     N = L L^T          (L lower triangular, positive diagonal)
//
// which costs about half of an LU factorisation, needs no pivoting, and fails
// loudly (a non-positive pivot) when the network is under-constrained - which
// is exactly the "datum defect" error a surveyor wants to hear about.

export class SingularMatrixError extends Error {
  constructor(message, pivotIndex) {
    super(message);
    this.name = 'SingularMatrixError';
    this.pivotIndex = pivotIndex;
  }
}

export class Matrix {
  /** Row-major dense matrix backed by a Float64Array. */
  constructor(rows, cols, data) {
    this.rows = rows;
    this.cols = cols;
    this.data = data || new Float64Array(rows * cols);
  }

  static zeros(rows, cols) {
    return new Matrix(rows, cols);
  }

  static identity(n) {
    const m = new Matrix(n, n);
    for (let i = 0; i < n; i++) m.data[i * n + i] = 1;
    return m;
  }

  /** Build from an array of row arrays. */
  static fromRows(rows) {
    const r = rows.length;
    const c = r ? rows[0].length : 0;
    const m = new Matrix(r, c);
    for (let i = 0; i < r; i++) {
      if (rows[i].length !== c) throw new Error('fromRows: ragged input');
      for (let j = 0; j < c; j++) m.data[i * c + j] = rows[i][j];
    }
    return m;
  }

  get(i, j) {
    return this.data[i * this.cols + j];
  }

  set(i, j, v) {
    this.data[i * this.cols + j] = v;
  }

  add(i, j, v) {
    this.data[i * this.cols + j] += v;
  }

  clone() {
    return new Matrix(this.rows, this.cols, Float64Array.from(this.data));
  }

  transpose() {
    const t = new Matrix(this.cols, this.rows);
    for (let i = 0; i < this.rows; i++) {
      for (let j = 0; j < this.cols; j++) t.data[j * this.rows + i] = this.data[i * this.cols + j];
    }
    return t;
  }

  /** this (m x k) times other (k x n). */
  mul(other) {
    if (this.cols !== other.rows) throw new Error(`mul: ${this.rows}x${this.cols} * ${other.rows}x${other.cols}`);
    const out = new Matrix(this.rows, other.cols);
    for (let i = 0; i < this.rows; i++) {
      for (let k = 0; k < this.cols; k++) {
        const a = this.data[i * this.cols + k];
        if (a === 0) continue;
        for (let j = 0; j < other.cols; j++) out.data[i * other.cols + j] += a * other.data[k * other.cols + j];
      }
    }
    return out;
  }

  /** this (m x n) times a plain vector of length n -> Float64Array(m). */
  mulVec(v) {
    if (this.cols !== v.length) throw new Error('mulVec: size mismatch');
    const out = new Float64Array(this.rows);
    for (let i = 0; i < this.rows; i++) {
      let s = 0;
      for (let j = 0; j < this.cols; j++) s += this.data[i * this.cols + j] * v[j];
      out[i] = s;
    }
    return out;
  }

  /** Largest |a_ij - b_ij| (handy in tests). */
  maxAbsDiff(other) {
    let d = 0;
    for (let i = 0; i < this.data.length; i++) d = Math.max(d, Math.abs(this.data[i] - other.data[i]));
    return d;
  }
}

/**
 * Cholesky factorisation of a symmetric positive definite matrix.
 * Returns the lower-triangular L with A = L L^T. Only the lower triangle of A
 * is read. Throws SingularMatrixError if a pivot is not safely positive.
 */
export function cholesky(A) {
  const n = A.rows;
  if (A.cols !== n) throw new Error('cholesky: matrix must be square');
  const L = new Matrix(n, n);
  for (let j = 0; j < n; j++) {
    // Diagonal: L_jj = sqrt( A_jj - sum_k<j L_jk^2 )
    let d = A.data[j * n + j];
    for (let k = 0; k < j; k++) d -= L.data[j * n + k] * L.data[j * n + k];
    // Relative test so that a tiny-but-legitimate pivot (large weights) passes
    // while a pivot cancelled to rounding noise (rank deficiency) does not.
    if (!(d > 1e-12 * Math.abs(A.data[j * n + j])) || !Number.isFinite(d)) {
      throw new SingularMatrixError(`Matrix is not positive definite (pivot ${j + 1})`, j);
    }
    const ljj = Math.sqrt(d);
    L.data[j * n + j] = ljj;
    // Below the diagonal: L_ij = ( A_ij - sum_k<j L_ik L_jk ) / L_jj
    for (let i = j + 1; i < n; i++) {
      let s = A.data[i * n + j];
      for (let k = 0; k < j; k++) s -= L.data[i * n + k] * L.data[j * n + k];
      L.data[i * n + j] = s / ljj;
    }
  }
  return L;
}

/** Solve L L^T x = b given the Cholesky factor L (forward then back substitution). */
export function choleskySolve(L, b) {
  const n = L.rows;
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {          // L y = b
    let s = b[i];
    for (let k = 0; k < i; k++) s -= L.data[i * n + k] * y[k];
    y[i] = s / L.data[i * n + i];
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {     // L^T x = y
    let s = y[i];
    for (let k = i + 1; k < n; k++) s -= L.data[k * n + i] * x[k];
    x[i] = s / L.data[i * n + i];
  }
  return x;
}

/**
 * Inverse of an SPD matrix via Cholesky: solve A X = I column by column.
 * In least squares the inverse of the normal matrix is the cofactor matrix
 * Q_xx whose diagonal gives the unknowns' variances.
 */
export function inverseSPD(A, L = cholesky(A)) {
  const n = A.rows;
  const inv = new Matrix(n, n);
  const e = new Float64Array(n);
  for (let j = 0; j < n; j++) {
    e.fill(0);
    e[j] = 1;
    const col = choleskySolve(L, e);
    for (let i = 0; i < n; i++) inv.data[i * n + j] = col[i];
  }
  // Remove asymmetry left by rounding.
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const m = 0.5 * (inv.data[i * n + j] + inv.data[j * n + i]);
      inv.data[i * n + j] = m;
      inv.data[j * n + i] = m;
    }
  }
  return inv;
}
