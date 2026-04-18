const API_BASE = "http://127.0.0.1:8000";
const DEFAULT_MAP_CENTER = [23.1291, 113.2644];
const DEFAULT_MAP_ZOOM = 13.2;
const DEFAULT_ALTITUDE = 25;
const METERS_PER_DEG_LAT = 111320;

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
    defaultAltitude: document.getElementById("defaultAltitude"),
    routeProfile: document.getElementById("routeProfile"),
    gridScale: document.getElementById("gridScale"),
    gridScaleValue: document.getElementById("gridScaleValue"),
    fitRoute: document.getElementById("fitRoute"),
    saveRoute: document.getElementById("saveRoute"),
    publishMission: document.getElementById("publishMission"),
    cancelRoute: document.getElementById("cancelRoute"),
    clearWaypoints: document.getElementById("clearWaypoints"),
    formTip: document.getElementById("formTip"),
    missionTip: document.getElementById("missionTip"),
    navSummary: document.getElementById("navSummary"),
    draftList: document.getElementById("draftList"),
    waypointList: document.getElementById("waypointList"),
    mapCanvas: document.getElementById("mapCanvas"),
    realMap: document.getElementById("realMap"),
    mapStatus: document.getElementById("mapStatus"),
    tools: document.querySelectorAll(".tool-btn")
};

const state = {
    map: null,
    gridLayer: null,
    baseTileLayer: null,
    fallbackTileEnabled: false,
    tileErrorCount: 0,
    routeControl: null,
    fallbackRouteLine: null,
    markers: [],
    waypoints: [],
    activeTool: "point",
    routeProfile: "driving",
    gridScale: 1,
    currentRouteDraftId: null
};

const drafts = [];
const AREA_CENTER_MAP = {
    "河北省-石家庄市-长安区": [38.04895, 114.54589],
    "广东省-广州市-越秀区": [23.13171, 113.26627]
};

function escapeHtml(value) {
    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}

function setTip(el, message, isError = true) {
    if (!el) {
        return;
    }
    el.style.color = isError ? "#ef4444" : "#16a34a";
    el.textContent = message;
}

function showTip(message, isError = true) {
    setTip(refs.formTip, message, isError);
}

function showMissionTip(message, isError = true) {
    setTip(refs.missionTip, message, isError);
}

function showNavSummary(message, isError = false) {
    setTip(refs.navSummary, message, isError);
}

function isNumber(value) {
    return value !== "" && !Number.isNaN(Number(value));
}

function formatDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) {
        return "0 min";
    }
    const minutes = Math.round(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    if (hours > 0) {
        return `${hours}h ${mins}m`;
    }
    return `${Math.max(mins, 1)}m`;
}

function estimateProfileSpeed(profile) {
    if (profile === "walking") {
        return 1.35;
    }
    if (profile === "cycling") {
        return 5.6;
    }
    return 13.9;
}

function haversineMeters(a, b) {
    const toRad = (deg) => (deg * Math.PI) / 180;
    const earthRadius = 6378137;
    const lat1 = toRad(a.lat);
    const lat2 = toRad(b.lat);
    const dLat = lat2 - lat1;
    const dLng = toRad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return 2 * earthRadius * Math.asin(Math.min(1, Math.sqrt(h)));
}

function initUserPanel() {
    const raw = localStorage.getItem("uav_user");
    if (!raw) {
        window.location.href = "../login/login.html";
        return;
    }

    try {
        const user = JSON.parse(raw);
        const displayName = user.displayName || user.username || "admin";
        if (refs.userPanel) {
            refs.userPanel.textContent = `管理员：${displayName}`;
        }
    } catch (error) {
        localStorage.removeItem("uav_user");
        window.location.href = "../login/login.html";
    }
}

