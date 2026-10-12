#!/usr/bin/env python3
"""
🎬 OPhim Subtitle Extractor - Trích xuất phụ đề tiếng Việt từ video

Tối ưu cho CPU: 2-pass (quét nhanh phát hiện text → OCR chọn lọc).
Hỗ trợ: EasyOCR, Tesseract, PaddleOCR.

Cách dùng:
  python subtitle_extractor.py video.mp4                      # 1 file
  python subtitle_extractor.py ./downloads/"Ten phim"          # Cả bộ
  python subtitle_extractor.py video.mp4 --speed fast          # Nhanh (1fps)
  python subtitle_extractor.py video.mp4 --speed accurate      # Chính xác (3fps)
  python subtitle_extractor.py video.mp4 --engine tesseract    # Dùng Tesseract
"""

import argparse, os, sys, time, json, re
from pathlib import Path
from datetime import timedelta

if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

import cv2
import numpy as np
from tqdm import tqdm

# ─── OCR Engines ─────────────────────────────────────────────────────────────
OCR_ENGINE = None
OCR_READER = None

def init_ocr(engine="easyocr", lang="vi", gpu=False):
    global OCR_ENGINE, OCR_READER
    OCR_ENGINE = engine

    if engine == "easyocr":
        import easyocr
        OCR_READER = easyocr.Reader([lang], gpu=gpu)
        print(f"   ✅ EasyOCR ready (GPU={gpu})")

    elif engine == "tesseract":
        import pytesseract
        # Tesseract cần cài riêng: https://github.com/UB-Mannheim/tesseract/wiki
        # và cài language data cho tiếng Việt
        OCR_READER = pytesseract
        # Kiểm tra có ngôn ngữ vi không
        try:
            langs = pytesseract.get_languages()
            if "vie" not in langs:
                print(f"   ⚠ Tesserart chưa có language 'vie'. Đang thử 'eng'...")
                print(f"   Cài: tesseract.exe --list-langs  |  tesseract-ocr-vie")
        except:
            pass
        print(f"   ✅ Tesseract ready")

    elif engine == "paddle":
        from paddleocr import PaddleOCR
        OCR_READER = PaddleOCR(lang=lang, use_angle_cls=True, show_log=False)
        print(f"   ✅ PaddleOCR ready")

    else:
        raise ValueError(f"Unknown engine: {engine}")

    return OCR_READER


def ocr_text(img, min_confidence=0.4):
    """Run OCR, return list of (text, confidence)"""
    if OCR_ENGINE == "easyocr":
        results = OCR_READER.readtext(img)
        return [(r[1].strip(), r[2]) for r in results]

    elif OCR_ENGINE == "tesseract":
        try:
            # Thử với tiếng Việt trước
            data = OCR_READER.image_to_data(img, lang="vie", output_type=OCR_READER.Output.DICT)
        except:
            data = OCR_READER.image_to_data(img, lang="eng+vie", output_type=OCR_READER.Output.DICT)
        texts = []
        for i, text in enumerate(data["text"]):
            conf = int(data["conf"][i]) / 100.0 if data["conf"][i] != "-1" else 0.5
            t = text.strip()
            if t and conf >= min_confidence:
                texts.append((t, conf))
        return texts

    elif OCR_ENGINE == "paddle":
        results = OCR_READER.ocr(img, cls=True)
        if not results or not results[0]:
            return []
        return [(line[1][0].strip(), line[1][1]) for line in results[0]]

    return []


def ocr_multi_pass(img, min_confidence=0.4):
    """
    Chạy OCR với nhiều phương pháp tiền xử lý, chọn kết quả tốt nhất.
    """
    h, w = img.shape[:2]
    if h < 20 or w < 50:
        return ""

    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if len(img.shape) == 3 else img

    # Resize để tăng tốc và giảm nhiễu
    target_h = 80
    if h > target_h:
        scale = target_h / h
        gray = cv2.resize(gray, (int(w * scale), target_h))

    # Tăng contrast
    gray = cv2.convertScaleAbs(gray, alpha=1.4, beta=5)

    candidates = []

    # Pass 1: Ảnh gốc (tăng contrast)
    texts1 = ocr_text(gray, min_confidence)
    merged1 = merge_valid_texts(texts1, min_confidence)
    if merged1:
        candidates.append((merged1, sum(c for _, c in texts1 if c >= min_confidence) / max(1, len(texts1))))

    # Pass 2: Adaptive threshold (text sáng trên nền tối)
    thresh_light = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                                          cv2.THRESH_BINARY, 15, 4)
    texts2 = ocr_text(thresh_light, min_confidence)
    merged2 = merge_valid_texts(texts2, min_confidence)
    if merged2:
        candidates.append((merged2, sum(c for _, c in texts2 if c >= min_confidence) / max(1, len(texts2))))

    # Pass 3: Adaptive threshold ngược (text tối trên nền sáng)
    thresh_dark = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                                         cv2.THRESH_BINARY_INV, 15, 4)
    texts3 = ocr_text(thresh_dark, min_confidence)
    merged3 = merge_valid_texts(texts3, min_confidence)
    if merged3:
        candidates.append((merged3, sum(c for _, c in texts3 if c >= min_confidence) / max(1, len(texts3))))

    if not candidates:
        return ""

    # Chọn kết quả có confidence trung bình cao nhất
    candidates.sort(key=lambda x: x[1], reverse=True)
    return candidates[0][0]


