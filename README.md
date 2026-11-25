# Stick Man Infinity War — máy chủ online riêng

Gói này chạy **cả trang game lẫn máy chủ online** trên cùng một địa chỉ. Ai mở địa chỉ đó đều chơi online được:
**không cần claude.ai, không cần quyền Contributor**. Chỉ cần tạo tài khoản trong game.

## Chạy thử trên máy bạn
```
npm install
npm start          # mở http://localhost:3000
```
(Cần Node.js 18 trở lên. Biến môi trường tuỳ chọn: `PORT`, `DATA_DIR` = thư mục lưu dữ liệu.)

## Đưa lên mạng (miễn phí) bằng Render
1. Tạo một kho GitHub riêng và đẩy toàn bộ thư mục này lên (không cần đẩy `node_modules`).
2. Vào https://render.com → **New → Web Service** → chọn kho vừa tạo. Render đọc sẵn `render.yaml`
   (Build: `npm install`, Start: `node server.js`).
3. Chờ deploy xong, Render cho một địa chỉ dạng `https://ten-cua-ban.onrender.com` → gửi địa chỉ đó cho bạn bè.

Cách khác: Railway, Fly.io, VPS riêng… đều chạy được vì chỉ là một ứng dụng Node.

## Lưu ý quan trọng
- **Gói miễn phí của Render sẽ "ngủ"** sau ~15 phút không ai vào (lần vào kế tiếp chờ ~30–60 giây) và **đĩa không bền**:
  tài khoản/bạn bè/kho đồ có thể mất khi khởi động lại. Muốn giữ dữ liệu lâu dài: gắn *Persistent Disk* (trả phí) và đặt `DATA_DIR` vào đó,
  hoặc dùng VPS.
- Tài khoản **Void** (chủ) được xác thực trên máy chủ bằng mật khẩu đã băm; không ai đăng ký được tên "Void".
- Máy chủ kiểm tra quyền: chỉ ghi được dữ liệu của chính mình, không giả tin nhắn người khác, không tự cấp vật phẩm hay sửa điểm quá giới hạn; chỉ Void cấm tài khoản / cấp vật phẩm.
- Điểm xếp hạng do máy khách tính nên vẫn có thể bị gian lận trong giới hạn 0–20000; muốn chống hẳn cần để máy chủ tính trận (làm sau nếu bạn muốn).
