/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Copyright © 2026 Inkdex */
import { BasicRateLimiter, CloudflareError, ContentRating, DiscoverSectionType, InputRow, LabelRow, Section, TriStateSelectSection, } from "@paperback/types";
import { SearchFilterForm, } from "@paperback/types/lib/compat/0.8/searchFilters";
import { closureSelector } from "@paperback/types/lib/impl/Selector.js";
import { SettingsForm } from "./forms";
import { NHentaiInterceptor } from "./interceptors";
import * as NHentaiSettings from "./settings";
import { addDescMarkedReadId, ALL_DISCOVER_SECTIONS, DATE_FILTER_PRESETS, DISCOVER_TO_SORT_MAP, ensureInstallDate, formatDateByPattern, getAddTagsToDescriptionSetting, getAllRereadManga, getApiKeyAuthorizedSetting, getDateFormatSetting, getDaysOldFilterSetting, getDefaultSearchSortSetting, getDescMarkedReadIds, getDiscoverCarouselTilesSetting, getDiscoverPageTilesSetting, getDiscoverSectionOrder, getDisplayOptionsSetting, getEnableRelatedSetting, getEnableRereadSectionSetting, getExtraArgumentsSetting, getFavoritesThresholdMaxSetting, getFavoritesThresholdSetting, getHiddenSections, getHideReadInRelatedSetting, getHideReadSetting, getIncludeOrGroups, getIncognitoModeSetting, getLanguageAbbreviationFromSlug, getLanguageQueryTokens, getLanguageSetting, getMarkReadOnViewSetting, getNHentaiApiKey, getPagesExpressionSetting, getRateLimitLiteFallbackSetting, getRelatedLanguageSetting, getRemoveSeparatorSpacesSetting, getRereadCount, getSearchFilterDate, getSearchFilterFavorites, getSearchFilterLength, getSearchFilterTags, getSearchPageTilesSetting, getStatsTrackingEnabledSetting, getThumbnailQualitySetting, incrementDisplayedManga, incrementMarkReadOnDescCount, parsePagesExpression, recordMangaReadCount, recordPageCount, recordReadingSession, recordTagCounts, removeDescMarkedReadId, setRelatedLanguageSetting, setSearchFilterDate, setSearchFilterFavorites, setSearchFilterLength, setSearchFilterRelatedLanguage, setSearchFilterTags, SORT_OPTIONS, } from "./settings";
import { parseRetryAfterMs } from "./utils/http";
class InlineSearchFilterForm extends SearchFilterForm {
    getSections() {
        if (!this.filters) {
            return [Section("loading", [LabelRow("loading", { title: "Loading Filters" })])];
        }
        if (this.filters instanceof Error) {
            return [
                Section("error", [
                    LabelRow("error", {
                        title: "Error loading search filters",
                        subtitle: this.filters.message,
                    }),
                ]),
            ];
        }
        return this.filters.map((filter) => {
            switch (filter.type) {
                case "dropdown": {
                    const selectedOptionId = (this.selectedFilterValues[filter.id] ?? filter.value);
                    return Section({ id: filter.id, header: filter.title }, filter.options.map((option) => LabelRow(option.id, {
                        title: option.value,
                        value: selectedOptionId === option.id ? "✓" : undefined,
                        onSelect: closureSelector(this, `${filter.id}#${option.id}`, async () => {
                            this.selectedFilterValues[filter.id] = option.id;
                            this.reloadForm();
                        }),
                    })));
                }
                case "multiselect": {
                    if (!this.selectedFilterValues[filter.id]) {
                        this.selectedFilterValues[filter.id] = { ...filter.value };
                    }
                    const value = this.selectedFilterValues[filter.id];
                    return TriStateSelectSection(this, {
                        id: filter.id,
                        header: filter.title,
                        layout: "flow",
                        value,
                        items: filter.options.map((o) => ({ id: o.id, title: o.value })),
                        allowExclusion: filter.allowExclusion,
                        allowEmptySelection: filter.allowEmptySelection,
                        maximum: filter.maximum ?? undefined,
                    });
                }
                case "input": {
                    const value = (this.selectedFilterValues[filter.id] ?? filter.value);
                    return Section({ id: filter.id, header: filter.title }, [
                        InputRow(filter.id, {
                            title: filter.title,
                            value,
                            onValueChange: closureSelector(this, filter.id, async (newValue) => {
                                this.selectedFilterValues[filter.id] = newValue;
                                this.reloadForm();
                            }),
                        }),
                    ]);
                }
            }
        });
    }
}
const DOMAIN = "https://nhentai.net";
const API_V2_URL = `${DOMAIN}/api/v2`;
const EMPTY_QUERY = '""';
const READ_STATE_KEY = "nhentai.readHistory";
const COOKIE_JAR_STATE_KEY = "nhentai.cookieJar";
const RELATED_VIEW_COUNTS_KEY = "nhentai.relatedViewCounts";
const CDN_IMAGE_SERVERS_STATE_KEY = "nhentai.cdn.imageServers";
const CDN_THUMB_SERVERS_STATE_KEY = "nhentai.cdn.thumbServers";
const CDN_TS_STATE_KEY = "nhentai.cdn.ts";
const CDN_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 1 day
// Default tile counts before user settings are available.
const DEFAULT_CAROUSEL_TILES = 4;
const DEFAULT_DISCOVER_PAGE_SIZE = 9;
const DEFAULT_SEARCH_PAGE_SIZE = 9;
const MAX_SEARCH_PAGES = 50; // Max API pages to search through when filtering
const SEARCH_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours; search pages are safe to reuse across app restarts
const SEARCH_CACHE_STATE_KEY = "nhentai.searchCache.v1";
const TILE_STORE_STATE_KEY = "nhentai.tileStore.v1";
// Keep initial discover burst to one request per section to manage rate limits.
// With 6 discover sections (Popular, Recent, Random, etc.), this prevents burst 429s.
const DISCOVER_FETCH_INITIAL_BATCH_SIZE = 1;
const DISCOVER_FETCH_BATCH_SIZE = 1;
// Track how many times each related manga has been shown in the carousel
let relatedViewCounts;
function getCarouselTiles() {
    const value = getDiscoverCarouselTilesSetting();
    if (!Number.isFinite(value))
        return DEFAULT_CAROUSEL_TILES;
    return Math.max(1, Math.min(6, Math.floor(value)));
}
function getDiscoverPageSize() {
    const value = getDiscoverPageTilesSetting();
    if (!Number.isFinite(value))
        return DEFAULT_DISCOVER_PAGE_SIZE;
    return Math.max(1, Math.min(12, Math.floor(value)));
}
function getSearchPageSize() {
    const value = getSearchPageTilesSetting();
    if (!Number.isFinite(value))
        return DEFAULT_SEARCH_PAGE_SIZE;
    return Math.max(1, Math.min(16, Math.floor(value)));
}
function getEffectiveOffset(metadata) {
    if (typeof metadata?.scanOffset === "number") {
        return Math.max(0, Math.floor(metadata.scanOffset));
    }
    if (typeof metadata?.offset === "number") {
        return Math.max(0, Math.floor(metadata.offset));
    }
    return 0;
}
function buildOffsetMetadata(displayOffset, scanOffset) {
    return {
        offset: Math.max(0, Math.floor(displayOffset)),
        scanOffset: Math.max(0, Math.floor(scanOffset)),
    };
}
function getRelatedViewCounts() {
    if (!relatedViewCounts) {
        const stored = Application.getState(RELATED_VIEW_COUNTS_KEY);
        relatedViewCounts = new Map(Object.entries(stored ?? {}).map(([k, v]) => [parseInt(k, 10), v]));
    }
    return relatedViewCounts;
}
function incrementRelatedViewCount(id) {
    const counts = getRelatedViewCounts();
    const current = counts.get(id) ?? 0;
    const newCount = current + 1;
    counts.set(id, newCount);
    const obj = {};
    counts.forEach((v, k) => {
        obj[k.toString()] = v;
    });
    Application.setState(obj, RELATED_VIEW_COUNTS_KEY);
    return newCount;
}
const LENGTH_FILTER_OPTIONS = [
    { id: "all", label: "All" },
    { id: "le20", label: "Less than 20 pages", token: "<=20" },
    { id: "gt20", label: "More than 20 pages", token: ">20" },
    { id: "gt40", label: "More than 40 pages", token: ">40" },
    { id: "gt80", label: "More than 80 pages", token: ">80" },
    { id: "gt120", label: "More than 120 pages", token: ">120" },
    { id: "gt200", label: "More than 200 pages", token: ">200" },
];
const FAVORITES_FILTER_OPTIONS = [
    { id: "all", label: "All" },
    { id: "fav_100", label: "More than 100 favorites", token: ">100" },
    { id: "fav_250", label: "More than 250 favorites", token: ">250" },
    { id: "fav_500", label: "More than 500 favorites", token: ">500" },
    { id: "fav_1000", label: "More than 1k favorites", token: ">1000" },
    { id: "fav_2500", label: "More than 2.5k favorites", token: ">2500" },
    { id: "fav_5000", label: "More than 5k favorites", token: ">5000" },
    { id: "fav_7500", label: "More than 7.5k favorites", token: ">7500" },
    { id: "fav_10000", label: "More than 10k favorites", token: ">10000" },
    { id: "fav_20000", label: "More than 20k favorites", token: ">20000" },
    { id: "fav_50000", label: "More than 50k favorites", token: ">50000" },
];
function isSearchFilterValue(value) {
    if (typeof value !== "object" || value === null)
        return false;
    const candidate = value;
    if (typeof candidate.id !== "string")
        return false;
    if (typeof candidate.value === "string")
        return true;
    return typeof candidate.value === "object" && candidate.value !== null;
}
function cleanSearchFilterValues(metadata) {
    if (!Array.isArray(metadata))
        return undefined;
    return metadata.filter(isSearchFilterValue).map((filter) => {
        if (filter.id !== "tags" || typeof filter.value !== "object") {
            return filter;
        }
        const tags = { ...filter.value };
        delete tags["__apply_manga_filter_tags__"];
        return { ...filter, value: tags };
    });
}
function getActiveSearchFilterValues(filters) {
    return filters.filter((filter) => {
        if (typeof filter.value === "string") {
            return filter.value.trim().length > 0 && filter.value !== "all";
        }
        return Object.keys(filter.value).some((key) => key !== "__apply_manga_filter_tags__");
    });
}
const POPULAR_SECTIONS = [
    { id: "popular_today", title: "Popular Today", sort: "popular-today" },
    { id: "popular_week", title: "Popular This Week", sort: "popular-week" },
    { id: "popular_month", title: "Popular This Month", sort: "popular-month" },
    { id: "popular_all", title: "Popular All-Time", sort: "popular" },
];
const POPULAR_TAGS_CACHE_TTL_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
const POPULAR_TAGS_STATE_KEY = "nhentai.popularTagsCache";
const POPULAR_TAGS_TS_STATE_KEY = "nhentai.popularTagsCacheTs";
// Page-1 search cache TTL — short so newly published manga appear promptly
const GALLERY_CACHE_PAGE1_TTL_MS = 10 * 60 * 1000;
const RATE_LIMIT_WINDOW_SECONDS = 0.1;
// Static limiter defaults reapplied on each extension initialization.
// Backup limiter: fallback for cases where endpoint-specific limiting doesn't apply.
const NHENTAI_BACKUP_API_REQUESTS_PER_SECOND = 18;
// Image rate limiter: separate budget for concurrent image/thumbnail fetches.
const NHENTAI_IMAGE_REQUESTS_PER_SECOND = 24;
/**
 * Per-endpoint burst queues for rate limiting.
 * Each endpoint tracks its own request timestamps to respect individual rate limits.
 * Burst-based: requests fire immediately up to the limit, only waits when limit exceeded.
 */
const burstQueues = {
    search: {
        timestamps: [],
        mutex: Promise.resolve(),
        blockedChecks: 0,
        rateLimitedUntil: 0,
    },
    galleryDetail: {
        timestamps: [],
        mutex: Promise.resolve(),
        blockedChecks: 0,
        rateLimitedUntil: 0,
    },
    media: {
        timestamps: [],
        mutex: Promise.resolve(),
        blockedChecks: 0,
        rateLimitedUntil: 0,
    },
    galleries: {
        timestamps: [],
        mutex: Promise.resolve(),
        blockedChecks: 0,
        rateLimitedUntil: 0,
    },
    random: {
        timestamps: [],
        mutex: Promise.resolve(),
        blockedChecks: 0,
        rateLimitedUntil: 0,
    },
    related: {
        timestamps: [],
        mutex: Promise.resolve(),
        blockedChecks: 0,
        rateLimitedUntil: 0,
    },
    tagged: {
        timestamps: [],
        mutex: Promise.resolve(),
        blockedChecks: 0,
        rateLimitedUntil: 0,
    },
    popular: {
        timestamps: [],
        mutex: Promise.resolve(),
        blockedChecks: 0,
        rateLimitedUntil: 0,
    },
    config: {
        timestamps: [],
        mutex: Promise.resolve(),
        blockedChecks: 0,
        rateLimitedUntil: 0,
    },
    captcha: {
        timestamps: [],
        mutex: Promise.resolve(),
        blockedChecks: 0,
        rateLimitedUntil: 0,
    },
    default: {
        timestamps: [],
        mutex: Promise.resolve(),
        blockedChecks: 0,
        rateLimitedUntil: 0,
    },
};
// Authenticated vs anonymous endpoint limits differ; this table defines the limits for each endpoint class.
const NHENTAI_AUTH_ENDPOINT_LIMITS = {
    search: 20,
    galleryDetail: 45,
    media: 240,
    galleries: 30,
    random: 30,
    related: 30,
    tagged: 30,
    popular: 30,
    config: 30,
    captcha: 12,
    default: 30,
};
const NHENTAI_ANON_ENDPOINT_LIMITS = {
    search: 10,
    galleryDetail: 20,
    media: 180,
    galleries: 15,
    random: 20,
    related: 12,
    tagged: 15,
    popular: 15,
    config: 15,
    captcha: 6,
    default: 15,
};
function hasAuthorizationHeader(request) {
    const headers = request?.headers ?? {};
    const authorization = headers.Authorization ?? headers.authorization;
    return typeof authorization === "string" && /^Key\s+\S+/i.test(authorization);
}
function normalizeNhentaiApiUrl(url) {
    if (url.startsWith("http://nhentai.net/api/v2")) {
        return url.replace(/^http:\/\/nhentai\.net\/api\/v2/i, API_V2_URL);
    }
    return url;
}
function shouldAuthorizeNhentaiApiRequest(request) {
    return (request.url.startsWith(API_V2_URL) &&
        !hasAuthorizationHeader(request) &&
        getApiKeyAuthorizedSetting());
}
function withNhentaiApiAuth(request) {
    const url = normalizeNhentaiApiUrl(request.url);
    const normalizedRequest = url === request.url
        ? request
        : {
            ...request,
            url,
        };
    if (!shouldAuthorizeNhentaiApiRequest(normalizedRequest)) {
        return normalizedRequest;
    }
    const apiKey = getNHentaiApiKey();
    if (!apiKey) {
        return normalizedRequest;
    }
    return {
        ...normalizedRequest,
        headers: {
            ...normalizedRequest.headers,
            Authorization: `Key ${apiKey}`,
        },
    };
}
function getEndpointRateLimit(endpointClass, authenticated = false) {
    return (authenticated ? NHENTAI_AUTH_ENDPOINT_LIMITS : NHENTAI_ANON_ENDPOINT_LIMITS)[endpointClass];
}
function getBackgroundReservedSlots(endpointClass) {
    switch (endpointClass) {
        case "galleryDetail":
            return 2; // Was 3 (effective 17/min anon); now 1 (effective 18/min anon)
        case "search":
        case "galleries":
        case "related":
        case "random":
        case "popular":
        case "tagged":
            return 2;
        default:
            return 0;
    }
}
function classifyEndpoint(url) {
    const mediaPathMatch = url.match(/^https?:\/\/[^/]+\/galleries\/\d+\/(?:thumb|cover|\d+)\.[a-z0-9]+(?:\?|$)/i);
    if (mediaPathMatch) {
        return "media";
    }
    // Extract path from URL
    const pathMatch = url.match(/\/api\/v2\/(.+?)(?:\?|$)/);
    if (!pathMatch)
        return "default";
    const path = pathMatch[1];
    // Search endpoint (20/min - tightened from 30/min on 2026-04-04)
    if (path === "search" || path.startsWith("search?")) {
        return "search";
    }
    if (path === "" || path === "config" || path === "cdn") {
        return "config";
    }
    if (path === "captcha") {
        return "captcha";
    }
    // Related endpoint: /galleries/{id}/related
    if (path.includes("/related")) {
        return "related";
    }
    if (path === "galleries/random" || path.startsWith("galleries/random?")) {
        return "random";
    }
    // Tagged endpoint: /galleries/tagged (30/min)
    if (path === "galleries/tagged" || path.startsWith("galleries/tagged?")) {
        return "tagged";
    }
    // Gallery detail endpoint: /galleries/{id} (45/min)
    // Pattern: galleries/<number> (not followed by /popular, /tagged, /random)
    const galleryDetailMatch = path.match(/^galleries\/(\d+)(?:$|\/pages)/);
    if (galleryDetailMatch) {
        return "galleryDetail";
    }
    // Popular galleries endpoint: /galleries/popular (20/min - same as search)
    if (path === "galleries/popular" || path.startsWith("galleries/popular?")) {
        return "popular";
    }
    // Gallery list/CDN/tags endpoints:
    // - /galleries (list): 30/min
    // - /cdn: generous limits, treat 429 as backoff signal
    // - /tags: 30/min
    if (path.startsWith("galleries") || path.startsWith("cdn") || path.startsWith("tags")) {
        return "galleries";
    }
    return "default";
}
/**
 * Burst-based rate limiting: allows requests to fire as fast as possible
 * up to the rate limit. Only waits when the limit would be exceeded.
 *
 * Key behaviors:
 * 1. Requests fire immediately if under the limit
 * 2. When limit is reached, waits for oldest request to expire (60s window)
 * 3. Mutex ensures concurrent calls don't race past the limit
 */
async function withRateLimit(endpointClass, fn, options) {
    const queue = burstQueues[endpointClass];
    const baseRateLimit = getEndpointRateLimit(endpointClass, options?.authenticated ?? false);
    const reserve = options?.priority === "background" ? getBackgroundReservedSlots(endpointClass) : 0;
    const rateLimit = Math.max(1, baseRateLimit - reserve);
    const WINDOW_MS = 60_000; // 1 minute window
    const MAX_COOLDOWN_MS = 60_000;
    // Mutex to prevent concurrent calls from racing
    let resolveMutex;
    const myMutex = new Promise((resolve) => {
        resolveMutex = resolve;
    });
    const prevMutex = queue.mutex;
    queue.mutex = myMutex;
    let lockReleased = false;
    try {
        await prevMutex;
        const now = Date.now();
        if (queue.rateLimitedUntil > now) {
            const cappedUntil = Math.min(queue.rateLimitedUntil, now + MAX_COOLDOWN_MS);
            queue.rateLimitedUntil = cappedUntil;
            const cooldownMs = cappedUntil - now + 20;
            // Compute current usage in the active window for diagnostics
            const windowStartNow = Date.now() - WINDOW_MS;
            queue.timestamps = queue.timestamps.filter((t) => t > windowStartNow);
            const used = queue.timestamps.length;
            const authText = options?.authenticated ? "Authenticated" : "Unauthenticated";
            console.log(`[NHentai] ${endpointClass} endpoint cooling down after 429 (${used}/${rateLimit}) ${authText}. ` +
                `Waiting ${Math.round(cooldownMs / 1000)}s before next request.`);
            await Application.sleep(cooldownMs / 1000);
        }
        const windowStart = Date.now() - WINDOW_MS;
        // Clean up expired timestamps (older than 1 minute)
        queue.timestamps = queue.timestamps.filter((t) => t > windowStart);
        // Strictly wait for an actual free slot in the 60s window.
        // For /search (30/min), never send early probes that would force extra 429s.
        while (queue.timestamps.length >= rateLimit) {
            const oldestTimestamp = queue.timestamps[0];
            const waitMs = oldestTimestamp + WINDOW_MS - Date.now() + 20;
            if (waitMs > 0) {
                console.log(`[NHentai] Rate limit reached for ${endpointClass} (${queue.timestamps.length}/${rateLimit}). ` +
                    `Waiting ${Math.round(waitMs / 1000)}s for window to reset.`);
                await Application.sleep(waitMs / 1000);
            }
            queue.timestamps = queue.timestamps.filter((t) => t > Date.now() - WINDOW_MS);
        }
        // Record normal budgeted request timestamps.
        queue.timestamps.push(Date.now());
        queue.blockedChecks = 0;
        // Release the admission lock before executing the request so in-flight
        // network calls can overlap while still respecting budget checks.
        resolveMutex();
        lockReleased = true;
        // Execute the actual request.
        // If a request returns 429, cool down only until the next window slot is
        // expected to free up instead of forcing a full minute stall.
        try {
            return await fn();
        }
        catch (error) {
            const message = getErrorMessage(error);
            if (message.includes("429")) {
                const nowOn429 = Date.now();
                queue.timestamps = queue.timestamps.filter((t) => t > nowOn429 - WINDOW_MS);
                const oldestTimestampInWindow = queue.timestamps[0];
                const nextSlotAt = oldestTimestampInWindow !== undefined
                    ? oldestTimestampInWindow + WINDOW_MS + 20
                    : nowOn429 + 500;
                queue.rateLimitedUntil = Math.max(queue.rateLimitedUntil, Math.min(nextSlotAt, nowOn429 + MAX_COOLDOWN_MS));
            }
            throw error;
        }
    }
    finally {
        if (!lockReleased) {
            resolveMutex();
        }
    }
}
/**
 * Non-blocking estimate of available slots in the current 60s window.
 * Used to short-circuit hydration before queuing requests that would stall.
 */
function availableSlotsNow(endpointClass, authenticated, priority) {
    const queue = burstQueues[endpointClass];
    const baseLimit = getEndpointRateLimit(endpointClass, authenticated);
    const reserve = priority === "background" ? getBackgroundReservedSlots(endpointClass) : 0;
    const rateLimit = Math.max(1, baseLimit - reserve);
    const windowStart = Date.now() - 60_000;
    const active = queue.timestamps.filter((t) => t > windowStart).length;
    return Math.max(0, rateLimit - active);
}
// ============================================================================
// Discover Section Staggering
// ============================================================================
// Stagger section loads to reduce initial burst when app launches and respect
// rate limits. Without staggering, 6 concurrent section requests (Popular, Recent,
// Random, etc.) would hit endpoints quickly; spacing them out helps stay under limits.
/**
 * Delay between consecutive discover section requests (milliseconds).
 * Chosen to respect the 20/min rate limit on search/popular endpoints.
 * Staggering 6 sections at 245ms intervals helps distribute the burst.
 */
