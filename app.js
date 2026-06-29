/**
 * FinTrack Pro - Personal Finance Tracker
 * Backend: Express.js + Google Sheets API + Google Drive API
 * Author: Built with Claude
 */

// ============================================================
// DEPENDENCIES
// ============================================================
const express = require("express");
const multer = require("multer");
const { google } = require("googleapis");
const path = require("path");
const fs = require("fs");
const stream = require("stream");

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================
// MIDDLEWARE
// ============================================================
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Multer - store files in memory for direct Drive upload
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
  fileFilter: (req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/jpg", "image/webp"];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error("Only image files are allowed"));
  },
});

// ============================================================
// CONFIGURATION STORE (in-memory, saved to config.json)
// ============================================================
const CONFIG_FILE = path.join(__dirname, "config.json");

let config = {
  sheetId: "",
  sheetName: "Transactions",
  driveFolderId: "",
  credentials: null,
};

// Load config if exists
if (fs.existsSync(CONFIG_FILE)) {
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch (e) {
    console.log("No existing config found, starting fresh.");
  }
}

function saveConfig() {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

// ============================================================
// GOOGLE AUTH HELPER
// ============================================================
function getGoogleAuth() {
  if (!config.credentials) throw new Error("Google credentials not configured");
  const auth = new google.auth.GoogleAuth({
    credentials: config.credentials,
    scopes: [
      "https://www.googleapis.com/auth/spreadsheets",
      "https://www.googleapis.com/auth/drive",
    ],
  });
  return auth;
}

// ============================================================
// GOOGLE SHEETS HELPERS
// ============================================================

/**
 * Ensure the sheet has the correct header row
 */
async function ensureHeaders(sheets) {
  const headers = [
    "Sl No.",
    "Date",
    "Time",
    "Description",
    "Credit (+)",
    "Debit (-)",
    "Balance",
    "Payment Screenshot",
    "Transaction Success Screenshot",
  ];

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: config.sheetId,
    range: `${config.sheetName}!A1:I1`,
  });

  const row = res.data.values?.[0] || [];
  if (row.length === 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: config.sheetId,
      range: `${config.sheetName}!A1:I1`,
      valueInputOption: "RAW",
      requestBody: { values: [headers] },
    });
  }
}

/**
 * Get all transaction rows from sheet
 */
async function getAllRows(sheets) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: config.sheetId,
    range: `${config.sheetName}!A2:I`,
  });
  return res.data.values || [];
}

/**
 * Calculate next serial number and running balance
 */
async function getNextSlAndBalance(sheets) {
  const rows = await getAllRows(sheets);
  const sl = rows.length + 1;
  let balance = 0;
  if (rows.length > 0) {
    const lastRow = rows[rows.length - 1];
    balance = parseFloat(lastRow[6]) || 0;
  }
  return { sl, balance };
}

// ============================================================
// GOOGLE DRIVE HELPERS
// ============================================================

/**
 * Upload a file buffer to Google Drive and return shareable link
 */
async function uploadToDrive(auth, buffer, filename, mimetype) {
  const drive = google.drive({ version: "v3", auth });

  const bufferStream = new stream.PassThrough();
  bufferStream.end(buffer);

  // Build requestBody — add folder if configured
  const requestBody = { name: filename, mimeType: mimetype };
  if (config.driveFolderId) requestBody.parents = [config.driveFolderId];

  const res = await drive.files.create({
    requestBody,
    media: { mimeType: mimetype, body: bufferStream },
    fields: "id",
  });

  const fileId = res.data.id;

  // Make file publicly viewable
  await drive.permissions.create({
    fileId,
    requestBody: { role: "reader", type: "anyone" },
  });

  return `https://drive.google.com/file/d/${fileId}/view`;
}

// ============================================================
// API ROUTES
// ============================================================

