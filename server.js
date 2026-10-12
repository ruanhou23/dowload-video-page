#!/usr/bin/env node

/**
 * OPhim Downloader - Server + Web GUI
 * Giao diện web để tìm kiếm, xem thông tin và tải phim
 */

import express from "express";
import { spawn } from "child_process";
import { existsSync, mkdirSync, statSync, readdirSync, rmSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createInterface } from "readline";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// ─── Constants ───────────────────────────────────────────────────────────────
const API_BASE = "https://phimapi.com/v1/api";
let DOWNLOAD_DIR = process.env.DOWNLOAD_DIR
  ? path.resolve(process.env.DOWNLOAD_DIR)
  : path.join(__dirname, "downloads");
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

// ─── Auto-detect ffmpeg ────────────────────────────────────────────────────
function findFfmpeg() {
  // Các vị trí phổ biến của ffmpeg
  const possiblePaths = [
    "ffmpeg",
    "ffmpeg.exe",
    path.join(process.env.LOCALAPPDATA || "", "Microsoft", "WinGet", "Packages", "Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe"),
    path.join(process.env.ProgramFiles || "C:\\Program Files", "FFmpeg", "bin", "ffmpeg.exe"),
    path.join(process.env.ProgramFiles || "C:\\Program Files", "ffmpeg", "bin", "ffmpeg.exe"),
    "C:\\ffmpeg\\bin\\ffmpeg.exe",
  ];

  // Tìm thư mục Gyan.FFmpeg (có version khác nhau)
  const wingetDir = path.join(process.env.LOCALAPPDATA || "", "Microsoft", "WinGet", "Packages");
  if (existsSync(wingetDir)) {
    try {
      const dirs = readdirSync(wingetDir);
      const ffmpegDir = dirs.find(d => d.startsWith("Gyan.FFmpeg"));
      if (ffmpegDir) {
        const fullDir = path.join(wingetDir, ffmpegDir);
        const subdirs = readdirSync(fullDir).filter(d => !d.endsWith(".db"));
        for (const sub of subdirs) {
          const binPath = path.join(fullDir, sub, "bin", "ffmpeg.exe");
          if (existsSync(binPath)) {
            possiblePaths.unshift(binPath);
          }
        }
      }
    } catch {}
  }

  for (const p of possiblePaths) {
    if (existsSync(p) || p === "ffmpeg" || p === "ffmpeg.exe") {
      return p;
    }
  }
  return "ffmpeg"; // fallback
}

const FFMPEG_PATH = findFfmpeg();
console.log(`  🔧 ffmpeg: ${FFMPEG_PATH}`);

