import { createMapsController } from './maps.js';
import { setupPasswordVisibility } from './password-visibility.js';
import '../assets/vendor/leaflet/leaflet.css';

setupPasswordVisibility();

const STORAGE_KEY = 'vip-go-activities-v1';
const toast = document.getElementById('toast');
let toastTimer;
let currentUser = null;
let campaignData = null;
let mapsController;
let activityCache = null;
let editingActivityId = null;
let communityPhotoFiles = [];
let communityCommentState = new Map();
let activeCommunityId = null;
let communityDirectory = [];
let calendarMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let selectedCalendarDate = new Date();
selectedCalendarDate.setHours(0, 0, 0, 0);

async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
  });
  const data = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Não foi possível concluir a operação.');
  return data;
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3000);
}

function readActivities() {
  if (activityCache) return activityCache;
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(stored) ? stored : [];
  } catch { return []; }
}

function saveActivities(activities) {
  activityCache = activities;
  // Precise GPS coordinates stay in memory; the account API reloads them after sign-in.
  localStorage.setItem(STORAGE_KEY, JSON.stringify(activities.map(({ route, ...activity }) => activity)));
}
function formatNumber(value) { return new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 }).format(value); }
function baseActivityMode(activityType) {
  if (['Corrida', 'Corrida de rua', 'Corrida em trilha', 'Trilha'].includes(activityType)) return 'Corrida';
  if (['Ciclismo', 'Mountain bike', 'Ciclismo indoor', 'Spinning'].includes(activityType)) return 'Ciclismo';
  return 'Caminhada';
}
function activitySymbol(activityType) {
  return ({
    Caminhada: '🚶', Corrida: '🏃', 'Corrida de rua': '🏃', 'Corrida em trilha': '🏃', Trilha: '🥾', Ciclismo: '🚴', 'Mountain bike': '🚵', Patinação: '🛼', Canoagem: '🛶', Escalada: '🧗', Surfe: '🏄', Skate: '🛹',
    Natação: '🏊', Musculação: '🏋️', 'Treinamento funcional': '💪', Crossfit: '🏋️', Yoga: '🧘', Pilates: '🤸', Dança: '💃',
    Futebol: '⚽', Futsal: '⚽', Basquete: '🏀', Vôlei: '🏐', Tênis: '🎾', 'Beach tennis': '🏖️', Remo: '🚣',
    'Ciclismo indoor': '🚴', Spinning: '🚴', Elíptico: '🏃', Escada: '🪜', Alongamento: '🧘', 'Artes marciais': '🥋', Outro: '🏅',
  })[activityType] || '🏃';
}
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
function formatDuration(seconds) {
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours}h ${String(minutes % 60).padStart(2, '0')}min` : `${minutes} min`;
}
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function setAvatar(element, name, photoUrl) {
  const initials = String(name || '?').split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
  element.textContent = photoUrl ? '' : initials;
  element.classList.toggle('has-photo', Boolean(photoUrl));
  if (photoUrl) element.style.backgroundImage = `url("${photoUrl}")`;
  else element.style.removeProperty('background-image');
  element.setAttribute('aria-label', name || 'Participante');
}

function renderActivities() {
  const activities = readActivities();
  const list = document.getElementById('activityList');
  list.replaceChildren();
  activities.forEach((activity) => {
    const item = document.createElement('article');
    item.className = 'activity';
    const activityStart = new Date(activity.startedAt);
    const activityEnd = new Date(activityStart.getTime() + activity.durationSeconds * 1000);
    const date = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'medium' }).format(activityStart);
    const timeRange = `${new Intl.DateTimeFormat('pt-BR', { timeStyle: 'short' }).format(activityStart)}–${new Intl.DateTimeFormat('pt-BR', { timeStyle: 'short' }).format(activityEnd)}`;
    const distance = activity.distanceKm > 0 ? `${formatNumber(activity.distanceKm)} km` : 'Distância não informada';
    const activityType = activity.activityType || activity.mode;
    const hasDistance = distanceActivityTypes.has(activityType) && activity.distanceKm > 0;
    const heartRateSummary = activity.averageHeartRate ? ` · FC ${activity.averageHeartRate} média / ${activity.maxHeartRate} máx.` : '';
    item.dataset.activityId = activity.id;
    item.innerHTML = `<div class="activity-main"><div class="activity-icon" aria-hidden="true">${activitySymbol(activityType)}</div><div class="activity-copy"><h3>${escapeHtml(activityType)}</h3><p>${escapeHtml(`${date} · ${timeRange}`)}</p></div><div class="activity-metrics"><strong>${escapeHtml(hasDistance ? distance : formatDuration(activity.durationSeconds))}</strong><small>${escapeHtml(`${hasDistance ? formatDuration(activity.durationSeconds) : 'Duração'}${heartRateSummary}`)}</small></div></div><div class="activity-actions" aria-label="Ações da atividade"><button type="button" class="activity-action activity-action-start" data-activity-action="start">▶ Iniciar</button><button type="button" class="activity-action" data-activity-action="edit">Editar</button><button type="button" class="activity-action activity-action-media" data-activity-action="media">＋ Foto/vídeo</button><button type="button" class="activity-action activity-action-delete" data-activity-action="delete">Excluir</button></div>`;
    list.append(item);
  });
  if (!activities.length) {
    const empty = document.createElement('p');
    empty.className = 'activity-empty';
    empty.textContent = 'Suas atividades registradas aparecerão aqui.';
    list.append(empty);
  }
  const now = new Date();
  const monday = new Date(now);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const nextMonday = new Date(monday);
  nextMonday.setDate(nextMonday.getDate() + 7);
  const week = activities.filter((activity) => {
    const started = new Date(activity.startedAt);
    return started >= monday && started < nextMonday && started <= now;
  });
  const seconds = week.reduce((sum, activity) => sum + activity.durationSeconds, 0);
  const minutes = Math.floor(seconds / 60);
  const distance = week.reduce((sum, activity) => sum + activity.distanceKm, 0);
  document.getElementById('distanceStat').innerHTML = `${formatNumber(distance)} <span>km</span>`;
  document.getElementById('timeStat').innerHTML = `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}<span>min</span>`;
  document.getElementById('countStat').innerHTML = `${week.length} <span>esta semana</span>`;
  document.getElementById('weekMinutes').textContent = minutes;
  renderWeeklyActivityChart(activities);
  renderCalendar();
}

function calendarDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function renderCalendar() {
  const title = document.getElementById('calendarMonthTitle');
  const dayGrid = document.getElementById('calendarDays');
  if (!title || !dayGrid) return;
  title.textContent = new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric' }).format(calendarMonth);
  const activities = readActivities().filter((activity) => activity.startedAt && Number.isFinite(new Date(activity.startedAt).getTime()));
  const byDate = new Map();
  activities.forEach((activity) => {
    const key = calendarDateKey(new Date(activity.startedAt));
    if (!byDate.has(key)) byDate.set(key, []);
    byDate.get(key).push(activity);
  });
  const monthActivities = activities.filter((activity) => {
    const date = new Date(activity.startedAt);
    return date.getFullYear() === calendarMonth.getFullYear() && date.getMonth() === calendarMonth.getMonth();
  });
  const monthSeconds = monthActivities.reduce((sum, activity) => sum + Number(activity.durationSeconds || 0), 0);
  const monthDistance = monthActivities.reduce((sum, activity) => sum + Number(activity.distanceKm || 0), 0);
  document.getElementById('calendarTotalTime').textContent = formatDuration(monthSeconds);
  document.getElementById('calendarTotalDistance').textContent = `${formatNumber(monthDistance)} km`;
  document.getElementById('calendarTotalActivities').textContent = String(monthActivities.length);

  const weekdays = document.getElementById('calendarWeekdays');
  weekdays.replaceChildren();
  ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'].forEach((name) => {
    const label = document.createElement('span');
    label.textContent = name;
    weekdays.append(label);
  });
  dayGrid.replaceChildren();
  const year = calendarMonth.getFullYear();
  const month = calendarMonth.getMonth();
  const firstWeekday = (new Date(year, month, 1).getDay() + 6) % 7;
  for (let i = 0; i < firstWeekday; i += 1) {
    const blank = document.createElement('span');
    blank.className = 'calendar-day-placeholder';
    blank.setAttribute('aria-hidden', 'true');
    dayGrid.append(blank);
  }
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayKey = calendarDateKey(new Date());
  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = new Date(year, month, day);
    const key = calendarDateKey(date);
    const dayActivities = byDate.get(key) || [];
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `calendar-day${dayActivities.length ? ' has-workout' : ''}${key === todayKey ? ' is-today' : ''}${key === calendarDateKey(selectedCalendarDate) ? ' is-selected' : ''}`;
    button.setAttribute('aria-label', `${day} de ${new Intl.DateTimeFormat('pt-BR', { month: 'long' }).format(date)}${dayActivities.length ? `, ${dayActivities.length} ${dayActivities.length === 1 ? 'atividade' : 'atividades'}` : ', sem atividades'}`);
    button.setAttribute('aria-pressed', String(key === calendarDateKey(selectedCalendarDate)));
    button.innerHTML = `<span>${day}</span>${dayActivities.length ? `<i aria-hidden="true"></i><small>${dayActivities.length}</small>` : ''}`;
    button.addEventListener('click', () => {
      selectedCalendarDate = date;
      renderCalendar();
    });
    dayGrid.append(button);
  }

  const selectedKey = calendarDateKey(selectedCalendarDate);
  const selectedActivities = (byDate.get(selectedKey) || []).slice().sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt));
  document.getElementById('calendarSelectedDate').textContent = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' }).format(selectedCalendarDate);
  document.getElementById('calendarSelectedCount').textContent = `${selectedActivities.length} ${selectedActivities.length === 1 ? 'atividade' : 'atividades'}`;
  const details = document.getElementById('calendarDayActivities');
  details.replaceChildren();
  if (!selectedActivities.length) {
    const empty = document.createElement('p');
    empty.className = 'calendar-empty';
    empty.textContent = 'Nenhuma atividade registrada neste dia.';
    details.append(empty);
    return;
  }
  selectedActivities.forEach((activity) => {
    const start = new Date(activity.startedAt);
    const end = new Date(start.getTime() + Number(activity.durationSeconds || 0) * 1000);
    const type = activity.activityType || activity.mode || 'Atividade';
    const item = document.createElement('article');
    item.className = 'calendar-activity';
    const metrics = [formatDuration(Number(activity.durationSeconds || 0))];
    if (Number(activity.distanceKm) > 0) metrics.push(`${formatNumber(Number(activity.distanceKm))} km`);
    if (activity.averageHeartRate) metrics.push(`${activity.averageHeartRate} bpm médios`);
    item.innerHTML = `<span class="calendar-activity-icon" aria-hidden="true">${activitySymbol(type)}</span><div class="calendar-activity-copy"><strong>${escapeHtml(type)}</strong><small>${escapeHtml(new Intl.DateTimeFormat('pt-BR', { timeStyle: 'short' }).format(start))}–${escapeHtml(new Intl.DateTimeFormat('pt-BR', { timeStyle: 'short' }).format(end))}</small><span>${escapeHtml(metrics.join(' · '))}</span></div>${activity.media?.length ? `<span class="calendar-media-count" title="Atividade com fotos ou vídeos">▧ ${activity.media.length}</span>` : ''}`;
    details.append(item);
  });
}

function renderWeeklyActivityChart(activities) {
  const bars = document.getElementById('weeklyChartBars');
  if (!bars) return;
  const campaign = campaignData?.campaign;
  const target = campaign ? Number(campaign.weeklyGoalMinutes) : null;
  const now = new Date();
  const campaignDays = campaign?.periodType === 'monthly' ? new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate() : 7;
  const perDay = target > 0 ? target / campaignDays : null;
  document.getElementById('weeklyDailyPace').textContent = perDay ? `Ritmo diário: ${Math.ceil(perDay)} min` : 'Entre na campanha para ver a meta diária';
  const monday = new Date(now);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const dayNames = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'];
  const daily = dayNames.map((name, index) => {
    const date = new Date(monday);
    date.setDate(monday.getDate() + index);
    const next = new Date(date);
    next.setDate(date.getDate() + 1);
    const items = activities.filter((activity) => {
      const started = new Date(activity.startedAt);
      return started >= date && started < next && started <= now;
    });
    const totalMinutes = items.reduce((sum, activity) => sum + Number(activity.durationSeconds || 0), 0) / 60;
    const morningActivities = items.filter((activity) => {
      const started = new Date(activity.startedAt);
      return started.getHours() >= 5 && started.getHours() < 12;
    });
    const morningCount = morningActivities.length;
    const morningMinutes = morningActivities.reduce((sum, activity) => sum + Number(activity.durationSeconds || 0), 0) / 60;
    const isFuture = date > new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const status = !perDay || isFuture ? 'neutral' : totalMinutes >= perDay ? 'met' : 'missed';
    return { name, date, totalMinutes, morningCount, morningMinutes, status, isFuture };
  });
  const maxMinutes = Math.max(perDay || 1, ...daily.map((day) => day.totalMinutes), 1);
  bars.replaceChildren();
  daily.forEach((day) => {
    const item = document.createElement('div');
    item.className = `weekly-day is-${day.status}${day.isFuture ? ' is-future' : ''}`;
    item.setAttribute('role', 'listitem');
    const pct = day.totalMinutes > 0 ? Math.max(5, Math.min(100, day.totalMinutes / maxMinutes * 100)) : 0;
    const morning = day.morningCount > 0;
    const label = `${day.name}: ${Math.floor(day.totalMinutes)} minutos${morning ? `, ${day.morningCount} ${day.morningCount === 1 ? 'atividade' : 'atividades'} pela manhã, ${Math.floor(day.morningMinutes)} minutos` : ', sem atividade pela manhã'}${day.status === 'met' ? ', meta cumprida' : day.status === 'missed' ? ', abaixo da meta' : day.isFuture ? ', dia futuro' : ', meta diária indisponível'}`;
    item.setAttribute('aria-label', label);
    item.title = label;
    item.innerHTML = `<span class="weekly-day-value">${Math.floor(day.totalMinutes)}<small>m</small></span><div class="weekly-bar-track"><i style="height:${pct}%"></i>${morning ? '<b class="morning-marker" aria-hidden="true">☀</b>' : ''}</div><span class="weekly-day-name">${day.name}</span>`;
    bars.append(item);
  });
}

document.getElementById('activityList').addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-activity-action]');
  if (!button) return;
  const activity = readActivities().find((item) => item.id === button.closest('[data-activity-id]')?.dataset.activityId);
  if (!activity) return;
  if (button.dataset.activityAction === 'start') {
    if (!currentUser) { showToast('Entre na sua conta para iniciar uma atividade.'); return; }
    const activityType = activity.activityType || activity.mode;
    if (mapsController.start(activityType, { trackLocation: gpsActivityTypes.has(activityType) })) setPage('Atividades');
    return;
  }
  if (button.dataset.activityAction === 'edit') {
    openActivityEdit(activity);
    return;
  }
  if (button.dataset.activityAction === 'media') {
    openActivityEdit(activity);
    document.getElementById('activityMediaInput').click();
    return;
  }
  if (button.dataset.activityAction === 'delete') {
    if (!window.confirm(`Excluir sua atividade de ${activity.activityType || activity.mode}? Esta ação não pode ser desfeita.`)) return;
    button.disabled = true;
    try {
      await api(`/activities/${encodeURIComponent(activity.id)}`, { method: 'DELETE' });
      await loadAccountData();
      showToast('Atividade excluída.');
    } catch (error) {
      showToast(error.message);
      button.disabled = false;
    }
  }
});

function renderRanking(rows, containerId, team = false) {
  const list = document.getElementById(containerId);
  list.replaceChildren();
  if (!rows?.length) {
    const empty = document.createElement('p');
    empty.className = 'activity-empty';
    empty.textContent = campaignData?.joined ? 'Ainda não há atividade registrada nesta semana.' : 'Entre na campanha para ver o ranking.';
    list.append(empty);
    return;
  }
  rows.forEach((row, index) => {
    const item = document.createElement('div');
    item.className = 'leader-row';
    const placeClass = ['gold', 'silver', 'bronze'][index] || '';
    const name = team ? row.teamName : row.name;
    const detail = team ? `${row.participants} participante${row.participants === 1 ? '' : 's'}` : `${row.teamName} · ${row.activityCount} atividade${row.activityCount === 1 ? '' : 's'}`;
    item.innerHTML = `<span class="leader-place ${placeClass}">${index + 1}</span><span class="avatar">${team ? '👥' : escapeHtml(name.split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase())}</span><div class="leader-name"><strong>${escapeHtml(name)}</strong><small>${escapeHtml(detail)}</small></div><strong class="leader-score">${row.minutes} <small>min</small></strong>`;
    list.append(item);
  });
}

function renderBadges(badges = []) {
  for (const id of ['badgeList', 'profileBadges']) {
    const list = document.getElementById(id);
    list.replaceChildren();
    if (!badges.length) {
      const empty = document.createElement('p');
      empty.className = 'activity-empty';
      empty.textContent = 'Continue participando para conquistar sua primeira medalha.';
      list.append(empty);
      continue;
    }
    badges.forEach((badge) => {
      const item = document.createElement('article');
      item.className = 'badge-item';
      item.innerHTML = `<span class="badge-icon">${escapeHtml(badge.icon)}</span><span><strong>${escapeHtml(badge.name)}</strong><small>${escapeHtml(badge.description)}</small></span>`;
      list.append(item);
    });
  }
}

function renderActivityFeed(activities = []) {
  const list = document.getElementById('activityFeed');
  list.replaceChildren();
  if (!activities.length) {
    const empty = document.createElement('p');
    empty.className = 'activity-empty';
    empty.textContent = 'Nenhuma atividade compartilhada nesta campanha.';
    list.append(empty);
    return;
  }
  activities.forEach((activity) => {
    const item = document.createElement('article');
    item.className = 'feed-item';
    const date = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'medium' }).format(new Date(activity.startedAt));
    const distanceText = activity.distanceKm > 0 ? ` · ${formatNumber(activity.distanceKm)} km` : '';
    item.innerHTML = `<div class="avatar">${escapeHtml(activity.name.split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase())}</div><div class="feed-copy"><strong>${escapeHtml(activity.name)}</strong> registrou ${escapeHtml(activity.mode.toLowerCase())}<small>${escapeHtml(date)} · ${escapeHtml(formatDuration(activity.durationSeconds))}${escapeHtml(distanceText)}</small></div>`;
    list.append(item);
  });
}

function renderSocialHome(data = {}) {
  const peopleList = document.getElementById('socialPeopleList');
  const feedList = document.getElementById('socialFeedList');
  const people = data.people || [];
  const feed = data.socialFeed || [];
  const communityPosts = data.communityPosts || [];
  const profileUser = data.user || currentUser;
  const profileName = profileUser?.name || 'Participante VIP Go';
  const profilePhoto = profileUser?.profilePhoto
    ? (String(profileUser.profilePhoto).startsWith('/') ? profileUser.profilePhoto : `/api/profile-photos/${profileUser.profilePhoto}`)
    : null;
  setAvatar(document.getElementById('socialProfileAvatar'), profileName, profilePhoto);
  document.getElementById('socialProfileName').textContent = profileName;
  document.getElementById('socialProfileDetail').textContent = data.joined
    ? [profileUser?.teamName, profileUser?.companyName].filter(Boolean).join(' · ') || 'Participante da campanha'
    : 'Participe de uma campanha para encontrar sua equipe';
  document.getElementById('socialFollowingCount').textContent = String(people.filter((person) => person.isFollowing).length);
  document.getElementById('socialActivityCount').textContent = document.getElementById('countStat').textContent.trim().split(/\s+/)[0] || '0';
  document.getElementById('socialInviteCard').hidden = Boolean(!data.joined && !data.user && !currentUser);
  document.getElementById('socialInviteAction').textContent = data.joined ? 'Encontrar colegas →' : 'Entrar com código da empresa →';
  document.getElementById('socialPeopleCount').textContent = String(people.length);
  peopleList.replaceChildren();
  feedList.replaceChildren();
  if (!data.joined) {
    if (data.user) {
    const photoUrl = profileUser.profilePhoto ? (String(profileUser.profilePhoto).startsWith('/') ? profileUser.profilePhoto : `/api/profile-photos/${profileUser.profilePhoto}`) : null;
    document.getElementById('shareProfilePhoto').checked = Boolean(profileUser.shareProfilePhoto);
    document.getElementById('shareActivities').checked = Boolean(profileUser.shareActivities);
    document.getElementById('showInRanking').checked = Boolean(profileUser.showInRanking);
    setAvatar(document.getElementById('profilePhotoPreview'), profileUser.name, photoUrl);
    document.querySelectorAll('.profile-mini .avatar').forEach((node) => setAvatar(node, profileUser.name, photoUrl));
    setAvatar(document.getElementById('accountButton'), profileUser.name, photoUrl);
    }
    const empty = document.createElement('p');
    empty.className = 'activity-empty';
    empty.innerHTML = '<strong>Entre na campanha para encontrar sua comunidade</strong><span>Use o código da empresa no seu perfil para ver participantes e acompanhar as atividades que eles escolheram compartilhar.</span>';
    peopleList.append(empty);
    const feedEmpty = document.createElement('p');
    feedEmpty.className = 'activity-empty';
    feedEmpty.innerHTML = '<strong>Seu feed está pronto para começar</strong><span>Entre na sua campanha para descobrir participantes e ver as atividades que eles escolheram compartilhar.</span>';
    const joinAction = document.createElement('button');
    joinAction.type = 'button';
    joinAction.className = 'social-join-action';
    const signedIn = Boolean(currentUser || data.user);
    joinAction.textContent = signedIn ? 'Usar código da empresa' : 'Entrar ou criar conta';
    joinAction.addEventListener('click', () => {
      if (!currentUser && !data.user) {
        document.getElementById('accountButton').click();
        return;
      }
      setPage('Perfil');
      setProfileTab('join');
    });
    feedEmpty.append(joinAction);
    feedList.append(feedEmpty);
  } else if (!people.length) {
    const empty = document.createElement('p');
    empty.className = 'activity-empty';
    empty.innerHTML = '<strong>Sua comunidade começa com você</strong><span>Convide colegas com o código da campanha para descobrir e seguir participantes.</span>';
    peopleList.append(empty);
  }
  people.forEach((person) => {
    const row = document.createElement('article');
    row.className = 'social-person';
    const avatar = document.createElement('span');
    avatar.className = 'avatar';
    setAvatar(avatar, person.name, person.profilePhoto);
    const info = document.createElement('div');
    info.className = 'social-person-info';
    const name = document.createElement('strong');
    name.textContent = person.name;
    const detail = document.createElement('small');
    detail.textContent = person.teamName || `${person.activityCount} atividades compartilhadas`;
    info.append(name, detail);
    const follow = document.createElement('button');
    follow.type = 'button';
    follow.className = person.isFollowing ? 'social-following-button' : 'social-follow-button';
    follow.textContent = person.isFollowing ? 'Seguindo' : 'Seguir';
    follow.addEventListener('click', async () => {
      follow.disabled = true;
      try {
        if (person.isFollowing) await api(`/social/follow/${person.id}`, { method: 'DELETE' });
        else await api(`/social/follow/${person.id}`, { method: 'POST' });
        await refreshCampaign();
      } catch (error) { showToast(error.message); follow.disabled = false; }
    });
    row.append(avatar, info, follow);
    peopleList.append(row);
  });
  if (data.joined && !feed.length && !communityPosts.length) {
    const empty = document.createElement('p');
    empty.className = 'activity-empty';
    empty.innerHTML = people.length ? '<strong>Seu feed começa com um follow</strong><span>Siga participantes para acompanhar as atividades que eles escolheram compartilhar.</span>' : '<strong>As novidades da campanha aparecem aqui</strong><span>Quando alguém compartilhar uma atividade, ela ficará disponível neste feed.</span>';
    feedList.append(empty);
  }
  feed.forEach((activity) => {
    const post = document.createElement('article');
    post.className = 'social-post';
    const header = document.createElement('div');
    header.className = 'social-post-header';
    const avatar = document.createElement('span');
    avatar.className = 'avatar';
    setAvatar(avatar, activity.name, activity.profilePhoto);
    const author = document.createElement('div');
    author.className = 'social-post-author';
    const name = document.createElement('strong');
    name.textContent = activity.name;
    const date = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(activity.startedAt));
    const meta = document.createElement('small');
    meta.textContent = `${activity.mode} · ${date}${activity.teamName ? ` · ${activity.teamName}` : ''}`;
    author.append(name, meta);
    header.append(avatar, author);
    post.append(header);
    const metrics = document.createElement('div');
    metrics.className = 'social-post-metrics';
    metrics.innerHTML = `<span>⏱ ${escapeHtml(formatDuration(activity.durationSeconds))}</span><span>↗ ${escapeHtml(formatNumber(activity.distanceKm))} km</span>`;
    post.append(metrics);
    const media = document.createElement('div');
    media.className = 'social-post-media';
    (activity.media || []).forEach((item) => {
      if (item.type === 'video') {
        const video = document.createElement('video');
        video.src = item.url;
        video.controls = true;
        video.preload = 'metadata';
        media.append(video);
      } else {
        const image = document.createElement('img');
        image.src = item.url;
        image.alt = `Foto da atividade de ${activity.name}`;
        image.loading = 'lazy';
        media.append(image);
      }
    });
    if (media.childElementCount) post.append(media);
    feedList.append(post);
  });
  renderCommunityPostCards(communityPosts, feedList, false);
  renderCommunityCarousel(communityPosts, feed);
}

function renderCommunityPostCards(communityPosts = [], feedList = document.getElementById('socialFeedList'), inCommunity = false) {
  communityPosts.forEach((communityPost) => {
    const post = document.createElement('article');
    post.className = 'social-post community-post';
    const header = document.createElement('div');
    header.className = 'social-post-header';
    const avatar = document.createElement('span');
    avatar.className = 'avatar';
    setAvatar(avatar, communityPost.name, communityPost.profilePhoto);
    const author = document.createElement('div');
    author.className = 'social-post-author';
    const name = document.createElement('strong'); name.textContent = communityPost.name;
    const meta = document.createElement('small');
    meta.textContent = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(`${communityPost.createdAt.replace(' ', 'T')}Z`));
    author.append(name, meta); header.append(avatar, author); post.append(header);
    if (communityPost.body) {
      const body = document.createElement('p'); body.className = 'community-post-body'; body.textContent = communityPost.body; post.append(body);
    }
    if (communityPost.media?.length) {
      const media = document.createElement('div'); media.className = 'social-post-media';
      communityPost.media.forEach((item) => { const image = document.createElement('img'); image.src = item.url; image.alt = `Foto compartilhada por ${communityPost.name}`; image.loading = 'lazy'; media.append(image); });
      post.append(media);
    }
    const actions = document.createElement('div'); actions.className = 'community-post-actions';
    const react = document.createElement('button'); react.type = 'button'; react.className = communityPost.reacted ? 'community-reaction is-active' : 'community-reaction';
    react.textContent = `👏 ${communityPost.reactionCount} ${communityPost.reactionCount === 1 ? 'parabéns' : 'parabéns'}`;
    react.addEventListener('click', async () => { react.disabled = true; try { await api(`/community/posts/${communityPost.id}/reaction`, { method: 'POST' }); if (inCommunity) await loadSelectedCommunity(activeCommunityId); else await refreshCampaign(); } catch (error) { showToast(error.message); react.disabled = false; } });
    const commentsButton = document.createElement('button'); commentsButton.type = 'button'; commentsButton.className = 'community-comments-toggle';
    commentsButton.textContent = `💬 ${communityPost.commentCount} comentários`;
    actions.append(react, commentsButton); post.append(actions);
    const commentsPanel = document.createElement('div'); commentsPanel.className = 'community-comments';
    const renderComments = (comments) => {
      commentsPanel.replaceChildren();
      comments.forEach((comment) => { const row = document.createElement('div'); row.className = 'community-comment'; const photo = document.createElement('span'); photo.className = 'avatar'; photo.style.width = '30px'; photo.style.height = '30px'; setAvatar(photo, comment.name, comment.profilePhoto); const copy = document.createElement('p'); const strong = document.createElement('strong'); strong.textContent = comment.name; const text = document.createElement('span'); text.textContent = comment.body; copy.append(strong, text); row.append(photo, copy); commentsPanel.append(row); });
      const form = document.createElement('form'); form.className = 'community-comment-form'; const input = document.createElement('input'); input.maxLength = 500; input.placeholder = 'Escreva um comentário…'; input.setAttribute('aria-label', 'Escreva um comentário'); input.required = true; const send = document.createElement('button'); send.type = 'submit'; send.textContent = 'Enviar'; form.append(input, send); form.addEventListener('submit', async (event) => { event.preventDefault(); send.disabled = true; try { const result = await api(`/community/posts/${communityPost.id}/comments`, { method: 'POST', body: JSON.stringify({ body: input.value }) }); communityCommentState.set(communityPost.id, result.comments); renderComments(result.comments); if (inCommunity) await loadSelectedCommunity(activeCommunityId); else await refreshCampaign(); } catch (error) { showToast(error.message); send.disabled = false; } }); commentsPanel.append(form);
    };
    commentsButton.addEventListener('click', async () => {
      const open = !commentsPanel.hidden; commentsPanel.hidden = open;
      if (!open) { commentsButton.disabled = true; try { const result = communityCommentState.has(communityPost.id) ? { comments: communityCommentState.get(communityPost.id) } : await api(`/community/posts/${communityPost.id}/comments`); communityCommentState.set(communityPost.id, result.comments); renderComments(result.comments); } catch (error) { showToast(error.message); commentsPanel.hidden = true; } finally { commentsButton.disabled = false; } }
    });
    commentsPanel.hidden = true; post.append(commentsPanel); feedList.append(post);
  });
}

function renderCommunityCarousel(posts = [], activities = []) {
  const track = document.getElementById('communityCarouselTrack');
  track.replaceChildren();
  const slides = [
    ...posts.map((post) => ({ ...post, kind: 'post', date: post.createdAt })),
    ...activities.map((activity) => ({ ...activity, kind: 'activity', date: activity.startedAt, body: `${activity.mode} · ${formatDuration(activity.durationSeconds)}${activity.distanceKm > 0 ? ` · ${formatNumber(activity.distanceKm)} km` : ''}` })),
  ].sort((a, b) => new Date(b.date.replace?.(' ', 'T') || b.date).getTime() - new Date(a.date.replace?.(' ', 'T') || a.date).getTime()).slice(0, 12);
  if (!slides.length) {
    const empty = document.createElement('p'); empty.className = 'activity-empty';
    empty.innerHTML = '<strong>A comunidade está começando</strong><span>As publicações e atividades compartilhadas pelos participantes aparecerão aqui.</span>';
    track.append(empty); return;
  }
  slides.forEach((item) => {
    const card = document.createElement('article'); card.className = 'community-carousel-slide';
    const head = document.createElement('div'); head.className = 'community-carousel-author';
    const avatar = document.createElement('span'); avatar.className = 'avatar'; setAvatar(avatar, item.name, item.profilePhoto);
    const info = document.createElement('div'); const name = document.createElement('strong'); name.textContent = item.name;
    const date = document.createElement('small'); date.textContent = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'medium' }).format(new Date(item.date.replace?.(' ', 'T') || item.date));
    info.append(name, date); head.append(avatar, info); card.append(head);
    const text = document.createElement('p'); text.className = 'community-carousel-copy'; text.textContent = item.body || (item.kind === 'post' ? 'Compartilhou um momento com a campanha.' : `Registrou ${item.mode.toLowerCase()}.`); card.append(text);
    const mediaItems = item.kind === 'post' ? item.media || [] : item.media || [];
    if (mediaItems.length) {
      const media = document.createElement('div'); media.className = 'community-carousel-media';
      const image = document.createElement('img'); image.src = mediaItems[0].url; image.alt = `Publicação de ${item.name}`; image.loading = 'lazy'; media.append(image); card.append(media);
    }
    const link = document.createElement('button'); link.type = 'button'; link.className = 'community-slide-link'; link.textContent = item.kind === 'post' ? `👏 ${item.reactionCount} · 💬 ${item.commentCount}` : 'Ver na comunidade →';
    link.addEventListener('click', () => setPage('Comunidade')); card.append(link); track.append(card);
  });
}

function renderCommunityDirectory(communities = []) {
  communityDirectory = communities;
  const list = document.getElementById('communityDirectoryList');
  list.replaceChildren();
  if (!communities.length) {
    const empty = document.createElement('p'); empty.className = 'activity-empty';
    empty.textContent = 'Nenhuma comunidade encontrada. Você pode criar uma e convidar outras pessoas.'; list.append(empty); return;
  }
  communities.forEach((community) => {
    const card = document.createElement('article'); card.className = 'community-directory-item';
    const copy = document.createElement('div'); copy.className = 'community-directory-copy';
    const name = document.createElement('strong'); name.textContent = community.name;
    const desc = document.createElement('p'); desc.textContent = community.description || 'Comunidade aberta do VIP Go.';
    const meta = document.createElement('small'); meta.textContent = `${community.memberCount} ${community.memberCount === 1 ? 'participante' : 'participantes'}`;
    copy.append(name, desc, meta);
    const action = document.createElement('button'); action.type = 'button'; action.className = community.isMember ? 'community-join-button is-member' : 'community-join-button'; action.textContent = community.isMember ? 'Abrir' : 'Participar';
    action.addEventListener('click', async () => {
      action.disabled = true;
      try {
        if (!community.isMember) await api(`/communities/${community.id}/join`, { method: 'POST' });
        await loadSelectedCommunity(community.id); await loadCommunityDirectory();
      } catch (error) { showToast(error.message); action.disabled = false; }
    });
    card.append(copy, action); list.append(card);
  });
}

async function loadCommunityDirectory(query = '') {
  if (!currentUser) {
    document.getElementById('communityDirectoryList').innerHTML = '<p class="activity-empty">Entre na sua conta para encontrar comunidades.</p>';
    return;
  }
  try {
    const result = await api(`/communities${query ? `?q=${encodeURIComponent(query)}` : ''}`);
    renderCommunityDirectory(result.communities || []);
  } catch (error) { showToast(error.message); }
}

async function loadSelectedCommunity(id) {
  try {
    const result = await api(`/communities/${id}`);
    activeCommunityId = Number(id);
    document.getElementById('communitySelectedCard').hidden = true;
    document.getElementById('communityConversation').hidden = false;
    document.getElementById('selectedCommunityName').textContent = result.community.name;
    document.getElementById('selectedCommunityDescription').textContent = `${result.community.description || 'Comunidade aberta'} · ${result.community.memberCount} participantes`;
    const codeButton = document.getElementById('selectedCommunityCode');
    codeButton.textContent = `Código ${result.community.joinCode}`;
    codeButton.onclick = async () => { try { await navigator.clipboard.writeText(result.community.joinCode); showToast('Código da comunidade copiado.'); } catch { showToast(`Código da comunidade: ${result.community.joinCode}`); } };
    document.getElementById('communityComposer').hidden = false;
    const feed = document.getElementById('socialFeedList'); feed.replaceChildren();
    if (!result.posts.length) { const empty = document.createElement('p'); empty.className = 'activity-empty'; empty.textContent = 'Ainda não há publicações. Seja a primeira pessoa a compartilhar algo!'; feed.append(empty); }
    else renderCommunityPostCards(result.posts, feed, true);
  } catch (error) { showToast(error.message); }
}

document.getElementById('createCommunityForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const submit = event.currentTarget.querySelector('button[type="submit"]'); submit.disabled = true;
  try {
    const result = await api('/communities', { method: 'POST', body: JSON.stringify({ name: document.getElementById('newCommunityName').value, description: document.getElementById('newCommunityDescription').value }) });
    event.currentTarget.reset(); await loadCommunityDirectory(); await loadSelectedCommunity(result.id); showToast('Comunidade criada. Compartilhe o nome ou código para outras pessoas encontrarem.');
  } catch (error) { showToast(error.message); }
  finally { submit.disabled = false; }
});

let communitySearchTimer;
document.getElementById('communitySearch').addEventListener('input', (event) => {
  clearTimeout(communitySearchTimer); communitySearchTimer = setTimeout(() => loadCommunityDirectory(event.target.value.trim()), 180);
});

function renderCommunityPhotoPreviews() {
  const previews = document.getElementById('communityPhotoPreviews');
  previews.replaceChildren();
  communityPhotoFiles.forEach((file, index) => {
    const wrapper = document.createElement('div'); wrapper.className = 'community-photo-preview';
    const image = document.createElement('img'); image.src = URL.createObjectURL(file); image.alt = file.name;
    const remove = document.createElement('button'); remove.type = 'button'; remove.setAttribute('aria-label', 'Remover foto'); remove.textContent = '×'; remove.addEventListener('click', () => { communityPhotoFiles.splice(index, 1); renderCommunityPhotoPreviews(); });
    wrapper.append(image, remove); previews.append(wrapper);
  });
  document.getElementById('communityPhotoCount').textContent = `${communityPhotoFiles.length}/4 fotos · até 5 MB cada`;
}

document.getElementById('communityPostPhotos').addEventListener('change', (event) => {
  const selected = [...event.target.files];
  if (communityPhotoFiles.length + selected.length > 4) { showToast('Adicione no máximo 4 fotos.'); event.target.value = ''; return; }
  if (selected.some((file) => !['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024)) { showToast('Use fotos JPG, PNG ou WebP de até 5 MB cada.'); event.target.value = ''; return; }
  communityPhotoFiles.push(...selected); event.target.value = ''; renderCommunityPhotoPreviews();
});

document.getElementById('communityComposer').addEventListener('submit', async (event) => {
  event.preventDefault();
  const body = document.getElementById('communityPostBody').value.trim();
  const button = event.currentTarget.querySelector('button[type="submit"]');
  if (!body && !communityPhotoFiles.length) { showToast('Escreva uma mensagem ou adicione uma foto.'); return; }
  button.disabled = true;
  try {
    const media = await Promise.all(communityPhotoFiles.map((file) => new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve({ data: reader.result }); reader.onerror = reject; reader.readAsDataURL(file); })));
    if (!activeCommunityId) throw new Error('Escolha uma comunidade antes de publicar.');
    await api(`/communities/${activeCommunityId}/posts`, { method: 'POST', body: JSON.stringify({ body, media }) });
    event.currentTarget.reset(); communityPhotoFiles = []; communityCommentState.clear(); renderCommunityPhotoPreviews(); await loadSelectedCommunity(activeCommunityId); await refreshCampaign(); showToast('Publicação compartilhada com a comunidade.');
  } catch (error) { showToast(error.message); }
  finally { button.disabled = false; }
});

document.getElementById('socialInviteAction').addEventListener('click', () => {
  if (campaignData?.joined) {
    document.querySelector('.social-people-column').scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  if (!currentUser) {
    document.getElementById('accountButton').click();
    return;
  }
  setPage('Perfil');
  setProfileTab('join');
});

function challengeStatusLabel(status) {
  return status === 'upcoming' ? 'Em breve' : status === 'ended' ? 'Encerrado' : 'Em andamento';
}

function challengeParticipationLabel(challenge) {
  if (!challenge.accepted) return 'Convite recebido';
  if (challenge.status === 'ended') return Number(challenge.minutes) >= Number(challenge.goalMinutes) ? 'Concluído' : 'Encerrado';
  if (Number(challenge.minutes) >= Number(challenge.goalMinutes)) return 'Concluído';
  return 'Participando';
}

function formatChallengeDate(value) {
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short' }).format(new Date(value));
}

function renderParticipantChallenges(challenges = []) {
  const list = document.getElementById('participantChallengeList');
  const count = document.getElementById('participantChallengeCount');
  list.replaceChildren();
  count.textContent = `${challenges.length} desafio${challenges.length === 1 ? '' : 's'}`;
  if (!challenges.length) {
    const empty = document.createElement('p');
    empty.className = 'activity-empty';
    empty.textContent = campaignData?.joined ? 'Ainda não há desafios publicados pela administração.' : 'Entre na campanha para ver os desafios.';
    list.append(empty);
    return;
  }
  challenges.forEach((challenge) => {
    const minutes = Number(challenge.minutes || 0);
    const goal = Number(challenge.goalMinutes || 0);
    const progress = goal > 0 ? Math.min(100, minutes / goal * 100) : 0;
    const card = document.createElement('article');
    card.className = 'participant-challenge participant-challenge-featured';
    const content = document.createElement('div');
    content.className = 'participant-challenge-content';
    const heading = document.createElement('div');
    heading.className = 'participant-challenge-heading';
    const title = document.createElement('h3');
    title.textContent = challenge.title;
    const badge = document.createElement('span');
    badge.className = 'goal-badge';
    badge.textContent = challengeParticipationLabel(challenge);
    heading.append(title, badge);
    content.append(heading);
    if (challenge.description) {
      const description = document.createElement('p');
      description.textContent = challenge.description;
      content.append(description);
    }
    const goalLine = document.createElement('p');
    goalLine.className = 'participant-challenge-goal';
    goalLine.textContent = `🏅 Complete ${goal.toLocaleString('pt-BR')} minutos de atividade neste desafio.`;
    content.append(goalLine);
    const period = document.createElement('small');
    period.textContent = `${challenge.periodType === 'monthly' ? 'Mensal' : 'Semanal'} · ${formatChallengeDate(challenge.startsAt)} – ${formatChallengeDate(challenge.endsAt)}`;
    content.append(period);
    if (challenge.accepted) {
      const metrics = document.createElement('div');
      metrics.className = 'participant-challenge-metrics';
      const current = document.createElement('strong');
      current.textContent = `${minutes} min`;
      const target = document.createElement('span');
      target.textContent = `de ${goal} min · ${Number(challenge.activityCount || 0)} atividade${Number(challenge.activityCount || 0) === 1 ? '' : 's'}`;
      metrics.append(current, target);
      content.append(metrics);
      const bar = document.createElement('div');
      bar.className = 'bar participant-challenge-bar';
      const fill = document.createElement('i');
      fill.style.width = `${progress}%`;
      bar.append(fill);
      content.append(bar);
    } else {
      const explanation = document.createElement('p');
      explanation.className = 'challenge-invitation-copy';
      explanation.textContent = challenge.status === 'upcoming'
        ? 'Aceite agora para participar quando o desafio começar.'
        : 'Aceite este desafio para participar e acompanhar seu progresso.';
      content.append(explanation);
      const acceptButton = document.createElement('button');
      acceptButton.type = 'button';
      acceptButton.className = 'accept-challenge-button';
      acceptButton.textContent = 'Aceitar desafio';
      acceptButton.addEventListener('click', async () => {
        acceptButton.disabled = true;
        try {
          await api(`/challenges/${challenge.id}/accept`, { method: 'POST' });
          await loadAccountData();
          showToast(`Você aceitou o desafio “${challenge.title}”.`);
        } catch (error) {
          showToast(error.message);
          acceptButton.disabled = false;
        }
      });
      content.append(acceptButton);
    }
    if (challenge.rewardText) {
      const reward = document.createElement('p');
      reward.className = 'participant-challenge-reward';
      reward.textContent = `🎁 ${challenge.rewardText}`;
      content.append(reward);
    }
    const cover = document.createElement('div');
    cover.className = 'participant-challenge-cover';
    if (challenge.coverImage) {
      const image = document.createElement('img');
      image.src = challenge.coverImage;
      image.alt = `Capa do desafio ${challenge.title}`;
      image.loading = 'lazy';
      cover.append(image);
    } else {
      cover.classList.add('is-placeholder');
      const wordmark = document.createElement('strong');
      wordmark.textContent = 'VIP GO';
      cover.append(wordmark);
    }
    card.append(content, cover);
    list.append(card);
  });
}

function renderAdminChallenges(challenges = []) {
  const list = document.getElementById('adminChallengeList');
  list.replaceChildren();
  if (!challenges.length) {
    const empty = document.createElement('p');
    empty.className = 'activity-empty';
    empty.textContent = 'Ainda não há desafios publicados nesta campanha.';
    list.append(empty);
    return;
  }
  challenges.forEach((challenge) => {
    const row = document.createElement('div');
    row.className = 'admin-team-row';
    const copy = document.createElement('div');
    copy.className = 'admin-challenge-copy';
    if (challenge.coverImage) {
      const cover = document.createElement('img');
      cover.className = 'admin-challenge-thumb';
      cover.src = challenge.coverImage;
      cover.alt = '';
      copy.append(cover);
    }
    const title = document.createElement('strong');
    title.textContent = challenge.title;
    const detail = document.createElement('small');
    detail.textContent = `${challenge.periodType === 'monthly' ? 'Mensal' : 'Semanal'} · ${challenge.goalMinutes} min · ${formatChallengeDate(challenge.startsAt)} – ${formatChallengeDate(challenge.endsAt)}`;
    copy.append(title, detail);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'Excluir';
    remove.addEventListener('click', async () => {
      if (!window.confirm(`Excluir o desafio “${challenge.title}”?`)) return;
      try {
        await api(`/admin/challenges/${challenge.id}`, { method: 'DELETE' });
        await loadAccountData();
        showToast('Desafio excluído.');
      } catch (error) { showToast(error.message); }
    });
    row.append(copy, remove);
    list.append(row);
  });
}

function renderCampaign(data) {
  campaignData = data;
  const adminNav = document.getElementById('adminNav');
  const adminMobileNav = document.getElementById('adminMobileNav');
  const isAdmin = Boolean(data.isCampaignAdmin && data.admin);
  adminNav.hidden = !isAdmin;
  adminMobileNav.hidden = !isAdmin;
  if (!isAdmin && document.body.dataset.page === 'Admin') setPage('Início');
  document.body.dataset.admin = String(isAdmin);
  document.getElementById('joinCampaignTab').hidden = Boolean(data.joined || data.isCampaignAdmin);
  document.getElementById('createCampaignTab').hidden = Boolean(data.joined);
  if (!data.joined) {
    document.getElementById('campaignStatus').textContent = 'AGUARDANDO CÓDIGO';
    document.getElementById('campaignDescription').textContent = 'Use o código da sua empresa para entrar e participar.';
    document.getElementById('campaignCodeHint').textContent = 'Convide sua equipe com o código fornecido pela empresa.';
    document.getElementById('campaignReward').hidden = true;
    document.getElementById('leaderList').innerHTML = '<p class="activity-empty">Entre na campanha para ver o ranking.</p>';
    document.getElementById('teamRanking').innerHTML = '<p class="activity-empty">Entre na campanha para ver as equipes.</p>';
    document.getElementById('campaignCompanyName').textContent = 'Sem campanha';
    document.getElementById('createCampaignPanel').hidden = false;
    document.getElementById('weeklyGoalMinutes').textContent = '0 min';
    document.getElementById('weeklyGoalTarget').textContent = 'de 0 min';
    document.getElementById('weeklyGoalBadge').textContent = '0%';
    document.getElementById('weeklyGoalProgress').style.width = '0%';
    document.getElementById('sidebarGoalProgress').style.width = '0%';
    document.getElementById('weeklyGoalRemaining').textContent = 'Entre em uma campanha para participar';
    renderWeeklyActivityChart(readActivities());
    renderBadges([]);
    renderActivityFeed([]);
    renderParticipantChallenges([]);
    renderSocialHome({ joined: false, user: data.user || currentUser });
    return;
  }
  const { campaign, user } = data;
  const goal = campaign.weeklyGoalMinutes;
  const periodMinutes = data.periodMinutes;
  const progress = Math.min(100, periodMinutes / goal * 100);
  document.getElementById('createCampaignPanel').hidden = false;
  document.getElementById('campaignStatus').textContent = 'PARTICIPANDO';
  document.getElementById('campaignTitle').textContent = campaign.name;
  document.getElementById('campaignDescription').textContent = `${user.companyName} · sua equipe participa da campanha.`;
  const reward = document.getElementById('campaignReward');
  reward.textContent = `🎁 Reconhecimento: ${campaign.rewardText}`;
  reward.hidden = false;
  document.getElementById('campaignCodeHint').textContent = `Empresa: ${user.companyName}`;
  document.getElementById('campaignCompanyName').textContent = user.companyName;
  document.getElementById('weeklyGoalDescription').textContent = campaign.periodType === 'monthly' ? 'Minutos ativos neste mês' : 'Minutos ativos nesta semana';
  document.getElementById('rankingSubtitle').textContent = campaign.periodType === 'monthly' ? 'Minutos ativos neste mês' : 'Minutos ativos nesta semana';
  document.getElementById('weeklyGoalMinutes').textContent = `${periodMinutes} min`;
  document.getElementById('weeklyGoalTarget').textContent = `de ${goal} min`;
  document.getElementById('weeklyGoalBadge').textContent = `${Math.round(progress)}%`;
  document.getElementById('weeklyGoalProgress').style.width = `${progress}%`;
  document.getElementById('sidebarGoalProgress').style.width = `${progress}%`;
  document.getElementById('weeklyGoalRemaining').textContent = periodMinutes >= goal ? 'Meta do período concluída! 🎉' : `Faltam ${goal - periodMinutes} minutos`;
  renderWeeklyActivityChart(readActivities());
  document.getElementById('currentTeamName').textContent = user.teamName || 'Sem equipe';
  document.getElementById('sidebarTeam').textContent = user.teamName || user.companyName;
  document.getElementById('showInRanking').checked = Boolean(user.showInRanking);
  document.getElementById('shareActivities').checked = Boolean(user.shareActivities);
  document.getElementById('shareProfilePhoto').checked = Boolean(user.shareProfilePhoto);
  const profilePhotoUrl = user.profilePhoto ? `/api/profile-photos/${user.profilePhoto}` : null;
  setAvatar(document.getElementById('profilePhotoPreview'), user.name, profilePhotoUrl);
  document.querySelectorAll('.profile-mini .avatar').forEach((node) => setAvatar(node, user.name, profilePhotoUrl));
  setAvatar(document.getElementById('accountButton'), user.name, profilePhotoUrl);
  const teamSelect = document.getElementById('teamSelect');
  teamSelect.replaceChildren(new Option('Sem equipe', ''));
  data.teams.forEach((team) => teamSelect.add(new Option(team.name, team.id)));
  if (user.teamId) teamSelect.value = String(user.teamId);
  renderRanking(data.individualRanking, 'leaderList');
  renderRanking(data.teamRanking, 'teamRanking', true);
  renderBadges(data.badges);
  renderActivityFeed(data.activityFeed || []);
  renderParticipantChallenges(data.challenges || []);
  renderSocialHome(data);
  if (isAdmin) {
    document.getElementById('adminCampaignName').textContent = campaign.name;
    document.getElementById('adminInviteCode').textContent = data.admin.joinCode;
    document.getElementById('adminParticipantCount').textContent = data.admin.summary.participantCount || 0;
    document.getElementById('adminVisibleCount').textContent = data.admin.summary.visibleParticipantCount || 0;
    document.getElementById('adminTeamCount').textContent = data.admin.summary.teamCount || 0;
    document.getElementById('adminName').value = campaign.name;
    document.getElementById('adminGoal').value = campaign.weeklyGoalMinutes;
    document.getElementById('adminReward').value = campaign.rewardText;
    document.getElementById('adminPeriod').value = campaign.periodType;
    document.getElementById('adminCreateAdminForm').hidden = !data.admin.canManageAdmins;
    document.getElementById('adminAdminsReadOnly').hidden = data.admin.canManageAdmins;
    renderAdminTeams(data.admin.teams);
    renderAdminChallenges(data.admin.challenges || []);
    renderAdminAdmins(data.admin.admins || []);
  }
}

function renderAdminAdmins(admins = []) {
  const list = document.getElementById('adminAdminsList');
  list.replaceChildren();
  document.getElementById('adminAdminCount').textContent = String(admins.length);
  if (!admins.length) {
    const empty = document.createElement('p');
    empty.className = 'activity-empty';
    empty.textContent = 'Nenhum administrador cadastrado.';
    list.append(empty);
    return;
  }
  admins.forEach((admin) => {
    const row = document.createElement('div');
    row.className = 'admin-team-row';
    const entry = document.createElement('div');
    entry.className = 'admin-admin-entry';
    const copy = document.createElement('div');
    copy.className = 'admin-admin-entry-copy';
    const name = document.createElement('strong');
    name.textContent = admin.name;
    const email = document.createElement('span');
    email.textContent = admin.email;
    copy.append(name, email);
    entry.append(copy);
    row.append(entry);
    if (admin.isPrimary) {
      const badge = document.createElement('span');
      badge.className = 'admin-primary-badge';
      badge.textContent = 'Principal';
      row.append(badge);
    }
    list.append(row);
  });
}

let adminParticipants = [];
let adminParticipantTeams = [];

function renderAdminParticipants(query = '') {
  const list = document.getElementById('adminParticipantsList');
  if (!list) return;
  const normalized = query.trim().toLocaleLowerCase('pt-BR');
  const participants = adminParticipants.filter((person) => `${person.name} ${person.email}`.toLocaleLowerCase('pt-BR').includes(normalized));
  document.getElementById('adminParticipantsCount').textContent = String(adminParticipants.length);
  list.replaceChildren();
  if (!participants.length) {
    const empty = document.createElement('p');
    empty.className = 'activity-empty';
    empty.textContent = adminParticipants.length ? 'Nenhuma conta corresponde à busca.' : 'Ainda não há contas cadastradas.';
    list.append(empty);
    return;
  }

  participants.forEach((person) => {
    const row = document.createElement('article');
    row.className = 'admin-participant-row';
    row.dataset.participantId = String(person.id);
    const details = document.createElement('div');
    details.className = 'admin-participant-details';
    const name = document.createElement('strong');
    name.textContent = person.name;
    const email = document.createElement('span');
    email.textContent = person.email;
    const meta = document.createElement('small');
    const joinedDate = new Date(`${person.createdAt}Z`);
    meta.textContent = `Cadastro: ${Number.isNaN(joinedDate.getTime()) ? 'data indisponível' : joinedDate.toLocaleDateString('pt-BR')} · Grupo: ${person.companyName || 'Sem grupo'} · ${person.isAdmin ? 'Administrador' : 'Participante'} · ${person.showInRanking ? 'No ranking' : 'Fora do ranking'}`;
    details.append(name, email, meta);
    const form = document.createElement('form');
    form.className = 'admin-participant-edit premium-form';
    form.dataset.participantId = String(person.id);
    const nameLabel = document.createElement('label');
    nameLabel.textContent = 'Nome';
    const nameInput = document.createElement('input');
    nameInput.name = 'name'; nameInput.required = true; nameInput.minLength = 2; nameInput.maxLength = 60; nameInput.value = person.name;
    nameLabel.append(nameInput);
    const emailLabel = document.createElement('label');
    emailLabel.textContent = 'E-mail';
    const emailInput = document.createElement('input');
    emailInput.name = 'email'; emailInput.type = 'email'; emailInput.required = true; emailInput.maxLength = 254; emailInput.value = person.email;
    emailLabel.append(emailInput);
    const teamLabel = document.createElement('label');
    teamLabel.textContent = 'Equipe';
    const teamSelect = document.createElement('select');
    teamSelect.name = 'teamId';
    teamSelect.add(new Option('Sem equipe', ''));
    adminParticipantTeams.filter((team) => person.companyId && Number(team.companyId) === Number(person.companyId)).forEach((team) => teamSelect.add(new Option(team.name, team.id)));
    teamSelect.value = person.teamId ? String(person.teamId) : '';
    teamLabel.append(teamSelect);
    const save = document.createElement('button');
    save.className = 'create-goal'; save.type = 'submit'; save.textContent = 'Salvar';
    form.append(nameLabel, emailLabel, teamLabel, save);
    row.append(details, form);
    list.append(row);
  });
}

async function loadAdminParticipants() {
  const list = document.getElementById('adminParticipantsList');
  if (!list) return;
  list.innerHTML = '<p class="activity-empty">Carregando contas…</p>';
  try {
    const result = await api('/admin/participants');
    adminParticipants = result.participants || [];
    adminParticipantTeams = result.teams || [];
    renderAdminParticipants(document.getElementById('adminParticipantsSearch').value);
  } catch (error) {
    list.innerHTML = '';
    const message = document.createElement('p'); message.className = 'activity-empty'; message.textContent = error.message; list.append(message);
  }
}

function renderAdminTeams(teams = []) {
  const list = document.getElementById('adminTeamList');
  list.replaceChildren();
  if (!teams.length) {
    const empty = document.createElement('p');
    empty.className = 'activity-empty';
    empty.textContent = 'Ainda não há equipes nesta campanha.';
    list.append(empty);
    return;
  }
  teams.forEach((team) => {
    const row = document.createElement('div');
    row.className = 'admin-team-row';
    const name = document.createElement('span');
    name.textContent = team.name;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'Remover equipe';
    remove.addEventListener('click', async () => {
      if (!window.confirm(`Remover a equipe “${team.name}”? Os colaboradores voltam para “Sem equipe”.`)) return;
      try {
        await api(`/teams/${team.id}`, { method: 'DELETE' });
        await loadAccountData();
        showToast('Equipe removida.');
      } catch (error) { showToast(error.message); }
    });
    row.append(name, remove);
    list.append(row);
  });
}

async function refreshCampaign() {
  if (!currentUser) return;
  renderCampaign(await api('/campaign'));
}

function showUser(user) {
  currentUser = user;
  const button = document.getElementById('accountButton');
  if (!user) {
    activeCommunityId = null;
    document.getElementById('communitySelectedCard').hidden = false;
    document.getElementById('communityConversation').hidden = true;
    document.getElementById('communityDirectoryList').innerHTML = '<p class="activity-empty">Entre na sua conta para encontrar comunidades.</p>';
    setAvatar(button, 'Entrar', null);
    button.textContent = 'Entrar';
    button.setAttribute('aria-label', 'Entrar ou criar conta');
    document.getElementById('welcomeName').textContent = 'pessoa';
    document.querySelectorAll('.profile-mini .avatar').forEach((node) => setAvatar(node, '?', null));
    document.querySelectorAll('.profile-mini strong').forEach((node) => { node.textContent = 'Participante'; });
    document.querySelectorAll('.profile-mini small').forEach((node) => { node.textContent = 'Entre ou crie uma conta'; });
    document.getElementById('campaignStatus').textContent = 'ENTRE NA CAMPANHA';
    document.getElementById('createCampaignPanel').hidden = false;
    return;
  }
  const initials = user.name.split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
  setAvatar(button, user.name, user.profilePhoto ? `/api/profile-photos/${user.profilePhoto}` : null);
  button.title = `${user.name} · clique para sair`;
  button.setAttribute('aria-label', `${user.name}. Clique para sair da conta.`);
  document.getElementById('welcomeName').textContent = user.name.split(' ')[0];
  document.querySelectorAll('.profile-mini strong').forEach((node) => { node.textContent = user.name; });
  document.querySelectorAll('.profile-mini .avatar').forEach((node) => setAvatar(node, user.name, user.profilePhoto ? `/api/profile-photos/${user.profilePhoto}` : null));
  setAvatar(document.getElementById('profilePhotoPreview'), user.name, user.profilePhoto ? `/api/profile-photos/${user.profilePhoto}` : null);
  document.getElementById('shareProfilePhoto').checked = Boolean(user.shareProfilePhoto);
}

async function loadAccountData() {
  const { activities } = await api('/activities');
  saveActivities(activities);
  renderActivities();
  await refreshCampaign();
  if (!document.getElementById('mapView').hidden) await mapsController.refresh();
}

function setPage(page) {
  document.body.dataset.page = page;
  document.querySelectorAll('button[data-page]').forEach((item) => item.classList.toggle('active', item.dataset.page === page));
  document.querySelector('.crumb b').textContent = page;
  document.querySelector('.welcome').hidden = page !== 'Início';
  document.querySelector('.stats').hidden = page !== 'Início';
  document.getElementById('socialHome').hidden = page !== 'Início';
  document.getElementById('communityView').hidden = page !== 'Comunidade';
  document.getElementById('calendarView').hidden = page !== 'Calendário';
  document.querySelector('.content-grid').dataset.page = page;
  document.querySelectorAll('[data-section]').forEach((section) => {
    section.hidden = page === 'Atividades' ? section.dataset.section !== 'Atividades'
      : page === 'Desafios' ? section.dataset.section !== 'Desafios' : page === 'Perfil' || page === 'Admin' || page === 'Mapas' || page === 'Comunidade' || page === 'Calendário';
  });
  document.querySelector('.content-grid').hidden = page === 'Perfil' || page === 'Admin' || page === 'Mapas' || page === 'Comunidade' || page === 'Calendário';
  const showActivityMap = page === 'Atividades' && mapsController?.isActivityVisible();
  document.getElementById('mapView').hidden = page !== 'Mapas' && !showActivityMap;
  document.getElementById('mapView').classList.toggle('map-view--inline', Boolean(showActivityMap));
  document.getElementById('profileView').hidden = page !== 'Perfil';
  document.getElementById('adminView').hidden = page !== 'Admin';
  if (page === 'Comunidade') loadCommunityDirectory(document.getElementById('communitySearch').value.trim());
  if (page === 'Perfil') setProfileTab('account');
  if (page === 'Admin') setAdminTab('overview');
  if (page === 'Mapas' || showActivityMap) mapsController.open();
  if (page === 'Calendário') renderCalendar();
}

// Start on the community home with every route-specific section synchronized.
mapsController = createMapsController({
  api, readActivities, loadAccountData, showToast, getUser: () => currentUser,
  showLogin: () => document.getElementById('accountButton').click(),
  onActivityStateChange: () => {
    if (document.body.dataset.page !== 'Atividades') return;
    const show = mapsController?.isActivityVisible();
    const mapView = document.getElementById('mapView');
    mapView.hidden = !show;
    mapView.classList.toggle('map-view--inline', Boolean(show));
    if (show) mapsController.open();
  },
});
setPage('Início');

function setProfileTab(name) {
  document.querySelectorAll('[data-profile-tab]').forEach((tab) => {
    const active = tab.dataset.profileTab === name;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  });
  document.querySelectorAll('[data-profile-panel]').forEach((panel) => {
    panel.hidden = panel.dataset.profilePanel !== name;
  });
}

function setAdminTab(name) {
  document.querySelectorAll('[data-admin-tab]').forEach((tab) => {
    const active = tab.dataset.adminTab === name;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  });
  document.querySelectorAll('[data-admin-panel]').forEach((panel) => {
    panel.hidden = panel.dataset.adminPanel !== name;
  });
}

document.querySelectorAll('[data-profile-tab]').forEach((tab) => tab.addEventListener('click', () => setProfileTab(tab.dataset.profileTab)));
document.querySelectorAll('[data-admin-tab]').forEach((tab) => tab.addEventListener('click', () => setAdminTab(tab.dataset.adminTab)));
document.querySelector('[data-admin-tab="participants"]').addEventListener('click', loadAdminParticipants);
document.getElementById('adminParticipantsSearch').addEventListener('input', (event) => renderAdminParticipants(event.currentTarget.value));
document.getElementById('adminParticipantsList').addEventListener('submit', async (event) => {
  if (!event.target.matches('.admin-participant-edit')) return;
  event.preventDefault();
  const form = event.target;
  const button = form.querySelector('button[type="submit"]');
  const error = document.getElementById('adminParticipantEditError');
  const fields = new FormData(form);
  error.hidden = true;
  button.disabled = true;
  try {
    const result = await api(`/admin/participants/${form.dataset.participantId}`, { method: 'PUT', body: JSON.stringify({
      name: fields.get('name'), email: fields.get('email'), teamId: fields.get('teamId') || null,
    }) });
    adminParticipants = result.participants || [];
    renderAdminParticipants(document.getElementById('adminParticipantsSearch').value);
    showToast('Cadastro do participante atualizado.');
  } catch (requestError) {
    error.textContent = requestError.message;
    error.hidden = false;
    button.disabled = false;
  }
});
document.getElementById('openAdminChallenges').addEventListener('click', () => {
  setAdminTab('challenges');
  document.getElementById('challengeTitleInput').focus();
});

document.querySelectorAll('button[data-page]').forEach((button) => button.addEventListener('click', () => setPage(button.dataset.page)));
document.getElementById('calendarPrevMonth').addEventListener('click', () => {
  calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1, 1);
  renderCalendar();
});
document.getElementById('calendarNextMonth').addEventListener('click', () => {
  calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1);
  renderCalendar();
});
document.getElementById('calendarToday').addEventListener('click', () => {
  selectedCalendarDate = new Date();
  selectedCalendarDate.setHours(0, 0, 0, 0);
  calendarMonth = new Date(selectedCalendarDate.getFullYear(), selectedCalendarDate.getMonth(), 1);
  renderCalendar();
});
document.getElementById('calendarAddActivity').addEventListener('click', () => openActivityForm());
document.getElementById('openCommunity').addEventListener('click', () => setPage('Comunidade'));
document.getElementById('communityCarouselPrev').addEventListener('click', () => document.getElementById('communityCarouselTrack').scrollBy({ left: -320, behavior: 'smooth' }));
document.getElementById('communityCarouselNext').addEventListener('click', () => document.getElementById('communityCarouselTrack').scrollBy({ left: 320, behavior: 'smooth' }));
const communityCarouselTrack = document.getElementById('communityCarouselTrack');
let carouselDragStart = null;
communityCarouselTrack.addEventListener('pointerdown', (event) => {
  if (event.pointerType === 'mouse' && event.button === 0) {
    carouselDragStart = { x: event.clientX, scrollLeft: communityCarouselTrack.scrollLeft };
    communityCarouselTrack.classList.add('is-dragging');
    communityCarouselTrack.setPointerCapture(event.pointerId);
  }
});
communityCarouselTrack.addEventListener('pointermove', (event) => {
  if (carouselDragStart) communityCarouselTrack.scrollLeft = carouselDragStart.scrollLeft - (event.clientX - carouselDragStart.x);
});
const finishCarouselDrag = () => {
  carouselDragStart = null;
  communityCarouselTrack.classList.remove('is-dragging');
};
communityCarouselTrack.addEventListener('pointerup', finishCarouselDrag);
communityCarouselTrack.addEventListener('pointercancel', finishCarouselDrag);
communityCarouselTrack.addEventListener('lostpointercapture', finishCarouselDrag);
renderActivities();
renderBadges([]);
renderCampaign({ joined: false });

document.getElementById('accountButton').addEventListener('click', async () => {
  if (!currentUser) { window.location.href = '/login.html'; return; }
  try {
    await api('/auth/logout', { method: 'POST' });
    window.location.replace('/login.html');
  } catch (error) { showToast(error.message); }
});

const activityDialog = document.getElementById('activityDialog');
const activityForm = document.getElementById('activityForm');
function updateActivityFields() {
  const activityType = activityForm.elements.activityType.value;
  const needsGps = gpsActivityTypes.has(activityType);
  document.querySelector('.activity-distance-field').hidden = !distanceActivityTypes.has(activityType);
  document.querySelector('.activity-map-preview').hidden = Boolean(editingActivityId) || !needsGps;
  document.getElementById('activityIndoorStart').hidden = Boolean(editingActivityId) || needsGps;
  const start = new Date(activityForm.elements.startedAt.value);
  const end = new Date(activityForm.elements.endedAt.value);
  const summary = document.getElementById('manualDurationSummary');
  if (!activityForm.elements.startedAt.value || !activityForm.elements.endedAt.value || !Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) {
    summary.textContent = 'Informe um término posterior ao início.';
    summary.dataset.valid = 'false';
    return 0;
  }
  const seconds = Math.floor((end - start) / 1000);
  if (seconds > 48 * 60 * 60) {
    summary.textContent = 'A duração máxima permitida é de 48 horas.';
    summary.dataset.valid = 'false';
    return 0;
  }
  summary.textContent = `Duração total: ${formatDuration(seconds)}.`;
  summary.dataset.valid = 'true';
  return seconds;
}
activityForm.elements.activityType.addEventListener('change', () => {
  updateActivityFields();
  if (!document.querySelector('.activity-map-preview').hidden) mapsController.openActivityPreview();
});
activityForm.elements.startedAt.addEventListener('input', updateActivityFields);
activityForm.elements.endedAt.addEventListener('input', updateActivityFields);
function openActivityForm() {
  if (!currentUser) { window.location.href = '/login.html'; return; }
  editingActivityId = null;
  activityForm.reset();
  clearActivityMedia();
  document.getElementById('activityDialogTitle').textContent = 'Adicionar atividade';
  document.querySelector('#activityDialog .auth-description').textContent = 'Escolha o tipo de atividade. Você pode iniciar o GPS quando chegar ao ponto de partida ou preencher os dados manualmente.';
  document.querySelector('.activity-map-preview').hidden = false;
  document.getElementById('activityIndoorStart').hidden = false;
  document.querySelector('.activity-media-field').hidden = false;
  activityExistingMedia = [];
  document.getElementById('activityExistingMediaNote').hidden = true;
  document.getElementById('activityEditPreservation').hidden = true;
  document.getElementById('activityStartTimer').hidden = false;
  document.querySelector('#activityForm button[type="submit"]').textContent = 'Salvar atividade';
  document.getElementById('activityError').hidden = true;
  const now = new Date();
  const localInput = (date) => new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  activityForm.elements.startedAt.value = localInput(new Date(now.getTime() - 30 * 60000));
  activityForm.elements.endedAt.value = localInput(now);
  updateActivityFields();
  activityDialog.showModal();
  if (!document.querySelector('.activity-map-preview').hidden) mapsController.openActivityPreview();
}
function openActivityEdit(activity) {
  if (!currentUser) { showToast('Entre na sua conta para editar uma atividade.'); return; }
  const localInput = (date) => new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const startedAt = new Date(activity.startedAt);
  const endedAt = new Date(startedAt.getTime() + activity.durationSeconds * 1000);
  editingActivityId = activity.id;
  activityForm.reset();
  clearActivityMedia();
  activityForm.elements.activityType.value = activity.activityType || activity.mode;
  activityForm.elements.startedAt.value = localInput(startedAt);
  activityForm.elements.endedAt.value = localInput(endedAt);
  activityForm.elements.distanceKm.value = activity.distanceKm || '';
  document.getElementById('activityDialogTitle').textContent = 'Editar atividade';
  document.querySelector('#activityDialog .auth-description').textContent = 'Ajuste o tipo, os horários ou a distância. Os dados gravados do percurso e as mídias serão mantidos.';
  document.querySelector('.activity-map-preview').hidden = true;
  document.getElementById('activityIndoorStart').hidden = true;
  document.querySelector('.activity-media-field').hidden = false;
  activityExistingMedia = Array.isArray(activity.media) ? activity.media : [];
  const existingMediaNote = document.getElementById('activityExistingMediaNote');
  existingMediaNote.hidden = !activityExistingMedia.length;
  existingMediaNote.textContent = activityExistingMedia.length ? `${activityExistingMedia.length} arquivo${activityExistingMedia.length === 1 ? '' : 's'} já anexado${activityExistingMedia.length === 1 ? '' : 's'}. Os novos arquivos serão adicionados.` : 'Adicione fotos ou vídeos a esta atividade.';
  renderActivityMedia();
  document.getElementById('activityEditPreservation').hidden = false;
  document.getElementById('activityShareToggle').checked = Boolean(currentUser?.shareActivities);
  document.getElementById('activityStartTimer').hidden = true;
  document.querySelector('#activityForm button[type="submit"]').textContent = 'Salvar alterações';
  document.getElementById('activityError').hidden = true;
  updateActivityFields();
  activityDialog.showModal();
}
document.getElementById('openActivity').addEventListener('click', openActivityForm);
document.getElementById('historyRegister').addEventListener('click', openActivityForm);
document.getElementById('activityClose').addEventListener('click', () => activityDialog.close());
document.getElementById('activityCancel').addEventListener('click', () => activityDialog.close());
document.getElementById('activityStartTimer').addEventListener('click', () => {
  const mode = activityForm.elements.activityType.value;
  if (activityMediaFiles.length) mapsController.queueMediaFiles(activityMediaFiles);
  activityDialog.close();
  setPage('Mapas');
  mapsController.start(mode, { trackLocation: false });
});
activityDialog.addEventListener('click', (event) => { if (event.target === activityDialog) activityDialog.close(); });
const activityMediaInput = document.getElementById('activityMediaInput');
const activityMediaDropzone = document.getElementById('activityMediaDropzone');
const activityMediaPreviews = document.getElementById('activityMediaPreviews');
const activityMediaStatus = document.getElementById('activityMediaStatus');
const activityMediaCount = document.getElementById('activityMediaCount');
let activityMediaObjectUrls = [];
let activityMediaFiles = [];
let activityExistingMedia = [];
function setActivityMediaStatus(message, isError = false) {
  activityMediaStatus.textContent = message;
  activityMediaStatus.classList.toggle('is-error', isError);
}
function renderActivityMedia() {
  activityMediaObjectUrls.forEach((url) => URL.revokeObjectURL(url));
  activityMediaObjectUrls = [];
  activityMediaPreviews.replaceChildren();
  const files = activityMediaFiles;
  activityMediaCount.textContent = `${activityExistingMedia.length + files.length} de 4`;
  files.forEach((file, index) => {
    const url = URL.createObjectURL(file);
    activityMediaObjectUrls.push(url);
    const item = document.createElement('article');
    item.className = 'activity-media-item';
    const preview = file.type.startsWith('video/') ? document.createElement('video') : document.createElement('img');
    preview.className = 'activity-media-thumb';
    preview.src = url;
    preview.setAttribute('aria-label', file.name);
    if (preview instanceof HTMLVideoElement) { preview.muted = true; preview.playsInline = true; preview.preload = 'metadata'; }
    const meta = document.createElement('div');
    meta.className = 'activity-media-meta';
    const name = document.createElement('strong');
    name.textContent = file.name;
    name.title = file.name;
    const details = document.createElement('small');
    details.textContent = `${file.type.startsWith('video/') ? 'Vídeo' : 'Foto'} · ${(file.size / (1024 * 1024)).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MB`;
    meta.append(name, details);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'activity-media-remove';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `Remover ${file.name}`);
    remove.addEventListener('click', () => {
      activityMediaFiles = activityMediaFiles.filter((selected, selectedIndex) => selectedIndex !== index);
      const transfer = new DataTransfer();
      activityMediaFiles.forEach((selected) => transfer.items.add(selected));
      activityMediaInput.files = transfer.files;
      renderActivityMedia();
      setActivityMediaStatus(activityMediaInput.files.length ? 'Arquivo removido. Você pode adicionar outros arquivos.' : 'Fotos e vídeos só serão exibidos conforme suas opções de privacidade.');
    });
    item.append(preview, meta, remove);
    activityMediaPreviews.append(item);
  });
}
function acceptActivityMedia(files) {
  const incoming = [...files];
  const selected = editingActivityId ? [...activityMediaFiles, ...incoming] : incoming;
  if (activityExistingMedia.length + selected.length > 4) { setActivityMediaStatus(`Esta atividade aceita até quatro arquivos. Você pode adicionar mais ${Math.max(0, 4 - activityExistingMedia.length)}.`, true); }
  else if (selected.some((file) => !file.type.startsWith('image/') && !file.type.startsWith('video/'))) { setActivityMediaStatus('Escolha somente fotos ou vídeos.', true); }
  else if (selected.some((file) => file.size > 12 * 1024 * 1024)) { setActivityMediaStatus('Cada arquivo pode ter no máximo 12 MB.', true); }
  else {
    activityMediaFiles = selected;
    renderActivityMedia();
    setActivityMediaStatus(selected.length ? `${selected.length} arquivo${selected.length === 1 ? '' : 's'} pronto${selected.length === 1 ? '' : 's'} para anexar. Visibilidade conforme suas opções de privacidade.` : 'Fotos e vídeos só serão exibidos conforme suas opções de privacidade.');
  }
  const transfer = new DataTransfer();
  activityMediaFiles.forEach((file) => transfer.items.add(file));
  activityMediaInput.files = transfer.files;
}
function clearActivityMedia() {
  activityMediaFiles = [];
  activityExistingMedia = [];
  activityMediaInput.value = '';
  activityMediaInput.files = new DataTransfer().files;
  renderActivityMedia();
  setActivityMediaStatus('Fotos e vídeos só serão exibidos conforme suas opções de privacidade.');
}
activityMediaInput.addEventListener('change', () => {
  const selected = [...activityMediaInput.files];
  activityMediaInput.value = '';
  acceptActivityMedia(selected);
});
activityMediaDropzone.addEventListener('dragover', (event) => { event.preventDefault(); activityMediaDropzone.classList.add('is-dragging'); });
activityMediaDropzone.addEventListener('dragleave', (event) => { if (!activityMediaDropzone.contains(event.relatedTarget)) activityMediaDropzone.classList.remove('is-dragging'); });
activityMediaDropzone.addEventListener('drop', (event) => { event.preventDefault(); activityMediaDropzone.classList.remove('is-dragging'); acceptActivityMedia(event.dataTransfer.files); });
activityForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const errorNode = document.getElementById('activityError');
  const fields = new FormData(activityForm);
  const durationSeconds = updateActivityFields();
  if (!durationSeconds) { errorNode.textContent = 'Corrija o horário de início e de término.'; errorNode.hidden = false; return; }
  if (editingActivityId) {
    const activityType = fields.get('activityType');
    const changes = {
      mode: baseActivityMode(activityType),
      activityType,
      startedAt: new Date(fields.get('startedAt')).toISOString(),
      durationSeconds,
      distanceKm: distanceActivityTypes.has(activityType) ? Number(fields.get('distanceKm') || 0) : 0,
    };
    try {
      const newMedia = await Promise.all(activityMediaFiles.map((file) => new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve({ name: file.name, data: reader.result });
        reader.onerror = reject;
        reader.readAsDataURL(file);
      })));
      if (newMedia.length) changes.media = newMedia;
      if (document.getElementById('activityShareToggle').checked !== Boolean(currentUser?.shareActivities)) {
        const { user } = await api('/privacy', { method: 'PUT', body: JSON.stringify({
          showInRanking: Boolean(currentUser?.showInRanking),
          shareActivities: document.getElementById('activityShareToggle').checked,
          shareProfilePhoto: Boolean(currentUser?.shareProfilePhoto),
        }) });
        showUser(user);
      }
      await api(`/activities/${encodeURIComponent(editingActivityId)}`, { method: 'PUT', body: JSON.stringify(changes) });
      editingActivityId = null;
      activityDialog.close();
      activityForm.reset();
      clearActivityMedia();
      await loadAccountData();
      showToast(newMedia.length ? 'Atividade atualizada com as novas fotos ou vídeos.' : 'Alterações salvas. Percurso e mídias preservados.');
    } catch (error) { errorNode.textContent = error.message; errorNode.hidden = false; }
    return;
  }
  const mediaFiles = [...activityMediaInput.files];
  if (mediaFiles.length > 4) { errorNode.textContent = 'Escolha até quatro arquivos.'; errorNode.hidden = false; return; }
  if (mediaFiles.some((file) => file.size > 12 * 1024 * 1024)) { errorNode.textContent = 'Cada foto ou vídeo deve ter no máximo 12 MB.'; errorNode.hidden = false; return; }
  const activity = {
    id: crypto.randomUUID(),
    mode: baseActivityMode(fields.get('activityType')),
    activityType: fields.get('activityType'),
    startedAt: new Date(fields.get('startedAt')).toISOString(),
    durationSeconds,
    distanceKm: distanceActivityTypes.has(fields.get('activityType')) ? Number(fields.get('distanceKm') || 0) : 0,
    route: [],
    media: await Promise.all(mediaFiles.map((file) => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve({ name: file.name, data: reader.result });
      reader.onerror = reject;
      reader.readAsDataURL(file);
    }))),
  };
  try {
    await api('/activities', { method: 'POST', body: JSON.stringify(activity) });
    activityDialog.close();
    activityForm.reset();
    clearActivityMedia();
    await loadAccountData();
    showToast('Atividade salva na campanha.');
  } catch (error) { errorNode.textContent = error.message; errorNode.hidden = false; }
});

async function joinCampaign() {
  const codeInput = document.getElementById('campaignCode');
  try {
    const { user } = await api('/campaign/join', { method: 'POST', body: JSON.stringify({ code: codeInput.value }) });
    showUser(user);
    await refreshCampaign();
    showToast(`Você entrou na campanha ${user.companyName}.`);
  } catch (error) { showToast(error.message); }
}
document.getElementById('joinCampaignButton').addEventListener('click', joinCampaign);
document.getElementById('joinCampaignShortcut').addEventListener('click', () => { setPage('Perfil'); setProfileTab('join'); document.getElementById('campaignCode').focus(); });
document.getElementById('createCampaignButton').addEventListener('click', async () => {
  const companyName = document.getElementById('newCompanyName').value;
  const campaignName = document.getElementById('newCampaignName').value;
  const weeklyGoalMinutes = Number(document.getElementById('newCampaignGoal').value);
  const rewardText = document.getElementById('newCampaignReward').value;
  const periodType = document.getElementById('newCampaignPeriod').value;
  const result = document.getElementById('createdCampaignCode');
  try {
    const response = await api('/companies', { method: 'POST', body: JSON.stringify({ companyName, campaignName, weeklyGoalMinutes, rewardText, periodType }) });
    showUser(response.user);
    await refreshCampaign();
    setPage('Admin');
    showToast(`Campanha criada. Código ${response.code}; copie-o na aba Resumo para compartilhar.`);
  } catch (error) { showToast(error.message); }
});

document.getElementById('savePrivacy').addEventListener('click', async () => {
  try {
    const { user } = await api('/privacy', { method: 'PUT', body: JSON.stringify({
      showInRanking: document.getElementById('showInRanking').checked,
      shareActivities: document.getElementById('shareActivities').checked,
      shareProfilePhoto: document.getElementById('shareProfilePhoto').checked,
    }) });
    showUser(user);
    await refreshCampaign();
    showToast('Preferências de privacidade salvas.');
  } catch (error) { showToast(error.message); }
});

document.getElementById('saveProfilePhoto').addEventListener('click', async () => {
  const file = document.getElementById('profilePhotoInput').files[0];
  if (!file) { showToast('Escolha uma foto para enviar.'); return; }
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) {
    showToast('Escolha uma foto JPG, PNG ou WebP de até 5 MB.');
    return;
  }
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const { user } = await api('/profile/photo', { method: 'PUT', body: JSON.stringify({ data: reader.result }) });
      showUser(user);
      await refreshCampaign();
      document.getElementById('profilePhotoInput').value = '';
      showToast('Foto de perfil salva e atualizada.');
    } catch (error) { showToast(error.message); }
  };
  reader.onerror = () => showToast('Não foi possível ler essa foto.');
  reader.readAsDataURL(file);
});

document.getElementById('profilePhotoInput').addEventListener('change', (event) => {
  const file = event.target.files[0];
  if (!file) return;
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) {
    showToast('Escolha uma foto JPG, PNG ou WebP de até 5 MB.');
    event.target.value = '';
    return;
  }
  const url = URL.createObjectURL(file);
  setAvatar(document.getElementById('profilePhotoPreview'), currentUser?.name, url);
});

document.getElementById('joinTeamButton').addEventListener('click', async () => {
  const teamId = document.getElementById('teamSelect').value;
  if (!teamId) { showToast('Escolha uma equipe.'); return; }
  try {
    const { user } = await api('/teams/join', { method: 'POST', body: JSON.stringify({ teamId }) });
    showUser(user);
    await refreshCampaign();
    showToast(`Você entrou na equipe ${user.teamName}.`);
  } catch (error) { showToast(error.message); }
});

document.getElementById('adminCreateTeam').addEventListener('click', async () => {
  const input = document.getElementById('adminNewTeam');
  try {
    const { teams, user } = await api('/teams', { method: 'POST', body: JSON.stringify({ name: input.value }) });
    input.value = '';
    showUser(user);
    await refreshCampaign();
    showToast(`Equipe ${teams.find((team) => team.id === user.teamId)?.name || ''} criada.`);
  } catch (error) { showToast(error.message); }
});

document.getElementById('adminCreateAdminForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector('button[type="submit"]');
  const error = document.getElementById('adminCreateAdminError');
  const fields = new FormData(form);
  error.hidden = true;
  submit.disabled = true;
  try {
    const result = await api('/admin/admins', { method: 'POST', body: JSON.stringify({
      name: fields.get('name'),
      email: fields.get('email'),
      password: fields.get('password'),
    }) });
    form.reset();
    await loadAccountData();
    showToast(result.createdAccount ? 'Conta e acesso administrativo criados.' : result.added ? 'Participante promovido a administrador.' : 'Essa pessoa já é administradora.');
  } catch (requestError) {
    error.textContent = requestError.message;
    error.hidden = false;
  } finally { submit.disabled = false; }
});

document.getElementById('saveCampaignSettings').addEventListener('click', async () => {
  try {
    await api('/admin/campaign', { method: 'PUT', body: JSON.stringify({
      name: document.getElementById('adminName').value,
      weeklyGoalMinutes: Number(document.getElementById('adminGoal').value),
      periodType: document.getElementById('adminPeriod').value,
      rewardText: document.getElementById('adminReward').value,
    }) });
    await loadAccountData();
    showToast('Configuração atualizada para os participantes.');
  } catch (error) { showToast(error.message); }
});

function localDateInputValue(date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function setChallengeDefaultDates() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const period = document.getElementById('challengePeriodInput').value;
  const end = new Date(start);
  end.setDate(end.getDate() + (period === 'monthly' ? 29 : 6));
  document.getElementById('challengeStartsInput').value = localDateInputValue(start);
  document.getElementById('challengeEndsInput').value = localDateInputValue(end);
  renderChallengePreview();
}

document.getElementById('challengePeriodInput').addEventListener('change', setChallengeDefaultDates);
setChallengeDefaultDates();
let challengeCoverPreviewUrl = null;
const challengeCoverDropzone = document.getElementById('challengeCoverDropzone');
['dragenter', 'dragover'].forEach((eventName) => {
  challengeCoverDropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    challengeCoverDropzone.classList.add('is-dragging');
  });
});
['dragleave', 'dragend'].forEach((eventName) => {
  challengeCoverDropzone.addEventListener(eventName, () => challengeCoverDropzone.classList.remove('is-dragging'));
});
challengeCoverDropzone.addEventListener('drop', (event) => {
  event.preventDefault();
  challengeCoverDropzone.classList.remove('is-dragging');
  const file = event.dataTransfer?.files?.[0];
  if (!file) return;
  const transfer = new DataTransfer();
  transfer.items.add(file);
  document.getElementById('challengeCoverInput').files = transfer.files;
  document.getElementById('challengeCoverInput').dispatchEvent(new Event('change', { bubbles: true }));
});

function renderChallengePreview() {
  const title = document.getElementById('challengeTitleInput').value.trim();
  const description = document.getElementById('challengeDescriptionInput').value.trim();
  const reward = document.getElementById('challengeRewardInput').value.trim();
  const goal = Number(document.getElementById('challengeGoalInput').value) || 150;
  const period = document.getElementById('challengePeriodInput').value;
  const startsOn = document.getElementById('challengeStartsInput').value;
  const endsOn = document.getElementById('challengeEndsInput').value;
  const formatDate = (value) => value ? new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short' }).format(new Date(`${value}T12:00:00`)) : '';
  document.getElementById('challengePreviewTitle').textContent = title || 'Seu desafio começa aqui';
  document.getElementById('challengePreviewDescription').textContent = description || 'A descrição do desafio aparecerá neste espaço.';
  document.getElementById('challengePreviewGoal').textContent = `${goal.toLocaleString('pt-BR')} min`;
  document.getElementById('challengePreviewDates').textContent = startsOn && endsOn ? `${formatDate(startsOn)} a ${formatDate(endsOn)} · ${period === 'monthly' ? 'Mensal' : 'Semanal'}` : 'Defina o período';
  document.getElementById('challengePreviewReward').textContent = reward || 'Sua recompensa pode aparecer aqui.';
}

['challengeTitleInput', 'challengeDescriptionInput', 'challengeGoalInput', 'challengeRewardInput', 'challengeStartsInput', 'challengeEndsInput'].forEach((id) => {
  document.getElementById(id).addEventListener('input', renderChallengePreview);
  document.getElementById(id).addEventListener('change', renderChallengePreview);
});
document.getElementById('challengePeriodInput').addEventListener('change', renderChallengePreview);

document.getElementById('challengeCoverInput').addEventListener('change', (event) => {
  const file = event.target.files[0];
  const preview = document.getElementById('challengeCoverPreview');
  const help = document.getElementById('challengeCoverHelp');
  const coverImage = document.getElementById('challengePreviewImage');
  const cover = document.getElementById('challengePreviewCover');
  const wordmark = document.getElementById('challengePreviewWordmark');
  if (challengeCoverPreviewUrl) URL.revokeObjectURL(challengeCoverPreviewUrl);
  challengeCoverPreviewUrl = null;
  preview.replaceChildren();
  if (!file) {
    preview.hidden = true;
    help.textContent = 'JPEG, PNG ou WebP · até 5 MB';
    coverImage.hidden = true;
    cover.classList.add('is-placeholder');
    wordmark.hidden = false;
    return;
  }
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) {
    event.target.value = '';
    preview.hidden = true;
    help.textContent = 'Escolha JPEG, PNG ou WebP de até 5 MB.';
    coverImage.hidden = true;
    cover.classList.add('is-placeholder');
    wordmark.hidden = false;
    showToast('A capa deve ser JPEG, PNG ou WebP e ter até 5 MB.');
    return;
  }
  challengeCoverPreviewUrl = URL.createObjectURL(file);
  const image = document.createElement('img');
  image.src = challengeCoverPreviewUrl;
  image.alt = 'Prévia da capa do desafio';
  preview.append(image);
  preview.hidden = false;
  coverImage.src = challengeCoverPreviewUrl;
  coverImage.hidden = false;
  cover.classList.remove('is-placeholder');
  wordmark.hidden = true;
  help.textContent = `${file.name} · pronto para publicar`;
});

function readChallengeCover() {
  const file = document.getElementById('challengeCoverInput').files[0];
  if (!file) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Não foi possível ler a imagem da capa.'));
    reader.readAsDataURL(file);
  });
}

document.getElementById('createChallengeButton').addEventListener('click', async () => {
  const button = document.getElementById('createChallengeButton');
  button.disabled = true;
  try {
    const fields = {
      title: document.getElementById('challengeTitleInput').value.trim(),
      description: document.getElementById('challengeDescriptionInput').value.trim(),
      goalMinutes: Number(document.getElementById('challengeGoalInput').value),
      periodType: document.getElementById('challengePeriodInput').value,
      startsOn: document.getElementById('challengeStartsInput').value,
      endsOn: document.getElementById('challengeEndsInput').value,
      rewardText: document.getElementById('challengeRewardInput').value.trim(),
      coverImage: await readChallengeCover(),
    };
    await api('/admin/challenges', { method: 'POST', body: JSON.stringify(fields) });
    document.getElementById('challengeTitleInput').value = '';
    document.getElementById('challengeDescriptionInput').value = '';
    document.getElementById('challengeRewardInput').value = '';
    document.getElementById('challengeCoverInput').value = '';
    document.getElementById('challengeCoverPreview').hidden = true;
    document.getElementById('challengeCoverHelp').textContent = 'JPEG, PNG ou WebP · até 5 MB';
    if (challengeCoverPreviewUrl) URL.revokeObjectURL(challengeCoverPreviewUrl);
    challengeCoverPreviewUrl = null;
    document.getElementById('challengeCoverInput').dispatchEvent(new Event('change'));
    renderChallengePreview();
    await loadAccountData();
    showToast('Desafio publicado e visível para os participantes.');
  } catch (error) { showToast(error.message); }
  finally { button.disabled = false; }
});

document.getElementById('copyInviteCode').addEventListener('click', async () => {
  const code = document.getElementById('adminInviteCode').textContent;
  try {
    await navigator.clipboard.writeText(code);
    showToast('Código copiado. Compartilhe com os colaboradores.');
  } catch { showToast(`Código da campanha: ${code}`); }
});

api('/auth/me').then(async ({ user }) => {
  if (!user) return;
  showUser(user);
  await loadAccountData();
}).catch(() => {});
