# Survey-Adjust

A STAR*NET-style **least squares adjustment** tool that runs in the browser, works **offline**, and is usable on a phone: load a job from a USB stick in the field, run the adjustment, read the report before leaving site.

**Live app:** https://stephenking989.github.io/Survey-Adjust/

No build step, no frameworks, no runtime dependencies. Plain JavaScript ES modules served straight from GitHub Pages.

## Status

| Version | Scope |
|---|---|
| **0.1 (now)** | Engine core + **1D differential levelling**, STAR*NET-style report, PE/PNEZD CSV export, mobile UI, offline PWA |
| Next | 2D/3D total-station networks (DB, DM, DE, DV, M, B records) |
| Later | Importers: Trimble JobXML, Carlson RW5, Leica GSI |
| Later | Grid / NAD83(CSRS) support |

## Using it

1. Open the app and tap **Open .dat file** (works with a USB stick on Android/iOS), or paste the data, or try the built-in sample.
2. Check the project settings. STAR*NET keeps these in the `.snproj`, not the `.dat`, so enter the **differential level std error (per km)** or load it from the `.snproj`.
3. Tap **Adjust**.
4. Read the report. A failed chi-square test is shown in red, and observations with |StdRes| over the limit (default 3) are highlighted.
5. Download the report (`.lst`) and the coordinates as CSV (`Point,Elevation` or `PNEZD`).

Add it to your home screen (or install it from the browser menu) and it works with no signal. Nothing is ever uploaded.

## Data file support (`.dat`)

| Item | Status |
|---|---|
| `#` comments, blank lines, CRLF/LF, `'description` | supported |
| Options `.UNITS .ORDER .LEVEL .2D .3D .END` and any other `.OPTION` | parsed and stored; `.UNITS` and `.LEVEL` are used |
| `E name elev [! \| * \| stdErr]` | 1D control: fixed, free, weighted |
| `C name N E [Z] [! \| * \| stdErr ...]` | parsed and stored (used from 2D/3D onwards) |
| `L from-to dElev length [stdErr]` and `L from to dElev length [stdErr]` | differential levels |
| `DB DM DE DV M B ...` | kept as "unsupported" with a warning; added next session |

New record types are one function and one line in `RECORD_PARSERS` (`engine/parser.js`); the line splitter, option handling and error reporting do not change.

## How the 1D adjustment works

The maths is commented step by step in [`engine/level.js`](engine/level.js):

- Observation equation `h_to - h_from = dElev + v`, linearised as `A x - l = v`
- Weights from the level std error per km: `sigma^2 = c^2 * length_km`, `P = diag(1/sigma^2)`
- Normal equations `N x = u` with `N = A'PA`, solved by Cholesky; `Qxx = N^-1` is the cofactor matrix
- Residuals `v = A x - l`, standardised residuals `v / sigma`, sum of squares `v'Pv`
- Degrees of freedom, a-posteriori variance factor, total error factor `sqrt(v'Pv / dof)`
- Two-sided chi-square test (reported, like STAR*NET, as bounds on the error factor)
- Elevation std devs from `diag(Qxx)`, **scaled by the total error factor** (see below)

The linear algebra (`engine/matrix.js`) and the probability functions (`engine/stats.js`) are written from scratch. No GPL or third-party code.

### Does STAR*NET scale propagated errors by the error factor?

Yes, in the validated run. Station N02's unscaled std dev is 0.0000352 m; times the error factor 6.336 it is 0.000223 m, which is the value in the STAR*NET listing. The fixed station's listed 0.000001 m only appears if its fixed std error (1e-7) is also scaled, to 6.3e-7. One fixture cannot show whether STAR*NET also scales when the chi-square test *passes*; we scale always (the textbook a-posteriori covariance), and `Scale std devs by the total error factor` can be switched off.

## Validation against STAR*NET

`tests/fixtures/LEVEL_JOB.*` is a real STAR*NET-PRO 14 run (40 stations, 50 level runs, one fixed station). The test suite checks our result against its `.lst`, `.pts` and `.snproj`:

| Check | STAR*NET | Survey-Adjust |
|---|---|---|
| Stations / observations / unknowns / redundant | 40 / 50 / 39 / 11 | 40 / 50 / 39 / 11 |
| Sum of squares of StdRes | 441.532 | 441.532 |
| Total error factor | 6.336 | 6.336 |
| Chi-square (5%) | fails, bounds 0.589 / 1.412 | fails, bounds 0.589 / 1.412 |
| Max elevation difference vs `.pts` | | 0.0000049 m (the `.pts` has 5 decimals) |
| Max std dev difference vs `.lst` | | 0.0000005 m (the `.lst` has 6 decimals) |
| Observations flagged `*` | 16 | 16, same ones |

## Run it locally

Needs Node 20 or newer for the tests and the tiny dev server. Nothing to install.

```bash
node --test "tests/*.test.js"   # or: npm test
node tools/serve.js 8080         # then open http://localhost:8080/
```

## Layout

```
engine/   pure functions, no DOM: parser, matrix maths, adjustment, statistics, report
app/      the web page: index.html, style.css, app.js, manifest.json, icon.svg
tests/    node:test suites (no packages) and tests/fixtures (real STAR*NET jobs)
tools/    local dev server
sw.js     service worker (repo root so its scope covers app/ and engine/)
index.html  redirects to app/
```

## Deploying

GitHub Pages serves the `main` branch from the repo root. Work happens on a feature branch and merges to `main` only when all tests pass. **Bump `CACHE_NAME` in `sw.js` on every deploy** so installed copies discard stale files.

## Licence

No licence has been chosen yet, so all rights are reserved by default.
