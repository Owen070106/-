const API_BASE = "http://127.0.0.1:8000";
const SETTINGS_KEY = "uav_route_plan_settings";
const DEFAULT_MAP_IMAGE = "map/HighresScreenshot00000.png";
const DRAG_THRESHOLD_PX = 5;

const refs = {
    userPanel: document.getElementById("userPanel"),
    backToTask: document.getElementById("backToTask"),
    areaConfirm: document.getElementById("areaConfirm"),
    province: document.getElementById("province"),
    city: document.getElementById("city"),
    district: document.getElementById("district"),
    routeName: document.getElementById("routeName"),
    lng: document.getElementById("lng"),
    lat: document.getElementById("lat"),
    distance: document.getElementById("distance"),
    pointCount: document.getElementById("pointCount"),
    direction: document.getElementById("direction"),
    height: document.getElementById("height"),
    saveRoute: document.getElementById("saveRoute"),
    publishMission: document.getElementById("publishMission"),
    cancelRoute: document.getElementById("cancelRoute"),
    formTip: document.getElementById("formTip"),
    missionTip: document.getElementById("missionTip"),
    draftList: document.getElementById("draftList"),
    waypointList: document.getElementById("waypointList"),
    routeLayer: document.getElementById("routeLayer"),
    mapCanvas: document.getElementById("mapCanvas"),
    mapImage: document.getElementById("mapImage"),
    mapImageUrl: document.getElementById("mapImageUrl"),
    defaultAltitude: document.getElementById("defaultAltitude"),
    invertX: document.getElementById("invertX"),
    invertY: document.getElementById("invertY"),
    anchorAX: document.getElementById("anchorAX"),
    anchorAY: document.getElementById("anchorAY"),
    anchorBX: document.getElementById("anchorBX"),
    anchorBY: document.getElementById("anchorBY"),
    setAnchorA: document.getElementById("setAnchorA"),
    setAnchorB: document.getElementById("setAnchorB"),
    clearCalibration: document.getElementById("clearCalibration"),
    anchorATip: document.getElementById("anchorATip"),
    anchorBTip: document.getElementById("anchorBTip"),
    clearWaypoints: document.getElementById("clearWaypoints"),
    tools: document.querySelectorAll(".tool-btn")
};

const drafts = [];
const state = {
    waypoints: [],
    currentRouteDraftId: null,
    activeTool: "point",
    pendingCalibrationAnchor: "",
    calibrationAnchorA: null,
    calibrationAnchorB: null,
    mapPanX: 0,
    mapPanY: 0,
    dragging: false,
    dragPointerId: null,
    dragStartX: 0,
    dragStartY: 0,
    dragStartPanX: 0,
    dragStartPanY: 0,
    dragMoved: false,
    suppressNextClick: false
};

function escapeHtml(value) {
    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}

function loadSettings() {
    try {
        const raw = localStorage.getItem(SETTINGS_KEY);
        if (!raw) {
            return {
                mapImageUrl: DEFAULT_MAP_IMAGE,
                defaultAltitude: "25",
                invertX: false,
                invertY: false,
                calibrationAnchorA: null,
                calibrationAnchorB: null
            };
        }

        const parsed = JSON.parse(raw);
        return {
            mapImageUrl: parsed.mapImageUrl || DEFAULT_MAP_IMAGE,
            defaultAltitude: parsed.defaultAltitude ?? "25",
            invertX: Boolean(parsed.invertX),
            invertY: Boolean(parsed.invertY),
            calibrationAnchorA: parsed.calibrationAnchorA || null,
            calibrationAnchorB: parsed.calibrationAnchorB || null
        };
    } catch (error) {
        return {
            mapImageUrl: DEFAULT_MAP_IMAGE,
            defaultAltitude: "25",
            invertX: false,
            invertY: false,
            calibrationAnchorA: null,
            calibrationAnchorB: null
        };
    }
}

