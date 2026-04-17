# 无人机巡检 Web 系统

## 已完成内容

- 后端已接入 MySQL，并支持自动建表与初始化数据。
- 登录页已接入后端账号认证接口。
- 任务管理页已实现：查询、分页、新增、编辑、删除、启停、导出 CSV。
- 航线规划页已实现：表单校验、保存到数据库、读取历史草稿。
- 图像检测页已实现：调用检测接口并将检测记录落库展示。

## 默认账号

- 用户名：admin
- 密码：admin123

## 1. 准备 MySQL

先创建数据库：

CREATE DATABASE uav_system CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

默认后端配置：

- MYSQL_HOST=127.0.0.1
- MYSQL_PORT=3306
- MYSQL_USER=root
- MYSQL_PASSWORD=123456
- MYSQL_DB=uav_system

如需自定义，可通过环境变量覆盖。

## 2. 安装依赖

在项目根目录执行：

pip install -r requirements.txt

## 3. 启动后端

在项目根目录执行：

uvicorn website.backend.text:app --host 127.0.0.1 --port 8000 --reload

## 4. 打开页面

- 首页：website/index/index.html
- 登录页：website/login/login.html
- 任务管理：website/task-center/index.html
- 图像检测：website/task-center/object_detection.html
- 航线规划：website/route-plan/index.html

## 说明

- 启动时会自动建表：users、tasks、route_drafts、detection_records。
- 图像检测依赖本地模型权重，默认路径是项目根目录的 best.pt。

## 5. 对接 UE4.27 + AirSim 做实时俯视检测

### 5.1 你没有无人机控制代码时的最小方案

项目已提供桥接脚本：

- website/backend/airsim_realtime_bridge.py

该脚本包含最小控制能力：

- 连接 AirSim
- 可选自动解锁 + 起飞 + 定高悬停
- 将相机姿态设置为正下方俯视（Pitch=-90）
- 按指定帧率抓图并调用后端实时检测接口

### 5.2 AirSim 配置（俯视相机）

可参考项目根目录示例文件：

- airsim_settings.json.example

将其内容复制到你的 AirSim settings.json（通常在 文档/AirSim/settings.json），并确保 UE 场景中车辆名与相机名一致。

### 5.3 安装新增依赖

pip install -r requirements.txt

### 5.4 启动后端

uvicorn website.backend.text:app --host 127.0.0.1 --port 8000 --reload

### 5.5 启动桥接脚本

无控制代码推荐先用自动起飞模式：

python website/backend/airsim_realtime_bridge.py --vehicle Drone1 --camera down_cam --backend http://127.0.0.1:8000 --fps 6 --takeoff --flight-height 25

如果你已经在 UE/AirSim 中手动控制飞行，可去掉 --takeoff，仅采图推理：

python website/backend/airsim_realtime_bridge.py --vehicle Drone1 --camera down_cam --backend http://127.0.0.1:8000 --fps 6

### 5.6 页面查看实时结果

打开图像检测页：

- website/task-center/object_detection.html

点击“开启实时查看”，页面会轮询最新检测记录并更新结果图。

### 5.7 route-plan 下发 UE4/AirSim 航线

现在航线规划页不只是保存草稿，还可以生成可执行 mission：

- 在 website/route-plan/index.html 中点击地图添加航点
- 先设置底图为 UE4 俯视图截图或同源地图
- 使用标定点 A / B 记录地图上的两个已知世界坐标点，让浏览器底图和 UE4 俯视图使用同一套坐标基准
- 先点“保存草稿”，再点“下发执行”

如果地图方向和 UE4 不一致，可以勾选 X/Y 轴反向后重新标定。

后端会写入最新 mission，AirSim 桥接脚本会自动轮询并按航点飞行：

- website/backend/airsim_realtime_bridge.py

启动示例：

python website/backend/airsim_realtime_bridge.py --vehicle Drone1 --camera down_cam --backend http://127.0.0.1:8000 --fps 6 --takeoff --flight-height 25

如果你的 UE4/AirSim 已经在空中，也可以只执行任务，不自动起飞。

