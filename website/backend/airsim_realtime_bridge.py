import argparse
import sys
import time
from typing import Optional

import requests

try:
    import airsim
except Exception:
    airsim = None

try:
    import cv2
    import numpy as np
except Exception:
    cv2 = None
    np = None


def check_dependencies() -> None:
    missing = []
    if airsim is None:
        missing.append("airsim")
    if cv2 is None:
        missing.append("opencv-python")
    if np is None:
        missing.append("numpy")
    if missing:
        raise RuntimeError(f"缺少依赖: {', '.join(missing)}")


def configure_downward_camera(client, camera_name: str, vehicle_name: str) -> None:
    # Pitch -90 degree for nadir view.
    pose = airsim.Pose(
        airsim.Vector3r(0, 0, 0),
        airsim.to_quaternion(-1.5707963, 0, 0),
    )
    print(f"[bridge] 设置相机俯视姿态: camera={camera_name}, vehicle={vehicle_name or '<default>'}")
    client.simSetCameraPose(camera_name, pose, vehicle_name)
    print("[bridge] 相机姿态设置完成")


def arm_and_takeoff(client, vehicle_name: str, flight_height: float) -> None:
    print(f"[bridge] 准备起飞，vehicle='{vehicle_name or '<default>'}'")
    client.enableApiControl(True, vehicle_name)
    client.armDisarm(True, vehicle_name)
    client.takeoffAsync(vehicle_name=vehicle_name)
    time.sleep(4.0)

    # NED 坐标系：向上为负 z。
    target_z = -abs(flight_height)
    climb_speed = min(8.0, max(2.0, abs(flight_height) / 8.0))
    print(f"[bridge] 目标高度 z={target_z:.2f}，爬升速度={climb_speed:.2f}m/s")
    client.moveToZAsync(target_z, climb_speed, vehicle_name=vehicle_name)

    # 等待到达目标高度，避免固定 sleep 导致高度看起来总是一样。
    start = time.time()
    timeout_sec = 45.0
    reached = False
    while time.time() - start < timeout_sec:
        state = client.getMultirotorState(vehicle_name=vehicle_name)
        z = state.kinematics_estimated.position.z_val
        err = abs(z - target_z)
        if err <= 1.0:
            reached = True
            break
        time.sleep(0.2)

    if not reached:
        state = client.getMultirotorState(vehicle_name=vehicle_name)
        z = state.kinematics_estimated.position.z_val
        print(f"[bridge] 高度等待超时，当前 z={z:.2f}，目标 z={target_z:.2f}")

    client.hoverAsync(vehicle_name=vehicle_name)
    time.sleep(1.0)

    try:
        state = client.getMultirotorState(vehicle_name=vehicle_name)
        z = state.kinematics_estimated.position.z_val
        print(f"[bridge] 起飞完成，当前高度(NED z)={z:.2f}")
    except Exception as e:
        print(f"[bridge] 已发送起飞命令，但读取状态失败: {e}")


class PatrolController:
    def __init__(
        self,
        enabled: bool,
        axis: str,
        span: float,
        speed: float,
        hold_sec: float,
        arrive_thresh: float,
    ) -> None:
        self.enabled = enabled
        self.axis = axis.lower()
        self.span = max(2.0, abs(span))
        self.speed = max(0.5, abs(speed))
        self.hold_sec = max(0.0, hold_sec)
        self.arrive_thresh = max(0.2, arrive_thresh)

        self._a = None
        self._b = None
        self._target = None
        self._hold_until = 0.0
        self._started = False

    @staticmethod
    def _dist3(p1, p2) -> float:
        dx = p1[0] - p2[0]
        dy = p1[1] - p2[1]
        dz = p1[2] - p2[2]
        return (dx * dx + dy * dy + dz * dz) ** 0.5

    def start(self, client, vehicle_name: str) -> None:
        if not self.enabled:
            return

        state = client.getMultirotorState(vehicle_name=vehicle_name)
        pos = state.kinematics_estimated.position
        cx, cy, cz = pos.x_val, pos.y_val, pos.z_val
        half = self.span / 2.0

        if self.axis == "y":
            self._a = (cx, cy - half, cz)
            self._b = (cx, cy + half, cz)
        else:
            self._a = (cx - half, cy, cz)
            self._b = (cx + half, cy, cz)

        self._target = self._a
        self._hold_until = 0.0
        self._started = True

        print(
            f"[bridge] 巡检已开启 axis={self.axis} span={self.span}m speed={self.speed}m/s hold={self.hold_sec}s"
        )
        print(f"[bridge] 巡检端点 A={self._a}, B={self._b}")
        self._dispatch_move(client, vehicle_name, self._target)

    def _dispatch_move(self, client, vehicle_name: str, target) -> None:
        tx, ty, tz = target
        client.moveToPositionAsync(
            tx,
            ty,
            tz,
            self.speed,
            drivetrain=airsim.DrivetrainType.MaxDegreeOfFreedom,
            yaw_mode=airsim.YawMode(is_rate=False, yaw_or_rate=0),
            vehicle_name=vehicle_name,
        )
        print(f"[bridge] 前往目标点: ({tx:.2f}, {ty:.2f}, {tz:.2f})")

    def step(self, client, vehicle_name: str) -> None:
        if not self.enabled or not self._started or self._target is None:
            return

        state = client.getMultirotorState(vehicle_name=vehicle_name)
        pos = state.kinematics_estimated.position
        current = (pos.x_val, pos.y_val, pos.z_val)

        d = self._dist3(current, self._target)
        now = time.time()
        if d > self.arrive_thresh:
            return

        if self._hold_until == 0.0:
            self._hold_until = now + self.hold_sec
            print(f"[bridge] 抵达目标点，悬停 {self.hold_sec:.1f}s")
            client.hoverAsync(vehicle_name=vehicle_name)
            return

        if now < self._hold_until:
            return

        self._hold_until = 0.0
        self._target = self._b if self._target == self._a else self._a
        self._dispatch_move(client, vehicle_name, self._target)


