import * as L from '../assets/vendor/leaflet/leaflet-src.esm.js';

const $ = (id) => document.getElementById(id);
const radians = Math.PI / 180;
const distanceActivityTypes = new Set([
  'Caminhada', 'Corrida', 'Corrida de rua', 'Corrida em trilha', 'Trilha', 'Ciclismo', 'Mountain bike',
  'Patinação', 'Canoagem', 'Escalada', 'Surfe', 'Skate', 'Natação', 'Futebol', 'Futsal', 'Basquete', 'Vôlei',
  'Tênis', 'Beach tennis', 'Remo', 'Ciclismo indoor', 'Spinning', 'Elíptico', 'Escada',
]);
const gpsActivityTypes = new Set([
  'Caminhada', 'Corrida', 'Corrida de rua', 'Corrida em trilha', 'Trilha', 'Ciclismo', 'Mountain bike',
  'Patinação', 'Canoagem', 'Escalada', 'Surfe', 'Skate', 'Natação', 'Futebol', 'Futsal', 'Basquete', 'Vôlei',
  'Tênis', 'Beach tennis', 'Remo',
]);

function metersBetween(a, b) {
  const dLat = (b.lat - a.lat) * radians;
  const dLng = (b.lng - a.lng) * radians;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * radians) * Math.cos(b.lat * radians) * Math.sin(dLng / 2) ** 2;
  return 12742000 * Math.asin(Math.sqrt(Math.min(1, h)));
}

function pointsAtDistanceIntervals(route, interval = 100) {
  const markers = [];
  if (!Array.isArray(route) || route.length < 2) return markers;
  let distance = 0;
  let nextMarker = interval;
  for (let index = 1; index < route.length; index += 1) {
    const start = route[index - 1];
    const end = route[index];
    const segmentLength = metersBetween(start, end);
    if (!segmentLength) continue;
    while (nextMarker <= distance + segmentLength) {
      const fraction = (nextMarker - distance) / segmentLength;
      markers.push({
        distance: nextMarker,
        lat: start.lat + (end.lat - start.lat) * fraction,
        lng: start.lng + (end.lng - start.lng) * fraction,
      });
      nextMarker += interval;
    }
    distance += segmentLength;
  }
  return markers;
}

function smoothRouteForDisplay(route) {
  if (!Array.isArray(route) || route.length < 3) return route || [];
  const median = (values) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
  return route.map((point, index) => {
    if (index === 0 || index === route.length - 1) return point;
    const window = route.slice(index - 1, index + 2);
    return { ...point, lat: median(window.map((entry) => entry.lat)), lng: median(window.map((entry) => entry.lng)) };
  });
}

