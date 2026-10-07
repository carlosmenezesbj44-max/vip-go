import express from 'express';
import session from 'express-session';
import bcrypt from 'bcryptjs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { database, statements } from './db.js';
import { SQLiteSessionStore } from './session-store.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const uploadsDirectory = resolve(here, 'uploads');
const app = express();
const sessionStore = new SQLiteSessionStore();
const port = Number(process.env.PORT || 5173);
const host = process.env.HOST || '0.0.0.0';
const isProduction = process.env.NODE_ENV === 'production';
const secureCookies = process.env.COOKIE_SECURE === 'true' || (isProduction && process.env.COOKIE_SECURE !== 'false');
const activityTypes = new Set([
  'Caminhada', 'Corrida', 'Corrida de rua', 'Corrida em trilha', 'Trilha', 'Ciclismo', 'Mountain bike', 'Patinação', 'Canoagem', 'Escalada', 'Surfe', 'Skate',
  'Natação', 'Musculação', 'Treinamento funcional', 'Crossfit', 'Yoga', 'Pilates', 'Dança', 'Futebol',
  'Futsal', 'Basquete', 'Vôlei', 'Tênis', 'Beach tennis', 'Remo', 'Ciclismo indoor', 'Spinning',
  'Elíptico', 'Escada', 'Alongamento', 'Artes marciais', 'Outro',
]);
let valhallaProcess;
let shuttingDown = false;
const liveActivityLocations = new Map();
const gpsActivityTypes = new Set([
  'Caminhada', 'Corrida', 'Corrida de rua', 'Corrida em trilha', 'Trilha', 'Ciclismo', 'Mountain bike', 'Patinação',
  'Canoagem', 'Escalada', 'Surfe', 'Skate', 'Futebol', 'Futsal', 'Basquete', 'Vôlei', 'Tênis', 'Beach tennis', 'Remo',
]);
if (isProduction && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32)) {
  throw new Error('Defina SESSION_SECRET com pelo menos 32 caracteres antes de iniciar em produção.');
}

app.disable('x-powered-by');
if (isProduction) app.set('trust proxy', 1);
app.use(express.json({ limit: '70mb' }));
app.use(session({
  name: 'vipgo.sid',
  store: sessionStore,
  secret: process.env.SESSION_SECRET || 'local-vip-go-session-secret-change-before-deploying',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: secureCookies, maxAge: 1000 * 60 * 60 * 24 * 30 },
}));

function authRequired(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Entre na sua conta para continuar.' });
  next();
}

function publicUser(id) {
  return statements.publicUserById.get(id);
}

function challengeWithCover(challenge) {
  return { ...challenge, coverImage: challenge.coverImage ? `/api/challenge-covers/${challenge.coverImage}` : null };
}

function establishUserSession(req, userId) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((regenerateError) => {
      if (regenerateError) return reject(regenerateError);
      req.session.userId = userId;
      req.session.save((saveError) => saveError ? reject(saveError) : resolve());
    });
  });
}

function campaignAdminRequired(req, res, next) {
  const user = publicUser(req.session.userId);
  const campaign = user?.companyId ? statements.campaignByCompany.get(user.companyId) : null;
  if (!campaign || (campaign.adminUserId !== user.id && !statements.isCampaignAdmin.get(campaign.id, user.id))) return res.status(403).json({ error: 'Esta ação é exclusiva da administração da campanha.' });
  req.adminUser = user;
  req.adminCampaign = campaign;
  next();
}

function validActivity(body) {
  const modes = ['Caminhada', 'Corrida', 'Ciclismo'];
  if (!body || !modes.includes(body.mode)) return 'Tipo de atividade inválido.';
  if (body.activityType !== undefined && !activityTypes.has(body.activityType)) return 'Modalidade de atividade inválida.';
  if (typeof body.id !== 'string' || body.id.length > 80 || !/^[a-zA-Z0-9_-]+$/.test(body.id)) return 'Identificador da atividade inválido.';
  if (typeof body.startedAt !== 'string' || Number.isNaN(Date.parse(body.startedAt))) return 'Data de início inválida.';
  if (!Number.isInteger(body.durationSeconds) || body.durationSeconds < 1 || body.durationSeconds > 60 * 60 * 48) return 'Duração inválida.';
  if (typeof body.distanceKm !== 'number' || !Number.isFinite(body.distanceKm) || body.distanceKm < 0 || body.distanceKm > 1000) return 'Distância inválida.';
  for (const key of ['averageHeartRate', 'maxHeartRate']) {
    const value = body[key];
    if (value !== undefined && value !== null && (!Number.isInteger(value) || value < 30 || value > 240)) return 'Frequência cardíaca inválida.';
  }
  if (body.averageHeartRate && body.maxHeartRate && body.averageHeartRate > body.maxHeartRate) return 'A média cardíaca não pode superar o máximo.';
  const route = body.route ?? [];
  if (!Array.isArray(route) || route.length > 5000 || route.length === 1) return 'Percurso inválido.';
  let previousTime = 0;
  for (const point of route) {
    if (!point || typeof point !== 'object' || !Number.isFinite(point.lat) || !Number.isFinite(point.lng)
      || point.lat < -90 || point.lat > 90 || point.lng < -180 || point.lng > 180
      || !Number.isInteger(point.t) || point.t < previousTime || point.t > Date.now() + 60000) return 'Coordenadas do percurso inválidas.';
    previousTime = point.t;
  }
  if (body.shareRoute === true && route.length < 2) return 'Grave um percurso antes de compartilhá-lo.';
  if (body.shareRoute === true && maskSharedRoute(route).length < 2) return 'Para compartilhar, grave mais de 400 m. Você ainda pode salvar o percurso como privado.';
  return null;
}