// Đảm bảo thư mục downloads tồn tại
if (!existsSync(DOWNLOAD_DIR)) {
  mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

// ─── Store download tasks ────────────────────────────────────────────────────
const downloadTasks = new Map(); // taskId -> { status, progress, ... }

// ─── Middleware ──────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ─── API Proxy ──────────────────────────────────────────────────────────────

async function apiFetch(url) {
  const res = await fetch(url, {
    headers: { accept: "application/json", "User-Agent": USER_AGENT },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function normalizeImages(data) {
  if (!data) return;
  const cdn = data.APP_DOMAIN_CDN_IMAGE || "https://phimimg.com";
  const fixUrl = (u) => {
    if (!u) return u;
    if (u.startsWith("http://") || u.startsWith("https://")) return u;
    return `${cdn.replace(/\/+$/, "")}/${u.replace(/^\/+/, "")}`;
  };

  if (Array.isArray(data.items)) {
    data.items.forEach((item) => {
      if (item.thumb_url) item.thumb_url = fixUrl(item.thumb_url);
      if (item.poster_url) item.poster_url = fixUrl(item.poster_url);
    });
  }
  if (data.item) {
    if (data.item.thumb_url) data.item.thumb_url = fixUrl(data.item.thumb_url);
    if (data.item.poster_url) data.item.poster_url = fixUrl(data.item.poster_url);
  }
  if (data.movie) {
    if (data.movie.thumb_url) data.movie.thumb_url = fixUrl(data.movie.thumb_url);
    if (data.movie.poster_url) data.movie.poster_url = fixUrl(data.movie.poster_url);
  }
}

// GET /api/search?keyword=&page=&limit=
app.get("/api/search", async (req, res) => {
  try {
    const { keyword = "", page = 1, limit = 24 } = req.query;
    const url = `${API_BASE}/tim-kiem?keyword=${encodeURIComponent(keyword)}&page=${page}&limit=${limit}`;
    const data = await apiFetch(url);
    if (data.status !== "success" && data.status !== true) throw new Error(data.message || data.msg || "Search failed");
    normalizeImages(data.data);
    res.json(data.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/movie/:slug
app.get("/api/movie/:slug", async (req, res) => {
  try {
    const { slug } = req.params;
    const url = `${API_BASE}/phim/${encodeURIComponent(slug)}`;
    const data = await apiFetch(url);
    if (data.status !== "success" && data.status !== true) throw new Error(data.message || data.msg || "Failed");
    if (!data.data.item && data.data.movie) data.data.item = data.data.movie;
    normalizeImages(data.data);
    res.json(data.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/list/:slug?page=&limit=
app.get("/api/list/:slug", async (req, res) => {
  try {
    const { slug } = req.params;
    const { page = 1, limit = 24 } = req.query;
    const url = `${API_BASE}/danh-sach/${encodeURIComponent(slug)}?page=${page}&limit=${limit}`;
    const data = await apiFetch(url);
    if (data.status !== "success" && data.status !== true) throw new Error(data.message || data.msg || "Failed");
    normalizeImages(data.data);
    res.json(data.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/genres
app.get("/api/genres", async (req, res) => {
  try {
    const url = `${API_BASE}/the-loai`;
    const data = await apiFetch(url);
    if (data.status !== "success" && data.status !== true) throw new Error(data.message || data.msg || "Failed");
    const raw = data.data;
    res.json(Array.isArray(raw) ? raw : raw?.items || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/countries
app.get("/api/countries", async (req, res) => {
  try {
    const url = `${API_BASE}/quoc-gia`;
    const data = await apiFetch(url);
    if (data.status !== "success" && data.status !== true) throw new Error(data.message || data.msg || "Failed");
    const raw = data.data;
    res.json(Array.isArray(raw) ? raw : raw?.items || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/settings - Lấy thông tin thư mục lưu hiện tại
app.get("/api/settings", (req, res) => {
  res.json({ downloadDir: DOWNLOAD_DIR });
});

// POST /api/settings - Cập nhật thư mục lưu video
app.post("/api/settings", (req, res) => {
  try {
    const { downloadDir } = req.body;
    if (!downloadDir || typeof downloadDir !== "string") {
      return res.status(400).json({ error: "Đường dẫn thư mục không hợp lệ" });
    }
    const resolved = path.resolve(downloadDir.trim());
    if (!existsSync(resolved)) {
      mkdirSync(resolved, { recursive: true });
    }
    DOWNLOAD_DIR = resolved;
    process.env.DOWNLOAD_DIR = resolved;
    console.log(`  📁 Đã đổi thư mục tải thành: ${DOWNLOAD_DIR}`);
    res.json({ success: true, downloadDir: DOWNLOAD_DIR });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/open-folder - mở thư mục trong explorer
app.post("/api/open-folder", (req, res) => {
  try {
    const { path: folderPath } = req.body;
    if (!folderPath) return res.status(400).json({ error: "Missing path" });
    if (!existsSync(folderPath)) return res.status(404).json({ error: "Folder not found" });

    // Mở thư mục bằng explorer (Windows) hoặc finder (Mac) hoặc xdg-open (Linux)
    const cmd = process.platform === "win32"
      ? `explorer "${folderPath}"`
      : process.platform === "darwin"
        ? `open "${folderPath}"`
        : `xdg-open "${folderPath}"`;

    spawn(cmd, [], { shell: true, detached: true });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/downloads - danh sách file đã tải
app.get("/api/downloads", (req, res) => {
  try {
    if (!existsSync(DOWNLOAD_DIR)) {
      return res.json([]);
    }
    const dirs = readdirSync(DOWNLOAD_DIR, { withFileTypes: true });
    const result = dirs
      .filter((d) => d.isDirectory())
      .map((d) => {
        const moviePath = path.join(DOWNLOAD_DIR, d.name);
        let files = [];
        try {
          files = readdirSync(moviePath).filter((f) => f.endsWith(".mp4"));
        } catch {}
        let totalSize = 0;
        const fileDetails = files.map((f) => {
          let size = 0;
          try {
            size = statSync(path.join(moviePath, f)).size;
          } catch {}
          totalSize += size;
          return { name: f, size };
        });
        return {
          name: d.name,
          episodes: files.length,
          size: totalSize,
          files: files,
          fileDetails,
          path: moviePath,
        };
      });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function deleteMovieFolder(rawName) {
  const safeName = path.basename(rawName);
  const moviePath = path.join(DOWNLOAD_DIR, safeName);
  const resolvedPath = path.resolve(moviePath);
  const resolvedDownloadDir = path.resolve(DOWNLOAD_DIR);
  if (!resolvedPath.startsWith(resolvedDownloadDir) || resolvedPath === resolvedDownloadDir) {
    throw new Error("Đường dẫn không hợp lệ");
  }
  if (!existsSync(resolvedPath)) {
    throw new Error("Không tìm thấy thư mục phim hoặc đã bị xóa");
  }
  rmSync(resolvedPath, { recursive: true, force: true });
  for (const [taskId, task] of downloadTasks.entries()) {
    if (task.movieName === safeName || task.id.startsWith(safeName)) {
      task.status = "cancelled";
      if (task.process) {
        try { task.process.kill("SIGKILL"); } catch {}
      }
      downloadTasks.delete(taskId);
    }
  }
}

function clearAllDownloadFolders() {
  if (existsSync(DOWNLOAD_DIR)) {
    const items = readdirSync(DOWNLOAD_DIR);
    for (const item of items) {
      const itemPath = path.join(DOWNLOAD_DIR, item);
      rmSync(itemPath, { recursive: true, force: true });
    }
  }
  for (const [taskId, task] of downloadTasks.entries()) {
    task.status = "cancelled";
    if (task.process) {
      try { task.process.kill("SIGKILL"); } catch {}
    }
  }
  downloadTasks.clear();
}

// DELETE /api/downloads/:name - xóa một phim trong lịch sử
app.delete("/api/downloads/:name", (req, res) => {
  try {
    deleteMovieFolder(req.params.name);
    res.json({ success: true, message: "Đã xóa phim thành công" });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/downloads/delete - hỗ trợ gọi POST
app.post("/api/downloads/delete", (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: "Thiếu tên phim cần xóa" });
    deleteMovieFolder(name);
    res.json({ success: true, message: "Đã xóa phim thành công" });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /api/downloads/:name/file/:filename - xóa 1 tập của phim
app.delete("/api/downloads/:name/file/:filename", (req, res) => {
  try {
    const safeMovie = path.basename(req.params.name);
    const safeFile = path.basename(req.params.filename);
    const filePath = path.join(DOWNLOAD_DIR, safeMovie, safeFile);
    const resolvedPath = path.resolve(filePath);
    const resolvedDownloadDir = path.resolve(DOWNLOAD_DIR);
    if (!resolvedPath.startsWith(resolvedDownloadDir)) {
      return res.status(400).json({ error: "Đường dẫn không hợp lệ" });
    }
    if (existsSync(resolvedPath)) {
      rmSync(resolvedPath, { force: true });
    }
    res.json({ success: true, message: `Đã xóa tập ${safeFile}` });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /api/downloads - xóa tất cả lịch sử tải về
app.delete("/api/downloads", (req, res) => {
  try {
    clearAllDownloadFolders();
    res.json({ success: true, message: "Đã xóa toàn bộ lịch sử tải về" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/downloads/clear-all - hỗ trợ gọi POST
app.post("/api/downloads/clear-all", (req, res) => {
  try {
    clearAllDownloadFolders();
    res.json({ success: true, message: "Đã xóa toàn bộ lịch sử tải về" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Download API ────────────────────────────────────────────────────────────

// POST /api/download/start - bắt đầu tải
app.post("/api/download/start", async (req, res) => {
  try {
    const { slug, serverIndex = 0, episodes: selectedEps, movieName, outputDir } = req.body;

    // Lấy thông tin phim
    const movieUrl = `${API_BASE}/phim/${encodeURIComponent(slug)}`;
    const data = await apiFetch(movieUrl);
    if (data.status !== "success" && data.status !== true) throw new Error(data.message || data.msg || "Failed");
    if (!data.data.item && data.data.movie) data.data.item = data.data.movie;

    const movie = data.data.item;
    const episodes = movie.episodes || data.data.episodes || [];
    const server = episodes[serverIndex];
    if (!server || !server.server_data) throw new Error("Server không có dữ liệu");

    const allEps = server.server_data;

    // Xác định danh sách tập cần tải
    let toDownload = [];
    if (selectedEps === "all") {
      toDownload = allEps
        .map((ep, idx) => ({ ep, idx }))
        .filter(({ ep }) => ep.link_m3u8);
    } else if (Array.isArray(selectedEps)) {
      toDownload = selectedEps
        .map((i) => ({ ep: allEps[i], idx: i }))
        .filter(({ ep }) => ep && ep.link_m3u8);
    } else {
      throw new Error("Phải chọn tập hoặc 'all'");
    }

    if (toDownload.length === 0) {
      throw new Error("Không có tập nào có link_m3u8 để tải");
    }

    let targetDownloadDir = DOWNLOAD_DIR;
    if (outputDir && typeof outputDir === "string" && outputDir.trim()) {
      targetDownloadDir = path.resolve(outputDir.trim());
      if (!existsSync(targetDownloadDir)) {
        mkdirSync(targetDownloadDir, { recursive: true });
      }
    }

    const taskId = `${slug}_${Date.now()}`;
    const movieDir = path.join(targetDownloadDir, sanitizeFilename(movieName || movie.name));
    if (!existsSync(movieDir)) {
      mkdirSync(movieDir, { recursive: true });
    }

    // Tạo task
    const task = {
      id: taskId,
      movieName: movieName || movie.name,
      slug,
      total: toDownload.length,
      completed: 0,
      current: "",
      progress: 0,
      episodes: toDownload.map(({ ep, idx }) => ({
        index: idx,
        name: ep.name || `Tập ${idx + 1}`,
        status: "pending", // pending | downloading | done | error | skipped
        file: path.join(movieDir, `${sanitizeFilename(ep.name || `Tập ${idx + 1}`)}.mp4`),
        m3u8: ep.link_m3u8,
      })),
      status: "running",
      createdAt: Date.now(),
    };

    downloadTasks.set(taskId, task);
    res.json({ taskId });

    // Xử lý tải tuần tự trong background
    runDownloadTask(taskId).catch((err) => {
      console.error(`[Task ${taskId}] Error:`, err.message);
      const t = downloadTasks.get(taskId);
      if (t) t.status = "error";
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/download/progress/:taskId
app.get("/api/download/progress/:taskId", (req, res) => {
  const task = downloadTasks.get(req.params.taskId);
  if (!task) return res.json({ error: "Task not found" });
  res.json(task);
});

// GET /api/download/progress/:taskId/stream - SSE
app.get("/api/download/progress/:taskId/stream", (req, res) => {
  const taskId = req.params.taskId;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const send = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // Gửi trạng thái hiện tại
  const task = downloadTasks.get(taskId);
  if (task) send(task);

  // Polling mỗi 500ms
  const interval = setInterval(() => {
    const t = downloadTasks.get(taskId);
    if (t) {
      send(t);
      if (t.status === "done" || t.status === "error") {
        clearInterval(interval);
        res.end();
      }
    } else {
      clearInterval(interval);
      res.end();
    }
  }, 500);

  req.on("close", () => {
    clearInterval(interval);
  });
});

// POST /api/download/cancel/:taskId
app.post("/api/download/cancel/:taskId", (req, res) => {
  const task = downloadTasks.get(req.params.taskId);
  if (!task) return res.status(404).json({ error: "Task not found" });
  task.status = "cancelled";
  if (task.process) {
    task.process.kill("SIGKILL");
  }
  res.json({ success: true });
});

// ─── Download Runner ─────────────────────────────────────────────────────────

async function runDownloadTask(taskId) {
  const task = downloadTasks.get(taskId);
  if (!task) return;

  for (let i = 0; i < task.episodes.length; i++) {
    const ep = task.episodes[i];
    if (task.status === "cancelled") break;

    // Kiểm tra file đã tồn tại
    if (existsSync(ep.file)) {
      try {
        const stat = statSync(ep.file);
        if (stat.size > 1024 * 1024) {
          ep.status = "skipped";
          task.completed++;
          continue;
        }
      } catch {}
    }

    ep.status = "downloading";
    task.current = ep.name;

    try {
      await downloadEpisode(ep.m3u8, ep.file, (pct) => {
        task.progress = Math.round(
          ((task.completed + pct / 100) / task.total) * 100
        );
      });

      ep.status = "done";
      task.completed++;
      task.progress = Math.round((task.completed / task.total) * 100);
    } catch (err) {
      ep.status = "error";
      ep.error = err.message;
      task.completed++;
    }

    // Delay nhẹ giữa các tập
    if (i < task.episodes.length - 1) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  task.status = task.status === "cancelled" ? "cancelled" : "done";
  task.current = "";
}

function downloadEpisode(m3u8Url, outputPath, onProgress) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(FFMPEG_PATH, [
      "-y",
      "-user_agent", USER_AGENT,
      "-i", m3u8Url,
      "-c", "copy",
      "-bsf:a", "aac_adtstoasc",
      "-movflags", "+faststart",
      "-progress", "pipe:1",
      "-nostats",
      "-loglevel", "error",
      outputPath,
    ]);

    let duration = 0;
    let outTime = 0;

    ffmpeg.stdout.on("data", (data) => {
      const lines = data.toString().split("\n");
      for (const line of lines) {
        if (line.startsWith("duration=")) {
          const val = line.split("=")[1]?.trim();
          if (val && val !== "N/A") {
            const parts = val.split(":").map(parseFloat);
            duration = parts[0] * 3600 + parts[1] * 60 + (parts[2] || 0);
          }
        }
        if (line.startsWith("out_time=")) {
          const val = line.split("=")[1]?.trim();
          if (val && val !== "N/A") {
            const parts = val.split(":").map(parseFloat);
            outTime = parts[0] * 3600 + parts[1] * 60 + (parts[2] || 0);
          }
        }
      }
      if (duration > 0 && onProgress) {
        onProgress(Math.min(100, Math.round((outTime / duration) * 100)));
      }
    });

    ffmpeg.on("close", (code) => {
      if (code === 0) resolve(true);
      else reject(new Error(`ffmpeg exit code ${code}`));
    });

    ffmpeg.on("error", () => {
      reject(new Error("Không tìm thấy ffmpeg. Hãy cài đặt ffmpeg và thêm vào PATH."));
    });
  });
}

function sanitizeFilename(name) {
  return name
    .replace(/[<>:"/\\|?*]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .substring(0, 200);
}

// ─── Serve index.html for all other routes ──────────────────────────────────
app.get("*", (req, res) => {
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({ error: "Not found" });
  }
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ─── Start Server ───────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log("");
  console.log("  🎬 OPhim Downloader - Web GUI");
  console.log("  ════════════════════════════════");
  console.log(`  🌐 http://localhost:${PORT}`);
  console.log("");
  console.log("  Tính năng:");
  console.log("  - Tìm kiếm phim");
  console.log("  - Xem danh sách tập");
  console.log("  - Tải theo tập hoặc cả bộ");
  console.log("  - Theo dõi tiến độ tải realtime");
  console.log("");
  console.log(`  📁 Thư mục tải: ${DOWNLOAD_DIR}`);
  console.log("");
});