def get_scene_frame(client, camera_name: str, vehicle_name: str):
    resp = client.simGetImages(
        [airsim.ImageRequest(camera_name, airsim.ImageType.Scene, False, False)],
        vehicle_name=vehicle_name,
    )[0]

    if resp.width == 0 or resp.height == 0:
        return None

    img1d = np.frombuffer(resp.image_data_uint8, dtype=np.uint8)
    frame = img1d.reshape(resp.height, resp.width, 3)
    return frame


def post_frame(
    backend_url: str,
    frame,
    camera_name: str,
    source: str,
    persist_upload: bool,
    timeout: float,
) -> dict:
    ok, encoded = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), 85])
    if not ok:
        raise RuntimeError("帧编码失败")

    files = {
        "file": ("frame.jpg", encoded.tobytes(), "image/jpeg"),
    }
    data = {
        "source": source,
        "camera": camera_name,
        "persist_upload": str(persist_upload).lower(),
    }

    url = backend_url.rstrip("/") + "/api/detect/frame"
    r = requests.post(url, files=files, data=data, timeout=timeout)
    payload = r.json()
    if r.status_code >= 400:
        raise RuntimeError(payload.get("message", f"后端错误: {r.status_code}"))
    return payload


def run_loop(
    host: str,
    port: int,
    vehicle_name: str,
    camera_name: str,
    backend_url: str,
    fps: float,
    source: str,
    persist_upload: bool,
    takeoff: bool,
    flight_height: float,
    patrol: bool,
    patrol_axis: str,
    patrol_span: float,
    patrol_speed: float,
    patrol_hold: float,
    patrol_arrive_thresh: float,
) -> None:
    client = airsim.MultirotorClient(ip=host, port=port)
    client.confirmConnection()

    vehicles = []
    try:
        vehicles = client.listVehicles() or []
    except Exception:
        vehicles = []

    resolved_vehicle = vehicle_name
    if vehicles:
        if not resolved_vehicle:
            resolved_vehicle = vehicles[0]
            print(f"[bridge] 未指定 vehicle，自动使用: {resolved_vehicle}")
        elif resolved_vehicle not in vehicles:
            print(
                f"[bridge] 指定 vehicle '{resolved_vehicle}' 不存在，可用车辆: {vehicles}，改用 {vehicles[0]}"
            )
            resolved_vehicle = vehicles[0]

    if takeoff:
        arm_and_takeoff(client, resolved_vehicle, flight_height)
    else:
        print("[bridge] 当前为仅采图模式（未启用起飞）")

    try:
        configure_downward_camera(client, camera_name, resolved_vehicle)
    except Exception as e:
        print(f"[bridge] 相机姿态设置失败（将继续运行）: {e}")

    interval = 1.0 / max(fps, 0.1)

    print("[bridge] AirSim 实时桥接已启动，按 Ctrl+C 停止")
    print(
        f"[bridge] vehicle={resolved_vehicle or '<default>'}, camera={camera_name}, fps={fps}, backend={backend_url}"
    )

    patrol_ctl = PatrolController(
        enabled=patrol,
        axis=patrol_axis,
        span=patrol_span,
        speed=patrol_speed,
        hold_sec=patrol_hold,
        arrive_thresh=patrol_arrive_thresh,
    )
    try:
        patrol_ctl.start(client, resolved_vehicle)
    except Exception as e:
        print(f"[bridge] 巡检初始化失败: {e}")

    sent = 0
    t0 = time.time()

    while True:
        loop_start = time.time()

        try:
            patrol_ctl.step(client, resolved_vehicle)
        except Exception as e:
            print(f"[bridge] 巡检控制异常: {e}")

        frame = get_scene_frame(client, camera_name, resolved_vehicle)
        if frame is None:
            print("[bridge] 未获取到图像帧，跳过")
            time.sleep(interval)
            continue

        try:
            result = post_frame(
                backend_url=backend_url,
                frame=frame,
                camera_name=camera_name,
                source=source,
                persist_upload=persist_upload,
                timeout=15.0,
            )
            det = result.get("result", {})
            status = det.get("status", "unknown")
            objects = det.get("objects", []) or []
            msg = det.get("message", "")
            sent += 1

            elapsed = max(time.time() - t0, 1e-6)
            real_fps = sent / elapsed
            print(
                f"[bridge] status={status} objects={len(objects)} fps={real_fps:.2f} msg={msg}"
            )
        except Exception as e:
            print(f"[bridge] 发送/检测失败: {e}")

        cost = time.time() - loop_start
        wait = interval - cost
        if wait > 0:
            time.sleep(wait)


