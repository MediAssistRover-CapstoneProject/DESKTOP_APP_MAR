# MAR Desktop

App Windows để nối Wi‑Fi và vận hành MentorPi từ giao diện, thay các thao tác SSH lặp lại. Robot vẫn khởi động như trước. App **không tự chạy MAR khi bật robot**, không thay thuật toán MOVE và không triển khai source BE/Pi.

## Chạy hoặc đóng gói

Cần Windows 10/11 x64, Node.js 24 trở lên và npm. Python 3.10+ chỉ cần khi chạy kiểm tra helper trên máy phát triển.

```powershell
cd C:\GitHub\DESKTOP_MAR
npm.cmd ci
npm.cmd start
```

Đóng gói bản portable:

```powershell
npm.cmd run check
npm.cmd test
npm.cmd run test:remote
npm.cmd run dist
```

Mở `dist\MAR-Desktop-0.2.0-x64.exe`. Người dùng bản portable không cần cài Node.js/Python trên Windows. Bản build hiện chưa ký số.

## Sử dụng hằng ngày

1. Bật robot, cho máy tính dùng cùng Wi-Fi với robot.
2. Mở **Kết nối**, nhập mật khẩu robot rồi bấm **Kết nối robot → Tiếp tục**.
3. Đăng nhập tài khoản quản lý. Chọn **Sử dụng bản đồ có sẵn**, chọn bản đồ và xác nhận robot có gắn thùng hay không.
4. Bấm **Bắt đầu sử dụng**. Khi ứng dụng yêu cầu, mở bản đồ và xác định vị trí robot.

Để quét khu vực mới, chọn **Tạo bản đồ mới**, chọn tầng và đặt tên. Nếu hệ thống chỉ có một quy trình quét, ứng dụng tự chọn quy trình đó. Các thông số kỹ thuật nằm trong mục nâng cao; ID và nhật ký nằm trong **Hỗ trợ**.

**Đổi Wi-Fi** chỉ cần khi chuyển robot sang mạng khác. `192.168.149.1` là địa chỉ AP mặc định của image hãng, không phải IP hiện tại được ứng dụng đo. Khi robot nối router/hotspot, dùng **Tìm robot**, tên `.local` hoặc IP được mạng đó cấp. Gợi ý địa chỉ AP chỉ xuất hiện khi laptop đang nối mạng tên `HW-…`/`HW_…`; tên mạng không tự chứng minh danh tính robot.

## Chuẩn bị Pi

- Pi host đã có SSH, Python 3, Docker, `systemd`, NetworkManager và `wifi.service` của Hiwonder.
- User SSH có quyền `sudo -n` cho các thao tác được helper sử dụng. App không gửi mật khẩu vào `sudo` hoặc tự thay quyền hệ thống.
- Container `MentorPi` và project MAR đã cấu hình tại `/home/ubuntu/mediassist-mqtt-2026-10-08`, gồm môi trường Python, ROS, thiết bị, CA, MQTT và device secret hiện có. Có thể đổi tên container/đường dẫn trong cấu hình nâng cao của app.
- Laptop và Pi cùng mạng khi nối SSH; hoặc laptop nối trực tiếp hotspot `HW…` để cấp mạng lần đầu. Mạng có client isolation có thể chặn việc tìm và kết nối robot.

App không yêu cầu nhập device secret hoặc mật khẩu MQTT. Đăng nhập BE bằng tài khoản **ADMIN**; thông tin robot vẫn dùng cấu hình đã có trên Pi.

## Bốn tab

| Tab | Thao tác |
| --- | --- |
| Kết nối | Tìm thiết bị hoặc nhập địa chỉ, nhập mật khẩu robot và kiểm tra kết nối. Cổng, user và khóa SSH nằm trong tùy chọn nâng cao. |
| Sử dụng robot | Đăng nhập, chọn bản đồ có sẵn hoặc tạo bản đồ mới. Xem bước tiếp theo sau khi bắt đầu. |
| Đổi Wi‑Fi | Kết nối hotspot HW, cấp mạng Internet cho robot rồi tìm địa chỉ mới. |
| Hỗ trợ | Chi tiết trạng thái, ID phiên/nhiệm vụ và nhật ký kỹ thuật khi cần xử lý lỗi. |

## Cấp mạng qua hotspot HW

1. Khi laptop còn ở Wi‑Fi có Internet, ghi nhớ SSID mạng muốn cấp cho robot. App có thể hiện SSID; mật khẩu cần nhập hoặc dùng profile Windows đã lưu.
2. Trong tab **Đổi Wi‑Fi**, nối laptop vào `HW…` của robot. AP của image hãng thường có địa chỉ `192.168.149.1`; nếu robot đã tùy chỉnh, nhập IP AP thực tế.
3. Sang **Kết nối**, nối SSH tới IP AP, xác minh đúng fingerprint và robot. Nhập thông tin SSH của bạn; app không tích hợp mật khẩu mặc định.
4. Gửi SSID/mật khẩu mạng đích cho Pi. Helper chỉ đổi cấu hình Wi‑Fi của hãng khi MAR đã dừng; không sửa networking trong container. Việc đổi mạng làm SSH ngắt là bình thường.
5. Cho laptop quay lại Wi‑Fi đích, chờ Pi nhận IP rồi bấm **Tìm lại robot** và nối SSH lại. Có thể tìm bằng `raspberrypi.local`, `mar-v1.local` nếu tên đó đã được cấu hình, hoặc nhập IP biết được. App không tự đổi hostname Pi.

