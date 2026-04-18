const API_BASE = "http://127.0.0.1:8000";

const refs = {
    username: document.getElementById("username"),
    password: document.getElementById("password"),
    loginBtn: document.getElementById("login_btn"),
    loginTip: document.getElementById("login_tip"),
    openRegisterBtn: document.getElementById("open_register_btn"),
    registerModal: document.getElementById("register_modal"),
    registerDisplayName: document.getElementById("register_display_name"),
    registerUsername: document.getElementById("register_username"),
    registerPassword: document.getElementById("register_password"),
    registerConfirmPassword: document.getElementById("register_confirm_password"),
    registerTip: document.getElementById("register_tip"),
    registerBtn: document.getElementById("register_btn"),
    closeRegisterBtn: document.getElementById("close_register_btn")
};

function setTip(message, isError = true) {
    refs.loginTip.textContent = message;
    refs.loginTip.style.color = isError ? "#ef4444" : "#16a34a";
}

function setRegisterTip(message, isError = true) {
    refs.registerTip.textContent = message;
    refs.registerTip.style.color = isError ? "#fca5a5" : "#86efac";
}

function openRegisterModal() {
    refs.registerModal.classList.remove("hidden");
    setRegisterTip("", false);
}

function closeRegisterModal() {
    refs.registerModal.classList.add("hidden");
    refs.registerDisplayName.value = "";
    refs.registerUsername.value = "";
    refs.registerPassword.value = "";
    refs.registerConfirmPassword.value = "";
    setRegisterTip("", false);
}

async function doLogin() {
    const username = refs.username.value.trim();
    const password = refs.password.value;

    if (!username || !password) {
        setTip("请输入用户名和密码");
        return;
    }

    refs.loginBtn.disabled = true;
    setTip("正在登录...", false);

    try {
        const response = await fetch(`${API_BASE}/api/login`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ username, password })
        });

        const data = await response.json();
        if (!response.ok) {
            throw new Error(data.detail || "登录失败");
        }

        localStorage.setItem("uav_user", JSON.stringify(data.user));
        setTip("登录成功，正在跳转...", false);
        window.location.href = "../task-center/index.html";
    } catch (error) {
        setTip(error.message || "登录失败");
    } finally {
        refs.loginBtn.disabled = false;
    }
}

refs.loginBtn.addEventListener("click", doLogin);

refs.password.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
        doLogin();
    }
});

async function doRegister() {
    const displayName = refs.registerDisplayName.value.trim();
    const username = refs.registerUsername.value.trim();
    const password = refs.registerPassword.value;
    const confirmPassword = refs.registerConfirmPassword.value;

    if (!displayName || !username || !password || !confirmPassword) {
        setRegisterTip("请完整填写注册信息");
        return;
    }
    if (username.length < 3) {
        setRegisterTip("用户名至少 3 位");
        return;
    }
    if (password.length < 6) {
        setRegisterTip("密码至少 6 位");
        return;
    }
    if (password !== confirmPassword) {
        setRegisterTip("两次密码不一致");
        return;
    }

    refs.registerBtn.disabled = true;
    setRegisterTip("正在注册...", false);
    try {
        const response = await fetch(`${API_BASE}/api/register`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ displayName, username, password })
        });
        const data = await response.json();
        if (!response.ok) {
            throw new Error(data.detail || "注册失败");
        }

        refs.username.value = username;
        refs.password.value = "";
        setTip("注册成功，请登录", false);
        closeRegisterModal();
    } catch (error) {
        setRegisterTip(error.message || "注册失败");
    } finally {
        refs.registerBtn.disabled = false;
    }
}

refs.openRegisterBtn.addEventListener("click", openRegisterModal);
refs.closeRegisterBtn.addEventListener("click", closeRegisterModal);
refs.registerBtn.addEventListener("click", doRegister);
refs.registerModal.addEventListener("click", (event) => {
    if (event.target === refs.registerModal) {
        closeRegisterModal();
    }
});