function routeDistanceMeters(a, b) {
  const toRadians = Math.PI / 180;
  const lat1 = a.lat * toRadians;
  const lat2 = b.lat * toRadians;
  const deltaLat = (b.lat - a.lat) * toRadians;
  const deltaLng = (b.lng - a.lng) * toRadians;
  const haversine = Math.sin(deltaLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2;
  const bounded = Math.min(1, Math.max(0, haversine));
  return 6371000 * 2 * Math.atan2(Math.sqrt(bounded), Math.sqrt(1 - bounded));
}

function maskSharedRoute(route, edgeMeters = 200) {
  if (route.length < 2) return [];
  const cumulative = [0];
  for (let index = 1; index < route.length; index += 1) cumulative.push(cumulative[index - 1] + routeDistanceMeters(route[index - 1], route[index]));
  const total = cumulative.at(-1);
  if (total <= edgeMeters * 2) return [];
  function pointAt(distance) {
    let index = 1;
    while (index < cumulative.length - 1 && cumulative[index] < distance) index += 1;
    const span = cumulative[index] - cumulative[index - 1];
    const fraction = span ? (distance - cumulative[index - 1]) / span : 0;
    return {
      lat: route[index - 1].lat + (route[index].lat - route[index - 1].lat) * fraction,
      lng: route[index - 1].lng + (route[index].lng - route[index - 1].lng) * fraction,
    };
  }
  return [pointAt(edgeMeters), ...route.filter((_point, index) => cumulative[index] > edgeMeters && cumulative[index] < total - edgeMeters), pointAt(total - edgeMeters)]
    .map(({ lat, lng }) => ({ lat: Number(lat.toFixed(5)), lng: Number(lng.toFixed(5)) }));
}

function decodePolyline6(encoded) {
  let index = 0;
  let lat = 0;
  let lng = 0;
  const points = [];
  while (index < encoded.length) {
    const readValue = () => {
      let result = 0;
      let shift = 0;
      let value;
      do {
        value = encoded.charCodeAt(index++) - 63;
        result |= (value & 0x1f) << shift;
        shift += 5;
      } while (value >= 0x20 && index <= encoded.length);
      return result & 1 ? ~(result >> 1) : result >> 1;
    };
    lat += readValue();
    lng += readValue();
    points.push({ lat: lat / 1e6, lng: lng / 1e6 });
  }
  return points;
}

function evenlySampleRoute(route, limit = 100) {
  if (route.length <= limit) return route;
  return Array.from({ length: limit }, (_value, index) => route[Math.round(index * (route.length - 1) / (limit - 1))]);
}

async function matchGpsRoute(route, mode) {
  if (route.length < 3 || !process.env.VALHALLA_URL) return [];
  const locations = evenlySampleRoute(route).map(({ lat, lng }, index, all) => ({ lat, lon: lng, ...(index > 0 && index < all.length - 1 ? { type: 'through' } : {}) }));
  const costing = mode === 'Ciclismo' ? 'bicycle' : 'pedestrian';
  try {
    const response = await fetch(`${process.env.VALHALLA_URL.replace(/\/$/, '')}/trace_route`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ costing, shape: locations, shape_match: 'map_snap', shape_format: 'polyline6',
        trace_options: { gps_accuracy: 20, search_radius: 80, breakage_distance: 1200, interpolation_distance: 10, turn_penalty_factor: 200 },
        directions_options: { units: 'kilometers', language: 'pt-BR' },
      }),
      signal: AbortSignal.timeout(25000),
    });
    if (!response.ok) throw new Error(`Valhalla returned ${response.status}`);
    const result = await response.json();
    const matched = (result.trip?.legs || []).flatMap((leg) => typeof leg.shape === 'string' ? decodePolyline6(leg.shape) : []);
    if (matched.length < 2) return [];
    const rawMeters = route.slice(1).reduce((total, point, index) => total + routeDistanceMeters(route[index], point), 0);
    const matchedMeters = matched.slice(1).reduce((total, point, index) => total + routeDistanceMeters(matched[index], point), 0);
    if (!rawMeters || matchedMeters < rawMeters * 0.35 || matchedMeters > rawMeters * 2.5) return [];
    return matched;
  } catch (error) {
    console.warn('Map matching unavailable; preserving the original GPS trace:', error.message);
    return [];
  }
}

app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
app.post('/api/auth/register', async (req, res, next) => {
  try {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (name.length < 2 || name.length > 60) return res.status(400).json({ error: 'Informe um nome entre 2 e 60 caracteres.' });
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Informe um e-mail válido.' });
    if (password.length < 8 || password.length > 128) return res.status(400).json({ error: 'A senha deve ter entre 8 e 128 caracteres.' });
    const passwordHash = await bcrypt.hash(password, 12);
    const code = typeof req.body?.companyCode === 'string' ? req.body.companyCode.trim() : '';
    const company = code ? statements.companyByCode.get(code) : null;
    if (code && !company) return res.status(400).json({ error: 'Código de convite ou da empresa inválido.' });
    let result;
    try { result = statements.createUser.run({ name, email, passwordHash, companyId: company?.id || null }); }
    catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'Já existe uma conta com este e-mail.' });
      throw error;
    }
    const userId = Number(result.lastInsertRowid);
    await establishUserSession(req, userId);
    if (company) statements.claimCampaignAdmin.run(userId, company.id);
    res.status(201).json({ user: publicUser(userId) });
  } catch (error) { next(error); }
});

app.post('/api/auth/login', async (req, res, next) => {
  try {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const user = statements.userByEmail.get(email);
    if (!user || !(await bcrypt.compare(password, user.password_hash))) return res.status(401).json({ error: 'E-mail ou senha incorretos.' });
    await establishUserSession(req, user.id);
    res.json({ user: publicUser(user.id) });
  } catch (error) { next(error); }
});

app.get('/api/auth/me', (req, res) => {
  if (!req.session.userId) return res.json({ user: null });
  const user = publicUser(req.session.userId);
  if (!user) { req.session.destroy(() => {}); return res.json({ user: null }); }
  res.json({ user });
});

app.post('/api/auth/logout', (req, res) => {
  if (req.session.userId) liveActivityLocations.delete(req.session.userId);
  req.session.destroy((error) => {
    if (error) return res.status(500).json({ error: 'Não foi possível sair da conta.' });
    res.clearCookie('vipgo.sid', { httpOnly: true, sameSite: 'lax', secure: secureCookies });
    res.json({ ok: true });
  });
});

app.get('/api/activities', authRequired, (req, res) => {
  const activities = statements.listActivities.all(req.session.userId).map(({ routeJson, matchedRouteJson, mediaJson, ...activity }) => {
    const matchedRoute = JSON.parse(matchedRouteJson || '[]');
    return { ...activity, media: JSON.parse(mediaJson || '[]'), routeMatched: matchedRoute.length >= 2, route: matchedRoute.length >= 2 ? matchedRoute : JSON.parse(routeJson || '[]') };
  });
  res.json({ activities });
});

app.get('/api/maps/routes', authRequired, (req, res) => {
  const user = publicUser(req.session.userId);
  if (!user?.companyId) return res.json({ routes: [] });
  const routes = statements.mapRoutesForCompany.all(user.companyId, user.id).flatMap(({ routeJson, matchedRouteJson, ...activity }) => {
    const route = maskSharedRoute(JSON.parse(routeJson || '[]'));
    return route.length >= 2 ? [{ ...activity, routeMatched: JSON.parse(matchedRouteJson || '[]').length >= 2, route }] : [];
  });
  res.json({ routes });
});

app.post('/api/live-activities/location', authRequired, (req, res) => {
  const user = publicUser(req.session.userId);
  if (!user) return res.status(401).json({ error: 'Sua sessão expirou. Entre novamente.' });
  if (req.body?.isSharing === false) {
    liveActivityLocations.delete(user.id);
    return res.json({ sharing: false });
  }
  if (!user?.companyId) return res.status(403).json({ error: 'Entre em uma campanha para compartilhar sua posição ao vivo.' });
  const { activityType, lat, lng } = req.body || {};
  if (!gpsActivityTypes.has(activityType) || !Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) {
    return res.status(400).json({ error: 'Atividade ou localização inválida para o compartilhamento ao vivo.' });
  }
  const previous = liveActivityLocations.get(user.id);
  liveActivityLocations.set(user.id, {
    userId: user.id,
    companyId: user.companyId,
    name: user.name,
    activityType,
    lat,
    lng,
    startedAt: previous?.startedAt || Date.now(),
    updatedAt: Date.now(),
  });
  res.json({ sharing: true });
});

app.get('/api/live-activities', authRequired, (req, res) => {
  const user = publicUser(req.session.userId);
  if (!user?.companyId) return res.json({ participants: [] });
  const now = Date.now();
  const participants = [];
  for (const [userId, live] of liveActivityLocations) {
    if (now - live.updatedAt > 35000) { liveActivityLocations.delete(userId); continue; }
    if (live.userId !== user.id && live.companyId === user.companyId && publicUser(live.userId)?.companyId === live.companyId) {
      participants.push({ userId: live.userId, name: live.name, activityType: live.activityType, lat: live.lat, lng: live.lng, startedAt: live.startedAt, updatedAt: live.updatedAt });
    }
  }
  res.json({ participants });
});

