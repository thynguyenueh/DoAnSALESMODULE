# ĐỒ ÁN THỰC TẬP - SALES MODULE

- **Sinh viên thực hiện:** Nguyễn Ngô Bảo Thy
- **Mã số sinh viên:** 31231021131
- **Công nghệ sử dụng:** Node.js (Express), PostgreSQL, HTML5/CSS3 (SB Admin 2), jQuery, Bootstrap.

---

## 🔑 Thông Tin Đăng Nhập Mặc Định (Demo)
- **Tên đăng nhập:** `admin`
- **Mật khẩu:** `123`

---

## 🛠 Hướng Dẫn Cài Đặt & Khởi Chạy Dự Án

### 1. Yêu cầu môi trường
- **Node.js**: Phiên bản v18.x trở lên
- **PostgreSQL**: Phiên bản 13.x trở lên

### 2. Khôi phục Cơ sở dữ liệu (PostgreSQL)
1. Mở **pgAdmin** hoặc PostgreSQL CLI, tạo một Database mới tên là `salesmodule`.
2. Mở file `database_schema.sql` (hoặc file `.sql` trong thư mục `database/`).
3. Execute / Run toàn bộ script SQL này vào database `salesmodule` để tự động khởi tạo Bảng (Tables), Views, Stored Procedures và Dữ liệu mẫu (Seed data).

### 3. Cấu hình Môi trường (.env)
1. Tạo một file tên `.env` tại thư mục gốc của dự án (hoặc đổi tên file `.env.example` thành `.env`).
2. Sao chép nội dung cấu hình dưới đây và điền đúng thông số kết nối PostgreSQL trên máy của bạn:

```env
PORT=3000
DB_HOST=localhost
DB_PORT=5432
DB_NAME=salesmodule
DB_USER=postgres
DB_PASSWORD=nhap_mat_khau_postgres_cua_ban

ADMIN_USERNAME=admin
ADMIN_PASSWORD_HASH=scrypt$0a625b8dd88fd0607bc9761909c83a34$f012542687cb8ad54cb2bea062c4d2ee8c14f2a69bba1fe563a878f08660569e
ADMIN_SESSION_SECRET=dbd842b17619edd2e295320996c32b6497025b1158358762d05555350b668b370d96aa98dd7d1695a1a573f2598e7926




Mở Terminal / Command Prompt tại thư mục dự án và thực hiện các lệnh:

Bash
# 1. Cài đặt các thư viện phụ thuộc
npm install

# 2. Khởi chạy Server Node.js
node server.js
Đơn hàng và hệ thống sẽ hoạt động tại địa chỉ: http://localhost:3000
