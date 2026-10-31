# Survey-Adjust

A STAR*NET-style **least squares adjustment** tool that runs in the browser, works **offline**, and is usable on a phone: load a job from a USB stick in the field, run the adjustment, read the report before leaving site.

**Live app:** https://stephenking989.github.io/Survey-Adjust/

No build step, no frameworks, no runtime dependencies. Plain JavaScript ES modules served straight from GitHub Pages.

## Status

| Version | Scope |
|---|---|
| 0.1 | Engine core + 1D differential levelling, report, CSV, mobile UI, offline PWA |
| **0.2 (now)** | **3D total-station networks**: direction sets, slope distances, zenith angles, angles, azimuths, weighted/fixed control, starting coordinates computed from the observations |
| Next | 2D networks, error ellipses, direction correlation from instrument centering |
| Later | Importers: Trimble JobXML, Carlson RW5, Leica GSI |
| Later | Grid / NAD83(CSRS) support |

## Using it

1. Open the app and tap **Open .dat file** (works with a USB stick on Android/iOS), or paste the data, or try a built-in sample (levelling or 3D).
2. Check the project settings. STAR*NET keeps these in the `.snproj`, not the `.dat`, so enter them or tap **Load settings from .snproj**:
   - levelling: the differential level std error per km
   - 3D: the instrument (distance constant and ppm, direction, zenith, angle and azimuth std errors, centering errors) and the refraction coefficient
3. Tap **Adjust**.
4. Read the report. A failed chi-square test is shown in red, and observations with |StdRes| over the limit (default 3) are highlighted.
5. Download the report (`.lst`) and the coordinates as CSV (`Point,Elevation`, `PNEZD`, or `Point,N,E`).

Add it to your home screen (or install it from the browser menu) and it works with no signal. Nothing is ever uploaded.

## Data file support (`.dat`)

| Item | Status |
|---|---|
| `#` comments, blank lines, CRLF/LF, `'description` | supported |
| Options `.UNITS .ORDER .3D .2D .LEVEL .REF .CURVE .EDM .ADDC .END` | parsed; all used. `.ORDER` takes both `NE`/`EN` and `ATFROMTO`/`FROMATTO` |
| Any other `.OPTION` (`.DELTA`, `.REL`, ...) | parsed and stored, not used yet |
| Inline options that change mid-file (`.REF`, `.CURVE`, `.EDM`, `.ADDC`) | each observation uses the setting in force on its own line |
| `E name elev [! \| * \| stdErr]` | 1D control: fixed, free, weighted |
| `C name N E [Z] [! \| * \| stdErr ...]` | control, fixed / free / weighted per component |
| `L from-to dElev length [stdErr]` | differential levels |
| `DB at` ... `DM to dir dist zen [HI/HT]` / `DN` / `DV` ... `DE` | direction sets (each set gets its own unknown orientation) |
| `D`, `V`, `A`, `B`, `M` | distance, zenith, angle, azimuth/bearing (incl. quadrant bearings), angle+distance+zenith |
| Stations without a `C` record | starting coordinates are worked out from the observations, like STAR*NET |
| Anything else (`TB`, `G`, ...) | kept as "unsupported" with a warning |

New record types are one function and one line in `RECORD_PARSERS` (`engine/parser.js`).

## How the adjustments work

The maths is commented step by step in [`engine/level.js`](engine/level.js) (1D) and [`engine/network3d.js`](engine/network3d.js) (3D):

- Observation equations, linearised as `A x - l = v`; the 3D case iterates (Gauss-Newton)
- Weights `P = diag(1/sigma^2)` from the instrument settings, including centering errors
- Normal equations `N x = u`, `N = A'PA`, solved by Cholesky; `Qxx = N^-1` is the cofactor matrix
- Residuals, standardised residuals `v / sigma`, sum of squares `v'Pv`, redundancy, total error factor
- Two-sided chi-square test, reported (like STAR*NET) as bounds on the error factor
- Std devs from `diag(Qxx)`

The linear algebra (`engine/matrix.js`) and the probability functions (`engine/stats.js`) are written from scratch. No GPL or third-party code. The dense solver is comfortable up to a few hundred unknowns on a phone; very large networks would need a sparse solver.

### What was checked against the STAR*NET manual (not assumed)