app.put('/api/activities/:id/route-visibility', authRequired, (req, res) => {
  const activity = statements.routeByOwner.get(req.params.id, req.session.userId);
  if (!activity) return res.status(404).json({ error: 'Atividade não encontrada.' });
  if (typeof req.body?.shareRoute !== 'boolean') return res.status(400).json({ error: 'Informe se deseja compartilhar o percurso.' });
  if (req.body.shareRoute && maskSharedRoute(JSON.parse(activity.routeJson || '[]')).length < 2) return res.status(400).json({ error: 'Para compartilhar, o percurso precisa ter mais de 400 m.' });
  statements.updateRouteVisibility.run(req.body.shareRoute ? 1 : 0, activity.id, req.session.userId);
  res.json({ shareRoute: req.body.shareRoute });
});

app.get('/api/media/:filename', authRequired, (req, res) => {
  const filename = req.params.filename;
  if (!/^[a-f0-9]{36}\.(jpg|png|webp|gif|mp4|webm|mov)$/.test(filename)) return res.status(404).end();
  const activity = statements.sharedMediaActivity.get(filename);
  const viewer = publicUser(req.session.userId);
  if (!activity || !viewer || activity.companyId !== viewer.companyId) return res.status(404).end();
  const media = JSON.parse(activity.mediaJson || '[]');
  if (!media.some((item) => item.url === `/api/media/${filename}`)) return res.status(404).end();
  if (activity.userId !== viewer.id && (!activity.shareActivities || !statements.isFollowing.get(viewer.id, activity.userId))) return res.status(403).end();
  const contentType = ({ jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime' })[filename.split('.').pop()];
  res.type(contentType);
  res.set('Cache-Control', 'private, max-age=3600');
  createReadStream(resolve(uploadsDirectory, filename)).on('error', () => { if (!res.headersSent) res.status(404).end(); }).pipe(res);
});

app.get('/api/challenge-covers/:filename', authRequired, (req, res) => {
  const filename = req.params.filename;
  if (!/^[a-f0-9]{36}\.(jpg|png|webp)$/.test(filename)) return res.status(404).end();
  const cover = statements.challengeCoverByFilename.get(filename);
  const viewer = publicUser(req.session.userId);
  const campaign = viewer?.companyId ? statements.campaignByCompany.get(viewer.companyId) : null;
  if (!cover || campaign?.id !== cover.campaignId) return res.status(404).end();
  const contentType = ({ jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' })[filename.split('.').pop()];
  res.type(contentType);
  res.set('Cache-Control', 'private, max-age=3600');
  createReadStream(resolve(uploadsDirectory, filename)).on('error', () => { if (!res.headersSent) res.status(404).end(); }).pipe(res);
});

app.get('/api/profile-photos/:filename', authRequired, (req, res) => {
  const filename = req.params.filename;
  if (!/^[a-f0-9]{36}\.(jpg|png|webp)$/.test(filename)) return res.status(404).end();
  const photoOwner = statements.profilePhotoOwner.get(filename);
  const viewer = publicUser(req.session.userId);
  const sharedCommunity = photoOwner && viewer && statements.sharedCommunityMembers.get(photoOwner.id, viewer.id);
  if (!photoOwner || !viewer || (photoOwner.companyId !== viewer.companyId && !sharedCommunity) || (photoOwner.id !== viewer.id && !photoOwner.shareProfilePhoto)) return res.status(404).end();
  const contentType = ({ jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' })[filename.split('.').pop()];
  res.type(contentType);
  res.set('Cache-Control', 'private, max-age=3600');
  createReadStream(resolve(uploadsDirectory, filename)).on('error', () => { if (!res.headersSent) res.status(404).end(); }).pipe(res);
});

app.put('/api/profile/photo', authRequired, async (req, res) => {
  const match = typeof req.body?.data === 'string' && req.body.data.match(/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/);
  if (!match) return res.status(400).json({ error: 'Escolha uma foto JPG, PNG ou WebP.' });
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length || buffer.length > 5 * 1024 * 1024) return res.status(400).json({ error: 'A foto deve ter no máximo 5 MB.' });
  const extension = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[match[1]];
  const filename = `${randomBytes(18).toString('hex')}.${extension}`;
  try {
    await mkdir(uploadsDirectory, { recursive: true });
    await writeFile(resolve(uploadsDirectory, filename), buffer, { flag: 'wx' });
    statements.updateProfilePhoto.run(filename, req.session.userId);
    res.json({ user: publicUser(req.session.userId) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Não foi possível salvar a foto de perfil.' });
  }
});

function campaignPeriodBounds(periodType = 'weekly', now = new Date()) {
  const recifeOffset = 3 * 60 * 60 * 1000;
  const local = new Date(now.getTime() - recifeOffset);
  local.setUTCHours(0, 0, 0, 0);
  if (periodType === 'monthly') local.setUTCDate(1);
  else local.setUTCDate(local.getUTCDate() - ((local.getUTCDay() + 6) % 7));
  const start = new Date(local.getTime() + recifeOffset);
  const end = new Date(start);
  if (periodType === 'monthly') end.setUTCMonth(end.getUTCMonth() + 1);
  else end.setUTCDate(end.getUTCDate() + 7);
  return { start: start.toISOString(), end: end.toISOString(), periodType };
}

app.get('/api/campaign', authRequired, (req, res) => {
  const user = statements.publicUserById.get(req.session.userId);
  if (!user?.companyId) return res.json({ joined: false, user, campaign: null, teams: [], people: [], socialFeed: [], communityPosts: statements.communityPosts.all({ companyId: -1, viewerId: user.id }).map((post) => ({ ...post, media: JSON.parse(post.mediaJson || '[]').map((item) => ({ ...item, url: `/api/community-media/${item.filename}` })), profilePhoto: post.profilePhoto ? `/api/profile-photos/${post.profilePhoto}` : null })), individualRanking: [], teamRanking: [], badges: [] });
  const campaign = statements.campaignByCompany.get(user.companyId);
  const { start, end, periodType } = campaignPeriodBounds(campaign.periodType);
  const rows = statements.weeklyActivities.all(start, end, user.companyId);
  const individualRanking = rows.filter((row) => row.showInRanking).map((row) => ({
    userId: row.userId,
    name: row.userId === user.id ? `${row.name} (você)` : row.name,
    teamName: row.teamName || 'Sem equipe',
    minutes: Math.floor(row.durationSeconds / 60),
    activityCount: row.activityCount,
  }));
  const teamTotals = new Map(statements.teamsForCompany.all(user.companyId).map((team) => [team.id, {
    teamId: team.id, teamName: team.name, minutes: 0, participants: 0,
  }]));
  rows.filter((row) => row.showInRanking && row.teamId).forEach((row) => {
    const current = teamTotals.get(row.teamId);
    current.minutes += Math.floor(row.durationSeconds / 60);
    current.participants += 1;
    teamTotals.set(row.teamId, current);
  });
  const isCampaignAdmin = campaign.adminUserId === user.id || Boolean(statements.isCampaignAdmin.get(campaign.id, user.id));
  const totalSeconds = rows.filter((row) => row.userId === user.id).reduce((sum, row) => sum + row.durationSeconds, 0);
  const lifetime = statements.userLifetime.get(user.id);
  const badges = [];
  if (lifetime.activityCount >= 1) badges.push({ id: 'first', name: 'Primeiro movimento', icon: '🌱', description: 'Registrou sua primeira atividade.' });
  if (lifetime.activityCount >= 10) badges.push({ id: 'ten', name: 'Em movimento', icon: '🏅', description: 'Completou 10 atividades.' });
  if (lifetime.activityCount >= 25) badges.push({ id: 'twenty-five', name: 'Constância', icon: '🏆', description: 'Completou 25 atividades.' });
  if (Math.floor(totalSeconds / 60) >= campaign.weeklyGoalMinutes) badges.push({ id: 'period-goal', name: 'Meta do período', icon: '🔥', description: `Atingiu ${campaign.weeklyGoalMinutes} minutos ativos neste período.` });
  const admin = isCampaignAdmin ? {
    joinCode: statements.companyById.get(user.companyId).joinCode,
    summary: statements.companySummary.get(user.companyId),
    teams: statements.teamsForCompany.all(user.companyId),
    challenges: statements.challengesForCampaign.all(campaign.id).map(challengeWithCover),
    admins: statements.campaignAdmins.all(campaign.id),
    canManageAdmins: campaign.adminUserId === user.id,
  } : null;
  const challenges = statements.challengesForCampaign.all(campaign.id).map((challenge) => {
    const participation = statements.acceptedChallenge.get(challenge.id, user.id);
    const progress = participation ? statements.challengeProgress.get(user.id, challenge.startsAt, challenge.endsAt) : { durationSeconds: 0, activityCount: 0 };
    const now = Date.now();
    return {
      ...challenge,
      coverImage: challenge.coverImage ? `/api/challenge-covers/${challenge.coverImage}` : null,
      status: now < Date.parse(challenge.startsAt) ? 'upcoming' : now >= Date.parse(challenge.endsAt) ? 'ended' : 'active',
      accepted: Boolean(participation),
      acceptedAt: participation?.acceptedAt || null,
      minutes: Math.floor(progress.durationSeconds / 60),
      activityCount: progress.activityCount,
    };
  });
  res.json({
    joined: true,
    user,
    campaign,
    week: { startsAt: start, endsAt: end, periodType },
    periodMinutes: Math.floor(totalSeconds / 60),
    teams: statements.teamsForCompany.all(user.companyId),
    individualRanking,
    teamRanking: [...teamTotals.values()].sort((a, b) => b.minutes - a.minutes),
    people: statements.campaignPeople.all({ companyId: user.companyId, viewerId: user.id }).map(({ profilePhoto, shareProfilePhoto, ...person }) => ({ ...person, profilePhoto: profilePhoto && shareProfilePhoto ? `/api/profile-photos/${profilePhoto}` : null })),
    socialFeed: statements.sharedActivityFeed.all({ companyId: user.companyId, viewerId: user.id }).map(({ mediaJson, profilePhoto, shareProfilePhoto, ...activity }) => ({ ...activity, profilePhoto: profilePhoto && shareProfilePhoto ? `/api/profile-photos/${profilePhoto}` : null, media: JSON.parse(mediaJson || '[]') })),
    communityPosts: statements.communityPosts.all({ companyId: user.companyId, viewerId: user.id }).map((post) => ({ ...post, media: JSON.parse(post.mediaJson || '[]').map((item) => ({ ...item, url: `/api/community-media/${item.filename}` })), profilePhoto: post.profilePhoto ? `/api/profile-photos/${post.profilePhoto}` : null })),
    challenges,
    badges,
    isCampaignAdmin,
    admin,
  });
});

function findCommunityPostForViewer(postId, userId) {
  const post = statements.communityPostById.get(postId);
  const viewer = publicUser(userId);
  if (!post || !viewer) return null;
  if (post.communityId) return statements.isCommunityMember.get(post.communityId, viewer.id) ? { post, viewer } : null;
  return viewer.companyId && post.companyId === viewer.companyId ? { post, viewer } : null;
}

app.get('/api/communities', authRequired, (req, res) => {
  const query = typeof req.query?.q === 'string' ? req.query.q.trim().slice(0, 80) : '';
  const communities = query
    ? statements.communitiesForDirectory.all({ userId: req.session.userId, query: `%${query}%`, code: query.toUpperCase() })
    : statements.communitiesForUser.all({ userId: req.session.userId });
  res.json({ communities });
});

app.post('/api/communities', authRequired, (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  const description = typeof req.body?.description === 'string' ? req.body.description.trim() : '';
  if (name.length < 3 || name.length > 60) return res.status(400).json({ error: 'O nome da comunidade deve ter entre 3 e 60 caracteres.' });
  if (description.length > 300) return res.status(400).json({ error: 'A descrição deve ter até 300 caracteres.' });
  let result;
  try {
    const code = `VIP-${randomBytes(4).toString('hex').toUpperCase()}`;
    result = statements.createCommunity.run(req.session.userId, name, description, code);
    statements.addCommunityMember.run(Number(result.lastInsertRowid), req.session.userId);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Não foi possível criar a comunidade.' });
  }
  res.status(201).json({ id: Number(result.lastInsertRowid) });
});

app.post('/api/communities/:id/join', authRequired, (req, res) => {
  const id = Number(req.params.id);
  const community = Number.isInteger(id) ? statements.communityById.get(id) : null;
  if (!community) return res.status(404).json({ error: 'Comunidade não encontrada.' });
  statements.addCommunityMember.run(id, req.session.userId);
  res.json({ joined: true, id });
});

app.get('/api/communities/:id', authRequired, (req, res) => {
  const id = Number(req.params.id);
  const community = Number.isInteger(id) ? statements.communityById.get(id) : null;
  if (!community || !statements.isCommunityMember.get(id, req.session.userId)) return res.status(404).json({ error: 'Entre na comunidade para ver as publicações.' });
  const posts = statements.postsForCommunity.all({ communityId: id, viewerId: req.session.userId }).map((post) => ({ ...post, media: JSON.parse(post.mediaJson || '[]').map((item) => ({ ...item, url: `/api/community-media/${item.filename}` })), profilePhoto: post.profilePhoto ? `/api/profile-photos/${post.profilePhoto}` : null }));
  res.json({ community, posts });
});

async function saveCommunityPost(req, res, communityId = null) {
  const user = publicUser(req.session.userId);
  if (communityId) {
    if (!statements.isCommunityMember.get(communityId, user.id)) return res.status(403).json({ error: 'Participe da comunidade para publicar.' });
  } else if (!user?.companyId) return res.status(403).json({ error: 'Entre na campanha para publicar na comunidade.' });
  const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
  const uploads = Array.isArray(req.body?.media) ? req.body.media : [];
  if (body.length > 1000) return res.status(400).json({ error: 'A publicação deve ter até 1.000 caracteres.' });
  if (!body && !uploads.length) return res.status(400).json({ error: 'Escreva uma mensagem ou adicione uma foto.' });
  if (uploads.length > 4) return res.status(400).json({ error: 'Adicione no máximo 4 fotos.' });
  const savedFiles = [];
  try {
    await mkdir(uploadsDirectory, { recursive: true });
    for (const upload of uploads) {
      const match = typeof upload?.data === 'string' && upload.data.match(/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/);
      if (!match) throw new Error('Escolha fotos JPG, PNG ou WebP.');
      const buffer = Buffer.from(match[2], 'base64');
      if (!buffer.length || buffer.length > 5 * 1024 * 1024) throw new Error('Cada foto deve ter no máximo 5 MB.');
      const extension = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[match[1]];
      const filename = `${randomBytes(18).toString('hex')}.${extension}`;
      await writeFile(resolve(uploadsDirectory, filename), buffer, { flag: 'wx' });
      savedFiles.push({ filename, type: 'image' });
    }
    const result = statements.createCommunityPost.run(user.id, communityId, body, JSON.stringify(savedFiles));
    res.status(201).json({ id: Number(result.lastInsertRowid) });
  } catch (error) {
    await Promise.all(savedFiles.map(({ filename }) => unlink(resolve(uploadsDirectory, filename)).catch(() => {})));
    res.status(400).json({ error: error.message || 'Não foi possível criar a publicação.' });
  }
}

app.post('/api/community/posts', authRequired, (req, res) => saveCommunityPost(req, res));
app.post('/api/communities/:id/posts', authRequired, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || !statements.communityById.get(id)) return res.status(404).json({ error: 'Comunidade não encontrada.' });
  return saveCommunityPost(req, res, id);
});

app.get('/api/community/posts/:id/comments', authRequired, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(404).json({ error: 'Publicação não encontrada.' });
  const result = findCommunityPostForViewer(id, req.session.userId);
  if (!result) return res.status(404).json({ error: 'Publicação não encontrada nesta campanha.' });
  const comments = statements.communityComments.all(id).map((comment) => ({ ...comment, profilePhoto: comment.profilePhoto ? `/api/profile-photos/${comment.profilePhoto}` : null }));
  res.json({ comments });
});

app.post('/api/community/posts/:id/comments', authRequired, (req, res) => {
  const id = Number(req.params.id);
  const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
  if (!Number.isInteger(id)) return res.status(404).json({ error: 'Publicação não encontrada.' });
  if (!body || body.length > 500) return res.status(400).json({ error: 'O comentário deve ter entre 1 e 500 caracteres.' });
  const result = findCommunityPostForViewer(id, req.session.userId);
  if (!result) return res.status(404).json({ error: 'Publicação não encontrada nesta campanha.' });
  statements.createCommunityComment.run(id, req.session.userId, body);
  res.status(201).json({ comments: statements.communityComments.all(id).map((comment) => ({ ...comment, profilePhoto: comment.profilePhoto ? `/api/profile-photos/${comment.profilePhoto}` : null })) });
});

app.post('/api/community/posts/:id/reaction', authRequired, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(404).json({ error: 'Publicação não encontrada.' });
  const result = findCommunityPostForViewer(id, req.session.userId);
  if (!result) return res.status(404).json({ error: 'Publicação não encontrada nesta campanha.' });
  const existing = statements.communityReactionExists.get(id, req.session.userId);
  if (existing) statements.removeCommunityReaction.run(id, req.session.userId);
  else statements.toggleCommunityReaction.run(id, req.session.userId);
  const post = statements.communityPosts.all({ companyId: result.viewer.companyId, viewerId: result.viewer.id }).find((item) => item.id === id);
  res.json({ reacted: !existing, reactionCount: post?.reactionCount ?? 0 });
});

app.get('/api/community-media/:filename', authRequired, (req, res) => {
  const filename = req.params.filename;
  if (!/^[a-f0-9]{36}\.(jpg|png|webp)$/.test(filename)) return res.status(404).end();
  const viewer = publicUser(req.session.userId);
  const post = database.prepare("SELECT p.community_id AS communityId, u.company_id AS companyId FROM community_posts p JOIN users u ON u.id = p.user_id WHERE EXISTS (SELECT 1 FROM json_each(p.media_json) m WHERE json_extract(m.value, '$.filename') = ?)").get(filename);
  if (!post || !viewer || (post.communityId ? !statements.isCommunityMember.get(post.communityId, viewer.id) : post.companyId !== viewer.companyId)) return res.status(404).end();
  res.type(({ jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' })[filename.split('.').pop()]);
  res.set('Cache-Control', 'private, max-age=3600');
  createReadStream(resolve(uploadsDirectory, filename)).on('error', () => { if (!res.headersSent) res.status(404).end(); }).pipe(res);
});

app.post('/api/social/follow/:id', authRequired, (req, res) => {
  const user = statements.publicUserById.get(req.session.userId);
  const followedId = Number(req.params.id);
  if (!Number.isInteger(followedId) || followedId === user.id) return res.status(400).json({ error: 'Participante inválido.' });
  const followed = statements.followedUser.get(followedId, user.companyId);
  if (!followed) return res.status(404).json({ error: 'Participante não encontrado nesta campanha.' });
  statements.follow.run(user.id, followed.id);
  res.json({ following: true });
});

app.delete('/api/social/follow/:id', authRequired, (req, res) => {
  const followedId = Number(req.params.id);
  if (!Number.isInteger(followedId)) return res.status(400).json({ error: 'Participante inválido.' });
  statements.unfollow.run(req.session.userId, followedId);
  res.status(204).end();
});

app.post('/api/challenges/:id/accept', authRequired, (req, res) => {
  const user = statements.publicUserById.get(req.session.userId);
  const campaign = user?.companyId ? statements.campaignByCompany.get(user.companyId) : null;
  if (!campaign) return res.status(400).json({ error: 'Entre em uma campanha para aceitar um desafio.' });
  const challengeId = Number(req.params.id);
  if (!Number.isInteger(challengeId)) return res.status(400).json({ error: 'Desafio inválido.' });
  const challenge = statements.challengeById.get(challengeId, campaign.id);
  if (!challenge) return res.status(404).json({ error: 'Desafio não encontrado nesta campanha.' });
  const now = Date.now();
  if (now >= Date.parse(challenge.endsAt)) return res.status(410).json({ error: 'Este desafio já foi encerrado.' });
  statements.acceptChallenge.run(challengeId, user.id);
  res.status(200).json({ accepted: true });
});

app.post('/api/campaign/join', authRequired, (req, res) => {
  const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
  const company = statements.companyByCode.get(code);
  if (!company) return res.status(404).json({ error: 'Código de convite ou da empresa não encontrado.' });
  const currentUser = publicUser(req.session.userId);
  const currentCampaign = currentUser?.companyId ? statements.campaignByCompany.get(currentUser.companyId) : null;
  if (currentCampaign?.adminUserId === currentUser.id && currentUser.companyId !== company.id) {
    return res.status(409).json({ error: 'Transfira a administração antes de sair desta campanha.' });
  }
  statements.joinCompany.run(company.id, req.session.userId);
  statements.claimCampaignAdmin.run(req.session.userId, company.id);
  res.json({ user: publicUser(req.session.userId) });
});

app.post('/api/companies', authRequired, (req, res) => {
  const owner = publicUser(req.session.userId);
  if (owner?.companyId) return res.status(409).json({ error: 'Sua conta já está em uma campanha. Gerencie-a pela área administrativa.' });
  const companyName = typeof req.body?.companyName === 'string' ? req.body.companyName.trim() : '';
  const campaignName = typeof req.body?.campaignName === 'string' ? req.body.campaignName.trim() : '';
  const weeklyGoalMinutes = Number(req.body?.weeklyGoalMinutes);
  if (companyName.length < 2 || companyName.length > 80) return res.status(400).json({ error: 'O nome da empresa deve ter de 2 a 80 caracteres.' });
  if (campaignName.length < 2 || campaignName.length > 80) return res.status(400).json({ error: 'O nome da campanha deve ter de 2 a 80 caracteres.' });
  if (!Number.isInteger(weeklyGoalMinutes) || weeklyGoalMinutes < 1 || weeklyGoalMinutes > 10080) return res.status(400).json({ error: 'A meta semanal deve estar entre 1 e 10.080 minutos.' });
  const create = database.transaction(() => {
    const code = randomBytes(6).toString('base64url').slice(0, 8).toUpperCase();
    const company = statements.createCompany.run(companyName, code);
    const companyId = Number(company.lastInsertRowid);
    const rewardText = typeof req.body?.rewardText === 'string' && req.body.rewardText.trim()
      ? req.body.rewardText.trim().slice(0, 160) : 'Medalha digital e reconhecimento da equipe';
    const periodType = req.body?.periodType === 'monthly' ? 'monthly' : 'weekly';
    statements.createCampaign.run(companyId, campaignName, weeklyGoalMinutes, rewardText, periodType, req.session.userId);
    statements.joinCompany.run(companyId, req.session.userId);
    return { code, user: publicUser(req.session.userId) };
  });
  try { res.status(201).json(create()); }
  catch { res.status(500).json({ error: 'Não foi possível criar a campanha agora.' }); }
});

app.post('/api/teams', authRequired, (req, res) => {
  const user = statements.publicUserById.get(req.session.userId);
  const campaign = user?.companyId ? statements.campaignByCompany.get(user.companyId) : null;
  if (!campaign) return res.status(400).json({ error: 'Entre em uma campanha antes de criar uma equipe.' });
  if (campaign.adminUserId !== user.id) return res.status(403).json({ error: 'Somente a administração pode criar equipes.' });
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (name.length < 2 || name.length > 40) return res.status(400).json({ error: 'O nome da equipe deve ter de 2 a 40 caracteres.' });
  try {
    const result = statements.createTeam.run(user.companyId, name);
    statements.joinTeam.run(result.lastInsertRowid, user.id, user.companyId);
    res.status(201).json({ teams: statements.teamsForCompany.all(user.companyId), user: publicUser(user.id) });
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'Já existe uma equipe com esse nome.' });
    res.status(500).json({ error: 'Não foi possível criar a equipe.' });
  }
});

app.post('/api/admin/admins', authRequired, campaignAdminRequired, async (req, res, next) => {
  try {
    if (req.adminCampaign.adminUserId !== req.adminUser.id) return res.status(403).json({ error: 'Somente o administrador principal pode gerenciar outros administradores.' });
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (name.length < 2 || name.length > 60) return res.status(400).json({ error: 'Informe um nome entre 2 e 60 caracteres.' });
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Informe um e-mail válido.' });

    const existing = statements.userAccountByEmail.get(email);
    let userId;
    let createdAccount = false;
    if (existing) {
      if (existing.companyId !== req.adminUser.companyId) return res.status(409).json({ error: 'Esse e-mail já pertence a uma conta de outra empresa.' });
      userId = existing.id;
    } else {
      if (password.length < 8 || password.length > 128) return res.status(400).json({ error: 'Para uma nova conta, informe uma senha entre 8 e 128 caracteres.' });
      const passwordHash = await bcrypt.hash(password, 12);
      try {
        const result = statements.createUser.run({ name, email, passwordHash, companyId: req.adminUser.companyId });
        userId = Number(result.lastInsertRowid);
        createdAccount = true;
      } catch (error) {
        if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'Já existe uma conta com esse e-mail.' });
        throw error;
      }
    }

    const added = statements.addCampaignAdmin.run(req.adminCampaign.id, userId).changes > 0;
    res.status(createdAccount ? 201 : 200).json({ createdAccount, added, admins: statements.campaignAdmins.all(req.adminCampaign.id) });
  } catch (error) { next(error); }
});

app.get('/api/admin/participants', authRequired, campaignAdminRequired, (req, res) => {
  res.json({ participants: statements.allAccountsForAdmin.all(), teams: statements.teamsForAllCompanies.all() });
});

app.put('/api/admin/participants/:id', authRequired, campaignAdminRequired, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Participante inválido.' });
  const participant = statements.accountForAdminById.get(id);
  if (!participant) return res.status(404).json({ error: 'Cadastro não encontrado.' });

  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const teamId = req.body?.teamId === null || req.body?.teamId === '' ? null : Number(req.body?.teamId);
  if (name.length < 2 || name.length > 60) return res.status(400).json({ error: 'O nome deve ter de 2 a 60 caracteres.' });
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Informe um e-mail válido.' });
  if (teamId !== null && (!Number.isInteger(teamId) || !participant.companyId || !statements.teamByIdAndCompany.get(teamId, participant.companyId))) return res.status(400).json({ error: 'Selecione uma equipe do grupo atual da conta.' });
  const existing = statements.userByEmail.get(email);
  if (existing && existing.id !== id) return res.status(409).json({ error: 'Esse e-mail já está sendo usado por outra conta.' });

  statements.updateAccountForAdmin.run(name, email, teamId, id);
  res.json({ participants: statements.allAccountsForAdmin.all(), teams: statements.teamsForAllCompanies.all() });
});

app.put('/api/admin/campaign', authRequired, campaignAdminRequired, (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  const rewardText = typeof req.body?.rewardText === 'string' ? req.body.rewardText.trim() : '';
  const weeklyGoalMinutes = Number(req.body?.weeklyGoalMinutes);
  const periodType = req.body?.periodType;
  if (name.length < 2 || name.length > 80) return res.status(400).json({ error: 'O nome da campanha deve ter de 2 a 80 caracteres.' });
  if (rewardText.length > 160) return res.status(400).json({ error: 'A premiação deve ter até 160 caracteres.' });
  if (!Number.isInteger(weeklyGoalMinutes) || weeklyGoalMinutes < 1 || weeklyGoalMinutes > 10080) return res.status(400).json({ error: 'A meta deve estar entre 1 e 10.080 minutos.' });
  if (!['weekly', 'monthly'].includes(periodType)) return res.status(400).json({ error: 'Escolha um período semanal ou mensal.' });
  statements.updateCampaign.run(name, weeklyGoalMinutes, rewardText || 'Medalha digital e reconhecimento da equipe', periodType, req.adminCampaign.id);
  res.json({ campaign: statements.campaignByCompany.get(req.adminUser.companyId) });
});

app.post('/api/admin/challenges', authRequired, campaignAdminRequired, async (req, res) => {
  const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
  const description = typeof req.body?.description === 'string' ? req.body.description.trim() : '';
  const rewardText = typeof req.body?.rewardText === 'string' ? req.body.rewardText.trim() : '';
  const goalMinutes = Number(req.body?.goalMinutes);
  const periodType = req.body?.periodType;
  const startsOn = typeof req.body?.startsOn === 'string' ? req.body.startsOn : '';
  const endsOn = typeof req.body?.endsOn === 'string' ? req.body.endsOn : '';
  const coverData = req.body?.coverImage;
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;
  if (title.length < 2 || title.length > 80) return res.status(400).json({ error: 'O título deve ter de 2 a 80 caracteres.' });
  if (description.length > 240 || rewardText.length > 160) return res.status(400).json({ error: 'Descrição ou premiação excede o limite.' });
  if (!Number.isInteger(goalMinutes) || goalMinutes < 1 || goalMinutes > 10080) return res.status(400).json({ error: 'A meta deve ser de 1 a 10.080 minutos.' });
  if (!['weekly', 'monthly'].includes(periodType)) return res.status(400).json({ error: 'Escolha um período semanal ou mensal.' });
  if (!datePattern.test(startsOn) || !datePattern.test(endsOn)) return res.status(400).json({ error: 'Informe as datas de início e encerramento.' });
  const start = new Date(`${startsOn}T03:00:00.000Z`);
  const end = new Date(`${endsOn}T03:00:00.000Z`);
  end.setUTCDate(end.getUTCDate() + 1);
  const durationDays = (end - start) / 86400000;
  const maxDays = periodType === 'weekly' ? 7 : 31;
  if (durationDays < 1 || durationDays > maxDays) return res.status(400).json({ error: periodType === 'weekly' ? 'O desafio semanal deve durar de 1 a 7 dias.' : 'O desafio mensal deve durar de 1 a 31 dias.' });
  let coverFilename = null;
  if (coverData !== undefined && coverData !== null) {
    const match = typeof coverData === 'string' && coverData.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
    if (!match) return res.status(400).json({ error: 'Escolha uma capa JPEG, PNG ou WebP válida.' });
    const buffer = Buffer.from(match[2], 'base64');
    const validImage = match[1] === 'image/jpeg' ? buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))
      : match[1] === 'image/png' ? buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
        : buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
    if (!buffer.length || buffer.length > 5 * 1024 * 1024 || !validImage) return res.status(400).json({ error: 'A capa deve ser uma imagem válida de até 5 MB.' });
    const extension = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[match[1]];
    coverFilename = `${randomBytes(18).toString('hex')}.${extension}`;
    await mkdir(uploadsDirectory, { recursive: true });
    await writeFile(resolve(uploadsDirectory, coverFilename), buffer, { flag: 'wx' });
  }
  try {
    statements.createChallenge.run({
      campaignId: req.adminCampaign.id,
      title,
      description,
      goalMinutes,
      periodType,
      startsAt: start.toISOString(),
      endsAt: end.toISOString(),
      rewardText,
      createdBy: req.adminUser.id,
      coverImage: coverFilename,
    });
  } catch (error) {
    if (coverFilename) await unlink(resolve(uploadsDirectory, coverFilename)).catch(() => {});
    throw error;
  }
  res.status(201).json({ challenges: statements.challengesForCampaign.all(req.adminCampaign.id).map(challengeWithCover) });
});

