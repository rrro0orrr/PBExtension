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
  SearchQuery,
  SearchResultItem,
  SearchResultsProviding,
  SortingOption,
  SourceManga,
} from "@paperback/types";
import * as cheerio from "cheerio";
import { NovelArchiveSearchForm, type NovelArchiveSearchMetadata } from "./forms/SearchForm";
import { NovelArchiveInterceptor } from "./interceptors";

const baseUrl = "https://novelarchive.cc";
const apiUrl = `${baseUrl}/api`;

const PAGE_SIZE = 24;
const GENRE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

// Values accepted by /api/novels?sort=
const SORT_OPTIONS: SortingOption[] = [
  { id: "recent", label: "Recently Updated" },
  { id: "popular", label: "Popular" },
  { id: "rating", label: "Top Rated" },
  { id: "chapters", label: "Most Chapters" },
];

const ADULT_GENRES = ["adult", "smut", "erotica", "explicit sex", "nsfw", "r-18", "r18", "hentai"];
const MATURE_GENRES = ["mature", "ecchi", "r-15", "gore", "steamy"];

const VOID_ELEMENTS = "area|base|br|col|embed|hr|img|input|link|meta|source|track|wbr";
const VOID_ELEMENT_REGEX = new RegExp(`<(${VOID_ELEMENTS})((?:\\s+[^>]*?)?)\\s*/?>`, "gi");
const KEPT_ATTRIBUTES = new Set(["src", "alt", "colspan", "rowspan"]);

interface ApiNovel {
  id: string;
  title: string;
  author?: string;
  genres?: string;
  description?: string;
  cover_url?: string;
  novel_image?: string;
  associated_names?: string[];
  chapter_names?: string[];
  total_chapters?: string | number;
  rating?: number;
  rating_count?: number;
  release_status?: string;
  updated_at?: string;
}

interface ApiNovelList {
  novels?: ApiNovel[];
  pagination?: { page: number; total_pages: number; has_next: boolean };
}

interface ApiChapter {
  chapter?: { number: number; name?: string; content?: string };
}

type PageMetadata = { page?: number };

type NovelArchiveImplementation = Extension &
  SearchResultsProviding &
  MangaProviding &
  ChapterProviding &
  DiscoverSectionProviding &
  CloudflareBypassRequestProviding;

export class NovelArchiveExtension implements NovelArchiveImplementation {
  cookieStorageInterceptor = new CookieStorageInterceptor({
    storage: "stateManager",
  });
  requestManager = new NovelArchiveInterceptor("main");
  globalRateLimiter = new BasicRateLimiter("rateLimiter", {
    numberOfRequests: 5,
    bufferInterval: 1,
    ignoreImages: true,
  });

  private genreCache: { genres: { id: string; name: string }[]; fetchedAt: number } | undefined;

  async initialise(): Promise<void> {
    this.cookieStorageInterceptor.registerInterceptor();
    this.requestManager.registerInterceptor();
    this.globalRateLimiter.registerInterceptor();
  }

  // ----- Discover -----

  async getDiscoverSections(): Promise<DiscoverSection[]> {
    return [
      { id: "trending", title: "Trending", type: DiscoverSectionType.featured },
      { id: "editors", title: "Editor's Choice", type: DiscoverSectionType.prominentCarousel },
      {
        id: "updated",
        title: "Recently Updated",
        type: DiscoverSectionType.simpleCarousel,
      },
      { id: "popular", title: "Popular", type: DiscoverSectionType.simpleCarousel },
      { id: "rating", title: "Top Rated", type: DiscoverSectionType.simpleCarousel },
      { id: "new", title: "New Novels", type: DiscoverSectionType.simpleCarousel },
    ];
  }

