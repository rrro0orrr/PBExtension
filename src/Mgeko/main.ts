import {
  AdvancedSearchForm,
  BasicRateLimiter,
  Chapter,
  ChapterDetails,
  ChapterProviding,
  CloudflareBypassRequestProviding,
  CloudflareError,
  ContentRating,
  Cookie,
  CookieStorageInterceptor,
  DiscoverSection,
  DiscoverSectionItem,
  DiscoverSectionProviding,
  DiscoverSectionType,
  Extension,
  MangaProviding,
  Metadata,
  PagedResults,
  Request,
  SearchQuery,
  SearchResultItem,
  SearchResultsProviding,
  SortingOption,
  SourceManga,
  Tag,
} from "@paperback/types";
import * as cheerio from "cheerio";
import type { CheerioAPI } from "cheerio";
import { MgekoInterceptor } from "./interceptors";
import { MgekoSearchForm, type GenreState, type MgekoSearchMetadata } from "./SearchForm";

// Built with Inkdex's Mgeko extension (inkdex/general-extensions) as the
// reference for the site's endpoints and markup.
const DOMAIN = "https://www.mgeko.cc";
const GENRE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// Values accepted by /browse-comics/data/?sort=
const SORT_OPTIONS: SortingOption[] = [
  { id: "popular_all_time", label: "Popular (All Time)" },
  { id: "popular_monthly", label: "Popular (Monthly)" },
  { id: "popular_weekly", label: "Popular (Weekly)" },
  { id: "popular_daily", label: "Popular (Daily)" },
  { id: "rating", label: "Top Rated" },
  { id: "latest", label: "Latest Updates" },
  { id: "recently_added", label: "Recently Added" },
  { id: "az", label: "Title (A-Z)" },
  { id: "za", label: "Title (Z-A)" },
];

const SECTIONS: Record<string, { title: string; sort: string; type: DiscoverSectionType }> = {
  popular_daily: {
    title: "Trending Today",
    sort: "popular_daily",
    type: DiscoverSectionType.featured,
  },
  latest: {
    title: "Latest Updates",
    sort: "latest",
    type: DiscoverSectionType.simpleCarousel,
  },
  popular_weekly: {
    title: "Popular This Week",
    sort: "popular_weekly",
    type: DiscoverSectionType.prominentCarousel,
  },
  popular_all_time: {
    title: "Popular All Time",
    sort: "popular_all_time",
    type: DiscoverSectionType.simpleCarousel,
  },
  rating: { title: "Top Rated", sort: "rating", type: DiscoverSectionType.simpleCarousel },
  recently_added: {
    title: "Recently Added",
    sort: "recently_added",
    type: DiscoverSectionType.simpleCarousel,
  },
};

const ADULT_GENRES = ["adult", "smut", "hentai", "erotica"];
const MATURE_GENRES = ["mature", "ecchi"];

