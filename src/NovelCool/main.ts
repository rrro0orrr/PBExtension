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
  SourceManga,
  Tag,
} from "@paperback/types";
import * as cheerio from "cheerio";
import type { CheerioAPI } from "cheerio";
import { NovelCoolSearchForm, type NovelCoolSearchMetadata } from "./forms/SearchForm";
import { NovelCoolInterceptor } from "./interceptors";

// English site. Other languages live on subdomains (es., de., ...) and are ignored.
const baseUrl = "https://www.novelcool.com";

// "Web Novel" genre: the site mixes manga and novels in every listing, and this
// genre is the only server-side way to get mostly-novel lists.
const WEB_NOVEL_GENRE = "1090";
const MAX_REDIRECT_HOPS = 4;
const GENRE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const ADULT_TAGS = ["adult", "smut", "erotica", "hentai", "18+", "r-18", "explicit"];
const MATURE_TAGS = ["mature", "ecchi"];

const VOID_ELEMENTS = "area|base|br|col|embed|hr|img|input|link|meta|source|track|wbr";
const VOID_ELEMENT_REGEX = new RegExp(`<(${VOID_ELEMENTS})((?:\\s+[^>]*?)?)\\s*/?>`, "gi");
const KEPT_ATTRIBUTES = new Set(["src", "alt", "colspan", "rowspan"]);

interface ListItem {
  id: string;
  title: string;
  cover: string;
  tags: string[];
  isNovel: boolean;
  subtitle?: string;
}

interface FetchedPage {
  $: CheerioAPI;
  html: string;
  finalUrl: string;
  status: number;
}

type PageMetadata = { page?: number };

const SECTIONS: Record<string, { title: string; paths: string[]; type: DiscoverSectionType }> = {
  latest: {
    title: "Latest Updates",
    paths: [`/category/latest/category_id-${WEB_NOVEL_GENRE}.html`, "/category/latest.html"],
    type: DiscoverSectionType.simpleCarousel,
  },
  popular: {
    title: "Popular Novels",
    paths: [`/category/popular/category_id-${WEB_NOVEL_GENRE}.html`, "/category/popular.html"],
    type: DiscoverSectionType.featured,
  },
  new: {
    title: "New Novels",
    paths: [`/category/new_list/category_id-${WEB_NOVEL_GENRE}.html`, "/category/new_list.html"],
    type: DiscoverSectionType.simpleCarousel,
  },
  original: {
    title: "NovelCool Originals",
    paths: ["/category/original.html"],
    type: DiscoverSectionType.prominentCarousel,
  },
  completed: {
    title: "Completed",
    paths: [`/category/completed/category_id-${WEB_NOVEL_GENRE}.html`, "/category/completed.html"],
    type: DiscoverSectionType.simpleCarousel,
  },
};

type NovelCoolImplementation = Extension &
  SearchResultsProviding &
  MangaProviding &
  ChapterProviding &
  DiscoverSectionProviding &
  CloudflareBypassRequestProviding;

