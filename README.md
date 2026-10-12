# dowload-video-page - OPhim Downloader 🎬

Tool tìm kiếm và tải phim từ API OPhim với giao diện Web hiện đại và CLI mạnh mẽ. Hỗ trợ chạy trực tiếp trên **GitHub Actions** (cloud runner tải phim siêu tốc) hoặc chạy local trên máy tính cá nhân.

---

## 🌟 Tính Năng Nổi Bật

- 🚀 **Chạy trực tiếp trên GitHub**: Sử dụng **GitHub Actions** để tải phim trên máy chủ GitHub (tốc độ mạng 1 Gbps+), không tốn băng thông máy cá nhân.
- 📁 **Tùy chọn thư mục lưu video**: Cho phép chỉ định thư mục lưu video tải về theo ý muốn cả trên Web GUI, CLI và GitHub Actions.
- 🌐 **Giao diện Web GUI**: Trực quan, tìm kiếm nhanh, xem danh sách tập và theo dõi tiến độ tải realtime.
- 💻 **Công cụ dòng lệnh CLI**: Đầy đủ tính năng tìm kiếm, xem thông tin phim, tải theo tập hoặc trọn bộ.
- ⚡ **Xử lý m3u8 thông minh**: Tự động ghép nối video và tải bằng ffmpeg chất lượng cao.

---

## ☁️ Hướng Dẫn Chạy Trên GitHub (GitHub Actions)

Bạn có thể chạy tải phim trực tiếp trên GitHub mà không cần bật máy tính hay cài đặt bất cứ phần mềm nào:

1. Truy cập vào kho mã nguồn của bạn trên GitHub: `https://github.com/ruanhou23/dowload-video-page`
2. Nhấn vào tab **Actions** ở menu phía trên.
3. Ở cột bên trái, chọn workflow **"Tải Phim Trực Tiếp Trên GitHub (OPhim Downloader)"**.
4. Nhấn nút **"Run workflow"** ở góc phải:
   - **Slug hoặc mã phim**: Nhập mã phim (Ví dụ: `tro-choi-con-muc-phan-2`, `dau-pha-thuong-khung`, v.v.)
   - **Tập cần tải**: Nhập `all` để tải tất cả các tập, hoặc nhập số thứ tự tập (ví dụ: `0` cho tập 1, hoặc `0,1,2`)
   - **Thư mục lưu video**: Chọn tên thư mục lưu trên máy chủ (mặc định: `downloads` hoặc thư mục bạn muốn)
   - **Tạo GitHub Release**: Tích chọn nếu muốn lưu trữ vĩnh viễn trên GitHub Releases
5. Bấm **"Run workflow"** màu xanh để bắt đầu.
6. Sau khi chạy xong:
   - Vào lại lần chạy đó, cuộn xuống phần **Artifacts** để tải file `.zip` chứa toàn bộ video về máy tính với tốc độ cao!

---

## ☁️ Chạy Trên GitHub Codespaces (Trực Tiếp Trên Trình Duyệt)

1. Nhấn nút xanh **Code** -> chọn tab **Codespaces** -> chọn **Create codespace on main**.
2. GitHub sẽ tự động mở giao diện VS Code trên trình duyệt, tự động cài FFmpeg và Node.js.
3. Trong terminal Codespaces, gõ:
   ```bash
   npm start
   ```
4. Cổng `3000` sẽ tự động mở giao diện Web GUI ngay trên trình duyệt của bạn!

---

## 🖥️ Hướng Dẫn Cài Đặt & Chạy Trên Máy Cá Nhân (Local)

### Yêu Cầu
- [Node.js](https://nodejs.org/) (phiên bản 18 trở lên)
- [FFmpeg](https://ffmpeg.org/) (đã được cài đặt và thêm vào biến môi trường PATH)

### Cài Đặt

```bash
# Clone repo về máy
git clone https://github.com/ruanhou23/dowload-video-page.git
cd dowload-video-page

# Cài đặt các thư viện cần thiết
npm install
```

### 1. Khởi Chạy Giao Diện Web GUI

```bash
npm start
# hoặc: node server.js
```
Mở trình duyệt truy cập: `http://localhost:3000`

> 💡 **Chọn thư mục lưu trên Web GUI**:
> - Vào tab **📁 Đã tải**: Nhập đường dẫn thư mục bạn muốn (Ví dụ: `D:\Phim` hoặc `C:\Users\...\Downloads`) rồi nhấn **💾 Lưu thư mục**.
> - Hoặc khi mở xem chi tiết một bộ phim, nhấn **✏️ Đổi thư mục** để lưu riêng cho lần tải đó!

### 2. Sử Dụng Công Cụ Dòng Lệnh CLI

```bash
# Tìm kiếm phim
node download.js search "trò chơi con mực"

# Xem thông tin phim và danh sách tập
node download.js info tro-choi-con-muc-phan-2

# Tải cả bộ phim và lưu vào thư mục được chọn
node download.js dl tro-choi-con-muc-phan-2 --all -o "D:/Movies"

# Tải tập cụ thể (tập 0 và tập 1) vào thư mục được chọn
node download.js dl tro-choi-con-muc-phan-2 -e 0,1 -o "./my-videos"

# Chế độ tương tác từng bước (hỏi chọn server, tập, và thư mục lưu)
node download.js dl tro-choi-con-muc-phan-2
```

---

## 📁 Cấu Trúc Dự Án

```
lag-ff/
├── .github/
│   └── workflows/
│       └── download.yml         # Workflow chạy tải video trên GitHub Actions
├── .devcontainer/
│   └── devcontainer.json        # Cấu hình 1-click GitHub Codespaces
├── public/
│   └── index.html               # Giao diện Web GUI
├── download.js                  # CLI tool tải phim
├── server.js                    # Web server API & quản lý tải về
├── package.json                 # Cấu hình dự án & dependencies
└── README.md                    # Tài liệu hướng dẫn
```

---

## 📜 Giấy Phép
Dự án được phân phối dưới giấy phép MIT.