const SECTION_STAGGER_MS = 80;
/** Maximum time window for sections to join the same stagger wave (milliseconds). */
const SECTION_WAVE_JOIN_WINDOW_MS = 180;
let lastSectionRequestTime = 0;
async function staggeredSectionDelay() {
    if (SECTION_STAGGER_MS <= 0) {
        lastSectionRequestTime = Date.now();
        return;
    }
    const now = Date.now();
    const timeSinceLast = now - lastSectionRequestTime;
    // Progressive stagger: first section goes immediately,
    // subsequent sections wait progressively longer
    const requiredDelay = SECTION_STAGGER_MS;
    if (timeSinceLast < requiredDelay) {
        const waitMs = requiredDelay - timeSinceLast;
        await Application.sleep(waitMs / 1000);
    }
    lastSectionRequestTime = Date.now();
}
const LANGUAGE_TAG_IDS = {
    english: 12227,
    chinese: 29963,
    japanese: 6346,
};
const DEBUG_NHENTAI = typeof globalThis !== "undefined" &&
    globalThis.process?.env
        ?.KAKAROT_DEBUG_NHENTAI === "1";
function logDebug(...args) {
    if (DEBUG_NHENTAI) {
        console.log("[NHentai]", ...args);
    }
}
function hasFavoritesConstraint(constraint) {
    return constraint !== undefined && (constraint.min !== undefined || constraint.max !== undefined);
}
function matchesFavoritesConstraint(gallery, constraint) {
    if (!hasFavoritesConstraint(constraint))
        return true;
    if (constraint.min !== undefined && gallery.num_favorites < constraint.min) {
        return false;
    }
    if (constraint.max !== undefined && gallery.num_favorites > constraint.max) {
        return false;
    }
    return true;
}
function queryContainsFavoritesToken(query) {
    return /\bfavorites\s*:/i.test(query);
}
function interleaveGalleryLists(lists) {
    const seen = new Set();
    const merged = [];
    let added = true;
    while (added) {
        added = false;
        for (const list of lists) {
            const next = list.shift();
            if (!next)
                continue;
            added = true;
            if (seen.has(next.id))
                continue;
            seen.add(next.id);
            merged.push(next);
        }
    }
    return merged;
}
function normalizeBridgeString(value, fallback = "") {
    if (typeof value === "string")
        return value;
    if (typeof value === "number" || typeof value === "boolean") {
        return String(value);
    }
    return fallback;
}
const CREATOR_LANGUAGE_TOKEN_SET = new Set([
    "english",
    "japanese",
    "chinese",
    "korean",
    "spanish",
    "french",
    "german",
    "italian",
    "portuguese",
    "russian",
    "thai",
    "vietnamese",
    "indonesian",
    "turkish",
    "polish",
    "simpchinese",
    "tradchinese",
    "simplifiedchinese",
    "traditionalchinese",
    "en",
    "jp",
    "ja",
    "cn",
    "zh",
    "kr",
    "ko",
    "es",
    "fr",
    "de",
    "it",
    "pt",
    "ru",
    "th",
    "vi",
    "id",
    "tr",
    "pl",
].map((value) => value.toLowerCase()));
function isLanguageLikeCreatorToken(value) {
    const normalized = value.toLowerCase().replace(/[^a-z]/g, "");
    if (!normalized)
        return true;
    return CREATOR_LANGUAGE_TOKEN_SET.has(normalized);
}
/**
 * Derive a display "pretty" title from raw english/japanese search titles.
 * Search results only provide english_title/japanese_title (not API pretty),
 * so strip artist/group prefixes and trailing metadata the same way galleries
 * detail does.
 *
 * Example:
 *   (C105) [Group (Artist)] "Title" | 日本語 (Series) [Chinese] [Group] [Decensored]
 *   → "Title" | 日本語
 */
