'use strict';
/*
 * FF Diamond — Free Fire Watch & Earn Platform (Complete Backend Server)
 * Zero npm dependencies: uses Node.js built-in http, crypto, fs, path, url only.
 *
 * Folder structure to run:
 *   project/
 *   ├── server.js
 *   └── public/
 *       └── index.html
 *
 * Start command:
 *   OWNER_USERNAME=admin OWNER_PASSWORD=yourpassword node server.js
 *
 * Dedicated Owner Link (Not shown on public pages):
 *   http://localhost:3000/owner   OR   http://localhost:3000/#/owner   OR   http://localhost:3000/?owner=1
 */

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'db.json');
const PUBLIC_DIR = path.resolve(__dirname, 'public');

const BLOCK_SEC = 60;                    // 60 verified seconds per earning block
const BLOCK_MILLI = 150;                 // 0.15 Diamond (150 milli-Diamonds) per 60s block (300 milli when 2X Boost)
const DEFAULT_LONG_DUR_SEC = 240;        // Safe fallback duration (4m) if owner enters 0 for Long video
const DEFAULT_SHORT_DUR_SEC = 45;        // Safe fallback duration (45s) if owner enters 0 for Short video
const REDEEM_MIN_MILLI = 100 * 1000;     // Minimum redeem = 100 Diamonds
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
const CHALLENGE_TTL_MS = 1000 * 60 * 10; // 10 minutes
const HEARTBEAT_TOLERANCE_SEC = 2.5;     // Slack for network jitter (blocks >1x speed hacks)

const STREAK_REQUIRE_SEC = 120;          // Watch 2 mins today to claim daily streak
const STREAK_REWARDS_MILLI = [200, 350, 500, 700, 900, 1200, 1500]; // Day 1..7 in milli-Diamonds
const SPIN_REQUIRE_SEC = 600;            // Watch 10 mins today to unlock Daily Lucky Spin
const SPIN_PRIZES_MILLI = [100, 150, 200, 300, 500, 750, 1000];
const REFERRAL_UNLOCK_SEC = 900;         // Friend must complete 15 mins (900s) verified watch
const REFERRAL_BONUS_MILLI = 2000;       // 2.00 Diamonds to both inviter and friend

const MISSIONS_DEF = {
  shorts2m: { id: 'shorts2m', title: 'Shorts Sprinter (Watch 2m Shorts)', rewardMilli: 200 },
  watch10m: { id: 'watch10m', title: 'Booyah Watcher (Watch 10m Videos)', rewardMilli: 350 },
  social:   { id: 'social',   title: 'Community Fan (1 Like + 1 Comment)', rewardMilli: 200 },
  chest:    { id: 'chest',    title: 'Daily Booyah Chest (Complete All 3)', rewardMilli: 500 },
};

// ---------------------------------------------------------------------------
// Date & Rank Helpers
// ---------------------------------------------------------------------------
function todayStr() {
  const istMs = Date.now() + (5.5 * 60 * 60 * 1000);
  return new Date(istMs).toISOString().slice(0, 10);
}

function yesterdayStr() {
  const istMs = Date.now() + (5.5 * 60 * 60 * 1000) - (24 * 60 * 60 * 1000);
  return new Date(istMs).toISOString().slice(0, 10);
}

function getRankInfo(totalWatchSec) {
  const mins = Math.floor((totalWatchSec || 0) / 60);
  if (mins >= 4500) return { name: 'Grandmaster', icon: '👑', nextMins: null };
  if (mins >= 2100) return { name: 'Heroic',      icon: '🔥', nextMins: 4500 };
  if (mins >= 900)  return { name: 'Diamond',     icon: '💎', nextMins: 2100 };
  if (mins >= 360)  return { name: 'Platinum',    icon: '💠', nextMins: 900 };
  if (mins >= 120)  return { name: 'Gold',        icon: '🥇', nextMins: 360 };
  if (mins >= 30)   return { name: 'Silver',      icon: '🥈', nextMins: 120 };
  return { name: 'Bronze', icon: '🥉', nextMins: 30 };
}

function ensureDailyStats(u) {
  const t = todayStr();
  if (!u.daily || u.daily.date !== t) {
    u.daily = {
      date: t,
      watchSec: 0,
      shortsSec: 0,
      likes: 0,
      comments: 0,
      spinUsed: false,
      streakClaimed: false,
      missionsClaimed: {},
    };
  }
  if (!u.daily.missionsClaimed || typeof u.daily.missionsClaimed !== 'object') {
    u.daily.missionsClaimed = {};
  }
  if (typeof u.streakDays !== 'number') u.streakDays = 0;
  if (typeof u.lastStreakDate !== 'string') u.lastStreakDate = '';
  if (!u.watchCredited || typeof u.watchCredited !== 'object') u.watchCredited = {};
  if (!u.promoClaimed || typeof u.promoClaimed !== 'object') u.promoClaimed = {};
  if (!u.referralCode) u.referralCode = u.username.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) + String(u.createdAt || Date.now()).slice(-3);
}

// ---------------------------------------------------------------------------
// Database initialization, migration & pruning
// ---------------------------------------------------------------------------
function emptyDb() {
  return {
    users: [],
    videos: [],
    sessions: [],
    challenges: [],
    watchSessions: [],
    watchHistory: [],
    ledger: [],
    redemptions: [],
    promoCodes: [],     // {id, code, rewardMilli, maxClaims, minDailyWatchSec, claimedBy: [], createdAt}
    promoInquiries: [], // {id, name, contact, channelUrl, promoType, message, status: 'new'|'read', createdAt}
    comments: [],       // {id, videoId, userId, username, rankIcon, rankName, text, at}
    settings: {
      broadcast: '🔥 Welcome to FF Diamond! Anyone can explore the platform, watch the Introduction Video, read Terms & Conditions, or send a Promotional Inquiry!',
      promoEmail: 'promotions@ffdiamond.com',
      introVideo: {
        youtubeId: 'dQw4w9WgXcQ',
        url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        title: 'Official Introduction — How FF Diamond Works & How to Redeem Free Fire Diamonds',
        description: 'Watch this introduction video to learn how you earn 0.15–0.30 💎 per minute, complete daily missions, and redeem Diamonds directly to your Free Fire UID.',
      },
      customRoom: {
        active: false,
        title: 'Sunday Booyah Custom Room — 500 💎 Prize Pool',
        matchTime: 'Sunday, 8:00 PM IST',
        prize: '500 💎 Top-Up for Booyah Winner',
        roomId: '',
        roomPass: '',
        minWatchMins: 15,
      },
    },
  };
}

function loadDb() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    const base = emptyDb();
    for (const k of Object.keys(base)) {
      if (k === 'settings') {
        parsed.settings = {
          ...base.settings,
          ...(parsed.settings || {}),
          introVideo: { ...base.settings.introVideo, ...((parsed.settings && parsed.settings.introVideo) || {}) },
          customRoom: { ...base.settings.customRoom, ...((parsed.settings && parsed.settings.customRoom) || {}) },
        };
      } else if (!Array.isArray(parsed[k])) {
        parsed[k] = base[k];
      }
    }
    for (const u of parsed.users) ensureDailyStats(u);
    for (const v of parsed.videos) {
      if (!Array.isArray(v.likedBy)) v.likedBy = [];
      if (typeof v.boost2x !== 'boolean') v.boost2x = false;
      if (!v.durationSec || v.durationSec < 10) {
        v.durationSec = v.type === 'Short' ? DEFAULT_SHORT_DUR_SEC : DEFAULT_LONG_DUR_SEC;
      }
    }
    return parsed;
  } catch {
    return emptyDb();
  }
}

