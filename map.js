/* Long Pasture point counts — map logic
 *
 * Reads two CSVs from /data, sums detections per station, and draws them.
 * Everything is computed in the browser, so the map can never disagree
 * with the data files. Edit a CSV, reload, done.
 *
 * Reading order if you're new to JS: start at init() near the bottom.
 */

'use strict';

/* ---------- settings you might actually want to change ---------- */

var SETTINGS = {
  stationsCsv:  'stations.csv',
  detectionsCsv:'detections.csv',
  surveyRadiusM: 100,          // the fixed-radius protocol distance
  minCirclePx: 7,              // smallest bubble
  maxCirclePx: 30,             // largest bubble
  colors: { radius: '#3B6B52', view: '#A81E67' }
};

/* Any band except '>100' is inside the survey radius. Keeping the test
   in one place means a future band ('100-200') only needs editing here. */
var BEYOND_BAND = '>100';

/* ---------- module state ---------- */

var map, baseLayers, stationLayer;
var stations = [];      // one object per station, from stations.csv
var detections = [];    // one object per detection row
var metric = 'within';  // 'within' or 'all'
var week = 'all';       // 'all' or a week number
var markersById = {};

/* ---------- loading ---------- */

function loadCsv(url) {
  return new Promise(function (resolve, reject) {
    Papa.parse(url, {
      download: true,
      header: true,
      dynamicTyping: true,   // turns "41.71" into a number, "5" into 5
      skipEmptyLines: true,
      complete: function (results) { resolve(results.data); },
      error: function (err) { reject(err); }
    });
  });
}

/* ---------- aggregation ---------- */

/* Rows for the currently selected week. */
function activeDetections() {
  if (week === 'all') return detections;
  return detections.filter(function (d) { return d.week === week; });
}

/* Build a summary object for one station.
   within  = birds inside the 100 m radius (comparable across all stations)
   beyond  = birds counted past 100 m (the harbor scans at the view stations)
   species = [{name, count}] sorted high to low, for the active metric */
function summarise(station, rows) {
  var mine = rows.filter(function (d) { return d.station_id === station.station_id; });
  var within = 0, beyond = 0;
  var speciesTotals = {};
  var speciesWithin = {};

  mine.forEach(function (d) {
    var n = d.count || 0;
    if (d.distance_band === BEYOND_BAND) {
      beyond += n;
    } else {
      within += n;
      speciesWithin[d.common_name] = (speciesWithin[d.common_name] || 0) + n;
    }
    speciesTotals[d.common_name] = (speciesTotals[d.common_name] || 0) + n;
  });

  var table = (metric === 'within') ? speciesWithin : speciesTotals;
  var species = Object.keys(table)
    .map(function (name) { return { name: name, count: table[name] }; })
    .sort(function (a, b) { return b.count - a.count; });

  return {
    station: station,
    within: within,
    beyond: beyond,
    total: within + beyond,
    value: (metric === 'within') ? within : within + beyond,
    richness: species.length,
    species: species
  };
}

function summariseAll() {
  var rows = activeDetections();
  return stations.map(function (s) { return summarise(s, rows); });
}

/* ---------- geometry ---------- */

/* Move distM metres from a point along a compass bearing.
   Standard great-circle destination formula; accurate enough at 400 m. */
function destination(lat, lon, bearingDeg, distM) {
  var R = 6371000;
  var d = distM / R;
  var b = bearingDeg * Math.PI / 180;
  var la = lat * Math.PI / 180;
  var lo = lon * Math.PI / 180;
  var la2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(b));
  var lo2 = lo + Math.atan2(
    Math.sin(b) * Math.sin(d) * Math.cos(la),
    Math.cos(d) - Math.sin(la) * Math.sin(la2)
  );
  return [la2 * 180 / Math.PI, lo2 * 180 / Math.PI];
}

/* A pie-slice polygon for a view station's sightline.
   Only drawn if you fill in view_bearing_min / view_bearing_max /
   view_dist_m in stations.csv. Bearings are compass degrees, clockwise
   from north; the wedge is drawn from min to max going clockwise. */
function sectorPoints(lat, lon, bMin, bMax, distM) {
  var span = bMax - bMin;
  if (span <= 0) span += 360;          // e.g. 320 -> 40 crosses north
  var steps = 36;
  var pts = [[lat, lon]];
  for (var i = 0; i <= steps; i++) {
    pts.push(destination(lat, lon, bMin + span * (i / steps), distM));
  }
  return pts;
}

/* Circle area, not radius, should be proportional to the count —
   otherwise big numbers look several times bigger than they are. */
