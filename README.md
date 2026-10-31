# Survey-Adjust

A STAR*NET-style **least squares adjustment** tool that runs in the browser, works **offline**, and is usable on a phone: load a job from a USB stick in the field, run the adjustment, read the report before leaving site.

**Live app:** https://stephenking989.github.io/Survey-Adjust/

No build step, no frameworks, no runtime dependencies. Plain JavaScript ES modules served straight from GitHub Pages.

## Status

| Version | Scope |
|---|---|
| 0.1 | Engine core + 1D differential levelling, report, CSV, mobile UI, offline PWA |
| 0.2 | 3D total-station networks: direction sets, slope distances, zenith angles, angles, azimuths, weighted/fixed control, starting coordinates computed from the observations |
| 0.3 | Projects like STAR*NET's: several data files with include checkboxes and a reading order, an in-page editor for each file, Check data, a results page, and plain-language help when the chi-square test fails |
| 0.4 | Error ellipses and a network plot (3D jobs): station and relative ellipses in the listing, matching STAR*NET's listings for both test jobs, and a pan-and-zoom plot with names, observation lines and ellipses |
| 0.5 | 2D networks: horizontal angles, directions, distances and azimuths with no heights or zeniths, and traverse data (`TB` / `T` / `TE`). Same listing, ellipses and plot as 3D, without the elevation parts. **Not yet checked against a real STAR*NET 2D listing** (see below) |
| **0.6 (now)** | **Leica GSI import** (GSI8 and GSI16): add a `.gsi` file and it is converted to a `.dat` you can edit. **Digital level files** (Leica DNA) are converted to levelling data and have been run on eight real files; **total-station files** are written from Leica's format guide and tested on generated files only |
| Next | Direction correlation from instrument centering, 3D-format data in a 2D job, traverses that start from a bearing |
| Later | Importers: Trimble JobXML, Carlson RW5 |
| Later | Grid / NAD83(CSRS) support |

## Using it

The app has three tabs, the same loop STAR*NET uses: edit the data, run, read the results.

It works for levelling, 2D and 3D jobs. The job type is worked out from the data: a zenith angle or an elevation on a `C` record makes it 3D.

1. **Data.** Add your `.dat` files (pick several at once, and a `.snproj` too if you have it: its options and file order are used), or start a new file, or try a sample. Each file has a checkbox (untick it to leave it out of the next run), up/down buttons (files are read in list order) and a remove button. Tap a name to **edit it in the page**: line numbers, bad lines marked in red as you type, undo/redo, find, and a row of keys for `- . ! * # '` that are awkward on a phone. Your text is saved on the device after every change.
2. **Check data** lists every syntax error and warning with its file and line (tap one to jump there). **Adjust** runs the adjustment.
3. **Options.** STAR*NET keeps these in the `.snproj`, not the `.dat`, so enter them or load the `.snproj`: levelling needs the differential level std error per km; 3D needs the instrument (distance constant and ppm, direction, zenith, angle and azimuth std errors, centering errors) and the refraction coefficient.
4. **Results.** *Summary* (chi-square verdict, numbers, error factor by type of observation, and advice), *Listing* (the full STAR*NET-style report with a jump-to-section list), *Plot* (3D jobs: stations, observation lines, error ellipses and relative ellipses; drag to pan, pinch or buttons to zoom, tap a station for its numbers, a slider sets the ellipse exaggeration), *Residuals* (worst first; tap a row to open that line in the editor), *Points* (adjusted coordinates), *Messages*. Download the listing (`.lst`) or the coordinates as CSV (`Point,Elevation`, `PNEZD`, or `Point,N,E`).

### If the chi-square test fails

That is a statement about your std errors, not about the software: the test passes only when the real scatter of your data matches the std errors you gave. Run on the default options, almost any real job fails. After you enter the instrument from the job's `.snproj`, the two 3D test jobs pass and the levelling job still fails (STAR*NET fails it too: its error factor is 6.3). The Summary page says which of two things it looks like, using only numbers from the run:

- **One blunder:** a single residual far larger than the rest. It names the observation and its file and line.
- **Std errors too small (or too large) overall:** many moderate residuals. It shows the error factor by type of observation (directions, distances, zeniths ...) and which Options field controls the worst one.

Std devs are scaled by the error factor when the test fails, as STAR*NET does (switch it off in Options).

Add the app to your home screen (or install it from the browser menu) and it works with no signal. Nothing is ever uploaded.

## Data file support (`.dat`)

