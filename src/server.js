const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const dotenv = require("dotenv");
const express = require("express");

dotenv.config();

const app = express();
const rootDir = path.resolve(__dirname, "..");
const dataDir = path.join(rootDir, "data");
const dbPath = path.resolve(rootDir, process.env.DATABASE_PATH || "./data/energy.sqlite");
const scheduleArchivePath = process.env.SCHEDULE_ARCHIVE_ROOT || "/home/bot_rasp/archive";
const scheduleArchiveRoot = path.isAbsolute(scheduleArchivePath)
  ? path.resolve(scheduleArchivePath)
  : path.resolve(rootDir, scheduleArchivePath);
const publicDir = path.join(rootDir, "public");
const viewsDir = path.join(rootDir, "views");
const port = Number(process.env.PORT || 9348);

const SESSION_COOKIE = "energy_session";
const STATUSES = ["Новая", "Готова", "Выдана"];
const ARCHIVE_STATUS = "Архив";
const FILTER_STATUSES = [...STATUSES, ARCHIVE_STATUS];
const CERTIFICATE_TYPES = ["Об обучении", "В военкомат", "О размере стипендии"];
const ROLES = ["admin", "staff"];
const quickSubmitWindowMs = 30_000;
const readyArchiveDelayMs = 7 * 24 * 60 * 60 * 1000;
const scheduleLimit = 90;
const secretaryLimit = 3;
const quickSubmitCache = new Map();
const PLAYER_COOKIE = "energy_player";

fs.mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(dbPath);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    full_name TEXT NOT NULL,
    group_name TEXT NOT NULL,
    certificate_type TEXT NOT NULL,
    contact TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'Новая',
    ready_at TEXT,
    archive_after_at TEXT,
    archived_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS admin_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'staff',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash TEXT NOT NULL UNIQUE,
    user_id INTEGER NOT NULL,
    csrf_token TEXT NOT NULL,
    user_agent TEXT NOT NULL DEFAULT '',
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES admin_users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS energy_players (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    group_name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS energy_scores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id INTEGER NOT NULL,
    score INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (player_id) REFERENCES energy_players(id) ON DELETE CASCADE
  );
`);

migrateRequestsTable();
backfillReadyArchiveDates();

app.set("view engine", "ejs");
app.set("views", viewsDir);
app.set("trust proxy", 1);
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static(publicDir, { maxAge: "7d", etag: true }));

app.use((req, res, next) => {
  res.locals.currentPath = req.path;
  res.locals.query = req.query;
  res.locals.formatDate = formatDate;
  res.locals.formatArchiveCountdown = formatArchiveCountdown;
  res.locals.certificateTypes = CERTIFICATE_TYPES;
  res.locals.statuses = STATUSES;
  res.locals.filterStatuses = FILTER_STATUSES;
  res.locals.roleLabel = roleLabel;
  res.locals.flash = consumeFlash(req, res);
  next();
});

ensureInitialAdmin();
cleanExpiredSessions();
autoArchiveReadyRequests();
setInterval(cleanExpiredSessions, 60 * 60 * 1000).unref();
setInterval(autoArchiveReadyRequests, 15 * 60 * 1000).unref();

app.get("/", (req, res) => {
  res.render("index", {
    title: "Заказ справки | ПК Энергия",
    errors: [],
    old: {},
    certificateTypes: CERTIFICATE_TYPES
  });
});

app.post("/requests", (req, res) => {
  const payload = {
    fullName: normalizeText(req.body.fullName),
    groupName: normalizeText(req.body.groupName),
    certificateType: normalizeText(req.body.certificateType),
    contact: normalizeText(req.body.contact)
  };
  const errors = validateRequest(payload);

  if (isQuickRepeat(req)) {
    errors.push("Заявка уже отправляется. Подождите немного и попробуйте снова.");
  }

  if (errors.length > 0) {
    return res.status(422).render("index", {
      title: "Заказ справки | ПК Энергия",
      errors,
      old: payload,
      certificateTypes: CERTIFICATE_TYPES
    });
  }

  rememberSubmit(req);
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO requests (full_name, group_name, certificate_type, contact, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'Новая', ?, ?)
  `).run(payload.fullName, payload.groupName, payload.certificateType, payload.contact, now, now);

  res.redirect("/success");
});