  async getDiscoverSectionItems(
    section: DiscoverSection,
    metadata: PageMetadata | undefined,
  ): Promise<PagedResults<DiscoverSectionItem>> {
    switch (section.id) {
      case "trending": {
        const list = await this.fetchJson<ApiNovelList>(`${apiUrl}/novels/trending?limit=20`);
        return {
          items: (list.novels ?? []).map((novel) => ({
            type: "featuredCarouselItem",
            mangaId: novel.id,
            imageUrl: coverUrl(novel),
            title: novel.title,
            supertitle: novel.author || undefined,
            contentRating: contentRatingFor(novel.genres),
          })),
        };
      }
      case "editors": {
        const list = await this.fetchJson<ApiNovelList>(`${apiUrl}/novels/editors-choice?limit=20`);
        return {
          items: (list.novels ?? []).map((novel) => ({
            type: "prominentCarouselItem",
            mangaId: novel.id,
            imageUrl: coverUrl(novel),
            title: novel.title,
            subtitle: novel.author || undefined,
            contentRating: contentRatingFor(novel.genres),
          })),
        };
      }
      case "updated":
      case "popular":
      case "rating":
      case "new": {
        const page = metadata?.page ?? 1;
        // "New Novels" uses the creation-ordered feed, the rest the browse sort
        const url =
          section.id === "new"
            ? `${apiUrl}/novels/recent?limit=${PAGE_SIZE * page}`
            : `${apiUrl}/novels?sort=${section.id === "updated" ? "recent" : section.id}&page=${page}&per_page=${PAGE_SIZE}`;
        const list = await this.fetchJson<ApiNovelList>(url);
        let novels = list.novels ?? [];
        if (section.id === "new") novels = novels.slice((page - 1) * PAGE_SIZE);

        return {
          items: novels.map((novel) => ({
            type: "simpleCarouselItem",
            mangaId: novel.id,
            imageUrl: coverUrl(novel),
            title: novel.title,
            subtitle: chapterCountLabel(novel),
            contentRating: contentRatingFor(novel.genres),
          })),
          metadata:
            section.id === "new"
              ? novels.length >= PAGE_SIZE && page < 5
                ? { page: page + 1 }
                : undefined
              : list.pagination?.has_next
                ? { page: page + 1 }
                : undefined,
        };
      }
      default:
        return { items: [] };
    }
  }

  // ----- Search -----

  async getSortingOptions(_query: SearchQuery<Metadata>): Promise<SortingOption[]> {
    return SORT_OPTIONS;
  }

  async getAdvancedSearchForm(query: SearchQuery<Metadata>): Promise<AdvancedSearchForm> {
    const meta = (query.metadata as { searchMeta?: NovelArchiveSearchMetadata } | undefined)
      ?.searchMeta;
    const genres = await this.getGenres().catch(() => []);
    return new NovelArchiveSearchForm(genres, meta);
  }

  async getSearchResults(
    query: SearchQuery<Metadata>,
    metadata: PageMetadata | undefined,
    sortingOption: SortingOption | undefined,
  ): Promise<PagedResults<SearchResultItem>> {
    const page = metadata?.page ?? 1;
    const searchMeta = (query.metadata as { searchMeta?: NovelArchiveSearchMetadata } | undefined)
      ?.searchMeta;

    const params: string[] = [];
    const title = (query.title ?? "").trim();
    if (title) params.push(`search=${encodeURIComponent(title)}`, "fuzzy=1");
    if (searchMeta?.tagIncluded?.length) {
      params.push(`genres_include=${encodeURIComponent(searchMeta.tagIncluded.join(","))}`);
    }
    if (searchMeta?.tagExcluded?.length) {
      params.push(`genres_exclude=${encodeURIComponent(searchMeta.tagExcluded.join(","))}`);
    }
    // With a title, leave the order to the site's relevance ranking unless asked
    const sort = sortingOption?.id ?? (title ? "" : "popular");
    if (sort && sort !== "recent") params.push(`sort=${sort}`);
    params.push(`page=${page}`, `per_page=${PAGE_SIZE}`);

    const list = await this.fetchJson<ApiNovelList>(`${apiUrl}/novels?${params.join("&")}`);

    return {
      items: (list.novels ?? []).map((novel) => ({
        mangaId: novel.id,
        imageUrl: coverUrl(novel),
        title: novel.title,
        subtitle: [novel.author, chapterCountLabel(novel)].filter(Boolean).join(" · "),
        contentRating: contentRatingFor(novel.genres),
      })),
      metadata: list.pagination?.has_next ? { page: page + 1 } : undefined,
    };
  }

