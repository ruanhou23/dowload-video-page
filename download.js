#!/usr/bin/env node

/**
 * OPhim Downloader - CLI tool tải phim từ API ophim1.com
 *
 * Tính năng:
 * - Tìm kiếm phim theo từ khóa
 * - Xem thông tin chi tiết phim + danh sách tập
 * - Tải theo tập (chọn tập cụ thể)
 * - Tải theo bộ (tất cả các tập)
 * - Hỗ trợ tải qua m3u8 (ffmpeg) hoặc link_embed
 *
 * API tham khảo từ: https://ophim1.com/v1/api
 */

import { program } from "commander";
import inquirer from "inquirer";
import chalk from "chalk";
import ora from "ora";
import { spawn } from "child_process";
import { existsSync, mkdirSync, statSync, readdirSync, rmSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

// ─── Constants ───────────────────────────────────────────────────────────────
const API_BASE = "https://phimapi.com/v1/api";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
let DOWNLOAD_DIR = process.env.DOWNLOAD_DIR
  ? path.resolve(process.env.DOWNLOAD_DIR)
  : path.join(__dirname, "downloads");

// ─── Auto-detect ffmpeg ────────────────────────────────────────────────────
function findFfmpeg() {
  const possiblePaths = [
    "ffmpeg",
    "ffmpeg.exe",
  ];

  // Tìm thư mục Gyan.FFmpeg từ winget
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
          if (existsSync(binPath)) possiblePaths.unshift(binPath);
        }
      }
    } catch {}
  }

  for (const p of possiblePaths) {
    if (existsSync(p) || p === "ffmpeg" || p === "ffmpeg.exe") return p;
  }
  return "ffmpeg";
}

const FFMPEG_PATH = findFfmpeg();

// ─── Utilities ───────────────────────────────────────────────────────────────

/** Gọi API với timeout & retry */
async function apiFetch(url, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);

      const res = await fetch(url, {
        headers: {
          accept: "application/json",
          "User-Agent": USER_AGENT,
        },
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }

      const data = await res.json();
      return data;
    } catch (err) {
      if (i === retries) throw err;
      await sleep(1000 * (i + 1));
    }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Format bytes sang human-readable */
function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(1) + " " + units[i];
}

