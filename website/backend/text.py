import os
import shutil
from typing import Optional
from fastapi import FastAPI, File, UploadFile
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware

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
os.makedirs(UPLOAD_DIR, exist_ok=True)

# ==========================================
# 核心逻辑：模拟 AI 检测接口
# ==========================================
def run_ai_detection(image_path: str) -> dict:
    """
    这里预留了 AI 模型接入的位置。
    目前返回的是模拟数据，后期请替换为你的 PyTorch/TensorFlow/YOLO 代码。
    """
    print(f"正在处理图片: {image_path}")
    
    # --- 在这里接入你的 AI 模型 ---
    # 示例伪代码:
    # results = model(image_path)
    # detected_objects = parse_results(results)
    
    # 模拟耗时操作 (假设模型跑了 2 秒)
    import time
    time.sleep(2) 

    # 模拟返回的检测结果
    return {
        "status": "success",
        "message": "检测完成",
        "objects": [
            {"label": "无人机", "confidence": 0.98, "bbox": [100, 100, 200, 200]},
            {"label": "车辆", "confidence": 0.85, "bbox": [300, 300, 400, 400]}
        ]
    }

# ==========================================
# 接口：接收文件并返回结果
# ==========================================
@app.post("/api/upload")
async def upload_file(file: UploadFile = File(...)):
    """
    接收前端上传的文件，保存后送入 AI 模型，最后返回 JSON 结果
    """
    # 1. 校验文件类型 (只允许图片)
    if not file.content_type.startswith("image/"):
        return JSONResponse(status_code=400, content={"message": "请上传图片文件"})

    # 2. 保存文件到本地
    file_path = os.path.join(UPLOAD_DIR, file.filename)
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
        "filepath": file_path, # 返回文件路径，方便前端显示图片
        "result": detection_result
    }

# ==========================================
# 启动服务器
# ==========================================
if __name__ == "__main__":
    import uvicorn
    # 启动服务，监听 8000 端口
    print("服务器已启动：http://127.0.0.1:8000")
    uvicorn.run(app, host="127.0.0.1", port=8000)