function saveSettings() {
    const payload = {
        mapImageUrl: refs.mapImageUrl.value.trim(),
        defaultAltitude: refs.defaultAltitude.value.trim(),
        invertX: refs.invertX.checked,
        invertY: refs.invertY.checked,
        calibrationAnchorA: state.calibrationAnchorA,
        calibrationAnchorB: state.calibrationAnchorB
    };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(payload));
}

function applySettings() {
    const settings = loadSettings();
    refs.mapImageUrl.value = settings.mapImageUrl || DEFAULT_MAP_IMAGE;
    refs.defaultAltitude.value = settings.defaultAltitude;
    refs.invertX.checked = settings.invertX;
    refs.invertY.checked = settings.invertY;
    state.calibrationAnchorA = settings.calibrationAnchorA;
    state.calibrationAnchorB = settings.calibrationAnchorB;
    refs.anchorAX.value = state.calibrationAnchorA?.worldX ?? "";
    refs.anchorAY.value = state.calibrationAnchorA?.worldY ?? "";
    refs.anchorBX.value = state.calibrationAnchorB?.worldX ?? "";
    refs.anchorBY.value = state.calibrationAnchorB?.worldY ?? "";
    updateCalibrationTips();
}

function persistAndRefreshBackground() {
    saveSettings();
    const url = refs.mapImageUrl.value.trim() || DEFAULT_MAP_IMAGE;
    refs.mapImageUrl.value = url;
    refs.mapImage.src = encodeURI(url);
}

function showMissionTip(message, isError = true) {
    refs.missionTip.style.color = isError ? "#ef4444" : "#16a34a";
    refs.missionTip.textContent = message;
}

function updateCalibrationTips() {
    refs.anchorATip.textContent = state.calibrationAnchorA
        ? `屏幕(${Math.round(state.calibrationAnchorA.u * 1000)}, ${Math.round(state.calibrationAnchorA.v * 1000)})`
        : "尚未记录";
    refs.anchorBTip.textContent = state.calibrationAnchorB
        ? `屏幕(${Math.round(state.calibrationAnchorB.u * 1000)}, ${Math.round(state.calibrationAnchorB.v * 1000)})`
        : "尚未记录";
}

function getBaseMapViewport() {
    const rect = refs.mapCanvas.getBoundingClientRect();
    const naturalWidth = refs.mapImage.naturalWidth || rect.width;
    const naturalHeight = refs.mapImage.naturalHeight || rect.height;

    if (!naturalWidth || !naturalHeight || !rect.width || !rect.height) {
        return { left: 0, top: 0, width: rect.width, height: rect.height };
    }

    const scale = Math.min(rect.width / naturalWidth, rect.height / naturalHeight);
    const width = naturalWidth * scale;
    const height = naturalHeight * scale;

    return {
        left: (rect.width - width) / 2,
        top: (rect.height - height) / 2,
        width,
        height
    };
}

function getMapViewport() {
    const base = getBaseMapViewport();
    return {
        ...base,
        left: base.left + state.mapPanX,
        top: base.top + state.mapPanY
    };
}

function getMapPanBounds() {
    const base = getBaseMapViewport();
    return {
        minX: -Math.max(0, base.left),
        maxX: Math.max(0, base.left),
        minY: -Math.max(0, base.top),
        maxY: Math.max(0, base.top)
    };
}

function clampMapPan(nextX, nextY) {
    const bounds = getMapPanBounds();
    return {
        x: Math.min(bounds.maxX, Math.max(bounds.minX, nextX)),
        y: Math.min(bounds.maxY, Math.max(bounds.minY, nextY))
    };
}

function applyMapImageTransform() {
    refs.mapImage.style.transform = `translate(${state.mapPanX}px, ${state.mapPanY}px)`;
}

function setMapPan(nextX, nextY, shouldRender = true) {
    const clamped = clampMapPan(nextX, nextY);
    state.mapPanX = clamped.x;
    state.mapPanY = clamped.y;
    applyMapImageTransform();
    if (shouldRender) {
        renderWaypoints();
    }
}

