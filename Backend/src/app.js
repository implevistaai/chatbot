import express from "express";
import cors from "cors";
import jwt from "jsonwebtoken";
import cookieParser from "cookie-parser";

import { chatRoutes } from "./routes/chat.routes.js";
import { sapRoutes } from "./routes/sap.routes.js";
import { poExtractRoutes } from "./routes/poextract.routes.js";
import { s4dPoRoutes } from "./routes/s4d.po.routes.js";
import solmanReleaseTransportRoutes from "./routes/solman.release-transport.routes.js";
import solmanRoutes from "./routes/solman.routes.js";
import { procurementQueryController } from "./controllers/procurement.query.controller.js";
import { handleChatStream } from "./controllers/chat.stream.controller.js";

import { errorHandler } from "./middleware/errorHandler.js";
import { requireAuth } from "./middleware/requireAuth.js";
import { signAccessToken, signRefreshToken } from "./services/auth/jwt.service.js";
import { validateRefreshCookie } from "./services/auth/auth.service.js";

export const app = express();

// --------------------
// CORS
// --------------------
app.use(
  cors({
    origin: [
      "http://localhost:5173",
      "http://127.0.0.1:5173",
      "http://localhost:5174",
      "http://127.0.0.1:5174",
      "http://localhost:5175",
      "http://127.0.0.1:5175",
      "http://localhost:5176",
      "http://127.0.0.1:5176",
      "http://192.168.1.59:5173",
    ],
    credentials: true,
    exposedHeaders: ["x-access-token", "x-auth-refreshed"],
  })
);

// --------------------
// Cookies
// --------------------
app.use(cookieParser());

// --------------------
// JSON parser
// --------------------
app.use(express.json({ limit: "2mb" }));

// --------------------
// Health check
// --------------------
app.get("/health", (req, res) => {
  res.json({ ok: true, service: "sap-chat", ts: new Date().toISOString() });
});

// --------------------
// DEV LOGIN
// --------------------
if (process.env.NODE_ENV !== "production") {
  app.post("/auth/dev-login", (req, res) => {
    const username = String(req.body?.username || "dev").trim() || "dev";

    const accessToken = signAccessToken({ id: username, username });
    const refreshToken = signRefreshToken({ id: username, username, type: "refresh" });

    res.cookie("refreshToken", refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });

    return res.json({ ok: true, accessToken });
  });

  app.post("/auth/refresh", (req, res) => {
    try {
      const payload = validateRefreshCookie(req.cookies?.refreshToken);
      const accessToken = signAccessToken({ id: payload.id, username: payload.username || payload.id });

      return res.json({ ok: true, accessToken });
    } catch (error) {
      return res.status(error.status || 401).json({ ok: false, error: "Your session has expired. Please login again.", code: error.code || "TOKEN_EXPIRED" });
    }
  });
}

// --------------------
// ROUTES
// --------------------
app.use("/api/solman", requireAuth, solmanRoutes);
app.use("/api/solman", solmanReleaseTransportRoutes);
app.use("/api/s4d", requireAuth, s4dPoRoutes);
app.use("/sap", requireAuth, sapRoutes);

app.post("/chat/stream", requireAuth, handleChatStream);
app.post("/api/query", requireAuth, procurementQueryController);
app.use("/chat", requireAuth, chatRoutes);
app.use("/po", requireAuth, poExtractRoutes);

// --------------------
// 404 fallback
// --------------------
app.use((req, res) => res.status(404).json({ ok: false, error: "Not found" }));

// --------------------
// Error handler
// --------------------
app.use(errorHandler);