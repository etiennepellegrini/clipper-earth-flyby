# Earth Flyby Visibility Explorer

A self-contained static/PWA web app for exploring whether an Earth flyby might be optically visible from the ground.

It computes in the browser:

- topocentric altitude/azimuth from an arbitrary observer location,
- whether the observer is in darkness/twilight,
- whether the target is illuminated or in Earth's shadow,
- a deliberately rough apparent-magnitude proxy,
- a sky-path polar plot,
- a synced near-Earth 3D geometry view with Earth day/night shading,
- a refined best-spot scan for the brightest plausible observing geometry.

The app performs **no network ephemeris calls at runtime**. Datasets are static JSON files under `data/`, listed in `data/datasets.json`.

## Running locally

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000`.

## Dataset selector

The app reads `data/datasets.json`:

```json
{
  "datasets": [
    {
      "id": "clipper-ega-2026",
      "label": "Europa Clipper · Earth gravity assist · Dec 2026",
      "path": "data/clipper_ega.json",
      "description": "Shown under the dropdown."
    }
  ]
}
```

Each dataset file should contain:

- `times`: UTC ISO strings,
- `object_eci_km` or `target_eci_km`: target vectors from Earth center,
- `sun_eci_km`: Sun vectors from Earth center at the same epochs,
- `metadata`: provenance and display information.

Older files with `clipper_eci_km` still work.

## Adding a target

Use `scripts/add_target.py` for the normal workflow. It is the user-facing wrapper:

1. searches a broad window around an approximate closest-approach epoch,
2. calls the low-level Horizons fetcher,
3. adds optional brightness/display defaults to the dataset metadata,
4. updates `data/datasets.json`.

The default search is a 31-day window centered on `--approx-ca`, with a 60-minute coarse search cadence. The final dataset defaults to ±24 hours around the found closest approach at 30-second cadence.

### Europa Clipper

```bash
python scripts/add_target.py \
  --target -159 \
  --name "Europa Clipper" \
  --approx-ca "2026-12-03 21:15" \
  --hours 12 \
  --step-sec 10 \
  --out data/clipper_ega.json \
  --id clipper-ega-2026 \
  --label "Europa Clipper · Earth gravity assist · Dec 2026" \
  --area-m2 140 \
  --albedo 0.22
```

### Apophis 2029

Quote the semicolon because it is Horizons small-body syntax and shells treat semicolons specially.

```bash
python scripts/add_target.py \
  --target "99942;" \
  --name "99942 Apophis" \
  --approx-ca "2029-04-13 21:45" \
  --diameter-m 340 \
  --albedo 0.35
```

For small bodies, the wrapper also tries to parse `RAD`, `DIAMETER`, and `ALBEDO` from Horizons `OBJ_DATA` and turn them into app defaults. User-supplied `--area-m2`, `--diameter-m`, and `--albedo` always win. Spacecraft reflective area and attitude generally are **not** Horizons ephemeris data, so provide them manually when you have a better estimate.

Useful optional overrides:

```bash
python scripts/add_target.py \
  --target "99942;" \
  --name "99942 Apophis" \
  --approx-ca "2029-04-13 21:45" \
  --search-days 7 \
  --search-step-min 15 \
  --hours 12 \
  --step-sec 10 \
  --mag-limit 6.5 \
  --min-alt-deg 10 \
  --dark-limit-deg -6
```

## Low-level Horizons fetcher

`scripts/fetch_horizons.py` is intentionally lower-level. It only creates the ephemeris JSON and raw Horizons text. It does **not** update the manifest and does **not** take brightness/UI parameters.

```bash
python scripts/fetch_horizons.py \
  --target -159 \
  --name "Europa Clipper" \
  --ca-utc "2026-12-03 21:15" \
  --hours 12 \
  --step-sec 10 \
  --out data/clipper_ega.json
```

For a generic target, provide either `--ca-utc` or an explicit bounded search window:

```bash
python scripts/fetch_horizons.py \
  --target "99942;" \
  --name "99942 Apophis" \
  --search-start "2029-03-29" \
  --search-stop "2029-04-29" \
  --hours 24 \
  --step-sec 30 \
  --out data/apophis_2029.json