def merge_valid_texts(texts_with_conf, min_confidence=0.4):
    """Gộp text hợp lệ, lọc bỏ rác"""
    valid = []
    for t, c in texts_with_conf:
        if c < min_confidence:
            continue
        t = t.strip()
        # Bỏ text rác
        if len(t) < 2:
            continue
        if re.match(r'^[\d\W_]+$', t):
            continue
        # Bỏ các pattern rác phổ biến
        if re.match(r'^[|#@$%^&*~`]+$', t):
            continue
        valid.append(t)

    return "\n".join(valid[:3])


# ─── Fast Text Detection ─────────────────────────────────────────────────────

def has_text_region(img, min_edge_density=0.015, min_variance=25):
    """Kiểm tra nhanh vùng có khả năng chứa text"""
    h, w = img.shape[:2]
    if h < 20 or w < 50:
        return False

    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if len(img.shape) == 3 else img
    edges = cv2.Canny(gray, 50, 150)
    edge_density = np.count_nonzero(edges) / (h * w)
    variance = np.var(gray)

    return edge_density > min_edge_density or variance > min_variance


def frame_diff_score(img1, img2):
    """Điểm khác biệt giữa 2 frame (0-1)"""
    gray1 = cv2.cvtColor(img1, cv2.COLOR_BGR2GRAY) if len(img1.shape) == 3 else img1
    gray2 = cv2.cvtColor(img2, cv2.COLOR_BGR2GRAY) if len(img2.shape) == 3 else img2
    small = (160, 60)
    g1 = cv2.resize(gray1, small)
    g2 = cv2.resize(gray2, small)
    mse = np.mean((g1.astype(float) - g2.astype(float)) ** 2)
    return mse / 255.0


# ─── Text Cleaning ───────────────────────────────────────────────────────────

def clean_subtitle(text):
    """Làm sạch text sau OCR"""
    # Chuẩn hóa khoảng trắng
    text = re.sub(r'\s+', ' ', text)
    # Xóa ký tự rác đầu/cuối dòng
    text = re.sub(r'^[|#$%^&*~`\[\]{}]+', '', text)
    text = re.sub(r'[|#$%^&*~`\[\]{}]+$', '', text)
    # Xóa dấu ngoặc vuông rác [RO CHO CON MVC 2] -> giữ lại
    text = text.strip()

    # Loại bỏ các pattern OCR lỗi rõ ràng
    # Dòng chỉ có 1-2 ký tự lạ
    if re.match(r'^[A-Za-z]{1,2}$', text) and len(text) <= 2:
        return ""
    # Dòng bắt đầu bằng ký tự lạ
    if re.match(r'^[#@$%^&]', text):
        text = re.sub(r'^[#@$%^&]+', '', text)

    return text.strip()


# ─── Core ────────────────────────────────────────────────────────────────────