function updateMapStatus() {
    if (!refs.mapStatus) {
        return;
    }
    if (!state.map) {
        refs.mapStatus.textContent = "Map initializing...";
        return;
    }

    const center = state.map.getCenter();
    const modeLabel = state.activeTool === "point" ? "point" : state.activeTool === "line" ? "line" : "area";
    refs.mapStatus.textContent =
        `zoom ${state.map.getZoom().toFixed(2)} | grid ${state.gridScale.toFixed(1)}x\n` +
        `waypoints ${state.waypoints.length} | mode ${modeLabel} | nav ${state.routeProfile}\n` +
        `center ${center.lat.toFixed(4)}, ${center.lng.toFixed(4)}`;
}

function buildGridLayer(scale = 1) {
    const tileSize = Math.max(64, Math.min(512, Math.round(96 * scale)));
    const layer = L.gridLayer({
        pane: "overlayPane",
        tileSize,
        opacity: 0.42
    });

    layer.createTile = (coords) => {
        const tile = document.createElement("canvas");
        const size = layer.getTileSize();
        tile.width = size.x;
        tile.height = size.y;
        const ctx = tile.getContext("2d");
        if (!ctx) {
            return tile;
        }

        const majorColor = "rgba(56, 189, 248, 0.34)";
        const minorColor = "rgba(56, 189, 248, 0.16)";
        const step = Math.max(16, Math.round(size.x / 4));

        ctx.lineWidth = 1;
        ctx.strokeStyle = minorColor;
        for (let x = 0; x <= size.x; x += step) {
            ctx.beginPath();
            ctx.moveTo(x + 0.5, 0);
            ctx.lineTo(x + 0.5, size.y);
            ctx.stroke();
        }
        for (let y = 0; y <= size.y; y += step) {
            ctx.beginPath();
            ctx.moveTo(0, y + 0.5);
            ctx.lineTo(size.x, y + 0.5);
            ctx.stroke();
        }

        ctx.strokeStyle = majorColor;
        ctx.strokeRect(0.5, 0.5, size.x - 1, size.y - 1);
        ctx.beginPath();
        ctx.moveTo(size.x / 2, 0);
        ctx.lineTo(size.x / 2, size.y);
        ctx.moveTo(0, size.y / 2);
        ctx.lineTo(size.x, size.y / 2);
        ctx.stroke();

        ctx.fillStyle = "rgba(226, 232, 240, 0.9)";
        ctx.font = "11px sans-serif";
        ctx.fillText(`z${coords.z}`, 7, 14);
        return tile;
    };

    return layer;
}

function rebuildGridLayer() {
    if (!state.map) {
        return;
    }
    if (state.gridLayer) {
        state.gridLayer.remove();
    }
    state.gridLayer = buildGridLayer(state.gridScale);
    state.gridLayer.addTo(state.map);
}

function createPrimaryTileLayer() {
    return L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxNativeZoom: 19,
        maxZoom: 22,
        attribution: "&copy; OpenStreetMap contributors",
        referrerPolicy: "origin-when-cross-origin"
    });
}

function createFallbackTileLayer() {
    return L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
        maxNativeZoom: 20,
        maxZoom: 22,
        subdomains: "abcd",
        attribution: "&copy; OpenStreetMap contributors &copy; CARTO"
    });
}

function switchToFallbackTileLayer() {
    if (!state.map || state.fallbackTileEnabled) {
        return;
    }
    state.fallbackTileEnabled = true;
    if (state.baseTileLayer) {
        state.baseTileLayer.remove();
    }
    state.baseTileLayer = createFallbackTileLayer();
    state.baseTileLayer.addTo(state.map);
    showMissionTip("OSM blocked. Switched to fallback basemap.", true);
}

function setMapModeClass() {
    if (refs.mapCanvas) {
        refs.mapCanvas.classList.toggle("mode-point", state.activeTool === "point");
    }
    updateMapStatus();
}

function clearMarkersAndRoutes() {
    state.markers.forEach((marker) => marker.remove());
    state.markers = [];

    if (state.routeControl) {
        state.routeControl.remove();
        state.routeControl = null;
    }
    if (state.fallbackRouteLine) {
        state.fallbackRouteLine.remove();
        state.fallbackRouteLine = null;
    }
}