app.delete('/api/admin/challenges/:id', authRequired, campaignAdminRequired, async (req, res) => {
  const id = Number(req.params.id);
  if (!statements.challengeById.get(id, req.adminCampaign.id)) return res.status(404).json({ error: 'Desafio não encontrado.' });
  const { coverImage } = statements.challengeCoverById.get(id, req.adminCampaign.id) || {};
  statements.deleteChallenge.run(id, req.adminCampaign.id);
  if (coverImage) await unlink(resolve(uploadsDirectory, coverImage)).catch((error) => { if (error.code !== 'ENOENT') console.error('Não foi possível remover a capa do desafio.', error); });
  res.status(204).end();
});

app.delete('/api/teams/:id', authRequired, campaignAdminRequired, (req, res) => {
  const teamId = Number(req.params.id);
  const team = statements.teamByIdAndCompany.get(teamId, req.adminUser.companyId);
  if (!team) return res.status(404).json({ error: 'Equipe não encontrada.' });
  statements.deleteTeam.run(teamId, req.adminUser.companyId);
  res.status(204).end();
});

app.post('/api/teams/join', authRequired, (req, res) => {
  const user = statements.publicUserById.get(req.session.userId);
  const teamId = Number(req.body?.teamId);
  if (!user?.companyId) return res.status(400).json({ error: 'Entre em uma campanha antes de escolher uma equipe.' });
  const result = statements.joinTeam.run(teamId, user.id, user.companyId);
  if (!result.changes) return res.status(404).json({ error: 'Equipe não encontrada nesta campanha.' });
  res.json({ user: publicUser(user.id) });
});