def extract_subtitles(video_path, fps_sample=2, region_bottom=0.30,
                      region_top=0.65, min_confidence=0.45, min_duration_ms=500,
                      max_gap_ms=2500, change_threshold=2.0):
    """
    2-pass extraction:
    Pass 1: Quét nhanh phát hiện frame có text
    Pass 2: OCR chính xác các frame ứng viên
    """
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise ValueError(f"Không thể mở: {video_path}")

    fps = cap.get(cv2.CAP_PROP_FPS)
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    duration_sec = total_frames / fps if fps > 0 else 0
    sample_interval = max(1, int(fps / fps_sample))
    total_samples = total_frames // sample_interval

    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    y_start = int(h * region_top)
    y_end = h

    print(f"  📹 {fps:.1f}fps | {w}x{h} | {duration_sec:.0f}s | ~{total_samples} mẫu")

    # ─── Pass 1 ──────────────────────────────────────────────────────────────
    print(f"  🔍 Pass 1: Quét nhanh tìm text...")
    candidates = []
    cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
    frame_num = 0
    prev_sub = None

    with tqdm(total=total_samples, desc="  🔍 Pass 1", unit="f",
              bar_format="{l_bar}{bar}| {n_fmt}/{total_fmt} [{elapsed}]") as pbar:
        while True:
            ret, frame = cap.read()
            if not ret:
                break
            frame_num += 1
            if frame_num % sample_interval != 0:
                continue

            ts_ms = int((frame_num / fps) * 1000)
            sub = frame[y_start:y_end, :]

            if has_text_region(sub):
                if prev_sub is None or frame_diff_score(sub, prev_sub) > change_threshold:
                    candidates.append((frame_num, ts_ms))
                    prev_sub = sub.copy()
            pbar.update(1)

    cap.release()
    print(f"  📝 Ứng viên: {len(candidates)} frame có text")

    if not candidates:
        return []

    # ─── Pass 2 ──────────────────────────────────────────────────────────────
    print(f"  🎯 Pass 2: OCR {len(candidates)} frame...")
    cap = cv2.VideoCapture(video_path)
    raw_subtitles = []

    for target_frame, target_ts in tqdm(candidates, desc="  🎯 OCR", unit="f",
                                         bar_format="{l_bar}{bar}| {n_fmt}/{total_fmt} [{elapsed}]"):
        cap.set(cv2.CAP_PROP_POS_FRAMES, target_frame)
        ret, frame = cap.read()
        if not ret:
            continue

        sub = frame[y_start:y_end, :]
        text = ocr_multi_pass(sub, min_confidence)

        if text:
            cleaned = clean_subtitle(text)
            if cleaned and len(cleaned) >= 2:
                raw_subtitles.append((target_frame, target_ts, cleaned))

    cap.release()
    print(f"  ✅ OCR xong: {len(raw_subtitles)} đoạn text")

    # ─── Merge ───────────────────────────────────────────────────────────────
    if not raw_subtitles:
        return []

    subtitles = []
    i = 0
    while i < len(raw_subtitles):
        _, start_ms, text = raw_subtitles[i]
        end_ms = start_ms + min_duration_ms
        j = i + 1

        while j < len(raw_subtitles):
            _, next_ms, next_text = raw_subtitles[j]
            gap = next_ms - raw_subtitles[j-1][1]
            if gap > max_gap_ms:
                break

            s1, s2 = set(text), set(next_text)
            if s1 and s2:
                sim = len(s1 & s2) / len(s1 | s2)
                if sim < 0.55:
                    break
            end_ms = next_ms + min_duration_ms
            j += 1

        best = text
        for k in range(i, j):
            if len(raw_subtitles[k][2]) > len(best):
                best = raw_subtitles[k][2]

        if end_ms - start_ms >= min_duration_ms:
            subtitles.append((start_ms, end_ms, best))
        i = j

    print(f"  📦 Sau gộp: {len(subtitles)} câu")
    return subtitles


# ─── Output ──────────────────────────────────────────────────────────────────

def ms_to_srt_time(ms):
    td = timedelta(milliseconds=ms)
    ts = int(td.total_seconds())
    return f"{ts//3600:02d}:{(ts%3600)//60:02d}:{ts%60:02d},{ms%1000:03d}"

def save_srt(subtitles, path):
    with open(path, "w", encoding="utf-8") as f:
        for i, (s, e, t) in enumerate(subtitles, 1):
            f.write(f"{i}\n{ms_to_srt_time(s)} --> {ms_to_srt_time(e)}\n{t}\n\n")
    sz = os.path.getsize(path) / 1024
    print(f"  📄 {path} ({sz:.1f} KB, {len(subtitles)} câu)")


# ─── Presets ─────────────────────────────────────────────────────────────────

SPEED = {
    "fast":     {"fps": 1, "conf": 0.35, "thresh": 3.0},
    "normal":   {"fps": 2, "conf": 0.40, "thresh": 2.0},
    "accurate": {"fps": 3, "conf": 0.45, "thresh": 1.5},
}