function drawFallbackPolyline(latLngs) {
    if (!state.map) {
        return;
    }
    if (state.fallbackRouteLine) {
        state.fallbackRouteLine.remove();
    }
    state.fallbackRouteLine = L.polyline(latLngs, {
        color: "#f59e0b",
        weight: 5,
        opacity: 0.95
    }).addTo(state.map);

    let distance = 0;
    for (let i = 1; i < state.waypoints.length; i += 1) {
        distance += haversineMeters(state.waypoints[i - 1], state.waypoints[i]);
    }
    const eta = distance / estimateProfileSpeed(state.routeProfile);
    showNavSummary(`line estimate: ${(distance / 1000).toFixed(2)} km / ${formatDuration(eta)}`, true);
}

function refreshNavigationRoute() {
    if (!state.map) {
        return;
    }
    if (state.routeControl) {
        state.routeControl.remove();
        state.routeControl = null;
    }
    if (state.fallbackRouteLine) {
        state.fallbackRouteLine.remove();
        state.fallbackRouteLine = null;
    }

    if (state.waypoints.length < 2) {
        showNavSummary("");
        return;
    }

    const latLngs = state.waypoints.map((item) => L.latLng(item.lat, item.lng));
    const canUseRouting = Boolean(L.Routing && typeof L.Routing.control === "function");
    if (!canUseRouting) {
        drawFallbackPolyline(latLngs);
        return;
    }

    state.routeControl = L.Routing.control({
        waypoints: latLngs,
        addWaypoints: false,
        draggableWaypoints: false,
        fitSelectedRoutes: false,
        show: false,
        routeWhileDragging: false,
        createMarker: () => null,
        lineOptions: {
            styles: [{ color: "#f59e0b", weight: 5, opacity: 0.95 }]
        },
        router: L.Routing.osrmv1({
            serviceUrl: `https://router.project-osrm.org/route/v1/${state.routeProfile}`
        })
    }).addTo(state.map);

    state.routeControl.on("routesfound", (event) => {
        const route = event.routes && event.routes[0];
        if (!route || !route.summary) {
            return;
        }
        const km = route.summary.totalDistance / 1000;
        showNavSummary(`road route: ${km.toFixed(2)} km / ${formatDuration(route.summary.totalTime)}`, false);
    });

    state.routeControl.on("routingerror", () => {
        drawFallbackPolyline(latLngs);
        showMissionTip("Routing service error, switched to polyline.", true);
    });
}

function syncStartFromWaypoints() {
    if (state.waypoints.length === 0) {
        return;
    }
    const first = state.waypoints[0];
    refs.lng.value = first.lng.toFixed(6);
    refs.lat.value = first.lat.toFixed(6);
}

function renderWaypoints() {
    refs.pointCount.value = String(state.waypoints.length);

    if (state.waypoints.length === 0) {
        refs.waypointList.innerHTML = '<li class="waypoint-empty">No waypoints</li>';
        clearMarkersAndRoutes();
        showNavSummary("");
        updateMapStatus();
        return;
    }

    clearMarkersAndRoutes();
    state.waypoints.forEach((item, index) => {
        const marker = L.circleMarker([item.lat, item.lng], {
            radius: 8,
            color: "#f59e0b",
            weight: 2,
            fillColor: "#ffffff",
            fillOpacity: 0.95
        }).addTo(state.map);

        marker.bindTooltip(String(index + 1), {
            permanent: true,
            direction: "center",
            className: "route-waypoint-index"
        });
        state.markers.push(marker);
    });

    refreshNavigationRoute();
    refs.waypointList.innerHTML = state.waypoints.map((item, index) => `
        <li class="waypoint-item">
            <span class="waypoint-badge">${index + 1}</span>
            <span class="waypoint-text">
                lat: ${item.lat.toFixed(6)}<br>
                lng: ${item.lng.toFixed(6)}
            </span>
            <button class="waypoint-remove" type="button" data-index="${index}">Remove</button>
        </li>
    `).join("");

    refs.waypointList.querySelectorAll(".waypoint-remove").forEach((btn) => {
        btn.addEventListener("click", () => removeWaypoint(Number(btn.dataset.index)));
    });

    syncStartFromWaypoints();
    updateMapStatus();
}