/** Làm sạch tên file */
function sanitizeFilename(name) {
  return name
    .replace(/[<>:"/\\|?*]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .substring(0, 200);
}

/** Format thời lượng giây -> mm:ss */
function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

// ─── API Functions ───────────────────────────────────────────────────────────

/** Tìm kiếm phim */
async function searchMovies(keyword, page = 1, limit = 20) {
  const url = `${API_BASE}/tim-kiem?keyword=${encodeURIComponent(keyword)}&page=${page}&limit=${limit}`;
  const data = await apiFetch(url);
  if (data.status !== "success" && data.status !== true) {
    throw new Error(data.message || data.msg || "Search failed");
  }
  return data.data;
}

/** Lấy chi tiết phim (bao gồm episodes) */
async function getMovieDetail(slug) {
  const url = `${API_BASE}/phim/${encodeURIComponent(slug)}`;
  const data = await apiFetch(url);
  if (data.status !== "success" && data.status !== true) {
    throw new Error(data.message || data.msg || "Không thể lấy thông tin phim");
  }

  // Normalize: đảm bảo có `data.item`
  if (!data.data.item && data.data.movie) {
    data.data.item = data.data.movie;
  }
  if (!data.data.item) {
    throw new Error("Thiếu dữ liệu phim");
  }

  return data.data;
}

/** Lấy danh sách phim theo danh mục */
async function getListBySlug(slug, page = 1, limit = 24) {
  const url = `${API_BASE}/danh-sach/${encodeURIComponent(slug)}?page=${page}&limit=${limit}`;
  const data = await apiFetch(url);
  if (data.status !== "success" && data.status !== true) {
    throw new Error(data.message || data.msg || "Không thể lấy danh sách");
  }
  return data.data;
}

// ─── Display Functions ──────────────────────────────────────────────────────

/** In thông tin chi tiết phim */
function displayMovieInfo(movie, episodes) {
  console.log("");
  console.log(chalk.bold.cyan("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"));
  console.log(chalk.bold.yellow(`  ${movie.name}`));
  if (movie.origin_name && movie.origin_name !== movie.name) {
    console.log(chalk.gray(`  ${movie.origin_name}`));
  }
  console.log(chalk.bold.cyan("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"));
  console.log("");
  console.log(`  ${chalk.gray("Năm:")}        ${chalk.white(movie.year || "N/A")}`);
  console.log(`  ${chalk.gray("Chất lượng:")} ${chalk.white(movie.quality || "HD")}`);
  console.log(`  ${chalk.gray("Ngôn ngữ:")}   ${chalk.white(movie.lang || "Vietsub")}`);
  console.log(`  ${chalk.gray("Thời lượng:")} ${chalk.white(movie.time || "N/A")}`);
  console.log(`  ${chalk.gray("Trạng thái:")} ${chalk.white(movie.episode_current || "N/A")}`);
  console.log(`  ${chalk.gray("Tổng số tập:")} ${chalk.white(movie.episode_total || "N/A")}`);
  console.log(`  ${chalk.gray("Loại:")}       ${chalk.white(movie.type === "series" ? "Phim bộ" : "Phim lẻ")}`);

  if (movie.category?.length) {
    console.log(`  ${chalk.gray("Thể loại:")}  ${chalk.white(movie.category.map((c) => c.name).join(", "))}`);
  }
  if (movie.country?.length) {
    console.log(`  ${chalk.gray("Quốc gia:")}  ${chalk.white(movie.country.map((c) => c.name).join(", "))}`);
  }
  if (movie.director?.length) {
    console.log(`  ${chalk.gray("Đạo diễn:")}  ${chalk.white(movie.director.join(", "))}`);
  }
  if (movie.actor?.length) {
    console.log(`  ${chalk.gray("Diễn viên:")} ${chalk.white(movie.actor.slice(0, 5).join(", "))}`);
  }

  console.log("");
  console.log(chalk.bold.cyan("  📺 DANH SÁCH TẬP / SERVER"));
  console.log("");

  if (!episodes || episodes.length === 0) {
    console.log(chalk.yellow("  ⚠ Không có dữ liệu tập nào."));
    return;
  }

  episodes.forEach((server, sIdx) => {
    const serverName = server.server_name || `Server ${sIdx + 1}`;
    const aiTag = server.is_ai ? chalk.magenta(" [AI]") : "";
    console.log(chalk.bold.green(`  ▸ Server: ${serverName}${aiTag}`));
    console.log(chalk.gray(`    ${"─".repeat(50)}`));

    const eps = server.server_data || [];
    // Hiển thị dạng lưới: mỗi hàng 5 tập
    for (let i = 0; i < eps.length; i += 5) {
      const row = eps.slice(i, i + 5).map((ep, j) => {
        const epIdx = i + j;
        const num = String(epIdx).padStart(3, "0");
        const name = ep.name || `Tập ${epIdx + 1}`;
        const hasM3u8 = ep.link_m3u8 ? chalk.green(" ✓") : chalk.red(" ✗");
        return chalk.gray(`[${num}]`) + ` ${name}${hasM3u8}`;
      });
      console.log(`    ${row.join("  ")}`);
    }
    console.log("");
  });

  // Đếm tổng số tập có link_m3u8
  let totalDownloadable = 0;
  let totalEpisodes = 0;
  episodes.forEach((s) => {
    (s.server_data || []).forEach((ep) => {
      totalEpisodes++;
      if (ep.link_m3u8) totalDownloadable++;
    });
  });
  console.log(chalk.gray(`  Tổng: ${totalEpisodes} tập | Có thể tải: ${totalDownloadable} tập (có link_m3u8)`));
  console.log("");
}

/** In kết quả tìm kiếm */
function displaySearchResults(items, keyword) {
  console.log("");
  console.log(chalk.bold.cyan("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"));
  console.log(chalk.bold.cyan(`  Kết quả tìm kiếm: "${keyword}"`));
  console.log(chalk.bold.cyan("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"));
  console.log("");

  if (!items || items.length === 0) {
    console.log(chalk.yellow("  Không tìm thấy phim nào."));
    return;
  }

  items.forEach((movie, idx) => {
    const index = chalk.bold.white(`[${String(idx).padStart(2, "0")}]`);
    const title = chalk.bold.green(movie.name);
    const origName = movie.origin_name && movie.origin_name !== movie.name
      ? chalk.gray(` (${movie.origin_name})`)
      : "";
    const type = movie.type === "series" ? chalk.cyan("[Bộ]") : chalk.yellow("[Lẻ]");
    const year = chalk.white(` | ${movie.year || "N/A"}`);
    const quality = chalk.magenta(` | ${movie.quality || "HD"}`);
    const lang = chalk.gray(` | ${movie.lang || "Vietsub"}`);
    const ep = movie.episode_current ? chalk.blue(` | ${movie.episode_current}`) : "";

    console.log(`  ${index} ${type} ${title}${origName}`);
    console.log(`      ${year}${quality}${lang}${ep}`);
    console.log(`      ${chalk.gray("slug:")} ${chalk.dim(movie.slug)}`);
    console.log("");
  });

  console.log(chalk.gray(`  Hiển thị ${items.length} kết quả.`));
  console.log("");
}

// ─── Download Logic ──────────────────────────────────────────────────────────

/**
 * Tải một tập phim từ link_m3u8 sử dụng ffmpeg
 */
function downloadEpisode(m3u8Url, outputPath, episodeName) {
  return new Promise((resolve, reject) => {
    // Kiểm tra ffmpeg có sẵn không
    const ffmpeg = spawn(FFMPEG_PATH, [
      "-y", // overwrite
      "-user_agent", USER_AGENT,
      "-i", m3u8Url,
      "-c", "copy", // copy codec, không re-encode
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
          // duration ở dạng HH:MM:SS.ms
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

      // In progress
      if (duration > 0) {
        const pct = Math.min(100, Math.round((outTime / duration) * 100));
        const bar = "█".repeat(Math.floor(pct / 2)) + "░".repeat(50 - Math.floor(pct / 2));
        process.stdout.write(
          `\r  ${chalk.cyan(`[${episodeName}]`)} ${chalk.green(bar)} ${chalk.yellow(`${pct}%`)} ${chalk.gray(`${formatDuration(outTime)}/${formatDuration(duration)}`)}`
        );
      }
    });

    ffmpeg.stderr.on("data", (data) => {
      // ffmpeg in lỗi ra stderr, có thể ignore nếu không quan trọng
    });

    ffmpeg.on("close", (code) => {
      process.stdout.write("\n");
      if (code === 0) {
        resolve(true);
      } else {
        reject(new Error(`ffmpeg exited with code ${code}`));
      }
    });

    ffmpeg.on("error", (err) => {
      reject(new Error(`Không thể chạy ffmpeg: ${err.message}. Hãy cài ffmpeg và thêm vào PATH.`));
    });
  });
}

/**
 * Tải tất cả các tập từ danh sách episodes
 */
async function downloadAllEpisodes(episodes, movieName, serverIndex = 0) {
  const server = episodes[serverIndex];
  if (!server || !server.server_data || server.server_data.length === 0) {
    console.log(chalk.red("  Không có tập nào để tải."));
    return [];
  }

  const results = [];
  const eps = server.server_data;

  // Lọc các tập có link_m3u8
  const downloadable = eps
    .map((ep, idx) => ({ ep, idx }))
    .filter(({ ep }) => ep.link_m3u8);

  if (downloadable.length === 0) {
    console.log(chalk.yellow("  Không có tập nào có link_m3u8 để tải."));
    console.log(chalk.gray("  Gợi ý: Thử server khác hoặc tập khác."));
    return [];
  }

  console.log("");
  console.log(chalk.bold.cyan(`  🎬 Bắt đầu tải ${downloadable.length} tập của "${movieName}"`));
  console.log(chalk.gray(`  Server: ${server.server_name || serverIndex}`));
  console.log("");

  // Tạo thư mục cho phim
  const movieDir = path.join(DOWNLOAD_DIR, sanitizeFilename(movieName));
  if (!existsSync(movieDir)) {
    mkdirSync(movieDir, { recursive: true });
  }

  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < downloadable.length; i++) {
    const { ep, idx } = downloadable[i];
    const epName = ep.name || `Tập ${idx + 1}`;
    const safeEpName = sanitizeFilename(epName);
    const outputFile = path.join(movieDir, `${safeEpName}.mp4`);

    console.log(chalk.white(`  [${i + 1}/${downloadable.length}] Đang tải: ${epName}`));

    // Kiểm tra file đã tồn tại
    if (existsSync(outputFile)) {
      const stat = statSync(outputFile);
      if (stat.size > 1024 * 1024) { // > 1MB, coi như đã tải xong
        console.log(chalk.yellow(`  ↳ Đã tồn tại (${formatBytes(stat.size)}), bỏ qua.`));
        successCount++;
        results.push({ episode: epName, file: outputFile, status: "skipped" });
        continue;
      }
    }

    try {
      await downloadEpisode(ep.link_m3u8, outputFile, `${i + 1}/${downloadable.length}`);
      const stat2 = statSync(outputFile);
      console.log(chalk.green(`  ✓ Hoàn thành: ${epName} (${formatBytes(stat2.size)})`));
      successCount++;
      results.push({ episode: epName, file: outputFile, status: "success" });
    } catch (err) {
      console.log(chalk.red(`  ✗ Lỗi: ${epName} - ${err.message}`));
      failCount++;
      results.push({ episode: epName, file: outputFile, status: "error", error: err.message });
    }

    // Delay nhẹ giữa các lần tải
    if (i < downloadable.length - 1) {
      await sleep(500);
    }
  }

  console.log("");
  console.log(chalk.bold.cyan("  📊 KẾT QUẢ TẢI:"));
  console.log(`  ${chalk.green(`✓ Thành công: ${successCount}`)}  ${chalk.red(`✗ Thất bại: ${failCount}`)}`);
  console.log(`  ${chalk.gray(`📁 Thư mục: ${movieDir}`)}`);
  console.log("");

  return results;
}

/**
 * Tải các tập được chọn
 */
async function downloadSelectedEpisodes(episodes, movieName, serverIndex, episodeIndexes) {
  const server = episodes[serverIndex];
  if (!server || !server.server_data) {
    console.log(chalk.red("  Server không tồn tại."));
    return [];
  }

  const eps = server.server_data;
  const movieDir = path.join(DOWNLOAD_DIR, sanitizeFilename(movieName));
  if (!existsSync(movieDir)) {
    mkdirSync(movieDir, { recursive: true });
  }

  const results = [];

  for (let i = 0; i < episodeIndexes.length; i++) {
    const epIdx = episodeIndexes[i];
    const ep = eps[epIdx];
    if (!ep) {
      console.log(chalk.yellow(`  Tập [${epIdx}] không tồn tại, bỏ qua.`));
      continue;
    }

    if (!ep.link_m3u8) {
      console.log(chalk.yellow(`  Tập "${ep.name || epIdx}" không có link_m3u8, bỏ qua.`));
      console.log(chalk.gray(`    Gợi ý: Thử server khác.`));
      continue;
    }

    const epName = ep.name || `Tập ${epIdx + 1}`;
    const safeEpName = sanitizeFilename(epName);
    const outputFile = path.join(movieDir, `${safeEpName}.mp4`);

    console.log(chalk.white(`  [${i + 1}/${episodeIndexes.length}] Đang tải: ${epName}`));

    // Kiểm tra file đã tồn tại
    if (existsSync(outputFile)) {
      const stat1 = statSync(outputFile);
      if (stat1.size > 1024 * 1024) {
        console.log(chalk.yellow(`  ↳ Đã tồn tại (${formatBytes(stat1.size)}), bỏ qua.`));
        results.push({ episode: epName, file: outputFile, status: "skipped" });
        continue;
      }
    }

    try {
      await downloadEpisode(ep.link_m3u8, outputFile, `${i + 1}/${episodeIndexes.length}`);
      const stat2 = statSync(outputFile);
      console.log(chalk.green(`  ✓ Hoàn thành: ${epName} (${formatBytes(stat2.size)})`));
      results.push({ episode: epName, file: outputFile, status: "success" });
    } catch (err) {
      console.log(chalk.red(`  ✗ Lỗi: ${epName} - ${err.message}`));
      results.push({ episode: epName, file: outputFile, status: "error", error: err.message });
    }

    if (i < episodeIndexes.length - 1) {
      await sleep(500);
    }
  }

  console.log("");
  const successCount = results.filter((r) => r.status === "success" || r.status === "skipped").length;
  const failCount = results.filter((r) => r.status === "error").length;
  console.log(chalk.bold.cyan("  📊 KẾT QUẢ:"));
  console.log(`  ${chalk.green(`✓ Hoàn thành: ${successCount}`)}  ${chalk.red(`✗ Thất bại: ${failCount}`)}`);
  console.log(`  ${chalk.gray(`📁 Thư mục: ${movieDir}`)}`);
  console.log("");

  return results;
}

// ─── Interactive Mode ────────────────────────────────────────────────────────

/**
 * Tương tác: chọn server & tập để tải
 */
async function interactiveDownload(movieSlug) {
  const spinner = ora("Đang lấy thông tin phim...").start();

  try {
    const detail = await getMovieDetail(movieSlug);
    const movie = detail.item || detail.movie;
    const episodes = movie.episodes || detail.episodes || [];

    spinner.stop();

    if (!movie) {
      console.log(chalk.red("Không tìm thấy phim."));
      return;
    }

    if (!episodes.length) {
      console.log(chalk.yellow("Phim chưa có dữ liệu tập."));
      console.log(chalk.gray(JSON.stringify(movie, null, 2)));
      return;
    }

    displayMovieInfo(movie, episodes);

    // Chọn server
    const serverChoices = episodes.map((s, idx) => {
      const name = s.server_name || `Server ${idx + 1}`;
      const ai = s.is_ai ? " [AI]" : "";
      const count = (s.server_data || []).length;
      const downloadable = (s.server_data || []).filter((e) => e.link_m3u8).length;
      return {
        name: `${name}${ai} (${count} tập, ${downloadable} tải được)`,
        value: idx,
      };
    });

    const { serverIndex } = await inquirer.prompt([
      {
        type: "list",
        name: "serverIndex",
        message: "Chọn server:",
        choices: serverChoices,
        pageSize: 10,
      },
    ]);

    const selectedServer = episodes[serverIndex];
    const serverEps = selectedServer.server_data || [];

    // Hỏi chế độ tải
    const { downloadMode } = await inquirer.prompt([
      {
        type: "list",
        name: "downloadMode",
        message: "Chọn chế độ tải:",
        choices: [
          { name: "🎯 Tải các tập được chọn (chọn cụ thể)", value: "select" },
          { name: "📦 Tải tất cả các tập có link_m3u8", value: "all" },
          { name: "📋 Chỉ hiển thị link m3u8", value: "list" },
        ],
      },
    ]);

    if (downloadMode === "list") {
      // Chỉ hiển thị link
      console.log("");
      console.log(chalk.bold.cyan("  🔗 DANH SÁCH LINK M3U8:"));
      console.log("");
      serverEps.forEach((ep, idx) => {
        const name = ep.name || `Tập ${idx + 1}`;
        console.log(chalk.gray(`  [${String(idx).padStart(3, "0")}] ${name}`));
        if (ep.link_m3u8) {
          console.log(chalk.dim(`       ${ep.link_m3u8}`));
        } else if (ep.link_embed) {
          console.log(chalk.dim(`       embed: ${ep.link_embed}`));
        } else {
          console.log(chalk.red("       (không có link)"));
        }
      });
      console.log("");
      return;
    }

    // Hỏi thư mục lưu
    const { targetFolder } = await inquirer.prompt([
      {
        type: "input",
        name: "targetFolder",
        message: "📁 Thư mục lưu video tải về:",
        default: DOWNLOAD_DIR,
      },
    ]);
    if (targetFolder && targetFolder.trim()) {
      DOWNLOAD_DIR = path.resolve(targetFolder.trim());
      process.env.DOWNLOAD_DIR = DOWNLOAD_DIR;
      if (!existsSync(DOWNLOAD_DIR)) {
        mkdirSync(DOWNLOAD_DIR, { recursive: true });
      }
    }

    if (downloadMode === "all") {
      await downloadAllEpisodes(episodes, movie.name, serverIndex);
      return;
    }

    // Chọn tập cụ thể
    const epChoices = serverEps.map((ep, idx) => {
      const name = ep.name || `Tập ${idx + 1}`;
      const hasM3u8 = ep.link_m3u8 ? " ✓" : " ✗";
      return {
        name: `[${String(idx).padStart(3, "0")}] ${name}${hasM3u8}`,
        value: idx,
        checked: !!ep.link_m3u8, // pre-check nếu có thể tải
      };
    });

    const { selectedEpisodes } = await inquirer.prompt([
      {
        type: "checkbox",
        name: "selectedEpisodes",
        message: "Chọn tập cần tải (space để chọn, enter để xác nhận):",
        choices: epChoices,
        pageSize: 15,
        validate: (input) => {
          if (input.length === 0) return "Phải chọn ít nhất 1 tập!";
          return true;
        },
      },
    ]);

    if (selectedEpisodes.length === 0) {
      console.log(chalk.yellow("Không có tập nào được chọn."));
      return;
    }

    await downloadSelectedEpisodes(episodes, movie.name, serverIndex, selectedEpisodes);
  } catch (err) {
    spinner.stop();
    console.log(chalk.red(`Lỗi: ${err.message}`));
  }
}

// ─── CLI Commands ────────────────────────────────────────────────────────────

program
  .name("ophim-dl")
  .description("CLI tool tải phim từ API OPhim - Tải theo tập, theo bộ")
  .version("1.0.0");

/** Lệnh tìm kiếm */
program
  .command("search")
  .alias("s")
  .description("Tìm kiếm phim theo từ khóa")
  .argument("<keyword>", "Từ khóa tìm kiếm")
  .option("-p, --page <number>", "Số trang", "1")
  .option("-l, --limit <number>", "Số kết quả mỗi trang", "20")
  .action(async (keyword, options) => {
    const spinner = ora(`Đang tìm "${keyword}"...`).start();
    try {
      const data = await searchMovies(keyword, parseInt(options.page), parseInt(options.limit));
      spinner.stop();
      displaySearchResults(data.items || [], keyword);

      if (data.params?.pagination) {
        const p = data.params.pagination;
        console.log(chalk.gray(`  Trang ${p.currentPage}/${Math.ceil(p.totalItems / p.totalItemsPerPage)} | Tổng: ${p.totalItems} kết quả`));
        console.log("");
      }

      // Hỏi có muốn xem chi tiết không
      if (data.items?.length > 0) {
        const { selectedIndex } = await inquirer.prompt([
          {
            type: "input",
            name: "selectedIndex",
            message: "Nhập số thứ tự để xem chi tiết & tải (hoặc Enter để bỏ qua):",
            validate: (input) => {
              if (!input.trim()) return true;
              const num = parseInt(input);
              if (isNaN(num) || num < 0 || num >= data.items.length) {
                return `Vui lòng nhập số từ 0-${data.items.length - 1}`;
              }
              return true;
            },
          },
        ]);

        if (selectedIndex.trim() !== "") {
          const movie = data.items[parseInt(selectedIndex)];
          await interactiveDownload(movie.slug);
        }
      }
    } catch (err) {
      spinner.stop();
      console.log(chalk.red(`Lỗi: ${err.message}`));
    }
  });

/** Lệnh xem thông tin phim */
program
  .command("info")
  .alias("i")
  .description("Xem thông tin chi tiết phim và danh sách tập")
  .argument("<slug>", "Slug của phim (VD: tro-choi-con-muc)")
  .action(async (slug) => {
    const spinner = ora("Đang lấy thông tin phim...").start();
    try {
      const detail = await getMovieDetail(slug);
      const movie = detail.item || detail.movie;
      const episodes = movie.episodes || detail.episodes || [];
      spinner.stop();
      displayMovieInfo(movie, episodes);
    } catch (err) {
      spinner.stop();
      console.log(chalk.red(`Lỗi: ${err.message}`));
    }
  });

/** Lệnh tải phim */
program
  .command("download")
  .alias("dl")
  .description("Tải phim - có thể tải theo tập hoặc cả bộ")
  .argument("<slug>", "Slug của phim")
  .option("-a, --all", "Tải tất cả các tập (theo bộ)")
  .option("-s, --server <number>", "Chọn server (mặc định: 0)", "0")
  .option("-e, --episodes <numbers>", "Tập cần tải, cách nhau bởi dấu phẩy (VD: 0,1,2,5)")
  .option("-o, --output <path>", "Thư mục lưu file (mặc định: ./downloads)")
  .option("--list-links", "Chỉ hiển thị link m3u8, không tải")
  .action(async (slug, options) => {
    const spinner = ora("Đang lấy thông tin phim...").start();
    try {
      const detail = await getMovieDetail(slug);
      const movie = detail.item || detail.movie;
      const episodes = movie.episodes || detail.episodes || [];
      spinner.stop();

      const serverIndex = parseInt(options.server);

      // Xử lý output dir
      if (options.output) {
        const customDir = path.resolve(options.output);
        if (!existsSync(customDir)) {
          mkdirSync(customDir, { recursive: true });
        }
        DOWNLOAD_DIR = customDir;
        process.env.DOWNLOAD_DIR = customDir;
      }

      // --list-links
      if (options.listLinks) {
        const server = episodes[serverIndex];
        if (!server) {
          console.log(chalk.red(`Server ${serverIndex} không tồn tại.`));
          return;
        }
        console.log("");
        console.log(chalk.bold.cyan(`  🔗 LINK M3U8 - ${movie.name}`));
        console.log(chalk.gray(`  Server: ${server.server_name || serverIndex}`));
        console.log("");
        (server.server_data || []).forEach((ep, idx) => {
          const name = ep.name || `Tập ${idx + 1}`;
          console.log(chalk.gray(`  [${String(idx).padStart(3, "0")}] ${name}`));
          if (ep.link_m3u8) {
            console.log(chalk.dim(`       ${ep.link_m3u8}`));
          } else {
            console.log(chalk.red("       (không có link_m3u8)"));
          }
        });
        console.log("");
        return;
      }

      displayMovieInfo(movie, episodes);

      // --all: Tải tất cả tập
      if (options.all) {
        await downloadAllEpisodes(episodes, movie.name, serverIndex);
        return;
      }

      // --episodes: Tải tập được chọn
      if (options.episodes) {
        const epIndexes = options.episodes
          .split(",")
          .map((s) => parseInt(s.trim()))
          .filter((n) => !isNaN(n));

        if (epIndexes.length === 0) {
          console.log(chalk.red("Danh sách tập không hợp lệ."));
          return;
        }

        await downloadSelectedEpisodes(episodes, movie.name, serverIndex, epIndexes);
        return;
      }

      // Không có flag: vào interactive mode
      await interactiveDownload(slug);
    } catch (err) {
      spinner.stop();
      console.log(chalk.red(`Lỗi: ${err.message}`));
    }
  });

/** Lệnh danh sách phim theo danh mục */
program
  .command("list")
  .alias("ls")
  .description("Xem danh sách phim theo danh mục")
  .argument("[slug]", "Danh mục (phim-moi, phim-bo, phim-le, phim-hot, hoat-hinh, ...)", "phim-moi")
  .option("-p, --page <number>", "Số trang", "1")
  .action(async (slug, options) => {
    const spinner = ora(`Đang lấy danh sách "${slug}"...`).start();
    try {
      const data = await getListBySlug(slug, parseInt(options.page));
      spinner.stop();

      const items = data.items || [];
      displaySearchResults(items, slug);

      if (data.params?.pagination) {
        const p = data.params.pagination;
        console.log(chalk.gray(`  Trang ${p.currentPage}/${Math.ceil(p.totalItems / p.totalItemsPerPage)} | Tổng: ${p.totalItems} kết quả`));
        console.log("");
      }

      // Hỏi có muốn xem chi tiết không
      if (items.length > 0) {
        const { selectedIndex } = await inquirer.prompt([
          {
            type: "input",
            name: "selectedIndex",
            message: "Nhập số thứ tự để xem chi tiết & tải (hoặc Enter để bỏ qua):",
            validate: (input) => {
              if (!input.trim()) return true;
              const num = parseInt(input);
              if (isNaN(num) || num < 0 || num >= items.length) {
                return `Vui lòng nhập số từ 0-${items.length - 1}`;
              }
              return true;
            },
          },
        ]);

        if (selectedIndex.trim() !== "") {
          const movie = items[parseInt(selectedIndex)];
          await interactiveDownload(movie.slug);
        }
      }
    } catch (err) {
      spinner.stop();
      console.log(chalk.red(`Lỗi: ${err.message}`));
    }
  });

program
  .command("clean")
  .description("Xóa lịch sử và file phim đã tải trong thư mục downloads")
  .option("-a, --all", "Xóa toàn bộ file đã tải")
  .action(async (options) => {
    const targetDir = finalDownloadDir;
    if (!existsSync(targetDir)) {
      console.log(chalk.yellow("Thư mục downloads chưa tồn tại."));
      return;
    }

    const dirs = readdirSync(targetDir, { withFileTypes: true }).filter((d) => d.isDirectory());
    if (dirs.length === 0) {
      console.log(chalk.yellow("Chưa có phim nào trong lịch sử tải về."));
      return;
    }

    if (options.all) {
      const { confirmAll } = await inquirer.prompt([
        {
          type: "confirm",
          name: "confirmAll",
          message: chalk.red("Bạn có chắc chắn muốn xóa TOÀN BỘ file đã tải không?"),
          default: false,
        },
      ]);
      if (confirmAll) {
        for (const d of dirs) {
          rmSync(path.join(targetDir, d.name), { recursive: true, force: true });
        }
        console.log(chalk.green("✔ Đã xóa toàn bộ lịch sử tải về!"));
      }
      return;
    }

    const choices = dirs.map((d) => {
      const moviePath = path.join(targetDir, d.name);
      let count = 0;
      let size = 0;
      try {
        const files = readdirSync(moviePath).filter((f) => f.endsWith(".mp4"));
        count = files.length;
        size = files.reduce((s, f) => s + statSync(path.join(moviePath, f)).size, 0);
      } catch {}
      return {
        name: `${d.name} (${count} tập • ${formatBytes(size)})`,
        value: d.name,
      };
    });

    choices.push(new inquirer.Separator());
    choices.push({ name: "🗑️  XÓA TẤT CẢ", value: "__ALL__" });
    choices.push({ name: "❌ Hủy bỏ", value: "__CANCEL__" });

    const { target } = await inquirer.prompt([
      {
        type: "list",
        name: "target",
        message: "Chọn phim muốn xóa khỏi lịch sử:",
        choices,
      },
    ]);

    if (target === "__CANCEL__") return;

    if (target === "__ALL__") {
      const { confirmAll } = await inquirer.prompt([
        {
          type: "confirm",
          name: "confirmAll",
          message: chalk.red("Bạn có chắc chắn muốn xóa TOÀN BỘ file đã tải không?"),
          default: false,
        },
      ]);
      if (confirmAll) {
        for (const d of dirs) {
          rmSync(path.join(targetDir, d.name), { recursive: true, force: true });
        }
        console.log(chalk.green("✔ Đã xóa toàn bộ lịch sử tải về!"));
      }
      return;
    }

    const { confirmOne } = await inquirer.prompt([
      {
        type: "confirm",
        name: "confirmOne",
        message: chalk.yellow(`Bạn có chắc muốn xóa phim "${target}"?`),
        default: false,
      },
    ]);

    if (confirmOne) {
      rmSync(path.join(targetDir, target), { recursive: true, force: true });
      console.log(chalk.green(`✔ Đã xóa "${target}"!`));
    }
  });

// ─── Khởi động ──────────────────────────────────────────────────────────────

// Đảm bảo thư mục downloads tồn tại
const finalDownloadDir = process.env.DOWNLOAD_DIR || DOWNLOAD_DIR;
if (!existsSync(finalDownloadDir)) {
  mkdirSync(finalDownloadDir, { recursive: true });
}

program.parse(process.argv);

// Hiển thị help nếu không có tham số
if (!process.argv.slice(2).length) {
  console.log("");
  console.log(chalk.bold.green("  🎬 OPhim Downloader v1.0.0"));
  console.log(chalk.gray("  Tải phim từ API ophim1.com - Hỗ trợ tải theo tập, theo bộ"));
  console.log("");
  console.log(chalk.cyan("  Các lệnh:"));
  console.log("");
  console.log(`  ${chalk.yellow("search <keyword>")}  ${chalk.gray("- Tìm kiếm phim")}`);
  console.log(`  ${chalk.yellow("info <slug>")}       ${chalk.gray("- Xem chi tiết phim + danh sách tập")}`);
  console.log(`  ${chalk.yellow("download <slug>")}   ${chalk.gray("- Tải phim (tương tác chọn tập)")}`);
  console.log(`  ${chalk.yellow("list [category]")}   ${chalk.gray("- Danh sách phim theo danh mục")}`);
  console.log(`  ${chalk.yellow("clean")}             ${chalk.gray("- Xóa lịch sử và file phim đã tải")}`);
  console.log("");
  console.log(chalk.cyan("  Ví dụ:"));
  console.log("");
  console.log(`  ${chalk.green("node download.js search \"trò chơi con mực\"")}`);
  console.log(`  ${chalk.green("node download.js info tro-choi-con-muc")}`);
  console.log(`  ${chalk.green("node download.js download tro-choi-con-muc --all")}`);
  console.log(`  ${chalk.green("node download.js download tro-choi-con-muc -e 0,1,2")}`);
  console.log(`  ${chalk.green("node download.js list phim-moi")}`);
  console.log(`  ${chalk.green("node download.js download tro-choi-con-muc --list-links")}`);
  console.log("");
  console.log(chalk.cyan("  Tùy chọn download:"));
  console.log("");
  console.log(`  ${chalk.yellow("-a, --all")}            ${chalk.gray("Tải tất cả tập (cả bộ)")}`);
  console.log(`  ${chalk.yellow("-e, --episodes <0,1,2>")} ${chalk.gray("Chỉ tải các tập được chọn")}`);
  console.log(`  ${chalk.yellow("-s, --server <n>")}      ${chalk.gray("Chọn server (mặc định: 0)")}`);
  console.log(`  ${chalk.yellow("-o, --output <path>")}   ${chalk.gray("Thư mục lưu file")}`);
  console.log(`  ${chalk.yellow("--list-links")}         ${chalk.gray("Chỉ hiển thị link m3u8")}`);
  console.log("");
  console.log(chalk.gray(`  📁 Thư mục tải về: ${DOWNLOAD_DIR}`));
  console.log(chalk.gray("  📋 Yêu cầu: ffmpeg phải được cài đặt và có trong PATH"));
  console.log("");
}