// Paperback rejects ids with characters outside this set
const UNSAFE_ID_CHARS = /[^a-zA-Z0-9._\-@()[\]%?#+=/&:]/g;

const MONTHS: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

interface BrowseResult {
  results_html?: string;
  page?: number;
  num_pages?: number;
  total_results?: number;
}

interface ComicCard {
  id: string;
  title: string;
  cover: string;
  rating?: string;
  views?: string;
  badge?: string;
}

type PageMetadata = { page?: number };

type MgekoImplementation = Extension &
  SearchResultsProviding &
  MangaProviding &
  ChapterProviding &
  DiscoverSectionProviding &
  CloudflareBypassRequestProviding;

export class MgekoExtension implements MgekoImplementation {
  cookieStorageInterceptor = new CookieStorageInterceptor({
    storage: "stateManager",
  });
  requestManager = new MgekoInterceptor("main");
  globalRateLimiter = new BasicRateLimiter("rateLimiter", {
    numberOfRequests: 4,
    bufferInterval: 1,
    ignoreImages: true,
  });

  private genreCache: { genres: Tag[]; fetchedAt: number } | undefined;

  async initialise(): Promise<void> {
    this.cookieStorageInterceptor.registerInterceptor();
    this.requestManager.registerInterceptor();
    this.globalRateLimiter.registerInterceptor();
  }

  // ----- Discover -----

  async getDiscoverSections(): Promise<DiscoverSection[]> {
    return [
      ...Object.entries(SECTIONS).map(([id, s]) => ({ id, title: s.title, type: s.type })),
      { id: "genres", title: "Genres", type: DiscoverSectionType.genres },
    ];
  }

  async getDiscoverSectionItems(
    section: DiscoverSection,
    metadata: PageMetadata | undefined,
  ): Promise<PagedResults<DiscoverSectionItem>> {
    if (section.id === "genres") {
      const genres = await this.getGenres().catch(() => [] as Tag[]);
      return {
        items: genres.map((genre) => ({
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

    const def = SECTIONS[section.id];
    if (!def) return { items: [] };

    const page = metadata?.page ?? 1;
    const { cards, hasNext } = await this.browse({ page, sort: def.sort });

    return {
      items: cards.map((card): DiscoverSectionItem => {
        const subtitle = cardSubtitle(card);
        switch (def.type) {
          case DiscoverSectionType.featured:
            return {
              type: "featuredCarouselItem",
              mangaId: card.id,
              imageUrl: card.cover,
              title: card.title,
              supertitle: card.badge || undefined,
            };
          case DiscoverSectionType.prominentCarousel:
            return {
              type: "prominentCarouselItem",
              mangaId: card.id,
              imageUrl: card.cover,
              title: card.title,
              subtitle,
            };
          default:
            return {
              type: "simpleCarouselItem",
              mangaId: card.id,
              imageUrl: card.cover,
              title: card.title,
              subtitle,
            };
        }
      }),
      metadata: hasNext ? { page: page + 1 } : undefined,
    };
  }

  // ----- Search -----

  async getSortingOptions(_query: SearchQuery<Metadata>): Promise<SortingOption[]> {
    return SORT_OPTIONS;
  }

  async getAdvancedSearchForm(query: SearchQuery<Metadata>): Promise<AdvancedSearchForm> {
    const genres = await this.getGenres().catch(() => [] as Tag[]);
    return new MgekoSearchForm(genres, searchMetaOf(query));
  }

  // The browse endpoint takes the title (q) together with every filter and
  // pages its results, unlike the site's autocomplete box.
  async getSearchResults(
    query: SearchQuery<Metadata>,
    metadata: PageMetadata | undefined,
    sortingOption: SortingOption | undefined,
  ): Promise<PagedResults<SearchResultItem>> {
    const page = metadata?.page ?? 1;
    const meta = searchMetaOf(query);
    const title = (query.title ?? "").trim();

    const { cards, hasNext } = await this.browse({
      page,
      q: title,
      sort: sortingOption?.id ?? (title ? "popular_all_time" : "popular_weekly"),
      status: meta.status,
      type: meta.type,
      includeGenres: genresIn(meta.genres, "included"),
      excludeGenres: genresIn(meta.genres, "excluded"),
      minChapters: meta.minChapters,
    });

    return {
      items: cards.map((card) => ({
        mangaId: card.id,
        imageUrl: card.cover,
        title: card.title,
        subtitle: cardSubtitle(card),
      })),
      metadata: hasNext ? { page: page + 1 } : undefined,
    };
  }

  // ----- Manga -----

  async getMangaDetails(mangaId: string): Promise<SourceManga> {
    const $ = await this.fetchHtml(`${DOMAIN}/manga/${mangaId}/`);

    const title = clean($(".novel-title").first().text());
    const altTitles = clean($("h2.alternative-title").first().text())
      .split(/\s*,\s*/)
      .filter((t) => t && t !== title);
    const coverImg = $("div.fixed-img img").first();
    const cover = absoluteUrl(coverImg.attr("data-src") || coverImg.attr("src") || "");

    const authorText = clean($("div.author").first().text()).replace(/^Author:\s*/i, "");
    const author = /^updating$/i.test(authorText) ? "" : authorText;

    // The description starts with boilerplate ending in "The Summary is"
    const rawDescription = $(".description").first().text().trim();
    const summaryAt = rawDescription.indexOf("The Summary is");
    const synopsis = decode(
      summaryAt >= 0 ? rawDescription.slice(summaryAt + "The Summary is".length) : rawDescription,
    ).trim();

    const genres: Tag[] = [];
    const seen = new Set<string>();
    $("div.categories li").each((_, el) => {
      const name = clean($(el).text());
      const key = name.toLowerCase();
      if (!name || seen.has(key)) return;
      seen.add(key);
      genres.push({ id: encodeId(name), title: titleCase(name) });
    });

    const ratingValue = parseFloat($(".rating-star strong").first().text());
    let statusText = "";
    $("div.header-stats span").each((_, el) => {
      if (/status/i.test($(el).find("small").text()))
        statusText = clean($(el).find("strong").text());
    });

    return {
      mangaId,
      mangaInfo: {
        primaryTitle: title || mangaId,
        secondaryTitles: altTitles,
        thumbnailUrl: cover,
        synopsis,
        ...(author ? { author, artist: author } : {}),
        ...(Number.isFinite(ratingValue) ? { rating: Math.min(1, ratingValue / 5) } : {}),
        status: mapStatus(statusText),
        contentRating: contentRatingFor(genres.map((g) => g.title)),
        tagGroups: genres.length ? [{ id: "genres", title: "Genres", tags: genres }] : [],
        shareUrl: `${DOMAIN}/manga/${mangaId}/`,
      },
    };
  }

  async getChapters(sourceManga: SourceManga): Promise<Chapter[]> {
    const $ = await this.fetchHtml(`${DOMAIN}/manga/${sourceManga.mangaId}/all-chapters/`);

    const chapters: Chapter[] = [];
    const seen = new Set<string>();
    const items = $("ul.chapter-list li").toArray();
    items.forEach((el, index) => {
      const link = $(el).find("a").first();
      const chapterId = link.attr("href")?.match(/\/reader\/en\/([^/?#]+)/)?.[1] ?? "";
      if (!chapterId || seen.has(chapterId)) return;
      seen.add(chapterId);

      // Titles look like "17-eng-li" or "10-5-eng-li": number, then a language suffix
      const rawTitle = clean($(el).find("strong.chapter-title").text());
      const number = parseChapterNumber(rawTitle) ?? parseChapterNumber(chapterId);
      const extra = rawTitle
        .replace(/^\s*\d+(?:[-.]\d+)?/, "")
        .replace(/-?eng(?:-li)?\b/gi, "")
        .replace(/^[\s:–-]+/, "")
        .trim();
      const date = parseSiteDate($(el).find("time.chapter-update").attr("datetime"));

      chapters.push({
        chapterId,
        sourceManga,
        // The list is newest first
        chapNum: number ?? items.length - index,
        title: extra ? `Chapter ${number ?? ""}: ${extra}`.replace(" :", ":") : "",
        langCode: "en",
        ...(date ? { publishDate: date } : {}),
      });
    });

    if (!chapters.length) {
      throw new Error(`Mgeko: no chapters found for ${sourceManga.mangaId}`);
    }
    return chapters;
  }

  async getChapterDetails(chapter: Chapter): Promise<ChapterDetails> {
    const $ = await this.fetchHtml(`${DOMAIN}/reader/en/${chapter.chapterId}/`);

    const pages: string[] = [];
    $("#chapter-reader img, .page-in img").each((_, el) => {
      const img = $(el);
      const src = absoluteUrl(img.attr("data-src") || img.attr("src") || "");
      if (!src || /credits-mgeko/i.test(src) || /credits/i.test(img.attr("alt") ?? "")) return;
      if (!pages.includes(src)) pages.push(src);
    });

    if (!pages.length) {
      throw new Error(`Mgeko: no pages found for ${chapter.chapterId}`);
    }
    return { id: chapter.chapterId, mangaId: chapter.sourceManga.mangaId, pages };
  }

  // ----- Cloudflare -----

  async saveCloudflareBypassCookies(cookies: Cookie[]): Promise<void> {
    for (const cookie of this.cookieStorageInterceptor.cookies) {
      this.cookieStorageInterceptor.deleteCookie(cookie);
    }
    for (const cookie of cookies) {
      if (cookie.expires && cookie.expires.getTime() <= Date.now()) continue;
      this.cookieStorageInterceptor.setCookie(cookie);
    }
  }

  // ----- Helpers -----

  private async browse(options: {
    page: number;
    sort: string;
    q?: string;
    status?: string;
    type?: string;
    includeGenres?: string[];
    excludeGenres?: string[];
    minChapters?: string;
  }): Promise<{ cards: ComicCard[]; hasNext: boolean }> {
    const params = new URLSearchParams({
      page: String(options.page),
      sort: options.sort,
      safe_mode: "0",
    });
    if (options.q) params.set("q", options.q);
    if (options.status) params.set("status", options.status);
    if (options.type) params.set("type", options.type);
    if (options.includeGenres?.length)
      params.set("include_genres", options.includeGenres.join(","));
    if (options.excludeGenres?.length)
      params.set("exclude_genres", options.excludeGenres.join(","));
    if (options.minChapters) params.set("min_chapters", options.minChapters);

    const data = await this.fetchJson<BrowseResult>(
      `${DOMAIN}/browse-comics/data/?${params.toString()}`,
    );
    const cards = parseCards(cheerio.load(data.results_html ?? ""));
    const hasNext =
      typeof data.page === "number" && typeof data.num_pages === "number"
        ? data.page < data.num_pages
        : cards.length > 0;
    return { cards, hasNext };
  }

  private async getGenres(): Promise<Tag[]> {
    if (this.genreCache && Date.now() - this.genreCache.fetchedAt < GENRE_CACHE_TTL_MS) {
      return this.genreCache.genres;
    }
    const $ = await this.fetchHtml(`${DOMAIN}/browse-comics/`);
    const genres: Tag[] = [];
    const seen = new Set<string>();
    $("button.chip[data-group='include_genres']").each((_, el) => {
      const value = ($(el).attr("data-value") ?? "").trim();
      if (!value || seen.has(value.toLowerCase())) return;
      seen.add(value.toLowerCase());
      genres.push({ id: encodeId(value), title: value });
    });
    if (genres.length) this.genreCache = { genres, fetchedAt: Date.now() };
    return genres;
  }

  private async fetchHtml(url: string): Promise<CheerioAPI> {
    const [response, data] = await Application.scheduleRequest({ url, method: "GET" } as Request);
    checkStatus(response.status, url);
    return cheerio.load(Application.arrayBufferToUTF8String(data));
  }

  private async fetchJson<T>(url: string): Promise<T> {
    const [response, data] = await Application.scheduleRequest({ url, method: "GET" } as Request);
    checkStatus(response.status, url);
    try {
      return JSON.parse(Application.arrayBufferToUTF8String(data)) as T;
    } catch {
      // An HTML page instead of JSON means a bot check
      throw new CloudflareError({ url: `${DOMAIN}/`, method: "GET" });
    }
  }
}

// ----- Parsing -----

function parseCards($: CheerioAPI): ComicCard[] {
  const cards: ComicCard[] = [];
  const seen = new Set<string>();
  let nodes = $("article.comic-card, .comic-card").toArray();
  // Fall back to any block that links to a manga page
  if (!nodes.length) nodes = $("a[href*='/manga/']").parent().toArray();

  for (const el of nodes) {
    const card = $(el);
    const href = card.find("a[href*='/manga/']").first().attr("href") ?? card.attr("href") ?? "";
    const id = href.match(/\/manga\/([^/?#]+)/)?.[1] ?? "";
    if (!id || seen.has(id)) continue;

    const img = card.find("img").first();
    const title = clean(
      card.find(".comic-card__title").first().text() ||
        img.attr("alt") ||
        card.find("a[title]").first().attr("title") ||
        "",
    );
    if (!title) continue;
    seen.add(id);

    cards.push({
      id,
      title,
      cover: absoluteUrl(img.attr("data-src") || img.attr("src") || ""),
      rating: clean(card.find(".comic-card__stat--rating").first().text())
        .replace(/[⭐★]/g, "")
        .trim(),
      views: card
        .find(".comic-card__stat--hot span")
        .toArray()
        .map((s) => clean($(s).text()))
        .find(Boolean),
      badge: clean(card.find(".comic-card__badge").first().text()) || undefined,
    });
  }
  return cards;
}

function cardSubtitle(card: ComicCard): string | undefined {
  const parts = [
    card.rating ? `★ ${card.rating}` : "",
    card.views ? `🔥 ${formatCount(card.views)}` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : undefined;
}

// "17-eng-li" -> 17, "10-5-eng-li" -> 10.5, "...-chapter-3-eng-li" -> 3
function parseChapterNumber(text: string): number | undefined {
  const match =
    text.match(/(?:chapter-)?(\d+)(?:[-.](\d+))?(?=-eng|$|\s)/i) ??
    text.match(/(\d+)(?:[-.](\d+))?/);
  if (!match) return undefined;
  const value = parseFloat(match[2] ? `${match[1]}.${match[2]}` : match[1]);
  return Number.isFinite(value) ? value : undefined;
}

// Django dates: "Nov. 2, 2026, 6:26 p.m.", "Sept. 1, 2025, noon", "May 3, 2024, 11 a.m."
function parseSiteDate(text: string | undefined): Date | undefined {
  if (!text) return undefined;
  const m = text
    .trim()
    .match(
      /^([A-Za-z]+)\.?\s+(\d{1,2}),\s*(\d{4})(?:,\s*(noon|midnight|(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?))?/i,
    );
  if (!m) return undefined;
  const month = MONTHS[m[1].slice(0, 3).toLowerCase()];
  if (month === undefined) return undefined;
  let hours = 0;
  let minutes = 0;
  if (m[4]?.toLowerCase() === "noon") hours = 12;
  else if (m[5]) {
    hours = Number(m[5]) % 12;
    minutes = Number(m[6] ?? 0);
    if (m[7]?.toLowerCase() === "p") hours += 12;
  }
  const date = new Date(Date.UTC(Number(m[3]), month, Number(m[2]), hours, minutes));
  return Number.isNaN(date.getTime()) ? undefined : date;
}

// ----- Utils -----

function checkStatus(status: number, url: string): void {
  if (status === 403 || status === 503) {
    throw new CloudflareError({ url: `${DOMAIN}/`, method: "GET" });
  }
  if (status === 404) throw new Error(`Mgeko: not found (${url})`);
  if (status === 429) throw new Error("Mgeko: too many requests, please try again later");
  if (status < 200 || status >= 300) throw new Error(`Mgeko: HTTP ${status} for ${url}`);
}

function searchMetaOf(query: SearchQuery<Metadata>): MgekoSearchMetadata {
  return (query.metadata as { searchMeta?: MgekoSearchMetadata } | undefined)?.searchMeta ?? {};
}

function genresIn(genres: GenreState | undefined, state: "included" | "excluded"): string[] {
  return Object.entries(genres ?? {})
    .filter(([, value]) => value === state)
    .map(([id]) => decodeId(id));
}

function contentRatingFor(genres: string[]): ContentRating {
  const lower = genres.map((g) => g.toLowerCase());
  if (lower.some((g) => ADULT_GENRES.includes(g))) return ContentRating.ADULT;
  if (lower.some((g) => MATURE_GENRES.includes(g))) return ContentRating.MATURE;
  return ContentRating.EVERYONE;
}

function mapStatus(status: string): string {
  const value = status.toLowerCase();
  if (value.includes("complet")) return "COMPLETED";
  if (value.includes("ongoing")) return "ONGOING";
  if (value.includes("hiatus")) return "HIATUS";
  return "UNKNOWN";
}

function formatCount(raw: string): string {
  const n = parseInt(raw.replace(/[^\d]/g, ""), 10);
  if (!Number.isFinite(n)) return raw;
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${+(n / 1_000).toFixed(1)}K`;
  return `${+(n / 1_000_000).toFixed(1)}M`;
}

function absoluteUrl(url: string): string {
  const value = url.trim();
  if (!value) return "";
  if (value.startsWith("//")) return `https:${value}`;
  if (value.startsWith("/")) return `${DOMAIN}${value}`;
  return value;
}

function encodeId(value: string): string {
  return value.replace(UNSAFE_ID_CHARS, (char) => {
    const encoded = encodeURIComponent(char);
    return encoded !== char ? encoded : "-";
  });
}

function decodeId(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function titleCase(text: string): string {
  return text.replace(/\b\w/g, (c) => c.toUpperCase());
}

function clean(text: string | undefined | null): string {
  return decode(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function decode(text: string): string {
  return Application.decodeHTMLEntities(text);
}

export const Mgeko = new MgekoExtension();
