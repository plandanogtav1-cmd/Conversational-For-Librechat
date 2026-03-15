/**
 * routes/middleware.ts
 * Simple bearer-token auth for bridge API endpoints.
 */

import { Request, Response, NextFunction } from "express";
import { config } from "../config";

export function requireBridgeSecret(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const auth = req.headers["authorization"] ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";

  if (!token || token !== config.BRIDGE_API_SECRET) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}
