# Test jobs

Five jobs used to test the adjustments. They are real surveys (coursework), published with every station
renamed, every comment and description removed, and nothing else changed: the angles, distances, standard
errors and control values are exactly as observed. The 2D link traverse also has its control coordinates
shifted by a constant so they no longer point to a place. A shift changes none of the results.

| Job | Kind | Files |
|---|---|---|
| `Level1D_A` | 1D levelling, 40 stations, 50 runs, one fixed benchmark | `.dat`, `.snproj` |
| `Network3D_A` | 3D total station, 25 stations, 24 direction sets, 3 weighted control points | `.dat`, `.snproj` |
| `Network3D_B` | 3D total station, one control point, a fixed azimuth, mixed `M`/`DN`/`DV`/`DM` | `.dat`, `.snproj` |
| `Traverse2D_A` | 2D link traverse between two control points | `.dat` |
| `Traverse2D_B` | 2D loop traverse that starts on a fixed bearing, with sideshots | `.dat` |

The `.snproj` files are STAR*NET project files (the instrument settings live there, not in the `.dat`).

## STAR*NET listings

The comparison tests (`tests/validation/`, and parts of `approx.test.js` and `ellipse.test.js`) read STAR*NET's
`.lst` and `.pts` for a job. For these renamed jobs, run each in STAR*NET and put the outputs here:

1. Put `Name.dat` and `Name.snproj` in one folder and open `Name.snproj` in STAR*NET.
2. Run the adjustment (Run > Adjust Network) with the options as saved in the project.
3. Copy `Name.lst` and `Name.pts` next to the `.dat`.

Until a job has its `.lst`, the tests for it are skipped on a clean checkout. On a machine that still has the
original runs in `tests/fixtures/local/` (git-ignored) the same tests run against those, which gives the same
numbers because only the station names differ. `tests/jobs.js` decides which set is used.

The 2D traverses have no `.snproj` yet: create a 2D project with the settings from the run sheet, and add its
`.snproj`, `.lst` and `.pts` here.

`tests/shell.test.js` fails if a student number, an instrument serial number, or a crew tag
appears in any file under this folder.