  // ----- Manga -----

  async getMangaDetails(mangaId: string): Promise<SourceManga> {
    const novel = await this.getNovel(mangaId);
    const genres = splitGenres(novel.genres);

    return {
      mangaId,
      mangaInfo: {
        primaryTitle: novel.title,
        secondaryTitles: (novel.associated_names ?? []).filter(Boolean),
        thumbnailUrl: coverUrl(novel),
        synopsis: novel.description ?? "",
        ...(novel.author ? { author: novel.author } : {}),
        ...(novel.rating ? { rating: novel.rating } : {}),
        status: mapStatus(novel.release_status),
        contentRating: contentRatingFor(novel.genres),
        contentType: "novel",
        tagGroups: genres.length
          ? [
              {
                id: "genres",
                title: "Genres",
                tags: genres.map((g) => ({ id: g.toLowerCase(), title: g })),
              },
            ]
          : [],
        shareUrl: `${baseUrl}/novel?id=${encodeURIComponent(mangaId)}`,
      },
    };
  }

  async getChapters(sourceManga: SourceManga): Promise<Chapter[]> {
    const novel = await this.getNovel(sourceManga.mangaId);
    const names = novel.chapter_names ?? [];
    const total = Math.max(Number(novel.total_chapters) || 0, names.length);
    const updatedAt = novel.updated_at ? new Date(novel.updated_at) : undefined;

    const chapters: Chapter[] = [];
    for (let number = 1; number <= total; number++) {
      const name = names[number - 1]?.trim();
      chapters.push({
        chapterId: String(number),
        sourceManga,
        title: name && !/^chapter\s*\d+$/i.test(name) ? name : `Chapter ${number}`,
        chapNum: number,
        langCode: "en",
        // The API has no per-chapter dates; mark the newest chapter with the novel's update time
        ...(number === total && updatedAt && !Number.isNaN(updatedAt.getTime())
          ? { publishDate: updatedAt }
          : {}),
      });
    }
    return chapters;
  }