def process_one(video_path, args):
    name = Path(video_path).stem
    out_dir = args.output or str(Path(video_path).parent)
    srt = os.path.join(out_dir, f"{name}.srt")

    if os.path.exists(srt) and not args.force:
        print(f"  ⏭ Có sẵn: {srt}")
        return True

    os.makedirs(out_dir, exist_ok=True)
    preset = SPEED.get(args.speed, SPEED["normal"])

    print(f"\n{'='*60}")
    print(f"🎬 {name}")
    print(f"{'='*60}")

    try:
        subs = extract_subtitles(
            video_path,
            fps_sample=args.fps_sample or preset["fps"],
            region_bottom=args.region_bottom,
            region_top=args.region_top,
            min_confidence=args.confidence or preset["conf"],
            min_duration_ms=args.min_duration,
            max_gap_ms=args.max_gap,
            change_threshold=args.change_threshold or preset["thresh"],
        )
        if subs:
            save_srt(subs, srt)
            if args.debug:
                jp = os.path.join(out_dir, f"{name}_debug.json")
                with open(jp, "w", encoding="utf-8") as f:
                    json.dump([{"i": i, "s": s, "e": e, "t": t}
                               for i, (s, e, t) in enumerate(subs, 1)],
                              f, ensure_ascii=False, indent=2)
            return True
        else:
            print(f"  ⚠ Không tìm thấy phụ đề!")
            if args.mark_empty:
                Path(srt).write_text("1\n00:00:00,000 --> 00:00:01,000\n(Không có phụ đề)\n\n",
                                     encoding="utf-8")
            return False
    except Exception as e:
        print(f"  ❌ {e}")
        if args.debug:
            import traceback; traceback.print_exc()
        return False


def find_videos(path, ext_filter=".mp4"):
    p = Path(path)
    want = ext_filter.lower()
    if not want.startswith("."):
        want = f".{want}"
    all_exts = {want, want.upper()}

    if p.is_file():
        return [str(p)] if p.suffix in all_exts else []
    if p.is_dir():
        vids = []
        for e in all_exts:
            vids.extend(p.glob(f"*{e}"))
        return sorted(set(str(v) for v in vids), key=lambda x: Path(x).name)
    return []


def main():
    parser = argparse.ArgumentParser(
        description="🎬 OPhim Subtitle Extractor - Trích xuất phụ đề từ video → .srt",
        epilog="""
Ví dụ:
  python subtitle_extractor.py video.mp4
  python subtitle_extractor.py ./downloads/"Ten phim" --speed normal
  python subtitle_extractor.py video.mp4 --engine tesseract
  python subtitle_extractor.py video.mp4 --fps-sample 3 --confidence 0.5
        """
    )
    parser.add_argument("input", help="File video hoặc thư mục")
    parser.add_argument("-o", "--output", help="Thư mục xuất .srt")
    parser.add_argument("--speed", default="normal", choices=["fast", "normal", "accurate"])
    parser.add_argument("--engine", default="easyocr",
                        choices=["easyocr", "tesseract", "paddle"])
    parser.add_argument("--fps-sample", type=int)
    parser.add_argument("--confidence", type=float)
    parser.add_argument("--change-threshold", type=float)
    parser.add_argument("--region-bottom", type=float, default=0.30)
    parser.add_argument("--region-top", type=float, default=0.65)
    parser.add_argument("--min-duration", type=int, default=500)
    parser.add_argument("--max-gap", type=int, default=2500)
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--mark-empty", action="store_true")
    parser.add_argument("--debug", action="store_true")
    parser.add_argument("--ext", default="mp4")

    args = parser.parse_args()

    videos = find_videos(args.input, args.ext)
    if not videos:
        print("❌ Không tìm thấy video!")
        sys.exit(1)

    preset = SPEED[args.speed]
    print(f"\n🎬 OPhim Subtitle Extractor v2.1")
    print(f"   Engine: {args.engine} | Speed: {args.speed} | {len(videos)} video(s)")
    print(f"   fps={args.fps_sample or preset['fps']}/s, conf={args.confidence or preset['conf']}")
    print(f"   Vùng quét: {int(args.region_top*100)}%-{100}%\n")

    print("⏳ Đang tải OCR engine...")
    t0 = time.time()
    init_ocr(args.engine, "vi", gpu=False)
    print(f"   ✅ {time.time()-t0:.1f}s\n")

    ok = fail = 0
    for i, v in enumerate(videos, 1):
        if len(videos) > 1:
            print(f"[{i}/{len(videos)}]", end=" ")
        try:
            if process_one(v, args): ok += 1
            else: fail += 1
        except KeyboardInterrupt:
            print("\n⚠ Dừng.")
            break

    print(f"\n{'='*60}")
    print(f"📊 ✅ {ok} | ❌ {fail} | 📂 {len(videos)}")
    print(f"{'='*60}\n")


if __name__ == "__main__":
    main()
