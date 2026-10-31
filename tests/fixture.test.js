// Levelling validation against the STAR*NET listing. The checks live in tests/validation/level.js and run when
// a listing for the job is available (see tests/jobs.js).
import test from 'node:test';
import { listingJob, SKIP_NO_LISTING } from './jobs.js';

if (listingJob('level')) await import('./validation/level.js');
else test('levelling validation against STAR*NET', { skip: SKIP_NO_LISTING }, () => {});
