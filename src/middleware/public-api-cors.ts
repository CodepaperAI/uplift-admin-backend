import type { NextFunction, Request, Response } from "express";

function normalizeOrigin(value?: string | null): string | null {
    const origin = value?.trim().replace(/^"+|"+$/g, "");
    return origin ? origin.replace(/\/+$/, "") : null;
}

function getAllowedPublicOrigins(): Set<string> {
    return new Set(
        [
            "http://localhost:3000",
            "http://localhost:3001",
            "http://localhost:3002",
            "https://dashboard.upliftai.co",
            "https://upliftai.co",
            "https://www.upliftai.co",
            "https://dashboard.dev.upliftai.co",
            "https://app.dev.upliftai.co",
            normalizeOrigin(process.env.FRONTEND_URL),
            normalizeOrigin(process.env.NEXT_PUBLIC_APP_URL),
            ...(process.env.CORS_ALLOWED_ORIGINS ?? "")
                .split(",")
                .map(normalizeOrigin),
        ].filter((origin): origin is string => Boolean(origin)),
    );
}

// Framer plugins execute from Framer-controlled sandbox origins. Keep this
// deliberately narrower than a wildcard so credential-bearing plugin calls
// cannot be read by an arbitrary website.
const FRAMER_PUBLIC_ORIGIN =
    /^https:\/\/([a-z0-9-]+\.)?framer\.(com|app|website|wiki)$/i;

export function publicApiCors(
    req: Request,
    res: Response,
    next: NextFunction
) {
    const origin = normalizeOrigin(req.headers.origin);
    if (
        origin &&
        (getAllowedPublicOrigins().has(origin) || FRAMER_PUBLIC_ORIGIN.test(origin))
    ) {
        res.setHeader("Access-Control-Allow-Origin", origin);
    }
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With, Accept, Origin, X-API-Key, X-Plugin-Nonce");
    res.setHeader("Access-Control-Max-Age", "86400");

    if (req.method === "OPTIONS") {
        return res.status(200).end();
    }

    next();
}
