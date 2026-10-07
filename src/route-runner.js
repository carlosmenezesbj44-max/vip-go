const RUNNER_SVG = '<svg class="runner-svg" viewBox="0 0 64 80" aria-hidden="true"><g class="runner-facing"><g class="runner-athlete"><g class="runner-leg-back" data-limb="back-leg" transform="translate(29 43)"><path d="M0 0L0 14" stroke="#243c4d" stroke-width="8"/><g data-joint="back-knee" transform="translate(0 14)"><path d="M0 0L0 14" stroke="#b97550" stroke-width="5"/><path d="M-2 14h8" stroke="#eee" stroke-width="5"/></g></g><g class="runner-arm-back" data-limb="back-arm" transform="translate(33 25)"><path d="M0 0L0 11" stroke="#b97550" stroke-width="5"/><g transform="translate(0 11) rotate(-85)"><path d="M0 0L0 10" stroke="#b97550" stroke-width="4"/></g></g><path d="M33 23Q39 25 35 33L32 43 23 41 28 27Z" fill="#06ad92"/><path d="M24 39l10 2-3 7-10-3Z" fill="#19334a"/><g class="runner-leg-front" data-limb="front-leg" transform="translate(28 43)"><path d="M0 0L0 14" stroke="#243c4d" stroke-width="8"/><g data-joint="front-knee" transform="translate(0 14)"><path d="M0 0L0 14" stroke="#e4a174" stroke-width="5"/><path d="M-2 14h9" stroke="#f9f9f4" stroke-width="5"/><path d="M-2 16h9" stroke="#ff7045" stroke-width="2"/></g></g><path d="M34 24l2-7" stroke="#e4a174" stroke-width="5"/><path d="M33 9q10-3 10 6l-1 5-8 1-3-6Z" fill="#e4a174"/><path d="M31 13q-2-8 7-7 7 0 6 7l-6-2-5 5Z" fill="#24313a"/><g class="runner-arm-front" data-limb="front-arm" transform="translate(33 26)"><path d="M0 0L0 11" stroke="#e4a174" stroke-width="5"/><g transform="translate(0 11) rotate(-85)"><path d="M0 0L0 10" stroke="#e4a174" stroke-width="4"/><circle cy="10" r="2.5" fill="#e4a174"/></g></g></g></g></svg>';

export function createRunnerIcon(L) {
  return L.divIcon({ className: 'activity-route-runner', html: RUNNER_SVG, iconSize: [36, 45], iconAnchor: [18, 40] });
}

function applyRunnerPose(svg, now, mirror = false) {
  if (!svg) return;
  const phase = now / 650 * Math.PI * 2;
  svg.classList.add('is-route-animated');
  svg.querySelector('.runner-facing').setAttribute('transform', mirror ? 'translate(64 0) scale(-1 1)' : '');
  svg.querySelector('.runner-athlete').setAttribute('transform', `translate(0 ${-1.5 * Math.cos(phase * 2)})`);
  for (const [side, offset] of [['front', 0], ['back', Math.PI]]) {
    const step = phase + offset;
    const thigh = -38 * Math.sin(step);
    const knee = 22 + 68 * Math.max(0, Math.cos(step));
    svg.querySelector(`[data-limb="${side}-leg"]`).setAttribute('transform', `translate(${side === 'front' ? 28 : 29} 43) rotate(${thigh})`);
    svg.querySelector(`[data-joint="${side}-knee"]`).setAttribute('transform', `translate(0 14) rotate(${knee})`);
    svg.querySelector(`[data-limb="${side}-arm"]`).setAttribute('transform', `translate(33 26) rotate(${32 * Math.sin(step) + 8})`);
  }
}

export function createRunnerMarker(L, map, point, animateInPlace = true) {
  const latlng = Array.isArray(point) ? point : [point.lat, point.lng];
  const marker = L.marker(latlng, { icon: createRunnerIcon(L), interactive: false, zIndexOffset: 1000 }).addTo(map);
  if (animateInPlace) {
    let frame;
    const tick = (now) => {
      if (!map.hasLayer(marker)) return;
      applyRunnerPose(marker.getElement()?.querySelector('.runner-svg'), now);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    marker.on('remove', () => cancelAnimationFrame(frame));
  }
  return marker;
}

export function animateRouteRunner(L, map, route, duration = 4200) {
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
  const marker = createRunnerMarker(L, map, coordinates[0], false);
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
    const mirror = Math.abs(b[1] - a[1]) > 0.000001 && b[1] < a[1];
    applyRunnerPose(marker.getElement()?.querySelector('.runner-svg'), now, mirror);
    frame = requestAnimationFrame(animate);
  };
  frame = requestAnimationFrame(animate);
  return { marker, stop() { stopped = true; cancelAnimationFrame(frame); marker.remove(); } };
}
