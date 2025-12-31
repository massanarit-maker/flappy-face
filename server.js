const path = require("path");
const fs = require("fs");
const express = require("express");
const multer = require("multer");
const sqlite3 = require("sqlite3").verbose();

const app = express();
const PORT = 3000;

// Parse JSON bodies
app.use(express.json({ limit: "1mb" }));

// ---------- Helpers ----------
function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function safeUsername(input) {
  const raw = String(input || "").trim().toLowerCase();
  const cleaned = raw.replace(/\s+/g, "-").replace(/[^a-z0-9_-]/g, "");
  return cleaned || "player";
}

// ---------- Paths ----------
const PUBLIC_DIR = path.join(__dirname, "public");
const UPLOADS_DIR = path.join(__dirname, "uploads");
const FACES_DIR = path.join(UPLOADS_DIR, "faces");     // old character-based uploads (kept for no regressions)
const AVATARS_DIR = path.join(UPLOADS_DIR, "avatars"); // username-based avatars
const DB_PATH = path.join(__dirname, "data.sqlite");

ensureDir(UPLOADS_DIR);
ensureDir(FACES_DIR);
ensureDir(AVATARS_DIR);

// ---------- SQLite ----------
const db = new sqlite3.Database(DB_PATH);
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS leaderboard (
      username TEXT PRIMARY KEY,
      best INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    )
  `);
});

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

// ---------- Static ----------
app.use(express.static(PUBLIC_DIR));
app.use("/faces", express.static(FACES_DIR));
app.use("/avatars", express.static(AVATARS_DIR));

// ---------- Health ----------
app.get("/healthz", (req, res) => {
  res.json({
    ok: true,
    service: "flappy-face",
    time: new Date().toISOString()
  });
});

// ---------- Existing (kept): Characters endpoints ----------
const CHARACTERS = ["Broxton", "Laurel", "Hendrix", "Maddox", "Phoenix", "Dad", "Mom"];

function findFaceForCharacter(name) {
  const file = path.join(FACES_DIR, `${name}.png`);
  if (fs.existsSync(file)) return `/faces/${encodeURIComponent(name)}.png`;
  return null;
}

app.get("/api/characters", (req, res) => {
  const characters = CHARACTERS.map((name) => ({
    name,
    faceUrl: findFaceForCharacter(name)
  }));
  res.json({ ok: true, characters });
});

const characterStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, FACES_DIR),
  filename: (req, file, cb) => {
    const character = String(req.body.character || "").trim();
    if (!CHARACTERS.includes(character)) return cb(new Error("Invalid character"));
    cb(null, `${character}.png`);
  }
});
const uploadCharacterFace = multer({
  storage: characterStorage,
  limits: { fileSize: 5 * 1024 * 1024 }
});

app.post("/api/upload-face", uploadCharacterFace.single("face"), (req, res) => {
  try {
    const character = String(req.body.character || "").trim();
    if (!CHARACTERS.includes(character)) {
      return res.status(400).json({ ok: false, error: "Invalid character" });
    }
    return res.json({ ok: true, faceUrl: `/faces/${encodeURIComponent(character)}.png` });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Upload failed" });
  }
});

// ---------- Username avatar endpoints ----------
app.get("/api/avatar", (req, res) => {
  const username = safeUsername(req.query.username);
  const filePath = path.join(AVATARS_DIR, `${username}.png`);
  if (fs.existsSync(filePath)) {
    return res.json({ ok: true, avatarUrl: `/avatars/${encodeURIComponent(username)}.png` });
  }
  return res.json({ ok: true, avatarUrl: null });
});

const avatarStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, AVATARS_DIR),
  filename: (req, file, cb) => {
    const username = safeUsername(req.body.username);
    cb(null, `${username}.png`);
  }
});
const uploadAvatar = multer({
  storage: avatarStorage,
  limits: { fileSize: 5 * 1024 * 1024 }
});

app.post("/api/upload-avatar", uploadAvatar.single("avatar"), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, error: "Missing avatar file" });
    }
    const username = safeUsername(req.body.username);
    return res.json({ ok: true, avatarUrl: `/avatars/${encodeURIComponent(username)}.png` });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Avatar upload failed" });
  }
});

// ---------- Leaderboard endpoints (best score per username) ----------

// Get top leaderboard
app.get("/api/leaderboard", async (req, res) => {
  try {
    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(50, limitRaw)) : 20;

    const rows = await dbAll(
      `SELECT username, best, updated_at
       FROM leaderboard
       ORDER BY best DESC, updated_at ASC
       LIMIT ?`,
      [limit]
    );

    res.json({ ok: true, rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: "Failed to load leaderboard" });
  }
});

// Save score (upsert; keep max)
app.post("/api/score", async (req, res) => {
  try {
    const username = safeUsername(req.body.username);
    const scoreNum = Number(req.body.score);

    if (!username) return res.status(400).json({ ok: false, error: "Missing username" });
    if (!Number.isFinite(scoreNum) || scoreNum < 0) {
      return res.status(400).json({ ok: false, error: "Invalid score" });
    }

    const now = new Date().toISOString();
    const existing = await dbGet(`SELECT best FROM leaderboard WHERE username = ?`, [username]);
    const existingBest = existing ? Number(existing.best) : 0;
    const newBest = Math.max(existingBest, Math.floor(scoreNum));

    if (existing) {
      await dbRun(`UPDATE leaderboard SET best = ?, updated_at = ? WHERE username = ?`, [
        newBest,
        now,
        username
      ]);
    } else {
      await dbRun(`INSERT INTO leaderboard (username, best, updated_at) VALUES (?, ?, ?)`, [
        username,
        newBest,
        now
      ]);
    }

    res.json({ ok: true, username, best: newBest });
  } catch (e) {
    res.status(500).json({ ok: false, error: "Failed to save score" });
  }
});

// NEW: Get rank and total players for a username
// Rank rule:
// - Higher best score ranks higher
// - If tied best score, earlier updated_at ranks higher (stable tie-break)
app.get("/api/rank", async (req, res) => {
  try {
    const username = safeUsername(req.query.username);
    if (!username) return res.status(400).json({ ok: false, error: "Missing username" });

    const totalRow = await dbGet(`SELECT COUNT(*) AS total FROM leaderboard`, []);
    const total = totalRow ? Number(totalRow.total) : 0;

    const me = await dbGet(`SELECT best, updated_at FROM leaderboard WHERE username = ?`, [username]);
    if (!me) {
      return res.json({ ok: true, username, rank: null, total, best: null });
    }

    const best = Number(me.best);
    const updatedAt = String(me.updated_at);

    const aheadRow = await dbGet(
      `SELECT COUNT(*) AS ahead
       FROM leaderboard
       WHERE best > ?
          OR (best = ? AND updated_at < ?)`,
      [best, best, updatedAt]
    );

    const ahead = aheadRow ? Number(aheadRow.ahead) : 0;
    const rank = ahead + 1;

    return res.json({ ok: true, username, rank, total, best });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Failed to load rank" });
  }
});

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`Health check at http://localhost:${PORT}/healthz`);
});