app.get("/success", (req, res) => {
  res.render("success", {
    title: "Заявка принята | ПК Энергия"
  });
});

app.get(["/schedule", "/raspisanie"], (req, res) => {
  const schedules = listScheduleFiles();
  const selected = schedules.find((schedule) => schedule.id === req.query.file) || schedules[0] || null;

  res.render("schedule", {
    title: "Расписания | ПК Энергия",
    schedules,
    selected,
    archiveRoot: scheduleArchiveRoot,
    archiveExists: fs.existsSync(scheduleArchiveRoot)
  });
});

app.get("/energy-run", (req, res) => {
  const player = getEnergyPlayer(req);
  res.render("energy-run", {
    title: "Energy Run | ПК Энергия",
    player,
    errors: [],
    old: {},
    leaderboard: getEnergyLeaderboard(),
    groupLeaderboard: getEnergyGroupLeaderboard(),
    playerStats: player ? getEnergyPlayerStats(player.id) : null
  });
});

app.post("/energy-run/register", (req, res) => {
  const payload = {
    firstName: normalizeName(req.body.firstName),
    lastName: normalizeName(req.body.lastName),
    groupName: normalizeText(req.body.groupName).toUpperCase()
  };
  const errors = validateEnergyPlayer(payload);
  const leaderboard = getEnergyLeaderboard();
  const groupLeaderboard = getEnergyGroupLeaderboard();

  if (errors.length > 0) {
    return res.status(422).render("energy-run", {
      title: "Energy Run | ПК Энергия",
      player: null,
      errors,
      old: payload,
      leaderboard,
      groupLeaderboard,
      playerStats: null
    });
  }

  const token = crypto.randomBytes(32).toString("hex");
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO energy_players (first_name, last_name, group_name, token_hash, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(payload.firstName, payload.lastName, payload.groupName, hashToken(token), now, now);

  res.cookie(PLAYER_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: req.secure || req.headers["x-forwarded-proto"] === "https",
    path: "/",
    maxAge: 365 * 24 * 60 * 60 * 1000
  });
  res.redirect("/energy-run");
});

app.post("/energy-run/logout", (req, res) => {
  res.clearCookie(PLAYER_COOKIE, { path: "/" });
  res.redirect("/energy-run");
});

app.post("/energy-run/scores", (req, res) => {
  const player = getEnergyPlayer(req);
  if (!player) {
    return res.status(401).json({ ok: false, message: "Сначала создайте профиль игрока." });
  }

  const score = Number(req.body.score);
  if (!Number.isInteger(score) || score < 0 || score > 1_000_000) {
    return res.status(422).json({ ok: false, message: "Некорректный счет." });
  }

  db.prepare(`
    INSERT INTO energy_scores (player_id, score, created_at)
    VALUES (?, ?, ?)
  `).run(player.id, score, new Date().toISOString());

  res.json({
    ok: true,
    score,
    playerStats: getEnergyPlayerStats(player.id)
  });
});

app.get("/schedule/pdf/:id", (req, res, next) => {
  const file = getScheduleFileById(req.params.id);
  if (!file) return next();

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(file.filename)}"`);
  res.sendFile(file.absolutePath);
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "energy-certificate-requests",
    port,
    time: new Date().toISOString()
  });
});

app.get("/admin/login", redirectIfAuthenticated, (req, res) => {
  res.render("admin/login", {
    title: "Вход в админку",
    error: ""
  });
});

