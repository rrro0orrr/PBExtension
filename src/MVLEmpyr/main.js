import { BasicRateLimiter, ContentRating, CookieStorageInterceptor, DiscoverSectionType, } from "@paperback/types";
import * as cheerio from "cheerio";
import { MVLEmpyrInterceptor } from "./interceptors";
import { MVLEmpyrSearchForm } from "./SearchForm";
// Site layout (approach credited to PoppingMango's MVLEMPYR extension):
// - www.mvlempyr.io serves the pages (home sections, chapter text)
// - chap.heliosarchive.online is a WordPress API with the novel catalogue
//   (custom 'mvl-novels' type) and every chapter as a post
// - assets.mvlempyr.app hosts covers by novel code
const DOMAIN = "https://www.mvlempyr.io";
const API = "https://chap.heliosarchive.online/wp-json/wp/v2";
const ASSETS = "https://assets.mvlempyr.app";
const PAGE_SIZE = 20;
const CATALOGUE_PAGE_SIZE = 1000;
const CHAPTER_PAGE_SIZE = 500;
const LATEST_PAGE_SIZE = 30;
const CATALOGUE_TTL_MS = 60 * 60 * 1000;
const HOME_TTL_MS = 10 * 60 * 1000;
// Chapter posts are tagged with 7^code mod 1999999997 (from the site's JS)
const TAG_MODULUS = 1_999_999_997;
const ADULT_GENRES = ["adult", "smut"];
const MATURE_GENRES = ["mature", "ecchi"];
// Paperback rejects ids with characters outside this set
const UNSAFE_ID_CHARS = /[^a-zA-Z0-9._\-@()[\]%?#+=/&:]/g;
const GENRES = [
    "Action",
    "Adult",
    "Adventure",
    "Comedy",
    "Drama",
    "Ecchi",
    "Fan-Fiction",
    "Fantasy",
    "Gender Bender",
    "Harem",
    "Historical",
    "Horror",
    "Josei",
    "Martial Arts",
    "Mature",
    "Mecha",
    "Mystery",
    "Psychological",
    "Romance",
    "School Life",
    "Sci-fi",
    "Seinen",
    "Shoujo",
    "Shoujo Ai",
    "Shounen",
    "Shounen Ai",
    "Slice of Life",
    "Smut",
    "Sports",
    "Supernatural",
    "Tragedy",
    "Wuxia",
    "Xianxia",
    "Xuanhuan",
    "Yaoi",
    "Yuri",
].map((title) => ({ id: slugify(title), title }));
const SORT_OPTIONS = [
    { id: "rank", label: "Popular" },
    { id: "weekly", label: "Trending This Week" },
    { id: "rating", label: "Top Rated" },
    { id: "reviews", label: "Most Reviewed" },
    { id: "new", label: "Newest" },
    { id: "chapters", label: "Most Chapters" },
    { id: "az", label: "Title (A-Z)" },
];
// Home page sections, by their <section> class
const HOME_SECTIONS = {
    popular: { title: "Popular", cls: "popular-section", type: DiscoverSectionType.featured },
    trending: {
        title: "Trending",
        cls: "trending-section",
        type: DiscoverSectionType.prominentCarousel,
    },
    recommended: {
        title: "Recommended",
        cls: "recommended-section",
        type: DiscoverSectionType.simpleCarousel,
    },
    new_arrivals: {
        title: "New Arrivals",
        cls: "new-arrivals-section",
        type: DiscoverSectionType.simpleCarousel,
    },
    completed: {
        title: "Completed",
        cls: "completed-section",
        type: DiscoverSectionType.simpleCarousel,
    },
    romance: { title: "Romance", cls: "romance-section", type: DiscoverSectionType.simpleCarousel },
    // Every title here is marked Adult so the app's content filter can hide it
    r18: {
        title: "R18",
        cls: "r18-section",
        type: DiscoverSectionType.simpleCarousel,
        adult: true,
    },
};
export class MVLEmpyrExtension {
    cookieStorageInterceptor = new CookieStorageInterceptor({
        storage: "stateManager",
    });
    requestManager = new MVLEmpyrInterceptor("main");
    globalRateLimiter = new BasicRateLimiter("rateLimiter", {
        numberOfRequests: 4,
        bufferInterval: 1,
        ignoreImages: true,
    });
    catalogue;
    catalogueLoad;
    home;
    async initialise() {
        this.cookieStorageInterceptor.registerInterceptor();
        this.requestManager.registerInterceptor();
        this.globalRateLimiter.registerInterceptor();
    }
    // ----- Discover -----
    async getDiscoverSections() {
        const home = Object.entries(HOME_SECTIONS).map(([id, s]) => ({
            id,
            title: s.title,
            type: s.type,
        }));
        return [
            home[0],
            { id: "updates", title: "Latest Updates", type: DiscoverSectionType.chapterUpdates },
            ...home.slice(1),
            { id: "genres", title: "Genres", type: DiscoverSectionType.genres },
        ];
    }
    async getDiscoverSectionItems(section, metadata) {
        if (section.id === "updates")
            return this.getLatestUpdates(metadata);
        if (section.id === "genres") {
            return {
                items: GENRES.map((genre) => ({
                    type: "genresCarouselItem",
                    name: genre.title,
                    searchQuery: {
                        title: "",
                        metadata: { searchMeta: { genres: { [genre.id]: "included" } } },
                    },
                    contentRating: contentRatingFor([genre.title]),
                })),
            };
        }
        const def = HOME_SECTIONS[section.id];
        if (!def)
            return { items: [] };
        const cards = parseHomeSection(await this.getHome(), def.cls);
        return {
            items: cards.map((card) => {
                switch (def.type) {
                    case DiscoverSectionType.featured:
                        return {
                            type: "featuredCarouselItem",
                            mangaId: card.slug,
                            imageUrl: card.cover,
                            title: card.title,
                        };
                    case DiscoverSectionType.prominentCarousel:
                        return {
                            type: "prominentCarouselItem",
                            mangaId: card.slug,
                            imageUrl: card.cover,
                            title: card.title,
                        };
                    default:
                        return {
                            type: "simpleCarouselItem",
                            mangaId: card.slug,
                            imageUrl: card.cover,
                            title: card.title,
                            ...(def.adult ? { contentRating: ContentRating.ADULT } : {}),
                        };
                }
            }),
        };
    }
    // Newest chapter posts site-wide; each title is shown once
    async getLatestUpdates(metadata) {
        const page = metadata?.page ?? 1;
        const seen = new Set(metadata?.seen ?? []);
        const [{ posts, totalPages }, catalogue] = await Promise.all([
            this.fetchPosts(`per_page=${LATEST_PAGE_SIZE}&page=${page}`),
            this.getCatalogue(),
        ]);
        const byCode = new Map(catalogue.map((novel) => [novel.code, novel]));
        const items = [];
        for (const post of posts) {
            const code = toNumber(post.acf?.novel_code);
            const number = toNumber(post.acf?.chapter_number);
            const novel = code !== undefined ? byCode.get(code) : undefined;
            if (!novel || number === undefined || seen.has(novel.slug))
                continue;
            seen.add(novel.slug);
            const date = post.date ? new Date(post.date) : undefined;
            items.push({
                type: "chapterUpdatesCarouselItem",
                mangaId: novel.slug,
                chapterId: `${novel.code}-${number}`,
                imageUrl: coverUrl(novel.code, 300),
                title: novel.name,
                subtitle: `Ch. ${number}`,
                ...(date && !Number.isNaN(date.getTime()) ? { publishDate: date } : {}),
                contentRating: contentRatingFor(novel.genres),
            });
        }
        return {
            items,
            metadata: page < totalPages && page < 10 ? { page: page + 1, seen: [...seen] } : undefined,
        };
    }
    // ----- Search -----
    async getSortingOptions(_query) {
        return SORT_OPTIONS;
    }
    async getAdvancedSearchForm(query) {
        return new MVLEmpyrSearchForm(GENRES, searchMetaOf(query));
    }
    // The API has no server-side search; the website downloads the whole
    // catalogue and filters it in the browser. Same here, cached for an hour.
    async getSearchResults(query, metadata, sortingOption) {
        const page = metadata?.page ?? 1;
        const meta = searchMetaOf(query);
        const terms = normalize(query.title ?? "")
            .split(" ")
            .filter(Boolean);
        const authorTerms = normalize(meta.author ?? "")
            .split(" ")
            .filter(Boolean);
        const included = genresIn(meta.genres, "included");
        const excluded = genresIn(meta.genres, "excluded");
        const matches = (await this.getCatalogue()).filter((novel) => {
            const genres = novel.genres.map(slugify);
            if (included.length) {
                const ok = meta.genreMatch === "or"
                    ? included.some((g) => genres.includes(g))
                    : included.every((g) => genres.includes(g));
                if (!ok)
                    return false;
            }
            if (excluded.some((g) => genres.includes(g)))
                return false;
            if (meta.status && !novel.status.toLowerCase().includes(meta.status))
                return false;
            if (authorTerms.length) {
                const author = normalize(novel.author);
                if (!authorTerms.every((t) => author.includes(t)))
                    return false;
            }
            if (terms.length) {
                const haystack = normalize(`${novel.name} ${novel.altNames} ${novel.author}`);
                if (!terms.every((t) => haystack.includes(t)))
                    return false;
            }
            return true;
        });
        // With a title and no explicit sort, put exact/prefix title matches first
        const sort = sortingOption?.id ?? (terms.length ? "relevance" : "rank");
        const sorted = sortNovels(matches, sort, normalize(query.title ?? ""));
        const slice = sorted.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
        return {
            items: slice.map((novel) => ({
                mangaId: novel.slug,
                imageUrl: coverUrl(novel.code, 300),
                title: novel.name,
                subtitle: [
                    novel.chapters ? `Ch. ${novel.chapters}` : undefined,
                    novel.rating ? `★ ${novel.rating.toFixed(1)}` : undefined,
                ]
                    .filter(Boolean)
                    .join(" · "),
                contentRating: contentRatingFor(novel.genres),
            })),
            metadata: page * PAGE_SIZE < sorted.length ? { page: page + 1 } : undefined,
        };
    }
    // ----- Manga -----
    async getMangaDetails(mangaId) {
        const record = await this.fetchNovelRecord(mangaId);
        const code = toNumber(record["novel-code"]);
        const genres = (record.genre ?? []).map(clean).filter(Boolean);
        const tags = (record.tags ?? []).map(clean).filter(Boolean);
        const rating = toNumber(record["average-review"]) ?? 0;
        const altNames = clean(record["associated-names"])
            .split(/\s*[,;|]\s*/)
            .filter(Boolean);
        const tagGroups = [];
        if (genres.length) {
            tagGroups.push({
                id: "genres",
                title: "Genres",
                tags: genres.map((g) => ({ id: encodeId(slugify(g)), title: g })),
            });
        }
        if (tags.length) {
            tagGroups.push({
                id: "tags",
                title: "Tags",
                tags: tags.map((t) => ({ id: encodeId(slugify(t)), title: t })),
            });
        }
        return {
            mangaId,
            mangaInfo: {
                primaryTitle: clean(record.name) || mangaId,
                secondaryTitles: altNames,
                thumbnailUrl: code !== undefined ? coverUrl(code, 600) : "",
                synopsis: decode(record["synopsis-text"] ?? "").trim(),
                ...(record["author-name"] ? { author: clean(record["author-name"]) } : {}),
                // The site rates out of 5; Paperback expects 0-1
                ...(rating > 0 ? { rating: Math.min(1, rating / 5) } : {}),
                status: mapStatus(record.status),
                contentRating: contentRatingFor(genres),
                contentType: "novel",
                tagGroups,
                shareUrl: `${DOMAIN}/novel/${mangaId}`,
            },
        };
    }
    async getChapters(sourceManga) {
        const record = await this.fetchNovelRecord(sourceManga.mangaId);
        const code = toNumber(record["novel-code"]);
        if (code === undefined)
            throw new Error(`MVLEMPYR: no novel code for ${sourceManga.mangaId}`);
        const tag = chapterTagId(code);
        const posts = [];
        const first = await this.fetchPosts(`tags=${tag}&per_page=${CHAPTER_PAGE_SIZE}&page=1`);
        posts.push(...first.posts);
        // Fetch the remaining pages in parallel
        const rest = await Promise.all(Array.from({ length: Math.max(0, first.totalPages - 1) }, (_, i) => this.fetchPosts(`tags=${tag}&per_page=${CHAPTER_PAGE_SIZE}&page=${i + 2}`)));
        for (const page of rest)
            posts.push(...page.posts);
        const chapters = [];
        const seen = new Set();
        for (const post of posts) {
            const number = toNumber(post.acf?.chapter_number);
            if (number === undefined || toNumber(post.acf?.novel_code) !== code)
                continue;
            const chapterId = `${code}-${number}`;
            if (seen.has(chapterId))
                continue;
            seen.add(chapterId);
            const date = post.date ? new Date(post.date) : undefined;
            chapters.push({
                chapterId,
                sourceManga,
                title: clean(post.acf?.ch_name) || `Chapter ${number}`,
                chapNum: number,
                langCode: "en",
                ...(date && !Number.isNaN(date.getTime()) ? { publishDate: date } : {}),
            });
        }
        return chapters.sort((a, b) => b.chapNum - a.chapNum);
    }
    async getChapterDetails(chapter) {
        const $ = await this.fetchHtml(`${DOMAIN}/chapter/${chapter.chapterId}`);
        const container = $("#chapter").first();
        const root = container.find("span").first().length ? container.find("span").first() : container;
        root.find("script, style, iframe, noscript, ins, button, svg").remove();
        root.find("*").each((_, el) => {
            for (const name of Object.keys(el.attribs ?? {})) {
                if (name !== "src" && name !== "alt")
                    $(el).removeAttr(name);
            }
        });
        if (!root.text().trim()) {
            throw new Error(`MVLEMPYR: no text found for chapter ${chapter.chapterId}`);
        }
        // Serialize as XML so void tags are self-closed for the XHTML reader
        const body = cheerio.load(root.html() ?? "", null, false).html({ xml: true });
        const heading = chapter.title ? `<h2>${escapeXml(chapter.title)}</h2>` : "";
        return {
            id: chapter.chapterId,
            mangaId: chapter.sourceManga.mangaId,
            type: "html",
            html: `<html xmlns="http://www.w3.org/1999/xhtml"><head></head><body>${heading}${body}</body></html>`,
        };
    }
    // ----- Cloudflare -----
    async saveCloudflareBypassCookies(cookies) {
        for (const cookie of this.cookieStorageInterceptor.cookies) {
            this.cookieStorageInterceptor.deleteCookie(cookie);
        }
        for (const cookie of cookies) {
            if (cookie.expires && cookie.expires.getTime() <= Date.now())
                continue;
            this.cookieStorageInterceptor.setCookie(cookie);
        }
    }
    // ----- Data -----
    async getHome() {
        if (this.home && Date.now() - this.home.fetchedAt < HOME_TTL_MS)
            return this.home.$;
        const $ = await this.fetchHtml(`${DOMAIN}/`);
        this.home = { $, fetchedAt: Date.now() };
        return $;
    }
    // The catalogue endpoint filters by slug, so one novel is a single small request
    async fetchNovelRecord(slug) {
        const list = await this.fetchJson(`${API}/mvl-novels?per_page=1&slug=${encodeURIComponent(slug)}`);
        const record = list.find((r) => r.slug === slug);
        if (!record)
            throw new Error(`MVLEMPYR: novel not found (${slug})`);
        return record;
    }
    getCatalogue() {
        if (this.catalogue && Date.now() - this.catalogue.fetchedAt < CATALOGUE_TTL_MS) {
            return Promise.resolve(this.catalogue.novels);
        }
        this.catalogueLoad ??= this.loadCatalogue().finally(() => {
            this.catalogueLoad = undefined;
        });
        return this.catalogueLoad;
    }
    async loadCatalogue() {
        const novels = [];
        for (let page = 1; page <= 50; page++) {
            const records = await this.fetchJson(`${API}/mvl-novels?per_page=${CATALOGUE_PAGE_SIZE}&page=${page}`);
            // Trim each record right away: the full payload includes synopses
            for (const record of records) {
                const novel = toNovel(record);
                if (novel)
                    novels.push(novel);
            }
            if (records.length < CATALOGUE_PAGE_SIZE)
                break;
        }
        if (!novels.length)
            throw new Error("MVLEMPYR: could not load the novel catalogue");
        this.catalogue = { novels, fetchedAt: Date.now() };
        return novels;
    }
    async fetchPosts(query) {
        const url = `${API}/posts?${query}&_fields=date,acf`;
        const [response, data] = await Application.scheduleRequest({ url, method: "GET" });
        checkStatus(response.status, url);
        const posts = parseJson(data, url);
        const totalHeader = Object.entries(response.headers ?? {}).find(([key]) => key.toLowerCase() === "x-wp-totalpages")?.[1];
        return { posts, totalPages: Number.parseInt(totalHeader ?? "1", 10) || 1 };
    }
    async fetchJson(url) {
        const [response, data] = await Application.scheduleRequest({ url, method: "GET" });
        checkStatus(response.status, url);
        return parseJson(data, url);
    }
    async fetchHtml(url) {
        const [response, data] = await Application.scheduleRequest({ url, method: "GET" });
        checkStatus(response.status, url);
        return cheerio.load(Application.arrayBufferToUTF8String(data));
    }
}
// ----- Parsing -----
function parseHomeSection($, sectionClass) {
    const cards = [];
    const seen = new Set();
    $(`section.${sectionClass} [role=listitem]`).each((_, el) => {
        const item = $(el);
        const link = item.find('a[href*="/novel/"]').first();
        const slug = link.attr("href")?.match(/\/novel\/([^/?#]+)/)?.[1] ?? "";
        if (!slug || seen.has(slug))
            return;
        const img = item.find("img").first();
        const title = clean(item.find(".namex115, .namex175, .selectname, .vertical-list-novel-name").first().text() ||
            img.attr("alt") ||
            link.attr("title"));
        if (!title)
            return;
        seen.add(slug);
        cards.push({ slug, title, cover: img.attr("src") ?? "" });
    });
    return cards;
}
function toNovel(record) {
    const slug = (record.slug ?? "").trim();
    const code = toNumber(record["novel-code"]);
    const name = clean(record.name);
    if (!slug || code === undefined || !name)
        return undefined;
    const created = record.createdOn ? Date.parse(record.createdOn) : NaN;
    return {
        slug,
        code,
        name,
        author: clean(record["author-name"]),
        altNames: clean(record["associated-names"]),
        genres: (record.genre ?? []).map(clean).filter(Boolean),
        status: clean(record.status),
        chapters: toNumber(record["total-chapters"]) ?? 0,
        rating: toNumber(record["average-review"]) ?? 0,
        reviews: toNumber(record["total-reviews"]) ?? 0,
        rank: toNumber(record.rank) ?? Number.MAX_SAFE_INTEGER,
        weeklyRank: toNumber(record["weekly-rank"]) ?? Number.MAX_SAFE_INTEGER,
        created: Number.isNaN(created) ? 0 : created,
    };
}
function sortNovels(novels, sort, query) {
    const list = [...novels];
    switch (sort) {
        case "relevance": {
            const score = (n) => {
                const name = normalize(n.name);
                if (name === query)
                    return 0;
                if (name.startsWith(query))
                    return 1;
                return 2;
            };
            return list.sort((a, b) => score(a) - score(b) || a.rank - b.rank);
        }
        case "weekly":
            return list.sort((a, b) => a.weeklyRank - b.weeklyRank);
        case "rating":
            return list.sort((a, b) => b.rating - a.rating || b.reviews - a.reviews);
        case "reviews":
            return list.sort((a, b) => b.reviews - a.reviews);
        case "new":
            return list.sort((a, b) => b.created - a.created);
        case "chapters":
            return list.sort((a, b) => b.chapters - a.chapters);
        case "az":
            return list.sort((a, b) => a.name.localeCompare(b.name));
        default:
            return list.sort((a, b) => a.rank - b.rank);
    }
}
// 7^code mod 1999999997, with 16-bit split multiplication so intermediate
// values stay within Number's safe integer range
export function chapterTagId(code) {
    const mulmod = (a, b) => {
        const high = Math.floor(b / 65536);
        const low = b % 65536;
        return (((a * high) % TAG_MODULUS) * 65536 + a * low) % TAG_MODULUS;
    };
    let result = 1;
    let base = 7 % TAG_MODULUS;
    let exponent = code;
    while (exponent > 0) {
        if (exponent % 2 === 1)
            result = mulmod(result, base);
        base = mulmod(base, base);
        exponent = Math.floor(exponent / 2);
    }
    return result;
}
// ----- Utils -----
function checkStatus(status, url) {
    if (status === 404)
        throw new Error(`MVLEMPYR: not found (${url})`);
    if (status === 429)
        throw new Error("MVLEMPYR: too many requests, please try again later");
    if (status < 200 || status >= 300)
        throw new Error(`MVLEMPYR: HTTP ${status} for ${url}`);
}
function parseJson(data, url) {
    try {
        return JSON.parse(Application.arrayBufferToUTF8String(data));
    }
    catch {
        throw new Error(`MVLEMPYR: unexpected response from ${url}`);
    }
}
function searchMetaOf(query) {
    return query.metadata?.searchMeta ?? {};
}
function genresIn(genres, state) {
    return Object.entries(genres ?? {})
        .filter(([, value]) => value === state)
        .map(([id]) => id);
}
function coverUrl(code, size) {
    return `${ASSETS}/images/${size}/${code}.webp`;
}
function contentRatingFor(genres) {
    const lower = genres.map((g) => g.toLowerCase());
    if (lower.some((g) => ADULT_GENRES.includes(g)))
        return ContentRating.ADULT;
    if (lower.some((g) => MATURE_GENRES.includes(g)))
        return ContentRating.MATURE;
    return ContentRating.EVERYONE;
}
function mapStatus(status) {
    const value = (status ?? "").toLowerCase();
    if (value.includes("complet"))
        return "COMPLETED";
    if (value.includes("ongoing"))
        return "ONGOING";
    if (value.includes("hiatus"))
        return "HIATUS";
    if (value.includes("drop"))
        return "CANCELLED";
    return "UNKNOWN";
}
function toNumber(value) {
    const n = typeof value === "number" ? value : Number.parseFloat(value ?? "");
    return Number.isFinite(n) ? n : undefined;
}
function slugify(text) {
    return text.toLowerCase().trim().replace(/\s+/g, "-");
}
function encodeId(value) {
    return value.replace(UNSAFE_ID_CHARS, (char) => {
        const encoded = encodeURIComponent(char);
        return encoded !== char ? encoded : "-";
    });
}
function normalize(text) {
    return text
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
}
function clean(value) {
    return decode(value ?? "")
        .replace(/\s+/g, " ")
        .trim();
}
function decode(text) {
    return Application.decodeHTMLEntities(text);
}
function escapeXml(text) {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}
export const MVLEmpyr = new MVLEmpyrExtension();
