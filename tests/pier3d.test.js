// 3D validation (25 stations, 24 direction sets) against the STAR*NET listing. The checks live in
// tests/validation/pier3d.js and run when a listing for the job is available (see tests/jobs.js).
import test from 'node:test';
import { listingJob, SKIP_NO_LISTING } from './jobs.js';

if (listingJob('pier')) await import('./validation/pier3d.js');
else test('3D network A validation against STAR*NET', { skip: SKIP_NO_LISTING }, () => {});
