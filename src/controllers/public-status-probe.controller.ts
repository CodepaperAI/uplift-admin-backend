import type { Request, Response } from "express";

import {
  isPublicStatusComponent,
  runPublicStatusProbe,
} from "../services/public-status-probe.service";

export async function getPublicStatusProbe(req: Request, res: Response): Promise<void> {
  const component = req.params.component ?? "";
  if (!isPublicStatusComponent(component)) {
    res.status(404).json({ success: false, error: "Not found" });
    return;
  }
  const result = await runPublicStatusProbe(component);
  res.status(result.ok ? 200 : 503).json({
    success: result.ok,
    component: result.component,
    status: result.ok ? "operational" : "unavailable",
    checkedAt: result.checkedAt,
  });
}