function radiusPx(value, maxValue) {
  if (!value || !maxValue) return SETTINGS.minCirclePx;
  // radius = k * sqrt(value) keeps AREA proportional to the count, which is
  // what the eye reads. Adding a minimum size on top of this would break the
  // proportionality, so the floor only catches empty stations.
  return Math.max(
    SETTINGS.minCirclePx,
    SETTINGS.maxCirclePx * Math.sqrt(value / maxValue)
  );
}

/* ---------- drawing ---------- */

function popupHtml(s) {
  var st = s.station;
  var isView = st.point_type === 'view';
  var habitat = String(st.habitat_type || '').replace(/_/g, ' ');

  var html = '<div class="pop">';
  html += '<h3>' + st.station_name + '</h3>';
  html += '<p class="pop-meta">' + st.station_id + ' · ' + habitat +
          ' · ' + (isView ? 'view station' : '100 m radius') + '</p>';

  html += '<dl>';
  html += '<dt>Birds within 100 m</dt><dd>' + s.within + '</dd>';
  if (s.beyond > 0) {
    html += '<dt>Birds past 100 m</dt><dd>' + s.beyond + '</dd>';
  }
  html += '<dt>Species shown</dt><dd>' + s.richness + '</dd>';
  html += '</dl>';

  if (isView && s.beyond > 0) {
    html += '<p class="vista">Most of this station\'s birds are out on the flats, ' +
            'well past 100 m. Compare it to the inland stations on the ' +
            'within-100 m figure only.</p>';
  }

  if (s.species.length) {
    html += '<ul class="species">';
    s.species.slice(0, 6).forEach(function (sp) {
      html += '<li><span>' + sp.name + '</span><span class="n">' + sp.count + '</span></li>';
    });
    if (s.species.length > 6) {
      html += '<li><span>and ' + (s.species.length - 6) + ' more</span><span class="n"></span></li>';
    }
    html += '</ul>';
  } else {
    html += '<p class="vista">No detections recorded here in this week.</p>';
  }

  return html + '</div>';
}

function draw() {
  stationLayer.clearLayers();
  markersById = {};

  var summaries = summariseAll();
  var maxValue = summaries.reduce(function (m, s) { return Math.max(m, s.value); }, 0);

  summaries.forEach(function (s) {
    var st = s.station;
    var isView = st.point_type === 'view';
    var color = isView ? SETTINGS.colors.view : SETTINGS.colors.radius;
    var latlng = [st.lat, st.lon];

    /* The true 100 m survey radius, to scale on the ground.
       L.circle takes metres, so this stays correct at every zoom. */
    if (!isView) {
      L.circle(latlng, {
        radius: SETTINGS.surveyRadiusM,
        color: color,
        weight: 1,
        opacity: 0.7,
        dashArray: '4 4',
        fill: false,
        interactive: false
      }).addTo(stationLayer);
    }

    /* Optional sightline wedge for view stations. */
    if (isView && st.view_bearing_min !== null && st.view_bearing_min !== '' &&
        st.view_dist_m) {
      L.polygon(
        sectorPoints(st.lat, st.lon, Number(st.view_bearing_min),
                     Number(st.view_bearing_max), Number(st.view_dist_m)),
        { color: color, weight: 1, opacity: 0.6, fillColor: color,
          fillOpacity: 0.07, interactive: false }
      ).addTo(stationLayer);
    }

    var marker = L.circleMarker(latlng, {
      radius: radiusPx(s.value, maxValue),
      color: color,
      weight: 1.5,
      fillColor: color,
      fillOpacity: 0.45
    }).addTo(stationLayer);

    marker.bindPopup(popupHtml(s), { maxWidth: 300 });
    marker.bindTooltip(st.station_name + ' — ' + s.value, { direction: 'top' });
    markersById[st.station_id] = marker;
  });

  drawList(summaries);
}

function drawList(summaries) {
  var list = document.getElementById('station-list');
  list.innerHTML = '';

  summaries
    .slice()
    .sort(function (a, b) { return b.value - a.value; })
    .forEach(function (s) {
      var li = document.createElement('li');
      var btn = document.createElement('button');
      btn.type = 'button';

      var sid = document.createElement('span');
      sid.className = 'sid';
      sid.textContent = s.station.station_id;

      var name = document.createElement('span');
      name.className = 'sname' + (s.station.habitat_type === 'tidal' ? ' is-tidal' : '');
      name.textContent = s.station.station_name;

      var count = document.createElement('span');
      count.className = 'scount';
      count.textContent = s.value;

      btn.append(sid, name, count);
      btn.addEventListener('click', function () { focusStation(s.station.station_id); });
      li.appendChild(btn);
      list.appendChild(li);
    });
}