| Item | Status |
|---|---|
| `#` comments, blank lines, CRLF/LF, `'description` | supported |
| Options `.UNITS .ORDER .3D .2D .LEVEL .REF .CURVE .EDM .ADDC .END` | parsed; all used. `.ORDER` takes both `NE`/`EN` and `ATFROMTO`/`FROMATTO` |
| Any other `.OPTION` (`.DELTA`, `.REL`, ...) | parsed and stored, not used yet |
| Several data files in one project | read in list order; inline options end with each file, as in STAR*NET (manual 5.8); direction sets are numbered across files |
| Inline options that change mid-file (`.REF`, `.CURVE`, `.EDM`, `.ADDC`) | each observation uses the setting in force on its own line |
| `E name elev [! \| * \| stdErr]` | 1D control: fixed, free, weighted |
| `C name N E [Z] [! \| * \| stdErr ...]` | control, fixed / free / weighted per component |
| `L from-to dElev length [stdErr]` | differential levels |
| `DB at` ... `DM to dir dist zen [HI/HT]` / `DN` / `DV` ... `DE` | direction sets (each set gets its own unknown orientation) |
| `D`, `V`, `A`, `B`, `M` | distance, zenith, angle, azimuth/bearing (incl. quadrant bearings), angle+distance+zenith |
| Stations without a `C` record | starting coordinates are worked out from the observations, like STAR*NET |
| `TB` backsight, `T` at angle distance, `TE` end [closing angle station] | traverses (2D format). Each `T` line becomes an `M` record (angle and distance from that station, previous point to next point), so a traverse adjusts exactly like the `M` lines it stands for. A backsight or closing angle given as a fixed bearing is refused for now |
| `DM to direction distance` (no zenith) | the 2D form of a direction set; the 3D form adds the zenith |
| A code written against a numeric station name (`C1 5000 5000`, `T2 90-00-00 100`) | read as `C 1 ...` and `T 2 ...`, as the manual's own examples are written |
| Leica `.gsi` (GSI8 / GSI16) | converted to a `.dat` on import, see below |
| Anything else (`G`, ...) | kept as "unsupported" with a warning |

### Leica GSI import

Add a `.gsi` file with **Add files** (or the GSI sample under Samples) and it becomes a `.dat` in the project, which you can then edit like any other. The reader follows Leica's *GSI Online* guide: each block is a two-character word index, information characters, a unit code in position 6, a sign, and 8 (GSI8) or 16 (GSI16) data characters with the decimal point implied. The unit codes (metres, feet, gon, degrees, DMS, mils and their decimals) are read exactly as the guide lists them. Word 11 is the point id, 21 the horizontal angle, 22 the vertical angle, 31/32/33 the slope distance, horizontal distance and height difference, 81-83 target coordinates, 84-86 station coordinates, 87 target height and 88 instrument height.

What a GSI file does not say, and what the converter assumes (it reports each of these when it applies):

- A line with station words (84-86 or 16) starts a setup; observation lines belong to the current station. With no station line the observations are assumed to come from the station named in the import options (default `STN`).
- Pointings from one station form a direction set until a target repeats, which starts the next set.
- A zenith over 180 degrees is a face 2 pointing and is reduced to face 1 (zenith to 360 minus zenith, Hz minus 180).
- Station and target coordinates become `C` records, fixed by default (or approximate only, in the options).
- A horizontal distance with a height difference, or with a zenith, is converted to a slope distance and zenith, with no curvature or refraction.
- Vertical angles are taken as zenith angles; if most are under 50 degrees the converter warns that the instrument may be reading elevation angles, and the import options can switch to that.

**Digital levels (Leica DNA).** A level file is recognised by its back sight (word 331) and fore sight (332) readings. Each set-up becomes `L back-fore (back reading - fore reading) (back distance + fore distance)`, and the start benchmark's height (word 83 on a line with no readings) becomes a fixed `E` record. The converter checks its sums against the instrument's own running heights and says so when they differ (one of the eight real files differs by 38 mm at one point, which is worth a look at the field book). The instrument names every run's start "A1" and numbers the turning points from 1, and calls a line a loop when it starts and ends on the same point, so: the last fore sight of a loop is renamed to the start benchmark when it closes within 10 mm of it; later runs in the same file get an `R2_` style prefix; and when a second file would reuse point names already in the project it gets a prefix such as `F2_`. Unfinished readings left at the start or end of a file are reported and left out. Eight real files from one project (one to three runs each, with code lines, closure summaries and leftover test readings) all convert and adjust. What the closure words 505-514 mean beyond the start and end ids (509, 512) is taken from their pattern in those files, not from a specification.

The total-station side of the converter is checked by writing a job out as GSI with an independent writer and reading it back: the 3D sample comes back within a millimetre, which is the resolution GSI stores. It has **not** been tried on files from a real total station, whose station and setup conventions vary; send a few to test.

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

