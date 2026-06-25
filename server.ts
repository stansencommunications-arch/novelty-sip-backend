import express, { Request, Response } from "express";
import cors from "cors";
import dotenv from "dotenv";
import { v4 as uuidv4 } from "uuid";
import { SIPServer } from "./sipServer";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({
  origin: process.env.CORS_ORIGIN?.split(",") || "*",
  credentials: true
}));
app.use(express.json());

// Initialize SIP Server
const sipServer = new SIPServer(
  process.env.YEASTER_HOST || "192.168.1.250",
  parseInt(process.env.YEASTER_PORT || "8088"),
  process.env.YEASTER_SIP_USERNAME || "1000",
  process.env.YEASTER_SIP_PASSWORD || "",
  process.env.YEASTER_DOMAIN || "192.168.1.250"
);

// Track active calls
const callMap = new Map<string, { startTime: Date; toNumber: string }>();

// ===== HEALTH CHECK =====
app.get("/health", (req: Request, res: Response) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ===== SIP STATUS =====
app.get("/api/sip/status", (req: Request, res: Response) => {
  res.json({
    connected: sipServer ? true : false,
    timestamp: new Date().toISOString()
  });
});

// ===== MAKE CALL =====
app.post("/api/calls/make", async (req: Request, res: Response) => {
  const { toNumber } = req.body;

  if (!toNumber) {
    return res.status(400).json({ error: "toNumber required" });
  }

  const callId = uuidv4();
  const result = await sipServer.makeCall(toNumber, callId);

  if (result.success) {
    callMap.set(callId, {
      startTime: new Date(),
      toNumber
    });
    return res.json({ callId, ...result });
  } else {
    return res.status(500).json(result);
  }
});

// ===== END CALL =====
app.post("/api/calls/end", async (req: Request, res: Response) => {
  const { callId } = req.body;

  if (!callId) {
    return res.status(400).json({ error: "callId required" });
  }

  const result = await sipServer.endCall(callId);
  callMap.delete(callId);
  res.json(result);
});

// ===== CALL STATUS =====
app.get("/api/calls/:callId/status", (req: Request, res: Response) => {
  const { callId } = req.params;
  const status = sipServer.getCallStatus(callId);

  if (!status) {
    return res.status(404).json({ error: "Call not found" });
  }

  res.json(status);
});

// ===== START SERVER =====
app.listen(PORT, async () => {
  console.log(`[Server] 🚀 Novelty SIP Backend started on port ${PORT}`);

  try {
    await sipServer.connect();
    console.log("[Server] ✅ Ready for calls");
  } catch (error) {
    console.error("[Server] ⚠️  SIP connection failed (running in fallback mode):", error);
  }
});

process.on("SIGINT", async () => {
  console.log("[Server] Shutting down...");
  await sipServer.disconnect();
  process.exit(0);
});

export default app;