```

## Deploying on GitHub Pages

Commit the static files, including the generated data JSON files:

```bash
git add .
git commit -m "Add Earth flyby visibility explorer"
git push
```

Then in GitHub:

`Repo → Settings → Pages → Source: Deploy from branch → Branch: main → Folder: / (root)`

The included `.nojekyll` avoids Jekyll processing. Because this is a PWA with a service worker, hard-refresh or unregister the old service worker if your browser keeps showing a stale version after deployment.

## Caveats

- The built-in `data/clipper_ega.json` may be a synthetic demo if you have not overwritten it with Horizons output.
- Magnitude is intentionally rough. Spacecraft attitude, solar-array glints, asteroid phase functions, atmospheric extinction, moonlight, clouds, terrain, and airspace are not modeled.
- The best-spot scan is geometric/photometric only; it is not an observing recommendation.


# Appendix: Targets

## Europa Clipper
```python
python scripts/add_target.py \
  --target -159 \
  --name "Europa Clipper" \
  --label "Europa Clipper · Dec 2026" \
  --approx-ca "2026-12-03 21:15" \
  --hours 12 \
  --step-sec 1 \
  --area-m2 140 \
  --albedo 0.22
```

## JUICE — September 2026 Earth flyby
A very large spacecraft with 85 m² of solar panels, making it an excellent shadow/parallax example. ESA’s cruise plan includes Earth assists in 2026 and 2029.

```python
python scripts/add_target.py \
  --target -28 \
  --name "JUICE" \
  --label "JUICE · Sep 2026" \
  --approx-ca "2026-09-15 00:00" \
  --hours 12 \
  --step-sec 1 \
  --area-m2 85 \
  --albedo 0.08
```

## JUICE — January 2029 Earth flyby
Its last Earth gravity assist before heading outward toward Jupiter. The contrast with its 2026 ground track should be particularly interesting.

```python
python scripts/add_target.py \
  --target -28 \
  --name "JUICE" \
  --label "JUICE · Jan 2029" \
  --approx-ca "2029-01-15 00:00" \
  --hours 12 \
  --step-sec 1 \
  --area-m2 85 \
  --albedo 0.08
```

## OSIRIS-APEX near the Apophis encounter, April 2029
This would be fun specifically because you could switch between Apophis and the spacecraft sent to study it. OSIRIS-APEX has 8.5 m² of solar panels, and Horizons carries it under `-64`.

```python
python scripts/add_target.py \
  --target -64 \
  --name "OSIRIS-APEX" \
  --label "OSIRIS-APEX · Apophis encounter · Apr 2029" \
  --approx-ca "2029-04-13 00:00" \
  --hours 12 \
  --step-sec 1 \
  --area-m2 8.5 \
  --albedo 0.22
```

## Lucy — December 2030 Earth gravity assist
Lucy has two 7.3 m-diameter circular arrays, totaling about 83.7 m² geometrically. Its mission timeline places its third Earth flyby in late December 2030.

```python
python scripts/add_target.py \
  --target -49 \
  --name "Lucy" \
  --label "Lucy · Dec 2030" \
  --approx-ca "2030-12-26 00:00" \
  --hours 12 \
  --step-sec 1 \
  --area-m2 83.7 \
  --albedo 0.22
```

## (153814) 2001 WN5
Probably the best additional natural object: about 932 m across, only 0.65 lunar distances away, predicted to peak near magnitude 6.9. Its measured geometric albedo is about 0.097.

```python
python scripts/add_target.py \
  --target "153814;" \
  --name "(153814) 2001 WN5" \
  --label "(153814) 2001 WN5 · Jun 2028" \
  --approx-ca "2028-06-26 05:23" \
  --hours 12 \
  --step-sec 1 \
  --diameter-m 932 \
  --albedo 0.097
```

## (137108) 1999 AN10
Roughly 800 m across, passing at about 1.01 lunar distances; predicted peak magnitude about 7.6.

```python
python scripts/add_target.py \
  --target "137108;" \
  --name "(137108) 1999 AN10" \
  --label "(137108) 1999 AN10 · Aug 2027" \
  --approx-ca "2027-08-07 00:00" \
  --hours 12 \
  --step-sec 1 \
  --diameter-m 800 \
  --albedo 0.15
```

## Hayabusa2 — December 2027 Earth swing-by

JAXA plans two extended-mission Earth swing-bys, in 2027 and 2028.

NOTE: no traj found on Horizons

```python
python scripts/add_target.py \
  --target -37 \
  --name "Hayabusa2" \
  --label "Hayabusa2 · Dec 2027" \
  --approx-ca "2027-12-15 00:00" \
  --hours 12 \
  --step-sec 1 \
  --area-m2 5.75 \
  --albedo 0.22
```

## Hayabusa2 — June 2028 Earth swing-by
Same spacecraft, but a different approach direction, lighting geometry, ground track, and best observing region.

NOTE: no traj found on Horizons

```python
python scripts/add_target.py \
  --target -37 \
  --name "Hayabusa2" \
  --label "Hayabusa2 · Jun 2028" \
  --approx-ca "2028-06-15 00:00" \
  --hours 12 \
  --step-sec 1 \
  --area-m2 5.75 \
  --albedo 0.22
```