function keepMapPanInBounds() {
    const clamped = clampMapPan(state.mapPanX, state.mapPanY);
    state.mapPanX = clamped.x;
    state.mapPanY = clamped.y;
    applyMapImageTransform();
}

function updateMapCanvasModeClass() {
    refs.mapCanvas.classList.toggle("mode-point", state.activeTool === "point");
}

function readCalibration() {
    const anchorA = state.calibrationAnchorA;
    const anchorB = state.calibrationAnchorB;

    if (!anchorA || !anchorB) {
        throw new Error("请先记录标定点 A 和 B");
    }

    const worldAX = Number(refs.anchorAX.value);
    const worldAY = Number(refs.anchorAY.value);
    const worldBX = Number(refs.anchorBX.value);
    const worldBY = Number(refs.anchorBY.value);

    if ([worldAX, worldAY, worldBX, worldBY].some((value) => Number.isNaN(value))) {
        throw new Error("标定点的世界坐标必须是数字");
    }

    const defaultAltitude = Number(refs.defaultAltitude.value);
    if (Number.isNaN(defaultAltitude) || defaultAltitude <= 0) {
        throw new Error("默认航高必须是大于 0 的数字");
    }

    return {
        anchorA,
        anchorB,
        worldAX,
        worldAY,
        worldBX,
        worldBY,
        invertX: refs.invertX.checked,
        invertY: refs.invertY.checked,
        defaultAltitude
    };
}

function pointToWorld(point, calibration) {
    const worldAX = calibration.worldAX;
    const worldAY = calibration.worldAY;
    const worldBX = calibration.worldBX;
    const worldBY = calibration.worldBY;

    const screenA = calibration.anchorA;
    const screenB = calibration.anchorB;

    const deltaU = screenB.u - screenA.u;
    const deltaV = screenB.v - screenA.v;
    const worldDeltaX = worldBX - worldAX;
    const worldDeltaY = worldBY - worldAY;

    const safeDeltaU = Math.abs(deltaU) < 1e-6 ? 1e-6 : deltaU;
    const safeDeltaV = Math.abs(deltaV) < 1e-6 ? 1e-6 : deltaV;

    const normalizedU = (point.u - screenA.u) / safeDeltaU;
    const normalizedV = (point.v - screenA.v) / safeDeltaV;

    const mappedX = worldAX + normalizedU * worldDeltaX;
    const mappedY = worldAY + normalizedV * worldDeltaY;

    const appliedX = calibration.invertX ? worldAX - (mappedX - worldAX) : mappedX;
    const appliedY = calibration.invertY ? worldAY - (mappedY - worldAY) : mappedY;

    return {
        worldX: Number(appliedX.toFixed(3)),
        worldY: Number(appliedY.toFixed(3)),
        worldZ: Number(calibration.defaultAltitude.toFixed(3))
    };
}

function getWaypointSummary(point, index, calibration) {
    const worldPoint = pointToWorld(point, calibration);
    return `${index + 1}. (${worldPoint.worldX}, ${worldPoint.worldY}, ${worldPoint.worldZ})`;
}