def parse_args(argv: Optional[list[str]] = None):
    parser = argparse.ArgumentParser(description="AirSim 到 FastAPI 实时检测桥接脚本")
    parser.add_argument("--host", default="127.0.0.1", help="AirSim 主机")
    parser.add_argument("--port", type=int, default=41451, help="AirSim RPC 端口")
    parser.add_argument("--vehicle", default="", help="AirSim 车辆名，默认空")
    parser.add_argument("--camera", default="down_cam", help="相机名，例如 0 或 down_cam")
    parser.add_argument("--backend", default="http://127.0.0.1:8000", help="后端地址")
    parser.add_argument("--fps", type=float, default=6.0, help="采样帧率")
    parser.add_argument("--source", default="airsim", help="来源标签")
    parser.add_argument(
        "--persist-upload",
        action="store_true",
        help="是否保存原始帧到 uploads",
    )
    parser.add_argument(
        "--takeoff",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="是否自动解锁起飞并保持高度（默认开启）",
    )
    parser.add_argument(
        "--flight-height",
        type=float,
        default=50.0,
        help="起飞模式高度(米)",
    )
    parser.add_argument(
        "--patrol",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="是否启用往返巡检（默认开启）",
    )
    parser.add_argument(
        "--patrol-axis",
        choices=["x", "y"],
        default="x",
        help="巡检往返轴向：x 或 y",
    )
    parser.add_argument(
        "--patrol-span",
        type=float,
        default=200,
        help="往返总跨度（米）",
    )
    parser.add_argument(
        "--patrol-speed",
        type=float,
        default=3.0,
        help="巡检飞行速度（米/秒）",
    )
    parser.add_argument(
        "--patrol-hold",
        type=float,
        default=2.0,
        help="到达端点悬停秒数",
    )
    parser.add_argument(
        "--patrol-arrive-thresh",
        type=float,
        default=1.2,
        help="判定到达端点距离阈值（米）",
    )
    return parser.parse_args(argv)


def main(argv: Optional[list[str]] = None) -> int:
    try:
        check_dependencies()
        args = parse_args(argv)
        run_loop(
            host=args.host,
            port=args.port,
            vehicle_name=args.vehicle,
            camera_name=args.camera,
            backend_url=args.backend,
            fps=args.fps,
            source=args.source,
            persist_upload=args.persist_upload,
            takeoff=args.takeoff,
            flight_height=args.flight_height,
            patrol=args.patrol,
            patrol_axis=args.patrol_axis,
            patrol_span=args.patrol_span,
            patrol_speed=args.patrol_speed,
            patrol_hold=args.patrol_hold,
            patrol_arrive_thresh=args.patrol_arrive_thresh,
        )
        return 0
    except KeyboardInterrupt:
        print("\n[bridge] 已停止")
        return 0
    except Exception as e:
        print(f"[bridge] 启动失败: {e}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