// --- Serve frontend ---
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// --- Get current config (without credentials for security) ---
app.get("/api/config", (req, res) => {
  res.json({
    sheetId: config.sheetId,
    sheetName: config.sheetName,
    driveFolderId: config.driveFolderId,
    hasCredentials: !!config.credentials,
  });
});

// --- Save config ---
app.post("/api/config", (req, res) => {
  try {
    const { sheetId, sheetName, driveFolderId, credentials } = req.body;

    if (sheetId) config.sheetId = sheetId.trim();
    if (sheetName) config.sheetName = sheetName.trim();
    if (driveFolderId !== undefined) config.driveFolderId = driveFolderId.trim();
    if (credentials) {
      // Accept either raw JSON string or object
      config.credentials =
        typeof credentials === "string" ? JSON.parse(credentials) : credentials;
    }

    saveConfig();
    res.json({ success: true, message: "Configuration saved successfully" });
  } catch (e) {
    res.status(400).json({ success: false, message: "Invalid credentials JSON: " + e.message });
  }
});

// --- Test connection ---
app.get("/api/test-connection", async (req, res) => {
  try {
    if (!config.sheetId || !config.credentials) {
      return res.status(400).json({ success: false, message: "Configuration incomplete" });
    }
    const auth = getGoogleAuth();
    const sheets = google.sheets({ version: "v4", auth });
    await ensureHeaders(sheets);
    res.json({ success: true, message: "Connected to Google Sheets successfully!" });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// --- Get dashboard summary ---
app.get("/api/dashboard", async (req, res) => {
  try {
    if (!config.sheetId || !config.credentials) {
      return res.json({ balance: 0, todayCredit: 0, todayDebit: 0, todayTransactions: 0 });
    }

    const auth = getGoogleAuth();
    const sheets = google.sheets({ version: "v4", auth });
    const rows = await getAllRows(sheets);

    const today = new Date().toLocaleDateString("en-IN", {
      day: "2-digit", month: "2-digit", year: "numeric",
    });

    let balance = 0;
    let todayCredit = 0;
    let todayDebit = 0;
    let todayTransactions = 0;

    rows.forEach((row) => {
      const credit = parseFloat(row[4]) || 0;
      const debit = parseFloat(row[5]) || 0;
      const rowDate = row[1] || "";

      if (rowDate === today) {
        todayCredit += credit;
        todayDebit += debit;
        todayTransactions++;
      }
    });

    if (rows.length > 0) {
      balance = parseFloat(rows[rows.length - 1][6]) || 0;
    }

    res.json({ balance, todayCredit, todayDebit, todayTransactions });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// --- Add transaction ---
app.post(
  "/api/transaction",
  upload.fields([
    { name: "paymentScreenshot", maxCount: 1 },
    { name: "successScreenshot", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const { description, type, amount } = req.body;

      // Validation
      if (!description || description.trim() === "") {
        return res.status(400).json({ success: false, message: "Description is required" });
      }
      if (!amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
        return res.status(400).json({ success: false, message: "Valid amount is required" });
      }
      if (!req.files?.paymentScreenshot) {
        return res.status(400).json({ success: false, message: "Payment screenshot is required" });
      }
      if (!req.files?.successScreenshot) {
        return res.status(400).json({ success: false, message: "Transaction success screenshot is required" });
      }

      const auth = getGoogleAuth();
      const sheets = google.sheets({ version: "v4", auth });

      await ensureHeaders(sheets);

      const { sl, balance } = await getNextSlAndBalance(sheets);
      const parsedAmount = parseFloat(amount);

      const credit = type === "credit" ? parsedAmount : 0;
      const debit = type === "debit" ? parsedAmount : 0;
      const newBalance = type === "credit" ? balance + parsedAmount : balance - parsedAmount;

      const now = new Date();
      const date = now.toLocaleDateString("en-IN", {
        day: "2-digit", month: "2-digit", year: "numeric",
      });
      const time = now.toLocaleTimeString("en-IN", {
        hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true,
      });

      // Upload screenshots to Drive
      const payFile = req.files.paymentScreenshot[0];
      const sucFile = req.files.successScreenshot[0];

      const [payLink, sucLink] = await Promise.all([
        uploadToDrive(auth, payFile.buffer, `pay_${sl}_${Date.now()}`, payFile.mimetype),
        uploadToDrive(auth, sucFile.buffer, `suc_${sl}_${Date.now()}`, sucFile.mimetype),
      ]);

      // Append row to sheet
      await sheets.spreadsheets.values.append({
        spreadsheetId: config.sheetId,
        range: `${config.sheetName}!A:I`,
        valueInputOption: "RAW",
        insertDataOption: "INSERT_ROWS",
        requestBody: {
          values: [[sl, date, time, description.trim(), credit || "", debit || "", newBalance, payLink, sucLink]],
        },
      });

      res.json({
        success: true,
        message: "Transaction saved successfully",
        data: { sl, date, time, balance: newBalance },
      });
    } catch (e) {
      console.error("Transaction error:", e);
      res.status(500).json({ success: false, message: e.message });
    }
  }
);

// --- Get all transactions ---
app.get("/api/transactions", async (req, res) => {
  try {
    if (!config.sheetId || !config.credentials) {
      return res.json({ success: true, data: [] });
    }

    const auth = getGoogleAuth();
    const sheets = google.sheets({ version: "v4", auth });
    const rows = await getAllRows(sheets);

    const transactions = rows.map((row, i) => ({
      sl: row[0] || i + 1,
      date: row[1] || "",
      time: row[2] || "",
      description: row[3] || "",
      credit: parseFloat(row[4]) || 0,
      debit: parseFloat(row[5]) || 0,
      balance: parseFloat(row[6]) || 0,
      paymentScreenshot: row[7] || "",
      successScreenshot: row[8] || "",
    }));

    res.json({ success: true, data: transactions.reverse() }); // newest first
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// --- Get reports ---
app.get("/api/reports/:period", async (req, res) => {
  try {
    if (!config.sheetId || !config.credentials) {
      return res.json({ success: true, data: { totalCredit: 0, totalDebit: 0, balance: 0, count: 0 } });
    }

    const auth = getGoogleAuth();
    const sheets = google.sheets({ version: "v4", auth });
    const rows = await getAllRows(sheets);

    const now = new Date();
    const period = req.params.period; // today | weekly | monthly

    const filtered = rows.filter((row) => {
      if (!row[1]) return false;
      const parts = row[1].split("/");
      if (parts.length !== 3) return false;
      const rowDate = new Date(`${parts[2]}-${parts[1]}-${parts[0]}`);

      if (period === "today") {
        return rowDate.toDateString() === now.toDateString();
      } else if (period === "weekly") {
        const weekAgo = new Date(now);
        weekAgo.setDate(now.getDate() - 7);
        return rowDate >= weekAgo && rowDate <= now;
      } else if (period === "monthly") {
        return rowDate.getMonth() === now.getMonth() && rowDate.getFullYear() === now.getFullYear();
      }
      return false;
    });

    let totalCredit = 0;
    let totalDebit = 0;

    filtered.forEach((row) => {
      totalCredit += parseFloat(row[4]) || 0;
      totalDebit += parseFloat(row[5]) || 0;
    });

    const balance = rows.length > 0 ? parseFloat(rows[rows.length - 1][6]) || 0 : 0;

    res.json({
      success: true,
      data: {
        totalCredit,
        totalDebit,
        balance,
        count: filtered.length,
        period,
      },
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ============================================================
// START SERVER
// ============================================================
app.listen(PORT, () => {
  console.log(`\n🚀 FinTrack Pro running at http://localhost:${PORT}`);
  console.log(`📊 Open your browser and navigate to http://localhost:${PORT}`);
  console.log(`\n📌 First time? Go to Settings to configure Google Sheets.\n`);
});