AP đơn thuần không cung cấp Internet. Trong lúc laptop nối `HW…`, đăng nhập và gọi BE có thể chưa dùng được; hoàn tất nối mạng đích trước khi mở phiên robot. Lệnh Windows nối Wi‑Fi có thể cần profile/mật khẩu hoặc quyền truy cập Wi‑Fi của Windows; app phải đọc lại trạng thái để xác nhận đã nối.

## Chạy hai chế độ

**Quét map mới:** chọn robot đúng với Pi đã SSH, workflow MAPPING schema 3, tầng và tên map. Bấm Start; app mở stack mapping, chờ MQTT/heartbeat/IDLE trên BE rồi tạo mapping job bằng API hiện có. Mở trang map để điều khiển, tự quét và lưu. Nếu BE còn job/incident/recovery, app báo trạng thái để xử lý thay vì ép tạo job hoặc xóa journal.

**Dùng map đã lưu:** chọn map ACTIVE, thời hạn 2/4/8 giờ, robot trần hoặc có thùng và các tùy chọn voice/giám sát. App mở navigation session rồi gọi `run_navigation_session.py` với đúng session ID. Mở `mapping.html` để khởi tạo vị trí và chờ LOCALIZED trước khi gửi nhiệm vụ. App không tự đoán tọa độ, phát MOVE hoặc gọi global localization ngay khi Start.

Nếu còn navigation session cũ, app yêu cầu chọn rõ việc đóng phiên trước khi tạo mới. BE có thể từ chối đóng nếu nhiệm vụ còn giữ robot. Phiên cũ gắn với một lần chạy worker; không dùng một phiên cũ cho worker mới bằng cách bỏ kiểm tra identity.

Start thủ công dùng một **transient systemd unit** để giữ stack độc lập với kênh SSH; đóng app hoặc mất Wi‑Fi không phải lệnh Stop. Unit không được enable để tự chạy ở lần boot sau. Pi vẫn dùng supervisor MAR hiện có để quản lý ROS, chống trùng camera/LiDAR/Nav2 và thu hồi tiến trình con.

**Dừng stack** gọi quy trình STOP của supervisor và chờ kết quả; không kill container/PID1, không tự chuyển job sang CANCELLED và không giả bằng chứng dừng. Job/incident cần recovery vẫn phải xử lý trên BE. Dừng phần mềm không tự chứng minh servo đã khóa hoặc thùng đã trống.

## Thông tin được lưu

App lưu địa chỉ robot, đường dẫn project, tên container, địa chỉ BE và fingerprint máy chủ trong thư mục user data của Electron. Mật khẩu SSH/BE, passphrase và token chỉ giữ trong bộ nhớ phiên; không đưa vào repository hoặc log. Đường dẫn file khóa SSH được ghi nhớ, nội dung khóa không được sao chép vào cấu hình.

Khi chủ động kết nối một mạng mới, **Windows lưu profile Wi‑Fi** theo cơ chế hệ điều hành; Pi lưu SSID/mật khẩu trong cấu hình Wi‑Fi của hãng để lần sau tự nối lại. Đây là lưu cấu hình mạng có chủ đích, khác với việc app ghi nhớ mật khẩu đăng nhập SSH/BE.

## GitHub và CI

Đây là repository desktop riêng; chưa gắn remote. Sau khi tự tạo một repository trống trên GitHub:

```powershell
git status
git add .
git commit -m "Add minimal MAR Desktop launcher"
git remote add origin https://github.com/<organization>/DESKTOP_MAR.git
git push -u origin main
```

Workflow `.github/workflows/build.yml` kiểm tra và build Windows khi push `main` hoặc chạy thủ công. Tải `MAR-Desktop-Windows` tại mục **Artifacts** của GitHub Actions. CI **chỉ build/upload artifact**, không tự cài app lên laptop, không đẩy code lên robot và không deploy BE. `dist`, `node_modules`, khóa và file thông tin riêng được loại khỏi Git.

## Phạm vi kiểm chứng

Đã kiểm tra giao diện Windows, đọc mạng laptop, tìm `raspberrypi.local`, đọc trạng thái project/container và nhận diện cấu hình Wi‑Fi trên Pi thật. Các kiểm tra tự động dùng SSH/HTTP/process giả lập.

Chưa chuyển Wi‑Fi thật hoặc phát lệnh bánh/servo khi phát triển. Cần thử thực tế các bước chuyển `HW…` sang STA, tìm IP sau DHCP, Start từng chế độ, đóng app khi stack đang chạy và STOP hoàn chỉnh. Trạng thái “Start đã nhận” không thay cho MQTT READY hoặc localization đã xác nhận.
