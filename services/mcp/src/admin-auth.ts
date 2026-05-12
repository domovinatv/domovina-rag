// Admin auth middleware za /admin* namespace.
//
// Dvije razine:
//  - ADMIN_API_KEY nije configured  → 404 (admin disabled, ne fingerprint-aj postojanje).
//  - Bearer header ne matcha key    → 401.
//
// NE koristi OAuth jer admin operacije su authorization-server management, ne resource
// access — drugi trust boundary. Solo deploy → jedan ključ.

import type { Request, Response, NextFunction } from "express";

export function makeRequireAdmin(adminApiKey: string | null) {
  return function requireAdmin(req: Request, res: Response, next: NextFunction): void {
    if (!adminApiKey) {
      res.status(404).end();
      return;
    }
    const auth = req.header("authorization") ?? "";
    if (auth !== `Bearer ${adminApiKey}`) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  };
}