app.put('/api/privacy', authRequired, (req, res) => {
  const showInRanking = req.body?.showInRanking === false ? 0 : req.body?.showInRanking === true ? 1 : null;
  const shareActivities = req.body?.shareActivities === false ? 0 : req.body?.shareActivities === true ? 1 : null;
  const shareProfilePhoto = req.body?.shareProfilePhoto === false ? 0 : req.body?.shareProfilePhoto === true ? 1 : null;
  if (showInRanking === null || shareActivities === null || shareProfilePhoto === null) return res.status(400).json({ error: 'Escolha as opções de visibilidade do perfil.' });
  statements.updatePrivacy.run(showInRanking, shareActivities, shareProfilePhoto, req.session.userId);
  res.json({ user: publicUser(req.session.userId) });
});

app.post('/api/activities/sync', authRequired, (req, res) => {
  const activities = req.body?.activities;
  if (!Array.isArray(activities) || activities.length > 500) return res.status(400).json({ error: 'Lista de atividades inválida.' });
  const insert = database.transaction((items) => {
    let created = 0;
    for (const activity of items) {
      const error = validActivity(activity);
      if (error) throw Object.assign(new Error(error), { status: 400 });
      const result = statements.syncActivity.run({
        id: activity.id,
        userId: req.session.userId,
        mode: activity.mode,
        activityType: activity.activityType || activity.mode,
        averageHeartRate: activity.averageHeartRate || null,
        maxHeartRate: activity.maxHeartRate || null,
        startedAt: new Date(activity.startedAt).toISOString(),
        durationSeconds: activity.durationSeconds,
        distanceKm: activity.distanceKm,
        routeJson: '[]',
      });
      created += result.changes;
    }
    return created;
  });
  try {
    const imported = insert(activities);
    res.json({ imported });
  } catch (error) {
    res.status(error.status || (error.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' ? 409 : 400)).json({ error: error.message });
  }
});

app.post('/api/activities', authRequired, async (req, res) => {
  const error = validActivity(req.body);
  if (error) return res.status(400).json({ error });
  if (req.body.shareRoute && !publicUser(req.session.userId)?.companyId) return res.status(400).json({ error: 'Entre em uma campanha antes de compartilhar um percurso.' });
  try {
    const mediaInput = Array.isArray(req.body.media) ? req.body.media : [];
    if (mediaInput.length > 4 || mediaInput.some((item) => typeof item?.data !== 'string' || !/^data:(image\/(jpeg|png|webp|gif)|video\/(mp4|webm|quicktime));base64,/.test(item.data))) {
      return res.status(400).json({ error: 'Escolha até quatro fotos ou vídeos compatíveis.' });
    }
    const media = [];
    for (const item of mediaInput) {
      const match = item.data.match(/^data:(image\/(?:jpeg|png|webp|gif)|video\/(?:mp4|webm|quicktime));base64,(.+)$/);
      if (!match) return res.status(400).json({ error: 'Arquivo de mídia inválido.' });
      const buffer = Buffer.from(match[2], 'base64');
      if (!buffer.length || buffer.length > 12 * 1024 * 1024) return res.status(400).json({ error: 'Cada foto ou vídeo deve ter no máximo 12 MB.' });
      const extension = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov' }[match[1]];
      const filename = `${randomBytes(18).toString('hex')}.${extension}`;
      await mkdir(uploadsDirectory, { recursive: true });
      await writeFile(resolve(uploadsDirectory, filename), buffer, { flag: 'wx' });
      media.push({ filename, url: `/api/media/${filename}`, type: match[1].startsWith('video/') ? 'video' : 'image' });
    }
    statements.createActivity.run({
      id: req.body.id,
      userId: req.session.userId,
      mode: req.body.mode,
      activityType: req.body.activityType || req.body.mode,
      startedAt: new Date(req.body.startedAt).toISOString(),
      durationSeconds: req.body.durationSeconds,
      distanceKm: req.body.distanceKm,
      averageHeartRate: req.body.averageHeartRate || null,
      maxHeartRate: req.body.maxHeartRate || null,
      routeJson: JSON.stringify(req.body.route || []),
      matchedRouteJson: JSON.stringify(await matchGpsRoute(req.body.route || [], req.body.mode)),
      shareRoute: req.body.shareRoute === true ? 1 : 0,
      mediaJson: JSON.stringify(media),
    });
    media.forEach((item) => statements.linkActivityMedia.run(item.filename, req.body.id));
    res.status(201).json({ activity: req.body });
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') return res.status(409).json({ error: 'Esta atividade já foi sincronizada.' });
    res.status(500).json({ error: 'Não foi possível salvar a atividade.' });
  }
});

app.put('/api/activities/:id', authRequired, async (req, res) => {
  const activityType = req.body?.activityType;
  const mode = req.body?.mode;
  const startedAt = req.body?.startedAt;
  const durationSeconds = req.body?.durationSeconds;
  const distanceKm = req.body?.distanceKm;
  if (typeof req.params.id !== 'string' || req.params.id.length > 80 || !/^[a-zA-Z0-9_-]+$/.test(req.params.id)) return res.status(400).json({ error: 'Identificador da atividade inválido.' });
  if (!activityTypes.has(activityType) || !['Caminhada', 'Corrida', 'Ciclismo'].includes(mode)) return res.status(400).json({ error: 'Modalidade de atividade inválida.' });
  if (typeof startedAt !== 'string' || Number.isNaN(Date.parse(startedAt))) return res.status(400).json({ error: 'Data de início inválida.' });
  if (!Number.isInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 48 * 60 * 60) return res.status(400).json({ error: 'Duração inválida. O limite é 48 horas.' });
  if (typeof distanceKm !== 'number' || !Number.isFinite(distanceKm) || distanceKm < 0 || distanceKm > 1000) return res.status(400).json({ error: 'Distância inválida.' });
  const owned = statements.ownedActivity.get(req.params.id, req.session.userId);
  if (!owned) return res.status(404).json({ error: 'Atividade não encontrada.' });
  const currentMedia = JSON.parse(owned.mediaJson || '[]');
  const mediaInput = Array.isArray(req.body?.media) ? req.body.media : [];
  if (mediaInput.length > 4 || currentMedia.length + mediaInput.length > 4 || mediaInput.some((item) => typeof item?.data !== 'string' || !/^data:(image\/(jpeg|png|webp|gif)|video\/(mp4|webm|quicktime));base64,/.test(item.data))) {
    return res.status(400).json({ error: 'A atividade aceita até quatro fotos ou vídeos compatíveis.' });
  }
  const addedMedia = [];
  try {
    for (const item of mediaInput) {
      const match = item.data.match(/^data:(image\/(?:jpeg|png|webp|gif)|video\/(?:mp4|webm|quicktime));base64,(.+)$/);
      if (!match) return res.status(400).json({ error: 'Arquivo de mídia inválido.' });
      const buffer = Buffer.from(match[2], 'base64');
      if (!buffer.length || buffer.length > 12 * 1024 * 1024) return res.status(400).json({ error: 'Cada foto ou vídeo deve ter no máximo 12 MB.' });
      const extension = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov' }[match[1]];
      const filename = `${randomBytes(18).toString('hex')}.${extension}`;
      await mkdir(uploadsDirectory, { recursive: true });
      await writeFile(resolve(uploadsDirectory, filename), buffer, { flag: 'wx' });
      addedMedia.push({ filename, url: `/api/media/${filename}`, type: match[1].startsWith('video/') ? 'video' : 'image' });
    }
  } catch (error) {
    await Promise.all(addedMedia.map((item) => unlink(resolve(uploadsDirectory, item.filename)).catch(() => {})));
    return res.status(500).json({ error: 'Não foi possível enviar as fotos ou vídeos.' });
  }
  const result = statements.updateActivityDetails.run({
    id: req.params.id,
    userId: req.session.userId,
    mode,
    activityType,
    startedAt: new Date(startedAt).toISOString(),
    durationSeconds,
    distanceKm,
  });
  if (!result.changes) return res.status(404).json({ error: 'Atividade não encontrada.' });
  if (addedMedia.length) {
    statements.updateActivityMedia.run(JSON.stringify([...currentMedia, ...addedMedia]), req.params.id, req.session.userId);
    addedMedia.forEach((item) => statements.linkActivityMedia.run(item.filename, req.params.id));
  }
  res.json({ updated: true, addedMedia: addedMedia.length });
});

app.delete('/api/activities/:id', authRequired, async (req, res) => {
  const activity = statements.ownedActivity.get(req.params.id, req.session.userId);
  if (!activity) return res.status(404).json({ error: 'Atividade não encontrada.' });
  const media = JSON.parse(activity.mediaJson || '[]');
  const result = statements.deleteActivity.run(req.params.id, req.session.userId);
  if (!result.changes) return res.status(404).json({ error: 'Atividade não encontrada.' });
  await Promise.all(media.map((item) => {
    const filename = item.url?.split('/').pop();
    if (!filename || !/^[a-f0-9]{36}\.(jpg|png|webp|gif|mp4|webm|mov)$/.test(filename)) return Promise.resolve();
    return unlink(resolve(uploadsDirectory, filename)).catch((error) => { if (error.code !== 'ENOENT') console.error('Não foi possível remover mídia da atividade.', error); });
  }));
  res.status(204).end();
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'Rota da API não encontrada.' }));
const publicDirectory = isProduction ? resolve(root, 'dist') : root;
app.get(['/', '/index.html'], (req, res) => {
  const user = req.session.userId ? publicUser(req.session.userId) : null;
  if (!user) {
    if (req.session.userId) req.session.destroy(() => {});
    return res.redirect(302, '/login.html');
  }
  res.sendFile(resolve(publicDirectory, 'index.html'));
});
app.use(express.static(publicDirectory, { index: 'index.html', extensions: ['html'] }));
app.use((error, _req, res, _next) => {
  console.error(error);
  if (res.headersSent) return;
  res.status(500).json({ error: 'Ocorreu um erro no servidor.' });
});

const server = app.listen(port, host, () => console.log(`VIP Go em http://${host}:${port}`));
function startValhalla() {
  if (!process.env.VALHALLA_BIN || !process.env.VALHALLA_CONFIG || shuttingDown) return;
  valhallaProcess = spawn(process.env.VALHALLA_BIN, [process.env.VALHALLA_CONFIG, process.env.VALHALLA_CONCURRENCY || '2'], {
    stdio: 'ignore',
    env: { ...process.env, PATH: `${dirname(process.env.VALHALLA_BIN)}:${process.env.PATH || ''}` },
  });
  valhallaProcess.on('error', (error) => console.error('Não foi possível iniciar o serviço local de mapas:', error.message));
  valhallaProcess.on('exit', (code, signal) => {
    valhallaProcess = null;
    if (shuttingDown) return;
    console.error(`Serviço local de mapas encerrou (${signal || code}); nova tentativa em 5 segundos.`);
    setTimeout(startValhalla, 5000).unref();
  });
}
startValhalla();
async function rematchStoredRoutes() {
  if (!process.env.VALHALLA_URL) return;
  for (let attempt = 0; attempt < 60 && !shuttingDown; attempt += 1) {
    try {
      const health = await fetch(`${process.env.VALHALLA_URL.replace(/\/$/, '')}/status`, { signal: AbortSignal.timeout(1500) });
      if (health.ok) break;
    } catch { /* Wait until the local routing process finishes loading its tiles. */ }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  if (shuttingDown) return;
  try {
    const health = await fetch(`${process.env.VALHALLA_URL.replace(/\/$/, '')}/status`, { signal: AbortSignal.timeout(1500) });
    if (!health.ok) return;
  } catch { return; }
  const pending = statements.activitiesNeedingMatch.all();
  for (const activity of pending) {
    if (shuttingDown) return;
    const route = await matchGpsRoute(JSON.parse(activity.routeJson || '[]'), activity.mode);
    if (route.length >= 2) statements.saveMatchedRoute.run(JSON.stringify(route), activity.id);
  }
  if (pending.length) console.log(`Percursos GPS ajustados às ruas: ${pending.length}.`);
}
setTimeout(() => { void rematchStoredRoutes(); }, 1000).unref();
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  shuttingDown = true;
  valhallaProcess?.kill('SIGTERM');
  server.close(() => { sessionStore.close(); database.close(); process.exit(0); });
});
