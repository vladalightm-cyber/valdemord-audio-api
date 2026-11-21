const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");

let ffmpegStaticPath = null;
try {
  ffmpegStaticPath = require("ffmpeg-static");
} catch (_) {}

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || "";
const TEMP_DIR = path.join(__dirname, "temp_audio");
const BIN_DIR = path.join(__dirname, "bin");

fs.mkdirSync(TEMP_DIR, { recursive: true });
fs.mkdirSync(BIN_DIR, { recursive: true });

// Registry sementara untuk file yang siap diambil oleh bot
const readyFiles = new Map();

// Auto-cleanup file yang tidak diambil lebih dari 15 menit
setInterval(() => {
  const now = Date.now();
  for (const [token, meta] of readyFiles.entries()) {
    if (now - meta.createdAt > 15 * 60 * 1000) {
      try { fs.unlinkSync(meta.filePath); } catch (_) {}
      readyFiles.delete(token);
    }
  }
}, 5 * 60 * 1000);

// Auto-resolve atau auto-download binary yt-dlp jika tidak memakai Docker
async function ensureYtDlp() {
  const checkGlobal = spawnSync("which", ["yt-dlp"], { encoding: "utf8" });
  if (checkGlobal.status === 0 && checkGlobal.stdout.trim()) {
    return checkGlobal.stdout.trim().split(/\r?\n/)[0];
  }

  const localBin = path.join(BIN_DIR, "yt-dlp");
  if (fs.existsSync(localBin)) {
    try { fs.chmodSync(localBin, 0o755); } catch (_) {}
    return localBin;
  }

  const url = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux";
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`Gagal download yt-dlp (HTTP ${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(localBin, buf);
  fs.chmodSync(localBin, 0o755);
  return localBin;
}

function resolveFfmpegLocation() {
  const checkGlobal = spawnSync("which", ["ffmpeg"], { encoding: "utf8" });
  if (checkGlobal.status === 0 && checkGlobal.stdout.trim()) {
    return null; // Sudah ada di system PATH
  }
  if (ffmpegStaticPath && fs.existsSync(ffmpegStaticPath)) {
    return ffmpegStaticPath;
  }
  return null;
}

function sanitizeFilename(name) {
  return String(name || "Unknown")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 130);
}

// Middleware autentikasi API Key
function requireApiKey(req, res, next) {
  if (!API_KEY) return next();
  const provided = req.headers["x-api-key"];
  if (provided !== API_KEY) {
    return res.status(401).json({ error: "Unauthorized: Invalid x-api-key" });
  }
  return next();
}

// Endpoint Health Check (dipakai bot untuk membangunkan Render dari sleep)
app.get("/health", async (req, res) => {
  try {
    const ytDlp = await ensureYtDlp();
    res.json({
      ok: true,
      ytDlp,
      ffmpeg: resolveFfmpegLocation() || "system-path",
      uptime: Math.floor(process.uptime())
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Endpoint Download 1 Lagu dengan Streaming Progress (NDJSON)
app.post("/api/track", requireApiKey, async (req, res) => {
  const { title, artist = "", album = "", url = "", format = "mp3" } = req.body || {};

  if (!title || typeof title !== "string") {
    return res.status(400).json({ error: "Field 'title' wajib diisi." });
  }

  const allowedFormats = ["mp3", "m4a", "opus", "wav"];
  const targetFormat = allowedFormats.includes(String(format).toLowerCase())
    ? String(format).toLowerCase()
    : "mp3";

  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const sendEvent = (obj) => {
    if (!res.writableEnded) {
      res.write(JSON.stringify(obj) + "\n");
    }
  };

  let ytDlpPath;
  try {
    ytDlpPath = await ensureYtDlp();
  } catch (err) {
    sendEvent({ type: "error", error: err.message });
    return res.end();
  }

  const jobId = crypto.randomBytes(10).toString("hex");
  const baseName = artist
    ? sanitizeFilename(`${artist} - ${title}`)
    : sanitizeFilename(title);

  const outputTemplate = path.join(TEMP_DIR, `${jobId}_${baseName}.%(ext)s`);
  const expectedFile = path.join(TEMP_DIR, `${jobId}_${baseName}.${targetFormat}`);

  const sourceTarget = /^https?:\/\//i.test(url)
    ? url.trim()
    : `ytsearch1:${artist ? `${artist} - ` : ""}${title}`;

  // Susun metadata FFmpeg aman untuk karakter spesial & titik dua (:)
  const metaArgs = [`-metadata`, `title=${title.replace(/[\r\n]+/g, " ")}`];
  if (artist) metaArgs.push(`-metadata`, `artist=${artist.replace(/[\r\n]+/g, " ")}`);
  if (album) metaArgs.push(`-metadata`, `album=${album.replace(/[\r\n]+/g, " ")}`);

  const ffmpegLoc = resolveFfmpegLocation();
  const args = [
    "--no-playlist",
    "--extractor-args", "youtube:player_client=android,web",
    "--extract-audio",
    "--audio-format", targetFormat,
    "--audio-quality", "192K",
    ...(ffmpegLoc ? ["--ffmpeg-location", ffmpegLoc] : []),
    "--postprocessor-args", `Metadata:${metaArgs.map(a => `"${a.replace(/"/g, '\\"')}"`).join(" ")}`,
    "--newline",
    "--no-warnings",
    "-o", outputTemplate,
    sourceTarget
  ];

  // Opsional: jika kamu pasang cookies YouTube base64 di ENV Render
  let cookieFilePath = null;
  if (process.env.YT_COOKIES_BASE64) {
    cookieFilePath = path.join(TEMP_DIR, `cookies_${jobId}.txt`);
    fs.writeFileSync(cookieFilePath, Buffer.from(process.env.YT_COOKIES_BASE64, "base64"));
    args.unshift("--cookies", cookieFilePath);
  }

  sendEvent({
    type: "progress",
    percent: 0,
    speed: "-",
    eta: "--:--",
    stage: "Memulai download di server Render..."
  });

  const proc = spawn(ytDlpPath, args, { windowsHide: true });
  let lastErrorLine = "";

  const parseChunk = (chunk) => {
    const lines = chunk.toString().split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      const progMatch = trimmed.match(
        /\[download\]\s+(\d+(?:\.\d+)?)%\s+of\s+~?\s*([^\s]+)(?:\s+at\s+([^\s]+))?(?:\s+ETA\s+([^\s]+))?/i
      );
      if (progMatch) {
        sendEvent({
          type: "progress",
          percent: parseFloat(progMatch[1]),
          size: progMatch[2] || "-",
          speed: progMatch[3] || "-",
          eta: progMatch[4] || "--:--",
          stage: "Mengunduh stream audio..."
        });
        continue;
      }

      if (trimmed.startsWith("[ExtractAudio]") || trimmed.startsWith("[Metadata]")) {
        sendEvent({
          type: "progress",
          percent: 100,
          speed: "-",
          eta: "00:00",
          stage: `Konversi ke .${targetFormat.toUpperCase()} & menulis metadata...`
        });
        continue;
      }

      if (trimmed.startsWith("ERROR:")) {
        lastErrorLine = trimmed.replace(/^ERROR:\s*/i, "");
      }
    }
  };

  proc.stdout.on("data", parseChunk);
  proc.stderr.on("data", parseChunk);

  req.on("close", () => {
    if (!proc.killed) {
      try { proc.kill("SIGKILL"); } catch (_) {}
    }
  });

  proc.on("error", (err) => {
    if (cookieFilePath) try { fs.unlinkSync(cookieFilePath); } catch (_) {}
    sendEvent({ type: "error", error: err.message });
    res.end();
  });

  proc.on("close", (code) => {
    if (cookieFilePath) try { fs.unlinkSync(cookieFilePath); } catch (_) {}

    if (code === 0 && fs.existsSync(expectedFile)) {
      const stat = fs.statSync(expectedFile);
      const fileToken = crypto.randomBytes(12).toString("hex");
      const cleanFileName = `${baseName}.${targetFormat}`;

      readyFiles.set(fileToken, {
        filePath: expectedFile,
        fileName: cleanFileName,
        fileSize: stat.size,
        createdAt: Date.now()
      });

      sendEvent({
        type: "done",
        token: fileToken,
        fileName: cleanFileName,
        fileSize: stat.size
      });
    } else {
      sendEvent({
        type: "error",
        error: lastErrorLine || `yt-dlp exited with code ${code}`
      });
    }
    res.end();
  });
});

// Endpoint Ambil File Audio & Langsung Hapus dari Disk Render
app.get("/api/files/:token", requireApiKey, (req, res) => {
  const token = req.params.token;
  const meta = readyFiles.get(token);

  if (!meta || !fs.existsSync(meta.filePath)) {
    return res.status(404).json({ error: "File tidak ditemukan atau sudah kedaluwarsa." });
  }

  readyFiles.delete(token);
  res.download(meta.filePath, meta.fileName, () => {
    try { fs.unlinkSync(meta.filePath); } catch (_) {}
  });
});

app.listen(PORT, () => {
  console.log(`[Valdemort Audio API] Running on port ${PORT}`);
});