let db = loadDb();

function pruneDb() {
  const now = Date.now();
  db.sessions = db.sessions.filter((s) => s.expiresAt > now);
  db.challenges = db.challenges.filter((c) => c.expiresAt > now);
  db.watchSessions = db.watchSessions.filter((ws) => ws.active || (now - ws.lastTs < 2 * 60 * 60 * 1000));
  if (db.watchHistory.length > 2000) db.watchHistory = db.watchHistory.slice(-2000);
  if (db.ledger.length > 3000) db.ledger = db.ledger.slice(-3000);
  if (db.comments.length > 1000) db.comments = db.comments.slice(-1000);
  if (db.promoInquiries.length > 500) db.promoInquiries = db.promoInquiries.slice(-500);
}

let cloudSyncTimer = null;
let cloudSyncStatus = 'Local disk only (Set GITHUB_TOKEN & GITHUB_GIST_ID on Render for permanent cloud storage)';

async function pushToCloudGist() {
  const token = (process.env.GITHUB_TOKEN || '').trim();
  const gistId = (process.env.GITHUB_GIST_ID || '').trim();
  if (!token || !gistId || typeof fetch !== 'function') return;
  try {
    const res = await fetch(`https://api.github.com/gists/${gistId}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'FF-Diamond-Server',
      },
      body: JSON.stringify({
        files: {
          'ff_diamond_db.json': { content: JSON.stringify(db, null, 2) },
        },
      }),
    });
    if (res.ok) {
      cloudSyncStatus = 'Connected & Synced to GitHub Gist (' + new Date().toLocaleTimeString() + ')';
    } else {
      cloudSyncStatus = 'Cloud Sync error: HTTP ' + res.status;
    }
  } catch (err) {
    cloudSyncStatus = 'Cloud Sync error: ' + err.message;
  }
}

async function pullFromCloudGistOnBoot() {
  const token = (process.env.GITHUB_TOKEN || '').trim();
  const gistId = (process.env.GITHUB_GIST_ID || '').trim();
  if (!token || !gistId || typeof fetch !== 'function') return;
  try {
    const res = await fetch(`https://api.github.com/gists/${gistId}`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'FF-Diamond-Server',
      },
    });
    if (!res.ok) return;
    const data = await res.json();
    const fileObj = data.files && (data.files['ff_diamond_db.json'] || Object.values(data.files)[0]);
    if (fileObj && fileObj.content) {
      const remoteDb = JSON.parse(fileObj.content);
      if (remoteDb && Array.isArray(remoteDb.videos)) {
        // Merge remote DB if local DB was wiped by Render sleep
        if (db.videos.length === 0 && remoteDb.videos.length > 0) {
          db = { ...emptyDb(), ...remoteDb };
          for (const u of db.users) ensureDailyStats(u);
          fs.mkdirSync(DATA_DIR, { recursive: true });
          fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
          console.log(`[cloud-sync] Restored ${db.videos.length} videos & ${db.users.length} users from GitHub Gist!`);
        }
        cloudSyncStatus = 'Connected & Synced with GitHub Gist';
      }
    }
  } catch (err) {
    console.log('[cloud-sync] Boot pull skipped:', err.message);
  }
}

function saveDb(immediateCloud) {
  pruneDb();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DATA_FILE);
  if (process.env.GITHUB_TOKEN && process.env.GITHUB_GIST_ID) {
    if (immediateCloud) {
      pushToCloudGist();
    } else if (!cloudSyncTimer) {
      cloudSyncTimer = setTimeout(() => {
        cloudSyncTimer = null;
        pushToCloudGist();
      }, 10000);
    }
  }
}

// ---------------------------------------------------------------------------
// Password hashing (Node crypto scrypt + timingSafeEqual)
// ---------------------------------------------------------------------------
function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}
function makePasswordRecord(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, passwordHash: hashPassword(password, salt) };
}
function verifyPassword(user, password) {
  if (!user || !user.salt || !user.passwordHash) return false;
  const candidate = Buffer.from(hashPassword(password, user.salt), 'hex');
  const stored = Buffer.from(user.passwordHash, 'hex');
  return candidate.length === stored.length && crypto.timingSafeEqual(candidate, stored);
}

// ---------------------------------------------------------------------------
// Owner bootstrap from environment variables
// ---------------------------------------------------------------------------
function bootstrapOwner() {
  const username = (process.env.OWNER_USERNAME || '').trim().toLowerCase();
  const password = process.env.OWNER_PASSWORD || '';
  if (!username || !password) {
    console.log('[owner] OWNER_USERNAME / OWNER_PASSWORD not set — set them in environment to create/sync the owner account.');
    return;
  }
  let owner = db.users.find((u) => u.username === username);
  for (const u of db.users) {
    if (u.role === 'owner' && u.username !== username) u.role = 'viewer';
  }
  if (!owner) {
    const rec = makePasswordRecord(password);
    owner = {
      id: crypto.randomUUID(),
      username,
      passwordHash: rec.passwordHash,
      salt: rec.salt,
      role: 'owner',
      ffUid: '',
      bio: 'Official Platform Owner',
      banned: false,
      createdAt: Date.now(),
      balanceMilli: 0,
      heldMilli: 0,
      totalEarnedMilli: 0,
      pendingSec: 0,
      totalWatchSec: 0,
      watchCredited: {},
      promoClaimed: {},
      referredBy: null,
      referralRewarded: false,
      referralCount: 0,
      referralEarnedMilli: 0,
    };
    ensureDailyStats(owner);
    db.users.push(owner);
    console.log(`[owner] Owner account created for @${username}.`);
  } else {
    owner.role = 'owner';
    owner.banned = false;
    const rec = makePasswordRecord(password);
    owner.passwordHash = rec.passwordHash;
    owner.salt = rec.salt;
    ensureDailyStats(owner);
    console.log(`[owner] Owner account @${username} synced from environment.`);
  }
  saveDb();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const USERNAME_RE = /^[a-z0-9._]{3,24}$/;
const UID_RE = /^[0-9]{5,16}$/;

function videoCapSec(video) {
  if (!video) return DEFAULT_LONG_DUR_SEC;
  if (video.durationSec && video.durationSec >= 10) return video.durationSec;
  return video.type === 'Short' ? DEFAULT_SHORT_DUR_SEC : DEFAULT_LONG_DUR_SEC;
}

function lifetimeCreditedSec(user, videoId) {
  if (!user.watchCredited || typeof user.watchCredited !== 'object') user.watchCredited = {};
  return user.watchCredited[videoId] || 0;
}

function publicUser(u) {
  ensureDailyStats(u);
  const rank = getRankInfo(u.totalWatchSec || 0);
  const yest = yesterdayStr();
  const today = todayStr();
  let nextStreakDay = 1;
  if (u.lastStreakDate === today) {
    nextStreakDay = u.streakDays || 1;
  } else if (u.lastStreakDate === yest) {
    nextStreakDay = Math.min(7, (u.streakDays || 0) + 1);
  }
  return {
    id: u.id,
    username: u.username,
    role: u.role,
    ffUid: u.ffUid || '',
    bio: u.bio || '',
    banned: !!u.banned,
    balanceMilli: u.balanceMilli || 0,
    heldMilli: u.heldMilli || 0,
    totalEarnedMilli: u.totalEarnedMilli || 0,
    pendingSec: Math.floor(u.pendingSec || 0),
    totalWatchSec: Math.floor(u.totalWatchSec || 0),
    watchCredited: u.watchCredited || {},
    rank,
    referralCode: u.referralCode,
    referralCount: u.referralCount || 0,
    referralEarnedMilli: u.referralEarnedMilli || 0,
    referredBy: u.referredBy || null,
    referralRewarded: !!u.referralRewarded,
    streakDays: u.streakDays || 0,
    nextStreakDay,
    daily: {
      date: u.daily.date,
      watchSec: Math.floor(u.daily.watchSec || 0),
      shortsSec: Math.floor(u.daily.shortsSec || 0),
      likes: u.daily.likes || 0,
      comments: u.daily.comments || 0,
      spinUsed: !!u.daily.spinUsed,
      streakClaimed: !!u.daily.streakClaimed,
      missionsClaimed: u.daily.missionsClaimed || {},
    },
  };
}

function serializeVideo(v, user) {
  const cap = videoCapSec(v);
  const credited = user ? Math.min(cap, Math.floor(lifetimeCreditedSec(user, v.id))) : 0;
  const likedBy = Array.isArray(v.likedBy) ? v.likedBy : [];
  return {
    id: v.id,
    youtubeId: v.youtubeId,
    url: v.url,
    title: v.title,
    type: v.type,
    category: v.category,
    durationSec: cap,
    views: v.views || 0,
    boost2x: !!v.boost2x,
    likesCount: likedBy.length,
    liked: user ? likedBy.includes(user.id) : false,
    userCreditedSec: credited,
    progressPct: cap > 0 ? Math.min(100, Math.round((credited / cap) * 100)) : 0,
    createdAt: v.createdAt,
  };
}

function extractYouTubeId(input) {
  if (!input || typeof input !== 'string') return null;
  const s = input.trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  let url;
  try { url = new URL(s); } catch { return null; }
  const host = url.hostname.replace(/^www\.|^m\./, '');
  if (host === 'youtu.be') {
    const id = url.pathname.slice(1).split('/')[0];
    return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
  }
  if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (url.pathname === '/watch') {
      const id = url.searchParams.get('v');
      return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
    }
    const m = url.pathname.match(/^\/(shorts|embed|live)\/([A-Za-z0-9_-]{11})/);
    if (m) return m[2];
  }
  return null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) { reject(new Error('Body too large')); req.destroy(); }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0',
  });
  res.end(body);
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.sessions.push({ token, userId, createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL_MS });
  saveDb();
  return token;
}

