/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Copyright © 2026 Inkdex */
import { CloudflareError, PaperbackInterceptor } from "@paperback/types";
import { addDataReceived } from "./settings";
import { ImageUriResolver } from "./utils/uri";
const hitomiInterceptorNoticeTimestamps = new Map();
const HITOMI_CDN_DOMAIN = "gold-usergeneratedcontent.net";
function isHitomiCdnUrl(url) {
    try {
        const host = new URL(url).hostname.toLowerCase();
        return host === HITOMI_CDN_DOMAIN || host.endsWith(`.${HITOMI_CDN_DOMAIN}`);
    }
    catch {
        return false;
    }
}
function logHitomiInterceptorNotice(key, message, minimumIntervalMs = 15000) {
    const now = Date.now();
    const last = hitomiInterceptorNoticeTimestamps.get(key) ?? 0;
    if (now - last < minimumIntervalMs) {
        return;
    }
    hitomiInterceptorNoticeTimestamps.set(key, now);
    console.log(message);
}
export class HitomiInterceptor extends PaperbackInterceptor {
    static FALLBACK_IMAGE_URL = "https://ltn.gold-usergeneratedcontent.net/favicon-192x192.png";
    syncGGCallback = null;
    cookieHeaderProvider = null;
    // Set to true when a CDN 404/403 signals that gg.js has rotated
    ggRefreshNeeded = false;
    // Download pacing to avoid CDN 503/429 bursts during long chapter downloads.
    imageThrottleChain = Promise.resolve();
    imageNextAllowedAt = 0;
    activeImageRequests = 0;
    pendingImageRequestResolvers = [];
    activeImageRequestLeases = new Set();
    nextImageRequestLeaseId = 1;
    rateLimitBackoffUntil = 0;
    rateLimitStrikeCount = 0;
    lastStrikeTime = 0;
    cachedUserAgent = null;
    MAX_CONCURRENT_IMAGE_REQUESTS = 8;
    IMAGE_REQUEST_LEASE_TIMEOUT_MS = 1600;
    IMAGE_MIN_INTERVAL_MS = 16;
    IMAGE_DOWNLOAD_EXTRA_INTERVAL_MS = 10;
    IMAGE_JITTER_MAX_MS = 8;
    MAX_BACKOFF_MS = 1200;
    STRIKE_DECAY_MS = 30000;
    setSyncGG(fn) {
        this.syncGGCallback = fn;
    }
    setCookieHeaderProvider(fn) {
        this.cookieHeaderProvider = fn;
    }
    // Reset rate limiting state - call this on app restart/reinit
    resetRateLimitState() {
        this.rateLimitBackoffUntil = 0;
        this.rateLimitStrikeCount = 0;
        this.lastStrikeTime = 0;
        this.imageNextAllowedAt = 0;
        this.imageThrottleChain = Promise.resolve();
        this.activeImageRequests = 0;
        this.pendingImageRequestResolvers = [];
        this.activeImageRequestLeases.clear();
        this.nextImageRequestLeaseId = 1;
    }
    async interceptRequest(request) {
        if (!this.cachedUserAgent) {
            this.cachedUserAgent = await Application.getDefaultUserAgent();
        }
        request.headers = {
            ...request.headers,
            Referer: "https://hitomi.la/",
            "User-Agent": this.cachedUserAgent,
        };
        if (this.cookieHeaderProvider && request.url.startsWith("http")) {
            const cookieHeader = this.cookieHeaderProvider(request.url);
            if (cookieHeader) {
                request.headers = {
                    ...request.headers,
                    Cookie: cookieHeader,
                };
            }
        }
        // Rewrite lazy-placeholder URLs to real CDN URLs at download time.
        // This ensures fresh gg.js values are used for every image, preventing
        // failures when Hitomi rotates gg.js mid-chapter-download.
        const isImagePlaceholder = request.url.startsWith("hitomi://image/");
        const isThumbPlaceholder = request.url.startsWith("hitomi://thumb/");
        if (isImagePlaceholder || isThumbPlaceholder) {
            if (this.syncGGCallback && (this.ggRefreshNeeded || ImageUriResolver.needsSync())) {
                if (this.ggRefreshNeeded) {
                    ImageUriResolver.invalidate();
                }
                try {
                    await this.syncGGCallback();
                    if (ImageUriResolver.needsSync()) {
                        throw new Error("ImageUriResolver synchronization did not complete");
                    }
                    this.ggRefreshNeeded = false;
                }
                catch (e) {
                    console.warn("[Hitomi] interceptRequest: syncGG failed", e);
                    request.url = HitomiInterceptor.FALLBACK_IMAGE_URL;
                    return request;
                }
            }
            const rest = request.url.slice(isImagePlaceholder ? "hitomi://image/".length : "hitomi://thumb/".length);
            const parts = rest.split("/").filter((p) => p.length > 0);
            if (parts.length < 2) {
                console.warn("[Hitomi] interceptRequest: malformed placeholder URL", request.url);
                request.url = HitomiInterceptor.FALLBACK_IMAGE_URL;
                return request;
            }
            const hash = parts[0];
            const extRaw = parts[1].toLowerCase();
            const ext = extRaw === "avif" ? "avif" : "webp";
            const thumbSizeRaw = parts[2]?.toLowerCase();
            const isSmallThumb = thumbSizeRaw === "small";
            // Validate hash is not empty
            if (!hash || hash.length < 3) {
                console.warn("[Hitomi] interceptRequest: invalid hash in placeholder", hash);
                request.url = HitomiInterceptor.FALLBACK_IMAGE_URL;
                return request;
            }
            const file = {
                index: 0,
                hash,
                name: `image.${ext}`,
                hasWebp: ext === "webp",
                hasAvif: ext === "avif",
                width: 0,
                height: 0,
            };
            try {
                const resolvedUrl = ImageUriResolver.getImageUri(file, ext, {
                    isThumbnail: isThumbPlaceholder,
                    isSmall: isThumbPlaceholder ? isSmallThumb : false,
                });
                // Ensure we got a valid HTTPS URL back
                if (resolvedUrl && resolvedUrl.startsWith("https://")) {
                    request.url = resolvedUrl;
                }
                else {
                    console.warn("[Hitomi] interceptRequest: getImageUri returned invalid URL", resolvedUrl);
                    request.url = HitomiInterceptor.FALLBACK_IMAGE_URL;
                }
            }
            catch (e) {
                console.warn("[Hitomi] interceptRequest: getImageUri failed for", hash, ext, e);
                request.url = HitomiInterceptor.FALLBACK_IMAGE_URL;
            }
        }
        if (this.isFullSizeCdnImageRequest(request.url)) {
            await this.refreshResolvedImageRequestUrl(request);
        }
        if (this.isFullSizeCdnImageRequest(request.url)) {
            const leaseId = await this.acquireImageRequestSlot();
            request.__hitomiLeaseId = leaseId;
            try {
                await this.reserveImageRequestSlot();
            }
            catch (e) {
                this.releaseImageRequestLease(leaseId);
                throw e;
            }
        }
        return request;
    }
    async interceptResponse(request, response, data) {
        const bodyBytes = data && typeof data.byteLength === "number" ? Number(data.byteLength) : 0;
        const contentLengthBytes = this.extractResponseContentLength(response);
        const accountedBytes = bodyBytes > 0 ? bodyBytes : contentLengthBytes;
        if (accountedBytes > 0) {
            addDataReceived(accountedBytes);
        }
        if (response !== null && typeof response === "object" && "headers" in response) {
            const headers = response.headers;
            if (headers?.["cf-mitigated"] === "challenge") {
                throw new CloudflareError({
                    url: request.url,
                    method: request.method ?? "GET",
                    headers: { "user-agent": await Application.getDefaultUserAgent() },
                });
            }
        }
        // Detect CDN 404/403: indicates gg.js has been rotated server-side.
        // Flag so the next placeholder URL triggers a fresh gg.js sync before
        // computing the real CDN URL.
        if (response !== null &&
            typeof response === "object" &&
            "status" in response &&
            typeof response.status === "number") {
            const status = response.status;
            if (this.isFullSizeCdnImageRequest(request.url)) {
                const now = Date.now();
                // Decay strikes over time - if no issues for STRIKE_DECAY_MS, reduce strike count
                if (this.lastStrikeTime > 0 && now - this.lastStrikeTime > this.STRIKE_DECAY_MS) {
                    this.rateLimitStrikeCount = Math.max(0, this.rateLimitStrikeCount - 2);
                    if (this.rateLimitStrikeCount === 0) {
                        this.rateLimitBackoffUntil = 0; // Clear backoff when strikes cleared
                    }
                }
                if (status === 429 || status === 503) {
                    this.rateLimitStrikeCount = Math.min(4, this.rateLimitStrikeCount + 1); // Max 4 strikes
                    this.lastStrikeTime = now;
                    const cooldownMs = Math.min(this.MAX_BACKOFF_MS, 300 * 2 ** (this.rateLimitStrikeCount - 1));
                    this.rateLimitBackoffUntil = now + cooldownMs;
                    logHitomiInterceptorNotice("hitomi-interceptor:cooldown", `[Hitomi] CDN ${status} detected — applying ${cooldownMs}ms cooldown (strike ${this.rateLimitStrikeCount})`, 10000);
                }
                else if (status >= 200 && status < 300) {
                    // Successful request - decay strikes faster
                    this.rateLimitStrikeCount = Math.max(0, this.rateLimitStrikeCount - 1);
                    if (this.rateLimitStrikeCount === 0) {
                        this.rateLimitBackoffUntil = 0;
                    }
                }
            }
            if ((status === 404 || status === 403) &&
                isHitomiCdnUrl(request.url) &&
                !request.url.includes("gg.js") &&
                !request.url.includes(".nozomi")) {
                logHitomiInterceptorNotice("hitomi-interceptor:gg-refresh", "[Hitomi] CDN 404/403 detected — gg.js refresh scheduled for next image", 10000);
                this.ggRefreshNeeded = true;
            }
        }
        if (this.isFullSizeCdnImageRequest(request.url)) {
            const leaseId = request.__hitomiLeaseId;
            if (leaseId !== undefined) {
                this.releaseImageRequestLease(leaseId);
            }
        }
        return data;
    }
    isCdnImageRequest(url) {
        if (!isHitomiCdnUrl(url))
            return false;
        if (url.includes("gg.js") || url.includes(".nozomi"))
            return false;
        // Only pace real image payload requests. Do not classify gallery JS or index files as image traffic.
        return /\.(?:webp|avif)(?:\?|$)/i.test(url);
    }
    isFullSizeCdnImageRequest(url) {
        if (!this.isCdnImageRequest(url)) {
            return false;
        }
        const parsed = this.parseImageRequestUrl(url);
        return parsed ? !parsed.isThumbnail : true;
    }
    async acquireImageRequestSlot() {
        const grantSlot = () => {
            this.activeImageRequests++;
            const leaseId = this.nextImageRequestLeaseId++;
            this.activeImageRequestLeases.add(leaseId);
            this.startImageRequestLeaseTimer(leaseId);
            return leaseId;
        };
        if (this.activeImageRequests < this.MAX_CONCURRENT_IMAGE_REQUESTS) {
            return grantSlot();
        }
        const waiter = {
            resolve: () => {
                return;
            },
            granted: false,
        };
        const gate = new Promise((resolve) => {
            waiter.resolve = resolve;
        });
        this.pendingImageRequestResolvers.push(waiter);
        await gate;
        return grantSlot();
    }
    releaseImageRequestLease(leaseId) {
        if (!this.activeImageRequestLeases.delete(leaseId)) {
            return;
        }
        if (this.activeImageRequests > 0) {
            this.activeImageRequests--;
        }
        while (this.pendingImageRequestResolvers.length > 0) {
            const next = this.pendingImageRequestResolvers.shift();
            if (!next) {
                continue;
            }
            next.granted = true;
            next.resolve();
            break;
        }
    }
    startImageRequestLeaseTimer(leaseId) {
        void this.sleep(this.IMAGE_REQUEST_LEASE_TIMEOUT_MS).then(() => {
            if (!this.activeImageRequestLeases.has(leaseId)) {
                return;
            }
            logHitomiInterceptorNotice("hitomi-interceptor:lease-timeout", "[Hitomi] Releasing stale image request slot after timeout", 10000);
            this.releaseImageRequestLease(leaseId);
        });
    }
    async reserveImageRequestSlot() {
        await this.enqueueImageSlot(async () => {
            const now = Date.now();
            const waitForBackoff = Math.max(0, this.rateLimitBackoffUntil - now);
            const waitForPacing = Math.max(0, this.imageNextAllowedAt - now);
            const waitMs = Math.max(waitForBackoff, waitForPacing);
            if (waitMs > 0) {
                await this.sleep(waitMs);
            }
            const jitter = Math.floor(Math.random() * this.IMAGE_JITTER_MAX_MS);
            const extraIntervalMs = this.activeImageRequests >= this.MAX_CONCURRENT_IMAGE_REQUESTS - 2
                ? this.IMAGE_DOWNLOAD_EXTRA_INTERVAL_MS
                : 0;
            this.imageNextAllowedAt = Date.now() + this.IMAGE_MIN_INTERVAL_MS + extraIntervalMs + jitter;
        });
    }
    async enqueueImageSlot(fn) {
        let release = () => undefined;
        const gate = new Promise((resolve) => {
            release = resolve;
        });
        const previous = this.imageThrottleChain;
        this.imageThrottleChain = previous.then(() => gate);
        await previous;
        try {
            await fn();
        }
        finally {
            release();
        }
    }
    sleep(ms) {
        if (ms <= 0) {
            return Promise.resolve();
        }
        return Application.sleep(ms / 1000);
    }
    async refreshResolvedImageRequestUrl(request) {
        if (!(this.ggRefreshNeeded || ImageUriResolver.needsSync()) || !this.syncGGCallback) {
            return;
        }
        const parsed = this.parseImageRequestUrl(request.url);
        if (!parsed) {
            return;
        }
        if (this.ggRefreshNeeded) {
            ImageUriResolver.invalidate();
        }
        try {
            await this.syncGGCallback();
            if (ImageUriResolver.needsSync()) {
                throw new Error("ImageUriResolver synchronization did not complete");
            }
            const refreshedUrl = ImageUriResolver.getImageUri(parsed.file, parsed.extension, {
                isThumbnail: parsed.isThumbnail,
                isSmall: parsed.isSmall,
            });
            if (refreshedUrl.startsWith("https://")) {
                request.url = refreshedUrl;
                this.ggRefreshNeeded = false;
            }
        }
        catch (e) {
            console.warn("[Hitomi] interceptRequest: failed to refresh stale image URL", e);
        }
    }
    parseImageRequestUrl(url) {
        const match = url.match(/^(?:https?:\/\/)?[^/]+\/(.+?)\.(webp|avif)(?:\?.*)?$/i);
        if (!match) {
            return null;
        }
        const path = match[1];
        const extension = match[2].toLowerCase();
        const segments = path.split("/");
        const hash = segments[segments.length - 1];
        if (!hash || hash.length < 3) {
            return null;
        }
        const isSmall = path.includes("smalltn/");
        const isThumbnail = isSmall || path.includes("bigtn/");
        return {
            extension,
            isThumbnail,
            isSmall,
            file: {
                index: 0,
                hash,
                name: `image.${extension}`,
                hasWebp: extension === "webp",
                hasAvif: extension === "avif",
                width: 0,
                height: 0,
            },
        };
    }
    extractResponseContentLength(response) {
        if (!response || typeof response !== "object") {
            return 0;
        }
        const headers = response.headers;
        if (!headers || typeof headers !== "object") {
            return 0;
        }
        const map = headers;
        const value = map["Content-Length"] ?? map["content-length"] ?? map["CONTENT-LENGTH"];
        if (typeof value === "number" && Number.isFinite(value) && value > 0) {
            return Math.floor(value);
        }
        if (typeof value === "string") {
            const parsed = Number.parseInt(value, 10);
            if (Number.isFinite(parsed) && parsed > 0) {
                return parsed;
            }
        }
        return 0;
    }
}