function focusStation(id) {
  var marker = markersById[id];
  if (!marker) return;
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var target = marker.getLatLng();
  if (reduced) { map.setView(target, 17); } else { map.flyTo(target, 17, { duration: 0.6 }); }
  marker.openPopup();
}

/* ---------- controls ---------- */

var METRIC_NOTES = {
  within: 'Only birds inside the 100 m survey radius. This is the number that compares fairly across all eight stations.',
  all: 'Every bird counted, including harbor scans past 100 m. The two view stations now dominate — that is a difference in method, not in bird life.'
};

function wireControls() {
  document.querySelectorAll('.segmented button').forEach(function (btn) {
    btn.addEventListener('click', function () {
      metric = btn.dataset.metric;
      document.querySelectorAll('.segmented button').forEach(function (b) {
        var on = b === btn;
        b.classList.toggle('is-active', on);
        b.setAttribute('aria-checked', String(on));
      });
      document.getElementById('metric-note').textContent = METRIC_NOTES[metric];
      draw();
    });
  });

  var select = document.getElementById('week-select');
  var weeks = [];
  detections.forEach(function (d) {
    if (d.week != null && weeks.indexOf(d.week) === -1) weeks.push(d.week);
  });
  weeks.sort(function (a, b) { return a - b; });

  weeks.forEach(function (w) {
    var opt = document.createElement('option');
    opt.value = String(w);
    var date = (detections.find(function (d) { return d.week === w; }) || {}).date;
    opt.textContent = 'Week ' + w + (date ? ' — ' + date : '');
    select.appendChild(opt);
  });

  if (weeks.length > 1) {
    var all = document.createElement('option');
    all.value = 'all';
    all.textContent = 'All weeks combined';
    select.appendChild(all);
  }

  week = weeks.length ? weeks[weeks.length - 1] : 'all';
  select.value = String(week);

  select.addEventListener('change', function () {
    week = (select.value === 'all') ? 'all' : Number(select.value);
    draw();
  });
}

/* ---------- start-up ---------- */

function setStatus(message, isError) {
  var el = document.getElementById('status');
  if (!message) { el.hidden = true; return; }
  el.hidden = false;
  el.textContent = message;
  el.classList.toggle('is-error', Boolean(isError));
}

function buildMap() {
  map = L.map('map', { zoomControl: true, scrollWheelZoom: true });

  var light = L.tileLayer(
    'https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png?key=cb1_3ktg_1_d2a2b588db47a54e94f103ff',
    { maxZoom: 20, attribution: '&copy; OpenStreetMap contributors, &copy; CARTO' }
  );

  var imagery = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    { maxZoom: 19, attribution: 'Imagery: Esri, Maxar, Earthstar Geographics' }
  );

  light.addTo(map);
  baseLayers = { 'Plain': light, 'Aerial': imagery };
  L.control.layers(baseLayers, null, { position: 'topright' }).addTo(map);
  L.control.scale({ imperial: false }).addTo(map);

  /* Every station circle, ring and wedge goes in here, so redrawing after a
     control change is just clearLayers() plus a fresh pass. */
  stationLayer = L.layerGroup().addTo(map);
}

function init() {
  buildMap();

  /* Track which half we're in, so a drawing bug isn't reported as a
     missing-file problem. */
  var stage = 'load';

  Promise.all([loadCsv(SETTINGS.stationsCsv), loadCsv(SETTINGS.detectionsCsv)])
    .then(function (results) {
      stage = 'draw';
      stations = results[0].filter(function (s) { return s.station_id && s.lat && s.lon; });
      detections = results[1].filter(function (d) { return d.station_id; });

      if (!stations.length) {
        stage = 'load';
        throw new Error('stations.csv loaded but contained no usable rows');
      }

      wireControls();
      draw();

      map.fitBounds(
        L.latLngBounds(stations.map(function (s) { return [s.lat, s.lon]; })),
        { padding: [60, 60] }
      );
      setStatus(null);
    })
    .catch(function (err) {
      console.error(err);
      if (stage === 'load') {
        setStatus('Could not load the CSVs. If you opened this file directly, ' +
                  'run a local server instead — see the README.', true);
      } else {
        setStatus('The data loaded, but the map failed to draw: ' + err.message, true);
      }
    });
}

document.addEventListener('DOMContentLoaded', init);
