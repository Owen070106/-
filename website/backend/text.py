import json
import os
import shutil
import threading
from datetime import datetime
from uuid import uuid4
from typing import Any, Generator, Optional

from fastapi import Depends, FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from sqlalchemy import Boolean, DateTime, Integer, String, create_engine
from sqlalchemy.orm import Session, declarative_base, mapped_column, sessionmaker

try:
    import cv2
    import numpy as np
except Exception:
    cv2 = None
    np = None

try:
    from ultralytics import YOLO
except Exception:
    YOLO = None

# 初始化 FastAPI 应用
app = FastAPI(title="无人机目标检测系统")

# --- 解决跨域问题 (CORS) ---
# 因为你的前端是本地 HTML 文件，浏览器可能会拦截请求，所以需要允许跨域
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # 允许所有来源
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 创建上传文件夹（如果不存在）
UPLOAD_DIR = "uploads"
RESULT_DIR = "results"
os.makedirs(UPLOAD_DIR, exist_ok=True)
os.makedirs(RESULT_DIR, exist_ok=True)

# 挂载静态目录，便于前端直接访问上传图和结果图
app.mount("/static/uploads", StaticFiles(directory=UPLOAD_DIR), name="uploads")
app.mount("/static/results", StaticFiles(directory=RESULT_DIR), name="results")

BACKEND_DIR = os.path.dirname(__file__)
WEBSITE_ROOT = os.path.abspath(os.path.join(BACKEND_DIR, ".."))
PROJECT_ROOT = os.path.abspath(os.path.join(BACKEND_DIR, "..", ".."))
HTML_ROOT = os.path.join(PROJECT_ROOT, "html")
FRONTEND_PAGES = ("index", "login", "route-plan", "task-center")

for page in FRONTEND_PAGES:
    page_dir = os.path.join(WEBSITE_ROOT, page)
    if os.path.isdir(page_dir):
        app.mount(f"/website/{page}", StaticFiles(directory=page_dir, html=True), name=f"website-{page}")

if os.path.isdir(HTML_ROOT):
    app.mount("/html", StaticFiles(directory=HTML_ROOT), name="html-assets")

MODEL_PATH = os.getenv("YOLOV26_MODEL", "./best.pt")
MODEL_PATH = os.path.abspath(os.path.expanduser(MODEL_PATH))
model_load_error: Optional[str] = None
yolo_model = None
MODEL_CACHE = {}
MODEL_CACHE_LOCK = threading.Lock()

# ==========================================
# MySQL 配置与数据库模型
# ==========================================
MYSQL_HOST = os.getenv("MYSQL_HOST", "127.0.0.1")
MYSQL_PORT = os.getenv("MYSQL_PORT", "3306")
MYSQL_USER = os.getenv("MYSQL_USER", "root")
MYSQL_PASSWORD = os.getenv("MYSQL_PASSWORD", "Wcy12138")
MYSQL_DB = os.getenv("MYSQL_DB", "uav_system")

DATABASE_URL = (
    f"mysql+pymysql://{MYSQL_USER}:{MYSQL_PASSWORD}"
    f"@{MYSQL_HOST}:{MYSQL_PORT}/{MYSQL_DB}?charset=utf8mb4"
)

engine = create_engine(DATABASE_URL, pool_pre_ping=True)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


class User(Base):
    __tablename__ = "users"

    id = mapped_column(Integer, primary_key=True, index=True)
    username = mapped_column(String(64), unique=True, nullable=False, index=True)
    password = mapped_column(String(128), nullable=False)
    display_name = mapped_column(String(64), nullable=False, default="管理员")
    created_at = mapped_column(DateTime, default=datetime.utcnow, nullable=False)


class Task(Base):
    __tablename__ = "tasks"

    id = mapped_column(Integer, primary_key=True, index=True)
    name = mapped_column(String(120), nullable=False, index=True)
    type = mapped_column(String(32), nullable=False)
    cycle = mapped_column(String(32), nullable=False)
    status = mapped_column(String(32), nullable=False, default="待执行")
    start_time = mapped_column(String(32), nullable=False)
    end_time = mapped_column(String(32), nullable=False)
    executed_done = mapped_column(Integer, nullable=False, default=0)
    executed_total = mapped_column(Integer, nullable=False, default=1)
    enabled = mapped_column(Boolean, nullable=False, default=True)
    created_at = mapped_column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = mapped_column(
        DateTime,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
        nullable=False,
    )