The last row corrects version 0.1, which scaled always. The levelling run (error factor 6.336, test failed) is scaled; the first 3D job (error factor 0.968, test passed) is not, and both listings agree with the rule.

## Validation against STAR*NET

**About the test jobs.** The numbers below come from real STAR*NET-PRO 14 runs of three coursework jobs. The jobs themselves are published in `tests/fixtures/` with the stations renamed, the comments removed and the coordinates unchanged (the angles and distances are as observed), so nothing identifies the original survey. STAR*NET's own listings of the original runs are not in the repository. Once the renamed jobs have been re-run in STAR*NET, their listings are added here and the tests compare against those; until then the comparison tests run only on a machine that has the originals (they are skipped otherwise). See `tests/fixtures/README.md`.

**1D levelling** - `Level1D_A` (40 stations, 50 level runs, one fixed station); the test suite checks our result against STAR*NET's `.lst`, `.pts` and `.snproj`:

| Check | STAR*NET | Survey-Adjust |
|---|---|---|
| Stations / observations / unknowns / redundant | 40 / 50 / 39 / 11 | 40 / 50 / 39 / 11 |
| Sum of squares of StdRes | 441.532 | 441.532 |
| Total error factor | 6.336 | 6.336 |
| Chi-square (5%) | fails, bounds 0.589 / 1.412 | fails, bounds 0.589 / 1.412 |
| Max elevation difference vs `.pts` | | 0.0000049 m (the `.pts` has 5 decimals) |
| Max std dev difference vs `.lst` | | 0.0000005 m (the `.lst` has 6 decimals) |
| Observations flagged `*` | 16 | 16, same ones |

**3D networks** - `Network3D_A` and `Network3D_B`. The suite compares our result with STAR*NET's `.lst`, `.pts` and `.snproj`:

| | Network A (25 stations, 192 DM, 3 weighted control) | Network B (1 control point, fixed azimuth, `M`/`DN`/`DV`) |
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
| Station and relative error ellipses (25 + 18 rows / 9 + 15 rows) | axes and vertical within 0.000001 m, azimuth within 0.01 degree (68.27% confidence) | same, at 95% confidence; azimuths differ by at most a minute in the printed D-MM |

Ellipse axes use the 2-D chi-square factor for the chosen confidence (2.448 at 95%, 1.515 at 68.27%); heights use the 1-D normal factor (1.960, 1.000). Which ellipses are listed follows the `.ELLIPSE` and `.RELATIVE` inline options in the manual (default: all stations; relative ellipses between stations joined by an observation). Both test jobs use `.REL` pair lists, so the "joined by an observation" default, `/OBS` and `/CON` are implemented from the manual but not checked against a listing. Angles and `M` records join the instrument station to both of their targets, which is my reading and also unchecked.

**2D networks** - no real STAR*NET 2D listing was available, so the 2D adjustment is checked against things that can be proved instead: (1) a three-distance trilateration against an independent hand-written Gauss-Newton solution (agrees to 1e-9); (2) noise-free angles and distances recover the true coordinates; (3) a traverse gives the same result as the `M` lines it stands for; (4) the two-loop sample from the STAR*NET manual (appendix A, example 1) gives the same coordinates, sum of squares and ellipses as the 3D engine run with every height fixed at zero. The std error model for horizontal distances, angles and directions is the manual's (appendix C.4), and for these cases it is the same formula as the slope-distance one at a zenith of 90 degrees. The manual prints that example's input data but not its listing, so the sample's "suggested options" are mine, chosen so the test passes. If you can supply a real 2D job (`.dat`, `.lst`, `.snproj`), it can be added to the validation.

**Known differences** (not hidden by loosened tolerances):

- Network A's coordinates differ from STAR*NET's by up to 16 micrometres, about 0.02 arc-seconds at 100 m. Rounding of the `.pts` explains 5. I ruled out the iteration count, the weight geometry and the refraction coefficient; the remaining cause is unknown.
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
          approximate coordinates, reports, multi-file reading, data check, chi-square advice
app/      the web page: index.html, style.css, app.js (wiring), store.js (project and files),
          editor.js, results.js, manifest.json, icon.svg, samples/
tests/    node:test suites (no packages); tests/fixtures holds the real STAR*NET jobs
          (1D levelling, and 3d/ with the two 3D runs)
tools/    local dev server
sw.js     service worker (repo root so its scope covers app/ and engine/)
index.html  redirects to app/
```

## Deploying

GitHub Pages serves the `main` branch from the repo root. Work happens on a feature branch and merges to `main` only when all tests pass. **Bump `CACHE_NAME` in `sw.js` on every deploy** so installed copies discard stale files.

## Licence

No licence has been chosen yet, so all rights are reserved by default.