  async getChapterDetails(chapter: Chapter): Promise<ChapterDetails> {
    const data = await this.fetchJson<ApiChapter>(
      `${apiUrl}/novels/${encodeURIComponent(chapter.sourceManga.mangaId)}/chapters/${encodeURIComponent(chapter.chapterId)}`,
    );
    const content = data.chapter?.content ?? "";
    if (!content.trim()) {
      throw new Error(`Novel Archive: chapter ${chapter.chapterId} has no text`);
    }

    const name = data.chapter?.name?.trim();
    const heading = `Chapter ${chapter.chapterId}${name && !/^chapter\s*\d+$/i.test(name) ? `: ${name}` : ""}`;
    const body = fixVoidElements(
      `<h2>${escapeHtml(heading)}</h2>\n${looksLikeHtml(content) ? cleanHtml(content) : textToHtml(content)}`,
    );

    return {
      id: chapter.chapterId,
      mangaId: chapter.sourceManga.mangaId,
      type: "html",
      html: `<html xmlns="http://www.w3.org/1999/xhtml"><head></head><body>${body}</body></html>`,
    };
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

  private async getNovel(id: string): Promise<ApiNovel> {
    const data = await this.fetchJson<{ novel?: ApiNovel }>(
      `${apiUrl}/novels/${encodeURIComponent(id)}`,
    );
    if (!data.novel) throw new Error(`Novel Archive: novel ${id} not found`);
    return data.novel;
  }

  private async getGenres(): Promise<{ id: string; name: string }[]> {
    if (this.genreCache && Date.now() - this.genreCache.fetchedAt < GENRE_CACHE_TTL_MS) {
      return this.genreCache.genres;
    }
    const data = await this.fetchJson<{ genres?: { value: string; label: string }[] }>(
      `${apiUrl}/novels/genres`,
    );
    const genres = (data.genres ?? [])
      .filter((g) => g.value && /^[a-z0-9]/i.test(g.value))
      .map((g) => ({ id: g.value, name: g.label || g.value }));
    this.genreCache = { genres, fetchedAt: Date.now() };
    return genres;
  }

  private async fetchJson<T>(url: string): Promise<T> {
    const [response, data] = await Application.scheduleRequest({
      url,
      method: "GET",
      headers: { accept: "application/json", "content-type": "application/json" },
    });

    switch (response.status) {
      case 403:
      case 503:
        throw new CloudflareError({ url: baseUrl, method: "GET" });
      case 404:
        throw new Error("Novel Archive: not found");
      case 429:
        throw new Error("Novel Archive: too many requests, please try again later");
    }

    const text = Application.arrayBufferToUTF8String(data);
    try {
      return JSON.parse(text) as T;
    } catch {
      // An HTML page instead of JSON means a bot check or an error page
      throw new CloudflareError({ url: baseUrl, method: "GET" });
    }
  }
}

// ----- Utils -----

function coverUrl(novel: ApiNovel): string {
  const path = novel.cover_url || novel.novel_image || "";
  if (!path) return "";
  return path.startsWith("http") ? path : `${baseUrl}${path.startsWith("/") ? "" : "/"}${path}`;
}

function splitGenres(genres: string | undefined): string[] {
  return [
    ...new Set(
      (genres ?? "")
        .split(",")
        .map((g) => g.trim())
        .filter(Boolean),
    ),
  ];
}

function contentRatingFor(genres: string | undefined): ContentRating {
  const list = splitGenres(genres).map((g) => g.toLowerCase());
  if (list.some((g) => ADULT_GENRES.includes(g))) return ContentRating.ADULT;
  if (list.some((g) => MATURE_GENRES.includes(g))) return ContentRating.MATURE;
  return ContentRating.EVERYONE;
}

function mapStatus(status: string | undefined): string {
  switch ((status ?? "").toLowerCase()) {
    case "completed":
      return "COMPLETED";
    case "ongoing":
      return "ONGOING";
    case "hiatus":
      return "HIATUS";
    default:
      return "UNKNOWN";
  }
}

function chapterCountLabel(novel: ApiNovel): string | undefined {
  const total = Number(novel.total_chapters) || 0;
  if (!total) return undefined;
  return total === 1 ? "1 chapter" : `${total} chapters`;
}

function looksLikeHtml(content: string): boolean {
  return /<\/?(p|br|div|span|img|em|strong|i|b|h[1-6])\b[^>]*>/i.test(content);
}

// Plain text: blank lines separate paragraphs, single newlines are line breaks
function textToHtml(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) =>
      p === "***" || p === "* * *" ? "<hr />" : `<p>${escapeHtml(p).replace(/\n/g, "<br />")}</p>`,
    )
    .join("\n");
}

function cleanHtml(html: string): string {
  const $ = cheerio.load(`<div id="na-root">${html}</div>`);
  const root = $("#na-root");
  root.find("script, style, iframe, noscript, ins, button, svg").remove();
  root.find("*").each((_, el) => {
    const node = $(el);
    for (const name of Object.keys(el.attribs ?? {})) {
      if (!KEPT_ATTRIBUTES.has(name)) node.removeAttr(name);
    }
  });
  return (root.html() ?? "").replace(/&nbsp;/g, "&#160;");
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Readium parses chapters as XHTML, so void tags like <br> must be self-closed
function fixVoidElements(html: string): string {
  return html.replace(VOID_ELEMENT_REGEX, (_match, tag: string, attributes: string) => {
    const attrs = attributes.trim();
    return attrs ? `<${tag.toLowerCase()} ${attrs} />` : `<${tag.toLowerCase()} />`;
  });
}

export const NovelArchive = new NovelArchiveExtension();
