# Europa Clipper Earth Flyby Visibility

A self-contained static web app for exploring whether Europa Clipper might be optically visible during its December 2026 Earth gravity assist.

The app shows:

- a polar sky chart from any Earth location,
- a time slider and playback controls,
- ground darkness via local Sun altitude,
- spacecraft illumination / Earth-shadow state,
- a rough adjustable apparent-magnitude proxy,
- a synced compressed 3D Earth-centered geometry panel,
- a coarse global “best spot” scan,
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
python scripts/analyze_visibility.py --data data/clipper_ega.json --time-step-min 2 --lat-step 2 --lon-step 2
```

This prints a coarse list of promising location/time candidates. The browser app’s **Scan Earth** button does a similar scan interactively.

## Model assumptions

- Topocentric altitude/azimuth is computed in the browser from geocentric inertial vectors and WGS-84 Earth rotation.
- Ground darkness is judged by Sun altitude; default is civil twilight (`Sun altitude <= -6°`).
- Spacecraft illumination uses an angular Earth/Sun disk eclipse test from the spacecraft.
- Optical magnitude is only a rough diffuse reflecting-area model. Real visibility can be dominated by spacecraft attitude, glints, phase behavior, optics, local sky brightness, and weather.
- The 3D panel compresses distances nonlinearly so Earth and the full path can fit together.

## Suggested workflow

1. Run `scripts/fetch_horizons.py` to generate real data.
2. Start the app locally and click **Jump closest sample**.
3. Try Santa Monica and Strasbourg presets.
4. Click **Scan Earth** with a reasonable minimum altitude and limiting magnitude.
5. Adjust the brightness model to test optimistic/pessimistic assumptions.
6. Take screenshots from the browser once the view looks useful.
