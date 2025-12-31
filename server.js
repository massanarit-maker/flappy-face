const path = require("path");
const express = require("express");

const app = express();
const PORT = 3000;

// Serve files from /public
app.use(express.static(path.join(__dirname, "public")));

// Health check route
app.get("/healthz", (req, res) => {
  res.json({
    ok: true,
    service: "flappy-face",
    time: new Date().toISOString()
  });
});

// Start server
app.listen(PORT, () => {
  console.log("Server running at http://localhost:3000");
  console.log("Health check at http://localhost:3000/healthz");
});