class RouteDraft(Base):
    __tablename__ = "route_drafts"

    id = mapped_column(Integer, primary_key=True, index=True)
    name = mapped_column(String(120), nullable=False)
    province = mapped_column(String(64), nullable=False)
    city = mapped_column(String(64), nullable=False)
    district = mapped_column(String(64), nullable=False)
    lng = mapped_column(String(32), nullable=False)
    lat = mapped_column(String(32), nullable=False)
    distance = mapped_column(String(32), nullable=False)
    point_count = mapped_column(Integer, nullable=False)
    direction = mapped_column(String(32), nullable=False)
    height = mapped_column(String(32), nullable=False)
    created_at = mapped_column(DateTime, default=datetime.utcnow, nullable=False)


class DetectionRecord(Base):
    __tablename__ = "detection_records"

    id = mapped_column(Integer, primary_key=True, index=True)
    original_filename = mapped_column(String(255), nullable=False)
    upload_image_url = mapped_column(String(255), nullable=False)
    result_image_url = mapped_column(String(255), nullable=True)
    status = mapped_column(String(32), nullable=False)
    message = mapped_column(String(255), nullable=False)
    object_count = mapped_column(Integer, nullable=False, default=0)
    created_at = mapped_column(DateTime, default=datetime.utcnow, nullable=False)


class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=128)


class RegisterRequest(BaseModel):
    username: str = Field(min_length=3, max_length=64)
    password: str = Field(min_length=6, max_length=128)
    displayName: str = Field(min_length=1, max_length=64)