function elapsedText(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remaining = seconds % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remaining).padStart(2, '0')}` : `${String(minutes).padStart(2, '0')}:${String(remaining).padStart(2, '0')}`;
}

function gpsError(error) {
  if (error?.code === 1) return 'Permita o acesso à localização nas configurações do navegador.';
  if (error?.code === 2) return 'O GPS não conseguiu determinar sua localização. Tente em um local aberto.';
  if (error?.code === 3) return 'O GPS demorou para responder. Tente novamente.';
  return 'Não foi possível acessar sua localização.';
}

function baseActivityMode(activityType) {
  if (['Corrida', 'Corrida de rua', 'Corrida em trilha', 'Trilha'].includes(activityType)) return 'Corrida';
  if (['Ciclismo', 'Mountain bike', 'Ciclismo indoor', 'Spinning'].includes(activityType)) return 'Ciclismo';
  return 'Caminhada';
}

export function createMapsController({ api, readActivities, loadAccountData, showToast, getUser, showLogin, onActivityStateChange = () => {} }) {
  let map;
  let previewMap;
  let previewMarker;
  let previewPosition;
  let previewStart;
  let previewEnd;
  let previewRoute;
  let previewStartMarker;
  let previewEndMarker;
  let choosingPreviewPoint = null;
  let shownRoute;
  let routeDistanceDots;
  let liveRoute;
  let liveParticipantLayer;
  let liveParticipantMarkers = new Map();
  let liveParticipantTimer = null;
  let liveRequestQueue = Promise.resolve();
  let lastLiveUpdateAt = 0;
  let liveSharingRequested = false;
  let plannedRouteLayer;
  let plannedStartMarker;
  let plannedEndMarker;
  let locationMarker;
  let watchId = null;
  let timerId = null;
  let trackingActive = false;
  let trackingWithGps = true;
  let startedAt = 0;
  let stoppedAt = 0;
  let points = [];
  let meters = 0;
  let communityRoutes = [];
  let selected = null;
  let heartRateDevice = null;
  let heartRateCharacteristic = null;
  let heartRateCount = 0;
  let heartRateSum = 0;
  let maxHeartRate = 0;
  let mediaFiles = [];
  let mediaObjectUrls = [];

  function status(message) { $('mapStatus').textContent = message; }
  function liveShareStatus(message) { $('mapLiveShareStatus').textContent = message; }
  function queueLiveRequest(body) {
    liveRequestQueue = liveRequestQueue.catch(() => {}).then(() => api('/live-activities/location', { method: 'POST', body: JSON.stringify(body) }));
    return liveRequestQueue;
  }
  function updateLiveShareAvailability() {
    const control = $('mapShareLive');
    const user = getUser();
    const canShare = Boolean(user?.companyId && (!trackingActive || trackingWithGps) && gpsActivityTypes.has($('mapMode').value));
    control.disabled = !canShare;
    if (!user?.companyId) liveShareStatus('Entre em uma campanha para compartilhar sua posição ao vivo.');
    else if (trackingActive && !trackingWithGps) liveShareStatus('Atividades internas não usam localização GPS.');
    else if (!gpsActivityTypes.has($('mapMode').value)) liveShareStatus('Disponível para atividades ao ar livre com GPS.');
    else if (!control.checked) liveShareStatus('Sua posição fica privada até você ativar esta opção.');
  }
  function stopLiveSharing() {
    const control = $('mapShareLive');
    const shouldNotifyServer = liveSharingRequested;
    control.checked = false;
    liveSharingRequested = false;
    lastLiveUpdateAt = 0;
    if (shouldNotifyServer && getUser()) {
      queueLiveRequest({ isSharing: false }).catch(() => {});
      liveShareStatus('Compartilhamento ao vivo encerrado.');
    } else updateLiveShareAvailability();
  }
  function publishLiveLocation(point, force = false) {
    if (!$('mapShareLive').checked || !trackingActive || !trackingWithGps || !getUser()?.companyId) return;
    const now = Date.now();
    if (!force && now - lastLiveUpdateAt < 10000) return;
    lastLiveUpdateAt = now;
    liveSharingRequested = true;
    queueLiveRequest({ isSharing: true, activityType: $('mapMode').value, lat: point.lat, lng: point.lng })
      .then(() => liveShareStatus('Sua posição está sendo compartilhada com a campanha.'))
      .catch((error) => {
        liveSharingRequested = false;
        $('mapShareLive').checked = false;
        liveShareStatus(`Não foi possível compartilhar: ${error.message}`);
      });
  }
  function addTiles(target) {
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(target);
  }
  function ensureMap() {
    if (map) return;
    map = L.map('routeMap', { zoomControl: true }).setView([-8.052, -34.908], 12);
    addTiles(map);
    shownRoute = L.polyline([], { color: '#fa8b45', weight: 5, opacity: 0.9 }).addTo(map);
    routeDistanceDots = L.layerGroup().addTo(map);
    liveParticipantLayer = L.layerGroup().addTo(map);
    liveRoute = L.polyline([], { color: '#00dfc1', weight: 6, opacity: 0.95 }).addTo(map);
  }

  function openActivityPreview() {
    if (!previewMap) {
      previewMap = L.map('activityPreviewMap', { zoomControl: true }).setView([-8.052, -34.908], 12);
      addTiles(previewMap);
      previewMap.on('click', (event) => {
        if (!choosingPreviewPoint) return;
        const point = [event.latlng.lat, event.latlng.lng];
        if (choosingPreviewPoint === 'start') {
          previewStart = point;
          if (previewStartMarker) previewStartMarker.setLatLng(point);
          else previewStartMarker = L.marker(point).addTo(previewMap);
          previewStartMarker.bindTooltip('Saída');
        } else {
          previewEnd = point;
          if (previewEndMarker) previewEndMarker.setLatLng(point);
          else previewEndMarker = L.marker(point).addTo(previewMap);
          previewEndMarker.bindTooltip('Destino');
        }
        choosingPreviewPoint = null;
        updatePreviewRoute();
      });
    }
    $('activityPreviewStatus').textContent = previewPosition
      ? 'Sua última localização consultada está marcada. Atualize quando chegar ao ponto de partida.'
      : 'Toque em “Mostrar localização” para se encontrar no mapa.';
    setTimeout(() => previewMap.invalidateSize(), 0);
  }

  function updatePreviewRoute() {
    if (previewStart && previewEnd) {
      if (previewRoute) previewRoute.setLatLngs([previewStart, previewEnd]);
      else previewRoute = L.polyline([previewStart, previewEnd], { color: '#079a77', weight: 5, dashArray: '8 8' }).addTo(previewMap);
      previewMap.fitBounds([previewStart, previewEnd], { padding: [30, 30] });
      $('activityPreviewStatus').textContent = 'Saída e destino marcados. A linha é direta entre os pontos; o percurso real será gravado pelo GPS.';
    } else if (choosingPreviewPoint) {
      $('activityPreviewStatus').textContent = choosingPreviewPoint === 'start' ? 'Toque no mapa para marcar o ponto de saída.' : 'Toque no mapa para marcar o ponto de destino.';
    } else if (previewStart || previewEnd) {
      $('activityPreviewStatus').textContent = previewStart ? 'Saída marcada. Agora marque o destino.' : 'Destino marcado. Agora marque a saída.';
    }
  }

  function choosePreviewPoint(kind) {
    openActivityPreview();
    choosingPreviewPoint = kind;
    updatePreviewRoute();
  }

  function locateActivityPreview() {
    const output = $('activityPreviewStatus');
    if (!window.isSecureContext || !navigator.geolocation) {
      output.textContent = 'Localização disponível apenas em HTTPS ou localhost, com GPS habilitado.';
      return;
    }
    openActivityPreview();
    output.textContent = 'Buscando sua localização…';
    navigator.geolocation.getCurrentPosition((position) => {
      if (!$('activityDialog').open) return;
      const { latitude, longitude, accuracy } = position.coords;
      previewPosition = [latitude, longitude];
      if (previewMarker) previewMarker.setLatLng(previewPosition);
      else previewMarker = L.circleMarker(previewPosition, { radius: 8, color: '#fff', weight: 3, fillColor: '#00bca2', fillOpacity: 1 }).addTo(previewMap);
      previewMap.setView(previewPosition, 16);
      if (!previewStart) {
        previewStart = previewPosition;
        if (previewStartMarker) previewStartMarker.setLatLng(previewPosition);
        else previewStartMarker = L.marker(previewPosition).addTo(previewMap);
        previewStartMarker.bindTooltip('Saída');
      }
      updatePreviewRoute();
      output.textContent = `Localização aproximada encontrada · precisão de ${Math.round(accuracy)} m. A gravação ainda não começou.`;
    }, (error) => { if ($('activityDialog').open) output.textContent = gpsError(error); }, { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
  }

  function updateStats() {
    const end = stoppedAt || Date.now();
    $('mapElapsed').textContent = elapsedText(startedAt ? Math.max(0, Math.floor((end - startedAt) / 1000)) : 0);
    $('mapDistance').textContent = `${(meters / 1000).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} km`;
  }

  function resetHeartRateStats() {
    heartRateCount = 0;
    heartRateSum = 0;
    maxHeartRate = 0;
    $('mapHeartRate').textContent = '— bpm';
    if ($('activityHeartRateValue')) $('activityHeartRateValue').textContent = '— bpm';
  }

  function handleHeartRate(event) {
    const value = event.target.value;
    if (!value || value.byteLength < 2) return;
    const flags = value.getUint8(0);
    const bpm = flags & 0x01 ? value.getUint16(1, true) : value.getUint8(1);
    if (bpm < 30 || bpm > 240) return;
    heartRateCount += 1;
    heartRateSum += bpm;
    maxHeartRate = Math.max(maxHeartRate, bpm);
    $('mapHeartRate').textContent = `${bpm} bpm`;
    if ($('activityHeartRateValue')) $('activityHeartRateValue').textContent = `${bpm} bpm`;
  }

  function heartRateDisconnected() {
    heartRateCharacteristic?.removeEventListener('characteristicvaluechanged', handleHeartRate);
    heartRateCharacteristic = null;
    heartRateDevice = null;
    $('heartRateConnect').hidden = false;
    $('heartRateDisconnect').hidden = true;
    $('heartRateStatus').textContent = 'Sensor desconectado. A atividade segue sem batimentos.';
    if ($('activityHeartRateStatus')) $('activityHeartRateStatus').textContent = 'Sensor desconectado. A atividade segue sem batimentos.';
    if ($('activityHeartRateConnect')) $('activityHeartRateConnect').hidden = false;
    if ($('activityHeartRateDisconnect')) $('activityHeartRateDisconnect').hidden = true;
  }

  async function connectHeartRate() {
    if (!window.isSecureContext || !navigator.bluetooth) {
      const message = !window.isSecureContext
        ? 'Bluetooth exige HTTPS (ou localhost). Abra o VIP Go em uma conexão segura.'
        : 'Este navegador não oferece Bluetooth Web. Use Chrome ou Edge em um dispositivo compatível.';
      $('heartRateStatus').textContent = message;
      if ($('activityHeartRateStatus')) $('activityHeartRateStatus').textContent = message;
      return;
    }
    try {
      $('heartRateStatus').textContent = 'Escolha um sensor compatível na janela Bluetooth…';
      if ($('activityHeartRateStatus')) $('activityHeartRateStatus').textContent = 'Escolha seu sensor na janela Bluetooth…';
      const device = await navigator.bluetooth.requestDevice({ filters: [{ services: ['heart_rate'] }] });
      device.addEventListener('gattserverdisconnected', heartRateDisconnected);
      const server = await device.gatt.connect();
      const service = await server.getPrimaryService('heart_rate');
      const characteristic = await service.getCharacteristic('heart_rate_measurement');
      await characteristic.startNotifications();
      heartRateDevice = device;
      heartRateCharacteristic = characteristic;
      characteristic.addEventListener('characteristicvaluechanged', handleHeartRate);
      $('heartRateConnect').hidden = true;
      $('heartRateDisconnect').hidden = false;
      $('heartRateStatus').textContent = `Conectado: ${device.name || 'sensor cardíaco'}. A média e o máximo serão salvos nesta atividade.`;
      if ($('activityHeartRateStatus')) $('activityHeartRateStatus').textContent = `Conectado: ${device.name || 'sensor cardíaco'}. Os batimentos serão coletados durante a atividade.`;
      if ($('activityHeartRateConnect')) $('activityHeartRateConnect').hidden = true;
      if ($('activityHeartRateDisconnect')) $('activityHeartRateDisconnect').hidden = false;
    } catch (error) {
      $('heartRateStatus').textContent = error.name === 'NotFoundError' ? 'Nenhum sensor selecionado.' : `Não foi possível conectar: ${error.message}`;
      if ($('activityHeartRateStatus')) $('activityHeartRateStatus').textContent = error.name === 'NotFoundError' ? 'Nenhum sensor selecionado.' : `Não foi possível conectar: ${error.message}`;
    }
  }

  async function disconnectHeartRate() {
    const device = heartRateDevice;
    if (!device) return;
    try { await heartRateCharacteristic?.stopNotifications(); } catch {}
    heartRateCharacteristic?.removeEventListener('characteristicvaluechanged', handleHeartRate);
    heartRateCharacteristic = null;
    if (device.gatt?.connected) device.gatt.disconnect();
    heartRateDevice = null;
    $('heartRateConnect').hidden = false;
    $('heartRateDisconnect').hidden = true;
    $('heartRateStatus').textContent = 'Sensor desconectado.';
    if ($('activityHeartRateStatus')) $('activityHeartRateStatus').textContent = 'Sensor desconectado.';
    if ($('activityHeartRateConnect')) $('activityHeartRateConnect').hidden = false;
    if ($('activityHeartRateDisconnect')) $('activityHeartRateDisconnect').hidden = true;
  }

  function stopWatch() {
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
    clearInterval(timerId);
    timerId = null;
    trackingActive = false;
    $('mapStopButton').disabled = true;
  }

  function renderMediaQueue() {
    mediaObjectUrls.forEach((url) => URL.revokeObjectURL(url));
    mediaObjectUrls = [];
    const previews = $('mapMediaPreviews');
    previews.replaceChildren();
    $('mapMediaCount').textContent = mediaFiles.length ? `${mediaFiles.length} de 4 fotos/vídeos anexados` : 'Nenhuma mídia selecionada';
    mediaFiles.forEach((file, index) => {
      const url = URL.createObjectURL(file); mediaObjectUrls.push(url);
      const item = document.createElement('div'); item.className = 'map-media-item';
      const preview = file.type.startsWith('video/') ? document.createElement('video') : document.createElement('img');
      preview.src = url; preview.setAttribute('aria-label', file.name);
      if (preview instanceof HTMLVideoElement) { preview.muted = true; preview.playsInline = true; preview.preload = 'metadata'; }
      const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×'; remove.setAttribute('aria-label', `Remover ${file.name}`);
      remove.addEventListener('click', () => { mediaFiles.splice(index, 1); renderMediaQueue(); });
      item.append(preview, remove); previews.append(item);
    });
  }

  function queueMediaFiles(files) {
    const selectedFiles = [...files];
    if (mediaFiles.length + selectedFiles.length > 4) { showToast('Você pode anexar até 4 fotos ou vídeos.'); return false; }
    const supported = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/webm', 'video/quicktime']);
    if (selectedFiles.some((file) => !supported.has(file.type))) { showToast('Escolha fotos JPG, PNG, WebP ou GIF e vídeos MP4, WebM ou MOV.'); return false; }
    if (selectedFiles.some((file) => file.size > 12 * 1024 * 1024)) { showToast('Cada foto ou vídeo deve ter até 12 MB.'); return false; }
    mediaFiles.push(...selectedFiles); renderMediaQueue(); return true;
  }

  function clearDraft(clearMedia = true, resetLiveShare = true) {
    if (resetLiveShare) stopLiveSharing();
    stopWatch();
    points = [];
    meters = 0;
    startedAt = 0;
    stoppedAt = 0;
    $('mapAccuracy').textContent = '—';
    $('mapFinishPanel').hidden = true;
    $('mapStartButton').disabled = false;
    $('mapShareRoute').checked = false;
    $('routeMap').hidden = false;
    $('noGpsActivityNotice').hidden = true;
    $('mapLocateButton').hidden = false;
    $('mapAccuracy').closest('div').hidden = false;
    resetHeartRateStats();
    liveRoute?.setLatLngs([]);
    plannedRouteLayer?.remove();
    plannedStartMarker?.remove();
    plannedEndMarker?.remove();
    plannedRouteLayer = null;
    plannedStartMarker = null;
    plannedEndMarker = null;
    if (clearMedia) { mediaFiles = []; renderMediaQueue(); }
    updateStats();
    onActivityStateChange();
  }

  function renderLiveParticipants(participants) {
    const incoming = new Set(participants.map((participant) => String(participant.userId)));
    for (const [userId, marker] of liveParticipantMarkers) {
      if (incoming.has(userId)) continue;
      marker.remove();
      liveParticipantMarkers.delete(userId);
    }
    participants.forEach((participant) => {
      const userId = String(participant.userId);
      let marker = liveParticipantMarkers.get(userId);
      if (!marker) {
        marker = L.circleMarker([participant.lat, participant.lng], { radius: 9, color: '#fff', weight: 3, fillColor: '#ec5364', fillOpacity: 1 }).addTo(liveParticipantLayer);
        marker.bindTooltip(participant.name, { direction: 'top', opacity: 0.95 });
        liveParticipantMarkers.set(userId, marker);
      } else marker.setLatLng([participant.lat, participant.lng]);
    });

    const list = $('liveActivityList');
    list.replaceChildren();
    if (!getUser()?.companyId) {
      list.textContent = 'Entre em uma campanha para acompanhar participantes ao vivo.';
      return;
    }
    if (!participants.length) {
      list.textContent = 'Ninguém está compartilhando a localização agora.';
      return;
    }
    participants.forEach((participant) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'map-live-person';
      const name = document.createElement('strong');
      name.textContent = participant.name;
      const detail = document.createElement('small');
      const seconds = Math.max(0, Math.floor((Date.now() - participant.updatedAt) / 1000));
      detail.textContent = `${participant.activityType} · atualizado há ${seconds} s`;
      button.append(name, detail);
      button.addEventListener('click', () => {
        map.setView([participant.lat, participant.lng], 16);
        liveParticipantMarkers.get(String(participant.userId))?.openTooltip();
      });
      list.append(button);
    });
  }

  async function refreshLiveParticipants() {
    if (!$('mapView').hidden && getUser()?.companyId) {
      try {
        const { participants } = await api('/live-activities');
        renderLiveParticipants(participants);
      } catch { /* Live sharing is optional; keep the route recording usable. */ }
    }
  }

  function showRoute(route, type, id, isRoadMatched = false) {
    ensureMap();
    if (!map || !Array.isArray(route) || route.length < 2) return;
    selected = { type, id };
    const color = type === 'mine' ? '#00bca2' : '#fa8b45';
    const displayRoute = isRoadMatched ? route : smoothRouteForDisplay(route);
    shownRoute.setStyle({ color });
    shownRoute.setLatLngs(displayRoute.map((point) => [point.lat, point.lng]));
    routeDistanceDots.clearLayers();
    for (const marker of pointsAtDistanceIntervals(displayRoute, 100)) {
      L.circleMarker([marker.lat, marker.lng], {
        radius: 4,
        color: '#ffffff',
        weight: 2,
        fillColor: '#e53935',
        fillOpacity: 1,
      }).bindTooltip(`${marker.distance} m`, { direction: 'top', opacity: 0.95 }).addTo(routeDistanceDots);
    }
    map.fitBounds(shownRoute.getBounds(), { padding: [35, 35], maxZoom: 16 });
    document.querySelectorAll('.map-route-row').forEach((row) => row.classList.toggle('selected', row.dataset.routeId === String(id) && row.dataset.routeType === type));
  }

  function routeRow(activity, type) {
    const row = document.createElement('article');
    row.className = 'map-route-row';
    row.dataset.routeId = activity.id;
    row.dataset.routeType = type;
    const routeButton = document.createElement('button');
    routeButton.type = 'button';
    routeButton.className = 'map-route-open';
    const title = document.createElement('strong');
    title.textContent = type === 'mine' ? activity.mode : `${activity.name} · ${activity.mode}`;
    const detail = document.createElement('small');
    const date = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short' }).format(new Date(activity.startedAt));
    detail.textContent = `${date} · ${activity.distanceKm > 0 ? `${Number(activity.distanceKm).toLocaleString('pt-BR', { maximumFractionDigits: 2 })} km` : elapsedText(Math.floor(activity.durationSeconds))}`;
    routeButton.append(title, detail);
    routeButton.addEventListener('click', () => showRoute(activity.route, type, activity.id, activity.routeMatched));
    row.append(routeButton);
    if (type === 'mine') {
      const visibility = document.createElement('button');
      visibility.type = 'button';
      visibility.className = 'map-route-visibility';
      visibility.textContent = activity.shareRoute ? 'Compartilhado' : 'Privado';
      visibility.setAttribute('aria-label', activity.shareRoute ? 'Tornar este percurso privado' : 'Compartilhar este percurso com a campanha');
      visibility.addEventListener('click', async () => {
        visibility.disabled = true;
        try {
          await api(`/activities/${encodeURIComponent(activity.id)}/route-visibility`, { method: 'PUT', body: JSON.stringify({ shareRoute: !activity.shareRoute }) });
          await loadAccountData();
          showToast(activity.shareRoute ? 'Percurso privado.' : 'Percurso compartilhado com a campanha.');
        } catch (error) { showToast(error.message); visibility.disabled = false; }
      });
      row.append(visibility);
    }
    if (selected?.id === activity.id && selected.type === type) row.classList.add('selected');
    return row;
  }

  function renderLists() {
    const own = readActivities().filter((activity) => Array.isArray(activity.route) && activity.route.length >= 2);
    const mine = $('myRouteList');
    const others = $('communityRouteList');
    mine.replaceChildren();
    others.replaceChildren();
    if (!getUser()) {
      mine.textContent = 'Entre na sua conta para gravar e ver seus percursos.';
      others.textContent = 'Entre em uma campanha para descobrir rotas compartilhadas.';
      return;
    }
    if (!own.length) mine.textContent = 'Nenhum percurso gravado ainda. Inicie uma atividade no mapa.';
    else own.forEach((activity) => mine.append(routeRow(activity, 'mine')));
    if (!communityRoutes.length) others.textContent = 'Ainda não há rotas compartilhadas na sua campanha.';
    else communityRoutes.forEach((activity) => others.append(routeRow(activity, 'community')));
  }

  async function refresh() {
    communityRoutes = [];
    if (getUser()) {
      try { ({ routes: communityRoutes } = await api('/maps/routes')); }
      catch (error) { status(error.message); }
    }
    renderLists();
    updateLiveShareAvailability();
    refreshLiveParticipants();
  }

  function open() {
    ensureMap();
    if (!trackingActive) {
      $('routeMap').hidden = false;
      $('noGpsActivityNotice').hidden = true;
      $('mapLocateButton').hidden = false;
      $('mapAccuracy').closest('div').hidden = false;
    }
    setTimeout(() => map?.invalidateSize(), 0);
    if (!liveParticipantTimer) liveParticipantTimer = setInterval(refreshLiveParticipants, 5000);
    refresh();
  }

  function requireGPS() {
    if (!getUser()) { showLogin(); return false; }
    if (!window.isSecureContext || !navigator.geolocation) { status('Para usar o GPS, abra o app por HTTPS ou localhost em um navegador com localização disponível.'); return false; }
    return true;
  }

  function onPosition(position) {
    const { latitude: lat, longitude: lng, accuracy } = position.coords;
    $('mapAccuracy').textContent = `${Math.round(accuracy)} m`;
    if (accuracy > 50) { status('Aguardando um sinal de GPS mais preciso (até 50 m)…'); return; }
    const point = { lat, lng, t: Math.max(Date.now(), points.at(-1)?.t || 0) };
    if (!startedAt) {
      startedAt = point.t;
      timerId = setInterval(updateStats, 1000);
    }
    const last = points.at(-1);
    if (last) {
      const delta = metersBetween(last, point);
      const seconds = Math.max(1, (point.t - last.t) / 1000);
      if (delta < 5 || delta / seconds > 25) return;
      meters += delta;
    }
    points.push(point);
    publishLiveLocation(point);
    liveRoute.setLatLngs(smoothRouteForDisplay(points).map((entry) => [entry.lat, entry.lng]));
    if (locationMarker) locationMarker.setLatLng([lat, lng]);
    else locationMarker = L.circleMarker([lat, lng], { radius: 8, color: '#fff', weight: 3, fillColor: '#00d9bc', fillOpacity: 1 }).addTo(map);
    map.panTo([lat, lng]);
    updateStats();
    status(`Gravando percurso · ${points.length} pontos coletados.`);
    if (points.length >= 5000) finish();
  }

  function finish() {
    if (!trackingActive) return;
    const hadGps = trackingWithGps;
    stopWatch();
    stopLiveSharing();
    stoppedAt = Date.now();
    disconnectHeartRate();
    $('mapShareRoute').closest('label').hidden = !hadGps;
    $('mapFinishPanel').hidden = false;
    updateStats();
    status(!hadGps
      ? 'Atividade encerrada. Revise o horário e salve seu registro.'
      : points.length >= 2 ? 'Percurso encerrado. Escolha a atividade e salve.' : 'Percurso encerrado. São necessários pelo menos dois pontos de GPS para salvar.');
    onActivityStateChange();
  }

  function getActivityPlan() {
    return previewStart && previewEnd ? { start: previewStart, end: previewEnd } : null;
  }

  function start(mode, { trackLocation = true, plannedRoute = null } = {}) {
    if (trackingActive) { status('Sua atividade já está sendo gravada.'); return true; }
    if (!$('mapFinishPanel').hidden) { status('Salve ou descarte o percurso anterior antes de iniciar outro.'); return true; }
    if (trackLocation && !requireGPS()) return false;
    if (!trackLocation && !getUser()) { showLogin(); return false; }
    ensureMap();
    clearDraft(false, false);
    resetHeartRateStats();
    shownRoute.setLatLngs([]);
    routeDistanceDots.clearLayers();
    if (mode) $('mapMode').value = mode;
    trackingWithGps = trackLocation;
    updateLiveShareAvailability();
    $('routeMap').hidden = !trackLocation;
    $('noGpsActivityNotice').hidden = trackLocation;
    $('mapLocateButton').hidden = !trackLocation;
    $('mapAccuracy').closest('div').hidden = !trackLocation;
    $('mapDistance').closest('div').hidden = !trackLocation || !distanceActivityTypes.has($('mapMode').value);
    $('mapShareRoute').closest('label').hidden = !trackLocation;
    if (trackLocation && previewPosition) map.setView(previewPosition, 16);
    if (plannedRoute) {
      plannedRouteLayer = L.polyline([plannedRoute.start, plannedRoute.end], { color: '#13886f', weight: 5, opacity: 0.75, dashArray: '8 8' }).addTo(map);
      plannedStartMarker = L.marker(plannedRoute.start).bindTooltip('Saída planejada').addTo(map);
      plannedEndMarker = L.marker(plannedRoute.end).bindTooltip('Destino').addTo(map);
      map.fitBounds([plannedRoute.start, plannedRoute.end], { padding: [36, 36] });
    }
    $('mapStartButton').disabled = true;
    $('mapStopButton').disabled = false;
    trackingActive = true;
    updateLiveShareAvailability();
    if (trackLocation) {
      status('Solicitando acesso à localização… O tempo começará no primeiro ponto de GPS.');
      watchId = navigator.geolocation.watchPosition(onPosition, (error) => {
        status(gpsError(error));
        if (error.code === 1) { clearDraft(); status(gpsError(error)); }
      }, { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
    } else {
      startedAt = Date.now();
      timerId = setInterval(updateStats, 1000);
      status('Cronômetro ativo, sem localização GPS.');
    }
    onActivityStateChange();
    return true;
  }

  $('mapStartButton').addEventListener('click', () => start(undefined, { trackLocation: gpsActivityTypes.has($('mapMode').value) }));
  $('mapMode').addEventListener('change', () => {
    $('mapDistance').closest('div').hidden = !distanceActivityTypes.has($('mapMode').value);
    updateLiveShareAvailability();
  });
  $('mapShareLive').addEventListener('change', () => {
    updateLiveShareAvailability();
    if (!$('mapShareLive').checked) { stopLiveSharing(); return; }
    if (trackingActive && points.length) publishLiveLocation(points.at(-1), true);
    else liveShareStatus('Sua posição será compartilhada quando a atividade GPS começar.');
  });
  $('heartRateConnect').addEventListener('click', connectHeartRate);
  $('heartRateDisconnect').addEventListener('click', disconnectHeartRate);
  $('activityHeartRateConnect').addEventListener('click', connectHeartRate);
  $('activityHeartRateDisconnect').addEventListener('click', disconnectHeartRate);
  $('activityLocateButton').addEventListener('click', locateActivityPreview);
  $('activityPickStart').addEventListener('click', () => choosePreviewPoint('start'));
  $('activityPickEnd').addEventListener('click', () => choosePreviewPoint('end'));

  $('mapStopButton').addEventListener('click', finish);
  $('mapMediaInput').addEventListener('change', (event) => {
    const selectedFiles = [...event.target.files]; event.target.value = '';
    queueMediaFiles(selectedFiles);
  });
  $('mapLocateButton').addEventListener('click', () => {
    if (!requireGPS()) return;
    ensureMap();
    status('Buscando sua localização…');
    navigator.geolocation.getCurrentPosition((position) => {
      const { latitude, longitude, accuracy } = position.coords;
      if (locationMarker) locationMarker.setLatLng([latitude, longitude]);
      else locationMarker = L.circleMarker([latitude, longitude], { radius: 8, color: '#fff', weight: 3, fillColor: '#00d9bc', fillOpacity: 1 }).addTo(map);
      map.setView([latitude, longitude], 15);
      $('mapAccuracy').textContent = `${Math.round(accuracy)} m`;
      status('Sua localização está marcada no mapa.');
    }, (error) => status(gpsError(error)), { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
  });

  $('mapSaveButton').addEventListener('click', async () => {
    if (trackingWithGps && points.length < 2) { status('Aguarde pelo menos dois pontos de GPS para salvar o percurso.'); return; }
    const button = $('mapSaveButton');
    button.disabled = true;
    try {
      await api('/activities', { method: 'POST', body: JSON.stringify({
        id: crypto.randomUUID(),
        mode: baseActivityMode($('mapMode').value),
        activityType: $('mapMode').value,
        startedAt: new Date(startedAt).toISOString(),
        durationSeconds: Math.max(1, Math.round((stoppedAt - startedAt) / 1000)),
        distanceKm: trackingWithGps && distanceActivityTypes.has($('mapMode').value) ? Number((meters / 1000).toFixed(3)) : 0,
        averageHeartRate: heartRateCount ? Math.round(heartRateSum / heartRateCount) : null,
        maxHeartRate: heartRateCount ? maxHeartRate : null,
        route: trackingWithGps ? points : [],
        shareRoute: trackingWithGps && $('mapShareRoute').checked,
        media: await Promise.all(mediaFiles.map((file) => new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve({ data: reader.result });
          reader.onerror = () => reject(new Error(`Não foi possível ler o arquivo ${file.name}.`));
          reader.readAsDataURL(file);
        }))),
      }) });
      clearDraft();
      status('Percurso salvo em suas atividades.');
      await loadAccountData();
      showToast('Percurso salvo!');
    } catch (error) { status(error.message); }
    finally { button.disabled = false; }
  });
  $('mapDiscardButton').addEventListener('click', () => { clearDraft(); status('Percurso descartado.'); });

  return { open, refresh, start, openActivityPreview, getActivityPlan, queueMediaFiles, connectHeartRate, disconnectHeartRate, stop: stopWatch, isActivityVisible: () => trackingActive || !$('mapFinishPanel').hidden };
}
