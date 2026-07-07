# Europa Clipper Earth Flyby Visibility

A self-contained static web app for exploring whether Europa Clipper might be optically visible during its December 2026 Earth gravity assist.

The app shows:

- a polar sky chart from any Earth location,
- a time slider and playback controls,
- ground darkness via local Sun altitude,
- spacecraft illumination / Earth-shadow state,
- a rough adjustable apparent-magnitude proxy,
- a synced 3D Earth-centered geometry panel with Sun-on-edge direction, Earth day/night shading, and shadow geometry,
- a refined global “best spot” scan that returns the single brightest rough-magnitude candidate,
- PWA metadata + service worker for GitHub Pages / phone install.

## Important data note

The bundled `data/clipper_ega.json` is a **synthetic demo ephemeris** so the UI works offline in this build environment. Do **not** use the bundled demo data for real visibility conclusions.

Run the Horizons fetcher below to replace it with actual JPL Horizons vectors before publishing or interpreting the result.

## Fetch actual JPL Horizons ephemerides

From the repo root:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python scripts/fetch_horizons.py --hours 24 --step-sec 60 --out data/clipper_ega.json
```

For a denser close-approach app file:

```bash
python scripts/fetch_horizons.py --hours 12 --step-sec 10 --out data/clipper_ega.json
```

The script pre-saves:

- Europa Clipper vectors: `COMMAND='-159'`, `CENTER='500@399'`, `EPHEM_TYPE='VECTORS'`
- Sun vectors: `COMMAND='10'`, `CENTER='500@399'`, `EPHEM_TYPE='VECTORS'`

Implementation note: Horizons does **not** accept seconds as a fixed-time `STEP_SIZE` unit. For sub-minute cadences, the fetcher converts the requested window and `--step-sec` into Horizons' documented unitless interval count. For example, `--hours 12 --step-sec 10` covers 24 hours total, so it uses `STEP_SIZE='8640'`, producing 8641 samples including both endpoints.

The app itself performs no runtime Horizons calls.

## Run locally

```bash
python3 -m http.server 8000
```

Open `http://localhost:8000`.

## Deploy to GitHub Pages

Commit all files, including `data/clipper_ega.json` after you regenerate it from Horizons. Then enable GitHub Pages for the repository / branch. The included `.nojekyll` prevents GitHub Pages from hiding underscored files if you add any later.

## Optional CLI scan

After replacing the demo ephemeris with Horizons data:

```bash
python scripts/analyze_visibility.py --data data/clipper_ega.json
```

This prints the single best refined candidate found by a 5°/5-minute coarse global scan followed by local refinement to about 0.05° and the native ephemeris cadence. The browser app’s **Scan Earth** button does the same search interactively.

## Model assumptions

- Topocentric altitude/azimuth is computed in the browser from geocentric inertial vectors and WGS-84 Earth rotation.
- Ground darkness is judged by Sun altitude; default is civil twilight (`Sun altitude <= -6°`).
- Spacecraft illumination uses an angular Earth/Sun disk eclipse test from the spacecraft.
- Optical magnitude is only a rough diffuse reflecting-area model. Real visibility can be dominated by spacecraft attitude, glints, phase behavior, optics, local sky brightness, and weather.
- The 3D panel has two scales. Near-pass scale prioritizes the close Earth encounter and may let distant trajectory segments leave the frame; compressed mode fits the full ±window. Earth day/night shading is computed from the actual Earth-to-Sun vector in the current view, and the Sun is shown on the edge of the box as “far away that way.”

## Suggested workflow

1. Run `scripts/fetch_horizons.py` to generate real data.
2. Start the app locally and click **Jump closest sample**.
3. Try Santa Monica and Strasbourg presets.
4. Click **Scan Earth** with a reasonable minimum altitude and limiting magnitude; it will return one refined global best, not a neighbor list.
5. Adjust the brightness model to test optimistic/pessimistic assumptions.
6. Take screenshots from the browser once the view looks useful.
