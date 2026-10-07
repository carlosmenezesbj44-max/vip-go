import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dataDirectory = resolve(here, 'data');
mkdirSync(dataDirectory, { recursive: true });

export const database = new Database(resolve(dataDirectory, 'vip-go.sqlite'));
database.pragma('journal_mode = WAL');
database.pragma('foreign_keys = ON');
database.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS activities (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    mode TEXT NOT NULL CHECK (mode IN ('Caminhada', 'Corrida', 'Ciclismo')),
    started_at TEXT NOT NULL,
    duration_seconds INTEGER NOT NULL CHECK (duration_seconds > 0),
    distance_km REAL NOT NULL CHECK (distance_km >= 0),
    route_json TEXT NOT NULL DEFAULT '[]',
    activity_type TEXT,
    average_heart_rate INTEGER,
    max_heart_rate INTEGER,
    share_route INTEGER NOT NULL DEFAULT 0 CHECK (share_route IN (0, 1)),
    media_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL,
    session_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS companies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    join_code TEXT NOT NULL UNIQUE COLLATE NOCASE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS campaigns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    weekly_goal_minutes INTEGER NOT NULL DEFAULT 150,
    reward_text TEXT NOT NULL DEFAULT 'Medalha digital e reconhecimento da equipe',
    period_type TEXT NOT NULL DEFAULT 'weekly',
    admin_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    starts_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ends_at TEXT
  );
  CREATE TABLE IF NOT EXISTS campaign_admins (
    campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (campaign_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS teams (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(company_id, name)
  );
  CREATE TABLE IF NOT EXISTS challenges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    goal_minutes INTEGER NOT NULL,
    period_type TEXT NOT NULL CHECK (period_type IN ('weekly', 'monthly')),
    starts_at TEXT NOT NULL,
    ends_at TEXT NOT NULL,
    reward_text TEXT NOT NULL DEFAULT '',
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS challenge_participants (
    challenge_id INTEGER NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    accepted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (challenge_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS follows (
    follower_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    followed_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (follower_id, followed_id),
    CHECK (follower_id <> followed_id)
  );
  CREATE TABLE IF NOT EXISTS community_posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT NOT NULL DEFAULT '',
    media_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS communities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    creator_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    join_code TEXT NOT NULL UNIQUE COLLATE NOCASE,
    discoverable INTEGER NOT NULL DEFAULT 1 CHECK (discoverable IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS community_members (
    community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (community_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS community_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS community_reactions (
    post_id INTEGER NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (post_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS activity_media (
    filename TEXT PRIMARY KEY,
    activity_id TEXT NOT NULL REFERENCES activities(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS sessions_expires_at ON sessions(expires_at);
  CREATE INDEX IF NOT EXISTS activities_user_started ON activities(user_id, started_at DESC);
  CREATE INDEX IF NOT EXISTS community_members_user ON community_members(user_id, community_id);
`);

const existingCampaignColumns = new Set(database.prepare('PRAGMA table_info(campaigns)').all().map((column) => column.name));
if (!existingCampaignColumns.has('reward_text')) database.exec("ALTER TABLE campaigns ADD COLUMN reward_text TEXT NOT NULL DEFAULT 'Medalha digital e reconhecimento da equipe'");
if (!existingCampaignColumns.has('period_type')) database.exec("ALTER TABLE campaigns ADD COLUMN period_type TEXT NOT NULL DEFAULT 'weekly'");
if (!existingCampaignColumns.has('admin_user_id')) database.exec('ALTER TABLE campaigns ADD COLUMN admin_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL');

const existingUserColumns = new Set(database.prepare('PRAGMA table_info(users)').all().map((column) => column.name));
if (!existingUserColumns.has('company_id')) database.exec('ALTER TABLE users ADD COLUMN company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL');
if (!existingUserColumns.has('team_id')) database.exec('ALTER TABLE users ADD COLUMN team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL');
if (!existingUserColumns.has('show_in_ranking')) database.exec('ALTER TABLE users ADD COLUMN show_in_ranking INTEGER NOT NULL DEFAULT 1');
if (!existingUserColumns.has('share_activities')) database.exec('ALTER TABLE users ADD COLUMN share_activities INTEGER NOT NULL DEFAULT 1');
if (!existingUserColumns.has('profile_photo')) database.exec('ALTER TABLE users ADD COLUMN profile_photo TEXT');
if (!existingUserColumns.has('share_profile_photo')) database.exec('ALTER TABLE users ADD COLUMN share_profile_photo INTEGER NOT NULL DEFAULT 1');
const existingActivityColumns = new Set(database.prepare('PRAGMA table_info(activities)').all().map((column) => column.name));
if (!existingActivityColumns.has('media_json')) database.exec("ALTER TABLE activities ADD COLUMN media_json TEXT NOT NULL DEFAULT '[]'");
if (!existingActivityColumns.has('share_route')) database.exec('ALTER TABLE activities ADD COLUMN share_route INTEGER NOT NULL DEFAULT 0');
if (!existingActivityColumns.has('activity_type')) database.exec('ALTER TABLE activities ADD COLUMN activity_type TEXT');
if (!existingActivityColumns.has('average_heart_rate')) database.exec('ALTER TABLE activities ADD COLUMN average_heart_rate INTEGER');
if (!existingActivityColumns.has('max_heart_rate')) database.exec('ALTER TABLE activities ADD COLUMN max_heart_rate INTEGER');
if (!existingActivityColumns.has('matched_route_json')) database.exec("ALTER TABLE activities ADD COLUMN matched_route_json TEXT NOT NULL DEFAULT '[]'");
const existingCommunityPostColumns = new Set(database.prepare('PRAGMA table_info(community_posts)').all().map((column) => column.name));
if (!existingCommunityPostColumns.has('community_id')) database.exec('ALTER TABLE community_posts ADD COLUMN community_id INTEGER REFERENCES communities(id) ON DELETE CASCADE');
const existingChallengeColumns = new Set(database.prepare('PRAGMA table_info(challenges)').all().map((column) => column.name));
if (!existingChallengeColumns.has('cover_image')) database.exec('ALTER TABLE challenges ADD COLUMN cover_image TEXT');
database.exec(`UPDATE campaigns SET admin_user_id = (
  SELECT id FROM users WHERE users.company_id = campaigns.company_id ORDER BY users.created_at, users.id LIMIT 1
) WHERE admin_user_id IS NULL AND EXISTS (SELECT 1 FROM users WHERE users.company_id = campaigns.company_id)`);

database.prepare('INSERT OR IGNORE INTO companies (name, join_code) VALUES (?, ?)').run('VIP Go', 'VIPGO2026');
const defaultCompany = database.prepare('SELECT id FROM companies WHERE join_code = ?').get('VIPGO2026');
database.prepare('INSERT INTO campaigns (company_id, name, weekly_goal_minutes) SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM campaigns WHERE company_id = ?)')
  .run(defaultCompany.id, 'Movimento VIP Go', 150, defaultCompany.id);
// A campanha de demonstração é administrada pela primeira conta que entrar com o código padrão.
database.prepare(`UPDATE campaigns SET admin_user_id = (
  SELECT id FROM users WHERE company_id = campaigns.company_id ORDER BY id LIMIT 1
) WHERE company_id = ? AND admin_user_id IS NULL AND EXISTS (
  SELECT 1 FROM users WHERE company_id = campaigns.company_id
)`).run(defaultCompany.id);
database.prepare('INSERT OR IGNORE INTO campaign_admins (campaign_id, user_id) SELECT id, admin_user_id FROM campaigns WHERE admin_user_id IS NOT NULL').run();

export const statements = {
  createUser: database.prepare('INSERT INTO users (name, email, password_hash, company_id) VALUES (@name, @email, @passwordHash, @companyId)'),
  userByEmail: database.prepare('SELECT id, name, email, password_hash FROM users WHERE email = ? COLLATE NOCASE'),
  userAccountByEmail: database.prepare('SELECT id, name, email, company_id AS companyId FROM users WHERE email = ? COLLATE NOCASE'),
  publicUserById: database.prepare('SELECT u.id, u.name, u.email, u.created_at AS createdAt, u.company_id AS companyId, c.name AS companyName, u.team_id AS teamId, t.name AS teamName, u.show_in_ranking AS showInRanking, u.share_activities AS shareActivities, u.profile_photo AS profilePhoto, u.share_profile_photo AS shareProfilePhoto FROM users u LEFT JOIN companies c ON c.id = u.company_id LEFT JOIN teams t ON t.id = u.team_id WHERE u.id = ?'),
  companyByCode: database.prepare('SELECT id, name, join_code AS joinCode FROM companies WHERE join_code = ? COLLATE NOCASE'),
  companyById: database.prepare('SELECT id, name, join_code AS joinCode FROM companies WHERE id = ?'),
  createCompany: database.prepare('INSERT INTO companies (name, join_code) VALUES (?, ?)'),
  createCampaign: database.prepare('INSERT INTO campaigns (company_id, name, weekly_goal_minutes, reward_text, period_type, admin_user_id) VALUES (?, ?, ?, ?, ?, ?)'),
  joinCompany: database.prepare('UPDATE users SET company_id = ?, team_id = NULL WHERE id = ?'),
  teamsForCompany: database.prepare('SELECT id, name FROM teams WHERE company_id = ? ORDER BY name'),
  createTeam: database.prepare('INSERT INTO teams (company_id, name) VALUES (?, ?)'),
  teamByIdAndCompany: database.prepare('SELECT id FROM teams WHERE id = ? AND company_id = ?'),
  deleteTeam: database.prepare('DELETE FROM teams WHERE id = ? AND company_id = ?'),
  joinTeam: database.prepare('UPDATE users SET team_id = ? WHERE id = ? AND company_id = ?'),
  updatePrivacy: database.prepare('UPDATE users SET show_in_ranking = ?, share_activities = ?, share_profile_photo = ? WHERE id = ?'),
  updateProfilePhoto: database.prepare('UPDATE users SET profile_photo = ? WHERE id = ?'),
  campaignByCompany: database.prepare('SELECT id, name, weekly_goal_minutes AS weeklyGoalMinutes, reward_text AS rewardText, period_type AS periodType, admin_user_id AS adminUserId, starts_at AS startsAt, ends_at AS endsAt FROM campaigns WHERE company_id = ? ORDER BY id DESC LIMIT 1'),
  isCampaignAdmin: database.prepare('SELECT 1 AS isAdmin FROM campaign_admins WHERE campaign_id = ? AND user_id = ?'),
  campaignAdmins: database.prepare('SELECT u.id, u.name, u.email, (c.admin_user_id = u.id) AS isPrimary FROM campaign_admins ca JOIN users u ON u.id = ca.user_id JOIN campaigns c ON c.id = ca.campaign_id WHERE ca.campaign_id = ? ORDER BY isPrimary DESC, u.name COLLATE NOCASE'),
  campaignParticipants: database.prepare('SELECT u.id, u.name, u.email, u.created_at AS createdAt, u.team_id AS teamId, t.name AS teamName, u.show_in_ranking AS showInRanking, u.share_activities AS shareActivities, u.share_profile_photo AS shareProfilePhoto, (c.admin_user_id = u.id OR EXISTS (SELECT 1 FROM campaign_admins ca WHERE ca.campaign_id = c.id AND ca.user_id = u.id)) AS isAdmin FROM users u JOIN companies co ON co.id = u.company_id JOIN campaigns c ON c.company_id = co.id LEFT JOIN teams t ON t.id = u.team_id WHERE co.id = ? ORDER BY u.name COLLATE NOCASE, u.id'),
  campaignParticipantById: database.prepare('SELECT id FROM users WHERE id = ? AND company_id = ?'),
  updateCampaignParticipant: database.prepare('UPDATE users SET name = ?, email = ?, team_id = ? WHERE id = ? AND company_id = ?'),
  allAccountsForAdmin: database.prepare('SELECT u.id, u.name, u.email, u.created_at AS createdAt, u.company_id AS companyId, co.name AS companyName, u.team_id AS teamId, t.name AS teamName, u.show_in_ranking AS showInRanking, u.share_activities AS shareActivities, u.share_profile_photo AS shareProfilePhoto, (EXISTS (SELECT 1 FROM campaigns c WHERE c.admin_user_id = u.id) OR EXISTS (SELECT 1 FROM campaign_admins ca WHERE ca.user_id = u.id)) AS isAdmin FROM users u LEFT JOIN companies co ON co.id = u.company_id LEFT JOIN teams t ON t.id = u.team_id ORDER BY u.name COLLATE NOCASE, u.id'),
  accountForAdminById: database.prepare('SELECT id, company_id AS companyId FROM users WHERE id = ?'),
  teamsForAllCompanies: database.prepare('SELECT id, company_id AS companyId, name FROM teams ORDER BY company_id, name COLLATE NOCASE'),
  updateAccountForAdmin: database.prepare('UPDATE users SET name = ?, email = ?, team_id = ? WHERE id = ?'),
  addCampaignAdmin: database.prepare('INSERT OR IGNORE INTO campaign_admins (campaign_id, user_id) VALUES (?, ?)'),
  updateCampaign: database.prepare('UPDATE campaigns SET name = ?, weekly_goal_minutes = ?, reward_text = ?, period_type = ? WHERE id = ?'),
  claimCampaignAdmin: database.prepare('UPDATE campaigns SET admin_user_id = ? WHERE company_id = ? AND admin_user_id IS NULL'),
  companySummary: database.prepare('SELECT COUNT(*) AS participantCount, SUM(CASE WHEN show_in_ranking = 1 THEN 1 ELSE 0 END) AS visibleParticipantCount, COUNT(DISTINCT team_id) AS teamCount FROM users WHERE company_id = ?'),
  challengesForCampaign: database.prepare('SELECT id, title, description, goal_minutes AS goalMinutes, period_type AS periodType, starts_at AS startsAt, ends_at AS endsAt, reward_text AS rewardText, cover_image AS coverImage FROM challenges WHERE campaign_id = ? ORDER BY starts_at DESC, id DESC'),
  createChallenge: database.prepare('INSERT INTO challenges (campaign_id, title, description, goal_minutes, period_type, starts_at, ends_at, reward_text, created_by, cover_image) VALUES (@campaignId, @title, @description, @goalMinutes, @periodType, @startsAt, @endsAt, @rewardText, @createdBy, @coverImage)'),
  deleteChallenge: database.prepare('DELETE FROM challenges WHERE id = ? AND campaign_id = ?'),
  challengeCoverByFilename: database.prepare('SELECT campaign_id AS campaignId FROM challenges WHERE cover_image = ?'),
  challengeCoverById: database.prepare('SELECT cover_image AS coverImage FROM challenges WHERE id = ? AND campaign_id = ?'),
  challengeById: database.prepare('SELECT id, starts_at AS startsAt, ends_at AS endsAt FROM challenges WHERE id = ? AND campaign_id = ?'),
  challengeProgress: database.prepare('SELECT COALESCE(SUM(duration_seconds), 0) AS durationSeconds, COUNT(*) AS activityCount FROM activities WHERE user_id = ? AND started_at >= ? AND started_at < ?'),
  acceptedChallenge: database.prepare('SELECT accepted_at AS acceptedAt FROM challenge_participants WHERE challenge_id = ? AND user_id = ?'),
  acceptChallenge: database.prepare('INSERT OR IGNORE INTO challenge_participants (challenge_id, user_id) VALUES (?, ?)'),
  weeklyActivities: database.prepare("SELECT u.id AS userId, u.name, u.show_in_ranking AS showInRanking, u.team_id AS teamId, t.name AS teamName, COALESCE(SUM(a.duration_seconds), 0) AS durationSeconds, COUNT(a.id) AS activityCount FROM users u LEFT JOIN activities a ON a.user_id = u.id AND a.started_at >= ? AND a.started_at < ? LEFT JOIN teams t ON t.id = u.team_id WHERE u.company_id = ? GROUP BY u.id ORDER BY durationSeconds DESC, u.name"),
  activityFeed: database.prepare("SELECT COALESCE(a.activity_type, a.mode) AS mode, a.started_at AS startedAt, a.duration_seconds AS durationSeconds, a.distance_km AS distanceKm, u.name FROM activities a JOIN users u ON u.id = a.user_id WHERE u.company_id = ? AND u.share_activities = 1 ORDER BY a.started_at DESC LIMIT 10"),
  campaignPeople: database.prepare("SELECT u.id, u.name, u.team_id AS teamId, t.name AS teamName, u.profile_photo AS profilePhoto, u.share_profile_photo AS shareProfilePhoto, u.share_activities AS shareActivities, (SELECT COUNT(*) FROM follows f WHERE f.follower_id = @viewerId AND f.followed_id = u.id) AS isFollowing, (SELECT COUNT(*) FROM activities a WHERE a.user_id = u.id AND u.share_activities = 1) AS activityCount FROM users u LEFT JOIN teams t ON t.id = u.team_id WHERE u.company_id = @companyId AND u.id <> @viewerId ORDER BY isFollowing DESC, u.name LIMIT 100"),
  sharedActivityFeed: database.prepare("SELECT a.id, COALESCE(a.activity_type, a.mode) AS mode, a.started_at AS startedAt, a.duration_seconds AS durationSeconds, a.distance_km AS distanceKm, a.media_json AS mediaJson, u.id AS userId, u.name, u.profile_photo AS profilePhoto, u.share_profile_photo AS shareProfilePhoto, t.name AS teamName FROM activities a JOIN users u ON u.id = a.user_id LEFT JOIN teams t ON t.id = u.team_id WHERE u.company_id = @companyId AND u.share_activities = 1 AND (u.id = @viewerId OR EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = @viewerId AND f.followed_id = u.id)) ORDER BY a.started_at DESC LIMIT 50"),
  communityPosts: database.prepare("SELECT p.id, p.body, p.media_json AS mediaJson, p.created_at AS createdAt, u.id AS userId, u.name, CASE WHEN u.share_profile_photo = 1 THEN u.profile_photo ELSE NULL END AS profilePhoto, (SELECT COUNT(*) FROM community_reactions r WHERE r.post_id = p.id) AS reactionCount, EXISTS(SELECT 1 FROM community_reactions r WHERE r.post_id = p.id AND r.user_id = @viewerId) AS reacted, (SELECT COUNT(*) FROM community_comments c WHERE c.post_id = p.id) AS commentCount FROM community_posts p JOIN users u ON u.id = p.user_id WHERE (u.company_id = @companyId AND p.community_id IS NULL) OR EXISTS (SELECT 1 FROM community_members m WHERE m.community_id = p.community_id AND m.user_id = @viewerId) ORDER BY p.created_at DESC, p.id DESC LIMIT 50"),
  createCommunityPost: database.prepare('INSERT INTO community_posts (user_id, community_id, body, media_json) VALUES (?, ?, ?, ?)'),
  communityPostById: database.prepare('SELECT p.id, p.user_id AS userId, p.community_id AS communityId, u.company_id AS companyId FROM community_posts p JOIN users u ON u.id = p.user_id WHERE p.id = ?'),
  postsForCommunity: database.prepare("SELECT p.id, p.body, p.media_json AS mediaJson, p.created_at AS createdAt, u.id AS userId, u.name, CASE WHEN u.share_profile_photo = 1 THEN u.profile_photo ELSE NULL END AS profilePhoto, (SELECT COUNT(*) FROM community_reactions r WHERE r.post_id = p.id) AS reactionCount, EXISTS(SELECT 1 FROM community_reactions r WHERE r.post_id = p.id AND r.user_id = @viewerId) AS reacted, (SELECT COUNT(*) FROM community_comments c WHERE c.post_id = p.id) AS commentCount FROM community_posts p JOIN users u ON u.id = p.user_id WHERE p.community_id = @communityId ORDER BY p.created_at DESC, p.id DESC LIMIT 100"),
  communityById: database.prepare('SELECT id, name, description, join_code AS joinCode, creator_id AS creatorId, (SELECT COUNT(*) FROM community_members m WHERE m.community_id = communities.id) AS memberCount FROM communities WHERE id = ?'),
  communitiesForUser: database.prepare("SELECT c.id, c.name, c.description, c.join_code AS joinCode, c.creator_id AS creatorId, c.created_at AS createdAt, (SELECT COUNT(*) FROM community_members m WHERE m.community_id = c.id) AS memberCount, EXISTS(SELECT 1 FROM community_members m WHERE m.community_id = c.id AND m.user_id = @userId) AS isMember FROM communities c WHERE c.discoverable = 1 OR EXISTS(SELECT 1 FROM community_members m WHERE m.community_id = c.id AND m.user_id = @userId) ORDER BY isMember DESC, memberCount DESC, c.name COLLATE NOCASE LIMIT 200"),
  createCommunity: database.prepare('INSERT INTO communities (creator_id, name, description, join_code) VALUES (?, ?, ?, ?)'),
  addCommunityMember: database.prepare('INSERT OR IGNORE INTO community_members (community_id, user_id) VALUES (?, ?)'),
  isCommunityMember: database.prepare('SELECT 1 FROM community_members WHERE community_id = ? AND user_id = ?'),
  communitiesForDirectory: database.prepare("SELECT c.id, c.name, c.description, c.join_code AS joinCode, c.creator_id AS creatorId, c.created_at AS createdAt, (SELECT COUNT(*) FROM community_members m WHERE m.community_id = c.id) AS memberCount, EXISTS(SELECT 1 FROM community_members m WHERE m.community_id = c.id AND m.user_id = @userId) AS isMember FROM communities c WHERE c.discoverable = 1 AND (c.name LIKE @query COLLATE NOCASE OR c.join_code = @code COLLATE NOCASE) ORDER BY memberCount DESC, c.name COLLATE NOCASE LIMIT 100"),
  communityComments: database.prepare("SELECT c.id, c.body, c.created_at AS createdAt, u.id AS userId, u.name, CASE WHEN u.share_profile_photo = 1 THEN u.profile_photo ELSE NULL END AS profilePhoto FROM community_comments c JOIN users u ON u.id = c.user_id WHERE c.post_id = ? ORDER BY c.created_at, c.id LIMIT 100"),
  createCommunityComment: database.prepare('INSERT INTO community_comments (post_id, user_id, body) VALUES (?, ?, ?)'),
  toggleCommunityReaction: database.prepare('INSERT OR IGNORE INTO community_reactions (post_id, user_id) VALUES (?, ?)'),
  removeCommunityReaction: database.prepare('DELETE FROM community_reactions WHERE post_id = ? AND user_id = ?'),
  communityReactionExists: database.prepare('SELECT 1 FROM community_reactions WHERE post_id = ? AND user_id = ?'),
  follow: database.prepare('INSERT OR IGNORE INTO follows (follower_id, followed_id) VALUES (?, ?)'),
  unfollow: database.prepare('DELETE FROM follows WHERE follower_id = ? AND followed_id = ?'),
  followedUser: database.prepare('SELECT id FROM users WHERE id = ? AND company_id = ?'),
  profilePhotoOwner: database.prepare('SELECT id, company_id AS companyId, profile_photo AS profilePhoto, share_profile_photo AS shareProfilePhoto FROM users WHERE profile_photo = ?'),
  sharedCommunityMembers: database.prepare('SELECT 1 FROM community_members a JOIN community_members b ON b.community_id = a.community_id WHERE a.user_id = ? AND b.user_id = ? LIMIT 1'),
  sharedMediaActivity: database.prepare("SELECT a.id AS activityId, a.media_json AS mediaJson, u.id AS userId, u.company_id AS companyId, u.share_activities AS shareActivities FROM activity_media m JOIN activities a ON a.id = m.activity_id JOIN users u ON u.id = a.user_id WHERE m.filename = ?"),
  linkActivityMedia: database.prepare('INSERT INTO activity_media (filename, activity_id) VALUES (?, ?)'),
  isFollowing: database.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND followed_id = ?'),
  userLifetime: database.prepare('SELECT COALESCE(SUM(duration_seconds), 0) AS totalSeconds, COUNT(*) AS activityCount FROM activities WHERE user_id = ?'),
  listActivities: database.prepare('SELECT id, mode, COALESCE(activity_type, mode) AS activityType, started_at AS startedAt, duration_seconds AS durationSeconds, distance_km AS distanceKm, average_heart_rate AS averageHeartRate, max_heart_rate AS maxHeartRate, route_json AS routeJson, matched_route_json AS matchedRouteJson, share_route AS shareRoute, media_json AS mediaJson FROM activities WHERE user_id = ? ORDER BY started_at DESC'),
  activitiesNeedingMatch: database.prepare("SELECT id, mode, route_json AS routeJson FROM activities WHERE matched_route_json = '[]' AND route_json <> '[]' ORDER BY started_at DESC"),
  saveMatchedRoute: database.prepare("UPDATE activities SET matched_route_json = ? WHERE id = ? AND matched_route_json = '[]'"),
  createActivity: database.prepare('INSERT INTO activities (id, user_id, mode, activity_type, started_at, duration_seconds, distance_km, average_heart_rate, max_heart_rate, route_json, matched_route_json, share_route, media_json) VALUES (@id, @userId, @mode, @activityType, @startedAt, @durationSeconds, @distanceKm, @averageHeartRate, @maxHeartRate, @routeJson, @matchedRouteJson, @shareRoute, @mediaJson)'),
  ownedActivity: database.prepare('SELECT id, media_json AS mediaJson FROM activities WHERE id = ? AND user_id = ?'),
  updateActivityDetails: database.prepare('UPDATE activities SET mode = @mode, activity_type = @activityType, started_at = @startedAt, duration_seconds = @durationSeconds, distance_km = @distanceKm WHERE id = @id AND user_id = @userId'),
  updateActivityMedia: database.prepare('UPDATE activities SET media_json = ? WHERE id = ? AND user_id = ?'),
  mapRoutesForCompany: database.prepare("SELECT a.id, COALESCE(a.activity_type, a.mode) AS mode, a.started_at AS startedAt, a.duration_seconds AS durationSeconds, a.distance_km AS distanceKm, CASE WHEN a.matched_route_json <> '[]' THEN a.matched_route_json ELSE a.route_json END AS routeJson, a.matched_route_json AS matchedRouteJson, u.id AS userId, u.name FROM activities a JOIN users u ON u.id = a.user_id WHERE u.company_id = ? AND u.id <> ? AND u.share_activities = 1 AND a.share_route = 1 AND a.route_json <> '[]' ORDER BY a.started_at DESC LIMIT 100"),
  routeByOwner: database.prepare('SELECT id, route_json AS routeJson FROM activities WHERE id = ? AND user_id = ?'),
  updateRouteVisibility: database.prepare('UPDATE activities SET share_route = ? WHERE id = ? AND user_id = ?'),
  syncActivity: database.prepare('INSERT INTO activities (id, user_id, mode, activity_type, average_heart_rate, max_heart_rate, started_at, duration_seconds, distance_km, route_json) VALUES (@id, @userId, @mode, @activityType, @averageHeartRate, @maxHeartRate, @startedAt, @durationSeconds, @distanceKm, @routeJson) ON CONFLICT(id) DO NOTHING'),
  deleteActivity: database.prepare('DELETE FROM activities WHERE id = ? AND user_id = ?'),
};