app.post("/admin/login", redirectIfAuthenticated, (req, res) => {
  const username = normalizeText(req.body.username).toLowerCase();
  const password = String(req.body.password || "");
  const user = db.prepare(`
    SELECT * FROM admin_users
    WHERE lower(username) = ? AND active = 1
  `).get(username);

  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).render("admin/login", {
      title: "Вход в админку",
      error: "Неверный логин или пароль."
    });
  }

  const token = crypto.randomBytes(32).toString("hex");
  const csrfToken = crypto.randomBytes(24).toString("hex");
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare(`
    INSERT INTO sessions (token_hash, user_id, csrf_token, user_agent, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(hashToken(token), user.id, csrfToken, String(req.headers["user-agent"] || "").slice(0, 255), expiresAt, new Date().toISOString());

  res.cookie(SESSION_COOKIE, token, cookieOptions(req, expiresAt));
  res.redirect("/admin");
});

app.post("/admin/logout", requireAuth, requireCsrf, (req, res) => {
  db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(req.session.token_hash);
  res.clearCookie(SESSION_COOKIE, cookieOptions(req));
  res.redirect("/admin/login");
});

app.get("/admin", requireAuth, (req, res) => {
  autoArchiveReadyRequests();
  const filters = buildRequestFilters(req.query);
  const rows = listRequests(filters);
  const stats = getStats();

  res.render("admin/dashboard", {
    title: "Заявки | Админка",
    user: req.user,
    csrfToken: req.session.csrf_token,
    rows,
    stats,
    filters,
    certificateTypes: CERTIFICATE_TYPES,
    statuses: STATUSES,
    filterStatuses: FILTER_STATUSES
  });
});

app.post("/admin/requests/:id/status", requireAuth, requireCsrf, (req, res) => {
  const id = Number(req.params.id);
  const status = normalizeText(req.body.status);

  if (!Number.isInteger(id) || id <= 0 || !STATUSES.includes(status)) {
    setFlash(res, "Не удалось обновить статус заявки.", "error");
    return res.redirect(backToAdmin(req));
  }

  const now = new Date();
  const nowIso = now.toISOString();
  const readyAt = status === "Готова" ? nowIso : null;
  const archiveAfterAt = status === "Готова" ? new Date(now.getTime() + readyArchiveDelayMs).toISOString() : null;
  const result = db.prepare(`
    UPDATE requests
    SET status = ?, ready_at = ?, archive_after_at = ?, archived_at = NULL, updated_at = ?
    WHERE id = ?
  `).run(status, readyAt, archiveAfterAt, nowIso, id);

  setFlash(res, result.changes > 0 ? "Статус заявки обновлен." : "Заявка не найдена.", result.changes > 0 ? "success" : "error");
  res.redirect(backToAdmin(req));
});

app.get("/admin/export.csv", requireAuth, requireAdmin, (req, res) => {
  autoArchiveReadyRequests();
  const filters = buildRequestFilters(req.query);
  const rows = listRequests({ ...filters, limit: 10_000 });
  const header = ["ID", "ФИО", "Группа", "Тип справки", "Контакт", "Статус", "Архив", "Создана", "Обновлена"];
  const csv = [
    header.map(csvCell).join(";"),
    ...rows.map((row) => [
      row.id,
      row.full_name,
      row.group_name,
      row.certificate_type,
      row.contact,
      row.status,
      row.archive_countdown,
      formatDate(row.created_at),
      formatDate(row.updated_at)
    ].map(csvCell).join(";"))
  ].join("\r\n");

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="energy-requests-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(`\uFEFF${csv}`);
});

app.get("/admin/users", requireAuth, requireAdmin, (req, res) => {
  const users = db.prepare(`
    SELECT id, username, display_name, role, active, created_at, updated_at
    FROM admin_users
    ORDER BY active DESC, created_at ASC
  `).all();

  res.render("admin/users", {
    title: "Пользователи | Админка",
    user: req.user,
    csrfToken: req.session.csrf_token,
    users,
    secretaryCount: countSecretaries(),
    errors: [],
    old: {},
    roles: ROLES
  });
});

app.post("/admin/users", requireAuth, requireAdmin, requireCsrf, (req, res) => {
  const payload = {
    username: normalizeText(req.body.username).toLowerCase(),
    displayName: normalizeText(req.body.displayName),
    role: normalizeText(req.body.role),
    password: String(req.body.password || "")
  };
  const errors = validateUser(payload);
  if (payload.role === "staff" && countSecretaries() >= secretaryLimit) {
    errors.push(`Можно создать максимум ${secretaryLimit} активных секретаря.`);
  }
  const users = db.prepare(`
    SELECT id, username, display_name, role, active, created_at, updated_at
    FROM admin_users
    ORDER BY active DESC, created_at ASC
  `).all();

  if (errors.length > 0) {
    return res.status(422).render("admin/users", {
      title: "Пользователи | Админка",
      user: req.user,
      csrfToken: req.session.csrf_token,
      users,
      secretaryCount: countSecretaries(),
      errors,
      old: payload,
      roles: ROLES
    });
  }

  const now = new Date().toISOString();
  try {
    db.prepare(`
      INSERT INTO admin_users (username, display_name, password_hash, role, active, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, ?, ?)
    `).run(payload.username, payload.displayName, hashPassword(payload.password), payload.role, now, now);
    setFlash(res, "Пользователь добавлен.", "success");
    res.redirect("/admin/users");
  } catch (error) {
    return res.status(409).render("admin/users", {
      title: "Пользователи | Админка",
      user: req.user,
      csrfToken: req.session.csrf_token,
      users,
      secretaryCount: countSecretaries(),
      errors: ["Такой логин уже существует."],
      old: payload,
      roles: ROLES
    });
  }
});

app.post("/admin/users/:id/toggle", requireAuth, requireAdmin, requireCsrf, (req, res) => {
  const id = Number(req.params.id);
  const active = normalizeText(req.body.active) === "1" ? 1 : 0;

  if (!Number.isInteger(id) || id <= 0) {
    setFlash(res, "Пользователь не найден.", "error");
    return res.redirect("/admin/users");
  }

  const targetUser = db.prepare("SELECT id, role, active FROM admin_users WHERE id = ?").get(id);
  if (!targetUser) {
    setFlash(res, "Пользователь не найден.", "error");
    return res.redirect("/admin/users");
  }

  if (id === req.user.id && active === 0) {
    setFlash(res, "Нельзя отключить свою текущую учетную запись.", "error");
    return res.redirect("/admin/users");
  }

  if (targetUser.role === "staff" && active === 1 && !targetUser.active && countSecretaries() >= secretaryLimit) {
    setFlash(res, `Можно включить максимум ${secretaryLimit} активных секретаря.`, "error");
    return res.redirect("/admin/users");
  }

  db.prepare(`
    UPDATE admin_users
    SET active = ?, updated_at = ?
    WHERE id = ?
  `).run(active, new Date().toISOString(), id);

  if (active === 0) {
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(id);
  }

  setFlash(res, active ? "Пользователь включен." : "Пользователь отключен.", "success");
  res.redirect("/admin/users");
});

app.use((req, res) => {
  res.status(404).render("not-found", {
    title: "Страница не найдена"
  });
});

app.use((error, req, res, next) => {
  console.error(error);
  res.status(500).render("error", {
    title: "Ошибка",
    message: "Что-то пошло не так. Попробуйте обновить страницу."
  });
});

app.listen(port, () => {
  console.log(`Energy certificate requests app is running on http://localhost:${port}`);
});

