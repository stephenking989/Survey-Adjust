import test from 'node:test';
import assert from 'node:assert/strict';
import { Matrix, cholesky, choleskySolve, inverseSPD, SingularMatrixError } from '../engine/matrix.js';
import { near } from './helpers.js';

test('Cholesky factor reproduces A = L L^T', () => {
  const A = Matrix.fromRows([[4, 12, -16], [12, 37, -43], [-16, -43, 98]]);
  const L = cholesky(A);
  // Classic textbook example: L = [[2,0,0],[6,1,0],[-8,5,3]]
  assert.deepEqual(Array.from(L.data), [2, 0, 0, 6, 1, 0, -8, 5, 3]);
  assert.ok(L.mul(L.transpose()).maxAbsDiff(A) < 1e-12);
});

test('choleskySolve solves A x = b', () => {
  const A = Matrix.fromRows([[4, 12, -16], [12, 37, -43], [-16, -43, 98]]);
  const x = choleskySolve(cholesky(A), [1, 2, 3]);
  const back = A.mulVec(x);
  [1, 2, 3].forEach((b, i) => near(assert, back[i], b, 1e-10));
});

test('inverseSPD gives the identity when multiplied back', () => {
  const A = Matrix.fromRows([[4, 1, 0], [1, 3, 1], [0, 1, 2]]);
  const I = A.mul(inverseSPD(A));
  assert.ok(I.maxAbsDiff(Matrix.identity(3)) < 1e-12);
});

test('a singular matrix is rejected', () => {
  // Rank 1: rows are multiples of each other (a network with no datum looks like this).
  const A = Matrix.fromRows([[1, -1], [-1, 1]]);
  assert.throws(() => cholesky(A), SingularMatrixError);
});

test('mul, transpose and mulVec agree with hand arithmetic', () => {
  const A = Matrix.fromRows([[1, 2, 3], [4, 5, 6]]);
  assert.deepEqual(Array.from(A.transpose().data), [1, 4, 2, 5, 3, 6]);
  assert.deepEqual(Array.from(A.mul(A.transpose()).data), [14, 32, 32, 77]);
  assert.deepEqual(Array.from(A.mulVec([1, 0, -1])), [-2, -2]);
});
