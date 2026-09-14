# Long Pasture point counts

Weekly bird point counts at eight fixed stations in Long Pasture Wildlife
Sanctuary, Cummaquid, Massachusetts. Fall 2026.

Six stations are fixed-radius counts (everything within 100 m). Two are
vantage-point scans over Barnstable Harbor, where most birds are well past
100 m and a fixed radius would exclude the reason for standing there. The map
lets you switch between the two, because comparing raw totals across those
methods is the easiest way to draw a wrong conclusion from this data.

## Running it locally

A browser will not read the CSVs from a `file://` path, so double-clicking
`index.html` gives you a blank map. Serve the folder instead:

```bash
cd long-pasture-site
python3 -m http.server 8000
```

Then open <http://localhost:8000>. In VS Code, the Live Server extension does
the same thing with a click.

## Publishing to GitHub Pages

1. Create a public repo. Name it `yourusername.github.io` for a site at that
   address, or anything else for `yourusername.github.io/reponame`.
2. Push the contents of this folder to the repo root.
3. Settings → Pages → Source: "Deploy from a branch", branch `main`, folder
   `/ (root)`. Save.
4. Wait a minute or two, then load the URL Pages gives you.

Paths on GitHub Pages are case-sensitive even though they aren't on Windows or
macOS. `Data/Stations.csv` will 404 where `data/stations.csv` works.

## Weekly workflow

1. Add the new rows to `data/detections.csv` — same columns, new `week` number
   and `date`.
2. Run the checks:
   ```bash
   python3 scripts/qc_check.py
   ```
   It prints a per-station summary and flags anything that would misrepresent
   the data: unknown stations, bad distance bands, coordinates outside the
   sanctuary, a species code used for two names, or effort fields that
   disagree within a single visit.
3. Commit and push. The week dropdown picks up the new week automatically, and
   an "All weeks combined" option appears once there is more than one.

Nothing is pre-computed. The map sums the CSVs in the browser every time it
loads, so it cannot fall out of step with the data.

## Files

```
index.html            the page
css/style.css         all styling
js/map.js             loading, aggregation, drawing
data/stations.csv     8 stations: id, name, lat, lon, point_type, habitat_type
data/detections.csv   one row per species per distance band per visit
scripts/qc_check.py   pre-publish validation
```

## Things you may want to change

All in the `SETTINGS` object at the top of `js/map.js`: the survey radius, the
smallest and largest circle sizes, and the two colours.

Circle **area** is proportional to the count, so the radius goes as the square
root. Don't switch it to a linear radius — it exaggerates large counts badly,
which matters here because S02 can be seven times any other station.

### Sightline wedges

`stations.csv` has three empty columns: `view_bearing_min`, `view_bearing_max`,
`view_dist_m`. Fill them in for S01 and S02 and the map draws a wedge showing
where you were actually looking, instead of implying a circle. Bearings are
compass degrees clockwise from north, and the wedge runs clockwise from min to
max, so `320` to `40` correctly crosses north. Leave them blank and nothing is
drawn.

## Known gaps

- Counts are 10 minutes by protocol, but no end time is recorded, so duration
  is assumed rather than measured.
- `weather` is a single word. Wind is the largest detectability covariate after
  time of day, and tide governs what is present at S01 and S02.
- Distances were estimated by eye in week 1, calibrated against orthoimagery
  afterwards. Consistent bias across weeks, so trends hold; absolute densities
  should not be compared to other surveys.
- Eight stations across seven habitat classes means habitat is effectively a
  station label, not a factor with replication.
