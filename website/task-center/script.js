const API_BASE = "http://127.0.0.1:8000";

const state = {
    page: 1,
    pageSize: 6,
    total: 0,
    items: [],
    currentEditId: null
};

const refs = {
    taskName: document.getElementById("taskName"),
    taskType: document.getElementById("taskType"),
    taskCycle: document.getElementById("taskCycle"),
    taskStatus: document.getElementById("taskStatus"),
    taskTableBody: document.getElementById("taskTableBody"),
    summary: document.getElementById("summary"),
    pageText: document.getElementById("pageText"),
    prevPage: document.getElementById("prevPage"),
    nextPage: document.getElementById("nextPage"),
    searchBtn: document.getElementById("searchBtn"),
    resetBtn: document.getElementById("resetBtn"),
    createTaskBtn: document.getElementById("createTaskBtn"),
    downloadBtn: document.getElementById("downloadBtn"),
    userPanel: document.getElementById("userPanel"),
    taskModal: document.getElementById("taskModal"),
    taskModalTitle: document.getElementById("taskModalTitle"),
    taskModalClose: document.getElementById("taskModalClose"),
    taskModalCancel: document.getElementById("taskModalCancel"),
    taskModalSubmit: document.getElementById("taskModalSubmit"),
    taskFormTip: document.getElementById("taskFormTip"),
    formName: document.getElementById("formName"),
    formType: document.getElementById("formType"),
    formCycle: document.getElementById("formCycle"),
    formStatus: document.getElementById("formStatus"),
    formStartTime: document.getElementById("formStartTime"),
    formEndTime: document.getElementById("formEndTime"),
    formExecutedDone: document.getElementById("formExecutedDone"),
    formExecutedTotal: document.getElementById("formExecutedTotal"),
    formEnabled: document.getElementById("formEnabled")
};

function initUserPanel() {
    const raw = localStorage.getItem("uav_user");
    if (!raw) {
        window.location.href = "../login/login.html";
        return;
    }

    try {
        const user = JSON.parse(raw);
        const displayName = user.displayName || user.username || "未知用户";
        if (refs.userPanel) {
            refs.userPanel.textContent = `管理员：${displayName}`;
        }
    } catch (error) {
        localStorage.removeItem("uav_user");
        window.location.href = "../login/login.html";
    }
}

function getOpsByStatus(status) {
    if (status === "执行中" || status === "已完成") {
        return ["详情"];
    }
    return ["详情", "编辑", "删除"];
}

function renderTable() {
    const totalPages = Math.max(1, Math.ceil(state.total / state.pageSize));

    refs.taskTableBody.innerHTML = state.items.map(task => {
        const ops = getOpsByStatus(task.status).map(op => `<span class="action-link" data-op="${op}" data-id="${task.id}">${op}</span>`).join("");
        return `
            <tr>
                <td>${task.id}</td>
                <td>${task.name}</td>
                <td>${task.type}</td>
                <td>${task.cycle}</td>
                <td>${task.status}</td>
                <td>${task.startTime}</td>
                <td>${task.endTime}</td>
                <td>${task.executed}</td>
                <td>
                    <span class="switch">
                        <button class="${task.enabled ? "on" : "off"}" data-toggle-id="${task.id}">${task.enabled ? "开启" : "禁用"}</button>
                    </span>
                </td>
                <td><div class="actions">${ops}</div></td>
            </tr>
        `;
    }).join("");

    refs.summary.textContent = `共 ${state.total} 条任务`;
    refs.pageText.textContent = `${state.page} / ${totalPages}`;
    refs.prevPage.disabled = state.page <= 1;
    refs.nextPage.disabled = state.page >= totalPages;
}

async function fetchTasks() {
    const params = new URLSearchParams({
        name: refs.taskName.value.trim(),
        type: refs.taskType.value,
        cycle: refs.taskCycle.value,
        status: refs.taskStatus.value,
        page: String(state.page),
        page_size: String(state.pageSize)
    });

    const response = await fetch(`${API_BASE}/api/tasks?${params.toString()}`);
    const data = await response.json();
    if (!response.ok) {
        throw new Error(data.detail || "任务列表加载失败");
    }

    state.total = data.total || 0;
    state.items = data.items || [];
    renderTable();
}