function renderWaypoints() {
    let calibration = null;
    try {
        calibration = readCalibration();
    } catch (error) {
        calibration = null;
    }
    refs.pointCount.value = String(state.waypoints.length || 0);

    if (state.waypoints.length === 0) {
        refs.waypointList.innerHTML = '<li class="waypoint-empty">尚未添加航点</li>';
        refs.routeLayer.innerHTML = "";
        return;
    }

    const viewport = getMapViewport();
    const canvasRect = refs.mapCanvas.getBoundingClientRect();

    const toSvgPoint = (item) => {
        const x = viewport.left + item.u * viewport.width;
        const y = viewport.top + item.v * viewport.height;
        const xPct = canvasRect.width > 0 ? (x / canvasRect.width) * 1000 : 0;
        const yPct = canvasRect.height > 0 ? (y / canvasRect.height) * 1000 : 0;
        return { x: xPct, y: yPct };
    };

    const pointList = state.waypoints.map((item, index) => {
        const worldPoint = calibration ? pointToWorld(item, calibration) : null;
        const worldText = worldPoint ? `世界: (${worldPoint.worldX}, ${worldPoint.worldY}, ${worldPoint.worldZ})` : "世界坐标待校准";
        return `
            <li class="waypoint-item">
                <span class="waypoint-badge">${index + 1}</span>
                <span class="waypoint-text">屏幕: (${Math.round(item.u * 1000)}, ${Math.round(item.v * 1000)})<br>${worldText}</span>
                <button class="waypoint-remove" type="button" data-index="${index}">删除</button>
            </li>
        `;
    }).join("");

    const pathPoints = state.waypoints.map((item) => {
        const point = toSvgPoint(item);
        return `${point.x},${point.y}`;
    }).join(" ");
    const svgNodes = [];
    if (state.waypoints.length > 1) {
        svgNodes.push(`<polyline class="route-line" points="${pathPoints}"></polyline>`);
    }
    state.waypoints.forEach((item, index) => {
        const point = toSvgPoint(item);
        const x = point.x;
        const y = point.y;
        svgNodes.push(`<circle class="route-point" cx="${x}" cy="${y}" r="11"></circle>`);
        svgNodes.push(`<text class="route-point-label" x="${x}" y="${y + 5}">${index + 1}</text>`);
    });

    refs.waypointList.innerHTML = pointList;
    refs.routeLayer.innerHTML = svgNodes.join("");

    refs.waypointList.querySelectorAll(".waypoint-remove").forEach((button) => {
        button.addEventListener("click", () => {
            const index = Number(button.dataset.index);
            state.waypoints.splice(index, 1);
            renderWaypoints();
            showMissionTip("航点已删除", false);
        });
    });
}

function addWaypointFromEvent(event) {
    if (state.suppressNextClick) {
        state.suppressNextClick = false;
        return;
    }

    const rect = refs.mapCanvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
        return;
    }

    const viewport = getMapViewport();
    const imgLeft = rect.left + viewport.left;
    const imgTop = rect.top + viewport.top;
    const imgRight = imgLeft + viewport.width;
    const imgBottom = imgTop + viewport.height;

    if (event.clientX < imgLeft || event.clientX > imgRight || event.clientY < imgTop || event.clientY > imgBottom) {
        showMissionTip("请点击图片本体区域，避免留白区域", true);
        return;
    }

    const u = Math.min(1, Math.max(0, (event.clientX - imgLeft) / viewport.width));
    const v = Math.min(1, Math.max(0, (event.clientY - imgTop) / viewport.height));

    if (state.pendingCalibrationAnchor) {
        const selectedAnchor = state.pendingCalibrationAnchor;
        const worldXField = state.pendingCalibrationAnchor === "A" ? refs.anchorAX : refs.anchorBX;
        const worldYField = state.pendingCalibrationAnchor === "A" ? refs.anchorAY : refs.anchorBY;
        const worldX = Number(worldXField.value);
        const worldY = Number(worldYField.value);

        if (Number.isNaN(worldX) || Number.isNaN(worldY)) {
            showMissionTip(`请先填写标定点 ${state.pendingCalibrationAnchor} 的世界坐标`, true);
            return;
        }

        const anchor = { u, v, worldX, worldY };
        if (state.pendingCalibrationAnchor === "A") {
            state.calibrationAnchorA = anchor;
        } else {
            state.calibrationAnchorB = anchor;
        }

        updateCalibrationTips();
        saveSettings();
        renderWaypoints();
        state.pendingCalibrationAnchor = "";
        showMissionTip(`已记录标定点 ${selectedAnchor}`, false);
        return;
    }

    if (state.activeTool !== "point") {
        showMissionTip("当前工具不支持添加航点，请切换到“航点”", true);
        return;
    }

    state.waypoints.push({ u, v });
    renderWaypoints();

    try {
        const calibration = readCalibration();
        const summary = getWaypointSummary({ u, v }, state.waypoints.length - 1, calibration);
        showMissionTip(`已添加航点：${summary}`, false);
    } catch (error) {
        showMissionTip("已添加航点，补全地图校准后可生成世界坐标", false);
    }
}