function authUser(req) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return null;
  const session = db.sessions.find((s) => s.token === token);
  if (!session || session.expiresAt < Date.now()) return null;
  const user = db.users.find((u) => u.id === session.userId) || null;
  if (user) ensureDailyStats(user);
  return user;
}

function requireAuth(req, res) {
  const user = authUser(req);
  if (!user) { sendJson(res, 401, { error: 'Please login or create a free account first.' }); return null; }
  if (user.banned && user.role !== 'owner') {
    sendJson(res, 403, { error: 'Your account has been suspended by the owner for policy violations.' });
    return null;
  }
  return user;
}

function requireOwner(req, res) {
  const user = requireAuth(req, res);
  if (!user) return null;
  if (user.role !== 'owner') { sendJson(res, 403, { error: 'Owner access only.' }); return null; }
  return user;
}

function creditUser(user, amountMilli, kind, note) {
  user.balanceMilli = (user.balanceMilli || 0) + amountMilli;
  if (amountMilli > 0) {
    user.totalEarnedMilli = (user.totalEarnedMilli || 0) + amountMilli;
  }
  db.ledger.push({
    id: crypto.randomUUID(),
    userId: user.id,
    kind,
    amountMilli,
    note,
    at: Date.now(),
  });
}

function buildPublicFeed(user) {
  const recentRedeems = db.redemptions
    .slice(-15)
    .reverse()
    .map((r) => ({
      username: r.username,
      amountMilli: r.amountMilli,
      packName: r.packName || `${r.amountMilli / 1000} 💎 Pack`,
      status: r.status,
      at: r.resolvedAt || r.createdAt,
    }));
  const leaderboard = db.users
    .filter((u) => !u.banned)
    .slice()
    .sort((a, b) => (b.totalWatchSec || 0) - (a.totalWatchSec || 0))
    .slice(0, 10)
    .map((u, idx) => {
      const rk = getRankInfo(u.totalWatchSec || 0);
      return {
        rankPos: idx + 1,
        username: u.username,
        rankName: rk.name,
        rankIcon: rk.icon,
        totalWatchSec: Math.floor(u.totalWatchSec || 0),
        totalEarnedMilli: u.totalEarnedMilli || 0,
      };
    });
  const cr = db.settings.customRoom || {};
  const watchMinsToday = user ? Math.floor((user.daily.watchSec || 0) / 60) : 0;
  const reqMins = Number(cr.minWatchMins) || 15;
  const unlocked = Boolean(user && (watchMinsToday >= reqMins || user.role === 'owner'));
  return {
    broadcast: db.settings.broadcast || '',
    promoEmail: db.settings.promoEmail || 'promotions@ffdiamond.com',
    introVideo: db.settings.introVideo || null,
    recentRedeems,
    leaderboard,
    customRoom: {
      active: !!cr.active,
      title: cr.title || 'Free Fire Custom Room Giveaway',
      matchTime: cr.matchTime || 'TBA',
      prize: cr.prize || 'Diamonds Giveaway',
      minWatchMins: reqMins,
      unlocked,
      roomId: unlocked
        ? (cr.roomId || 'TBA')
        : (user ? `🔒 Watch ${Math.max(0, reqMins - watchMinsToday)}m more today to unlock` : `🔒 Login & watch ${reqMins}m today to unlock`),
      roomPass: unlocked ? (cr.roomPass || 'TBA') : '🔒 Locked',
    },
  };
}