async function applyFilter() {
    state.page = 1;
    await fetchTasks();
}

async function resetFilter() {
    refs.taskName.value = "";
    refs.taskType.value = "all";
    refs.taskCycle.value = "all";
    refs.taskStatus.value = "all";
    state.page = 1;
    await fetchTasks();
}

function parseExecution(task) {
    const done = task.executedDone ?? Number((task.executed || "0/1").split("/")[0] || 0);
    const total = task.executedTotal ?? Number((task.executed || "0/1").split("/")[1] || 1);
    return { done, total };
}

function setFormTip(message, isError = true) {
    refs.taskFormTip.textContent = message;
    refs.taskFormTip.style.color = isError ? "#dc2626" : "#16a34a";
}

function resetTaskForm() {
    refs.formName.value = "";
    refs.formType.value = "周期性任务";
    refs.formCycle.value = "每天";
    refs.formStatus.value = "待执行";
    refs.formStartTime.value = "";
    refs.formEndTime.value = "";
    refs.formExecutedDone.value = "0";
    refs.formExecutedTotal.value = "1";
    refs.formEnabled.value = "true";
    setFormTip("", false);
}

function openTaskModal(task = null) {
    state.currentEditId = task ? task.id : null;
    refs.taskModalTitle.textContent = task ? "编辑任务" : "新增任务";
    refs.taskModalSubmit.textContent = task ? "保存修改" : "创建任务";

    resetTaskForm();
    if (task) {
        const execution = parseExecution(task);
        refs.formName.value = task.name || "";
        refs.formType.value = task.type || "周期性任务";
        refs.formCycle.value = task.cycle || "每天";
        refs.formStatus.value = task.status || "待执行";
        refs.formStartTime.value = task.startTime || "";
        refs.formEndTime.value = task.endTime || "";
        refs.formExecutedDone.value = String(execution.done);
        refs.formExecutedTotal.value = String(execution.total);
        refs.formEnabled.value = task.enabled ? "true" : "false";
    }

    refs.taskModal.classList.remove("hidden");
}

function closeTaskModal() {
    refs.taskModal.classList.add("hidden");
    state.currentEditId = null;
}

function collectTaskPayloadFromModal() {
    const payload = {
        name: refs.formName.value.trim(),
        type: refs.formType.value,
        cycle: refs.formCycle.value,
        status: refs.formStatus.value,
        startTime: refs.formStartTime.value.trim(),
        endTime: refs.formEndTime.value.trim(),
        executedDone: Number(refs.formExecutedDone.value),
        executedTotal: Number(refs.formExecutedTotal.value),
        enabled: refs.formEnabled.value === "true"
    };

    if (!payload.name) {
        return { error: "请填写任务名称" };
    }
    if (!payload.startTime || !payload.endTime) {
        return { error: "请填写开始时间和结束时间" };
    }
    if (Number.isNaN(payload.executedDone) || Number.isNaN(payload.executedTotal)) {
        return { error: "执行次数请输入数字" };
    }
    if (payload.executedDone < 0 || payload.executedTotal < 1) {
        return { error: "执行次数不合法" };
    }
    if (payload.executedDone > payload.executedTotal) {
        return { error: "已执行次数不能大于总执行次数" };
    }

    return { payload };
}

async function submitTaskModal() {
    const { payload, error } = collectTaskPayloadFromModal();
    if (error) {
        setFormTip(error, true);
        return;
    }

    refs.taskModalSubmit.disabled = true;
    setFormTip(state.currentEditId ? "正在保存..." : "正在创建...", false);
    try {
        if (state.currentEditId) {
            const response = await fetch(`${API_BASE}/api/tasks/${state.currentEditId}`, {
                method: "PUT",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(payload)
            });
            const data = await response.json();
            if (!response.ok) {
                throw new Error(data.detail || "更新失败");
            }
        } else {
            const response = await fetch(`${API_BASE}/api/tasks`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(payload)
            });
            const data = await response.json();
            if (!response.ok) {
                throw new Error(data.detail || "新增失败");
            }
        }

        closeTaskModal();
        await fetchTasks();
    } catch (requestError) {
        setFormTip(requestError.message || "保存失败", true);
    } finally {
        refs.taskModalSubmit.disabled = false;
    }
}