function addWaypoint(lat, lng, shouldPan = false) {
    state.waypoints.push({ lat, lng });
    renderWaypoints();
    if (shouldPan && state.map) {
        state.map.panTo([lat, lng], { animate: true, duration: 0.25 });
    }
    showMissionTip(`Added waypoint ${state.waypoints.length}: ${lat.toFixed(6)}, ${lng.toFixed(6)}`, false);
}

function removeWaypoint(index) {
    if (index < 0 || index >= state.waypoints.length) {
        return;
    }
    state.waypoints.splice(index, 1);
    renderWaypoints();
    showMissionTip("Waypoint removed", false);
}

function fitRouteToView() {
    if (!state.map) {
        return;
    }
    if (state.waypoints.length === 0) {
        showMissionTip("No waypoints to fit", true);
        return;
    }
    if (state.waypoints.length === 1) {
        const p = state.waypoints[0];
        state.map.setView([p.lat, p.lng], Math.max(15, state.map.getZoom()), { animate: true });
        return;
    }
    const bounds = L.latLngBounds(state.waypoints.map((item) => [item.lat, item.lng]));
    state.map.fitBounds(bounds.pad(0.2), { animate: true });
}

function initMap() {
    if (typeof L === "undefined") {
        showMissionTip("Map library failed to load.", true);
        return;
    }

    state.map = L.map(refs.realMap, {
        zoomSnap: 0,
        zoomDelta: 0.1,
        minZoom: 2,
        maxZoom: 22,
        wheelPxPerZoomLevel: 100,
        scrollWheelZoom: true,
        touchZoom: true,
        boxZoom: true,
        inertia: true
    }).setView(DEFAULT_MAP_CENTER, DEFAULT_MAP_ZOOM);

    state.baseTileLayer = createPrimaryTileLayer();
    state.baseTileLayer.addTo(state.map);
    state.baseTileLayer.on("tileerror", () => {
        state.tileErrorCount += 1;
        if (state.tileErrorCount >= 2) {
            switchToFallbackTileLayer();
        }
    });

    if (window.location.protocol === "file:") {
        showMissionTip("Please open via http://127.0.0.1:8000 (not file://) to avoid tile blocking.", true);
    }

    rebuildGridLayer();
    L.control.scale({ imperial: false }).addTo(state.map);

    state.map.on("click", (event) => {
        if (state.activeTool !== "point") {
            showMissionTip("Switch to point mode before adding waypoints.", true);
            return;
        }
        addWaypoint(event.latlng.lat, event.latlng.lng, true);
    });

    state.map.on("zoom moveend", updateMapStatus);
    setMapModeClass();
    updateMapStatus();
    if (window.location.protocol !== "file:") {
        showMissionTip("Real map ready. Drag, zoom and click to add waypoints.", false);
    }
}

function validateForm() {
    if (!refs.routeName.value.trim()) {
        return "Route name is required.";
    }
    if (!isNumber(refs.lng.value) || Number(refs.lng.value) < -180 || Number(refs.lng.value) > 180) {
        return "Start longitude must be in [-180, 180].";
    }
    if (!isNumber(refs.lat.value) || Number(refs.lat.value) < -90 || Number(refs.lat.value) > 90) {
        return "Start latitude must be in [-90, 90].";
    }
    if (!isNumber(refs.distance.value) || Number(refs.distance.value) <= 0) {
        return "Distance must be greater than 0.";
    }
    if (!isNumber(refs.direction.value) || Number(refs.direction.value) < 0 || Number(refs.direction.value) > 360) {
        return "Direction must be in [0, 360].";
    }
    if (!isNumber(refs.height.value) || Number(refs.height.value) <= 0) {
        return "Height must be greater than 0.";
    }
    if (!isNumber(refs.defaultAltitude.value) || Number(refs.defaultAltitude.value) <= 0) {
        return "Default altitude must be greater than 0.";
    }
    if (state.waypoints.length < 2) {
        return "At least 2 waypoints are required.";
    }
    return "";
}

