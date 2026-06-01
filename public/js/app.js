const loadingForms = document.querySelectorAll("[data-loading-form]");

loadingForms.forEach((form) => {
  form.addEventListener("submit", () => {
    const button = form.querySelector("button[type='submit']");
    if (!button) return;

    button.classList.add("is-submitting");
    button.disabled = true;
  });
});

document.querySelectorAll("[data-certificate-select]").forEach((select) => {
  const form = select.closest("form");
  const periodCard = form?.querySelector("[data-scholarship-period]");
  const startInput = form?.querySelector("[data-period-start]");
  const endInput = form?.querySelector("[data-period-end]");
  const scholarshipValue = select.dataset.scholarshipValue || "";

  if (!periodCard || !startInput || !endInput) return;

  const syncPeriodState = () => {
    const isScholarship = select.value === scholarshipValue;
    periodCard.hidden = !isScholarship;
    periodCard.classList.toggle("is-visible", isScholarship);
    startInput.required = isScholarship;
    endInput.required = isScholarship;

    if (!isScholarship) {
      startInput.value = "";
      endInput.value = "";
    }
  };

  select.addEventListener("change", syncPeriodState);
  periodCard.querySelectorAll("[data-period-preset]").forEach((button) => {
    button.addEventListener("click", () => {
      const months = Number(button.dataset.periodPreset);
      if (!Number.isFinite(months) || months <= 0) return;

      const today = new Date();
      const end = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      const start = new Date(end.getFullYear(), end.getMonth() - months, end.getDate());
      startInput.value = formatDateInput(start);
      endInput.value = formatDateInput(end);
      startInput.focus();
    });
  });

  syncPeriodState();
});

window.energyStatusSubmit = (select) => {
  if (!select?.form) return;

  if (select.value === "Готова") {
    showReadyRun();
    window.setTimeout(() => select.form.submit(), 920);
    return;
  }

  select.form.submit();
};

document.querySelectorAll("[data-countdown]").forEach((element) => {
  updateCountdown(element);
  window.setInterval(() => updateCountdown(element), 60_000);
});

function showReadyRun() {
  const oldOverlay = document.querySelector(".runner-celebration");
  oldOverlay?.remove();

  const overlay = document.createElement("div");
  overlay.className = "runner-celebration";
  overlay.innerHTML = `
    <img class="ready-runner first" src="/img/student-run-1.png" alt="">
    <img class="ready-runner second" src="/img/student-run-2.png" alt="">
  `;
  document.body.append(overlay);
  window.setTimeout(() => overlay.remove(), 1_400);
}