function buildMissionPayload(routeDraftId = null) {
    const calibration = readCalibration();
    const routeName = refs.routeName.value.trim();

    if (!routeName) {
        throw new Error("请先填写航线名称");
    }
    if (state.waypoints.length < 2) {
        throw new Error("请至少添加 2 个航点");
    }

    return {
        routeDraftId,
        routeName,
        mapImageUrl: refs.mapImageUrl.value.trim() || null,
        calibration,
        waypoints: state.waypoints.map((item, index) => {
            const worldPoint = pointToWorld(item, calibration);
            return {
                order: index + 1,
                u: Number(item.u.toFixed(6)),
                v: Number(item.v.toFixed(6)),
                ...worldPoint
            };
        })
    };
}

function initUserPanel() {
    const raw = localStorage.getItem("uav_user");
    if (!raw) {
        window.location.href = "../login/login.html";
        return;
    }

    try {
        const user = JSON.parse(raw);
        const displayName = user.displayName || user.username || "未知用户";
        refs.userPanel.textContent = `管理员：${displayName}`;
    } catch (error) {
        localStorage.removeItem("uav_user");
        window.location.href = "../login/login.html";
    }
}

function showTip(message, isError = true) {
    refs.formTip.style.color = isError ? "#ef4444" : "#16a34a";
    refs.formTip.textContent = message;
}

function isNumber(value) {
    return value !== "" && !Number.isNaN(Number(value));
}

function validateForm() {
    if (!refs.routeName.value.trim()) {
        return "请填写航线名称";
    }
    if (!isNumber(refs.lng.value) || Number(refs.lng.value) < -180 || Number(refs.lng.value) > 180) {
        return "经度应为 -180 到 180 之间的数字";
    }
    if (!isNumber(refs.lat.value) || Number(refs.lat.value) < -90 || Number(refs.lat.value) > 90) {
        return "纬度应为 -90 到 90 之间的数字";
    }
    if (!isNumber(refs.distance.value) || Number(refs.distance.value) <= 0) {
        return "航点间距应为大于 0 的数字";
    }
    if (!isNumber(refs.pointCount.value) || Number(refs.pointCount.value) <= 1) {
        return "航点数量应为大于 1 的数字";
    }
    if (!isNumber(refs.direction.value) || Number(refs.direction.value) < 0 || Number(refs.direction.value) > 360) {
        return "航点方向应为 0 到 360 之间的数字";
    }
    if (!isNumber(refs.height.value) || Number(refs.height.value) <= 0) {
        return "航线高度应为大于 0 的数字";
    }
    return "";
}

function renderDrafts() {
    if (drafts.length === 0) {
        refs.draftList.innerHTML = "<li>暂无航线草稿</li>";
        return;
    }

    refs.draftList.innerHTML = drafts.map((item, index) => {
        return `<li>${index + 1}. ${escapeHtml(item.name)} | 点数: ${item.pointCount} | 高度: ${escapeHtml(item.height)}m | 起点: (${escapeHtml(item.lng)}, ${escapeHtml(item.lat)})</li>`;
    }).join("");
}

function resetForm() {
    refs.routeName.value = "";
    refs.lng.value = "";
    refs.lat.value = "";
    refs.distance.value = "";
    refs.pointCount.value = "";
    refs.direction.value = "";
    refs.height.value = "";
    showTip("", false);
    showMissionTip("", false);
}

function beginMapDrag(event) {
    if (event.button !== 0) {
        return;
    }

    state.dragging = true;
    state.dragPointerId = event.pointerId;
    state.dragStartX = event.clientX;
    state.dragStartY = event.clientY;
    state.dragStartPanX = state.mapPanX;
    state.dragStartPanY = state.mapPanY;
    state.dragMoved = false;
    refs.mapCanvas.classList.add("dragging");

    if (refs.mapCanvas.setPointerCapture) {
        refs.mapCanvas.setPointerCapture(event.pointerId);
    }
}