function toPrettyTitle(raw) {
    if (!raw)
        return "";
    let title = raw.trim();
    if (!title)
        return "";
    // Leading convention codes / artist-group brackets:
    // (C105), (Street Fighter 6), [jigokuno], [Group (Various artists)]
    let previous = "";
    while (title !== previous) {
        previous = title;
        title = title
            .replace(/^\([^)]*\)\s*/, "")
            .replace(/^\[[^\]]*\]\s*/, "")
            .trim();
    }
    // Trailing language / translator / status brackets and series parentheses:
    // [Chinese], [Decensored], [ongoing], (Blue Archive)
    previous = "";
    while (title !== previous) {
        previous = title;
        title = title
            .replace(/\s*\[[^\]]*\]\s*$/, "")
            .replace(/\s*\([^)]*\)\s*$/, "")
            .trim();
    }
    return title;
}
/** Prefer english, then japanese, then a stable fallback — always pretty-stripped. */
function prettyTitleFromListItem(item) {
    const pretty = toPrettyTitle(item.english_title) ||
        toPrettyTitle(item.japanese_title) ||
        item.english_title?.trim() ||
        item.japanese_title?.trim() ||
        "";
    return pretty.length > 0 ? pretty : `Gallery ${item.id}`;
}
function normalizeCreatorToken(value) {
    return value
        .replace(/_/g, " ")
        .replace(/\s+/g, " ")
        .replace(/^[,，]+|[,，]+$/g, "")
        .trim();
}
function hasMeaningfulCreatorCharacters(value) {
    return /[\p{L}\p{N}]/u.test(value);
}
function dedupeCreatorTokens(values) {
    const deduped = [];
    const seen = new Set();
    for (const rawValue of values) {
        const normalized = normalizeCreatorToken(rawValue);
        if (normalized.length === 0 ||
            !hasMeaningfulCreatorCharacters(normalized) ||
            isLanguageLikeCreatorToken(normalized)) {
            continue;
        }
        const key = normalized.toLocaleLowerCase();
        if (seen.has(key))
            continue;
        seen.add(key);
        deduped.push(normalized);
    }
    return deduped;
}
function getCreatorFieldsFromTags(tags) {
    const normalizeValues = (type) => dedupeCreatorTokens(tags.filter((tag) => tag.type === type).map((tag) => tag.name));
    const artists = normalizeValues("artist");
    const artistKeySet = new Set(artists.map((artist) => artist.toLocaleLowerCase()));
    const groups = normalizeValues("group").filter((group) => !artistKeySet.has(group.toLocaleLowerCase()));
    const authorCandidates = groups;
    const artistCandidates = artists;
    const formatCreatorField = (values) => {
        const cleaned = values
            .map((v) => v.trim())
            .filter((v) => v.length > 0 && /[\p{L}\p{N}]/u.test(v));
        if (cleaned.length === 0)
            return "";
        if (cleaned.length === 1)
            return cleaned[0];
        return cleaned.join(", ");
    };
    const author = formatCreatorField(authorCandidates);
    const artist = formatCreatorField(artistCandidates);
    const combined = [];
    if (author)
        combined.push(...author.split(/,\s*/));
    if (artist) {
        for (const a of artist.split(/,\s*/)) {
            if (!combined.includes(a))
                combined.push(a);
        }
    }
    return {
        author: combined.join(", ") || "",
    };
}
function formatSearchFilterSummary(filteredCount, readSkippedCount, includeReadSkipped) {
    const filtered = Math.max(0, Math.floor(filteredCount));
    const readSkipped = includeReadSkipped ? Math.max(0, Math.floor(readSkippedCount)) : 0;
    if (filtered === 0 && readSkipped === 0)
        return "";
    if (filtered === 0) {
        return readSkipped > 0 ? `, filtered ${readSkipped}(read)` : "";
    }
    if (readSkipped > 0) {
        return `, filtered ${filtered}+${readSkipped}(read)`;
    }
    return `, filtered ${filtered}`;
}
function getErrorMessage(error) {
    if (error instanceof Error) {
        return error.message;
    }
    if (typeof error === "string" ||
        typeof error === "number" ||
        typeof error === "boolean" ||
        error === null ||
        error === undefined) {
        return String(error ?? "");
    }
    try {
        return JSON.stringify(error);
    }
    catch {
        return "unknown error";
    }
}
class ReadHistory {
    _ordered;
    _lookup;
    static normalizeId(rawId) {
        const trimmed = String(rawId ?? "").trim();
        if (!trimmed)
            return "";
        if (/^\d+$/.test(trimmed))
            return String(parseInt(trimmed, 10));
        return trimmed;
    }
    constructor(items = []) {
        const ordered = [];
        const seen = new Set();
        for (const item of items) {
            const normalized = ReadHistory.normalizeId(String(item ?? ""));
            if (!normalized)
                continue;
            if (seen.has(normalized))
                continue;
            seen.add(normalized);
            ordered.push(normalized);
        }
        this._ordered = ordered;
        this._lookup = new Set(ordered);
    }
    has(id) {
        const normalized = ReadHistory.normalizeId(id);
        return normalized ? this._lookup.has(normalized) : false;
    }
    markRead(id) {
        const normalized = ReadHistory.normalizeId(id);
        if (!normalized)
            return false;
        if (this._lookup.has(normalized)) {
            // Move to front
            this._ordered = [normalized, ...this._ordered.filter((x) => x !== normalized)];
            return false; // not first-time
        }
        this._lookup.add(normalized);
        this._ordered.unshift(normalized);
        return true; // first-time marked
    }
    get ordered() {
        return this._ordered;
    }
    get size() {
        return this._lookup.size;
    }
    toArray() {
        return [...this._ordered];
    }
}
let readHistory;
export class NHentaiExtension {
    requestManager = new NHentaiInterceptor("main");
    cookieJar = new Map();
    // Backup limiter for fallback cases. Primary rate limiting uses endpoint-aware
    // burst queues in fetchJson which directly enforce per-endpoint limits.
    globalRateLimiter = new BasicRateLimiter("rateLimiter", {
        numberOfRequests: NHENTAI_BACKUP_API_REQUESTS_PER_SECOND,
        bufferInterval: RATE_LIMIT_WINDOW_SECONDS,
        ignoreImages: true,
    });
    // Image/thumbnail requests: separate budget from API calls. The ceiling here
    // balances concurrent media fetches against overall responsiveness.
    imageRateLimiter = new BasicRateLimiter("imageRateLimiter", {
        numberOfRequests: NHENTAI_IMAGE_REQUESTS_PER_SECOND,
        bufferInterval: RATE_LIMIT_WINDOW_SECONDS,
        ignoreImages: false,
    });
    popularTagsCache;
    popularTagsFetch;
    popularTagsCacheTs;
    cdnImageServers;
    cdnThumbServers;
    cdnConfigTs;
    cdnConfigFetch;
    searchCache = new Map();
    searchPending = new Map();
    // Cached SearchFilter[] output to avoid rebuilding on every framework call
    // Cached SearchFilter[] output — REMOVED caching to ensure fresh state reads
    sectionWaveSeq = 0;
    sectionWaveTokenSeq = 0;
    activeSectionWaves = new Map();
    async initialise() {
        this.requestManager.registerInterceptor();
        this.requestManager.resetRateLimitState();
        this.requestManager.setCookieHeaderProvider((url) => this.getCookieHeaderForUrl(url));
        this.globalRateLimiter.registerInterceptor();
        this.imageRateLimiter.registerInterceptor();
        // Register global callback for related pool invalidation
        globalThis.__nhentaiInvalidateRelatedPool = () => this.invalidateRelatedPool();
        // Ensure install date is set for statistics
        ensureInstallDate();
        this.restoreCookieJar();
        this.restoreTileStore();
        this.restoreSearchCache();
        try {
            const savedImageServers = Application.getState(CDN_IMAGE_SERVERS_STATE_KEY);
            const savedThumbServers = Application.getState(CDN_THUMB_SERVERS_STATE_KEY);
            const savedTs = Application.getState(CDN_TS_STATE_KEY);
            if (Array.isArray(savedImageServers) && savedImageServers.length > 0) {
                this.cdnImageServers = savedImageServers;
            }
            if (Array.isArray(savedThumbServers) && savedThumbServers.length > 0) {
                this.cdnThumbServers = savedThumbServers;
            }
            if (typeof savedTs === "number") {
                this.cdnConfigTs = savedTs;
            }
        }
        catch {
            // Ignore state restore issues for CDN config.
        }
        const hasServers = (this.cdnImageServers?.length ?? 0) > 0 && (this.cdnThumbServers?.length ?? 0) > 0;
        const needsRefresh = !this.cdnConfigTs || Date.now() - this.cdnConfigTs >= CDN_CACHE_TTL_MS || !hasServers;
        if (needsRefresh) {
            this.cdnConfigFetch = this.refreshCdnConfig().finally(() => {
                this.cdnConfigFetch = undefined;
            });
            void this.cdnConfigFetch;
        }
    }
    // Static accessor for settings form
    getPopularTagsForSettings() {
        if (this.popularTagsCache == null) {
            this.popularTagsFetch = this.getPopularTags();
        }
        return this.popularTagsCache ?? [];
    }
    async getSettingsForm() {
        return new SettingsForm();
    }
    async getDiscoverSections() {
        const order = getDiscoverSectionOrder();
        const hidden = getHiddenSections();
        const sectionMap = new Map(ALL_DISCOVER_SECTIONS.map((s) => [s.id, s]));
        const sections = [];
        for (const id of order) {
            if (hidden.has(id))
                continue;
            if (id === "related" && !getEnableRelatedSetting())
                continue;
            if (id === "top_reread" && !getEnableRereadSectionSetting())
                continue;
            const def = sectionMap.get(id);
            if (!def)
                continue;
            sections.push({
                id: def.id,
                title: def.title,
                type: DiscoverSectionType.simpleCarousel,
            });
        }
        return sections;
    }
    beginSectionWave(kind, label) {
        const now = Date.now();
        let wave = this.activeSectionWaves.get(kind);
        const canJoin = !!wave && now - wave.lastJoinAt <= SECTION_WAVE_JOIN_WINDOW_MS;
        if (!canJoin || !wave) {
            wave = {
                id: ++this.sectionWaveSeq,
                kind,
                startedAt: now,
                lastJoinAt: now,
                pending: new Set(),
                entries: [],
            };
            this.activeSectionWaves.set(kind, wave);
        }
        const token = `${kind}-${wave.id}-${++this.sectionWaveTokenSeq}`;
        wave.pending.add(token);
        wave.lastJoinAt = now;
        return {
            kind,
            waveId: wave.id,
            token,
            startedAt: now,
            label,
        };
    }
    completeSectionWave(handle, items, skipped, readSkipped, pagesScanned, labelOverride) {
        const wave = this.activeSectionWaves.get(handle.kind);
        if (!wave || wave.id !== handle.waveId)
            return;
        wave.pending.delete(handle.token);
        wave.entries.push({
            label: labelOverride ?? handle.label,
            items,
            skipped: Math.max(0, skipped),
            readSkipped: Math.max(0, readSkipped),
            pagesScanned: Math.max(0, pagesScanned),
            elapsedMs: Date.now() - handle.startedAt,
            completedAt: Date.now(),
        });
        if (wave.pending.size > 0)
            return;
        const ordered = [...wave.entries].sort((a, b) => a.completedAt - b.completedAt);
        const totalMs = Math.max(0, Date.now() - wave.startedAt);
        const totalPagesScanned = ordered.reduce((sum, entry) => sum + entry.pagesScanned, 0);
        const logLines = [];
        for (const entry of ordered) {
            const logParts = [`${entry.items} items`];
            if (entry.readSkipped > 0)
                logParts.push(`${entry.readSkipped} read`);
            if (entry.pagesScanned > 0) {
                const pageLabel = entry.pagesScanned === 1 ? "page" : "pages";
                logParts.push(`${entry.pagesScanned} ${pageLabel}`);
            }
            logLines.push(`  - ${entry.label}: ${logParts.join(", ")}, ${entry.elapsedMs}ms`);
        }
        if (String(wave.kind).toLowerCase() !== "search" && ordered.length > 1) {
            const prefix = `${wave.kind} Wave`;
            console.log(`[NHentai] ${prefix} Total Time: ${totalMs}ms, ${totalPagesScanned} pages searched\n${logLines.join("\n")}`);
        }
        this.activeSectionWaves.delete(handle.kind);
    }
    async getDiscoverSectionItems(section, metadata) {
        const pagination = metadata;
        const isFirstPage = !pagination?.page || pagination.page === 1;
        const sectionStart = Date.now();
        const sectionTileLimit = (pagination?.page ?? 1) > 1 ? getDiscoverPageSize() : getCarouselTiles();
        const waveHandle = isFirstPage
            ? this.beginSectionWave("Home", section.title ?? section.id)
            : undefined;
        const finalizeSection = (result, options) => {
            const pagesScanned = options?.pagesScanned ?? 0;
            const readSkipped = Math.max(0, options?.readSkipped ?? 0);
            const filteredSkipped = Math.max(0, options?.filteredSkipped ?? 0);
            const skippedTotal = Math.max(0, sectionTileLimit - result.items.length) + filteredSkipped;
            if (waveHandle) {
                this.completeSectionWave(waveHandle, result.items.length, skippedTotal, readSkipped, pagesScanned);
            }
            // Per-pagination discover log: list items returned and counts, include pages scanned when a new page was requested
            try {
                const elapsedMs = Math.max(0, Date.now() - sectionStart);
                const pagesScannedLog = options?.pagesScanned ?? 0;
                const totalSkipped = skippedTotal + readSkipped;
                console.log(`[NHentai] Discover ${section.title ?? section.id}: ${result.items.length} items` +
                    (totalSkipped > 0 ? `, ${totalSkipped} skipped` : "") +
                    (pagesScannedLog > 0 ? `, ${pagesScannedLog} pages scanned` : "") +
                    `, ${elapsedMs}ms`);
            }
            catch {
                /* ignore logging errors */
            }
            // Build description showing filtered and read item counts
            const descriptionParts = [];
            if (skippedTotal > 0)
                descriptionParts.push(`${skippedTotal} filtered`);
            if (readSkipped > 0)
                descriptionParts.push(`${readSkipped} read`);
            const description = descriptionParts.length > 0 ? descriptionParts.join(", ") : undefined;
            return {
                ...result,
                description,
            };
        };
        try {
            // Stagger section requests to prevent burst on app launch
            // Only stagger initial page loads (metadata.page === undefined or 1)
            if (isFirstPage) {
                await staggeredSectionDelay();
            }
            // Handle Related section separately
            if (section.id === "related") {
                return finalizeSection(await this.getRelatedSection(pagination));
            }
            // Handle Last Read section
            if (section.id === "last_read") {
                return finalizeSection(await this.getLastReadSection(pagination));
            }
            // Handle Top Reread section
            if (section.id === "top_reread") {
                return finalizeSection(await this.getTopRereadSection(pagination));
            }
            const initialPage = pagination?.page ?? 1;
            const sortKey = section.id === "new_uploads"
                ? "date"
                : (POPULAR_SECTIONS.find((entry) => entry.id === section.id)?.sort ?? "popular");
            const { tokens: discoverTokens, pagesConstraint: discoverPagesConstraint, dateConstraint: discoverDateConstraint, favoritesConstraint: discoverFavoritesConstraint, } = this.buildFilterTokens(undefined);
            const query = this.buildQueryString(undefined, discoverTokens);
            const queryHasFavoritesToken = queryContainsFavoritesToken(query);
            const hideRead = getHideReadSetting();
            const readCache = hideRead ? getReadCache() : null;
            if (sectionTileLimit <= 0) {
                return finalizeSection({ items: [], metadata: undefined });
            }
            let currentPage = initialPage;
            let response;
            let items = [];
            const seenItemIds = new Set();
            let bufferedGalleries = [...(pagination?.buffer ?? [])];
            if (bufferedGalleries.length > 0) {
                const initialBufferTake = bufferedGalleries.slice(0, sectionTileLimit);
                bufferedGalleries = bufferedGalleries.slice(sectionTileLimit);
                const hydratedFromBuffer = await this.hydrateLiteGalleries(initialBufferTake, initialBufferTake.length);
                items.push(...hydratedFromBuffer.map((gallery) => this.mapGalleryToDiscoverItem(gallery)));
            }
            // Popular all-time and monthly need to scan deeper since heavy readers
            // have read most of the top results.  Other sections have smaller pools.
            const isDeepScan = section.id === "popular_all" || section.id === "popular_month";
            const hasHeavyConstraint = hasFavoritesConstraint(discoverFavoritesConstraint) ||
                discoverPagesConstraint !== undefined ||
                discoverDateConstraint !== undefined;
            const approxResultsPerPage = 25;
            const basePagesNeeded = Math.max(1, Math.ceil(sectionTileLimit / approxResultsPerPage));
            const MAX_PAGES = Math.max(2, Math.min(8, basePagesNeeded +
                (hideRead ? 1 : 0) +
                (hasHeavyConstraint ? 2 : 1) +
                (isDeepScan ? 1 : 0)));
            let pagesScanned = 0;
            let reachedEnd = false;
            let rateLimitedEarlyReturn = false;
            let readSkippedTotal = 0;
            let filteredSkippedTotal = 0;
            let attemptedPages = 0;
            let consecutiveFailures = 0;
            while (pagesScanned < MAX_PAGES && items.length < sectionTileLimit) {
                // Batch immediately from the first wave rather than waiting for later scans.
                const batchSize = pagesScanned === 0 ? DISCOVER_FETCH_INITIAL_BATCH_SIZE : DISCOVER_FETCH_BATCH_SIZE;
                const remainingBatch = Math.min(batchSize, MAX_PAGES - pagesScanned);
                if (remainingBatch <= 0)
                    break;
                const batchPages = Array.from({ length: remainingBatch }, (_, index) => currentPage + index);
                const batchResults = await Promise.all(batchPages.map(async (page) => {
                    try {
                        return {
                            page,
                            result: await this.fetchSearchWithOrExpansion(query, page, sortKey, [], {
                                forceRefresh: section.id === "new_uploads" && page === 1,
                            }),
                            rateLimited: false,
                        };
                    }
                    catch (e) {
                        if (e instanceof CloudflareError)
                            throw e;
                        const msg = getErrorMessage(e);
                        const isRateLimited = msg.includes("429") || msg.includes("Cloudflare") || msg.includes("Non-JSON");
                        if (isRateLimited) {
                            await this.pause(20);
                        }
                        return { page, result: null, rateLimited: isRateLimited };
                    }
                }));
                for (const { page, result, rateLimited } of batchResults) {
                    attemptedPages++;
                    if (!result) {
                        if (rateLimited) {
                            rateLimitedEarlyReturn = true;
                            continue;
                        }
                        consecutiveFailures++;
                        await this.pause(Math.min(300, 60 * consecutiveFailures));
                        if (consecutiveFailures >= 8) {
                            // Keep continuation metadata available instead of forcing an end;
                            // transient API failures should not permanently cut off sections.
                            rateLimitedEarlyReturn = true;
                            continue;
                        }
                        continue;
                    }
                    consecutiveFailures = 0;
                    pagesScanned++;
                    currentPage = page + 1;
                    response = result;
                    const galleries = result.result ?? [];
                    const filtered = hideRead && readCache
                        ? galleries.filter((g) => !readCache.has(g.id.toString()))
                        : galleries;
                    const pagesExact = discoverPagesConstraint?.exact;
                    const pagesMin = discoverPagesConstraint?.min;
                    const pagesMax = discoverPagesConstraint?.max;
                    const filteredForFavorites = hasFavoritesConstraint(discoverFavoritesConstraint) && !queryHasFavoritesToken
                        ? filtered.filter((g) => matchesFavoritesConstraint(g, discoverFavoritesConstraint))
                        : filtered;
                    const filteredForPages = pagesExact !== undefined || pagesMin !== undefined || pagesMax !== undefined
                        ? filteredForFavorites.filter((g) => {
                            if (g.isLite)
                                return true;
                            if (pagesExact !== undefined)
                                return g.num_pages === pagesExact;
                            if (pagesMin !== undefined && g.num_pages < pagesMin)
                                return false;
                            if (pagesMax !== undefined && g.num_pages > pagesMax)
                                return false;
                            return true;
                        })
                        : filteredForFavorites;
                    const filteredForDate = discoverDateConstraint
                        ? filteredForPages.filter((g) => {
                            if (g.isLite)
                                return true;
                            const uploadedMs = g.upload_date * 1000;
                            if (discoverDateConstraint.newerThanDays !== undefined) {
                                const cutoff = Date.now() - discoverDateConstraint.newerThanDays * 24 * 60 * 60 * 1000;
                                if (uploadedMs < cutoff)
                                    return false;
                            }
                            if (discoverDateConstraint.olderThanDays !== undefined) {
                                const olderThan = Date.now() - discoverDateConstraint.olderThanDays * 24 * 60 * 60 * 1000;
                                if (uploadedMs > olderThan)
                                    return false;
                            }
                            return true;
                        })
                        : filteredForPages;
                    filteredSkippedTotal += Math.max(0, filtered.length - filteredForDate.length);
                    const remainingSlots = sectionTileLimit - items.length;
                    if (remainingSlots > 0) {
                        const pageCandidates = filteredForDate.slice(0, remainingSlots);
                        const pageRemainder = filteredForDate.slice(remainingSlots);
                        if (pageRemainder.length > 0) {
                            bufferedGalleries.push(...pageRemainder);
                        }
                        const hydratedCandidates = await this.hydrateLiteGalleries(pageCandidates, pageCandidates.length);
                        for (const gallery of hydratedCandidates) {
                            if (!seenItemIds.has(gallery.id)) {
                                seenItemIds.add(gallery.id);
                                items.push(this.mapGalleryToDiscoverItem(gallery));
                            }
                        }
                    }
                    if (page >= result.num_pages) {
                        reachedEnd = true;
                        break;
                    }
                    if (items.length >= sectionTileLimit) {
                        break;
                    }
                }
                if (rateLimitedEarlyReturn)
                    break;
                if (reachedEnd)
                    break;
            }
            // Fallback: if hide-read is enabled and every scanned page is filtered out,
            // show a small non-hidden baseline instead of returning an empty section.
            if (items.length === 0 && hideRead) {
                try {
                    const fallback = await this.fetchSearchWithOrExpansion(query, 1, sortKey);
                    const fallbackCandidates = (fallback.result ?? []).slice(0, Math.min(sectionTileLimit, 6));
                    const hydratedFallback = await this.hydrateLiteGalleries(fallbackCandidates, fallbackCandidates.length);
                    items.push(...hydratedFallback.map((gallery) => this.mapGalleryToDiscoverItem(gallery)));
                }
                catch {
                    // Keep empty if fallback fails.
                }
            }
            // Last-resort fallback: if every section request failed and produced no
            // response object, run one plain v2 search for this sort to avoid empty
            // carousels caused by malformed/corrupted filter state.
            if (items.length === 0 && response === undefined) {
                try {
                    const fallback = await this.fetchSearch(EMPTY_QUERY, 1, sortKey);
                    const fallbackCandidates = (fallback.result ?? []).slice(0, Math.min(sectionTileLimit, 6));
                    const hydratedFallback = await this.hydrateLiteGalleries(fallbackCandidates, fallbackCandidates.length);
                    items.push(...hydratedFallback.map((gallery) => this.mapGalleryToDiscoverItem(gallery)));
                }
                catch {
                    // Keep empty if fallback fails.
                }
            }
            // Cap items
            items = items.slice(0, sectionTileLimit);
            // Return metadata when more pages may still exist.
            // Preserve the upstream cursor when this call only consumed buffered items
            // so pagination does not stop prematurely.
            const continuationFromTransientFailures = response === undefined && attemptedPages > 0 && currentPage > initialPage;
            const continuationFromUnscannedCursor = response === undefined &&
                attemptedPages === 0 &&
                typeof pagination?.page === "number" &&
                pagination.page > 0;
            const hasMore = bufferedGalleries.length > 0 ||
                rateLimitedEarlyReturn ||
                continuationFromTransientFailures ||
                continuationFromUnscannedCursor ||
                (!reachedEnd && response !== undefined && currentPage <= response.num_pages);
            recordDisplayedTiles(items);
            // Trigger prefetch for next page in discover when approaching pagination boundary
            // Only for page >1 (skip initial carousel load), when largest multiple of page size <= 25 is reached
            const discoverIsNotFirstPage = currentPage > 1;
            const prefetchThreshold = 25 - (25 % sectionTileLimit);
            const discoverShouldPrefetch = discoverIsNotFirstPage &&
                items.length >= prefetchThreshold &&
                currentPage < (response?.num_pages ?? 999);
            if (discoverShouldPrefetch) {
                this.triggerDiscoverPrefetch(query, currentPage + 1, sortKey);
            }
            return finalizeSection({
                items,
                metadata: hasMore
                    ? {
                        page: currentPage,
                        ...(bufferedGalleries.length > 0
                            ? { buffer: bufferedGalleries }
                            : {}),
                    }
                    : undefined,
            }, {
                pagesScanned,
                readSkipped: readSkippedTotal,
                filteredSkipped: filteredSkippedTotal,
            });
        }
        catch (e) {
            if (waveHandle) {
                this.completeSectionWave(waveHandle, 0, Math.max(0, sectionTileLimit), 0, 0, section.title ?? section.id);
            }
            throw e;
        }
    }
    /**
     * Immediately notify the framework that search filters changed.
     * Coalesces rapid-fire calls within the current event loop tick.
     */
    debouncedInvalidateSearchFilters() {
        try {
            // Application.invalidateSearchFilters() - API removed
        }
        catch {
            /* ignore */
        }
    }
    getCookieStorageKey(cookie) {
        const path = cookie.path && cookie.path.length > 0 ? cookie.path : "/";
        return `${cookie.name}|${cookie.domain.toLowerCase()}|${path}`;
    }
    parseCookieExpires(value) {
        if (!value)
            return undefined;
        const parsed = value instanceof Date ? value : new Date(value);
        return Number.isFinite(parsed.getTime()) ? parsed : undefined;
    }
    normalizeCookie(cookie) {
        const name = typeof cookie.name === "string" ? cookie.name.trim() : "";
        const value = typeof cookie.value === "string" ? cookie.value : "";
        const domain = typeof cookie.domain === "string" ? cookie.domain.trim().toLowerCase() : "";
        if (!name || !domain)
            return undefined;
        const path = cookie.path && cookie.path.length > 0 ? cookie.path : "/";
        const expires = this.parseCookieExpires(cookie.expires);
        const created = this.parseCookieExpires(cookie.created);
        return { name, value, domain, path, expires, created };
    }
    isCookieExpired(cookie, now = Date.now()) {
        return !!cookie.expires && cookie.expires.getTime() <= now;
    }
    doesCookieMatchRequestUrl(cookie, requestUrl) {
        let parsedUrl;
        try {
            parsedUrl = new URL(requestUrl);
        }
        catch {
            return false;
        }
        const host = parsedUrl.hostname.toLowerCase();
        const domain = cookie.domain.replace(/^\./, "").toLowerCase();
        if (!domain)
            return false;
        if (host !== domain && !host.endsWith(`.${domain}`)) {
            return false;
        }
        const cookiePath = cookie.path && cookie.path.length > 0 ? cookie.path : "/";
        return parsedUrl.pathname.startsWith(cookiePath);
    }
    persistCookieJar() {
        try {
            Application.setState(Array.from(this.cookieJar.values()), COOKIE_JAR_STATE_KEY);
        }
        catch {
            // Ignore persistence failures
        }
    }
    restoreCookieJar() {
        try {
            const stored = Application.getState(COOKIE_JAR_STATE_KEY);
            if (!Array.isArray(stored)) {
                this.cookieJar.clear();
                return;
            }
            const now = Date.now();
            this.cookieJar.clear();
            for (const rawCookie of stored) {
                const cookie = this.normalizeCookie(rawCookie);
                if (!cookie || this.isCookieExpired(cookie, now))
                    continue;
                this.cookieJar.set(this.getCookieStorageKey(cookie), cookie);
            }
            this.persistCookieJar();
        }
        catch {
            this.cookieJar.clear();
        }
    }
    getCookieHeaderForUrl(url) {
        const now = Date.now();
        let expiredRemoved = false;
        const matchingCookies = [];
        for (const [key, cookie] of this.cookieJar.entries()) {
            if (this.isCookieExpired(cookie, now)) {
                this.cookieJar.delete(key);
                expiredRemoved = true;
                continue;
            }
            if (this.doesCookieMatchRequestUrl(cookie, url)) {
                matchingCookies.push(cookie);
            }
        }
        if (expiredRemoved) {
            this.persistCookieJar();
        }
        if (matchingCookies.length === 0)
            return undefined;
        matchingCookies.sort((a, b) => {
            const aPath = a.path ?? "/";
            const bPath = b.path ?? "/";
            return bPath.length - aPath.length;
        });
        return matchingCookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
    }
    async saveCloudflareBypassCookies(cookies) {
        const now = Date.now();
        let changed = false;
        for (const cookie of cookies) {
            const normalized = this.normalizeCookie(cookie);
            if (!normalized)
                continue;
            const key = this.getCookieStorageKey(normalized);
            if (this.isCookieExpired(normalized, now)) {
                changed = this.cookieJar.delete(key) || changed;
                continue;
            }
            this.cookieJar.set(key, normalized);
            changed = true;
        }
        if (changed) {
            this.persistCookieJar();
        }
    }
    async cloudflareBypassCompleted(_request, cookies, _localStorage) {
        await this.saveCloudflareBypassCookies(cookies);
    }
    async getSearchFilters() {
        const filters = [];
        // Length
        filters.push({
            id: "length",
            type: "dropdown",
            title: "Length",
            value: getSearchFilterLength(),
            options: LENGTH_FILTER_OPTIONS.map((option) => ({
                id: option.id,
                value: option.label,
            })),
        });
        // Favorites
        filters.push({
            id: "favorites",
            type: "dropdown",
            title: "Favorites",
            value: getSearchFilterFavorites(),
            options: FAVORITES_FILTER_OPTIONS.map((option) => ({
                id: option.id,
                value: option.label,
            })),
        });
        // Days Old filter
        filters.push({
            id: "daysOld",
            type: "dropdown",
            title: "Date",
            value: getSearchFilterDate(),
            options: DATE_FILTER_PRESETS.map((option) => ({
                id: option.id,
                value: option.label,
            })),
        });
        // Use cached popular tags, blocking only if cache is empty (to prevent empty tag list).
        // Kick off a background fetch if cache is stale.
        if (!this.popularTagsCache ||
            !this.popularTagsCacheTs ||
            Date.now() - this.popularTagsCacheTs >= POPULAR_TAGS_CACHE_TTL_MS) {
            if (!this.popularTagsFetch) {
                this.popularTagsFetch = this.getPopularTags();
            }
        }
        // If cache is empty, wait for the in-flight fetch to complete so tags aren't missing
        if (!this.popularTagsCache && this.popularTagsFetch) {
            try {
                await this.popularTagsFetch;
            }
            catch {
                /* ignore */
            }
        }
        const popularTags = this.popularTagsCache ?? [];
        const savedTags = getSearchFilterTags();
        const cleanedTags = {
            ...savedTags,
        };
        // Strip leftover apply-manga-filter key from old state
        delete cleanedTags["__apply_manga_filter_tags__"];
        const cleanedChanged = Object.keys(cleanedTags).length !== Object.keys(savedTags).length;
        if (cleanedChanged) {
            setSearchFilterTags(cleanedTags);
        }
        // Sort selected/excluded tags to the top of the tag list
        const selectedTagIds = new Set(Object.keys(cleanedTags));
        const sortTagsAlpha = getDisplayOptionsSetting().includes("show_tags_alpha");
        const unselectedPopularTags = popularTags.filter((tag) => !selectedTagIds.has(tag.id));
        if (sortTagsAlpha) {
            unselectedPopularTags.sort((a, b) => a.label.localeCompare(b.label));
        }
        const sortedPopularTags = [
            ...popularTags.filter((tag) => selectedTagIds.has(tag.id)),
            ...unselectedPopularTags,
        ];
        filters.push({
            id: "tags",
            type: "multiselect",
            title: "Tags",
            value: cleanedTags,
            options: sortedPopularTags.map((tag) => {
                const showTagCounts = getDisplayOptionsSetting().includes("show_tag_counts");
                const cleanedLabel = tag.label.replace(/\s*-\s*\([^)]*\)\s*$/, "");
                const countLabel = this.formatTagCount(this.parseTagCountValue(tag.count));
                return {
                    id: tag.id,
                    value: showTagCounts ? `${cleanedLabel} - (${countLabel})` : cleanedLabel,
                };
            }),
            allowExclusion: true,
            allowEmptySelection: true,
            maximum: undefined,
        });
        return filters;
    }
    async getAdvancedSearchForm(query) {
        return new InlineSearchFilterForm(query.metadata, this.getSearchFilters());
    }
    async getSortingOptions() {
        // Build sort options following the user's discover section order
        const order = getDiscoverSectionOrder();
        const hidden = getHiddenSections();
        const sortLabelMap = new Map(SORT_OPTIONS.map((o) => [o.id, o.label]));
        const options = [];
        for (const sectionId of order) {
            if (hidden.has(sectionId))
                continue;
            if (sectionId === "related" && !getEnableRelatedSetting())
                continue;
            if (sectionId === "top_reread" && !getEnableRereadSectionSetting())
                continue;
            const sortId = DISCOVER_TO_SORT_MAP[sectionId];
            if (!sortId)
                continue;
            const label = sortLabelMap.get(sortId);
            if (label)
                options.push({ id: sortId, label });
        }
        // Ensure at least 'date' is present if everything was hidden
        if (options.length === 0) {
            options.push({ id: "date", label: "Date Added" });
        }
        return options;
    }
    async getSearchResults(query, metadata, sortingOption) {
        const searchStart = Date.now();
        try {
            const pagination = metadata;
            const submittedFilters = cleanSearchFilterValues(query.metadata);
            const storedFilters = [];
            const searchFilterLength = getSearchFilterLength();
            if (searchFilterLength && searchFilterLength !== "all") {
                storedFilters.push({
                    id: "length",
                    value: searchFilterLength,
                });
            }
            const searchFilterFavorites = getSearchFilterFavorites();
            if (searchFilterFavorites && searchFilterFavorites !== "all") {
                storedFilters.push({
                    id: "favorites",
                    value: searchFilterFavorites,
                });
            }
            const searchFilterDate = getSearchFilterDate();
            if (searchFilterDate && searchFilterDate !== "all") {
                storedFilters.push({
                    id: "daysOld",
                    value: searchFilterDate,
                });
            }
            const searchFilterTags = submittedFilters
                ? (submittedFilters.find((filter) => filter.id === "tags")?.value ?? {})
                : getSearchFilterTags();
            // getSearchFilterTags() already merges synced manga filter tags,
            // so we do not need to manually merge getIncludeTagsSetting() or getExcludeTagsSetting().
            const mergedTags = { ...searchFilterTags };
            const submittedActiveFilters = submittedFilters
                ? getActiveSearchFilterValues(submittedFilters).filter((filter) => filter.id !== "tags")
                : undefined;
            if (Object.keys(mergedTags).length > 0) {
                const tagsFilter = {
                    id: "tags",
                    value: mergedTags,
                };
                if (submittedActiveFilters) {
                    submittedActiveFilters.push(tagsFilter);
                }
                else {
                    storedFilters.push(tagsFilter);
                }
            }
            const queryFilters = submittedActiveFilters ?? storedFilters;
            const filtersToPersist = submittedFilters ?? queryFilters;
            let currentPage = pagination?.page ?? 1;
            let effectiveSort = this.resolveSortOrder(query, sortingOption);
            if (effectiveSort === "related" && !getEnableRelatedSetting())
                effectiveSort = "date";
            if (effectiveSort === "top_reread" && !getEnableRereadSectionSetting())
                effectiveSort = "date";
            // Increment non-carousel counter when user requests non-related search pages.
            if (effectiveSort !== "related") {
                try {
                    this.incrementNonCarouselCounter();
                }
                catch {
                    /* ignore */
                }
            }
            let trimmedTitle = query.title?.trim() ?? "";
            // Detect OR groups typed in the search bar (e.g. "yuri OR maid" or "yuri || maid")
            // Extract them as additionalOrGroups and strip OR from the title so the API
            // doesn't receive a literal OR string it doesn't understand.
            const titleOrGroups = [];
            if (/\s*\|\|\s*|\s+OR\s+/i.test(trimmedTitle)) {
                // Split on comma/semicolon to handle multiple OR groups in one query
                const clauseParts = trimmedTitle
                    .split(/[,;]/)
                    .map((s) => s.trim())
                    .filter(Boolean);
                const remainingParts = [];
                for (const clause of clauseParts) {
                    if (/\s*\|\|\s*|\s+OR\s+/i.test(clause)) {
                        const orParts = this.dedupeQueryTokens(clause
                            .split(/\s*\|\|\s*|\s+OR\s+/i)
                            .map((s) => this.buildTagTokens([{ id: s.trim(), title: "" }], false)[0] ?? "")
                            .filter(Boolean));
                        if (orParts.length > 1) {
                            titleOrGroups.push(orParts);
                        }
                        else if (orParts.length === 1) {
                            remainingParts.push(orParts[0]);
                        }
                    }
                    else {
                        remainingParts.push(clause);
                    }
                }
                trimmedTitle = remainingParts.join(" ").trim();
            }
            if (trimmedTitle && /^\d+$/.test(trimmedTitle)) {
                try {
                    const gallery = await this.fetchGallery(trimmedTitle);
                    return {
                        items: [this.mapGalleryToSearchResult(gallery)],
                        metadata: undefined,
                    };
                }
                catch (error) {
                    console.error("Failed to fetch gallery by ID", error);
                    return { items: [], metadata: undefined };
                }
            }
            const { tokens: filterTokens, favoritesConstraint, pagesConstraint, dateConstraint, } = this.buildFilterTokens(queryFilters);
            let sawTagsFilter = false;
            // Always persist search filter values to state (even on first search)
            if (filtersToPersist.length > 0) {
                for (const filter of filtersToPersist) {
                    if (filter.id === "length" && typeof filter.value === "string") {
                        setSearchFilterLength(filter.value);
                    }
                    else if (filter.id === "favorites" && typeof filter.value === "string") {
                        setSearchFilterFavorites(filter.value);
                    }
                    else if (filter.id === "daysOld" && typeof filter.value === "string") {
                        setSearchFilterDate(filter.value);
                    }
                    else if (filter.id === "relatedLanguage" && typeof filter.value === "string") {
                        setSearchFilterRelatedLanguage(filter.value);
                        setRelatedLanguageSetting(filter.value);
                    }
                    else if (filter.id === "tags") {
                        sawTagsFilter = true;
                        const tagsValue = filter.value;
                        const nextTags = { ...tagsValue };
                        // Strip leftover apply-manga-filter key from old state
                        delete nextTags["__apply_manga_filter_tags__"];
                        setSearchFilterTags(nextTags);
                    }
                }
                if (!sawTagsFilter) {
                    setSearchFilterTags({});
                }
                // Invalidate search filters (API method no longer available)
            }
            else {
                setSearchFilterTags({});
            }
            if (effectiveSort === "related") {
                const relatedSection = await this.getRelatedSection(pagination, true);
                const items = this.discoverItemsToSearchResults(relatedSection.items);
                console.log(`[NHentai] Related: ${items.length} items, ${Date.now() - searchStart}ms`);
                return { items, metadata: relatedSection.metadata };
            }
            if (effectiveSort === "last_read") {
                const lastReadSection = await this.getLastReadSection(pagination, true);
                const items = this.discoverItemsToSearchResults(lastReadSection.items);
                console.log(`[NHentai] Last Read: ${items.length} items, ${Date.now() - searchStart}ms`);
                return { items, metadata: lastReadSection.metadata };
            }
            if (effectiveSort === "top_reread") {
                const topRereadSection = await this.getTopRereadSection(pagination, true);
                const items = this.discoverItemsToSearchResults(topRereadSection.items);
                console.log(`[NHentai] Top Reread: ${items.length} items, ${Date.now() - searchStart}ms`);
                return { items, metadata: topRereadSection.metadata };
            }
            // Type guard for TagsFilterValue
            function isTagsFilterValue(value) {
                if (typeof value !== "object" || value === null)
                    return false;
                const obj = value;
                for (const key of Object.keys(obj)) {
                    const v = obj[key];
                    if (v !== "included" && v !== "excluded")
                        return false;
                }
                return true;
            }
            // Get tags from filter
            const tagsFilter = queryFilters.find((filter) => filter.id === "tags");
            const tagsValueRaw = isTagsFilterValue(tagsFilter?.value)
                ? tagsFilter.value
                : {};
            const tagsValue = { ...tagsValueRaw };
            // Strip leftover apply-manga-filter key from old state
            delete tagsValue["__apply_manga_filter_tags__"];
            const includedTags = [];
            const excludedTags = [];
            // Process tags based on their inclusion/exclusion state
            for (const [tagId, state] of Object.entries(tagsValue)) {
                if (/\|\||\s+OR\s+/i.test(tagId))
                    continue;
                const normalizedTagId = tagId.replaceAll("-", " ");
                if (state === "excluded") {
                    excludedTags.push({ id: normalizedTagId, title: "" });
                }
                else if (state === "included") {
                    includedTags.push({ id: normalizedTagId, title: "" });
                }
            }
            const tagTokens = this.dedupeQueryTokens([
                ...this.buildTagTokens(includedTags, false),
                ...this.buildTagTokens(excludedTags, true),
            ]);
            const sortOrder = effectiveSort;
            const searchQuery = this.buildQueryString(trimmedTitle, [...filterTokens, ...tagTokens]);
            const searchSessionKey = JSON.stringify({
                query: searchQuery,
                sort: sortOrder,
                orGroups: titleOrGroups,
            });
            const hideRead = getHideReadSetting();
            const readCache = hideRead ? getReadCache() : null;
            const pagesExact = pagesConstraint?.exact;
            const pagesMin = pagesConstraint?.min;
            const pagesMax = pagesConstraint?.max;
            if (this.searchBufferSessionKey !== searchSessionKey || (pagination?.page ?? 1) <= 1) {
                this.searchBufferSessionKey = searchSessionKey;
                this.searchBufferGalleries = [];
                this.searchBufferNextPage = pagination?.page ?? 1;
                this.searchBufferNumPages = pagination?.numPages;
                this.searchConsecutiveEmpty = 0;
            }
            currentPage = pagination?.page ?? this.searchBufferNextPage;
            let response;
            let items = [];
            let safetyCounter = 0;
            const searchPageSize = getSearchPageSize();
            // Only use buffered galleries if this is the expected next page
            // If user explicitly navigated to a different page, discard the buffer
            let bufferedGalleries = currentPage === this.searchBufferNextPage ? [...this.searchBufferGalleries] : [];
            let knownNumPages = this.searchBufferNumPages ?? pagination?.numPages;
            let nextPage = currentPage;
            const strictPaginationFilters = hasFavoritesConstraint(favoritesConstraint) ||
                dateConstraint !== undefined ||
                pagesExact !== undefined ||
                pagesMin !== undefined ||
                pagesMax !== undefined;
            const emptyFilteredLimit = strictPaginationFilters ? 36 : 18;
            const continuationEmptyLimit = strictPaginationFilters ? 36 : 24;
            const approxResultsPerPage = 25;
            const maxPagesThisCall = Math.max(2, Math.min(8, Math.ceil(searchPageSize / approxResultsPerPage) +
                (strictPaginationFilters ? 3 : 1) +
                (hideRead ? 1 : 0)));
            let consecutiveEmptyFiltered = 0;
            let rateLimitedEarlyReturn = false;
            let pagesScannedThisCall = 0;
            let readSkippedTotal = 0;
            let filteredSkippedTotal = 0;
            const appendSearchCandidates = async (pageCandidates, source, pageLabel) => {
                if (pageCandidates.length === 0)
                    return;
                this.requestManager.resetCoverPacing();
                const hydratedCandidates = await this.hydrateLiteGalleries(pageCandidates, pageCandidates.length);
                items.push(...hydratedCandidates.map((gallery) => this.mapGalleryToSearchResult(gallery)));
                logDebug("search:hydrate", `page=${pageLabel}`, `source=${source}`, `candidates=${pageCandidates.length}`, `hydrated=${hydratedCandidates.length}`, `itemsTotal=${items.length}`);
            };
            logDebug("search:start", `sort=${sortOrder}`, `page=${currentPage}`, `query=${searchQuery}`, `titleOrGroups=${titleOrGroups.length}`, `favorites=${favoritesConstraint ? `${favoritesConstraint.min ?? "-"}:${favoritesConstraint.max ?? "-"}` : "off"}`, `pages=${pagesExact ?? `${pagesMin ?? "-"}:${pagesMax ?? "-"}`}`, `date=${dateConstraint ? `${dateConstraint.newerThanDays ?? "-"}:${dateConstraint.olderThanDays ?? "-"}` : "off"}`, `hideRead=${hideRead}`);
            if (bufferedGalleries.length > 0) {
                logDebug("search:buffer", `page=${currentPage}`, `buffered=${bufferedGalleries.length}`);
                const bufferedCandidates = bufferedGalleries.slice(0, searchPageSize - items.length);
                bufferedGalleries = bufferedGalleries.slice(bufferedCandidates.length);
                await appendSearchCandidates(bufferedCandidates, "buffer", currentPage);
            }
            while (items.length < searchPageSize &&
                safetyCounter < MAX_SEARCH_PAGES &&
                pagesScannedThisCall < maxPagesThisCall) {
                try {
                    response = await this.fetchSearchWithOrExpansion(searchQuery, currentPage, sortOrder, titleOrGroups);
                }
                catch (e) {
                    // CloudflareError must bubble up for the framework challenge UI
                    if (e instanceof CloudflareError)
                        throw e;
                    // Network or interceptor error during fetch — keep any items found so far
                    // and continue pagination after a brief pause for transient 429/Cloudflare
                    if (e instanceof Error) {
                        console.error("Search fetch failed:", e.message, e);
                        if (e.message.includes("429") ||
                            e.message.includes("Cloudflare") ||
                            e.message.includes("Non-JSON")) {
                            rateLimitedEarlyReturn = true;
                            break;
                        }
                    }
                    else {
                        console.error("Search fetch failed:", e);
                    }
                    break;
                }
                if (!response || !response.result) {
                    console.log("Search returned null/undefined response");
                    break;
                }
                knownNumPages = response.num_pages;
                nextPage = currentPage + 1;
                const galleries = response.result;
                pagesScannedThisCall++;
                const itemCountBefore = items.length;
                const preFilteredForRead = hideRead && readCache
                    ? galleries.filter((g) => !readCache.has(g.id.toString()))
                    : galleries;
                const filteredForFavorites = hasFavoritesConstraint(favoritesConstraint) && !queryContainsFavoritesToken(searchQuery)
                    ? preFilteredForRead.filter((g) => matchesFavoritesConstraint(g, favoritesConstraint))
                    : preFilteredForRead;
                logDebug("search:page", `page=${currentPage}`, `raw=${galleries.length}`, `afterFavorites=${filteredForFavorites.length}`);
                const filteredForRead = filteredForFavorites;
                const filteredForPages = pagesExact !== undefined || pagesMin !== undefined || pagesMax !== undefined
                    ? filteredForRead.filter((g) => {
                        if (g.isLite)
                            return true;
                        if (pagesExact !== undefined)
                            return g.num_pages === pagesExact;
                        if (pagesMin !== undefined && g.num_pages < pagesMin)
                            return false;
                        if (pagesMax !== undefined && g.num_pages > pagesMax)
                            return false;
                        return true;
                    })
                    : filteredForRead;
                logDebug("search:filters", `page=${currentPage}`, `afterRead=${filteredForRead.length}`, `afterPages=${filteredForPages.length}`);
                const filteredForDate = dateConstraint
                    ? filteredForPages.filter((g) => {
                        if (g.isLite)
                            return true;
                        const uploadedMs = g.upload_date * 1000;
                        if (dateConstraint.newerThanDays !== undefined) {
                            const cutoff = Date.now() - dateConstraint.newerThanDays * 24 * 60 * 60 * 1000;
                            if (uploadedMs < cutoff)
                                return false;
                        }
                        if (dateConstraint.olderThanDays !== undefined) {
                            const olderThan = Date.now() - dateConstraint.olderThanDays * 24 * 60 * 60 * 1000;
                            if (uploadedMs > olderThan)
                                return false;
                        }
                        return true;
                    })
                    : filteredForPages;
                filteredSkippedTotal += Math.max(0, preFilteredForRead.length - filteredForDate.length);
                logDebug("search:date", `page=${currentPage}`, `afterDate=${filteredForDate.length}`, `remainingSlots=${searchPageSize - items.length}`);
                const remainingSlots = searchPageSize - items.length;
                if (remainingSlots > 0) {
                    const pageCandidates = filteredForDate.slice(0, remainingSlots);
                    const leftoverCandidates = filteredForDate.slice(remainingSlots);
                    if (leftoverCandidates.length > 0) {
                        bufferedGalleries.push(...leftoverCandidates);
                    }
                    await appendSearchCandidates(pageCandidates, "page", currentPage);
                }
                // Track consecutive pages where filtering removes everything
                if (items.length === itemCountBefore && galleries.length > 0) {
                    consecutiveEmptyFiltered++;
                }
                else {
                    consecutiveEmptyFiltered = 0;
                }
                const reachedEnd = currentPage >= response.num_pages;
                const rawResultsEmpty = galleries.length === 0;
                if (items.length >= searchPageSize ||
                    reachedEnd ||
                    rawResultsEmpty ||
                    consecutiveEmptyFiltered >= emptyFilteredLimit) {
                    break;
                }
                currentPage = nextPage;
                safetyCounter += 1;
            }
            items = items.slice(0, searchPageSize);
            const hasNextPage = bufferedGalleries.length > 0 ||
                rateLimitedEarlyReturn ||
                (typeof knownNumPages === "number" && nextPage <= knownNumPages);
            // Track consecutive empty pages to prevent infinite loops
            if (items.length === 0 && hasNextPage) {
                this.searchConsecutiveEmpty++;
            }
            else {
                this.searchConsecutiveEmpty = 0;
            }
            // Continue pagination when filters remove all items but more pages exist.
            // Strict favorites/date filters can legitimately burn through several
            // pages before finding enough hydrated matches, so use a wider cap.
            const continueOffset = hasNextPage && this.searchConsecutiveEmpty < continuationEmptyLimit;
            this.searchBufferSessionKey = searchSessionKey;
            this.searchBufferGalleries = bufferedGalleries;
            this.searchBufferNextPage = nextPage;
            this.searchBufferNumPages = knownNumPages;
            if (!continueOffset) {
                this.searchBufferGalleries = [];
            }
            logDebug("search:return", `items=${items.length}`, `hasNext=${hasNextPage}`, `continue=${continueOffset}`, `nextPage=${continueOffset ? nextPage : "none"}`, `buffered=${bufferedGalleries.length}`, `elapsedMs=${Date.now() - searchStart}`);
            recordDisplayedTiles(items);
            // Trigger prefetch for next page when approaching pagination boundary
            // Only for search/discover (not page 2 of new search), when largest multiple of page size <= 25 is reached
            const isPastFirstPage = currentPage > 1;
            const isNotSecondPageNewSearch = !(currentPage === 2 && pagination?.page === undefined);
            const prefetchThreshold = 25 - (25 % searchPageSize);
            const shouldPrefetch = isPastFirstPage &&
                isNotSecondPageNewSearch &&
                items.length >= prefetchThreshold &&
                nextPage <= (knownNumPages ?? 999);
            if (shouldPrefetch) {
                this.triggerSearchPrefetch(searchQuery, nextPage, sortOrder, titleOrGroups, searchSessionKey);
            }
            const sortLabel = this.formatSearchSortLabel(effectiveSort);
            const filterSummary = formatSearchFilterSummary(filteredSkippedTotal, readSkippedTotal, true);
            console.log(`[NHentai] ${sortLabel}: ${items.length} items${filterSummary}, ${Date.now() - searchStart}ms`);
            // Build description showing filtered and read item counts
            const descriptionParts = [];
            if (filteredSkippedTotal > 0)
                descriptionParts.push(`${filteredSkippedTotal} filtered`);
            if (readSkippedTotal > 0)
                descriptionParts.push(`${readSkippedTotal} read`);
            const description = descriptionParts.length > 0 ? descriptionParts.join(", ") : undefined;
            return {
                items,
                metadata: continueOffset
                    ? {
                        page: nextPage,
                        nextPage,
                        numPages: knownNumPages,
                    }
                    : undefined,
                description,
            };
        }
        catch (e) {
            if (e instanceof CloudflareError)
                throw e;
            console.error("[NHentai Search] Unexpected error", e, {
                query,
                metadata,
                sorting: sortingOption,
            });
            return { items: [], metadata: undefined };
        }
    }
    async getMangaDetails(mangaId) {
        const gallery = await this.fetchGallery(mangaId);
        // Mark as read when viewing details if setting is enabled
        if (getHideReadSetting() && getMarkReadOnViewSetting()) {
            const readTags = gallery.tags
                .filter((t) => t.type === "tag")
                .map((t) => t.name)
                .slice(0, 12);
            const { isFirstRead } = markMangaAsRead(gallery.id.toString(), gallery.title.pretty || gallery.title.english || gallery.title.japanese, readTags, { trackStats: false });
            if (isFirstRead && !getDescMarkedReadIds().has(gallery.id.toString())) {
                incrementMarkReadOnDescCount();
            }
            addDescMarkedReadId(gallery.id.toString());
        }
        // Track statistics (non-blocking)
        try {
            ensureInstallDate();
            incrementDisplayedManga(mangaId);
        }
        catch {
            /* stats tracking should never break main flow */
        }
        this.debouncedInvalidateSearchFilters();
        const secondaryTitles = [
            gallery.title.english,
            gallery.title.japanese,
            gallery.title.pretty,
        ].filter((title) => !!title);
        const { synopsis, excludedTags } = this.createSynopsis(gallery);
        const tagSections = this.createTagSections(gallery, excludedTags);
        const thumbnailUrl = this.buildCoverUrl(gallery);
        const creators = getCreatorFieldsFromTags(gallery.tags);
        return {
            mangaId: gallery.id.toString(),
            mangaInfo: {
                primaryTitle: gallery.title.pretty,
                secondaryTitles: Array.from(new Set(secondaryTitles)),
                thumbnailUrl,
                synopsis,
                rating: 0,
                status: "COMPLETED",
                author: creators.author,
                contentRating: ContentRating.ADULT,
                tagGroups: tagSections,
                shareUrl: `${DOMAIN}/g/${gallery.id}`,
            },
        };
    }
    // State keys for related caching/persistence and counters
    RELATED_POOL_STATE_KEY = "nhentai.relatedPool";
    RELATED_POOL_HISTORY_INDEX_KEY = "nhentai.relatedPoolHistoryIndex";
    RELATED_POOL_SEEN_IDS_KEY = "nhentai.relatedPoolSeenIds";
    RELATED_POOL_MAX_CURSOR_KEY = "nhentai.relatedPoolMaxCursor";
    NONCAROUSEL_PAGE_COUNT_KEY = "nhentai.nonCarouselPageCount";
    // Lazy loading configuration
    LAZY_BATCH_SIZE = 4; // Load 4 history items at a time (reduced from 8 to avoid 429s)
    RELATED_PER_HISTORY = 5; // Max related per history item
    // Tile store: media_id + thumb info from search/related responses.
    // Persisted across sessions so history/reread/related sections avoid
    // gallery detail requests in lite mode (no date subtitles).
    tileStore = new Map();
    tileStoreDirty = false;
    galleryPending = new Map();
    galleryRecentCache = new Map();
    relatedPoolCache;
    relatedPoolLastHistoryIndex = 0;
    relatedPoolSeenIds = new Set();
    relatedPoolHistoryIds = new Set(); // Track history IDs to exclude from relatedIds
    relatedPoolMaxCursor = 0; // Max pool cursor seen across sessions for age-out
    // True when the pool was restored from persisted state this session.
    // When false, expandRelatedPool already populated the tile store in-session,
    // so the rescrape block in getRelatedSection is redundant and would issue
    // duplicate /api/v2/galleries/{id}/related requests.
    relatedPoolRestoredFromPersistence = false;
    // Session-based page tracking: maps item ID → page number when first displayed
    // Used to hide items after the configured related age window.
    searchConsecutiveEmpty = 0; // Track consecutive empty pages to prevent infinite loops
    searchBufferSessionKey = "";
    searchBufferGalleries = [];
    searchBufferNextPage = 1;
    searchBufferNumPages;
    prefetchedPageMediaIds = [];
    prefetchInProgress = false;
    lastPrefetchSessionKey = "";
    galleryDetailRateLimited = false;
    galleryDetailProbeAfter = 0;
    GALLERY_DETAIL_PROBE_INTERVAL_MS = 900;
    restoreSearchCache() {
        try {
            const saved = Application.getState(SEARCH_CACHE_STATE_KEY);
            if (!saved?.entries)
                return;
            const now = Date.now();
            let restoredCount = 0;
            for (const [key, entry] of saved.entries) {
                if (!entry?.response || now - entry.ts > this.getSearchCacheTtl(key)) {
                    continue;
                }
                this.searchCache.set(key, {
                    response: this.cloneQueryResponse(entry.response),
                    ts: entry.ts,
                });
                // Populate tile store from cached search pages so history/related sections
                // can build tiles without hitting gallery detail on startup.
                for (const gallery of entry.response.result ?? []) {
                    this.storeTileFromGallery(gallery);
                }
                restoredCount++;
            }
            if (restoredCount > 0) {
                console.log(`[NHentai] Restored ${restoredCount} cached search pages`);
            }
        }
        catch {
            // Ignore restore failures
        }
    }
    saveSearchCache() {
        try {
            const now = Date.now();
            const entries = [...this.searchCache.entries()]
                .filter(([key, entry]) => now - entry.ts < this.getSearchCacheTtl(key))
                .sort((a, b) => b[1].ts - a[1].ts)
                .slice(0, 120)
                .map(([key, entry]) => [
                key,
                {
                    response: this.cloneQueryResponse(entry.response),
                    ts: entry.ts,
                },
            ]);
            Application.setState({ entries }, SEARCH_CACHE_STATE_KEY);
        }
        catch {
            // Ignore save failures
        }
    }
    restoreTileStore() {
        try {
            const saved = Application.getState(TILE_STORE_STATE_KEY);
            if (!Array.isArray(saved))
                return;
            for (const [key, tile] of saved) {
                if (key && tile?.id && tile.mediaId) {
                    this.tileStore.set(key, tile);
                }
            }
        }
        catch {
            // Ignore restore failures
        }
    }
    saveTileStore() {
        if (!this.tileStoreDirty)
            return;
        this.tileStoreDirty = false;
        try {
            const entries = [...this.tileStore.entries()];
            Application.setState(entries, TILE_STORE_STATE_KEY);
        }
        catch {
            // Ignore save failures
        }
    }
    getSearchCacheTtl(cacheKey) {
        const [sortPart, pagePart] = cacheKey.split("|");
        const page = Number.parseInt(pagePart ?? "", 10);
        const isNewestFeed = sortPart === "date" || sortPart === "";
        return page === 1 && isNewestFeed ? GALLERY_CACHE_PAGE1_TTL_MS : SEARCH_CACHE_TTL_MS;
    }
    storeTileFromGallery(gallery) {
        if (!gallery?.id || !gallery.media_id)
            return;
        const thumbPath = gallery.images.thumbnail?.path ?? gallery.images.cover?.path ?? "";
        if (!thumbPath && !gallery.images.pages[0]?.path)
            return;
        const existing = this.tileStore.get(gallery.id.toString());
        // Preserve language tag ids so related/history tiles can still show language
        // codes after a full gallery fetch overwrites a search/related list tile.
        const languageTagIds = (gallery.tags ?? [])
            .filter((tag) => {
            if (tag.type !== "language")
                return false;
            const name = tag.name?.toLowerCase().trim();
            return name === "english" || name === "chinese" || name === "japanese";
        })
            .map((tag) => tag.id);
        // Prefer API pretty when present; otherwise strip prefixes/suffixes from raw titles.
        const pretty = gallery.title?.pretty?.trim() ||
            toPrettyTitle(gallery.title?.english) ||
            toPrettyTitle(gallery.title?.japanese) ||
            gallery.title?.english ||
            gallery.title?.japanese ||
            `Gallery ${gallery.id}`;
        this.tileStore.set(gallery.id.toString(), {
            id: gallery.id,
            title: pretty,
            mediaId: gallery.media_id,
            thumbPath,
            num_pages: gallery.num_pages ?? 0,
            num_favorites: gallery.num_favorites ?? 0,
            tag_ids: languageTagIds.length > 0 ? languageTagIds : existing?.tag_ids,
            upload_date: gallery.upload_date > 0 ? gallery.upload_date : existing?.upload_date,
        });
        this.tileStoreDirty = true;
    }
    storeTileFromListItem(item) {
        if (!item?.id || !item.media_id || !item.thumbnail)
            return;
        this.tileStore.set(item.id.toString(), {
            id: item.id,
            title: prettyTitleFromListItem(item),
            mediaId: item.media_id,
            thumbPath: item.thumbnail,
            num_pages: item.num_pages ?? 0,
            num_favorites: item.num_favorites ?? 0,
            tag_ids: item.tag_ids,
        });
        this.tileStoreDirty = true;
    }
    buildGalleryFromTile(tile) {
        const tags = (tile.tag_ids ?? []).map((id) => {
            let name = "";
            let type = "unknown";
            if (id === LANGUAGE_TAG_IDS.english) {
                name = "english";
                type = "language";
            }
            else if (id === LANGUAGE_TAG_IDS.chinese) {
                name = "chinese";
                type = "language";
            }
            else if (id === LANGUAGE_TAG_IDS.japanese) {
                name = "japanese";
                type = "language";
            }
            return { id, type, name, url: "", count: 0 };
        });
        return {
            id: tile.id,
            media_id: tile.mediaId,
            isLite: true,
            title: { pretty: tile.title },
            images: {
                pages: [],
                cover: { path: tile.thumbPath, t: this.getImageTypeFromPath(tile.thumbPath) },
                thumbnail: { path: tile.thumbPath, t: this.getImageTypeFromPath(tile.thumbPath) },
            },
            tags,
            num_pages: tile.num_pages,
            num_favorites: tile.num_favorites,
            upload_date: tile.upload_date ?? 0,
        };
    }
    getNextGalleryDetailProbeAt(now = Date.now()) {
        const WINDOW_MS = 60_000;
        const detailQueue = burstQueues.galleryDetail;
        detailQueue.timestamps = detailQueue.timestamps.filter((t) => t > now - WINDOW_MS);
        if (detailQueue.timestamps.length < getEndpointRateLimit("galleryDetail")) {
            return now + this.GALLERY_DETAIL_PROBE_INTERVAL_MS;
        }
        const oldestTimestamp = detailQueue.timestamps[0] ?? now;
        return Math.max(now + this.GALLERY_DETAIL_PROBE_INTERVAL_MS, oldestTimestamp + WINDOW_MS + 20);
    }
    markGalleryDetailRateLimited() {
        this.galleryDetailRateLimited = true;
        this.galleryDetailProbeAfter = this.getNextGalleryDetailProbeAt();
    }
    clearGalleryDetailRateLimited() {
        this.galleryDetailRateLimited = false;
        this.galleryDetailProbeAfter = 0;
    }
    incrementNonCarouselCounter() {
        try {
            const current = Application.getState(this.NONCAROUSEL_PAGE_COUNT_KEY) ?? 0;
            Application.setState(current + 1, this.NONCAROUSEL_PAGE_COUNT_KEY);
        }
        catch {
            /* ignore */
        }
    }
    async fetchRelatedPool(neededCount = 20) {
        try {
            // Get ordered read history (newest first)
            const history = getReadCache().ordered;
            if (history.length === 0) {
                logDebug("fetchRelatedPool: No read history");
                return [];
            }
            // Check if in-session cached pool exists but read history changed at index 0 (new read item added)
            if (this.relatedPoolCache && this.relatedPoolCache.length > 0 && history.length > 0) {
                const cycle1Item = this.relatedPoolCache.find((p) => p.cycleIndex === 1 && p.tag.startsWith("[r"));
                if (cycle1Item && cycle1Item.id.toString() !== history[0]) {
                    logDebug("fetchRelatedPool: In-session history mismatch at cycle 1, invalidating pool cache");
                    this.invalidateRelatedPool();
                }
            }
            // Initialize pool if needed
            if (!this.relatedPoolCache) {
                this.relatedPoolCache = [];
                this.relatedPoolLastHistoryIndex = 0;
                // Keep seenIds empty initially - base manga are added first, then marked seen
                // historyIds is used separately to prevent base manga from appearing via relatedIds
                this.relatedPoolSeenIds = new Set();
                this.relatedPoolHistoryIds = new Set(history.map((hid) => parseInt(hid, 10)).filter((id) => !Number.isNaN(id)));
                this.relatedPoolRestoredFromPersistence = false;
                // Try to restore from persisted state
                try {
                    const persistedPool = Application.getState(this.RELATED_POOL_STATE_KEY);
                    const persistedIndex = Application.getState(this.RELATED_POOL_HISTORY_INDEX_KEY);
                    const persistedSeenIds = Application.getState(this.RELATED_POOL_SEEN_IDS_KEY);
                    const persistedMaxCursor = Application.getState(this.RELATED_POOL_MAX_CURSOR_KEY);
                    if (persistedPool && persistedPool.length > 0 && typeof persistedIndex === "number") {
                        // Validate that history hasn't changed at processed positions
                        let valid = true;
                        for (let i = 0; i < Math.min(persistedIndex, history.length); i++) {
                            // Check for base manga [rN] tag format
                            const poolItem = persistedPool.find((p) => p.cycleIndex === i + 1 && p.tag.startsWith("[r"));
                            if (poolItem && poolItem.id.toString() !== history[i]) {
                                valid = false;
                                break;
                            }
                        }
                        if (valid) {
                            this.relatedPoolCache = persistedPool;
                            this.relatedPoolLastHistoryIndex = persistedIndex;
                            // Always rebuild seenIds from the pool itself so that expandRelatedPool
                            // never re-adds items already in the pool (guards against stale/empty persisted seenIds).
                            this.relatedPoolSeenIds = new Set([
                                ...persistedPool.map((p) => p.id),
                                ...(persistedSeenIds ?? []),
                            ]);
                            this.relatedPoolMaxCursor =
                                typeof persistedMaxCursor === "number" ? persistedMaxCursor : 0;
                            // Pool was restored from persistence — tile store may not have tiles
                            // for these IDs, so getRelatedSection's rescrape block is needed.
                            this.relatedPoolRestoredFromPersistence = true;
                            logDebug(`fetchRelatedPool: Restored pool with ${persistedPool.length} items, index ${persistedIndex}, maxCursor ${this.relatedPoolMaxCursor}`);
                        }
                    }
                }
                catch {
                    // Ignore state errors
                }
            }
            // Check if we need to load more
            while (this.relatedPoolCache.length < neededCount &&
                this.relatedPoolLastHistoryIndex < history.length) {
                await this.expandRelatedPool(history);
            }
            // Persist once after all expansions (not per-batch)
            this.persistRelatedPool();
            return this.relatedPoolCache;
        }
        catch (e) {
            if (e instanceof CloudflareError)
                throw e;
            console.error("[NHentai] fetchRelatedPool failed", e);
            return this.relatedPoolCache ?? [];
        }
    }
    async expandRelatedPool(history) {
        const startIndex = this.relatedPoolLastHistoryIndex;
        const endIndex = Math.min(startIndex + this.LAZY_BATCH_SIZE, history.length);
        if (startIndex >= history.length) {
            logDebug("expandRelatedPool: All history processed");
            return;
        }
        logDebug(`expandRelatedPool: Processing history ${startIndex}-${endIndex} of ${history.length}`);
        logDebug("expandRelatedPool: before", `pool=${this.relatedPoolCache?.length ?? 0}`, `seen=${this.relatedPoolSeenIds.size}`, `historyIds=${this.relatedPoolHistoryIds.size}`);
        const batch = history.slice(startIndex, endIndex);
        // History IDs are the gallery numeric IDs as strings — parse directly.
        // No gallery detail request needed to build the related pool.
        const validGalleries = batch
            .map((hid, batchIndex) => {
            const numId = parseInt(hid, 10);
            if (!Number.isFinite(numId) || numId <= 0)
                return null;
            return { id: numId, historyId: hid, batchIndex };
        })
            .filter((g) => g !== null);
        // Scrape related IDs with adaptive concurrency — start at 2 parallel
        // requests, fall back to sequential on any 429/Cloudflare error.
        const relatedResults = [];
        let concurrency = 2;
        let i = 0;
        while (i < validGalleries.length) {
            const chunk = validGalleries.slice(i, i + concurrency);
            const chunkResults = await Promise.all(chunk.map(async (hg) => {
                try {
                    const relatedIds = await this.scrapeRelatedManga(hg.historyId);
                    return {
                        historyId: hg.historyId,
                        historyGalleryId: hg.id,
                        relatedIds,
                        batchIndex: hg.batchIndex,
                        hitRateLimit: false,
                    };
                }
                catch (e) {
                    if (e instanceof CloudflareError)
                        throw e;
                    const msg = getErrorMessage(e);
                    const isRateLimit = msg.includes("429") || msg.includes("Cloudflare") || msg.includes("Non-JSON");
                    if (isRateLimit) {
                        logDebug("expandRelatedPool: 429 detected, reducing concurrency");
                    }
                    return {
                        historyId: hg.historyId,
                        historyGalleryId: hg.id,
                        relatedIds: [],
                        batchIndex: hg.batchIndex,
                        hitRateLimit: isRateLimit,
                    };
                }
            }));
            const hadRateLimit = chunkResults.some((r) => r.hitRateLimit);
            if (hadRateLimit) {
                concurrency = 1; // Fall back to sequential for remaining items
                await this.pause(30);
            }
            relatedResults.push(...chunkResults.map((entry) => ({
                historyId: entry.historyId,
                historyGalleryId: entry.historyGalleryId,
                relatedIds: entry.relatedIds,
                batchIndex: entry.batchIndex,
            })));
            i += chunk.length;
        }
        // Process each history item and add to pool.
        // Language filtering is NOT done here — getRelatedSection() handles it
        // at display time. This avoids loading every related gallery just to
        // check its language, which caused 429 errors on NHentai.
        for (const r of relatedResults) {
            const cycleIndex = startIndex + r.batchIndex + 1;
            // Add the read manga as [rN] — always add base regardless of seenIds
            // (a manga previously seen as a related item of another cycle may now be
            // the history item for this cycle; relatedPoolHistoryIds guards against the
            // reverse direction: a history item appearing as someone else's related).
            const alreadyInPool = this.relatedPoolCache.some((p) => p.id === r.historyGalleryId);
            if (!alreadyInPool) {
                this.relatedPoolCache.push({
                    id: r.historyGalleryId,
                    tag: `[r${cycleIndex}]`,
                    cycleIndex,
                });
                this.relatedPoolSeenIds.add(r.historyGalleryId);
            }
            // Add related manga (unfiltered — language filtering is deferred)
            let relatedCount = 0;
            for (const rid of r.relatedIds) {
                if (relatedCount >= this.RELATED_PER_HISTORY)
                    break;
                if (this.relatedPoolSeenIds.has(rid))
                    continue;
                if (this.relatedPoolHistoryIds.has(rid))
                    continue; // Skip other base manga
                relatedCount++;
                this.relatedPoolCache.push({
                    id: rid,
                    tag: `[${relatedCount}]`,
                    cycleIndex,
                });
                this.relatedPoolSeenIds.add(rid);
            }
            logDebug("expandRelatedPool: cycle", `cycle=${cycleIndex}`, `base=${r.historyGalleryId}`, `relatedFetched=${r.relatedIds.length}`, `relatedAdded=${relatedCount}`);
        }
        // IMPORTANT: Always advance to endIndex, not startIndex + validGalleries.length
        // This ensures we don't re-process failed items or get stuck in a loop
        this.relatedPoolLastHistoryIndex = endIndex;
        logDebug(`expandRelatedPool: Pool now has ${this.relatedPoolCache.length} items`);
        logDebug("expandRelatedPool: after", `pool=${this.relatedPoolCache.length}`, `seen=${this.relatedPoolSeenIds.size}`, `lastHistoryIndex=${this.relatedPoolLastHistoryIndex}`);
    }
    /** Persist related pool state once (called after the expansion while-loop). */
    persistRelatedPool() {
        try {
            Application.setState(this.relatedPoolCache, this.RELATED_POOL_STATE_KEY);
            Application.setState(this.relatedPoolLastHistoryIndex, this.RELATED_POOL_HISTORY_INDEX_KEY);
            Application.setState(Array.from(this.relatedPoolSeenIds), this.RELATED_POOL_SEEN_IDS_KEY);
            Application.setState(this.relatedPoolMaxCursor, this.RELATED_POOL_MAX_CURSOR_KEY);
        }
        catch {
            // Ignore state errors
        }
    }
    invalidateRelatedPool() {
        this.relatedPoolCache = undefined;
        this.relatedPoolLastHistoryIndex = 0;
        this.relatedPoolSeenIds = new Set();
        this.relatedPoolHistoryIds = new Set();
        this.relatedPoolMaxCursor = 0;
        this.relatedPoolRestoredFromPersistence = false;
        try {
            Application.setState(undefined, this.RELATED_POOL_STATE_KEY);
            Application.setState(undefined, this.RELATED_POOL_HISTORY_INDEX_KEY);
            Application.setState(undefined, this.RELATED_POOL_SEEN_IDS_KEY);
            Application.setState(undefined, this.RELATED_POOL_MAX_CURSOR_KEY);
        }
        catch {
            // Ignore
        }
        logDebug("Related pool invalidated");
    }
    async scrapeRelatedManga(mangaId) {
        try {
            // Always fetch fresh to populate tile store with tag_ids and metadata.
            // Tile store is used by getRelatedSection to avoid gallery detail requests.
            logDebug("scrapeRelatedManga: fetching related for", mangaId);
            const response = await this.fetchJson({
                url: `${API_V2_URL}/galleries/${encodeURIComponent(mangaId)}/related`,
                method: "GET",
            });
            logDebug("scrapeRelatedManga: received", response.result?.length ?? 0, "items for", mangaId);
            // Store tile info for each related item so related/history sections
            // can render without further gallery detail requests in lite mode.
            for (const item of response.result ?? []) {
                this.storeTileFromListItem(item);
            }
            const relatedIds = (response.result ?? [])
                .map((entry) => entry.id)
                .filter((id) => Number.isFinite(id) && id.toString() !== mangaId);
            logDebug("Loaded", relatedIds.length, "related IDs for", mangaId);
            this.saveTileStore();
            return relatedIds;
        }
        catch (e) {
            if (e instanceof CloudflareError)
                throw e;
            logDebug("Failed to load related manga for", mangaId, e);
            return [];
        }
    }
    async getRelatedSection(metadata, forSearch = false) {
        if (!getEnableRelatedSetting())
            return { items: [], metadata: undefined };
        const offset = getEffectiveOffset(metadata);
        const relatedCarouselTiles = getCarouselTiles();
        const discoverPageSize = getDiscoverPageSize();
        const searchPageSize = getSearchPageSize();
        const limit = forSearch
            ? searchPageSize
            : offset === 0
                ? relatedCarouselTiles
                : discoverPageSize;
        const minItems = forSearch
            ? searchPageSize
            : offset === 0
                ? relatedCarouselTiles
                : discoverPageSize;
        if (limit <= 0) {
            return { items: [], metadata: undefined };
        }
        try {
            const history = getReadCache().ordered;
            if (history.length === 0) {
                logDebug("getRelatedSection: No history");
                return { items: [], metadata: undefined };
            }
            let neededItems = offset + limit + 40;
            let pool = await this.fetchRelatedPool(neededItems);
            if (pool.length === 0) {
                logDebug("getRelatedSection: Empty pool");
                return { items: [], metadata: undefined };
            }
            const hideReadInRelated = getHideReadInRelatedSetting();
            const readCache = hideReadInRelated ? getReadCache() : null;
            const descMarkedIds = getHideReadSetting() && getMarkReadOnViewSetting() ? getDescMarkedReadIds() : null;
            const filterPool = (p) => {
                return p.filter((item) => {
                    const isBaseCycle = item.tag.startsWith("[r");
                    if (!isBaseCycle && hideReadInRelated && readCache && readCache.has(item.id.toString()))
                        return false;
                    if (!isBaseCycle && descMarkedIds && descMarkedIds.has(item.id.toString()))
                        return false;
                    return true;
                });
            };
            const alignPoolStart = () => {
                const firstCycleStart = pool.findIndex((item) => item.tag === "[r1]");
                if (firstCycleStart > 0) {
                    pool = pool.slice(firstCycleStart);
                }
            };
            pool = filterPool(pool);
            alignPoolStart();
            for (let tries = 0; tries < 3 &&
                pool.length < offset + minItems &&
                this.relatedPoolLastHistoryIndex < history.length; tries++) {
                neededItems += 80;
                pool = filterPool(await this.fetchRelatedPool(neededItems));
                alignPoolStart();
            }
            if (pool.length < offset + minItems && this.relatedPoolLastHistoryIndex < history.length) {
                pool = filterPool(await this.fetchRelatedPool(offset + limit + 120));
                alignPoolStart();
                if (pool.length <= offset) {
                    return { items: [], metadata: undefined };
                }
            }
            let cursor = Math.min(offset, pool.length);
            if (cursor >= pool.length) {
                return { items: [], metadata: undefined };
            }
            const items = [];
            const relatedLang = getRelatedLanguageSetting();
            const displayOptions = getDisplayOptionsSetting();
            const showRelatedOrder = displayOptions.includes("show_related_order");
            const seenIds = new Set();
            let expansions = 0;
            let languageSkipped = 0;
            // For pool items in the upcoming display window: if any tiles are missing,
            // re-scrape that cycle's base (fetches related tiles).
            // Lookahead is capped to the current page (limit items) to avoid bursting
            // related requests for cycles far ahead on each scroll.
            //
            // Only run when the pool was restored from persistence this session.
            // When expandRelatedPool built the pool in-session, scrapeRelatedManga
            // already populated the tile store — re-running it here would issue
            // duplicate /api/v2/galleries/{id}/related requests.
            const windowEnd = Math.min(cursor + limit, pool.length);
            const windowSlice = pool.slice(cursor, windowEnd);
            // Find cycles that have any missing tiles (cap at 4 to avoid 429s)
            const cyclesNeedingRescrape = new Set();
            if (this.relatedPoolRestoredFromPersistence) {
                for (const item of windowSlice) {
                    if (cyclesNeedingRescrape.size >= 4)
                        break;
                    if (!this.tileStore.has(item.id.toString())) {
                        cyclesNeedingRescrape.add(item.cycleIndex);
                    }
                }
            }
            if (cyclesNeedingRescrape.size > 0) {
                const rescrapePromises = [];
                for (const cycleIndex of cyclesNeedingRescrape) {
                    const historyId = history[cycleIndex - 1];
                    if (!historyId)
                        continue;
                    rescrapePromises.push((async () => {
                        try {
                            // Re-scrape related tiles for this cycle to populate tile store
                            await this.scrapeRelatedManga(historyId);
                        }
                        catch {
                            /* non-critical */
                        }
                    })());
                }
                if (rescrapePromises.length > 0) {
                    await Promise.all(rescrapePromises);
                }
            }
            while (items.length < limit) {
                if (cursor >= pool.length) {
                    if (this.relatedPoolLastHistoryIndex >= history.length || expansions >= 3)
                        break;
                    neededItems += 80;
                    pool = filterPool(await this.fetchRelatedPool(neededItems));
                    alignPoolStart();
                    expansions++;
                    if (cursor >= pool.length)
                        continue;
                }
                const item = pool[cursor++];
                if (seenIds.has(item.id))
                    continue;
                seenIds.add(item.id);
                const isBaseCycle = item.tag.startsWith("[r");
                if (!isBaseCycle && hideReadInRelated && readCache && readCache.has(item.id.toString())) {
                    continue;
                }
                // Language filter — tile always has tag_ids from /related response
                if (!isBaseCycle && relatedLang !== "all") {
                    const tile = this.tileStore.get(item.id.toString());
                    const tagIds = tile?.tag_ids ?? [];
                    const hasPreferredLanguage = relatedLang === "english"
                        ? tagIds.includes(LANGUAGE_TAG_IDS.english)
                        : relatedLang === "chinese"
                            ? tagIds.includes(LANGUAGE_TAG_IDS.chinese)
                            : relatedLang === "japanese"
                                ? tagIds.includes(LANGUAGE_TAG_IDS.japanese)
                                : false;
                    if (!hasPreferredLanguage) {
                        languageSkipped++;
                        continue;
                    }
                }
                // Build display data from tile store.
                // Base [rN] items may have no tile if never fetched this session;
                // fetch unconditionally to render them at all.
                // For all items, if date display is on and the tile lacks upload_date,
                // fetch gallery detail to hydrate it — but only when not rate-limited.
                let tile = this.tileStore.get(item.id.toString());
                const needsDate = !this.galleryDetailRateLimited &&
                    (displayOptions.includes("subtitle_relative") ||
                        displayOptions.includes("subtitle_date"));
                if (!tile && isBaseCycle) {
                    try {
                        const gallery = await this.fetchGallery(item.id.toString());
                        if (gallery)
                            tile = this.tileStore.get(item.id.toString());
                    }
                    catch {
                        /* non-critical — skip if rate-limited */
                    }
                }
                else if (tile && needsDate && !tile.upload_date) {
                    try {
                        const gallery = await this.fetchGallery(item.id.toString());
                        if (gallery)
                            tile = this.tileStore.get(item.id.toString());
                    }
                    catch {
                        /* non-critical */
                    }
                }
                const displayGallery = tile ? this.buildGalleryFromTile(tile) : null;
                if (!displayGallery)
                    continue;
                const title = displayGallery.title.pretty ??
                    displayGallery.title.english ??
                    displayGallery.title.japanese ??
                    "";
                const baseSubtitle = this.createSubtitle(displayGallery, {
                    rereadCount: getRereadCount(displayGallery.id.toString()),
                });
                const subtitle = showRelatedOrder ? `${item.tag} ${baseSubtitle}` : baseSubtitle;
                items.push({
                    type: "simpleCarouselItem",
                    mangaId: normalizeBridgeString(displayGallery.id, item.id.toString()),
                    title: normalizeBridgeString(title, `Gallery ${item.id}`),
                    subtitle: normalizeBridgeString(subtitle),
                    imageUrl: normalizeBridgeString(this.buildCoverUrl(displayGallery)),
                    metadata: undefined,
                });
                incrementRelatedViewCount(item.id);
            }
            const hasMoreInPool = cursor < pool.length;
            const hasMoreHistory = this.relatedPoolLastHistoryIndex < history.length;
            const hasMore = hasMoreInPool || hasMoreHistory;
            recordDisplayedTiles(items);
            const description = languageSkipped > 0 ? `${languageSkipped} language filtered` : undefined;
            return {
                items,
                metadata: hasMore ? buildOffsetMetadata(offset + items.length, cursor) : undefined,
                description,
            };
        }
        catch (e) {
            if (e instanceof CloudflareError)
                throw e;
            console.error("[NHentai Related] Failed", e);
            return { items: [], metadata: undefined };
        }
    }
    async getLastReadSection(metadata, forSearch = false) {
        try {
            const offset = getEffectiveOffset(metadata);
            const limit = forSearch
                ? getSearchPageSize()
                : offset === 0
                    ? getCarouselTiles()
                    : getDiscoverPageSize();
            if (limit <= 0) {
                return { items: [], metadata: undefined };
            }
            // Get ordered read history (newest first)
            const history = getReadCache().ordered;
            if (history.length === 0) {
                return { items: [], metadata: undefined };
            }
            // Slice the history for this page
            const slice = history.slice(offset, offset + limit);
            if (slice.length === 0) {
                return { items: [], metadata: undefined };
            }
            const items = [];
            const galleryResults = await Promise.all(slice.map(async (id) => {
                try {
                    const tile = this.tileStore.get(id);
                    const gallery = tile
                        ? this.buildGalleryFromTile(tile)
                        : await this.fetchGallery(id);
                    if (!gallery)
                        return null;
                    return this.mapGalleryToDiscoverItem(gallery);
                }
                catch (e) {
                    logDebug("[NHentai Last Read] Failed to load gallery", id, e);
                    return null;
                }
            }));
            items.push(...galleryResults.filter((r) => r !== null));
            const hasMore = offset + limit < history.length;
            recordDisplayedTiles(items);
            return {
                items,
                metadata: hasMore ? buildOffsetMetadata(offset + limit, offset + limit) : undefined,
            };
        }
        catch (e) {
            if (e instanceof CloudflareError)
                throw e;
            console.error("[NHentai Last Read] Failed", e);
            return { items: [], metadata: undefined };
        }
    }
    async getTopRereadSection(metadata, forSearch = false) {
        try {
            const offset = getEffectiveOffset(metadata);
            const limit = forSearch
                ? getSearchPageSize()
                : offset === 0
                    ? getCarouselTiles()
                    : getDiscoverPageSize();
            if (limit <= 0) {
                return { items: [], metadata: undefined };
            }
            const allReread = getAllRereadManga();
            if (allReread.length === 0) {
                return { items: [], metadata: undefined };
            }
            const slice = allReread.slice(offset, offset + limit);
            if (slice.length === 0) {
                return { items: [], metadata: undefined };
            }
            const items = [];
            const galleryResults = await Promise.all(slice.map(async (entry) => {
                try {
                    const tile = this.tileStore.get(entry.mangaId);
                    const gallery = tile
                        ? this.buildGalleryFromTile(tile)
                        : await this.fetchGallery(entry.mangaId);
                    if (!gallery)
                        return null;
                    const title = gallery.title?.pretty ||
                        gallery.title?.english ||
                        gallery.title?.japanese ||
                        `Gallery ${entry.mangaId}`;
                    return {
                        type: "simpleCarouselItem",
                        mangaId: normalizeBridgeString(gallery.id, entry.mangaId),
                        imageUrl: normalizeBridgeString(this.buildCoverUrl(gallery)),
                        title: normalizeBridgeString(title, `Gallery ${entry.mangaId}`),
                        subtitle: normalizeBridgeString(this.createTileSubtitle(gallery, {
                            rereadCount: entry.count,
                            isTopReread: true,
                        }).trim()),
                        contentRating: ContentRating.ADULT,
                        metadata: undefined,
                    };
                }
                catch (e) {
                    logDebug("[NHentai Top Reread] Failed to load gallery", entry.mangaId, e);
                    return null;
                }
            }));
            items.push(...galleryResults.filter((r) => r !== null));
            const hasMore = offset + limit < allReread.length;
            recordDisplayedTiles(items);
            return {
                items,
                metadata: hasMore ? buildOffsetMetadata(offset + limit, offset + limit) : undefined,
            };
        }
        catch (e) {
            if (e instanceof CloudflareError)
                throw e;
            console.error("[NHentai Top Reread] Failed", e);
            return { items: [], metadata: undefined };
        }
    }
    async getChapters(sourceManga) {
        const existingInfo = sourceManga.mangaInfo;
        const bestEffortTitle = existingInfo?.primaryTitle || existingInfo?.secondaryTitles?.[0] || sourceManga.mangaId;
        const chapterTitle = bestEffortTitle;
        const sourceMangaWithMetadata = sourceManga;
        sourceMangaWithMetadata.metadata = {
            ...sourceMangaWithMetadata.metadata,
            chapterTitle,
            chapterId: sourceManga.mangaId,
            subtitle: existingInfo?.author ?? "",
        };
        let cachedGallery;
        try {
            cachedGallery = await this.fetchGallery(sourceManga.mangaId);
        }
        catch (error) {
            logDebug("Synchronous gallery fetch failed", error);
        }
        const publishDate = cachedGallery?.upload_date
            ? new Date(cachedGallery.upload_date * 1000)
            : new Date();
        const chapter = {
            chapterId: sourceManga.mangaId,
            sourceManga,
            title: chapterTitle,
            volume: 0,
            chapNum: 1,
            langCode: cachedGallery ? this.getChapterLanguageCode(cachedGallery) : "unk",
            publishDate,
        };
        return [chapter];
    }
    async getChapterDetails(chapter) {
        const gallery = await this.fetchGallery(chapter.chapterId);
        this.requestManager.resetImageFastWindowForGallery(gallery.media_id);
        const pages = gallery.images.pages.map((image, index) => this.buildPageUrl(gallery, index + 1, image));
        // Persist read state — use parent manga id only to avoid double-counting
        const readTags = gallery.tags
            .filter((t) => t.type === "tag")
            .map((t) => t.name)
            .slice(0, 12);
        const wasDescMarked = getDescMarkedReadIds().has(chapter.sourceManga.mangaId);
        markMangaAsRead(chapter.sourceManga.mangaId, gallery.title.pretty || gallery.title.english || gallery.title.japanese, readTags, { forceFirstStatRead: wasDescMarked });
        // If this manga was previously only desc-marked-read, it's now actually read
        // so remove it from the exclusion list so it appears in Related section
        removeDescMarkedReadId(chapter.sourceManga.mangaId);
        try {
            recordReadingSession(chapter.chapterId);
            recordPageCount(gallery.num_pages);
            const tagNames = gallery.tags
                .filter((t) => t.type === "tag" || t.type === "male" || t.type === "female")
                .map((t) => t.name);
            if (tagNames.length > 0)
                recordTagCounts(tagNames);
        }
        catch {
            /* stats tracking should never break chapter loading */
        }
        this.debouncedInvalidateSearchFilters();
        const details = {
            id: chapter.chapterId,
            mangaId: chapter.sourceManga.mangaId,
            pages,
        };
        return details;
    }
    getMangaShareUrl(mangaId) {
        return `${DOMAIN}/g/${mangaId}`;
    }
    checkCloudflareStatus(status) {
        if (status === 503 || status === 403) {
            throw new CloudflareError({ url: DOMAIN, method: "GET" });
        }
    }
    computeBackoffDelayMs(attempt, status, headers, endpointClass) {
        const isGalleryDetail = endpointClass === "galleryDetail";
        const retryAfterMs = parseRetryAfterMs(headers);
        if (retryAfterMs !== undefined) {
            const cap = status === 429 ? (isGalleryDetail ? 2_200 : 5_000) : 3_000;
            return Math.min(cap, Math.max(300, retryAfterMs));
        }
        const baseMs = status === 403 || status === 429 || status === 503 ? (isGalleryDetail ? 900 : 5_000) : 120;
        const expMs = baseMs * Math.pow(2, attempt);
        const jitterMs = Math.floor(Math.random() * (isGalleryDetail ? 250 : 120));
        const maxMs = status === 429 ? (isGalleryDetail ? 2_200 : 5_000) : 3_000;
        return Math.min(maxMs, expMs + jitterMs);
    }
    async fetchSearch(query, page, sort, options) {
        const normalizedQuery = this.normalizeQueryString(query);
        const cacheKey = `${sort}|${page}|${normalizedQuery}`;
        const cached = this.searchCache.get(cacheKey);
        if (!options?.forceRefresh &&
            cached &&
            Date.now() - cached.ts < this.getSearchCacheTtl(cacheKey)) {
            return this.cloneQueryResponse(cached.response);
        }
        const pending = this.searchPending.get(cacheKey);
        if (pending) {
            return pending.then((response) => this.cloneQueryResponse(response));
        }
        const request = {
            url: `${API_V2_URL}/search?query=${encodeURIComponent(normalizedQuery)}&page=${page}&sort=${encodeURIComponent(sort)}`,
            method: "GET",
        };
        const fetchPromise = this.fetchJson(request).then(async (response) => {
            // Populate tile store before converting so raw V2GalleryListItem data is available.
            for (const item of response.result ?? []) {
                this.storeTileFromListItem(item);
            }
            const hydrated = this.mapV2SearchResponseToQueryResponse(response);
            this.searchCache.set(cacheKey, {
                response: this.cloneQueryResponse(hydrated),
                ts: Date.now(),
            });
            this.saveSearchCache();
            this.saveTileStore();
            return hydrated;
        });
        this.searchPending.set(cacheKey, fetchPromise);
        return fetchPromise.finally(() => {
            this.searchPending.delete(cacheKey);
        });
    }
    mapV2SearchResponseToQueryResponse(response) {
        const list = response.result ?? [];
        return {
            result: list.map((item) => this.mapV2ListItemToGallery(item)),
            num_pages: response.num_pages,
            per_page: response.per_page,
            error: response.error,
        };
    }
    mapV2ListItemToGallery(item) {
        const tags = (item.tag_ids ?? []).map((id) => {
            let name = "";
            let type = "unknown";
            if (id === LANGUAGE_TAG_IDS.english) {
                name = "english";
                type = "language";
            }
            else if (id === LANGUAGE_TAG_IDS.chinese) {
                name = "chinese";
                type = "language";
            }
            else if (id === LANGUAGE_TAG_IDS.japanese) {
                name = "japanese";
                type = "language";
            }
            return { id, type, name, url: "", count: 0 };
        });
        // Search API has no pretty field — synthesize one from raw titles.
        const pretty = prettyTitleFromListItem(item);
        return {
            id: item.id,
            media_id: item.media_id,
            isLite: true,
            title: {
                ...(item.english_title ? { english: item.english_title } : {}),
                ...(item.japanese_title ? { japanese: item.japanese_title } : {}),
                pretty,
            },
            images: {
                pages: [],
                cover: {
                    path: item.thumbnail,
                    t: this.getImageTypeFromPath(item.thumbnail),
                },
                thumbnail: {
                    path: item.thumbnail,
                    t: this.getImageTypeFromPath(item.thumbnail),
                },
            },
            tags,
            num_pages: item.num_pages ?? 0,
            num_favorites: item.num_favorites ?? 0,
            upload_date: 0,
        };
    }
    async hydrateLiteGalleries(galleries, maxToHydrate = Number.POSITIVE_INFINITY, options) {
        if (galleries.length === 0) {
            return galleries;
        }
        // Check if hydration is needed based on display settings.
        // Hydration fetches full gallery data, but the search payload now carries
        // favorites, so only subtitle date options still require it.
        const displayOptions = getDisplayOptionsSetting();
        const needsHydration = displayOptions.includes("subtitle_date") || displayOptions.includes("subtitle_relative");
        if (!options?.force && !needsHydration) {
            // Skip hydration - search API provides enough data (num_pages) for basic subtitles
            return galleries;
        }
        const allowLiteFallback = getRateLimitLiteFallbackSetting();
        // If the lower 45/min gallery-detail budget is already consumed, switch to
        // lite tiles immediately when fallback mode is enabled.
        if (allowLiteFallback) {
            const windowStart = Date.now() - 60_000;
            const detailQueue = burstQueues.galleryDetail;
            detailQueue.timestamps = detailQueue.timestamps.filter((t) => t > windowStart);
            if (detailQueue.timestamps.length >= getEndpointRateLimit("galleryDetail")) {
                this.markGalleryDetailRateLimited();
            }
        }
        const result = [...galleries];
        const hydrateLimit = Number.isFinite(maxToHydrate)
            ? Math.max(0, Math.floor(maxToHydrate))
            : result.length;
        const liteIndexes = [];
        for (let i = 0; i < result.length && liteIndexes.length < hydrateLimit; i++) {
            if (result[i].isLite) {
                liteIndexes.push(i);
            }
        }
        if (liteIndexes.length === 0) {
            return result;
        }
        // While rate-limited, allow at most one probe request every 7 seconds.
        if (allowLiteFallback && this.galleryDetailRateLimited) {
            const now = Date.now();
            if (now < this.galleryDetailProbeAfter) {
                return result;
            }
            this.galleryDetailProbeAfter = this.getNextGalleryDetailProbeAt(now);
            const probeIndex = liteIndexes.shift();
            if (probeIndex === undefined) {
                return result;
            }
            try {
                const probeHydrated = await this.fetchGallery(result[probeIndex].id.toString(), {
                    priority: "background",
                    liteHydration: true,
                });
                if (probeHydrated) {
                    result[probeIndex] = probeHydrated;
                    this.clearGalleryDetailRateLimited();
                }
            }
            catch {
                this.markGalleryDetailRateLimited();
            }
            if (this.galleryDetailRateLimited) {
                return result;
            }
        }
        // Early return tracking for repeated 429 errors
        let consecutive429s = 0;
        const MAX_CONSECUTIVE_429S = 1; // Return earlier once the detail endpoint is clearly throttled
        const CONCURRENCY = 2;
        for (let i = 0; i < liteIndexes.length; i += CONCURRENCY) {
            // Pre-batch slot check: if the rate limit window is too full to accept
            // this batch without stalling, bail to lite fallback immediately instead
            // of blocking inside withRateLimit for up to 60s.
            if (allowLiteFallback) {
                const authenticated = getApiKeyAuthorizedSetting();
                const slots = availableSlotsNow("galleryDetail", !!authenticated, "background");
                if (slots < CONCURRENCY) {
                    console.log(`[NHentai] Hydration lite fallback: only ${slots} slots available (need ${CONCURRENCY}), returning ${result.filter((g) => !g.isLite).length} hydrated + ${result.filter((g) => g.isLite).length} lite galleries.`);
                    break;
                }
            }
            const batchIndexes = liteIndexes.slice(i, i + CONCURRENCY);
            const hydratedBatch = await Promise.all(batchIndexes.map(async (index) => {
                const gallery = result[index];
                try {
                    const hydrated = await this.fetchGallery(gallery.id.toString(), {
                        priority: "background",
                        liteHydration: true,
                    });
                    if (hydrated) {
                        consecutive429s = 0; // Reset on success
                    }
                    return hydrated;
                }
                catch (e) {
                    const msg = getErrorMessage(e);
                    if (msg.includes("429")) {
                        consecutive429s++;
                        if (allowLiteFallback) {
                            this.markGalleryDetailRateLimited();
                        }
                    }
                    return null;
                }
            }));
            for (let j = 0; j < hydratedBatch.length; j++) {
                const hydrated = hydratedBatch[j];
                if (hydrated) {
                    result[batchIndexes[j]] = hydrated;
                }
            }
            // When repeated 429s happen, either fall back immediately (fast mode)
            // or pause/retry (full subtitle mode).
            if (consecutive429s >= MAX_CONSECUTIVE_429S) {
                console.log(`[NHentai] Hydration throttled: ${consecutive429s} consecutive 429 errors. ` +
                    `Returning ${result.filter((g) => !g.isLite).length} hydrated + ${result.filter((g) => g.isLite).length} lite galleries.`);
                if (allowLiteFallback) {
                    break;
                }
                await this.pause(200);
                consecutive429s = 0;
            }
            if (allowLiteFallback && this.galleryDetailRateLimited) {
                break;
            }
        }
        return result;
    }
    /**
     * Fetch search results with OR expansion. When include tags contain OR groups
     * (e.g. "yuri OR anal"), fetches each alternative independently, unions within
     * each OR group, then intersects across groups. This reduces M^N requests
     * (cartesian product) to N*M requests (linear per group).
     *
     * Fetches one page per alternative — the outer loop handles pagination.
     */
    async fetchSearchWithOrExpansion(baseQuery, page, sort, additionalOrGroups = [], options) {
        const settingsOrGroups = getIncludeOrGroups();
        const orGroups = [...settingsOrGroups, ...additionalOrGroups]
            .map((group) => this.dedupeQueryTokens(group))
            .filter((group) => group.length > 1);
        if (orGroups.length === 0) {
            return this.fetchSearch(baseQuery, page, sort, options);
        }
        // For a single OR group, use simple union (no intersection needed)
        if (orGroups.length === 1) {
            return this.fetchOrGroupUnion(baseQuery, orGroups[0], page, sort, options);
        }
        // Multiple OR groups: fetch each group independently, then intersect.
        // (A|B) AND (C|D) → G1 = union(base+A, base+B), G2 = union(base+C, base+D)
        // Result = G1 ∩ G2 (sorted by upload_date or interleaved by popularity)
        const allGalleries = new Map();
        let maxPages = page;
        let perPage = 25;
        const groupResponses = await Promise.all(orGroups.map((group) => this.fetchOrGroupUnion(baseQuery, group, page, sort, options)));
        const groupResults = groupResponses.map((response) => {
            maxPages = Math.max(maxPages, response.num_pages);
            perPage = response.per_page;
            const ids = new Set();
            for (const gallery of response.result ?? []) {
                ids.add(gallery.id);
                allGalleries.set(gallery.id, gallery);
            }
            return ids;
        });
        // Intersect across all OR groups
        if (groupResults.length === 0) {
            return { result: [], num_pages: 0, per_page: perPage };
        }
        let intersection = groupResults[0];
        for (let i = 1; i < groupResults.length; i++) {
            const next = new Set();
            for (const id of intersection) {
                if (groupResults[i].has(id))
                    next.add(id);
            }
            intersection = next;
        }
        const merged = [...intersection].map((id) => allGalleries.get(id)).filter(Boolean);
        if (sort === "date") {
            merged.sort((a, b) => b.upload_date - a.upload_date);
        }
        return { result: merged, num_pages: maxPages, per_page: perPage };
    }
    /**
     * Prefetch next search page in background when user approaches pagination boundary.
     * Stores media IDs from prefetched page to speed up next-page transitions.
     * Only runs once per session per next page; skips if already in progress.
     */
    triggerSearchPrefetch(baseQuery, prefetchPage, sort, additionalOrGroups = [], sessionKey) {
        // Skip if already prefetching this page or different session
        if (this.prefetchInProgress || this.lastPrefetchSessionKey !== sessionKey) {
            this.lastPrefetchSessionKey = sessionKey;
            return;
        }
        if (this.prefetchedPageMediaIds.length > 0) {
            // Already have prefetched page, don't fetch again
            return;
        }
        this.prefetchInProgress = true;
        this.lastPrefetchSessionKey = sessionKey;
        // Fire in background without awaiting
        this.fetchSearchWithOrExpansion(baseQuery, prefetchPage, sort, additionalOrGroups)
            .then((response) => {
            if (response?.result && Array.isArray(response.result)) {
                this.prefetchedPageMediaIds = response.result.map((g) => g.id);
                logDebug("search:prefetch", `page=${prefetchPage}`, `mediaIds=${this.prefetchedPageMediaIds.length}`);
            }
        })
            .catch((error) => {
            logDebug("search:prefetch", `page=${prefetchPage}`, `error=${getErrorMessage(error)}`);
        })
            .finally(() => {
            this.prefetchInProgress = false;
        });
    }
    /**
     * Prefetch next discover page in background.
     * Simpler than search prefetch since discover doesn't use OR groups.
     */
    triggerDiscoverPrefetch(baseQuery, prefetchPage, sort) {
        // Skip if already prefetching
        if (this.prefetchInProgress || this.prefetchedPageMediaIds.length > 0) {
            return;
        }
        this.prefetchInProgress = true;
        // Fire in background without awaiting
        this.fetchSearch(baseQuery, prefetchPage, sort)
            .then((response) => {
            if (response?.result && Array.isArray(response.result)) {
                this.prefetchedPageMediaIds = response.result.map((g) => g.id);
                logDebug("discover:prefetch", `page=${prefetchPage}`, `mediaIds=${this.prefetchedPageMediaIds.length}`);
            }
        })
            .catch((error) => {
            logDebug("discover:prefetch", `page=${prefetchPage}`, `error=${getErrorMessage(error)}`);
        })
            .finally(() => {
            this.prefetchInProgress = false;
        });
    }
    /**
     * Fetch all alternatives in a single OR group and union results.
     * Runs in batches of 3 for faster OR expansion while keeping requests bounded.
     */
    async fetchOrGroupUnion(baseQuery, alternatives, page, sort, options) {
        logDebug(`[NHentai OR] Fetching OR group union: ${alternatives.length} alternatives`);
        const BATCH_SIZE = 3;
        const results = [];
        for (let i = 0; i < alternatives.length; i += BATCH_SIZE) {
            const batch = alternatives.slice(i, i + BATCH_SIZE);
            const batchResults = await Promise.all(batch.map(async (alt) => {
                const q = this.normalizeQueryString([baseQuery, alt].filter((s) => s.length > 0 && s !== EMPTY_QUERY).join(" "));
                try {
                    const result = await this.fetchSearch(q, page, sort, options);
                    logDebug(`[NHentai OR] alt="${alt}" query="${q}" -> ${result.result?.length ?? 0} results`);
                    return result;
                }
                catch (e) {
                    logDebug(`[NHentai OR] alt="${alt}" fetch FAILED:`, e);
                    return null;
                }
            }));
            results.push(...batchResults);
        }
        const perAlternativeResults = [];
        let maxPages = 0;
        let perPage = 25;
        for (const response of results) {
            if (!response?.result)
                continue;
            maxPages = Math.max(maxPages, response.num_pages);
            perPage = response.per_page;
            perAlternativeResults.push([...response.result]);
        }
        const merged = interleaveGalleryLists(perAlternativeResults);
        logDebug(`[NHentai OR] Union complete: ${merged.length} unique results from ${results.filter((r) => r?.result).length}/${results.length} successful fetches`);
        return { result: merged, num_pages: maxPages, per_page: perPage };
    }
    async fetchGallery(mangaId, options) {
        // Return recently completed result to deduplicate sequential calls
        // (e.g. getMangaDetails → getChapters both fetching the same gallery)
        const recent = this.galleryRecentCache.get(mangaId);
        if (recent && Date.now() < recent.expiresAt) {
            return recent.gallery;
        }
        // Check if there's already a pending request for this gallery
        const pending = this.galleryPending.get(mangaId);
        if (pending) {
            return pending;
        }
        const request = {
            url: `${API_V2_URL}/galleries/${mangaId}`,
            method: "GET",
        };
        const fetchPromise = this.fetchJson(request, {
            priority: options?.priority ?? "foreground",
        })
            .then((detail) => this.mapV2GalleryDetailToGallery(detail))
            .then((gallery) => {
            this.storeTileFromGallery(gallery);
            this.saveTileStore();
            this.galleryRecentCache.set(mangaId, { gallery, expiresAt: Date.now() + 30_000 });
            return gallery;
        })
            .finally(() => {
            this.galleryPending.delete(mangaId);
        });
        this.galleryPending.set(mangaId, fetchPromise);
        return fetchPromise;
    }
    mapV2GalleryDetailToGallery(detail) {
        const toImage = (path) => ({
            path,
            t: this.getImageTypeFromPath(path),
        });
        const pages = (detail.pages ?? []).map((page) => ({
            path: page.path,
            thumbnail: page.thumbnail,
            t: this.getImageTypeFromPath(page.path),
        }));
        const uploadDate = typeof detail.upload_date === "number" && detail.upload_date > 2_000_000_000_000
            ? Math.floor(detail.upload_date / 1000)
            : detail.upload_date;
        return {
            id: detail.id,
            media_id: detail.media_id,
            isLite: false,
            title: {
                ...(detail.title?.english ? { english: detail.title.english } : {}),
                ...(detail.title?.japanese ? { japanese: detail.title.japanese } : {}),
                pretty: detail.title?.pretty ??
                    detail.title?.english ??
                    detail.title?.japanese ??
                    `Gallery ${detail.id}`,
            },
            images: {
                pages,
                cover: toImage(detail.cover?.path),
                thumbnail: toImage(detail.thumbnail?.path),
            },
            tags: detail.tags ?? [],
            num_pages: typeof detail.num_pages === "number" ? detail.num_pages : pages.length,
            num_favorites: typeof detail.num_favorites === "number" ? detail.num_favorites : 0,
            upload_date: typeof uploadDate === "number" ? uploadDate : 0,
        };
    }
    getImageTypeFromPath(path) {
        if (!path)
            return "j";
        const slash = path.lastIndexOf("/");
        const dot = path.lastIndexOf(".");
        if (dot === -1 || dot < slash)
            return "j";
        const ext = path.slice(dot + 1).toLowerCase();
        switch (ext) {
            case "jpg":
            case "jpeg":
                return "j";
            case "png":
                return "p";
            case "gif":
                return "g";
            case "webp":
                return "w";
            default:
                return "j";
        }
    }
    async fetchText(request) {
        const [response, data] = await Application.scheduleRequest(request);
        return {
            response,
            text: Application.arrayBufferToUTF8String(data),
        };
    }
    async pause(ms) {
        if (ms <= 0)
            return;
        // Application.sleep uses seconds and yields the runtime while waiting.
        await Application.sleep(ms / 1000);
    }
    async fetchJson(request, options) {
        const preparedRequest = withNhentaiApiAuth(request);
        const actualEndpointClass = classifyEndpoint(preparedRequest.url);
        const endpointClass = options?.rateLimitEndpoint ?? actualEndpointClass;
        const authenticated = hasAuthorizationHeader(preparedRequest);
        if (!authenticated && getApiKeyAuthorizedSetting()) {
            console.warn(`[NHentai] Set API key is unauthenticated`);
        }
        let effectiveRequest = preparedRequest;
        // Use withRateLimit to serialize requests and enforce spacing
        return withRateLimit(endpointClass, async () => {
            const maxAttempts = 2;
            let lastError;
            for (let attempt = 0; attempt < maxAttempts; attempt++) {
                try {
                    const { response, text } = await this.fetchText(effectiveRequest);
                    const trimmed = text.trim();
                    const status = response.status;
                    const isHtml = trimmed.startsWith("<");
                    const isRateLimited = status === 429 || status === 403 || status === 503;
                    const isRetryableServerError = status >= 500;
                    if (isRateLimited || isRetryableServerError || isHtml) {
                        if (actualEndpointClass === "galleryDetail" && status === 429) {
                            this.markGalleryDetailRateLimited();
                        }
                        if (status === 429) {
                            const retryAfterMs = parseRetryAfterMs(response.headers);
                            const queue = burstQueues[endpointClass];
                            const cooldown = Math.min(retryAfterMs ?? 60_000, 60_000);
                            queue.rateLimitedUntil = Math.max(queue.rateLimitedUntil, Date.now() + Math.max(1000, cooldown));
                        }
                        if (attempt < maxAttempts - 1) {
                            // On 429, use backoff delay
                            const waitMs = this.computeBackoffDelayMs(attempt, status, response.headers, endpointClass);
                            console.log(`[NHentai] HTTP ${status} for ${effectiveRequest.url} (attempt ${attempt + 1}/${maxAttempts}), waiting ${waitMs}ms before retry`);
                            await this.pause(waitMs);
                            continue;
                        }
                        if (status === 403 || status === 503) {
                            this.checkCloudflareStatus(status);
                        }
                        throw new Error(`[NHentai] HTTP ${status} for ${effectiveRequest.url} after ${maxAttempts} attempts`);
                    }
                    if (status < 200 || status >= 300) {
                        throw new Error(`[NHentai] HTTP ${status} for ${effectiveRequest.url}`);
                    }
                    if (actualEndpointClass === "galleryDetail") {
                        this.clearGalleryDetailRateLimited();
                    }
                    const parsed = JSON.parse(text);
                    if (parsed && typeof parsed === "object" && "error" in parsed && parsed.error) {
                        throw new Error(parsed.error);
                    }
                    return parsed;
                }
                catch (error) {
                    // CloudflareError must bubble up immediately so the framework
                    // can present the Cloudflare challenge to the user.
                    if (error instanceof CloudflareError)
                        throw error;
                    if (actualEndpointClass === "galleryDetail" && getErrorMessage(error).includes("429")) {
                        this.markGalleryDetailRateLimited();
                    }
                    lastError = error;
                    if (attempt < maxAttempts - 1) {
                        await this.pause((attempt + 1) * 75);
                        continue;
                    }
                }
            }
            throw lastError instanceof Error
                ? lastError
                : new Error(`[NHentai] Failed to fetch JSON from ${effectiveRequest.url}`);
        }, { authenticated, priority: options?.priority ?? "foreground" });
    }
    async refreshCdnConfig() {
        try {
            const response = await this.fetchJson({
                url: `${API_V2_URL}/config`,
                method: "GET",
            }, { priority: "foreground" }).catch(() => this.fetchJson({
                url: `${API_V2_URL}/cdn`,
                method: "GET",
            }, { priority: "foreground" }));
            const imageServers = (response.image_servers ?? [])
                .map((server) => server?.trim())
                .filter((server) => !!server);
            const thumbServers = (response.thumb_servers ?? [])
                .map((server) => server?.trim())
                .filter((server) => !!server);
            if (imageServers.length > 0) {
                this.cdnImageServers = imageServers;
            }
            if (thumbServers.length > 0) {
                this.cdnThumbServers = thumbServers;
            }
            this.cdnConfigTs = Date.now();
            try {
                if (this.cdnImageServers) {
                    Application.setState(this.cdnImageServers, CDN_IMAGE_SERVERS_STATE_KEY);
                }
                if (this.cdnThumbServers) {
                    Application.setState(this.cdnThumbServers, CDN_THUMB_SERVERS_STATE_KEY);
                }
                Application.setState(this.cdnConfigTs, CDN_TS_STATE_KEY);
            }
            catch {
                // Ignore state persistence failures.
            }
        }
        catch (error) {
            logDebug("Failed to refresh CDN config", error);
        }
    }
    async getPopularTags() {
        if (this.popularTagsCache &&
            this.popularTagsCacheTs &&
            Date.now() - this.popularTagsCacheTs < POPULAR_TAGS_CACHE_TTL_MS) {
            return this.popularTagsCache;
        }
        // Try restoring from persisted state (survives app restart)
        if (!this.popularTagsCache) {
            try {
                const persisted = Application.getState(POPULAR_TAGS_STATE_KEY);
                const persistedTs = Application.getState(POPULAR_TAGS_TS_STATE_KEY);
                if (Array.isArray(persisted) &&
                    persisted.length > 0 &&
                    typeof persistedTs === "number" &&
                    Date.now() - persistedTs < POPULAR_TAGS_CACHE_TTL_MS) {
                    this.popularTagsCache = persisted;
                    this.popularTagsCacheTs = persistedTs;
                    return persisted;
                }
            }
            catch {
                /* ignore */
            }
        }
        if (!this.popularTagsFetch) {
            this.popularTagsFetch = this.fetchPopularTagsFromRemote()
                .then((tags) => {
                const sorted = tags.slice().sort((a, b) => {
                    const diff = this.parseTagCountValue(b.count) - this.parseTagCountValue(a.count);
                    if (diff !== 0)
                        return diff;
                    return a.label.localeCompare(b.label);
                });
                if (sorted.length > 0) {
                    this.popularTagsCache = sorted;
                    this.popularTagsCacheTs = Date.now();
                    // Persist to state so cache survives app restart
                    try {
                        Application.setState(sorted, POPULAR_TAGS_STATE_KEY);
                        Application.setState(this.popularTagsCacheTs, POPULAR_TAGS_TS_STATE_KEY);
                    }
                    catch {
                        /* ignore */
                    }
                }
                return sorted;
            })
                .catch((error) => {
                console.error("Failed to fetch NHentai popular tags", error);
                return [];
            })
                .finally(() => {
                this.popularTagsFetch = undefined;
            });
        }
        return this.popularTagsFetch;
    }
    async fetchPopularTagsFromRemote() {
        const fetchedTagsAndCount = [];
        const seen = new Set();
        let maxPages = 5;
        for (let page = 1; page <= maxPages && page <= 5; page++) {
            try {
                const response = await this.fetchJson({
                    url: `${API_V2_URL}/tags/tag?sort=popular&page=${page}&per_page=100`,
                    method: "GET",
                });
                if (typeof response.num_pages === "number" && response.num_pages > 0) {
                    maxPages = response.num_pages;
                }
                for (const entry of response.result ?? []) {
                    const slug = entry.slug?.toLowerCase();
                    if (!slug || seen.has(slug))
                        continue;
                    const countValue = typeof entry.count === "number" && Number.isFinite(entry.count) ? entry.count : 0;
                    const countLabel = this.formatTagCount(countValue);
                    fetchedTagsAndCount.push({
                        id: slug,
                        label: `${entry.name} - (${countLabel})`,
                        count: countLabel,
                    });
                    seen.add(slug);
                }
            }
            catch (error) {
                // Keep the pages that already loaded instead of discarding them all
                console.error("Unable to load NHentai popular tags", error);
                break;
            }
        }
        return fetchedTagsAndCount;
    }
    formatTagCount(count) {
        if (count >= 1_000_000) {
            const value = count / 1_000_000;
            return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10}M`;
        }
        if (count >= 1_000) {
            const value = count / 1_000;
            return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10}K`;
        }
        return count.toString();
    }
    parseTagCountValue(count) {
        const normalized = count.trim().toLowerCase().replace(/,/g, "");
        const match = normalized.match(/^(\d+(?:\.\d+)?)([km])?$/);
        if (!match)
            return parseFloat(normalized) || 0;
        const value = parseFloat(match[1]) || 0;
        const suffix = match[2];
        if (suffix === "m")
            return value * 1_000_000;
        if (suffix === "k")
            return value * 1_000;
        return value;
    }
    buildQueryString(title, filterTokens = [], options) {
        const tokens = [...filterTokens];
        if (title && title.length > 0) {
            tokens.push(title);
        }
        if (!options?.skipDefaultLanguage) {
            // Single preferred language → language:X
            // Multiple preferred languages → -language:Y for the non-selected one(s)
            tokens.push(...getLanguageQueryTokens());
        }
        const extraArguments = getExtraArgumentsSetting().trim();
        if (extraArguments.length > 0) {
            tokens.push(extraArguments);
        }
        return this.normalizeQueryString(tokens.join(" "));
    }
    buildFilterTokens(filters) {
        const tokens = [];
        let favoritesConstraint;
        let pagesConstraint = parsePagesExpression(getPagesExpressionSetting());
        let dateConstraint;
        const lengthToken = this.getDropdownValue(filters, "length");
        const favoritesToken = this.getDropdownValue(filters, "favorites");
        const dateToken = this.getDropdownValue(filters, "daysOld");
        // Pages (search dropdown overrides settings, including explicit "all")
        const lengthOptionToken = this.getOptionToken(lengthToken, LENGTH_FILTER_OPTIONS);
        if (lengthToken !== undefined && lengthToken !== "all") {
            pagesConstraint = {};
            if (lengthOptionToken) {
                const match = lengthOptionToken.match(/^(>=|<=|>|<)?(\d+)$/);
                if (match) {
                    const op = match[1];
                    const val = Number(match[2]);
                    if (!Number.isNaN(val)) {
                        if (op === ">")
                            pagesConstraint.min = val + 1;
                        else if (op === ">=")
                            pagesConstraint.min = val;
                        else if (op === "<")
                            pagesConstraint.max = val - 1;
                        else if (op === "<=")
                            pagesConstraint.max = val;
                        else
                            pagesConstraint = { exact: val, min: val, max: val };
                    }
                }
            }
        }
        // Favorites (search dropdown overrides settings; if dropdown is "all" fall back to settings)
        const favoritesOptionToken = this.getOptionToken(favoritesToken, FAVORITES_FILTER_OPTIONS);
        if (favoritesToken !== undefined && favoritesToken !== "all") {
            favoritesConstraint = undefined;
        }
        if (favoritesOptionToken) {
            const favoritesMatch = favoritesOptionToken.match(/^(>=|<=|>|<)?(\d+)$/);
            if (favoritesMatch) {
                const operator = favoritesMatch[1];
                const value = Number(favoritesMatch[2]);
                if (!Number.isNaN(value)) {
                    if (operator === ">=" || operator === ">") {
                        favoritesConstraint = {
                            ...favoritesConstraint,
                            min: value,
                        };
                    }
                    else if (operator === "<=" || operator === "<") {
                        favoritesConstraint = {
                            ...favoritesConstraint,
                            max: value,
                        };
                    }
                    if (operator !== "<=" && operator !== "<") {
                        tokens.push(`favorites:${favoritesOptionToken}`);
                    }
                }
            }
        }
        else if (favoritesToken === undefined || favoritesToken === "all") {
            const favoritesThreshold = getFavoritesThresholdSetting();
            const favoritesThresholdMax = getFavoritesThresholdMaxSetting();
            if (favoritesThreshold !== undefined || favoritesThresholdMax !== undefined) {
                favoritesConstraint = {
                    min: favoritesThreshold,
                    max: favoritesThresholdMax,
                };
                if (favoritesThreshold !== undefined) {
                    tokens.push(`favorites:>=${favoritesThreshold}`);
                }
                // Keep max filtering client-side; API-side upper bounds are inconsistent.
            }
        }
        // Date filters (search dropdown overrides settings)
        // NHentai API: uploaded:<Xd = newer than X days, uploaded:>Xd = older than X days
        const hasDateFilter = filters?.some((f) => f.id === "daysOld");
        if (dateToken && dateToken !== "all") {
            const preset = DATE_FILTER_PRESETS.find((p) => p.id === dateToken);
            if (preset?.days !== undefined) {
                dateConstraint = { newerThanDays: preset.days };
                tokens.push(`uploaded:<${preset.days}d`);
            }
        }
        else if (!hasDateFilter || dateToken === "all") {
            const daysRange = getDaysOldFilterSetting();
            let newest = typeof daysRange.newest === "number" ? daysRange.newest : undefined;
            let oldest = typeof daysRange.oldest === "number" ? daysRange.oldest : undefined;
            if (newest !== undefined && oldest !== undefined && newest < oldest) {
                [newest, oldest] = [oldest, newest];
            }
            if (typeof newest === "number") {
                dateConstraint = {
                    ...dateConstraint,
                    newerThanDays: newest,
                };
                // uploaded:<Xd means "newer than X days"
                tokens.push(`uploaded:<${newest}d`);
            }
            if (typeof oldest === "number") {
                dateConstraint = {
                    ...dateConstraint,
                    olderThanDays: oldest,
                };
                // uploaded:>Xd means "older than X days"
                tokens.push(`uploaded:>${oldest}d`);
            }
        }
        // Pages tokens (add after date so tokens order stays predictable)
        if (pagesConstraint.exact !== undefined) {
            tokens.push(`pages:=${pagesConstraint.exact}`);
        }
        else {
            if (pagesConstraint.min !== undefined)
                tokens.push(`pages:>=${pagesConstraint.min}`);
            if (pagesConstraint.max !== undefined)
                tokens.push(`pages:<=${pagesConstraint.max}`);
        }
        return { tokens, favoritesConstraint, pagesConstraint, dateConstraint };
    }
    getDropdownValue(filters, id) {
        if (!filters)
            return undefined;
        const filter = filters.find((entry) => entry.id === id);
        return typeof filter?.value === "string" ? filter.value : undefined;
    }
    mapGalleryToDiscoverItem(gallery) {
        const subtitle = this.createTileSubtitle(gallery).trim();
        const imageUrl = normalizeBridgeString(this.buildCoverUrl(gallery));
        return {
            type: "simpleCarouselItem",
            mangaId: normalizeBridgeString(gallery.id, "0"),
            imageUrl,
            title: normalizeBridgeString(gallery.title?.pretty || gallery.title?.english || gallery.title?.japanese, `Gallery ${gallery.id}`),
            subtitle: subtitle.length > 0 ? subtitle : undefined,
            contentRating: ContentRating.ADULT,
        };
    }
    mapGalleryToSearchResult(gallery) {
        const subtitle = this.createTileSubtitle(gallery).trim();
        const imageUrl = normalizeBridgeString(this.buildCoverUrl(gallery));
        return {
            mangaId: normalizeBridgeString(gallery.id, "0"),
            imageUrl,
            title: normalizeBridgeString(gallery.title?.pretty || gallery.title?.english || gallery.title?.japanese, `Gallery ${gallery.id}`),
            subtitle: subtitle.length > 0 ? subtitle : undefined,
            contentRating: ContentRating.ADULT,
        };
    }
    createTileSubtitle(gallery, options) {
        return this.createSubtitle(gallery, {
            rereadCount: options?.rereadCount ?? getRereadCount(gallery.id.toString()),
            isTopReread: options?.isTopReread,
        });
    }
    discoverItemsToSearchResults(items) {
        return items
            .filter((item) => item.type === "simpleCarouselItem")
            .map(({ mangaId, title, subtitle, imageUrl, metadata, contentRating }) => ({
            mangaId: normalizeBridgeString(mangaId),
            title: normalizeBridgeString(title, "Gallery"),
            subtitle: subtitle === undefined ? undefined : normalizeBridgeString(subtitle, ""),
            imageUrl: normalizeBridgeString(imageUrl),
            metadata,
            contentRating,
        }));
    }
    pickMediaServer(servers, mediaId, fallbackPrefix) {
        const numericId = parseInt(mediaId, 10);
        const fallback = `https://${fallbackPrefix}${((Number.isFinite(numericId) ? numericId : 0) % 4) + 1}.nhentai.net`;
        if (!servers || servers.length === 0)
            return fallback;
        const index = (Number.isFinite(numericId) ? numericId : 0) % servers.length;
        const server = servers[index]?.trim();
        return server && server.length > 0 ? server.replace(/\/+$/, "") : fallback;
    }
    buildAbsoluteMediaUrl(relativePath, mediaId, kind) {
        const normalizedPath = relativePath.replace(/^\/+/, "");
        const host = kind === "image"
            ? this.pickMediaServer(this.cdnImageServers, mediaId, "i")
            : this.pickMediaServer(this.cdnThumbServers, mediaId, "t");
        return `${host}/${normalizedPath}`;
    }
    buildCoverUrl(gallery) {
        const quality = getThumbnailQualitySetting();
        const mediaId = gallery.media_id;
        logDebug("Building cover URL for gallery:", gallery.id, "media_id:", mediaId, "quality:", quality);
        if (quality === "high") {
            const firstPage = gallery.images.pages[0];
            if (firstPage?.path) {
                const url = this.buildAbsoluteMediaUrl(firstPage.path, mediaId, "image");
                logDebug("High quality URL (page 1):", url);
                return url;
            }
            // Lite gallery: derive page 1 extension from thumbnail path from thumb.ExtensionType.
            // Thumbnails may be re-encoded as webp (e.g. "thumb.jpg.webp"), so strip
            // the .webp suffix first to expose the underlying source extension.
            if (gallery.images.thumbnail.path) {
                let thumbPath = gallery.images.thumbnail.path;
                if (thumbPath.endsWith(".webp")) {
                    thumbPath = thumbPath.slice(0, -5);
                }
                const lastDot = thumbPath.lastIndexOf(".");
                const thumbExt = lastDot !== -1 ? thumbPath.slice(lastDot + 1) : "webp";
                const page1Path = `galleries/${mediaId}/1.${thumbExt}`;
                const url = this.buildAbsoluteMediaUrl(page1Path, mediaId, "image");
                logDebug("High quality lite URL (page 1 from thumb ext):", url);
                return url;
            }
        }
        // Low: thumb.webp (smallest thumbnail)
        // Example: //t4.nhentai.net/galleries/3746773/thumb.webp
        if (quality === "low") {
            if (gallery.images.thumbnail.path) {
                const url = this.buildAbsoluteMediaUrl(gallery.images.thumbnail.path, mediaId, "thumb");
                logDebug("Low quality (thumb path) URL:", url);
                return url;
            }
        }
        // Normal (default): cover.webp (medium quality cover)
        // Example: //t1.nhentai.net/galleries/3746773/cover.webp
        if (gallery.images.cover.path) {
            const url = this.buildAbsoluteMediaUrl(gallery.images.cover.path, mediaId, "thumb");
            logDebug("Normal quality (cover path) URL:", url);
            return url;
        }
        return `${DOMAIN}/favicon.ico`;
    }
    buildPageUrl(gallery, index, image) {
        if (image.path) {
            const url = this.buildAbsoluteMediaUrl(image.path, gallery.media_id, "image");
            logDebug("Page URL for index", index, ":", url, "from path");
            return url;
        }
        throw new Error(`[NHentai] Missing API-provided page path for gallery ${gallery.id} page ${index}`);
    }
    createSynopsis(gallery) {
        const displayOptions = getDisplayOptionsSetting();
        const excludedTags = new Set();
        const dateFmt = getDateFormatSetting();
        const uploadDate = new Date(gallery.upload_date * 1000);
        const pageCount = Number.isFinite(Number(gallery.num_pages))
            ? Math.max(0, Math.floor(Number(gallery.num_pages)))
            : 0;
        const favoriteCount = Number.isFinite(Number(gallery.num_favorites))
            ? Math.max(0, Math.floor(Number(gallery.num_favorites)))
            : 0;
        const rereadCount = getRereadCount(gallery.id.toString());
        const showReread = rereadCount > 1;
        const languageSlug = this.extractLanguageSlug(gallery.tags);
        const languageAbbrev = getLanguageAbbreviationFromSlug(languageSlug);
        const parts = [];
        if (displayOptions.includes("show_lang_desc")) {
            parts.push(languageAbbrev);
        }
        const isRead = isMangaRead(gallery.id.toString());
        const showReadLetter = displayOptions.includes("hide_read_letter");
        const readPrefix = isRead && showReadLetter ? "r" : "";
        if (displayOptions.length === 0 || displayOptions.includes("show_page_count")) {
            parts.push(showReread ? `${rereadCount}r${pageCount}p` : `${readPrefix}${pageCount}p`);
        }
        if (favoriteCount > 0) {
            let favs = favoriteCount.toString();
            if (favoriteCount >= 1_000_000) {
                favs = `${Math.round(favoriteCount / 1_000_000)}M`;
            }
            else if (favoriteCount >= 1000) {
                favs = `${Math.round(favoriteCount / 1000)}k`;
            }
            parts.push(favs);
        }
        const uploadHours = uploadDate.getHours();
        const uploadMins = uploadDate.getMinutes();
        const uploadMinsStr = uploadMins.toString().padStart(2, "0");
        const useMilitaryTime = NHentaiSettings.getMilitaryTimeSetting();
        const uploadTimeStr = useMilitaryTime
            ? `${uploadHours.toString().padStart(2, "0")}:${uploadMinsStr}`
            : `${((uploadHours + 11) % 12) + 1}:${uploadMinsStr}${uploadHours >= 12 ? "PM" : "AM"}`;
        let dateAbsolute = "";
        if (displayOptions.includes("desc_show_date")) {
            dateAbsolute = `${formatDateByPattern(uploadDate, dateFmt)} @ ${uploadTimeStr}`;
        }
        const dateRelative = displayOptions.includes("desc_relative_date")
            ? this.relativeTime(uploadDate)
            : "";
        if (dateRelative)
            parts.push(dateRelative);
        if (dateAbsolute)
            parts.push(dateAbsolute);
        if (displayOptions.includes("show_id")) {
            parts.push(gallery.id.toString());
        }
        const removeSpaces = getRemoveSeparatorSpacesSetting();
        const separator = removeSpaces ? "|" : " | ";
        const infoLine = parts.join(separator);
        const topTags = this.getTopTags(gallery);
        const tagsLine = topTags.length > 0 ? topTags.join(", ") : "";
        for (const tag of topTags)
            excludedTags.add(tag);
        const parodies = gallery.tags
            .filter((t) => t.type === "parody")
            .map((t) => t.name.replace(/_/g, " ").trim())
            .filter((name) => name.length > 0);
        const characters = gallery.tags
            .filter((t) => t.type === "character")
            .map((t) => t.name.replace(/_/g, " ").trim())
            .filter((name) => name.length > 0);
        const extraLines = [];
        if (displayOptions.includes("parodies_bottom")) {
            const nonOriginalParodies = parodies.filter((p) => p.toLowerCase() !== "original");
            if (nonOriginalParodies.length > 0) {
                extraLines.push(`Parodies: ${parodies.join(", ")}`);
            }
            if (characters.length > 0) {
                extraLines.push(`Characters: ${characters.join(", ")}`);
            }
            for (const parody of parodies)
                excludedTags.add(parody.toLowerCase());
            for (const character of characters) {
                excludedTags.add(character.toLowerCase());
            }
        }
        let synopsis = infoLine;
        if (tagsLine)
            synopsis += `\n${tagsLine}`;
        if (extraLines.length > 0)
            synopsis += `\n${extraLines.join("\n")}`;
        return { synopsis, excludedTags };
    }
    createSubtitle(gallery, options) {
        const isRead = isMangaRead(gallery.id.toString());
        const displayOptions = getDisplayOptionsSetting();
        const showReadLetter = displayOptions.includes("hide_read_letter");
        const readPrefix = isRead && showReadLetter ? "r" : "";
        const pageCount = Number.isFinite(Number(gallery.num_pages))
            ? Math.max(0, Math.floor(Number(gallery.num_pages)))
            : 0;
        const favoriteCount = Number.isFinite(Number(gallery.num_favorites))
            ? Math.max(0, Math.floor(Number(gallery.num_favorites)))
            : 0;
        const languageSlug = this.extractLanguageSlug(gallery.tags);
        const showRereadEverywhere = displayOptions.includes("show_reread_count");
        const rereadCount = options?.rereadCount;
        const showReread = rereadCount !== undefined &&
            rereadCount > 1 &&
            (options?.isTopReread || showRereadEverywhere);
        const safeRereadCount = showReread ? rereadCount : 0;
        const showPageCount = displayOptions.includes("show_page_count");
        const showFavoriteCount = displayOptions.includes("show_favorite_count");
        // Format as "7r55p" when reread count is shown alongside pages.
        const hasPageCount = pageCount > 0;
        const pagesStr = hasPageCount
            ? showReread && showPageCount
                ? `${safeRereadCount}r${pageCount}p`
                : showReread
                    ? `${safeRereadCount}r`
                    : showPageCount
                        ? `${readPrefix}${pageCount}p`
                        : ""
            : "";
        let favStr = "";
        if (showFavoriteCount && favoriteCount > 0) {
            if (displayOptions.includes("abbreviate_favorites") && favoriteCount >= 1000) {
                favStr =
                    favoriteCount >= 1_000_000
                        ? `${Math.round(favoriteCount / 1_000_000)}M`
                        : `${Math.round(favoriteCount / 1000)}k`;
            }
            else {
                favStr = favoriteCount.toString();
            }
        }
        const hasUploadDate = gallery.upload_date > 0;
        const uploadDate = new Date(gallery.upload_date * 1000);
        const dateFormatSetting = getDateFormatSetting();
        const showRelative = displayOptions.includes("subtitle_relative");
        const showAbsolute = displayOptions.includes("subtitle_date");
        let relativeStr = "";
        if (showRelative && hasUploadDate) {
            relativeStr = this.relativeTime(uploadDate);
        }
        let absoluteStr = "";
        if (showAbsolute && hasUploadDate) {
            absoluteStr = formatDateByPattern(uploadDate, dateFormatSetting);
        }
        const showLangTip = displayOptions.includes("show_lang_tip");
        const subtitleParts = [];
        if (showLangTip && languageSlug) {
            const languageAbbrev = getLanguageAbbreviationFromSlug(languageSlug);
            if (languageAbbrev && languageAbbrev !== "UNK") {
                subtitleParts.push(languageAbbrev.toUpperCase());
            }
        }
        if (pagesStr)
            subtitleParts.push(pagesStr);
        if (favStr)
            subtitleParts.push(favStr);
        // Ensure relative date appears before absolute date in subtitle
        if (showRelative && relativeStr)
            subtitleParts.push(relativeStr);
        if (showAbsolute && absoluteStr)
            subtitleParts.push(absoluteStr);
        // Keep subtitles visible for lightweight search/discover payloads
        // which may not include page/favorite/date details.
        if (subtitleParts.length === 0 && showPageCount && pageCount > 0) {
            subtitleParts.push(`${readPrefix}${pageCount}p`);
        }
        if (subtitleParts.length === 0) {
            if (readPrefix) {
                subtitleParts.push(readPrefix);
            }
            else if (gallery.isLite) {
                return "";
            }
            if (!readPrefix && showPageCount) {
                subtitleParts.push("0p");
            }
            else if (!readPrefix) {
                return "";
            }
        }
        // Get remove spaces setting
        const removeSpaces = getRemoveSeparatorSpacesSetting();
        const separator = removeSpaces ? "|" : " | ";
        return subtitleParts.join(separator);
    }
    extractLanguageSlug(tags) {
        const available = this.getNonTranslatedLanguageSlugs(tags);
        if (available.length === 0) {
            // Lite tiles occasionally lose language tags (e.g. after a detail fetch
            // overwrites a search/related list tile and wipes tag_ids). When that
            // happens, infer the language from the user's preferred-language setting
            // so the "show language in subtitle" display option keeps working.
            //
            // Search/discover results are already constrained to the preferred
            // languages by the query tokens (see getLanguageQueryTokens), so the
            // gallery must be one of the preferred languages. Use the preference
            // order (which already falls back to "english") — for a single preferred
            // language this is exact; for multiple, it is the user's top priority.
            const preferenceOrder = this.getLanguagePreferenceOrder();
            const preferred = preferenceOrder.filter((slug) => slug !== "english" || preferenceOrder.length === 1);
            // preferenceOrder always appends "english" as a last resort; only use it
            // as the inferred slug when english is actually a preferred language or
            // it is the only fallback left.
            if (preferred.length > 0) {
                return preferred[0];
            }
            return preferenceOrder[0];
        }
        const preferenceOrder = this.getLanguagePreferenceOrder();
        for (const slug of preferenceOrder) {
            if (available.includes(slug)) {
                return slug;
            }
        }
        return available[0];
    }
    getNonPreferredLanguageSlugs(tags) {
        const preferredSlug = this.extractLanguageSlug(tags);
        const available = this.getNonTranslatedLanguageSlugs(tags);
        if (!preferredSlug) {
            return available;
        }
        return available.filter((slug) => slug !== preferredSlug);
    }
    extractLanguageSlugsFromTagIds(tagIds) {
        const slugs = [];
        if (tagIds.includes(LANGUAGE_TAG_IDS.english))
            slugs.push("english");
        if (tagIds.includes(LANGUAGE_TAG_IDS.chinese))
            slugs.push("chinese");
        if (tagIds.includes(LANGUAGE_TAG_IDS.japanese))
            slugs.push("japanese");
        return slugs;
    }
    extractPreferredLanguageFromTagIds(tagIds) {
        const available = this.extractLanguageSlugsFromTagIds(tagIds);
        if (available.length === 0)
            return undefined;
        const preferenceOrder = this.getLanguagePreferenceOrder();
        for (const slug of preferenceOrder) {
            if (available.includes(slug))
                return slug;
        }
        return available[0];
    }
    getNonTranslatedLanguageSlugs(tags) {
        const seen = new Set();
        const slugs = [];
        for (const tag of tags) {
            if (tag.type !== "language") {
                continue;
            }
            const slug = tag.name?.toLowerCase().trim();
            if (!slug || slug === "translated" || seen.has(slug)) {
                continue;
            }
            seen.add(slug);
            slugs.push(slug);
        }
        return slugs;
    }
    getLanguagePreferenceOrder() {
        const fromSettings = getLanguageSetting()
            .map((value) => value.toLowerCase().trim())
            .filter((value) => value.length > 0 && value !== "all");
        const order = fromSettings.length > 0 ? [...fromSettings] : ["english"];
        if (!order.includes("english")) {
            order.push("english");
        }
        return order;
    }
    buildTagTokens(tags, excluded) {
        if (!tags || tags.length === 0)
            return [];
        const tokens = [];
        for (const t of tags) {
            const raw = (t.id ?? t.title ?? "").toString().trim();
            if (!raw || /\|\||\s+OR\s+/i.test(raw))
                continue;
            if (raw.includes(":")) {
                const parts = raw.split(":");
                const type = parts[0];
                const name = parts.slice(1).join(":").replace(/-/g, " ");
                if (!name || /\|\||\s+OR\s+/i.test(name))
                    continue;
                const needsQuotes = /\s|[^a-z0-9_-]/i.test(name);
                tokens.push(`${excluded ? "-" : ""}${type}:${needsQuotes ? `"${name}"` : name}`);
            }
            else {
                const normalized = raw.replace(/-/g, " ");
                if (!normalized || /\|\||\s+OR\s+/i.test(normalized))
                    continue;
                const needsQuotes = /\s|[^a-z0-9_-]/i.test(normalized);
                tokens.push(`${excluded ? "-" : ""}tag:${needsQuotes ? `"${normalized}"` : normalized}`);
            }
        }
        return tokens;
    }
    splitQueryTerms(segment) {
        const matches = segment.match(/-?[a-z]+:"[^"]+"|-?[a-z]+:[^\s"]+|"[^"]+"|\S+/gi);
        return matches?.map((token) => token.trim()).filter(Boolean) ?? [];
    }
    categorizeQueryToken(token) {
        const lower = token.toLowerCase();
        if (lower.startsWith("pages:") ||
            lower.startsWith("favorites:") ||
            lower.startsWith("uploaded:")) {
            return "constraint";
        }
        if (lower.startsWith("language:") || lower.startsWith("-language:")) {
            return "language";
        }
        return "content";
    }
    canonicalizeQueryToken(token) {
        return token
            .replace(/\s+OR\s+/gi, " OR ")
            .replace(/\s+/g, " ")
            .replace(/:\s+/g, ":")
            .replace(/"/g, "")
            .trim()
            .toLowerCase();
    }
    dedupeQueryTokens(tokens) {
        const seen = new Set();
        const deduped = [];
        for (const token of tokens) {
            const trimmed = token.trim();
            if (!trimmed)
                continue;
            const canonical = this.canonicalizeQueryToken(trimmed);
            if (seen.has(canonical))
                continue;
            seen.add(canonical);
            deduped.push(trimmed);
        }
        return deduped;
    }
    normalizeQueryString(query) {
        const buckets = {
            constraint: [],
            content: [],
            language: [],
        };
        for (const token of this.splitQueryTerms(query)) {
            const bucket = this.categorizeQueryToken(token);
            buckets[bucket].push(token);
        }
        const normalized = this.dedupeQueryTokens([
            ...buckets.constraint,
            ...buckets.content,
            ...buckets.language,
        ]).join(" ");
        return normalized.length > 0 ? normalized : EMPTY_QUERY;
    }
    cloneQueryResponse(response) {
        return {
            ...response,
            result: response.result?.slice(),
        };
    }
    extractTagSlug(tag) {
        if (tag.url) {
            const segments = tag.url.split("/").filter((segment) => segment.length > 0);
            if (segments.length > 0) {
                const lastSegment = segments[segments.length - 1];
                return lastSegment.split("?")[0];
            }
        }
        if (tag.name) {
            return tag.name.toLowerCase().replace(/\s+/g, "_");
        }
        return undefined;
    }
    buildTagIdentifier(tag) {
        const slug = this.extractTagSlug(tag) ?? tag.id.toString();
        const type = tag.type || "tag";
        return `${type}:${slug}`;
    }
    getTopTags(gallery) {
        if (!getAddTagsToDescriptionSetting()) {
            return [];
        }
        const sorted = [...gallery.tags].sort((a, b) => b.count - a.count);
        const tags = sorted.filter((t) => t.type === "tag");
        // Tag distribution: scroller capped at 5 until description reaches 15
        //   ≤4:  all in description, 0 scroller
        //   5:   1 in scroller
        //   6-8: scroller = total-5 (1,2,3)
        //   9-20: scroller = min(5, floor(total*0.4))
        //   >20: scroller = total-15 (description capped at 15)
        const totalTags = tags.length;
        let scrollerCount;
        if (totalTags <= 4) {
            scrollerCount = 0;
        }
        else if (totalTags === 5) {
            scrollerCount = 1;
        }
        else if (totalTags <= 8) {
            scrollerCount = totalTags - 5;
        }
        else if (totalTags <= 20) {
            scrollerCount = Math.min(5, Math.floor(totalTags * 0.4));
        }
        else {
            scrollerCount = totalTags - 15;
        }
        let limit = totalTags - scrollerCount;
        // If any would-be scroller tag has a long name (>14 chars), cap scroller at 4
        if (scrollerCount > 4) {
            const scrollerTags = tags.slice(limit);
            if (scrollerTags.some((t) => t.name.replace(/_/g, " ").length > 14)) {
                scrollerCount = 4;
                limit = totalTags - scrollerCount;
            }
        }
        // Hard cap: description never receives more than 15 tags regardless of formula
        if (limit > 15)
            limit = 15;
        return tags.slice(0, limit).map((t) => t.name.toLowerCase());
    }
    createTagSections(gallery, excludedTags) {
        const sections = [];
        const grouped = new Map();
        const tagCountsById = new Map();
        const nonPreferredLanguageTags = this.getNonPreferredLanguageSlugs(gallery.tags).map((slug) => ({
            id: `language:${slug}`,
            title: getLanguageAbbreviationFromSlug(slug).toUpperCase(),
        }));
        for (const tag of gallery.tags) {
            // Languages are handled separately; artists/groups already appear on
            // mangaInfo.author via getCreatorFieldsFromTags, so omit them from the scroller.
            if (tag.type === "language" || tag.type === "artist" || tag.type === "group") {
                continue;
            }
            // Skip tags that were promoted to the description
            const normalizedTagName = tag.name.toLowerCase().replace(/_/g, " ").trim();
            if (excludedTags && excludedTags.has(normalizedTagName)) {
                continue;
            }
            const sectionId = this.resolveSectionId(tag.type);
            const sectionTitle = this.resolveSectionTitle(tag.type);
            const existing = grouped.get(sectionId);
            const tagEntry = {
                id: this.buildTagIdentifier(tag),
                title: this.formatTagTitle(tag.name),
            };
            tagCountsById.set(tagEntry.id, tag.count ?? 0);
            if (existing) {
                existing.tags.push(tagEntry);
            }
            else {
                grouped.set(sectionId, {
                    id: sectionId,
                    title: sectionTitle,
                    tags: [tagEntry],
                });
            }
        }
        for (const section of grouped.values()) {
            section.tags.sort((a, b) => {
                const countDiff = (tagCountsById.get(b.id) ?? 0) - (tagCountsById.get(a.id) ?? 0);
                if (countDiff !== 0)
                    return countDiff;
                return a.title.localeCompare(b.title);
            });
        }
        if (nonPreferredLanguageTags.length > 0) {
            const tagsSection = grouped.get("tags");
            if (tagsSection) {
                tagsSection.tags = [...nonPreferredLanguageTags, ...tagsSection.tags];
            }
            else {
                grouped.set("tags", {
                    id: "tags",
                    title: "Tags",
                    tags: [...nonPreferredLanguageTags],
                });
            }
        }
        // Order sections: Tags first, then others (categories/doujinshi last), ID at end
        const tagsSection = grouped.get("tags");
        if (tagsSection && tagsSection.tags.length > 0) {
            sections.push(tagsSection);
        }
        // Add other sections except tags and categories
        for (const [key, section] of grouped) {
            if (key !== "tags" && key !== "categories" && section.tags.length > 0) {
                sections.push(section);
            }
        }
        // Categories (doujinshi, manga, etc.) always at the end of tag sections
        const categoriesSection = grouped.get("categories");
        if (categoriesSection && categoriesSection.tags.length > 0) {
            sections.push(categoriesSection);
        }
        const displayOptions = getDisplayOptionsSetting();
        if (!displayOptions.includes("desc_show_date")) {
            const uploadDate = new Date(gallery.upload_date * 1000);
            const hours = uploadDate.getHours();
            const mins = uploadDate.getMinutes().toString().padStart(2, "0");
            const period = hours >= 12 ? "PM" : "AM";
            const formattedTime = NHentaiSettings.getMilitaryTimeSetting()
                ? `${hours.toString().padStart(2, "0")}:${mins}`
                : `${((hours + 11) % 12) + 1}:${mins}${period}`;
            const formattedDate = formatDateByPattern(uploadDate, getDateFormatSetting());
            sections.push({
                id: "upload_date",
                title: "Date",
                tags: [
                    {
                        id: `date_${gallery.id}`,
                        title: `${formattedDate} @ ${formattedTime}`,
                    },
                ],
            });
        }
        // When "Show ID in Description" is OFF, add gallery ID to the scroller
        if (!displayOptions.includes("show_id")) {
            sections.push({
                id: "gallery_id",
                title: "ID",
                tags: [{ id: `id_${gallery.id}`, title: gallery.id.toString() }],
            });
        }
        const artistSections = sections.filter((section) => section.id === "artists" || section.id === "groups");
        if (artistSections.length > 0) {
            const withoutArtists = sections.filter((section) => section.id !== "artists" && section.id !== "groups");
            const idIndex = withoutArtists.findIndex((section) => section.id === "gallery_id");
            if (idIndex >= 0) {
                withoutArtists.splice(idIndex, 0, ...artistSections);
            }
            else {
                withoutArtists.push(...artistSections);
            }
            return withoutArtists;
        }
        return sections;
    }
    resolveSectionId(tagType) {
        switch (tagType) {
            case "tag":
                return "tags";
            case "artist":
                return "artists";
            case "parody":
                return "parodies";
            case "character":
                return "characters";
            case "group":
                return "groups";
            case "category":
                return "categories";
            case "series":
                return "series";
            case "magazine":
                return "magazines";
            default:
                return tagType;
        }
    }
    resolveSectionTitle(tagType) {
        switch (tagType) {
            case "tag":
                return "Tags";
            case "artist":
                return "Artists";
            case "parody":
                return "Parodies";
            case "character":
                return "Characters";
            case "group":
                return "Groups";
            case "category":
                return "Categories";
            case "series":
                return "Series";
            case "magazine":
                return "Magazines";
            default:
                return tagType.charAt(0).toUpperCase() + tagType.slice(1);
        }
    }
    formatTagTitle(name) {
        return name.replace(/_/g, " ");
    }
    relativeTime(date) {
        const now = new Date();
        const diffMs = Math.max(0, now.getTime() - date.getTime());
        const sec = Math.floor(diffMs / 1000);
        const min = Math.floor(sec / 60);
        const hr = Math.floor(min / 60);
        const day = Math.floor(diffMs / (1000 * 60 * 60 * 24));
        const years = day / 365;
        // Format as years if over 999 days or 1+ year
        if (day > 999 || years >= 1)
            return `${years.toFixed(1)}y`;
        if (day > 0)
            return `${day}d`;
        if (hr > 0)
            return `${hr}h`;
        if (min > 0)
            return `${min}m`;
        return `${sec}s`;
    }
    resolveSortOrder(_query, sortingOption) {
        if (sortingOption?.id) {
            return sortingOption.id;
        }
        const queryFilters = []; // Compat API removed
        const sortFilter = queryFilters.find((filter) => filter.id === "sort");
        if (sortFilter && typeof sortFilter.value === "string") {
            const match = SORT_OPTIONS.find((option) => option.id === sortFilter.value);
            if (match) {
                return match.id;
            }
        }
        return getDefaultSearchSortSetting();
    }
    formatSearchSortLabel(sortBy) {
        return SORT_OPTIONS.find((option) => option.id === sortBy)?.label ?? sortBy;
    }
    getChapterLanguageCode(gallery) {
        const languageSlug = this.extractLanguageSlug(gallery.tags);
        switch (languageSlug) {
            case "japanese":
                return "jp";
            case "chinese":
                return "cn";
            case "english":
                return "en";
            default:
                return "unk";
        }
    }
    getOptionToken(value, options) {
        if (!value || value === "all") {
            return undefined;
        }
        const match = options.find((option) => option.id === value);
        if (!match) {
            return undefined;
        }
        return match.token ?? match.id;
    }
}
function getReadCache() {
    if (!readHistory) {
        let stored = Application.getState(READ_STATE_KEY);
        // If no stored read history exists under the current key, try migrating from
        // previously-used keys so users don't lose their read state when keys change.
        if (!stored || stored.length === 0) {
            const legacyKeys = [
                "nhentai.viewedHistory",
                "nhentai.viewHistory",
                "nhentai.readCache",
                "nhentai.read",
                "nhentai.read_history",
            ];
            for (const key of legacyKeys) {
                const legacy = Application.getState(key);
                if (legacy && legacy.length > 0) {
                    // Migrate the legacy data to the current key (idempotent)
                    Application.setState(legacy, READ_STATE_KEY);
                    // Optionally mark which key we migrated from for debugging
                    Application.setState(true, `${READ_STATE_KEY}.migratedFrom.${key}`);
                    stored = legacy;
                    break;
                }
            }
        }
        readHistory = new ReadHistory(stored ?? []);
    }
    return readHistory;
}
function persistReadCache() {
    // Persist the ordered history, not the set
    if (readHistory) {
        Application.setState(readHistory.toArray(), READ_STATE_KEY);
    }
}
function recordDisplayedTiles(items) {
    for (const item of items) {
        try {
            const candidate = item && typeof item === "object"
                ? item
                : undefined;
            const id = candidate?.mangaId ?? candidate?.id ?? candidate?.galleryId;
            if (typeof id === "string" || typeof id === "number") {
                incrementDisplayedManga(id);
            }
        }
        catch {
            /* non-critical stats */
        }
    }
}
function isMangaRead(mangaId) {
    return getReadCache().has(mangaId);
}
function markMangaAsRead(mangaId, title, tags, options) {
    // Don't mark as read if incognito/pause mode is enabled
    if (getIncognitoModeSetting()) {
        return { isFirstRead: false };
    }
    const history = getReadCache();
    const wasRead = history.has(mangaId);
    const isFirstRead = history.markRead(mangaId);
    if (isFirstRead || wasRead) {
        persistReadCache();
        // Only invalidate the related pool when genuinely new history is added.
        // Re-reads (wasRead && !isFirstRead) update the recency order inside the
        // existing history but don't add a new entry, so the pool position stays
        // stable and pagination offsets remain valid.
        if (isFirstRead) {
            try {
                globalThis.__nhentaiInvalidateRelatedPool?.();
            }
            catch {
                /* ignore */
            }
        }
        // Notify framework that filters/search results may need updating so
        // description and lists that rely on read-state refresh promptly.
        try {
            // Application.invalidateSearchFilters() - API removed
        }
        catch {
            /* ignore */
        }
    }
    const shouldTrackStats = options?.trackStats ?? true;
    // Stats can be disabled independently from read-history.
    if (shouldTrackStats && getStatsTrackingEnabledSetting()) {
        const statsFirstRead = options?.forceFirstStatRead ? true : isFirstRead;
        recordMangaReadCount(mangaId, title, statsFirstRead, tags);
    }
    return { isFirstRead };
}
export const NHentai = new NHentaiExtension();