function formatDateInput(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function updateCountdown(element) {
  const archiveAt = element.dataset.countdown;
  const archivedAt = element.dataset.archived;

  if (archivedAt) return;
  if (!archiveAt) return;

  const remainingMs = new Date(archiveAt).getTime() - Date.now();
  if (Number.isNaN(remainingMs)) return;

  if (remainingMs <= 0) {
    element.textContent = "Уйдет в архив при обновлении";
    return;
  }

  const dayMs = 24 * 60 * 60 * 1000;
  const hourMs = 60 * 60 * 1000;
  const days = Math.floor(remainingMs / dayMs);
  const hours = Math.ceil((remainingMs % dayMs) / hourMs);
  element.textContent = days > 0
    ? `В архив через ${days} дн. ${hours} ч.`
    : `В архив через ${hours} ч.`;
}

const energyRun = document.querySelector("[data-energy-run]");
const energyRunOpen = document.querySelector("[data-energy-run-open]");
const energyRunClose = document.querySelector("[data-energy-run-close]");
const energyRunStart = document.querySelector("[data-energy-run-start]");
const energyCanvas = document.querySelector("[data-energy-canvas]");
const energyJump = document.querySelector("[data-energy-jump]");
const energyScore = document.querySelector("[data-energy-score]");
const energyState = document.querySelector("[data-energy-state]");
const energySaveState = document.querySelector("[data-energy-save-state]");

if (energyRun && energyCanvas) {
  const ctx = energyCanvas.getContext("2d");
  const isEmbeddedRun = energyRun.hasAttribute("data-energy-run-embedded");
  const canSaveScore = energyRun.dataset.energyPlayer === "1";
  const game = {
    active: false,
    over: false,
    scoreSubmitted: false,
    rafId: 0,
    lastTime: 0,
    score: 0,
    speed: 300,
    groundY: 250,
    runnerX: 118,
    runnerY: 250,
    velocityY: 0,
    legPhase: 0,
    groundOffset: 0,
    nextObstacle: 0.9,
    obstacles: []
  };

  energyRunOpen?.addEventListener("click", () => {
    energyRun.hidden = false;
    energyRun.setAttribute("aria-hidden", "false");
    startEnergyRun();
  });

  energyRunStart?.addEventListener("click", startEnergyRun);
  energyRunClose?.addEventListener("click", closeEnergyRun);
  energyJump?.addEventListener("click", jumpEnergyRun);
  energyCanvas.addEventListener("pointerdown", jumpEnergyRun);

  window.addEventListener("keydown", (event) => {
    if (energyRun.hidden) return;
    if (event.key === "Escape") {
      closeEnergyRun();
      return;
    }
    if (event.code === "Space" || event.code === "ArrowUp") {
      event.preventDefault();
      jumpEnergyRun();
    }
  });

  configureEnergyCanvas();
  drawEnergyRun();

  function startEnergyRun() {
    resetEnergyRun();
    game.active = true;
    game.lastTime = performance.now();
    if (game.rafId) cancelAnimationFrame(game.rafId);
    game.rafId = requestAnimationFrame(tickEnergyRun);
  }

  function closeEnergyRun() {
    game.active = false;
    if (game.rafId) cancelAnimationFrame(game.rafId);
    game.rafId = 0;
    if (isEmbeddedRun) return;
    energyRun.hidden = true;
    energyRun.setAttribute("aria-hidden", "true");
  }

  function resetEnergyRun() {
    configureEnergyCanvas();
    game.over = false;
    game.scoreSubmitted = false;
    game.score = 0;
    game.speed = 300;
    game.runnerY = game.groundY;
    game.velocityY = 0;
    game.legPhase = 0;
    game.groundOffset = 0;
    game.nextObstacle = 0.8;
    game.obstacles = [];
    if (energySaveState) energySaveState.textContent = "";
    setEnergyHud("Run", 0);
  }

  function jumpEnergyRun() {
    if (!game.active) {
      if (isEmbeddedRun) startEnergyRun();
      return;
    }
    if (game.over) {
      startEnergyRun();
      return;
    }
    if (game.runnerY >= game.groundY - 1) {
      game.velocityY = isEnergyRunMobile() ? -930 : -760;
    }
  }

  function tickEnergyRun(time) {
    if (!game.active) return;

    const dt = Math.min((time - game.lastTime) / 1000, 0.034);
    game.lastTime = time;
    updateEnergyRun(dt);
    drawEnergyRun();
    game.rafId = requestAnimationFrame(tickEnergyRun);
  }

  function updateEnergyRun(dt) {
    if (game.over) return;

    game.score += dt * 12;
    game.speed += dt * 7;
    game.groundOffset = (game.groundOffset + game.speed * dt) % 48;

    const grounded = game.runnerY >= game.groundY - 1;
    if (grounded) {
      game.legPhase += dt * 13;
    }

    game.velocityY += (isEnergyRunMobile() ? 2850 : 2350) * dt;
    game.runnerY += game.velocityY * dt;
    if (game.runnerY > game.groundY) {
      game.runnerY = game.groundY;
      game.velocityY = 0;
    }

    game.nextObstacle -= dt;
    if (game.nextObstacle <= 0) {
      game.obstacles.push(makeObstacle());
      game.nextObstacle = 0.95 + Math.random() * 0.85;
    }

    for (const obstacle of game.obstacles) {
      obstacle.x -= game.speed * dt;
    }
    game.obstacles = game.obstacles.filter((obstacle) => obstacle.x + obstacle.w > -20);

    if (game.obstacles.some(hitObstacle)) {
      game.over = true;
      setEnergyHud("Again", Math.floor(game.score));
      submitEnergyScore(Math.floor(game.score));
      return;
    }

    setEnergyHud("Run", Math.floor(game.score));
  }

  function makeObstacle() {
    const tall = Math.random() > 0.55;
    return {
      x: energyCanvas.width + 32,
      y: tall ? game.groundY - 64 : game.groundY - 42,
      w: tall ? 34 : 44,
      h: tall ? 64 : 42,
      color: tall ? "#0b64d8" : "#08a5d8"
    };
  }

  function hitObstacle(obstacle) {
    const runnerBox = {
      x: game.runnerX - 26,
      y: game.runnerY - 110,
      w: 60,
      h: 108
    };
    return runnerBox.x < obstacle.x + obstacle.w
      && runnerBox.x + runnerBox.w > obstacle.x
      && runnerBox.y < obstacle.y + obstacle.h
      && runnerBox.y + runnerBox.h > obstacle.y;
  }

  function drawEnergyRun() {
    const width = energyCanvas.width;
    const height = energyCanvas.height;
    ctx.clearRect(0, 0, width, height);

    const sky = ctx.createLinearGradient(0, 0, 0, height);
    sky.addColorStop(0, "#f5fbff");
    sky.addColorStop(0.62, "#ffffff");
    sky.addColorStop(1, "#eaf5ff");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, width, height);

    drawEnergyCloud(120, 74, 0.82);
    drawEnergyCloud(648, 58, 1);
    drawEnergyLogoMark(width - 92, 76);
    drawGround();

    for (const obstacle of game.obstacles) {
      drawObstacle(obstacle);
    }

    drawStudent(game.runnerX, game.runnerY, game.legPhase, game.runnerY < game.groundY - 2);

    if (game.over) {
      ctx.fillStyle = "rgba(255, 255, 255, 0.72)";
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = "#07306f";
      ctx.font = "900 34px Segoe UI, Arial";
      ctx.textAlign = "center";
      ctx.fillText("Energy Run", width / 2, 142);
      ctx.font = "800 18px Segoe UI, Arial";
      ctx.fillText(`Score ${Math.floor(game.score)}`, width / 2, 174);
    }
  }

  function drawGround() {
    ctx.strokeStyle = "#0b64d8";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(0, game.groundY + 4);
    ctx.lineTo(energyCanvas.width, game.groundY + 4);
    ctx.stroke();

    ctx.strokeStyle = "rgba(11, 100, 216, 0.34)";
    ctx.lineWidth = 2;
    for (let x = -game.groundOffset; x < energyCanvas.width; x += 48) {
      ctx.beginPath();
      ctx.moveTo(x, game.groundY + 22);
      ctx.lineTo(x + 22, game.groundY + 22);
      ctx.stroke();
    }
  }

  function drawStudent(x, footY, phase, airborne) {
    const stride = airborne ? 0.35 : Math.sin(phase);
    const counter = airborne ? -0.35 : Math.sin(phase + Math.PI);
    ctx.save();
    ctx.translate(x, footY);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    drawLeg(-9, stride, "#07306f");
    drawLeg(9, counter, "#0b64d8");

    ctx.fillStyle = "#0b64d8";
    roundRect(-18, -78, 42, 48, 9);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    roundRect(-10, -70, 24, 32, 6);
    ctx.fill();

    ctx.strokeStyle = "#f0b28b";
    ctx.lineWidth = 8;
    drawLimb(-14, -68, -38 - 10 * stride, -49 + 8 * Math.abs(stride), -46 - 20 * stride, -30);
    drawLimb(20, -66, 42 - 10 * counter, -48 + 8 * Math.abs(counter), 52 - 18 * counter, -32);

    ctx.fillStyle = "#f4bd96";
    ctx.beginPath();
    ctx.arc(4, -100, 19, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#2b2636";
    ctx.beginPath();
    ctx.arc(-2, -108, 17, Math.PI, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#07306f";
    roundRect(-13, -122, 36, 9, 5);
    ctx.fill();

    ctx.fillStyle = "#102033";
    ctx.beginPath();
    ctx.arc(12, -101, 2.4, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = "#102033";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(11, -94, 5, 0.15, Math.PI - 0.15);
    ctx.stroke();

    ctx.restore();
  }

  function drawLeg(hipX, run, color) {
    const kneeX = hipX + 12 * run;
    const kneeY = -28 + 8 * Math.abs(run);
    const footX = hipX + 34 * run;
    const footY = -2;
    ctx.strokeStyle = color;
    ctx.lineWidth = 9;
    drawLimb(hipX, -40, kneeX, kneeY, footX, footY);
    ctx.strokeStyle = "#102033";
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.moveTo(footX - 7, footY);
    ctx.lineTo(footX + 13, footY);
    ctx.stroke();
  }

  function drawLimb(x1, y1, x2, y2, x3, y3) {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.lineTo(x3, y3);
    ctx.stroke();
  }

  function drawObstacle(obstacle) {
    ctx.fillStyle = obstacle.color;
    roundRect(obstacle.x, obstacle.y, obstacle.w, obstacle.h, 7);
    ctx.fill();
    ctx.fillStyle = "rgba(255, 255, 255, 0.76)";
    ctx.fillRect(obstacle.x + 8, obstacle.y + 12, obstacle.w - 16, 4);
    ctx.fillRect(obstacle.x + 8, obstacle.y + 24, obstacle.w - 20, 4);
  }

  function drawEnergyCloud(x, y, scale) {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(scale, scale);
    ctx.fillStyle = "rgba(11, 100, 216, 0.08)";
    ctx.beginPath();
    ctx.arc(0, 0, 24, 0, Math.PI * 2);
    ctx.arc(28, -12, 28, 0, Math.PI * 2);
    ctx.arc(60, 0, 22, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawEnergyLogoMark(x, y) {
    ctx.save();
    ctx.translate(x, y);
    ctx.strokeStyle = "rgba(11, 100, 216, 0.22)";
    ctx.lineWidth = 8;
    ctx.beginPath();
    ctx.arc(0, 0, 34, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = "rgba(8, 165, 216, 0.34)";
    for (let i = 0; i < 8; i += 1) {
      ctx.rotate(Math.PI / 4);
      ctx.beginPath();
      ctx.moveTo(0, -48);
      ctx.lineTo(0, -32);
      ctx.stroke();
    }
    ctx.restore();
  }

  function roundRect(x, y, width, height, radius) {
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + width, y, x + width, y + height, radius);
    ctx.arcTo(x + width, y + height, x, y + height, radius);
    ctx.arcTo(x, y + height, x, y, radius);
    ctx.arcTo(x, y, x + width, y, radius);
    ctx.closePath();
  }

  function setEnergyHud(state, score) {
    if (energyScore) energyScore.textContent = String(score);
    if (energyState) energyState.textContent = state;
  }

  async function submitEnergyScore(score) {
    if (!canSaveScore || game.scoreSubmitted) return;
    game.scoreSubmitted = true;
    if (energySaveState) energySaveState.textContent = "Сохраняем счет...";

    try {
      const response = await fetch("/energy-run/scores", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ score })
      });
      const result = await response.json();
      if (!response.ok || !result.ok) {
        throw new Error(result.message || "Score save failed");
      }
      if (energySaveState) energySaveState.textContent = `Счет ${score} сохранен. Лидерборд обновляется...`;
      window.setTimeout(() => window.location.reload(), 1_100);
    } catch {
      if (energySaveState) energySaveState.textContent = "Не удалось сохранить счет. Проверьте интернет и попробуйте еще раз.";
    }
  }

  function configureEnergyCanvas() {
    const height = isEnergyRunMobile() ? 520 : 320;
    if (energyCanvas.width !== 900) energyCanvas.width = 900;
    if (energyCanvas.height !== height) energyCanvas.height = height;
    game.groundY = height - 70;
    game.runnerY = Math.min(game.runnerY || game.groundY, game.groundY);
  }

  function isEnergyRunMobile() {
    return window.matchMedia("(max-width: 640px)").matches;
  }
}