function ensureInitialAdmin() {
  const count = db.prepare("SELECT COUNT(*) AS count FROM admin_users").get().count;
  if (count > 0) return;

  const username = normalizeText(process.env.ADMIN_USERNAME || "admin").toLowerCase();
  const password = String(process.env.ADMIN_PASSWORD || "change-this-admin-password");
  const displayName = normalizeText(process.env.ADMIN_DISPLAY_NAME || "Администратор");
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO admin_users (username, display_name, password_hash, role, active, created_at, updated_at)
    VALUES (?, ?, ?, 'admin', 1, ?, ?)
  `).run(username, displayName, hashPassword(password), now, now);
}

function migrateRequestsTable() {
  const columns = db.prepare("PRAGMA table_info(requests)").all().map((column) => column.name);
  const missingColumns = [
    ["ready_at", "TEXT"],
    ["archive_after_at", "TEXT"],
    ["archived_at", "TEXT"]
  ].filter(([name]) => !columns.includes(name));

  for (const [name, type] of missingColumns) {
    db.exec(`ALTER TABLE requests ADD COLUMN ${name} ${type}`);
  }
}

function backfillReadyArchiveDates() {
  const rows = db.prepare(`
    SELECT id, updated_at
    FROM requests
    WHERE status = 'Готова' AND archive_after_at IS NULL
  `).all();

  const statement = db.prepare(`
    UPDATE requests
    SET ready_at = ?, archive_after_at = ?
    WHERE id = ?
  `);

  for (const row of rows) {
    const readyAtDate = new Date(row.updated_at || Date.now());
    const readyAt = Number.isNaN(readyAtDate.getTime()) ? new Date() : readyAtDate;
    const archiveAfterAt = new Date(readyAt.getTime() + readyArchiveDelayMs);
    statement.run(readyAt.toISOString(), archiveAfterAt.toISOString(), row.id);
  }
}

function requireAuth(req, res, next) {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) {
    return res.redirect("/admin/login");
  }

  const session = db.prepare(`
    SELECT sessions.*, admin_users.username, admin_users.display_name, admin_users.role, admin_users.active
    FROM sessions
    JOIN admin_users ON admin_users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ? AND admin_users.active = 1
  `).get(hashToken(token), new Date().toISOString());

  if (!session) {
    res.clearCookie(SESSION_COOKIE, cookieOptions(req));
    return res.redirect("/admin/login");
  }

  req.session = session;
  req.user = {
    id: session.user_id,
    username: session.username,
    displayName: session.display_name,
    role: session.role
  };
  res.locals.user = req.user;
  res.locals.csrfToken = session.csrf_token;
  next();
}

function redirectIfAuthenticated(req, res, next) {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return next();

  const session = db.prepare(`
    SELECT sessions.id
    FROM sessions
    JOIN admin_users ON admin_users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ? AND admin_users.active = 1
  `).get(hashToken(token), new Date().toISOString());

  if (session) return res.redirect("/admin");
  next();
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== "admin") {
    setFlash(res, "Недостаточно прав для этого раздела.", "error");
    return res.redirect("/admin");
  }
  next();
}

function roleLabel(role) {
  return role === "admin" ? "Администратор" : "Секретарь";
}

function countSecretaries() {
  return db.prepare("SELECT COUNT(*) AS count FROM admin_users WHERE role = 'staff' AND active = 1").get().count;
}

function requireCsrf(req, res, next) {
  if (req.body._csrf !== req.session?.csrf_token) {
    setFlash(res, "Сессия устарела. Повторите действие.", "error");
    return res.redirect(req.headers.referer || "/admin");
  }
  next();
}

function buildRequestFilters(query) {
  const requestedStatus = normalizeText(query.status);
  let archive = ["active", "archived", "all"].includes(normalizeText(query.archive)) ? normalizeText(query.archive) : "active";
  let status = FILTER_STATUSES.includes(requestedStatus) ? requestedStatus : "";
  if (status === ARCHIVE_STATUS) {
    archive = "archived";
  }
  const type = CERTIFICATE_TYPES.includes(normalizeText(query.type)) ? normalizeText(query.type) : "";
  const q = normalizeText(query.q).slice(0, 120);
  const sort = ["newest", "oldest", "updated"].includes(normalizeText(query.sort)) ? normalizeText(query.sort) : "newest";

  return { q, status, type, sort, archive, limit: 500 };
}

function listRequests(filters) {
  const where = [];
  const params = [];

  if (filters.archive === "active") {
    where.push("(archived_at IS NULL AND status != ?)");
    params.push(ARCHIVE_STATUS);
  } else if (filters.archive === "archived") {
    where.push("(archived_at IS NOT NULL OR status = ?)");
    params.push(ARCHIVE_STATUS);
  }

  if (filters.q) {
    where.push("(full_name LIKE ? OR group_name LIKE ? OR contact LIKE ?)");
    const like = `%${filters.q}%`;
    params.push(like, like, like);
  }

  if (filters.status) {
    where.push("status = ?");
    params.push(filters.status);
  }

  if (filters.type) {
    where.push("certificate_type = ?");
    params.push(filters.type);
  }

  const orderBy = {
    newest: "created_at DESC",
    oldest: "created_at ASC",
    updated: "updated_at DESC"
  }[filters.sort || "newest"];

  params.push(filters.limit || 500);
  return db.prepare(`
    SELECT *
    FROM requests
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY ${orderBy}
    LIMIT ?
  `).all(...params).map(decorateRequest);
}

function getStats() {
  const total = db.prepare("SELECT COUNT(*) AS count FROM requests WHERE archived_at IS NULL AND status != ?").get(ARCHIVE_STATUS).count;
  const archived = db.prepare("SELECT COUNT(*) AS count FROM requests WHERE archived_at IS NOT NULL OR status = ?").get(ARCHIVE_STATUS).count;
  const byStatusRows = db.prepare(`
    SELECT status, COUNT(*) AS count
    FROM requests
    WHERE archived_at IS NULL AND status != ?
    GROUP BY status
  `).all(ARCHIVE_STATUS);
  const byStatus = Object.fromEntries(STATUSES.map((status) => [status, 0]));
  for (const row of byStatusRows) byStatus[row.status] = row.count;

  return {
    total,
    new: byStatus["Новая"],
    ready: byStatus["Готова"],
    issued: byStatus["Выдана"],
    archived
  };
}

function autoArchiveReadyRequests() {
  const nowIso = new Date().toISOString();
  db.prepare(`
    UPDATE requests
    SET status = ?, archived_at = ?, updated_at = ?
    WHERE status = 'Готова'
      AND archive_after_at IS NOT NULL
      AND archive_after_at <= ?
      AND archived_at IS NULL
  `).run(ARCHIVE_STATUS, nowIso, nowIso, nowIso);
}

function decorateRequest(row) {
  return {
    ...row,
    archive_countdown: formatArchiveCountdown(row)
  };
}

function formatArchiveCountdown(row) {
  if (!row) return "";

  if (row.archived_at || row.status === ARCHIVE_STATUS) {
    return `В архиве с ${formatDate(row.archived_at || row.updated_at)}`;
  }

  if (row.status !== "Готова" || !row.archive_after_at) {
    return "—";
  }

  const remainingMs = new Date(row.archive_after_at).getTime() - Date.now();
  if (remainingMs <= 0) {
    return "Уйдет в архив при обновлении";
  }

  const days = Math.floor(remainingMs / (24 * 60 * 60 * 1000));
  const hours = Math.ceil((remainingMs % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
  if (days > 0) {
    return `В архив через ${days} дн. ${hours} ч.`;
  }
  return `В архив через ${hours} ч.`;
}

function validateRequest(payload) {
  const errors = [];
  if (payload.fullName.length < 5 || payload.fullName.length > 180) {
    errors.push("Введите Ф.И.О. полностью.");
  }
  if (payload.groupName.length < 2 || payload.groupName.length > 40) {
    errors.push("Введите корректную группу.");
  }
  if (!CERTIFICATE_TYPES.includes(payload.certificateType)) {
    errors.push("Выберите вариант справки.");
  }
  if (payload.contact.length > 120) {
    errors.push("Контакт слишком длинный.");
  }
  return errors;
}

function validateUser(payload) {
  const errors = [];
  if (!/^[a-z0-9._-]{3,40}$/.test(payload.username)) {
    errors.push("Логин: 3-40 символов, латиница, цифры, точка, дефис или подчеркивание.");
  }
  if (payload.displayName.length < 2 || payload.displayName.length > 80) {
    errors.push("Введите имя сотрудника.");
  }
  if (!ROLES.includes(payload.role)) {
    errors.push("Выберите роль пользователя.");
  }
  if (payload.password.length < 8 || payload.password.length > 120) {
    errors.push("Пароль должен быть от 8 символов.");
  }
  return errors;
}

function validateEnergyPlayer(payload) {
  const errors = [];
  if (payload.firstName.length < 2 || payload.firstName.length > 40) {
    errors.push("Введите имя игрока.");
  }
  if (payload.lastName.length < 2 || payload.lastName.length > 60) {
    errors.push("Введите фамилию игрока.");
  }
  if (payload.groupName.length < 2 || payload.groupName.length > 40) {
    errors.push("Введите группу.");
  }
  return errors;
}

function getEnergyPlayer(req) {
  const token = readCookie(req, PLAYER_COOKIE);
  if (!token) return null;

  return db.prepare(`
    SELECT id, first_name, last_name, group_name, created_at, updated_at
    FROM energy_players
    WHERE token_hash = ?
  `).get(hashToken(token)) || null;
}

function getEnergyLeaderboard() {
  return db.prepare(`
    SELECT
      energy_players.id,
      energy_players.first_name,
      energy_players.last_name,
      energy_players.group_name,
      MAX(energy_scores.score) AS best_score,
      SUM(energy_scores.score) AS total_score,
      COUNT(energy_scores.id) AS games_count
    FROM energy_scores
    JOIN energy_players ON energy_players.id = energy_scores.player_id
    GROUP BY energy_players.id
    ORDER BY best_score DESC, total_score DESC, games_count ASC
    LIMIT 20
  `).all();
}

function getEnergyGroupLeaderboard() {
  return db.prepare(`
    SELECT
      energy_players.group_name,
      MAX(energy_scores.score) AS best_score,
      SUM(energy_scores.score) AS total_score,
      COUNT(energy_scores.id) AS games_count,
      COUNT(DISTINCT energy_players.id) AS players_count
    FROM energy_scores
    JOIN energy_players ON energy_players.id = energy_scores.player_id
    GROUP BY energy_players.group_name
    ORDER BY total_score DESC, best_score DESC, players_count DESC
    LIMIT 12
  `).all();
}

function getEnergyPlayerStats(playerId) {
  return db.prepare(`
    SELECT
      COALESCE(MAX(score), 0) AS best_score,
      COALESCE(SUM(score), 0) AS total_score,
      COUNT(id) AS games_count
    FROM energy_scores
    WHERE player_id = ?
  `).get(playerId);
}

function listScheduleFiles() {
  if (!fs.existsSync(scheduleArchiveRoot)) return [];

  const schedules = [];
  const yearDirs = safeReadDir(scheduleArchiveRoot)
    .filter((entry) => entry.isDirectory() && /^\d{4}$/.test(entry.name))
    .sort((a, b) => b.name.localeCompare(a.name));

  for (const yearDir of yearDirs) {
    const yearPath = path.join(scheduleArchiveRoot, yearDir.name);
    const monthDirs = safeReadDir(yearPath)
      .filter((entry) => entry.isDirectory() && /^\d{2}$/.test(entry.name))
      .sort((a, b) => b.name.localeCompare(a.name));

    for (const monthDir of monthDirs) {
      const monthPath = path.join(yearPath, monthDir.name);
      const pdfFiles = safeReadDir(monthPath)
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".pdf"));

      for (const file of pdfFiles) {
        const absolutePath = path.join(monthPath, file.name);
        const stat = safeStat(absolutePath);
        if (!stat) continue;

        const date = extractScheduleDate(file.name, stat.mtime);
        const relativePath = path.relative(scheduleArchiveRoot, absolutePath);
        schedules.push({
          id: Buffer.from(relativePath, "utf8").toString("base64url"),
          absolutePath,
          filename: file.name,
          date,
          dateLabel: formatScheduleDate(date),
          monthLabel: formatScheduleMonth(date),
          sizeLabel: formatFileSize(stat.size),
          updatedLabel: formatDate(stat.mtime.toISOString())
        });
      }
    }
  }

  return schedules
    .sort((a, b) => b.date.getTime() - a.date.getTime() || b.filename.localeCompare(a.filename))
    .slice(0, scheduleLimit);
}

function getScheduleFileById(id) {
  let relativePath = "";
  try {
    relativePath = Buffer.from(String(id || ""), "base64url").toString("utf8");
  } catch {
    return null;
  }

  if (!relativePath || relativePath.includes("\0")) return null;

  const absolutePath = path.resolve(scheduleArchiveRoot, relativePath);
  const rootWithSeparator = scheduleArchiveRoot.endsWith(path.sep) ? scheduleArchiveRoot : `${scheduleArchiveRoot}${path.sep}`;
  if (absolutePath !== scheduleArchiveRoot && !absolutePath.startsWith(rootWithSeparator)) return null;
  if (!absolutePath.toLowerCase().endsWith(".pdf")) return null;

  const stat = safeStat(absolutePath);
  if (!stat?.isFile()) return null;

  return {
    absolutePath,
    filename: path.basename(absolutePath)
  };
}

function safeReadDir(directory) {
  try {
    return fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

function safeStat(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function extractScheduleDate(filename, fallbackDate) {
  const match = filename.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return fallbackDate;

  const date = new Date(`${match[1]}-${match[2]}-${match[3]}T12:00:00+03:00`);
  return Number.isNaN(date.getTime()) ? fallbackDate : date;
}

function formatScheduleDate(date) {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Europe/Moscow"
  }).format(date);
}

function formatScheduleMonth(date) {
  return new Intl.DateTimeFormat("ru-RU", {
    month: "long",
    year: "numeric",
    timeZone: "Europe/Moscow"
  }).format(date);
}

function formatFileSize(bytes) {
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} КБ`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeName(value) {
  return normalizeText(value).replace(/[^\p{L}\s-]/gu, "").slice(0, 80);
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const key = crypto.scryptSync(password, salt, 64).toString("hex");
  return `scrypt$${salt}$${key}`;
}

function verifyPassword(password, stored) {
  const [scheme, salt, expectedHex] = String(stored || "").split("$");
  if (scheme !== "scrypt" || !salt || !expectedHex) return false;

  const actual = Buffer.from(crypto.scryptSync(password, salt, 64).toString("hex"), "hex");
  const expected = Buffer.from(expectedHex, "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function readCookie(req, name) {
  const header = req.headers.cookie || "";
  const cookies = Object.fromEntries(
    header.split(";").map((part) => {
      const index = part.indexOf("=");
      if (index === -1) return ["", ""];
      return [decodeURIComponent(part.slice(0, index).trim()), decodeURIComponent(part.slice(index + 1).trim())];
    }).filter(([key]) => key)
  );
  return cookies[name] || "";
}

function cookieOptions(req, expiresAt) {
  const options = {
    httpOnly: true,
    sameSite: "lax",
    secure: req.secure || req.headers["x-forwarded-proto"] === "https",
    path: "/"
  };

  if (expiresAt) {
    options.expires = new Date(expiresAt);
  }

  return options;
}

function cleanExpiredSessions() {
  db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(new Date().toISOString());
}

function isQuickRepeat(req) {
  const key = `${req.ip}:${normalizeText(req.body.fullName).toLowerCase()}:${normalizeText(req.body.groupName).toLowerCase()}`;
  const lastSubmit = quickSubmitCache.get(key) || 0;
  return Date.now() - lastSubmit < quickSubmitWindowMs;
}

function rememberSubmit(req) {
  const key = `${req.ip}:${normalizeText(req.body.fullName).toLowerCase()}:${normalizeText(req.body.groupName).toLowerCase()}`;
  quickSubmitCache.set(key, Date.now());

  for (const [cacheKey, timestamp] of quickSubmitCache.entries()) {
    if (Date.now() - timestamp > quickSubmitWindowMs) quickSubmitCache.delete(cacheKey);
  }
}

function formatDate(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Moscow"
  }).format(new Date(value));
}

function setFlash(res, message, type = "success") {
  const value = Buffer.from(JSON.stringify({ message, type }), "utf8").toString("base64url");
  res.cookie("energy_flash", value, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 10_000 });
}

function consumeFlash(req, res) {
  const raw = readCookie(req, "energy_flash");
  if (!raw) return null;
  res.clearCookie("energy_flash", { path: "/" });
  try {
    return JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function backToAdmin(req) {
  const referer = req.headers.referer || "/admin";
  try {
    const url = new URL(referer);
    return `${url.pathname}${url.search}`.startsWith("/admin") ? `${url.pathname}${url.search}` : "/admin";
  } catch {
    return "/admin";
  }
}

function csvCell(value) {
  const text = String(value ?? "");
  return `"${text.replace(/"/g, '""')}"`;
}