| Behaviour | Source | Where |
|---|---|---|
| Distance std error = constant **+** ppm (additive), not root-sum-of-squares; `.EDM PROPAGATED` switches | Reference manual, Options and `.EDM` | `errorModel` |
| Direction, angle, azimuth, slope-distance and zenith centering formulas | Appendix C.4 | `errorModel` |
| Refraction correction = coefficient x central angle (Bomford), so the zenith correction is `(1/2 - k) Dh / R`; slope distances are not corrected | Appendix C.2 | `adjustNetwork3D` |
| Explicit std errors are used as given unless `.ADDCENTERING` is on | Appendix C.4, note 3 | `updateSigmas` |
| Propagated std devs are scaled by the total error factor **only when the chi-square test fails** | "Station Error Ellipses" | `propagationScale` |

The last row corrects version 0.1, which scaled always. The levelling run (error factor 6.336, test failed) is scaled; the 3D pier job (error factor 0.968, test passed) is not, and both listings agree with the rule.

## Validation against STAR*NET

**1D levelling** - `tests/fixtures/LEVEL_JOB.*` is a real STAR*NET-PRO 14 run (40 stations, 50 level runs, one fixed station); the test suite checks our result against its `.lst`, `.pts` and `.snproj`:

| Check | STAR*NET | Survey-Adjust |
|---|---|---|
| Stations / observations / unknowns / redundant | 40 / 50 / 39 / 11 | 40 / 50 / 39 / 11 |
| Sum of squares of StdRes | 441.532 | 441.532 |
| Total error factor | 6.336 | 6.336 |
| Chi-square (5%) | fails, bounds 0.589 / 1.412 | fails, bounds 0.589 / 1.412 |
| Max elevation difference vs `.pts` | | 0.0000049 m (the `.pts` has 5 decimals) |
| Max std dev difference vs `.lst` | | 0.0000005 m (the `.lst` has 6 decimals) |
| Observations flagged `*` | 16 | 16, same ones |

**3D networks** - two real STAR*NET runs. Their files contain personal identifiers (a student number, an instrument serial), so they are kept in the git-ignored `tests/fixtures/local/` and those tests skip when the files are absent. Results:

| | Pier monitoring (25 stations, 192 DM, 3 weighted control) | Control network (1 control point, fixed azimuth, `M`/`DN`/`DV`) |
|---|---|---|
| Stations / obs / unknowns / redundant | 25 / 585 / 99 / 486 (exact) | 9 / 246 / 50 / 196 (exact) |
| Error factor, chi-square | 0.968, passed, bounds 0.937/1.063 (exact) | 0.947, passed, bounds 0.901/1.099 (exact) |
| Sum sq. StdRes, distances | 164.004 (exact) | 34.577 vs 34.517 |
| Sum sq. StdRes, directions | 195.220 vs 195.223 | 39.669 vs 39.668 |
| Sum sq. StdRes, zeniths | 86.008 vs 86.009 | 101.367 vs 101.358 |
| Sum sq. StdRes, coordinates / angles / azimuths | 10.403 vs 10.431 | 0.096 / 0.000 (exact) |
| Every observation std error | identical to the listing | |
| Max coordinate difference vs `.pts` | 0.000016 m | 0.000027 m |
| Std devs (error propagation) | within 0.0000005 m, unscaled | |

**Known differences** (not hidden by loosened tolerances):

- The pier job's coordinates differ from STAR*NET's by up to 16 micrometres, about 0.02 arc-seconds at 100 m. Rounding of the `.pts` explains 5. I ruled out the iteration count, the weight geometry and the refraction coefficient; the remaining cause is unknown.
- The control-network job sets instrument centering to 1 mm. STAR*NET treats the directions of one set as statistically correlated in that case; we do not yet, which is probably why its distance sum of squares is 0.06 off. The engine adds a warning when this applies.

## Run it locally

Needs Node 20 or newer for the tests and the tiny dev server. Nothing to install.

```bash
node --test "tests/*.test.js"   # or: npm test
node tools/serve.js 8080         # then open http://localhost:8080/
```

## Layout

```
engine/   pure functions, no DOM: parser, matrix maths, statistics, levelling, 3D network,
          approximate coordinates, reports
app/      the web page: index.html, style.css, app.js, manifest.json, icon.svg, samples/
tests/    node:test suites (no packages); tests/fixtures holds the levelling job,
          tests/fixtures/local (git-ignored) the 3D jobs
tools/    local dev server
sw.js     service worker (repo root so its scope covers app/ and engine/)
index.html  redirects to app/
```

## Deploying

GitHub Pages serves the `main` branch from the repo root. Work happens on a feature branch and merges to `main` only when all tests pass. **Bump `CACHE_NAME` in `sw.js` on every deploy** so installed copies discard stale files.

## Licence

No licence has been chosen yet, so all rights are reserved by default.