function buildMissionPayload(routeDraftId = null) {
    const routeName = refs.routeName.value.trim();
    if (!routeName) {
        throw new Error("Route name is empty.");
    }
    if (state.waypoints.length < 2) {
        throw new Error("At least 2 waypoints are required.");
    }

    const defaultAltitude = Number(refs.defaultAltitude.value);
    if (!Number.isFinite(defaultAltitude) || defaultAltitude <= 0) {
        throw new Error("Default altitude must be > 0.");
    }

    const lngValues = state.waypoints.map((item) => item.lng);
    const latValues = state.waypoints.map((item) => item.lat);
    const minLng = Math.min(...lngValues);
    const maxLng = Math.max(...lngValues);
    const minLat = Math.min(...latValues);
    const maxLat = Math.max(...latValues);
    const centerLng = (minLng + maxLng) / 2;
    const centerLat = (minLat + maxLat) / 2;
    const lngSpan = maxLng - minLng;
    const latSpan = maxLat - minLat;

    const widthMeters = Math.max(
        1,
        (Math.max(lngSpan, 1e-6) * METERS_PER_DEG_LAT * Math.max(0.1, Math.cos((centerLat * Math.PI) / 180)))
    );
    const heightMeters = Math.max(1, Math.max(latSpan, 1e-6) * METERS_PER_DEG_LAT);

    return {
        routeDraftId,
        routeName,
        mapImageUrl: null,
        calibration: {
            worldCenterX: Number(centerLng.toFixed(6)),
            worldCenterY: Number(centerLat.toFixed(6)),
            mapWidthMeters: Number(widthMeters.toFixed(3)),
            mapHeightMeters: Number(heightMeters.toFixed(3)),
            invertX: false,
            invertY: false,
            defaultAltitude: Number(defaultAltitude.toFixed(3))
        },
        waypoints: state.waypoints.map((item, index) => ({
            order: index + 1,
            u: lngSpan > 1e-9 ? Number(((item.lng - minLng) / lngSpan).toFixed(6)) : 0.5,
            v: latSpan > 1e-9 ? Number(((item.lat - minLat) / latSpan).toFixed(6)) : 0.5,
            worldX: Number(item.lng.toFixed(6)),
            worldY: Number(item.lat.toFixed(6)),
            worldZ: Number(defaultAltitude.toFixed(3))
        }))
    };
}

function renderDrafts() {
    if (drafts.length === 0) {
        refs.draftList.innerHTML = "<li>No route drafts</li>";
        return;
    }

    refs.draftList.innerHTML = drafts.map((item, index) => `
        <li>
            ${index + 1}. ${escapeHtml(item.name)}
            | points: ${item.pointCount}
            | height: ${escapeHtml(item.height)}m
            | start: (${escapeHtml(item.lng)}, ${escapeHtml(item.lat)})
        </li>
    `).join("");
}

async function loadDrafts() {
    const response = await fetch(`${API_BASE}/api/routes?limit=50`);
    const data = await response.json();
    if (!response.ok) {
        throw new Error(data.detail || "Failed to load drafts.");
    }
    drafts.length = 0;
    (data.items || []).forEach((item) => drafts.push(item));
    renderDrafts();
}