export class NovelCoolExtension implements NovelCoolImplementation {
  cookieStorageInterceptor = new CookieStorageInterceptor({
    storage: "stateManager",
  });
  requestManager = new NovelCoolInterceptor("main");
  globalRateLimiter = new BasicRateLimiter("rateLimiter", {
    numberOfRequests: 4,
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
    return Object.entries(SECTIONS).map(([id, s]) => ({ id, title: s.title, type: s.type }));
  }

  async getDiscoverSectionItems(
    section: DiscoverSection,
  ): Promise<PagedResults<DiscoverSectionItem>> {
    const def = SECTIONS[section.id];
    if (!def) return { items: [] };

    // Category pages have no pagination: one page of up to ~80 titles each.
    let novels: ListItem[] = [];
    for (const path of def.paths) {
      try {
        const page = await this.fetchPage(`${baseUrl}${path}`);
        novels = parseList(page.$).filter((item) => item.isNovel);
      } catch {
        novels = [];
      }
      if (novels.length) break;
    }

    return {
      items: novels.map((item): DiscoverSectionItem => {
        const contentRating = contentRatingFor(item.tags);
        switch (def.type) {
          case DiscoverSectionType.featured:
            return {
              type: "featuredCarouselItem",
              mangaId: item.id,
              imageUrl: item.cover,
              title: item.title,
              contentRating,
            };
          case DiscoverSectionType.prominentCarousel:
            return {
              type: "prominentCarouselItem",
              mangaId: item.id,
              imageUrl: item.cover,
              title: item.title,
              subtitle: item.subtitle,
              contentRating,
            };
          default:
            return {
              type: "simpleCarouselItem",
              mangaId: item.id,
              imageUrl: item.cover,
              title: item.title,
              subtitle: item.subtitle,
              contentRating,
            };
        }
      }),
    };
  }

  // ----- Search -----

  async getAdvancedSearchForm(query: SearchQuery<Metadata>): Promise<AdvancedSearchForm> {
    const meta = (query.metadata as { searchMeta?: NovelCoolSearchMetadata } | undefined)
      ?.searchMeta;
    const genres = await this.getGenres().catch(() => []);
    return new NovelCoolSearchForm(genres, meta);
  }

  async getSearchResults(
    query: SearchQuery<Metadata>,
    metadata: PageMetadata | undefined,
  ): Promise<PagedResults<SearchResultItem>> {
    const page = metadata?.page ?? 1;
    const searchMeta = (query.metadata as { searchMeta?: NovelCoolSearchMetadata } | undefined)
      ?.searchMeta;
    const included = searchMeta?.tagIncluded ?? [];
    const excluded = searchMeta?.tagExcluded ?? [];
    const title = (query.title ?? "").trim();

    // The site's search mixes manga in and ignores genres when no name is
    // given, so genre-only browsing uses the genre's category page instead and
    // every result list is filtered to novels here.
    let items: ListItem[];
    let hasNext = false;

    if (!title && included.length) {
      if (page > 1) return { items: [] };
      const $ = (await this.fetchPage(`${baseUrl}/category/latest/category_id-${included[0]}.html`))
        .$;
      items = parseList($);
    } else {
      const params = new URLSearchParams({
        name_sel: "contain",
        name: title,
        author_sel: "contain",
        author: "",
        category_id: included.join(","),
        out_category_id: excluded.join(","),
        completed_series: "",
      });
      const $ = (await this.fetchPage(`${baseUrl}/search/?${params.toString()}&page=${page}.html`))
        .$;
      items = parseList($);
      hasNext = $(`.page-nav a[href*="page=${page + 1}."]`).length > 0;
    }

    // Client-side genre filtering by name (list items carry genre names, not IDs)
    const genres = await this.getGenres().catch(() => []);
    const nameOf = (id: string) => genres.find((g) => g.id === id)?.name.toLowerCase() ?? "";
    const includeNames = included.map(nameOf).filter(Boolean);
    const excludeNames = excluded.map(nameOf).filter(Boolean);

    const results = items.filter((item) => {
      if (!item.isNovel) return false;
      const tags = item.tags.map((t) => t.toLowerCase());
      if (!title && includeNames.slice(1).some((n) => !tags.includes(n))) return false;
      return !excludeNames.some((n) => tags.includes(n));
    });

    return {
      items: results.map((item) => ({
        mangaId: item.id,
        imageUrl: item.cover,
        title: item.title,
        subtitle: item.subtitle,
        contentRating: contentRatingFor(item.tags),
      })),
      // Keep paging even when one page had no novels: the next one may
      metadata: hasNext ? { page: page + 1 } : undefined,
    };
  }

  // ----- Manga -----

  async getMangaDetails(mangaId: string): Promise<SourceManga> {
    const { $ } = await this.fetchPage(novelUrl(mangaId));

    const title = $("h1.bookinfo-title").first().text().trim();
    const author = $(".bookinfo-author [itemprop=creator]").first().text().trim();
    const cover = $(".bookinfo-pic-img").first().attr("src") ?? "";
    const synopsis = $("[itemprop=description]").first().text().trim();
    const statusText = $(".bk-status").first().text().toLowerCase();
    const rating = parseFloat($(".bookinfo-rate-val").first().text());

    const tags: Tag[] = [];
    const seen = new Set<string>();
    $(".bookinfo-category-list .bk-cate-item a[title]").each((_, el) => {
      const name = ($(el).attr("title") ?? $(el).text()).trim();
      const key = name.toLowerCase();
      if (!name || seen.has(key)) return;
      seen.add(key);
      tags.push({ id: key, title: name });
    });

    return {
      mangaId,
      mangaInfo: {
        primaryTitle: decode(title),
        secondaryTitles: [],
        thumbnailUrl: cover,
        synopsis: decode(synopsis),
        ...(author ? { author: decode(author) } : {}),
        ...(Number.isFinite(rating) ? { rating } : {}),
        status: statusText.includes("complete")
          ? "COMPLETED"
          : statusText.includes("ongoing")
            ? "ONGOING"
            : "UNKNOWN",
        contentRating: contentRatingFor(tags.map((t) => t.title)),
        contentType: "novel",
        tagGroups: tags.length ? [{ id: "genres", title: "Genres", tags }] : [],
        shareUrl: novelUrl(mangaId),
      },
    };
  }

  async getChapters(sourceManga: SourceManga): Promise<Chapter[]> {
    const { $ } = await this.fetchPage(novelUrl(sourceManga.mangaId));

    const entries: { id: string; title: string; date?: Date }[] = [];
    const seen = new Set<string>();
    $(".chp-item a[href*='/chapter/']").each((_, el) => {
      const a = $(el);
      const id = chapterIdFromUrl(a.attr("href") ?? "");
      if (!id || seen.has(id)) return;
      seen.add(id);
      const title = (a.find(".chapter-item-headtitle").text() || a.attr("title") || "").trim();
      const date = new Date(a.find(".chapter-item-time").text().trim());
      entries.push({
        id,
        title,
        date: Number.isNaN(date.getTime()) ? undefined : date,
      });
    });

    // The site lists newest first
    const novelTitle = $("h1.bookinfo-title").first().text().trim();
    return entries.map((entry, index) => {
      const parsed = entry.title.match(/chapter\s*(\d+(?:\.\d+)?)/i);
      const chapNum = parsed ? parseFloat(parsed[1]) : entries.length - index;
      return {
        chapterId: entry.id,
        sourceManga,
        title: cleanChapterTitle(entry.title, novelTitle) || `Chapter ${chapNum}`,
        chapNum,
        langCode: "en",
        ...(entry.date ? { publishDate: entry.date } : {}),
      };
    });
  }

  // Chapter links are not always where the text is. A chapter URL can answer
  // with an HTTP redirect (followed by the app; the final address is in
  // response.url), a meta-refresh or script redirect page, or an interstitial
  // that only links onward. Each hop is recorded so a failure says where it went.
  async getChapterDetails(chapter: Chapter): Promise<ChapterDetails> {
    const trail: string[] = [];
    const visited = new Set<string>();
    let url = chapterUrl(chapter.chapterId);

    for (let hop = 0; hop <= MAX_REDIRECT_HOPS && !visited.has(url); hop++) {
      visited.add(url);
      let page: FetchedPage;
      try {
        page = await this.fetchPage(url, { allowNotFound: true });
      } catch (error) {
        if (error instanceof CloudflareError) throw error;
        trail.push(`${url} -> error: ${String(error)}`);
        break;
      }

      const redirected = page.finalUrl && page.finalUrl !== url;
      trail.push(`${url}${redirected ? ` -> ${page.finalUrl}` : ""} [HTTP ${page.status}]`);

      const content = extractChapterContent(page.$);
      if (content) {
        const heading = page.$(".chapter-title").first().text().trim() || chapter.title || "";
        const body = fixVoidElements(
          (heading ? `<h2>${escapeHtml(heading)}</h2>\n` : "") + content,
        );
        if (trail.length > 1 || redirected) {
          console.log(`[NovelCool] chapter ${chapter.chapterId} redirected: ${trail.join(" | ")}`);
        }
        return {
          id: chapter.chapterId,
          mangaId: chapter.sourceManga.mangaId,
          type: "html",
          html: `<html xmlns="http://www.w3.org/1999/xhtml"><head></head><body>${body}</body></html>`,
        };
      }

      // A 404 on the trailing-slash form: the site also uses ".../{id}.html"
      if (page.status === 404 && url.endsWith("/")) {
        url = url.replace(/\/$/, ".html");
        continue;
      }

      const next = findRedirectTarget(page.$, page.html, page.finalUrl || url);
      if (!next) break;
      url = next;
    }

    throw new Error(`NovelCool: no chapter text found. Tried: ${trail.join(" | ")}`);
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

  private async getGenres(): Promise<{ id: string; name: string }[]> {
    if (this.genreCache && Date.now() - this.genreCache.fetchedAt < GENRE_CACHE_TTL_MS) {
      return this.genreCache.genres;
    }
    const { $ } = await this.fetchPage(`${baseUrl}/search/?type=high`);
    const genres: { id: string; name: string }[] = [];
    $(".category-id-item[cate_id]").each((_, el) => {
      const id = $(el).attr("cate_id") ?? "";
      const name = ($(el).attr("title") ?? $(el).text()).trim();
      if (id && name) genres.push({ id, name });
    });
    if (genres.length) this.genreCache = { genres, fetchedAt: Date.now() };
    return genres;
  }

  private async fetchPage(
    url: string,
    options: { allowNotFound?: boolean } = {},
  ): Promise<FetchedPage> {
    const [response, data] = await Application.scheduleRequest({ url, method: "GET" });

    switch (response.status) {
      case 403:
      case 503:
        throw new CloudflareError({ url: baseUrl, method: "GET" });
      case 404:
        if (!options.allowNotFound) throw new Error(`NovelCool: page not found (${url})`);
        break;
      case 429:
        throw new Error("NovelCool: too many requests, please try again later");
    }

    const html = Application.arrayBufferToUTF8String(data);
    return {
      $: cheerio.load(html),
      html,
      finalUrl: response.url || url,
      status: response.status,
    };
  }
}

// ----- Parsing -----

function parseList($: CheerioAPI): ListItem[] {
  const items: ListItem[] = [];
  const seen = new Set<string>();

  $(".book-item").each((_, el) => {
    const item = $(el);
    const link = item.find(".book-info a[href*='/novel/']").first();
    const href = link.attr("href") ?? item.find("a[href*='/novel/']").first().attr("href") ?? "";
    const id = novelIdFromUrl(href);
    if (!id || seen.has(id)) return;
    seen.add(id);

    const img = item.find(".book-pic img").first();
    const title = (
      link.attr("title") ||
      item.find(".book-name").first().text() ||
      item.find(".book-pic").attr("title") ||
      ""
    ).trim();
    const updated = item.find(".book-data-time").first().text().trim();

    items.push({
      id,
      title: decode(title),
      cover: img.attr("lazy_url") || img.attr("cover_url") || img.attr("src") || "",
      tags: item
        .find(".book-tag")
        .map((_, t) => $(t).text().trim())
        .get()
        .filter(Boolean),
      // No type badge means the original-novel listing, which only has novels
      isNovel:
        item.find(".book-type-novel").length > 0 ||
        (item.find(".book-type").length === 0 && /\/novel\/original\//.test(href)),
      subtitle: updated || undefined,
    });
  });

  return items;
}

function extractChapterContent($: CheerioAPI): string {
  const section = $(".chapter-reading-section").first();
  if (!section.length) return "";

  const start = section.find(".chapter-start-mark").first();
  const nodes = start.length
    ? start.nextUntil(".chapter-end-mark")
    : section.children().not(".chapter-title, .chapter-end-mark, .chapter-section-report");

  const wrapper = cheerio.load('<div id="nc-root"></div>');
  const root = wrapper("#nc-root");
  nodes.each((_, el) => {
    root.append(wrapper.html(el) ?? $.html(el));
  });

  root
    .find(
      "script, style, iframe, noscript, ins, button, svg, .bookinfo-share, [class*='sharethis'], [class^='st-'], [class*=' st-'], .adsbygoogle, [id^='ad-'], [class^='ad-']",
    )
    .remove();
  root.find("*").each((_, el) => {
    const node = wrapper(el);
    for (const name of Object.keys(el.attribs ?? {})) {
      if (!KEPT_ATTRIBUTES.has(name)) node.removeAttr(name);
    }
  });
  // Drop empty / whitespace-only paragraphs
  root.find("p").each((_, el) => {
    const node = wrapper(el);
    if (!node.text().replace(/ /g, " ").trim() && !node.find("img").length) node.remove();
  });

  if (!root.text().trim()) return "";
  return (root.html() ?? "").replace(/&nbsp;/g, "&#160;");
}

// Looks for where a redirect/interstitial page wants to send the reader.
// Ignores the reader's own prev/next chapter variables.
function findRedirectTarget($: CheerioAPI, html: string, currentUrl: string): string | undefined {
  const candidates: string[] = [];

  const refresh = $("meta[http-equiv]")
    .filter((_, el) => ($(el).attr("http-equiv") ?? "").toLowerCase() === "refresh")
    .attr("content");
  const fromMeta = refresh?.match(/url\s*=\s*['"]?([^'";\s]+)/i)?.[1];
  if (fromMeta) candidates.push(fromMeta);

  const scriptRegex =
    /(?:window|document|top|self)\.location(?:\.href)?\s*(?:=|\.replace\(|\.assign\()\s*['"]([^'"]+)['"]/g;
  for (const match of html.matchAll(scriptRegex)) candidates.push(match[1]);

  const canonical = $("link[rel=canonical]").attr("href");
  if (canonical && /\/chapter\//.test(canonical)) candidates.push(canonical);

  // Interstitials ("continue reading", "click here") that link to a chapter
  $("a[href*='/chapter/']").each((_, el) => {
    const text = $(el).text().toLowerCase();
    if (/continue|click here|read now|go to chapter|redirect/.test(text)) {
      candidates.push($(el).attr("href") ?? "");
    }
  });

  for (const raw of candidates) {
    const target = raw.replace(/\\\//g, "/").trim();
    if (!target || target.startsWith("#") || target.startsWith("javascript:")) continue;
    const absolute = /^https?:\/\//i.test(target)
      ? target
      : target.startsWith("//")
        ? `https:${target}`
        : `${currentUrl.match(/^(https?:\/\/[^/]+)/i)?.[1] ?? baseUrl}${target.startsWith("/") ? "" : "/"}${target}`;
    if (absolute !== currentUrl) return absolute;
  }
  return undefined;
}

// ----- Utils -----

// ".../novel/Some-Title.html" -> "Some-Title"; ".../novel/original/id-251898.html" -> "original/id-251898"
function novelIdFromUrl(url: string): string {
  return url.match(/\/novel\/([^?#]+?)(?:\.html)?\/?(?:[?#]|$)/)?.[1] ?? "";
}

function novelUrl(id: string): string {
  return `${baseUrl}/novel/${id}.html`;
}

// ".../chapter/Title-Chapter-1/860666/" or ".../860666.html" -> "Title-Chapter-1/860666"
function chapterIdFromUrl(url: string): string {
  return url.match(/\/chapter\/([^?#]+?)(?:\.html|\/)?(?:[?#]|$)/)?.[1] ?? "";
}

function chapterUrl(id: string): string {
  return `${baseUrl}/chapter/${id}/`;
}

// "Transmigrator Meets Reincarnator Chapter 709" -> "Chapter 709"
function cleanChapterTitle(title: string, novelTitle: string): string {
  let t = title.replace(/\s+/g, " ").trim();
  if (novelTitle && t.toLowerCase().startsWith(novelTitle.toLowerCase())) {
    t = t.slice(novelTitle.length).trim();
  }
  return t.replace(/^[-:–]\s*/, "");
}

function contentRatingFor(tags: string[]): ContentRating {
  const lower = tags.map((t) => t.toLowerCase());
  if (lower.some((t) => ADULT_TAGS.includes(t))) return ContentRating.ADULT;
  if (lower.some((t) => MATURE_TAGS.includes(t))) return ContentRating.MATURE;
  return ContentRating.EVERYONE;
}

function decode(text: string): string {
  return Application.decodeHTMLEntities(text);
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

export const NovelCool = new NovelCoolExtension();