async function deleteTask(id) {
    const response = await fetch(`${API_BASE}/api/tasks/${id}`, {
        method: "DELETE"
    });
    const data = await response.json();
    if (!response.ok) {
        throw new Error(data.detail || "删除失败");
    }
    await fetchTasks();
}

async function toggleTask(id) {
    const response = await fetch(`${API_BASE}/api/tasks/${id}/toggle`, {
        method: "PATCH"
    });
    const data = await response.json();
    if (!response.ok) {
        throw new Error(data.detail || "状态更新失败");
    }
    await fetchTasks();
}

async function exportTasks() {
    const params = new URLSearchParams({
        name: refs.taskName.value.trim(),
        type: refs.taskType.value,
        cycle: refs.taskCycle.value,
        status: refs.taskStatus.value,
        page: "1",
        page_size: "500"
    });
    const response = await fetch(`${API_BASE}/api/tasks?${params.toString()}`);
    const data = await response.json();
    if (!response.ok) {
        throw new Error(data.detail || "导出失败");
    }

    const header = ["ID", "任务名称", "任务类型", "执行周期", "任务状态", "开始时间", "结束时间", "累计执行", "启用"];
    const lines = [header.join(",")];
    (data.items || []).forEach((item) => {
        const row = [
            item.id,
            item.name,
            item.type,
            item.cycle,
            item.status,
            item.startTime,
            item.endTime,
            item.executed,
            item.enabled ? "是" : "否"
        ];
        lines.push(row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(","));
    });

    const blob = new Blob([`\uFEFF${lines.join("\n")}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `tasks_${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
}

refs.searchBtn.addEventListener("click", () => {
    applyFilter().catch((error) => alert(error.message || "查询失败"));
});
refs.resetBtn.addEventListener("click", () => {
    resetFilter().catch((error) => alert(error.message || "重置失败"));
});
refs.createTaskBtn.addEventListener("click", () => {
    openTaskModal();
});
refs.downloadBtn.addEventListener("click", () => {
    exportTasks().catch((error) => alert(error.message || "导出失败"));
});
refs.taskModalClose.addEventListener("click", closeTaskModal);
refs.taskModalCancel.addEventListener("click", closeTaskModal);
refs.taskModalSubmit.addEventListener("click", () => {
    submitTaskModal().catch((error) => {
        setFormTip(error.message || "保存失败", true);
    });
});
refs.taskModal.addEventListener("click", (event) => {
    if (event.target === refs.taskModal) {
        closeTaskModal();
    }
});

refs.prevPage.addEventListener("click", () => {
    if (state.page > 1) {
        state.page -= 1;
        fetchTasks().catch((error) => alert(error.message || "翻页失败"));
    }
});

refs.nextPage.addEventListener("click", () => {
    const totalPages = Math.max(1, Math.ceil(state.total / state.pageSize));
    if (state.page < totalPages) {
        state.page += 1;
        fetchTasks().catch((error) => alert(error.message || "翻页失败"));
    }
});

refs.taskTableBody.addEventListener("click", (event) => {
    const target = event.target;

    if (!(target instanceof HTMLElement)) {
        return;
    }

    const toggleId = target.getAttribute("data-toggle-id");
    if (toggleId) {
        toggleTask(Number(toggleId)).catch((error) => alert(error.message || "切换失败"));
        return;
    }

    const op = target.getAttribute("data-op");
    const id = Number(target.getAttribute("data-id"));
    if (op && id) {
        const task = state.items.find(item => item.id === id);
        if (task) {
            if (op === "详情") {
                alert(`任务名称：${task.name}\n任务类型：${task.type}\n执行周期：${task.cycle}\n任务状态：${task.status}\n开始时间：${task.startTime}\n结束时间：${task.endTime}\n累计执行：${task.executed}`);
            }
            if (op === "编辑") {
                openTaskModal(task);
            }
            if (op === "删除") {
                if (confirm(`确认删除任务【${task.name}】吗？`)) {
                    deleteTask(task.id).catch((error) => alert(error.message || "删除失败"));
                }
            }
        }
    }
});

fetchTasks().catch((error) => {
    alert(error.message || "任务初始化失败，请检查后端服务");
});

initUserPanel();