// ---------------------------------------------------------------------------
// API Routes
// ---------------------------------------------------------------------------
const routes = {
  'POST /api/getChallenge': async (req, res) => {
    const a = 2 + Math.floor(Math.random() * 8);
    const b = 2 + Math.floor(Math.random() * 8);
    const useMultiply = Math.random() < 0.5;
    const question = useMultiply ? `${a} × ${b} = ?` : `${a} + ${b} = ?`;
    const answer = useMultiply ? a * b : a + b;
    const id = crypto.randomBytes(16).toString('hex');
    db.challenges = db.challenges.filter((c) => c.expiresAt > Date.now());
    db.challenges.push({ id, answer, expiresAt: Date.now() + CHALLENGE_TTL_MS });
    saveDb();
    sendJson(res, 200, { challengeId: id, question });
  },

  'POST /api/register': async (req, res, body) => {
    const username = String(body.username || '').trim().toLowerCase();
    const password = String(body.password || '');
    const ffUid = String(body.ffUid || '').trim();
    const refInput = String(body.referralCode || '').trim().toUpperCase();

    if (!USERNAME_RE.test(username)) {
      return sendJson(res, 400, { error: 'Username must be 3–24 characters: letters, numbers, underscore or dot.' });
    }
    if (password.length < 6 || password.length > 72) {
      return sendJson(res, 400, { error: 'Password must be 6–72 characters.' });
    }
    if (ffUid && !UID_RE.test(ffUid)) {
      return sendJson(res, 400, { error: 'Free Fire UID must be 5–16 digits.' });
    }
    const challenge = db.challenges.find((c) => c.id === body.challengeId);
    if (!challenge || challenge.expiresAt < Date.now()) {
      return sendJson(res, 400, { error: 'Security challenge expired. Please try again.' });
    }
    if (Number(body.challengeAnswer) !== challenge.answer) {
      return sendJson(res, 400, { error: 'Wrong answer to the security question.' });
    }
    db.challenges = db.challenges.filter((c) => c.id !== challenge.id);
    if (db.users.some((u) => u.username === username)) {
      saveDb();
      return sendJson(res, 409, { error: 'Username already taken.' });
    }

    let inviter = null;
    if (refInput) {
      inviter = db.users.find(
        (u) => (u.referralCode && u.referralCode.toUpperCase() === refInput) || u.username.toUpperCase() === refInput
      );
    }

    const rec = makePasswordRecord(password);
    const user = {
      id: crypto.randomUUID(),
      username,
      passwordHash: rec.passwordHash,
      salt: rec.salt,
      role: 'viewer',
      ffUid,
      bio: '',
      banned: false,
      createdAt: Date.now(),
      balanceMilli: 0,
      heldMilli: 0,
      totalEarnedMilli: 0,
      pendingSec: 0,
      totalWatchSec: 0,
      watchCredited: {},
      promoClaimed: {},
      referredBy: inviter ? inviter.id : null,
      referralRewarded: false,
      referralCount: 0,
      referralEarnedMilli: 0,
    };
    ensureDailyStats(user);
    db.users.push(user);
    const token = createSession(user.id);
    saveDb();
    sendJson(res, 200, { token, user: publicUser(user) });
  },

  'POST /api/login': async (req, res, body) => {
    const username = String(body.username || '').trim().toLowerCase();
    const password = String(body.password || '');
    const user = db.users.find((u) => u.username === username);
    if (!user || !verifyPassword(user, password)) {
      return sendJson(res, 401, { error: 'Wrong username or password.' });
    }
    if (user.banned && user.role !== 'owner') {
      return sendJson(res, 403, { error: 'Your account has been suspended by the owner.' });
    }
    const token = createSession(user.id);
    sendJson(res, 200, { token, user: publicUser(user) });
  },

  'POST /api/ownerLogin': async (req, res, body) => {
    const username = String(body.username || '').trim().toLowerCase();
    const password = String(body.password || '');
    const user = db.users.find((u) => u.username === username);
    if (!user || !verifyPassword(user, password)) {
      return sendJson(res, 401, { error: 'Wrong username or password.' });
    }
    if (user.role !== 'owner') {
      return sendJson(res, 403, { error: 'This is not an owner account.' });
    }
    const token = createSession(user.id);
    sendJson(res, 200, { token, user: publicUser(user) });
  },

  'POST /api/logout': async (req, res) => {
    const header = req.headers['authorization'] || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (token) db.sessions = db.sessions.filter((s) => s.token !== token);
    saveDb();
    sendJson(res, 200, { ok: true });
  },

  'POST /api/me': async (req, res) => {
    const user = requireAuth(req, res);
    if (!user) return;
    sendJson(res, 200, { user: publicUser(user), feed: buildPublicFeed(user) });
  },

  // --- Videos & Public Feed (Accessible to both Guests & Logged-In Users!) ---
  'GET /api/videos': async (req, res) => {
    const user = authUser(req);
    const videos = db.videos
      .slice()
      .sort((a, b) => (b.boost2x ? 1 : 0) - (a.boost2x ? 1 : 0) || b.createdAt - a.createdAt)
      .map((v) => serializeVideo(v, user));
    sendJson(res, 200, {
      videos,
      feed: buildPublicFeed(user),
      user: user ? publicUser(user) : null,
    });
  },

  // --- Promotional / Business Inquiry Ticket & Mail Trigger (Publicly Accessible) ---
  'POST /api/submitPromoInquiry': async (req, res, body) => {
    const name = String(body.name || '').trim().slice(0, 80);
    const contact = String(body.contact || '').trim().slice(0, 120);
    const channelUrl = String(body.channelUrl || '').trim().slice(0, 200);
    const promoType = String(body.promoType || 'Video Promotion').trim().slice(0, 60);
    const message = String(body.message || '').trim().slice(0, 800);
    if (!name || !contact || !message) {
      return sendJson(res, 400, { error: 'Please fill in your Name, Email/Contact, and Message.' });
    }
    const inquiry = {
      id: crypto.randomUUID(),
      name,
      contact,
      channelUrl,
      promoType,
      message,
      status: 'new',
      createdAt: Date.now(),
    };
    db.promoInquiries.push(inquiry);
    saveDb();
    sendJson(res, 200, {
      ok: true,
      inquiry,
      promoEmail: db.settings.promoEmail || 'promotions@ffdiamond.com',
    });
  },

  'POST /api/resolvePromoInquiry': async (req, res, body) => {
    const owner = requireOwner(req, res);
    if (!owner) return;
    if (body.action === 'delete') {
      db.promoInquiries = db.promoInquiries.filter((i) => i.id !== body.inquiryId);
    } else {
      const item = db.promoInquiries.find((i) => i.id === body.inquiryId);
      if (item) item.status = 'read';
    }
    saveDb();
    sendJson(res, 200, { ok: true });
  },

  'POST /api/addYouTubeVideo': async (req, res, body) => {
    const owner = requireOwner(req, res);
    if (!owner) return;
    const youtubeId = extractYouTubeId(body.url || body.youtubeUrl || '');
    if (!youtubeId) {
      return sendJson(res, 400, { error: 'Only valid YouTube links are accepted (watch, youtu.be, or Shorts).' });
    }
    const title = String(body.title || '').trim().slice(0, 140);
    if (!title) return sendJson(res, 400, { error: 'Video title is required.' });
    const type = body.type === 'Short' ? 'Short' : 'Long';
    const category = String(body.category || 'Gameplay').trim().slice(0, 40) || 'Gameplay';
    const rawDur = Math.floor(Number(body.durationSec) || 0);
    const durationSec = rawDur >= 10 ? rawDur : (type === 'Short' ? DEFAULT_SHORT_DUR_SEC : DEFAULT_LONG_DUR_SEC);
    const boost2x = !!body.boost2x;
    const video = {
      id: crypto.randomUUID(),
      youtubeId,
      url: `https://www.youtube.com/watch?v=${youtubeId}`,
      title,
      type,
      category,
      durationSec,
      boost2x,
      likedBy: [],
      views: 0,
      createdAt: Date.now(),
    };
    db.videos.push(video);
    saveDb(true);
    sendJson(res, 200, { video: serializeVideo(video, owner) });
  },

  'POST /api/toggleVideoBoost': async (req, res, body) => {
    const owner = requireOwner(req, res);
    if (!owner) return;
    const video = db.videos.find((v) => v.id === body.videoId);
    if (!video) return sendJson(res, 404, { error: 'Video not found.' });
    video.boost2x = !video.boost2x;
    saveDb();
    sendJson(res, 200, { video: serializeVideo(video, owner) });
  },

  'POST /api/removeVideo': async (req, res, body) => {
    const owner = requireOwner(req, res);
    if (!owner) return;
    const before = db.videos.length;
    db.videos = db.videos.filter((v) => v.id !== body.videoId);
    db.comments = db.comments.filter((c) => c.videoId !== body.videoId);
    if (db.videos.length === before) return sendJson(res, 404, { error: 'Video not found.' });
    saveDb(true);
    sendJson(res, 200, { ok: true });
  },

  // --- Video Likes & Comments ---
  'POST /api/toggleLike': async (req, res, body) => {
    const user = requireAuth(req, res);
    if (!user) return;
    const video = db.videos.find((v) => v.id === body.videoId);
    if (!video) return sendJson(res, 404, { error: 'Video not found.' });
    if (!Array.isArray(video.likedBy)) video.likedBy = [];
    const idx = video.likedBy.indexOf(user.id);
    let liked = false;
    if (idx === -1) {
      video.likedBy.push(user.id);
      user.daily.likes = (user.daily.likes || 0) + 1;
      liked = true;
    } else {
      video.likedBy.splice(idx, 1);
      liked = false;
    }
    saveDb();
    sendJson(res, 200, { liked, likesCount: video.likedBy.length, user: publicUser(user) });
  },

  'POST /api/getComments': async (req, res, body) => {
    const list = db.comments
      .filter((c) => c.videoId === body.videoId)
      .slice(-50)
      .reverse();
    sendJson(res, 200, { comments: list });
  },

  'POST /api/addComment': async (req, res, body) => {
    const user = requireAuth(req, res);
    if (!user) return;
    const video = db.videos.find((v) => v.id === body.videoId);
    if (!video) return sendJson(res, 404, { error: 'Video not found.' });
    const text = String(body.text || '').trim().slice(0, 180);
    if (!text) return sendJson(res, 400, { error: 'Comment cannot be empty.' });
    const rk = getRankInfo(user.totalWatchSec || 0);
    const comment = {
      id: crypto.randomUUID(),
      videoId: video.id,
      userId: user.id,
      username: user.username,
      rankIcon: rk.icon,
      rankName: rk.name,
      text,
      at: Date.now(),
    };
    db.comments.push(comment);
    user.daily.comments = (user.daily.comments || 0) + 1;
    saveDb();
    const list = db.comments.filter((c) => c.videoId === video.id).slice(-50).reverse();
    sendJson(res, 200, { comment, comments: list, user: publicUser(user) });
  },

  'POST /api/deleteComment': async (req, res, body) => {
    const user = requireAuth(req, res);
    if (!user) return;
    const target = db.comments.find((c) => c.id === body.commentId);
    if (!target) return sendJson(res, 404, { error: 'Comment not found.' });
    if (user.role !== 'owner' && target.userId !== user.id) {
      return sendJson(res, 403, { error: 'Not allowed.' });
    }
    db.comments = db.comments.filter((c) => c.id !== body.commentId);
    saveDb();
    sendJson(res, 200, { ok: true });
  },

  // --- Watching: Supports Guest Preview & Logged-In Verified Earning ---
  'POST /api/startWatch': async (req, res, body) => {
    const user = authUser(req);
    const video = db.videos.find((v) => v.id === body.videoId);
    if (!video) return sendJson(res, 404, { error: 'Video not found.' });
    video.views = (video.views || 0) + 1;
    const cap = videoCapSec(video);
    const comments = db.comments.filter((c) => c.videoId === video.id).slice(-50).reverse();

    if (!user) {
      saveDb();
      return sendJson(res, 200, {
        guest: true,
        sessionId: null,
        blockSec: BLOCK_SEC,
        blockMilli: video.boost2x ? BLOCK_MILLI * 2 : BLOCK_MILLI,
        boost2x: !!video.boost2x,
        pendingSec: 0,
        balanceMilli: 0,
        videoDurationSec: cap,
        videoCreditedSec: 0,
        rewardCapped: false,
        likesCount: Array.isArray(video.likedBy) ? video.likedBy.length : 0,
        liked: false,
        comments,
      });
    }

    for (const ws of db.watchSessions) if (ws.userId === user.id) ws.active = false;
    const session = {
      id: crypto.randomUUID(),
      userId: user.id,
      videoId: video.id,
      lastPosition: 0,
      lastTs: Date.now(),
      creditedSec: 0,
      active: true,
      createdAt: Date.now(),
    };
    db.watchSessions.push(session);
    saveDb();
    const alreadyCredited = lifetimeCreditedSec(user, video.id);
    sendJson(res, 200, {
      guest: false,
      sessionId: session.id,
      blockSec: BLOCK_SEC,
      blockMilli: video.boost2x ? BLOCK_MILLI * 2 : BLOCK_MILLI,
      boost2x: !!video.boost2x,
      pendingSec: Math.floor(user.pendingSec || 0),
      balanceMilli: user.balanceMilli,
      videoDurationSec: cap,
      videoCreditedSec: Math.floor(alreadyCredited),
      rewardCapped: alreadyCredited >= cap,
      likesCount: Array.isArray(video.likedBy) ? video.likedBy.length : 0,
      liked: Array.isArray(video.likedBy) && video.likedBy.includes(user.id),
      comments,
    });
  },

  'POST /api/reportWatch': async (req, res, body) => {
    const user = requireAuth(req, res);
    if (!user) return;
    const session = db.watchSessions.find((s) => s.id === body.sessionId && s.userId === user.id);
    if (!session || !session.active) return sendJson(res, 404, { error: 'Watch session not found or closed.' });
    const video = db.videos.find((v) => v.id === session.videoId);
    if (!video) return sendJson(res, 404, { error: 'Video removed.' });

    const reportedDur = Math.floor(Number(body.duration) || 0);
    if (reportedDur >= 10 && (video.durationSec === DEFAULT_LONG_DUR_SEC || video.durationSec === DEFAULT_SHORT_DUR_SEC)) {
      video.durationSec = reportedDur;
    }

    const now = Date.now();
    const elapsedSec = (now - session.lastTs) / 1000;
    const position = Number(body.position);
    const playbackRate = Number(body.playbackRate || 1);
    if (!Number.isFinite(position) || position < 0) {
      return sendJson(res, 400, { error: 'Invalid position.' });
    }
    const positionDelta = position - session.lastPosition;
    const suspended =
      body.suspended === true ||
      body.playerState === 'check' ||
      body.playerState === 'suspended' ||
      playbackRate > 1.05;

    let credited = 0;
    let earnedNowMilli = 0;
    let referralUnlockedNow = false;
    const cap = videoCapSec(video);

    if (!suspended && body.playing === true && positionDelta > 0 && positionDelta <= elapsedSec + HEARTBEAT_TOLERANCE_SEC) {
      credited = Math.min(positionDelta, elapsedSec + HEARTBEAT_TOLERANCE_SEC);
      const sessionRemaining = Math.max(0, cap - session.creditedSec);
      credited = Math.min(credited, sessionRemaining);
      const lifetimeRemaining = Math.max(0, cap - lifetimeCreditedSec(user, video.id));
      credited = Math.min(credited, lifetimeRemaining);
    }

    session.lastPosition = position;
    session.lastTs = now;

    if (credited > 0) {
      session.creditedSec += credited;
      user.watchCredited[video.id] = lifetimeCreditedSec(user, video.id) + credited;
      user.totalWatchSec = (user.totalWatchSec || 0) + credited;
      user.daily.watchSec = (user.daily.watchSec || 0) + credited;
      if (video.type === 'Short') {
        user.daily.shortsSec = (user.daily.shortsSec || 0) + credited;
      }
      user.pendingSec = (user.pendingSec || 0) + credited;

      const blockReward = video.boost2x ? BLOCK_MILLI * 2 : BLOCK_MILLI;
      while (user.pendingSec >= BLOCK_SEC) {
        user.pendingSec -= BLOCK_SEC;
        earnedNowMilli += blockReward;
      }
      if (earnedNowMilli > 0) {
        creditUser(
          user,
          earnedNowMilli,
          'earn',
          `Watched: ${video.title}${video.boost2x ? ' (🔥 2X Boost)' : ''}`
        );
      }

      if (user.referredBy && !user.referralRewarded && user.totalWatchSec >= REFERRAL_UNLOCK_SEC) {
        user.referralRewarded = true;
        const inviter = db.users.find((u) => u.id === user.referredBy);
        creditUser(user, REFERRAL_BONUS_MILLI, 'referral', 'Referral bonus unlocked (15m watched!)');
        if (inviter) {
          inviter.referralCount = (inviter.referralCount || 0) + 1;
          inviter.referralEarnedMilli = (inviter.referralEarnedMilli || 0) + REFERRAL_BONUS_MILLI;
          creditUser(inviter, REFERRAL_BONUS_MILLI, 'referral', `Referral bonus: @${user.username} watched 15 mins!`);
        }
        referralUnlockedNow = true;
      }

      const lastHist = db.watchHistory[db.watchHistory.length - 1];
      if (lastHist && lastHist.userId === user.id && lastHist.videoId === session.videoId && now - lastHist.at < 30000) {
        lastHist.seconds += credited;
        lastHist.at = now;
      } else {
        db.watchHistory.push({ userId: user.id, videoId: session.videoId, seconds: credited, at: now });
      }
    }

    saveDb();
    const lifetimeSec = lifetimeCreditedSec(user, video.id);
    sendJson(res, 200, {
      creditedSec: credited,
      earnedNowMilli,
      referralUnlockedNow,
      suspended,
      sessionCreditedSec: Math.floor(session.creditedSec),
      videoCreditedSec: Math.floor(lifetimeSec),
      videoDurationSec: cap,
      rewardCapped: lifetimeSec >= cap,
      pendingSec: Math.floor(user.pendingSec || 0),
      balanceMilli: user.balanceMilli,
      totalEarnedMilli: user.totalEarnedMilli,
      user: publicUser(user),
    });
  },

  'POST /api/endWatch': async (req, res, body) => {
    const user = authUser(req);
    if (!user) return sendJson(res, 200, { ok: true });
    const session = db.watchSessions.find((s) => s.id === body.sessionId && s.userId === user.id);
    if (session) session.active = false;
    saveDb();
    sendJson(res, 200, { ok: true, pendingSec: Math.floor(user.pendingSec || 0), balanceMilli: user.balanceMilli, user: publicUser(user) });
  },

  // --- Gamification: Streak, Spin, Missions, Promo Code ---
  'POST /api/claimDailyStreak': async (req, res) => {
    const user = requireAuth(req, res);
    if (!user) return;
    if (user.daily.streakClaimed) {
      return sendJson(res, 400, { error: 'Today\'s streak bonus is already claimed!' });
    }
    if ((user.daily.watchSec || 0) < STREAK_REQUIRE_SEC) {
      const rem = Math.ceil(STREAK_REQUIRE_SEC - (user.daily.watchSec || 0));
      return sendJson(res, 400, { error: `Watch ${rem}s more video today to unlock your Daily Streak reward!` });
    }
    const today = todayStr();
    const yest = yesterdayStr();
    if (user.lastStreakDate === yest) {
      user.streakDays = Math.min(7, (user.streakDays || 0) + 1);
    } else {
      user.streakDays = 1;
    }
    user.lastStreakDate = today;
    user.daily.streakClaimed = true;
    const rewardMilli = STREAK_REWARDS_MILLI[Math.min(6, user.streakDays - 1)];
    creditUser(user, rewardMilli, 'streak', `🔥 Day ${user.streakDays} Daily Streak Bonus`);
    saveDb();
    sendJson(res, 200, { rewardMilli, streakDays: user.streakDays, user: publicUser(user) });
  },

  'POST /api/spinWheel': async (req, res) => {
    const user = requireAuth(req, res);
    if (!user) return;
    if (user.daily.spinUsed) {
      return sendJson(res, 400, { error: 'You already used your Free Lucky Spin today! Come back tomorrow.' });
    }
    if ((user.daily.watchSec || 0) < SPIN_REQUIRE_SEC) {
      const rem = Math.ceil((SPIN_REQUIRE_SEC - (user.daily.watchSec || 0)) / 60);
      return sendJson(res, 400, { error: `Watch ${rem} more minute(s) today to unlock your Daily Lucky Spin!` });
    }
    user.daily.spinUsed = true;
    const prizeIndex = Math.floor(Math.random() * SPIN_PRIZES_MILLI.length);
    const rewardMilli = SPIN_PRIZES_MILLI[prizeIndex];
    creditUser(user, rewardMilli, 'spin', `🎰 Daily Lucky Spin Prize (+${rewardMilli / 1000} 💎)`);
    saveDb();
    sendJson(res, 200, { rewardMilli, prizeIndex, user: publicUser(user) });
  },

  'POST /api/claimMission': async (req, res, body) => {
    const user = requireAuth(req, res);
    if (!user) return;
    const mId = String(body.missionId || '');
    const mDef = MISSIONS_DEF[mId];
    if (!mDef) return sendJson(res, 400, { error: 'Unknown mission.' });
    if (user.daily.missionsClaimed[mId]) {
      return sendJson(res, 400, { error: 'Mission already claimed today!' });
    }
    if (mId === 'shorts2m' && (user.daily.shortsSec || 0) < 120) {
      return sendJson(res, 400, { error: 'Watch at least 2 minutes of Shorts today first!' });
    }
    if (mId === 'watch10m' && (user.daily.watchSec || 0) < 600) {
      return sendJson(res, 400, { error: 'Watch at least 10 minutes of videos today first!' });
    }
    if (mId === 'social' && ((user.daily.likes || 0) < 1 || (user.daily.comments || 0) < 1)) {
      return sendJson(res, 400, { error: 'Like at least 1 video and post 1 comment today first!' });
    }
    if (mId === 'chest') {
      if (!user.daily.missionsClaimed.shorts2m || !user.daily.missionsClaimed.watch10m || !user.daily.missionsClaimed.social) {
        return sendJson(res, 400, { error: 'Claim all 3 daily missions first to open the Booyah Chest!' });
      }
    }
    user.daily.missionsClaimed[mId] = true;
    creditUser(user, mDef.rewardMilli, 'mission', `📋 Mission Completed: ${mDef.title}`);
    saveDb();
    sendJson(res, 200, { rewardMilli: mDef.rewardMilli, missionId: mId, user: publicUser(user) });
  },

  'POST /api/redeemPromoCode': async (req, res, body) => {
    const user = requireAuth(req, res);
    if (!user) return;
    const code = String(body.code || '').trim().toUpperCase();
    if (!code) return sendJson(res, 400, { error: 'Enter a promo code.' });
    const promo = db.promoCodes.find((p) => p.code === code);
    if (!promo) return sendJson(res, 404, { error: 'Invalid or expired promo code.' });
    if (!Array.isArray(promo.claimedBy)) promo.claimedBy = [];
    if (promo.claimedBy.includes(user.id)) {
      return sendJson(res, 400, { error: 'You have already claimed this promo code!' });
    }
    if (promo.claimedBy.length >= promo.maxClaims) {
      return sendJson(res, 400, { error: 'This promo code has reached its maximum user limit!' });
    }
    if (promo.minDailyWatchSec > 0 && (user.daily.watchSec || 0) < promo.minDailyWatchSec) {
      const mins = Math.ceil(promo.minDailyWatchSec / 60);
      return sendJson(res, 400, { error: `Watch at least ${mins} minute(s) of video today before claiming this code!` });
    }
    promo.claimedBy.push(user.id);
    user.promoClaimed[code] = Date.now();
    creditUser(user, promo.rewardMilli, 'promo', `🎁 Secret Video Code Claimed: ${code}`);
    saveDb();
    sendJson(res, 200, { rewardMilli: promo.rewardMilli, code, user: publicUser(user) });
  },

  // --- Profile & Wallet ---
  'POST /api/myProfile': async (req, res) => {
    const user = requireAuth(req, res);
    if (!user) return;
    const history = db.watchHistory
      .filter((h) => h.userId === user.id)
      .slice(-50)
      .reverse()
      .map((h) => {
        const v = db.videos.find((x) => x.id === h.videoId);
        return {
          ...h,
          seconds: Math.floor(h.seconds),
          videoTitle: v ? v.title : '(removed video)',
          youtubeId: v ? v.youtubeId : null,
          type: v ? v.type : null,
        };
      });
    const videosWatched = new Set(db.watchHistory.filter((h) => h.userId === user.id).map((h) => h.videoId)).size;
    sendJson(res, 200, {
      user: publicUser(user),
      videosWatched,
      history,
      redemptions: db.redemptions.filter((r) => r.userId === user.id).slice().reverse(),
      ledger: db.ledger.filter((l) => l.userId === user.id).slice(-60).reverse(),
      feed: buildPublicFeed(user),
    });
  },

  'POST /api/updateProfile': async (req, res, body) => {
    const user = requireAuth(req, res);
    if (!user) return;
    if (typeof body.bio === 'string') {
      user.bio = body.bio.trim().slice(0, 160);
    }
    if (typeof body.ffUid === 'string') {
      const cleaned = body.ffUid.trim();
      if (cleaned && !UID_RE.test(cleaned)) {
        return sendJson(res, 400, { error: 'Free Fire UID must be 5–16 digits.' });
      }
      user.ffUid = cleaned;
    }
    saveDb();
    sendJson(res, 200, { user: publicUser(user) });
  },

  // --- Redeem ---
  'POST /api/requestRedeem': async (req, res, body) => {
    const user = requireAuth(req, res);
    if (!user) return;
    const amountMilli = Math.round(Number(body.amount) * 1000);
    const packName = String(body.packName || `${body.amount} 💎 Top-Up`).trim().slice(0, 60);
    if (!Number.isFinite(amountMilli) || amountMilli <= 0) {
      return sendJson(res, 400, { error: 'Select a valid Diamond pack or amount.' });
    }
    if (amountMilli < REDEEM_MIN_MILLI) {
      return sendJson(res, 400, { error: 'Minimum redeem is 100 Diamonds.' });
    }
    if (amountMilli > user.balanceMilli) {
      return sendJson(res, 400, { error: 'Not enough Diamond balance for this pack.' });
    }
    if (!user.ffUid || !UID_RE.test(user.ffUid)) {
      return sendJson(res, 400, { error: 'Please save a valid numeric Free Fire UID on your Profile before redeeming.' });
    }
    user.balanceMilli -= amountMilli;
    user.heldMilli = (user.heldMilli || 0) + amountMilli;
    const redemption = {
      id: crypto.randomUUID(),
      userId: user.id,
      username: user.username,
      amountMilli,
      packName,
      ffUid: user.ffUid,
      status: 'pending',
      ownerNote: '',
      createdAt: Date.now(),
      resolvedAt: null,
    };
    db.redemptions.push(redemption);
    db.ledger.push({
      id: crypto.randomUUID(),
      userId: user.id,
      kind: 'redeem_hold',
      amountMilli: -amountMilli,
      note: `Redeem requested: ${packName} (balance held)`,
      at: Date.now(),
    });
    saveDb();
    sendJson(res, 200, { redemption, balanceMilli: user.balanceMilli, heldMilli: user.heldMilli, user: publicUser(user) });
  },

  // --- Owner Dashboard & Controls ---
  'POST /api/ownerDashboard': async (req, res) => {
    const owner = requireOwner(req, res);
    if (!owner) return;
    const enrichRedemption = (r) => {
      const u = db.users.find((x) => x.id === r.userId);
      const videosWatched = new Set(db.watchHistory.filter((h) => h.userId === r.userId).map((h) => h.videoId)).size;
      return {
        ...r,
        username: r.username || (u ? u.username : ''),
        ffUid: r.ffUid || (u ? u.ffUid || '' : ''),
        userTotalEarnedMilli: u ? u.totalEarnedMilli : 0,
        userVideosWatched: videosWatched,
        userWatchTimeSec: u ? Math.floor(u.totalWatchSec || 0) : 0,
        userBalanceMilli: u ? u.balanceMilli : 0,
        userHeldMilli: u ? u.heldMilli : 0,
        userCreatedAt: u ? u.createdAt : null,
      };
    };
    const pending = db.redemptions.filter((r) => r.status === 'pending').slice().reverse().map(enrichRedemption);
    const all = db.redemptions.slice().reverse().map(enrichRedemption);
    const inquiries = db.promoInquiries.slice().reverse();
    sendJson(res, 200, {
      stats: {
        users: db.users.length,
        videos: db.videos.length,
        totalViews: db.videos.reduce((s, v) => s + (v.views || 0), 0),
        diamondsIssuedMilli: db.users.reduce((s, u) => s + (u.totalEarnedMilli || 0), 0),
        pendingRedeems: pending.length,
        unreadInquiries: inquiries.filter((i) => i.status === 'new').length,
        cloudSyncStatus,
      },
      settings: db.settings,
      videos: db.videos.slice().sort((a, b) => b.createdAt - a.createdAt).map((v) => serializeVideo(v, owner)),
      promoCodes: db.promoCodes.slice().reverse().map((p) => ({
        ...p,
        claimedCount: Array.isArray(p.claimedBy) ? p.claimedBy.length : 0,
      })),
      promoInquiries: inquiries,
      pendingRedemptions: pending,
      allRedemptions: all.slice(0, 50),
      users: db.users.map((u) => {
        const rk = getRankInfo(u.totalWatchSec || 0);
        return {
          id: u.id,
          username: u.username,
          role: u.role,
          ffUid: u.ffUid || '',
          banned: !!u.banned,
          rankName: rk.name,
          rankIcon: rk.icon,
          totalWatchSec: Math.floor(u.totalWatchSec || 0),
          balanceMilli: u.balanceMilli || 0,
          totalEarnedMilli: u.totalEarnedMilli || 0,
        };
      }),
    });
  },

  'POST /api/resolveRedemption': async (req, res, body) => {
    const owner = requireOwner(req, res);
    if (!owner) return;
    const redemption = db.redemptions.find((r) => r.id === body.redemptionId);
    if (!redemption) return sendJson(res, 404, { error: 'Redemption not found.' });
    if (redemption.status !== 'pending') return sendJson(res, 400, { error: 'Redemption already resolved.' });
    const user = db.users.find((u) => u.id === redemption.userId);
    const ownerNote = String(body.ownerNote || '').trim().slice(0, 140);
    redemption.ownerNote = ownerNote;
    if (body.action === 'paid') {
      redemption.status = 'paid';
      redemption.resolvedAt = Date.now();
      if (user) {
        user.heldMilli = Math.max(0, (user.heldMilli || 0) - redemption.amountMilli);
        db.ledger.push({
          id: crypto.randomUUID(),
          userId: user.id,
          kind: 'redeem_paid',
          amountMilli: 0,
          note: `✅ Redeem Paid: ${redemption.packName || (redemption.amountMilli / 1000) + ' 💎'}${ownerNote ? ' — ' + ownerNote : ''}`,
          at: Date.now(),
        });
      }
    } else if (body.action === 'reject') {
      redemption.status = 'rejected';
      redemption.resolvedAt = Date.now();
      if (user) {
        user.heldMilli = Math.max(0, (user.heldMilli || 0) - redemption.amountMilli);
        user.balanceMilli = (user.balanceMilli || 0) + redemption.amountMilli;
        db.ledger.push({
          id: crypto.randomUUID(),
          userId: user.id,
          kind: 'redeem_refund',
          amountMilli: redemption.amountMilli,
          note: `↩ Redeem Rejected & Refunded${ownerNote ? ' — ' + ownerNote : ''}`,
          at: Date.now(),
        });
      }
    } else {
      return sendJson(res, 400, { error: 'Action must be "paid" or "reject".' });
    }
    saveDb();
    sendJson(res, 200, { redemption });
  },

  'POST /api/createPromoCode': async (req, res, body) => {
    const owner = requireOwner(req, res);
    if (!owner) return;
    const code = String(body.code || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 24);
    const rewardMilli = Math.round(Number(body.rewardDiamonds || 0) * 1000);
    const maxClaims = Math.max(1, Math.floor(Number(body.maxClaims) || 50));
    const minDailyWatchSec = Math.max(0, Math.floor(Number(body.minWatchMins || 0) * 60));
    if (!code || code.length < 3) return sendJson(res, 400, { error: 'Code must be at least 3 characters.' });
    if (rewardMilli <= 0 || rewardMilli > 50000) return sendJson(res, 400, { error: 'Reward must be between 0.05 and 50 Diamonds.' });
    if (db.promoCodes.some((p) => p.code === code)) return sendJson(res, 409, { error: 'Promo code already exists.' });
    const promo = {
      id: crypto.randomUUID(),
      code,
      rewardMilli,
      maxClaims,
      minDailyWatchSec,
      claimedBy: [],
      createdAt: Date.now(),
    };
    db.promoCodes.push(promo);
    saveDb();
    sendJson(res, 200, { promo });
  },

  'POST /api/deletePromoCode': async (req, res, body) => {
    const owner = requireOwner(req, res);
    if (!owner) return;
    db.promoCodes = db.promoCodes.filter((p) => p.id !== body.promoId);
    saveDb();
    sendJson(res, 200, { ok: true });
  },

  'POST /api/setBroadcast': async (req, res, body) => {
    const owner = requireOwner(req, res);
    if (!owner) return;
    db.settings.broadcast = String(body.broadcast || '').trim().slice(0, 280);
    if (typeof body.promoEmail === 'string' && body.promoEmail.trim()) {
      db.settings.promoEmail = body.promoEmail.trim().slice(0, 120);
    }
    if (body.introUrl !== undefined) {
      const yId = extractYouTubeId(body.introUrl || '');
      if (yId) {
        db.settings.introVideo = {
          youtubeId: yId,
          url: `https://www.youtube.com/watch?v=${yId}`,
          title: String(body.introTitle || 'Platform Introduction Video').trim().slice(0, 140),
          description: String(body.introDesc || '').trim().slice(0, 300),
        };
      }
    }
    saveDb();
    sendJson(res, 200, { settings: db.settings });
  },

  'POST /api/setCustomRoom': async (req, res, body) => {
    const owner = requireOwner(req, res);
    if (!owner) return;
    db.settings.customRoom = {
      active: !!body.active,
      title: String(body.title || 'Free Fire Custom Room Giveaway').trim().slice(0, 120),
      matchTime: String(body.matchTime || 'TBA').trim().slice(0, 80),
      prize: String(body.prize || 'Diamonds Giveaway').trim().slice(0, 100),
      roomId: String(body.roomId || '').trim().slice(0, 40),
      roomPass: String(body.roomPass || '').trim().slice(0, 40),
      minWatchMins: Math.max(0, Math.floor(Number(body.minWatchMins) || 15)),
    };
    saveDb();
    sendJson(res, 200, { customRoom: db.settings.customRoom });
  },

  'POST /api/ownerUpdateUser': async (req, res, body) => {
    const owner = requireOwner(req, res);
    if (!owner) return;
    const target = db.users.find((u) => u.username === String(body.username || '').trim().toLowerCase() || u.id === body.userId);
    if (!target) return sendJson(res, 404, { error: 'User not found.' });
    if (target.role === 'owner' && body.toggleBan) {
      return sendJson(res, 400, { error: 'Cannot ban the owner account.' });
    }
    if (body.toggleBan) {
      target.banned = !target.banned;
      if (target.banned) {
        db.sessions = db.sessions.filter((s) => s.userId !== target.id);
      }
    }
    if (typeof body.deltaDiamonds === 'number' && Number.isFinite(body.deltaDiamonds) && body.deltaDiamonds !== 0) {
      const deltaMilli = Math.round(body.deltaDiamonds * 1000);
      target.balanceMilli = Math.max(0, (target.balanceMilli || 0) + deltaMilli);
      if (deltaMilli > 0) target.totalEarnedMilli = (target.totalEarnedMilli || 0) + deltaMilli;
      db.ledger.push({
        id: crypto.randomUUID(),
        userId: target.id,
        kind: 'owner_adjust',
        amountMilli: deltaMilli,
        note: String(body.reason || 'Owner balance adjustment').trim().slice(0, 120),
        at: Date.now(),
      });
    }
    saveDb();
    sendJson(res, 200, { ok: true, user: publicUser(target) });
  },

  'GET /api/health': async (req, res) => {
    sendJson(res, 200, { ok: true, videos: db.videos.length, users: db.users.length, cloudSyncStatus, ts: Date.now() });
  },

  'POST /api/ownerRestoreBackup': async (req, res, body) => {
    const owner = requireOwner(req, res);
    if (!owner) return;
    const incoming = body && body.backup;
    if (!incoming || typeof incoming !== 'object' || !Array.isArray(incoming.videos)) {
      return sendJson(res, 400, { error: 'Invalid backup JSON file.' });
    }
    const base = emptyDb();
    for (const k of Object.keys(base)) {
      if (k === 'settings' && incoming.settings) {
        db.settings = { ...base.settings, ...incoming.settings };
      } else if (Array.isArray(incoming[k])) {
        db[k] = incoming[k];
      }
    }
    bootstrapOwner();
    saveDb(true);
    sendJson(res, 200, { ok: true, videos: db.videos.length, users: db.users.length });
  },

  'GET /api/ownerBackup': async (req, res) => {
    const owner = requireOwner(req, res);
    if (!owner) return;
    const payload = JSON.stringify(db, null, 2);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="ff-diamond-backup-${todayStr()}.json"`,
    });
    res.end(payload);
  },
};

// ---------------------------------------------------------------------------
// Static file serving with strict directory boundary check
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, pathname) {
  const relPath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.resolve(PUBLIC_DIR, relPath);
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      const fallbackIndex = path.join(PUBLIC_DIR, 'index.html');
      fs.readFile(fallbackIndex, (err2, indexData) => {
        if (err2) {
          res.writeHead(500);
          return res.end('index.html not found inside public/ folder');
        }
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(indexData);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const key = `${req.method} ${url.pathname}`;
  if (routes[key]) {
    try {
      const body = req.method === 'POST' ? await readBody(req) : {};
      await routes[key](req, res, body);
    } catch (err) {
      sendJson(res, 400, { error: err.message || 'Bad request' });
    }
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    return sendJson(res, 404, { error: 'Unknown API route.' });
  }
  if (req.method === 'GET') {
    return serveStatic(req, res, url.pathname);
  }
  res.writeHead(405);
  res.end('Method not allowed');
});

bootstrapOwner();
pullFromCloudGistOnBoot().then(() => {
  bootstrapOwner();
});
server.listen(PORT, () => {
  console.log(`FF Diamond Platform running on http://localhost:${PORT}`);
  console.log(`Secret Owner Link: http://localhost:${PORT}/owner (or http://localhost:${PORT}/#/owner)`);
  // Auto Keep-Alive Self-Ping on Render every 10 minutes to reduce sleep spin-downs
  const extUrl = process.env.RENDER_EXTERNAL_URL;
  if (extUrl && typeof fetch === 'function') {
    setInterval(() => {
      fetch(`${extUrl.replace(/\/+$/, '')}/api/health`).catch(() => {});
    }, 10 * 60 * 1000);
  }
});
