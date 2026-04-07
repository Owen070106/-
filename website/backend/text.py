import os
import shutil
from uuid import uuid4
from typing import Optional
from fastapi import FastAPI, File, UploadFile
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware

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

MODEL_PATH = os.getenv("YOLOV26_MODEL", "./yolov10n.pt")
MODEL_PATH = os.path.abspath(os.path.expanduser(MODEL_PATH))
model_load_error: Optional[str] = None
yolo_model = None

if YOLO is None:
    model_load_error = "未安装 ultralytics，请先安装：pip install ultralytics"
elif not os.path.isfile(MODEL_PATH):
    model_load_error = (
        f"未找到本地模型权重: {MODEL_PATH}。"
        "请把权重放到该路径，或设置环境变量 YOLOV26_MODEL 指向 .pt 文件。"
    )
else:
    try:
        yolo_model = YOLO(MODEL_PATH)
    except Exception as e:
        model_load_error = f"模型加载失败: {str(e)}"

# ==========================================
# 核心逻辑：模拟 AI 检测接口
# ==========================================
def run_ai_detection(image_path: str) -> dict:
    """调用 YOLOv26 推理并返回标注结果图与检测框信息。"""
    if yolo_model is None:
        return {
            "status": "failed",
            "message": model_load_error or "YOLO 模型未初始化",
            "objects": [],
            "result_image_url": None
        }

    try:
        results = yolo_model.predict(source=image_path, save=False, verbose=False)
        if not results:
            return {
                "status": "failed",
                "message": "模型未返回有效结果",
                "objects": [],
                "result_image_url": None
            }

        result = results[0]
        result_filename = f"result_{uuid4().hex}.jpg"
        result_path = os.path.join(RESULT_DIR, result_filename)
        result.save(filename=result_path)

        objects = []
        boxes = result.boxes
        if boxes is not None:
            for box in boxes:
                cls_id = int(box.cls[0])
                conf = float(box.conf[0])
                x1, y1, x2, y2 = [round(v, 2) for v in box.xyxy[0].tolist()]

                names = yolo_model.names
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
            "result_image_url": f"/static/results/{result_filename}"
        }
    except Exception as e:
        return {
            "status": "failed",
            "message": f"检测失败: {str(e)}",
            "objects": [],
            "result_image_url": None
        }

# ==========================================
# 接口：接收文件并返回结果
# ==========================================
@app.post("/api/detect")
async def detect(file: UploadFile = File(...)):
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
    detection_result = run_ai_detection(file_path)

    # 4. 返回结果给前端
    return {
        "filename": file.filename,
        "upload_image_url": f"/static/uploads/{saved_filename}",
        "result": detection_result
    }


@app.post("/api/upload")
async def upload_file(file: UploadFile = File(...)):
    # 兼容旧接口，转发到新检测接口
    return await detect(file)

# ==========================================
# 启动服务器
# ==========================================
if __name__ == "__main__":
    import uvicorn
    # 启动服务，监听 8000 端口
    print("服务器已启动：http://127.0.0.1:8000")
    uvicorn.run(app, host="127.0.0.1", port=8000)