function updateMapDrag(event) {
    if (!state.dragging || event.pointerId !== state.dragPointerId) {
        return;
    }

    const deltaX = event.clientX - state.dragStartX;
    const deltaY = event.clientY - state.dragStartY;
    if (!state.dragMoved && Math.hypot(deltaX, deltaY) >= DRAG_THRESHOLD_PX) {
        state.dragMoved = true;
    }

    if (!state.dragMoved) {
        return;
    }

    event.preventDefault();
    setMapPan(state.dragStartPanX + deltaX, state.dragStartPanY + deltaY, true);
}

function endMapDrag(event) {
    if (!state.dragging) {
        return;
    }
    if (event && state.dragPointerId !== null && event.pointerId !== state.dragPointerId) {
        return;
    }

    const moved = state.dragMoved;
    state.dragging = false;
    state.dragMoved = false;
    state.dragPointerId = null;
    refs.mapCanvas.classList.remove("dragging");
    if (moved) {
        state.suppressNextClick = true;
    }
}

refs.backToTask.addEventListener("click", () => {
    window.location.href = "../task-center/index.html";
});

refs.areaConfirm.addEventListener("click", () => {
    if ([refs.province.value, refs.city.value, refs.district.value].some((value) => ["省", "市", "区/县"].includes(value))) {
        showTip("请完整选择省市区后再确认", true);
        return;
    }
    showTip(`区域已切换为：${refs.province.value}-${refs.city.value}-${refs.district.value}`, false);
});

refs.mapCanvas.addEventListener("pointerdown", beginMapDrag);
refs.mapCanvas.addEventListener("pointermove", updateMapDrag);
refs.mapCanvas.addEventListener("pointerup", endMapDrag);
refs.mapCanvas.addEventListener("pointercancel", endMapDrag);
refs.mapCanvas.addEventListener("lostpointercapture", endMapDrag);
refs.mapCanvas.addEventListener("click", (event) => {
    addWaypointFromEvent(event);
});

refs.setAnchorA.addEventListener("click", () => {
    state.pendingCalibrationAnchor = "A";
    showMissionTip("请在地图上点击一次，记录标定点 A", false);
});

refs.setAnchorB.addEventListener("click", () => {
    state.pendingCalibrationAnchor = "B";
    showMissionTip("请在地图上点击一次，记录标定点 B", false);
});

refs.clearCalibration.addEventListener("click", () => {
    state.calibrationAnchorA = null;
    state.calibrationAnchorB = null;
    state.pendingCalibrationAnchor = "";
    refs.anchorAX.value = "";
    refs.anchorAY.value = "";
    refs.anchorBX.value = "";
    refs.anchorBY.value = "";
    updateCalibrationTips();
    saveSettings();
    renderWaypoints();
    showMissionTip("标定已清空", false);
});

refs.mapImageUrl.addEventListener("input", () => {
    persistAndRefreshBackground();
});
refs.mapImageUrl.addEventListener("change", () => {
    persistAndRefreshBackground();
});

[refs.defaultAltitude, refs.invertX, refs.invertY, refs.anchorAX, refs.anchorAY, refs.anchorBX, refs.anchorBY].forEach((element) => {
    element.addEventListener("input", () => {
        saveSettings();
        renderWaypoints();
    });
    element.addEventListener("change", () => {
        saveSettings();
        renderWaypoints();
    });
});

function syncCalibrationStateFromInputs() {
    const worldAX = Number(refs.anchorAX.value);
    const worldAY = Number(refs.anchorAY.value);
    const worldBX = Number(refs.anchorBX.value);
    const worldBY = Number(refs.anchorBY.value);

    state.calibrationAnchorA = Number.isNaN(worldAX) || Number.isNaN(worldAY) ? state.calibrationAnchorA : {
        ...(state.calibrationAnchorA || { u: 0.25, v: 0.25 }),
        worldX: worldAX,
        worldY: worldAY
    };
    state.calibrationAnchorB = Number.isNaN(worldBX) || Number.isNaN(worldBY) ? state.calibrationAnchorB : {
        ...(state.calibrationAnchorB || { u: 0.75, v: 0.75 }),
        worldX: worldBX,
        worldY: worldBY
    };
    updateCalibrationTips();
}