class TaskPayload(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    type: str = Field(min_length=1, max_length=32)
    cycle: str = Field(min_length=1, max_length=32)
    status: str = Field(min_length=1, max_length=32)
    startTime: str = Field(min_length=1, max_length=32)
    endTime: str = Field(min_length=1, max_length=32)
    executedDone: int = Field(ge=0)
    executedTotal: int = Field(ge=1)
    enabled: bool = True


class RoutePayload(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    province: str = Field(min_length=1, max_length=64)
    city: str = Field(min_length=1, max_length=64)
    district: str = Field(min_length=1, max_length=64)
    lng: str = Field(min_length=1, max_length=32)
    lat: str = Field(min_length=1, max_length=32)
    distance: str = Field(min_length=1, max_length=32)
    pointCount: int = Field(ge=2)
    direction: str = Field(min_length=1, max_length=32)
    height: str = Field(min_length=1, max_length=32)


class MissionCalibrationPayload(BaseModel):
    worldCenterX: Optional[float] = None
    worldCenterY: Optional[float] = None
    mapWidthMeters: Optional[float] = None
    mapHeightMeters: Optional[float] = None
    anchorA: Optional[dict[str, Any]] = None
    anchorB: Optional[dict[str, Any]] = None
    worldAX: Optional[float] = None
    worldAY: Optional[float] = None
    worldBX: Optional[float] = None
    worldBY: Optional[float] = None
    invertX: bool = False
    invertY: bool = False
    defaultAltitude: Optional[float] = None


class MissionWaypointPayload(BaseModel):
    order: int = Field(ge=1)
    u: float = Field(ge=0, le=1)
    v: float = Field(ge=0, le=1)
    worldX: float
    worldY: float
    worldZ: float


class RouteMissionPayload(BaseModel):
    routeDraftId: Optional[int] = None
    routeName: str = Field(min_length=1, max_length=120)
    mapImageUrl: Optional[str] = Field(default=None, max_length=255)
    calibration: MissionCalibrationPayload
    waypoints: list[MissionWaypointPayload]


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def task_to_dict(task: Task) -> dict:
    return {
        "id": task.id,
        "name": task.name,
        "type": task.type,
        "cycle": task.cycle,
        "status": task.status,
        "startTime": task.start_time,
        "endTime": task.end_time,
        "executed": f"{task.executed_done}/{task.executed_total}",
        "executedDone": task.executed_done,
        "executedTotal": task.executed_total,
        "enabled": task.enabled,
    }


def init_seed_data() -> None:
    db = SessionLocal()
    try:
        admin = db.query(User).filter(User.username == "admin").first()
        if not admin:
            db.add(User(username="admin", password="admin123", display_name="管理员"))

        if db.query(Task).count() == 0:
            db.add_all(
                [
                    Task(
                        name="XX区日常巡检",
                        type="周期性任务",
                        cycle="每天",
                        status="执行中",
                        start_time="2021-11-15 14:00",
                        end_time="2022-11-14",
                        executed_done=49,
                        executed_total=52,
                        enabled=True,
                    ),
                    Task(
                        name="XX区临时巡检",
                        type="单次性任务",
                        cycle="单次",
                        status="已完成",
                        start_time="2021-11-01 09:00",
                        end_time="2021-11-01",
                        executed_done=1,
                        executed_total=1,
                        enabled=True,
                    ),
                    Task(
                        name="XX区紧急巡检",
                        type="单次性任务",
                        cycle="单次",
                        status="待执行",
                        start_time="2021-11-01 14:00",
                        end_time="2021-11-01",
                        executed_done=0,
                        executed_total=1,
                        enabled=False,
                    ),
                ]
            )
        db.commit()
    finally:
        db.close()


ROUTE_MISSION_FILE = os.path.join(os.path.dirname(__file__), "route_mission_current.json")


def load_route_mission() -> dict[str, Any]:
    if not os.path.isfile(ROUTE_MISSION_FILE):
        return {"item": None}

    try:
        with open(ROUTE_MISSION_FILE, "r", encoding="utf-8") as fp:
            mission = json.load(fp)
    except Exception:
        return {"item": None}

    return {"item": mission}


def save_route_mission(payload: dict[str, Any]) -> None:
    with open(ROUTE_MISSION_FILE, "w", encoding="utf-8") as fp:
        json.dump(payload, fp, ensure_ascii=False, indent=2)


def _as_float(value: Any) -> Optional[float]:
    try:
        if value is None:
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def _normalize_anchor(
    anchor: Any,
    fallback_world_x: Optional[float],
    fallback_world_y: Optional[float],
    label: str,
) -> dict[str, float]:
    if not isinstance(anchor, dict):
        raise ValueError(f"标定点 {label} 格式无效")

    u = _as_float(anchor.get("u"))
    v = _as_float(anchor.get("v"))
    if u is None or v is None or not (0 <= u <= 1) or not (0 <= v <= 1):
        raise ValueError(f"标定点 {label} 的屏幕坐标无效")

    world_x = _as_float(anchor.get("worldX"))
    world_y = _as_float(anchor.get("worldY"))
    if world_x is None:
        world_x = fallback_world_x
    if world_y is None:
        world_y = fallback_world_y
    if world_x is None or world_y is None:
        raise ValueError(f"标定点 {label} 的世界坐标无效")

    return {
        "u": round(u, 6),
        "v": round(v, 6),
        "worldX": round(world_x, 6),
        "worldY": round(world_y, 6),
    }


def normalize_mission_calibration(payload: MissionCalibrationPayload) -> dict[str, Any]:
    invert_x = bool(payload.invertX)
    invert_y = bool(payload.invertY)
    default_altitude = _as_float(payload.defaultAltitude)
    if default_altitude is None or default_altitude <= 0:
        default_altitude = 25.0

    legacy_center_x = _as_float(payload.worldCenterX)
    legacy_center_y = _as_float(payload.worldCenterY)
    legacy_width = _as_float(payload.mapWidthMeters)
    legacy_height = _as_float(payload.mapHeightMeters)
    if (
        legacy_center_x is not None
        and legacy_center_y is not None
        and legacy_width is not None
        and legacy_height is not None
    ):
        if legacy_width <= 0 or legacy_height <= 0:
            raise ValueError("旧版标定参数 mapWidthMeters/mapHeightMeters 必须大于 0")
        return {
            "format": "legacy",
            "invertX": invert_x,
            "invertY": invert_y,
            "defaultAltitude": round(default_altitude, 6),
            "worldCenterX": round(legacy_center_x, 6),
            "worldCenterY": round(legacy_center_y, 6),
            "mapWidthMeters": round(legacy_width, 6),
            "mapHeightMeters": round(legacy_height, 6),
        }

    world_ax = _as_float(payload.worldAX)
    world_ay = _as_float(payload.worldAY)
    world_bx = _as_float(payload.worldBX)
    world_by = _as_float(payload.worldBY)
    if payload.anchorA is not None or payload.anchorB is not None:
        anchor_a = _normalize_anchor(payload.anchorA, world_ax, world_ay, "A")
        anchor_b = _normalize_anchor(payload.anchorB, world_bx, world_by, "B")
        return {
            "format": "anchor",
            "invertX": invert_x,
            "invertY": invert_y,
            "defaultAltitude": round(default_altitude, 6),
            "anchorA": anchor_a,
            "anchorB": anchor_b,
            "worldAX": anchor_a["worldX"],
            "worldAY": anchor_a["worldY"],
            "worldBX": anchor_b["worldX"],
            "worldBY": anchor_b["worldY"],
        }

    raise ValueError("标定参数不完整，请提供旧版中心标定或新版双锚点标定")


@app.on_event("startup")
def on_startup() -> None:
    Base.metadata.create_all(bind=engine)
    init_seed_data()

def discover_model_paths() -> list[str]:
    candidates = []
    seen = set()
    search_dirs = [os.getcwd(), os.path.dirname(MODEL_PATH)]

    for base_dir in search_dirs:
        base_dir = os.path.abspath(base_dir)
        if not os.path.isdir(base_dir):
            continue

        try:
            for name in os.listdir(base_dir):
                if not name.lower().endswith(".pt"):
                    continue
                full_path = os.path.abspath(os.path.join(base_dir, name))
                if full_path in seen:
                    continue
                seen.add(full_path)
                candidates.append(full_path)
        except Exception:
            continue

    return sorted(candidates)


def resolve_model_path(model_name: str = "") -> str:
    if not model_name:
        return MODEL_PATH

    model_name = model_name.strip()
    if os.path.isabs(model_name):
        return os.path.abspath(model_name)

    path_1 = os.path.abspath(os.path.join(os.getcwd(), model_name))
    if os.path.isfile(path_1):
        return path_1

    path_2 = os.path.abspath(os.path.join(os.path.dirname(MODEL_PATH), model_name))
    return path_2


def get_yolo_model(model_name: str = ""):
    global yolo_model, model_load_error

    if YOLO is None:
        return None, "未安装 ultralytics，请先安装：pip install ultralytics", ""

    model_path = resolve_model_path(model_name)
    if not os.path.isfile(model_path):
        return (
            None,
            f"未找到模型权重: {model_path}。请检查模型文件名或路径。",
            model_path,
        )

    with MODEL_CACHE_LOCK:
        cached = MODEL_CACHE.get(model_path)
        if cached is not None:
            return cached, None, model_path

        try:
            loaded = YOLO(model_path)
            MODEL_CACHE[model_path] = loaded
            if model_path == MODEL_PATH:
                yolo_model = loaded
                model_load_error = None
            return loaded, None, model_path
        except Exception as e:
            return None, f"模型加载失败: {str(e)}", model_path


if YOLO is None:
    model_load_error = "未安装 ultralytics，请先安装：pip install ultralytics"
else:
    _model, _err, _path = get_yolo_model("")
    if _model is None:
        model_load_error = _err
    else:
        yolo_model = _model
        model_load_error = None

# ==========================================
# 核心逻辑：模拟 AI 检测接口
# ==========================================
def run_ai_detection(image_path: str, model_name: str = "") -> dict:
    """调用 YOLOv26 推理并返回标注结果图与检测框信息。"""
    model, err, selected_model_path = get_yolo_model(model_name)
    if model is None:
        return {
            "status": "failed",
            "message": err or model_load_error or "YOLO 模型未初始化",
            "objects": [],
            "result_image_url": None,
            "model": os.path.basename(selected_model_path) if selected_model_path else "",
            "imageWidth": None,
            "imageHeight": None,
        }

    try:
        results = model.predict(source=image_path, save=False, verbose=False)
        if not results:
            return {
                "status": "failed",
                "message": "模型未返回有效结果",
                "objects": [],
                "result_image_url": None,
                "model": os.path.basename(selected_model_path),
                "imageWidth": None,
                "imageHeight": None,
            }

        result = results[0]
        image_height = None
        image_width = None
        orig_shape = getattr(result, "orig_shape", None)
        if isinstance(orig_shape, (list, tuple)) and len(orig_shape) >= 2:
            try:
                image_height = int(orig_shape[0])
                image_width = int(orig_shape[1])
            except (TypeError, ValueError):
                image_height = None
                image_width = None

        result_filename = f"result_{uuid4().hex}.jpg"
        result_path = os.path.join(RESULT_DIR, result_filename)
        result.save(filename=result_path)

        objects = []
        names = getattr(result, "names", None) or getattr(model, "names", {})

        boxes = getattr(result, "boxes", None)
        if boxes is not None and len(boxes) > 0:
            xyxy_list = boxes.xyxy.cpu().tolist()
            conf_list = boxes.conf.cpu().tolist()
            cls_list = boxes.cls.cpu().tolist()

            for i in range(len(xyxy_list)):
                cls_id = int(cls_list[i])
                conf = float(conf_list[i])
                x1, y1, x2, y2 = [round(v, 2) for v in xyxy_list[i]]

                if isinstance(names, dict):
                    label = str(names.get(cls_id, cls_id))
                else:
                    label = str(names[cls_id]) if cls_id < len(names) else str(cls_id)

                objects.append({
                    "label": label,
                    "confidence": round(conf, 4),
                    "bbox": [x1, y1, x2, y2]
                })

        # 兼容 OBB 模型结果：有些模型结果在 result.obb 中
        if not objects:
            obb = getattr(result, "obb", None)
            if obb is not None and len(obb) > 0:
                xywhr_list = obb.xywhr.cpu().tolist()
                conf_list = obb.conf.cpu().tolist()
                cls_list = obb.cls.cpu().tolist()

                for i in range(len(xywhr_list)):
                    cls_id = int(cls_list[i])
                    conf = float(conf_list[i])
                    cx, cy, w, h, _ = xywhr_list[i]
                    x1 = round(cx - w / 2, 2)
                    y1 = round(cy - h / 2, 2)
                    x2 = round(cx + w / 2, 2)
                    y2 = round(cy + h / 2, 2)

                    if isinstance(names, dict):
                        label = str(names.get(cls_id, cls_id))
                    else:
                        label = str(names[cls_id]) if cls_id < len(names) else str(cls_id)

                    objects.append({
                        "label": label,
                        "confidence": round(conf, 4),
                        "bbox": [x1, y1, x2, y2]
                    })

        return {
            "status": "success",
            "message": "检测完成",
            "objects": objects,
            "result_image_url": f"/static/results/{result_filename}",
            "model": os.path.basename(selected_model_path),
            "imageWidth": image_width,
            "imageHeight": image_height,
        }
    except Exception as e:
        return {
            "status": "failed",
            "message": f"检测失败: {str(e)}",
            "objects": [],
            "result_image_url": None,
            "model": os.path.basename(selected_model_path),
            "imageWidth": None,
            "imageHeight": None,
        }


def run_ai_detection_frame(frame_bgr, model_name: str = "") -> dict:
    """对内存中的 BGR 图像帧进行检测并返回结果。"""
    model, err, selected_model_path = get_yolo_model(model_name)
    if model is None:
        return {
            "status": "failed",
            "message": err or model_load_error or "YOLO 模型未初始化",
            "objects": [],
            "result_image_url": None,
            "model": os.path.basename(selected_model_path) if selected_model_path else "",
            "imageWidth": None,
            "imageHeight": None,
        }

    if cv2 is None or np is None:
        return {
            "status": "failed",
            "message": "未安装 opencv-python 或 numpy，无法处理实时帧",
            "objects": [],
            "result_image_url": None,
            "imageWidth": None,
            "imageHeight": None,
        }

    try:
        results = model.predict(source=frame_bgr, save=False, verbose=False)
        if not results:
            return {
                "status": "failed",
                "message": "模型未返回有效结果",
                "objects": [],
                "result_image_url": None,
                "model": os.path.basename(selected_model_path),
                "imageWidth": None,
                "imageHeight": None,
            }

        result = results[0]
        result_filename = f"result_{uuid4().hex}.jpg"
        result_path = os.path.join(RESULT_DIR, result_filename)

        plotted = result.plot()
        cv2.imwrite(result_path, plotted)

        objects = []
        names = getattr(result, "names", None) or getattr(model, "names", {})
        boxes = getattr(result, "boxes", None)

        if boxes is not None and len(boxes) > 0:
            xyxy_list = boxes.xyxy.cpu().tolist()
            conf_list = boxes.conf.cpu().tolist()
            cls_list = boxes.cls.cpu().tolist()

            for i in range(len(xyxy_list)):
                cls_id = int(cls_list[i])
                conf = float(conf_list[i])
                x1, y1, x2, y2 = [round(v, 2) for v in xyxy_list[i]]

                if isinstance(names, dict):
                    label = str(names.get(cls_id, cls_id))
                else:
                    label = str(names[cls_id]) if cls_id < len(names) else str(cls_id)

                objects.append(
                    {
                        "label": label,
                        "confidence": round(conf, 4),
                        "bbox": [x1, y1, x2, y2],
                    }
                )

        if not objects:
            obb = getattr(result, "obb", None)
            if obb is not None and len(obb) > 0:
                xywhr_list = obb.xywhr.cpu().tolist()
                conf_list = obb.conf.cpu().tolist()
                cls_list = obb.cls.cpu().tolist()

                for i in range(len(xywhr_list)):
                    cls_id = int(cls_list[i])
                    conf = float(conf_list[i])
                    cx, cy, w, h, _ = xywhr_list[i]
                    x1 = round(cx - w / 2, 2)
                    y1 = round(cy - h / 2, 2)
                    x2 = round(cx + w / 2, 2)
                    y2 = round(cy + h / 2, 2)

                    if isinstance(names, dict):
                        label = str(names.get(cls_id, cls_id))
                    else:
                        label = str(names[cls_id]) if cls_id < len(names) else str(cls_id)

                    objects.append(
                        {
                            "label": label,
                            "confidence": round(conf, 4),
                            "bbox": [x1, y1, x2, y2],
                        }
                    )

        return {
            "status": "success",
            "message": "检测完成",
            "objects": objects,
            "result_image_url": f"/static/results/{result_filename}",
            "model": os.path.basename(selected_model_path),
            "imageWidth": int(frame_bgr.shape[1]) if hasattr(frame_bgr, "shape") else None,
            "imageHeight": int(frame_bgr.shape[0]) if hasattr(frame_bgr, "shape") else None,
        }
    except Exception as e:
        return {
            "status": "failed",
            "message": f"检测失败: {str(e)}",
            "objects": [],
            "result_image_url": None,
            "model": os.path.basename(selected_model_path),
            "imageWidth": None,
            "imageHeight": None,
        }


@app.get("/api/models")
def get_models():
    items = []
    default_abs = os.path.abspath(MODEL_PATH)

    for path in discover_model_paths():
        items.append(
            {
                "name": os.path.basename(path),
                "path": path,
                "isDefault": os.path.abspath(path) == default_abs,
            }
        )

    if not items and os.path.isfile(default_abs):
        items.append(
            {
                "name": os.path.basename(default_abs),
                "path": default_abs,
                "isDefault": True,
            }
        )

    return {
        "default": os.path.basename(default_abs),
        "items": items,
    }

# ==========================================
# 接口：登录
# ==========================================
@app.post("/api/login")
def login(payload: LoginRequest, db: Session = Depends(get_db)):
    user = (
        db.query(User)
        .filter(User.username == payload.username, User.password == payload.password)
        .first()
    )
    if not user:
        raise HTTPException(status_code=401, detail="用户名或密码错误")

    return {
        "message": "登录成功",
        "user": {
            "id": user.id,
            "username": user.username,
            "displayName": user.display_name,
        },
    }


@app.post("/api/register")
def register(payload: RegisterRequest, db: Session = Depends(get_db)):
    exists = db.query(User).filter(User.username == payload.username).first()
    if exists:
        raise HTTPException(status_code=400, detail="用户名已存在")

    user = User(
        username=payload.username.strip(),
        password=payload.password,
        display_name=payload.displayName.strip(),
    )
    db.add(user)
    db.commit()
    db.refresh(user)

    return {
        "message": "注册成功",
        "user": {
            "id": user.id,
            "username": user.username,
            "displayName": user.display_name,
        },
    }


# ==========================================
# 接口：任务管理
# ==========================================
@app.get("/api/tasks")
def get_tasks(
    name: str = "",
    type: str = "all",
    cycle: str = "all",
    status: str = "all",
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=6, ge=1, le=100),
    db: Session = Depends(get_db),
):
    query = db.query(Task)

    if name:
        query = query.filter(Task.name.like(f"%{name}%"))
    if type != "all":
        query = query.filter(Task.type == type)
    if cycle != "all":
        query = query.filter(Task.cycle == cycle)
    if status != "all":
        query = query.filter(Task.status == status)

    total = query.count()
    rows = (
        query.order_by(Task.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )

    return {
        "total": total,
        "page": page,
        "pageSize": page_size,
        "items": [task_to_dict(item) for item in rows],
    }


@app.post("/api/tasks")
def create_task(payload: TaskPayload, db: Session = Depends(get_db)):
    if payload.executedDone > payload.executedTotal:
        raise HTTPException(status_code=400, detail="累计执行次数不能大于总次数")

    task = Task(
        name=payload.name,
        type=payload.type,
        cycle=payload.cycle,
        status=payload.status,
        start_time=payload.startTime,
        end_time=payload.endTime,
        executed_done=payload.executedDone,
        executed_total=payload.executedTotal,
        enabled=payload.enabled,
    )
    db.add(task)
    db.commit()
    db.refresh(task)
    return {"message": "创建成功", "item": task_to_dict(task)}


@app.put("/api/tasks/{task_id}")
def update_task(task_id: int, payload: TaskPayload, db: Session = Depends(get_db)):
    task = db.query(Task).filter(Task.id == task_id).first()
    if not task:
        raise HTTPException(status_code=404, detail="任务不存在")
    if payload.executedDone > payload.executedTotal:
        raise HTTPException(status_code=400, detail="累计执行次数不能大于总次数")

    task.name = payload.name
    task.type = payload.type
    task.cycle = payload.cycle
    task.status = payload.status
    task.start_time = payload.startTime
    task.end_time = payload.endTime
    task.executed_done = payload.executedDone
    task.executed_total = payload.executedTotal
    task.enabled = payload.enabled
    db.commit()
    db.refresh(task)
    return {"message": "更新成功", "item": task_to_dict(task)}


@app.delete("/api/tasks/{task_id}")
def delete_task(task_id: int, db: Session = Depends(get_db)):
    task = db.query(Task).filter(Task.id == task_id).first()
    if not task:
        raise HTTPException(status_code=404, detail="任务不存在")

    db.delete(task)
    db.commit()
    return {"message": "删除成功"}


@app.patch("/api/tasks/{task_id}/toggle")
def toggle_task(task_id: int, db: Session = Depends(get_db)):
    task = db.query(Task).filter(Task.id == task_id).first()
    if not task:
        raise HTTPException(status_code=404, detail="任务不存在")

    task.enabled = not task.enabled
    db.commit()
    db.refresh(task)
    return {"message": "状态已更新", "item": task_to_dict(task)}


# ==========================================
# 接口：航线规划
# ==========================================
@app.get("/api/routes")
def get_routes(limit: int = Query(default=20, ge=1, le=200), db: Session = Depends(get_db)):
    rows = db.query(RouteDraft).order_by(RouteDraft.id.desc()).limit(limit).all()
    return {
        "items": [
            {
                "id": item.id,
                "name": item.name,
                "province": item.province,
                "city": item.city,
                "district": item.district,
                "lng": item.lng,
                "lat": item.lat,
                "distance": item.distance,
                "pointCount": item.point_count,
                "direction": item.direction,
                "height": item.height,
                "createdAt": item.created_at.strftime("%Y-%m-%d %H:%M:%S"),
            }
            for item in rows
        ]
    }


@app.post("/api/routes")
def create_route(payload: RoutePayload, db: Session = Depends(get_db)):
    route = RouteDraft(
        name=payload.name,
        province=payload.province,
        city=payload.city,
        district=payload.district,
        lng=payload.lng,
        lat=payload.lat,
        distance=payload.distance,
        point_count=payload.pointCount,
        direction=payload.direction,
        height=payload.height,
    )
    db.add(route)
    db.commit()
    db.refresh(route)
    return {"message": "航线保存成功", "id": route.id}


@app.post("/api/route-missions")
def publish_route_mission(payload: RouteMissionPayload):
    if len(payload.waypoints) < 2:
        raise HTTPException(status_code=400, detail="请至少添加 2 个航点")

    try:
        normalized_calibration = normalize_mission_calibration(payload.calibration)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    mission = {
        "id": uuid4().hex,
        "routeDraftId": payload.routeDraftId,
        "routeName": payload.routeName,
        "mapImageUrl": payload.mapImageUrl,
        "calibration": normalized_calibration,
        "waypoints": [item.model_dump() for item in payload.waypoints],
        "createdAt": datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S"),
        "status": "ready",
    }
    save_route_mission(mission)
    return {"message": "航线已下发到执行器", "item": mission}


@app.get("/api/route-missions/latest")
def get_latest_route_mission():
    return load_route_mission()


# ==========================================
# 接口：接收文件并返回结果
# ==========================================
@app.post("/api/detect")
async def detect(
    file: UploadFile = File(...),
    model_name: str = Form(default=""),
    db: Session = Depends(get_db),
):
    """
    接收前端上传的文件，保存后送入 AI 模型，最后返回 JSON 结果
    """
    # 1. 校验文件类型 (只允许图片)
    if not file.content_type.startswith("image/"):
        return JSONResponse(status_code=400, content={"message": "请上传图片文件"})

    # 2. 保存文件到本地
    ext = os.path.splitext(file.filename or "")[1] or ".jpg"
    saved_filename = f"upload_{uuid4().hex}{ext}"
    file_path = os.path.join(UPLOAD_DIR, saved_filename)
    try:
        with open(file_path, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)
    except Exception as e:
        return JSONResponse(status_code=500, content={"message": f"文件保存失败: {str(e)}"})

    # 3. 调用 AI 检测逻辑
    # 这里调用上面定义的 run_ai_detection 函数
    detection_result = run_ai_detection(file_path, model_name=model_name)

    record = DetectionRecord(
        original_filename=file.filename or "unknown",
        upload_image_url=f"/static/uploads/{saved_filename}",
        result_image_url=detection_result.get("result_image_url"),
        status=detection_result.get("status", "failed"),
        message=detection_result.get("message", ""),
        object_count=len(detection_result.get("objects", [])),
    )
    db.add(record)
    db.commit()

    # 4. 返回结果给前端
    return {
        "filename": file.filename,
        "upload_image_url": f"/static/uploads/{saved_filename}",
        "result": detection_result
    }


@app.post("/api/detect/frame")
async def detect_frame(
    file: UploadFile = File(...),
    source: str = Form(default="airsim"),
    camera: str = Form(default="down_cam"),
    model_name: str = Form(default=""),
    persist_upload: bool = Form(default=False),
    db: Session = Depends(get_db),
):
    """接收实时图像帧（内存处理），用于 AirSim/UE 实时检测。"""
    if cv2 is None or np is None:
        return JSONResponse(
            status_code=500,
            content={"message": "缺少 opencv-python 或 numpy 依赖"},
        )

    if not file.content_type.startswith("image/"):
        return JSONResponse(status_code=400, content={"message": "请上传图片帧"})

    try:
        raw = await file.read()
        np_arr = np.frombuffer(raw, dtype=np.uint8)
        frame = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)
        if frame is None:
            raise ValueError("图像解码失败")
    except Exception as e:
        return JSONResponse(status_code=400, content={"message": f"帧解析失败: {str(e)}"})

    detection_result = run_ai_detection_frame(frame, model_name=model_name)

    upload_image_url = None
    original_name = file.filename or "frame.jpg"

    if persist_upload:
        ext = os.path.splitext(original_name)[1] or ".jpg"
        saved_filename = f"upload_{uuid4().hex}{ext}"
        save_path = os.path.join(UPLOAD_DIR, saved_filename)
        try:
            with open(save_path, "wb") as fw:
                fw.write(raw)
            upload_image_url = f"/static/uploads/{saved_filename}"
        except Exception:
            upload_image_url = None

    record = DetectionRecord(
        original_filename=f"{source}:{camera}:{original_name}",
        upload_image_url=upload_image_url or "",
        result_image_url=detection_result.get("result_image_url"),
        status=detection_result.get("status", "failed"),
        message=detection_result.get("message", ""),
        object_count=len(detection_result.get("objects", [])),
    )
    db.add(record)
    db.commit()

    return {
        "filename": original_name,
        "source": source,
        "camera": camera,
        "result": detection_result,
    }


@app.post("/api/upload")
async def upload_file(file: UploadFile = File(...), db: Session = Depends(get_db)):
    # 兼容旧接口，转发到新检测接口
    return await detect(file, "", db)


@app.get("/api/detections")
def get_detections(limit: int = Query(default=20, ge=1, le=200), db: Session = Depends(get_db)):
    rows = db.query(DetectionRecord).order_by(DetectionRecord.id.desc()).limit(limit).all()
    return {
        "items": [
            {
                "id": item.id,
                "filename": item.original_filename,
                "status": item.status,
                "message": item.message,
                "objectCount": item.object_count,
                "uploadImageUrl": item.upload_image_url,
                "resultImageUrl": item.result_image_url,
                "createdAt": item.created_at.strftime("%Y-%m-%d %H:%M:%S"),
            }
            for item in rows
        ]
    }


@app.get("/api/detections/latest")
def get_latest_detection(db: Session = Depends(get_db)):
    item = db.query(DetectionRecord).order_by(DetectionRecord.id.desc()).first()
    if not item:
        return {"item": None}

    return {
        "item": {
            "id": item.id,
            "filename": item.original_filename,
            "status": item.status,
            "message": item.message,
            "objectCount": item.object_count,
            "uploadImageUrl": item.upload_image_url,
            "resultImageUrl": item.result_image_url,
            "createdAt": item.created_at.strftime("%Y-%m-%d %H:%M:%S"),
        }
    }

# ==========================================
# 启动服务器
# ==========================================
@app.get("/", include_in_schema=False)
def root_page():
    return RedirectResponse(url="/website/index/index.html", status_code=307)


@app.get("/favicon.ico", include_in_schema=False)
def favicon():
    return Response(status_code=204)


if __name__ == "__main__":
    import uvicorn
    # 启动服务，监听 8000 端口
    print("服务器已启动：http://127.0.0.1:8000")
    uvicorn.run(app, host="127.0.0.1", port=8000)
