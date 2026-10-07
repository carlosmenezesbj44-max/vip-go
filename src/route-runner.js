const MARKER_HTML = '<span class="route-progress-dot" aria-hidden="true"></span>';

export function createProgressIcon(L) {
  return L.divIcon({ className: 'route-progress-marker', html: MARKER_HTML, iconSize: [20, 20], iconAnchor: [10, 10] });
}

export function createProgressMarker(L, map, point) {
  const latlng = Array.isArray(point) ? point : [point.lat, point.lng];
  return L.marker(latlng, { icon: createProgressIcon(L), interactive: false, zIndexOffset: 1000 }).addTo(map);
}

export function animateRouteMarker(L, map, route, duration = 4200) {
  const coordinates = route.map((point) => Array.isArray(point) ? point : [Number(point.lat), Number(point.lng)]);
  if (coordinates.length < 2) return { marker: null, stop() {} };
  const lengths = [];
  let total = 0;
  for (let index = 1; index < coordinates.length; index += 1) {
    const [latA, lngA] = coordinates[index - 1];
    const [latB, lngB] = coordinates[index];
    const dLat = (latB - latA) * Math.PI / 180;
    const dLng = (lngB - lngA) * Math.PI / 180;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(latA * Math.PI / 180) * Math.cos(latB * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
    const length = 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
    lengths.push(length);
    total += length;
  }
  if (!total) return { marker: null, stop() {} };
  const marker = createProgressMarker(L, map, coordinates[0]);
  let frame = 0;
  let previous = 0;
  let distance = 0;
  let stopped = false;
  const animate = (now) => {
    if (stopped) return;
    if (previous) distance = (distance + total * (now - previous) / duration) % total;
    previous = now;
    let remaining = distance;
    let segment = 0;
    while (segment < lengths.length - 1 && remaining > lengths[segment]) { remaining -= lengths[segment]; segment += 1; }
    const fraction = Math.min(1, remaining / (lengths[segment] || 1));
    const a = coordinates[segment];
    const b = coordinates[segment + 1];
    marker.setLatLng([a[0] + (b[0] - a[0]) * fraction, a[1] + (b[1] - a[1]) * fraction]);
    frame = requestAnimationFrame(animate);
  };
  frame = requestAnimationFrame(animate);
  return { marker, stop() { stopped = true; cancelAnimationFrame(frame); marker.remove(); } };
}