[refs.anchorAX, refs.anchorAY, refs.anchorBX, refs.anchorBY].forEach((element) => {
    element.addEventListener("change", () => {
        syncCalibrationStateFromInputs();
        saveSettings();
        renderWaypoints();
    });
});

async function loadDrafts() {
    const response = await fetch(`${API_BASE}/api/routes?limit=50`);
    const data = await response.json();
    if (!response.ok) {
        throw new Error(data.detail || "草稿加载失败");
    }
    drafts.length = 0;
    (data.items || []).forEach((item) => drafts.push(item));
    renderDrafts();
}

refs.saveRoute.addEventListener("click", async () => {
    const err = validateForm();
    if (err) {
        showTip(err, true);
        return;
    }

    if (state.waypoints.length > 0) {
        refs.pointCount.value = String(state.waypoints.length);
    }

    if ([refs.province.value, refs.city.value, refs.district.value].some((value) => ["省", "市", "区/县"].includes(value))) {
        showTip("请先选择有效区域", true);
        return;
    }

    const payload = {
        name: refs.routeName.value.trim(),
        province: refs.province.value,
        city: refs.city.value,
        district: refs.district.value,
        lng: refs.lng.value.trim(),
        lat: refs.lat.value.trim(),
        distance: refs.distance.value.trim(),
        pointCount: Number(refs.pointCount.value),
        direction: refs.direction.value.trim(),
        height: refs.height.value.trim()
    };

    refs.saveRoute.disabled = true;
    showTip("正在保存航线...", false);
    try {
        const response = await fetch(`${API_BASE}/api/routes`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(payload)
        });
        const data = await response.json();
        if (!response.ok) {
            throw new Error(data.detail || "保存失败");
        }

        state.currentRouteDraftId = data.id;
        await loadDrafts();
        showTip("航线草稿已保存到数据库", false);
    } catch (error) {
        showTip(error.message || "保存失败", true);
    } finally {
        refs.saveRoute.disabled = false;
    }
});

refs.publishMission.addEventListener("click", async () => {
    showMissionTip("正在下发航线...", false);
    try {
        const payload = buildMissionPayload(state.currentRouteDraftId);
        saveSettings();
        const response = await fetch(`${API_BASE}/api/route-missions`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(payload)
        });
        const data = await response.json();
        if (!response.ok) {
            throw new Error(data.detail || data.message || "下发失败");
        }

        showMissionTip("航线已下发到执行器，桥接脚本会自动读取最新 mission", false);
    } catch (error) {
        showMissionTip(error.message || "下发失败", true);
    }
});

refs.cancelRoute.addEventListener("click", resetForm);

refs.clearWaypoints.addEventListener("click", () => {
    state.waypoints = [];
    renderWaypoints();
    showMissionTip("航点已清空", false);
});

refs.tools.forEach(button => {
    button.addEventListener("click", () => {
        state.activeTool = button.dataset.tool;
        refs.tools.forEach(item => item.classList.remove("active"));
        button.classList.add("active");
        updateMapCanvasModeClass();
    });
});

applySettings();
syncCalibrationStateFromInputs();
persistAndRefreshBackground();
updateMapCanvasModeClass();
keepMapPanInBounds();
renderWaypoints();
refs.mapImage.addEventListener("load", () => {
    keepMapPanInBounds();
    renderWaypoints();
});
if (refs.mapImage.complete) {
    keepMapPanInBounds();
    renderWaypoints();
}
window.addEventListener("resize", () => {
    keepMapPanInBounds();
    renderWaypoints();
});
loadDrafts().catch((error) => {
    showTip(error.message || "草稿初始化失败", true);
});

initUserPanel();
