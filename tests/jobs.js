// Where the real-job data sets live.
//
// "public"  tests/fixtures/*.dat, *.snproj  - the jobs with renamed stations and no comments. Safe to publish.
//           STAR*NET listings (.lst, .pts) for them are added when the renamed jobs have been run in STAR*NET.
// "local"   tests/fixtures/local/*          - the original runs, kept off the repository (git-ignored).
//
// The tests that compare against a STAR*NET listing use whichever set has the listing: the public one when it has
// been added, otherwise the local originals, otherwise they are skipped. The two sets hold the same observations;
// only the station names differ, so tests must not hard-code a station name (take it from the result instead).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, 'fixtures');

const JOBS = {
  level: { public: 'Level1D_A', local: 'level' },
  pier: { public: 'Network3D_A', local: 'netA' },
  control: { public: 'Network3D_B', local: 'netB' },
};

const has = (dir, base, ext) => fs.existsSync(path.join(dir, `${base}.${ext}`));

/** The data set to validate against a STAR*NET listing: { base, file(ext), read(ext) } or null. Public listings win. */
export function listingJob(key) {
  const j = JOBS[key];
  for (const s of [{ dir: fixtures, base: j.public }, { dir: path.join(fixtures, 'local'), base: j.local }]) {
    if (has(s.dir, s.base, 'lst') && has(s.dir, s.base, 'dat') && has(s.dir, s.base, 'snproj')) {
      const file = (ext) => path.join(s.dir, `${s.base}.${ext}`);
      return { base: s.base, isPublic: s.dir === fixtures, file, read: (ext) => fs.readFileSync(file(ext), 'utf8') };
    }
  }
  return null;
}

/** The public data file and project settings, which always exist. */
export function publicJob(key) {
  const j = JOBS[key];
  const file = (ext) => path.join(fixtures, `${j.public}.${ext}`);
  return { base: j.public, file, read: (ext) => fs.readFileSync(file(ext), 'utf8') };
}

export const SKIP_NO_LISTING = 'needs the STAR*NET listing for this job, which is not in this checkout (see tests/fixtures/README.md)';