function resetForm() {
    refs.routeName.value = "";
    refs.lng.value = "";
    refs.lat.value = "";
    refs.distance.value = "";
    refs.pointCount.value = "";
    refs.direction.value = "";
    refs.height.value = "";
    refs.defaultAltitude.value = String(DEFAULT_ALTITUDE);
    showTip("", false);
    showMissionTip("", false);
    showNavSummary("");
}

function applyAreaSelection() {
    if (refs.province.selectedIndex <= 0 || refs.city.selectedIndex <= 0 || refs.district.selectedIndex <= 0) {
        showTip("Please select province/city/district first.", true);
        return;
    }
    const key = `${refs.province.value}-${refs.city.value}-${refs.district.value}`;
    const center = AREA_CENTER_MAP[key] || DEFAULT_MAP_CENTER;
    if (state.map) {
        state.map.setView(center, 13.5, { animate: true });
    }
    showTip(`Area switched: ${key}`, false);
}

refs.backToTask.addEventListener("click", () => {
    window.location.href = "../task-center/index.html";
});

refs.areaConfirm.addEventListener("click", applyAreaSelection);

refs.fitRoute.addEventListener("click", fitRouteToView);

refs.routeProfile.addEventListener("change", () => {
    state.routeProfile = refs.routeProfile.value || "driving";
    refreshNavigationRoute();
    updateMapStatus();
});

refs.gridScale.addEventListener("input", () => {
    const value = Number(refs.gridScale.value);
    if (!Number.isFinite(value) || value <= 0) {
        return;
    }
    state.gridScale = value;
    refs.gridScaleValue.textContent = `${value.toFixed(1)}x`;
    rebuildGridLayer();
    updateMapStatus();
});

refs.saveRoute.addEventListener("click", async () => {
    const err = validateForm();
    if (err) {
        showTip(err, true);
        return;
    }
    if (refs.province.selectedIndex <= 0 || refs.city.selectedIndex <= 0 || refs.district.selectedIndex <= 0) {
        showTip("Please select a valid area first.", true);
        return;
    }

    refs.pointCount.value = String(state.waypoints.length);
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
    showTip("Saving route draft...", false);
    try {
        const response = await fetch(`${API_BASE}/api/routes`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });
        const data = await response.json();
        if (!response.ok) {
            throw new Error(data.detail || "Save failed.");
        }

        state.currentRouteDraftId = data.id;
        await loadDrafts();
        showTip("Route draft saved.", false);
    } catch (error) {
        showTip(error.message || "Save failed.", true);
    } finally {
        refs.saveRoute.disabled = false;
    }
});

refs.publishMission.addEventListener("click", async () => {
    showMissionTip("Publishing mission...", false);
    try {
        const payload = buildMissionPayload(state.currentRouteDraftId);
        const response = await fetch(`${API_BASE}/api/route-missions`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });
        const data = await response.json();
        if (!response.ok) {
            throw new Error(data.detail || data.message || "Publish failed.");
        }
        showMissionTip("Mission published.", false);
    } catch (error) {
        showMissionTip(error.message || "Publish failed.", true);
    }
});

refs.cancelRoute.addEventListener("click", resetForm);

refs.clearWaypoints.addEventListener("click", () => {
    state.waypoints = [];
    renderWaypoints();
    showMissionTip("Waypoints cleared.", false);
});

refs.tools.forEach((button) => {
    button.addEventListener("click", () => {
        state.activeTool = button.dataset.tool;
        refs.tools.forEach((item) => item.classList.remove("active"));
        button.classList.add("active");
        setMapModeClass();
        if (state.activeTool !== "point") {
            showMissionTip("Current mode is browse-only.", false);
        }
    });
});

initUserPanel();
resetForm();
renderWaypoints();

if (refs.gridScaleValue) {
    refs.gridScaleValue.textContent = `${state.gridScale.toFixed(1)}x`;
}
if (refs.routeProfile) {
    refs.routeProfile.value = state.routeProfile;
}

initMap();
loadDrafts().catch((error) => {
    showTip(error.message || "Draft initialization failed.", true);
});
