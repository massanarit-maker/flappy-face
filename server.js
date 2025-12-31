// server.js
const path = require("path");
const fs = require("fs");
const express = require("express");
const multer = require("multer");

const app = express();
const PORT = 3000;

const CHARACTERS = ["Broxton", "Laurel", "Hendrix", "Maddox", "Phoenix", "Dad", "Mom"];

const UPLOADS_DIR = path.join(__dirname, "uploads");
const FACES_JSON_PATH = path.join(UPLOADS_DIR, "faces.json");

// Ensure uploads directory exists
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Load faces mapping (character -> filename)
function loadFacesMap() {
  try {
    if (!fs.existsSync(FACES_JSON_PATH)) return {};
    const raw = fs.readFileSync(FACES_JSON_PATH, "utf8");
    return JSON.parse(raw || "{}");
  } catch (e) {
    return {};
  }
}

function saveFacesMap(map) {
  fs.writeFileSync(FACES_JSON_PATH, JSON.stringify(map, null, 2), "utf8");
}

// Multer: store file in /uploads with safe name
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ch = String(req.body.character || "").trim();
    const ext = path.extname(file.originalname || "").toLowerCase() || ".bin";
    const safeChar = ch.replace(/[^a-z0-9_-]/gi, "_"); // safety
    cb(null, `${safeChar}${ext}`);
  }
});

function fileFilter(req, file, cb) {
  const allowed = ["image/png", "image/jpeg", "image/jpg", "image/webp"];
  if (allowed.includes(file.mimetype)) cb(null, true);
  else cb(new Error("Only PNG, JPG, or WEBP images are allowed."));
}

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB
});

// Serve static files
app.use(express.static(path.join(__dirname, "public")));

// Serve uploaded faces
app.use("/uploads", express.static(UPLOADS_DIR, { fallthrough: false }));

// Health check route
app.get("/healthz", (req, res) => {
  res.json({
    ok: true,
    service: "flappy-face",
    time: new Date().toISOString()
  });
});

// List characters + currently uploaded faces (if any)
app.get("/api/characters", (req, res) => {
  const facesMap = loadFacesMap();
  const result = CHARACTERS.map((name) => {
    const filename = facesMap[name] || null;
    return {
      name,
      faceUrl: filename ? `/uploads/${encodeURIComponent(filename)}` : null
    };
  });
  res.json({ characters: result });
});

// Upload a face image for a character
app.post("/api/upload-face", upload.single("face"), (req, res) => {
  const character = String(req.body.character || "").trim();

  if (!CHARACTERS.includes(character)) {
    // If file was saved but character invalid, clean up
    if (req.file && req.file.path && fs.existsSync(req.file.path)) {
      try { fs.unlinkSync(req.file.path); } catch (_) {}
    }
    return res.status(400).json({ ok: false, error: "Invalid character." });
  }

  if (!req.file) {
    return res.status(400).json({ ok: false, error: "No file uploaded." });
  }

  // If this character had an old file, remove it (unless same name)
  const facesMap = loadFacesMap();
  const oldFilename = facesMap[character];
  const newFilename = req.file.filename;

  if (oldFilename && oldFilename !== newFilename) {
    const oldPath = path.join(UPLOADS_DIR, oldFilename);
    if (fs.existsSync(oldPath)) {
      try { fs.unlinkSync(oldPath); } catch (_) {}
    }
  }

  facesMap[character] = newFilename;
  saveFacesMap(facesMap);

  res.json({
    ok: true,
    character,
    faceUrl: `/uploads/${encodeURIComponent(newFilename)}`
  });
});

// Simple error handler for upload errors
app.use((err, req, res, next) => {
  if (err) {
    return res.status(400).json({ ok: false, error: err.message || "Request error" });
  }
  next();
});

app.listen(PORT, () => {
  console.log("Server running at http://localhost:3000");
  console.log("Health check at http://localhost:3000/healthz");
});
