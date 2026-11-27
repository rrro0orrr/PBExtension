import {
  Chapter,
  ChapterDetails,
  CloudflareError,
  ContentRating,
  Cookie,
  CookieStorageInterceptor,
  DiscoverSection,
  DiscoverSectionItem,
  Metadata,
  PagedResults,
  SearchQuery,
  SearchResultItem,
  SortingOption,
  Response,
  SourceManga,
  TagSection,
} from "@paperback/types";
import { CheerioAPI } from "cheerio";

import { MadaraSearchMeta } from "../utils/madara/forms";
import { MadaraExtension, PLACEHOLDER_COVER } from "../utils/madara/template";

/** How long a madaradex.org session cookie is kept when the site gives none. */
const SESSION_COOKIE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Paperback's cookie store forgets session cookies (no expiry) on restart.
 * The access MadaraDex grants after its verification check can be tied to
 * such a cookie, which would make the reader verify again after every app
 * restart. Keep madaradex.org session cookies for up to 30 days instead, like
 * a browser that restores its session. The site still decides whether they
 * are valid; anything it rejects just leads back to the verification prompt.
 */
export class MadaraDexCookieStore extends CookieStorageInterceptor {
  private persist(cookie: Cookie): Cookie {
    if (cookie.expires || !/(^|\.)madaradex\.org$/i.test(cookie.domain.replace(/^\./, ""))) {
      return cookie;
    }
    return { ...cookie, expires: new Date(Date.now() + SESSION_COOKIE_TTL_MS) };
  }

  override setCookie(cookie: Cookie): void {
    super.setCookie(this.persist(cookie));
  }

  override async interceptResponse(
    request: Parameters<CookieStorageInterceptor["interceptResponse"]>[0],
    response: Response,
    data: ArrayBuffer,
  ): Promise<ArrayBuffer> {
    const cookies = (response.cookies ?? []).map((c) => this.persist(c));
    return super.interceptResponse(request, { ...response, cookies }, data);
  }
}

/**
 * MadaraDex replaced its Madara theme with a custom "madaradex-reader" theme
 * (`mdxr-*` markup). Listings and search now live at `/all/` and are driven by
 * `order` / `q` / `mdxr_page`, cards are `article.mdxr-card`, and the details
 * page and chapter list use new markup with a paginated chapter list. None of
 * the stock Madara selectors match any more, so this subclass overrides the
 * listing, search, details and chapter-list parsing. Chapter reading still
 * goes through the shared template (`div.page-break` images).
 */
export class MadaraDexExtension extends MadaraExtension {
  constructor() {
    super({
      name: "MadaraDex",
      baseUrl: "https://madaradex.org",
      mangaSubString: "title",
      useNewChapterEndpoint: false,
      // The old mdx_fp/mdx_auth cookie scheme is gone from the site; chapter
      // images are now gated by a Turnstile-backed grant (see getChapterDetails).
      mdxAuth: false,
      contentRating: ContentRating.MATURE,
      langCode: "🇬🇧",
    });
    this.cookieStorageInterceptor = new MadaraDexCookieStore({ storage: "stateManager" });
  }

  /** Safety cap on chapter-list pages followed per series (80 chapters each). */
  static readonly MAX_CHAPTER_PAGES = 50;

  // Built by hand: the Paperback runtime has no URLSearchParams.
  private indexUrl(params: Record<string, string>, page: number): string {
    const query: [string, string][] = [["mdxr_index", "1"]];
    for (const [key, value] of Object.entries(params)) {
      if (value) query.push([key, value]);
    }
    if (page > 1) query.push(["mdxr_page", page.toString()]);
    const qs = query.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
    return `${this.baseUrl}/all/?${qs}`;
  }

  /** Parse the `article.mdxr-card` grid shared by browse and search pages. */
  private parseCards(
    $: CheerioAPI,
    seen: string[],
  ): { mangaId: string; title: string; image: string }[] {
    const out: { mangaId: string; title: string; image: string }[] = [];
    let cards = $("article.mdxr-update-card");
    if (cards.length === 0) cards = $("main article.mdxr-card");
    cards.each((_, element) => {
      const card = $(element);
      const link = card.find(".mdxr-card-copy h3 a, h3 a").first();
      const cover = card.find("a.mdxr-cover-link").first();
      const title =
        link.text().trim() || link.attr("title")?.trim() || cover.attr("aria-label")?.trim() || "";
      const href = link.attr("href") || cover.attr("href") || "";
      const mangaId = href ? this.parseMangaId(href) : "";
      if (!title || !mangaId || seen.includes(mangaId)) return;
      seen.push(mangaId);
      out.push({
        mangaId,
        title,
        image: this.imageFromElement(card.find("img.mdxr-cover, img").first()) || PLACEHOLDER_COVER,
      });
    });
    return out;
  }

  private hasNextIndexPage($: CheerioAPI): boolean {
    return $("nav.mdxr-index-pagination a[rel=next]").length > 0;
  }

  // ----------------------------------------------------------------
  // Discover
  // ----------------------------------------------------------------

  override async getDiscoverSectionItems(
    section: DiscoverSection,
    metadata: Metadata | undefined,
  ): Promise<PagedResults<DiscoverSectionItem>> {
    const order: Record<string, string> = {
      new_series: "new",
      recently_updated: "latest",
      currently_trending: "popular",
      most_popular: "views",
    };
    if (!order[section.id]) return { items: [] };

    const meta = metadata as { page?: number; collectedIds?: string[] } | undefined;
    const page = meta?.page ?? 1;
    const collectedIds = meta?.collectedIds ?? [];
    const $ = await this.fetchCheerio({
      url: this.indexUrl({ order: order[section.id] }, page),
      method: "GET",
    });

    const type = section.id === "new_series" ? "featuredCarouselItem" : "simpleCarouselItem";
    const items: DiscoverSectionItem[] = this.parseCards($, collectedIds).map((card) => ({
      type,
      mangaId: card.mangaId,
      imageUrl: card.image,
      title: card.title,
      metadata: undefined,
    }));

    return {
      items,
      metadata: this.hasNextIndexPage($) ? { page: page + 1, collectedIds } : undefined,
    };
  }

  // ----------------------------------------------------------------
  // Search
  // ----------------------------------------------------------------

  override async getSortingOptions(): Promise<SortingOption[]> {
    return [
      { id: "", label: "Default" },
      { id: "latest", label: "Latest update" },
      { id: "new", label: "Newest titles" },
      { id: "oldest", label: "Oldest titles" },
      { id: "popular_day", label: "Popular today" },
      { id: "popular", label: "Popular this week" },
      { id: "popular_month", label: "Popular this month" },
      { id: "views", label: "Most viewed" },
      { id: "rating", label: "Highest rated" },
      { id: "az", label: "Title A to Z" },
      { id: "za", label: "Title Z to A" },
    ];
  }

  override async getSearchResults(
    query: SearchQuery<Metadata>,
    metadata: Metadata | undefined,
    sortingOption: SortingOption | undefined,
  ): Promise<PagedResults<SearchResultItem>> {
    const meta = metadata as { page?: number; searchCollectedIds?: string[] } | undefined;
    const page = meta?.page ?? 1;
    const collectedIds = meta?.searchCollectedIds ?? [];
    const searchMeta = (query.metadata as { searchMeta?: MadaraSearchMeta } | undefined)
      ?.searchMeta;

    // The advanced form still speaks Madara values; map them onto the new
    // index filters. The sorting dropdown wins over the form's order.
    const formOrder: Record<string, string> = {
      latest: "latest",
      alphabet: "az",
      rating: "rating",
      trending: "popular",
      views: "views",
      "new-manga": "new",
    };
    const nsfw: Record<string, string> = { "0": "exclude", "1": "only" };
    const titleQuery = (query.title || "").trim();
    const order =
      sortingOption?.id ||
      formOrder[searchMeta?.orderBy?.[0] ?? ""] ||
      (titleQuery ? "" : "latest");

    const $ = await this.fetchCheerio({
      url: this.indexUrl(
        {
          q: titleQuery,
          order,
          status: searchMeta?.status?.[0] ?? "",
          nsfw: nsfw[searchMeta?.adult?.[0] ?? ""] ?? "",
          author_q: searchMeta?.author?.trim() ?? "",
          artist_q: searchMeta?.artist?.trim() ?? "",
          year_min: searchMeta?.release?.trim() ?? "",
          year_max: searchMeta?.release?.trim() ?? "",
        },
        page,
      ),
      method: "GET",
    });

    const items: SearchResultItem[] = this.parseCards($, collectedIds).map((card) => ({
      mangaId: card.mangaId,
      imageUrl: card.image,
      title: card.title,
      subtitle: undefined,
      metadata: undefined,
    }));
    const more = this.hasNextIndexPage($) && page < MadaraExtension.MAX_SEARCH_PAGES;
    return {
      items,
      metadata: more ? { page: page + 1, searchCollectedIds: collectedIds } : undefined,
    };
  }

  // ----------------------------------------------------------------
  // Details
  // ----------------------------------------------------------------

  override async getMangaDetails(mangaId: string): Promise<SourceManga> {
    const url = this.buildMangaUrl(await this.resolveMangaId(mangaId));
    const $ = await this.fetchCheerio({ url, method: "GET" });

    const title =
      $("h1#mdxr-series-title").first().text().trim() ||
      $('meta[property="og:title"]').attr("content")?.trim() ||
      "";

    const altTitles: string[] = [];
    $("[data-alternative-titles] bdi").each((_, el) => {
      const t = $(el).text().trim();
      if (t && !altTitles.includes(t)) altTitles.push(t);
    });

    const image =
      this.imageFromElement($(".mdxr-series-cover img").first()) ||
      this.absoluteUrl($('meta[property="og:image"]').attr("content") ?? "") ||
      PLACEHOLDER_COVER;

    const synopsis = $("#mdxr-summary-text").first().text().trim();
    const field = (name: string) =>
      $(`[data-detail-field="${name}"] a`)
        .map((_, el) => $(el).text().trim())
        .get()
        .filter(Boolean);
    const status = $('[data-detail-field="status"]').first().text().trim();

    const termGroup = (group: string, heading: string): TagSection | undefined => {
      const tags = $(`[data-term-group="${group}"] a.mdxr-detail-term`)
        .map((_, el) => $(el).text().trim())
        .get()
        .filter(Boolean)
        .map((t) => ({ id: t.toLowerCase().replace(/\s+/g, "-"), title: t }));
      return tags.length > 0 ? { id: group, title: heading, tags } : undefined;
    };
    const tagGroups = [termGroup("genres", "Genres"), termGroup("tags", "Tags")].filter(
      (g): g is TagSection => !!g,
    );

    const ratingValue = parseFloat(
      $("[data-rating-value]").first().attr("data-rating-value") ?? "",
    );
    const typeText = $(".mdxr-series-cover .mdxr-type-badge").text().toLowerCase();

    return {
      mangaId,
      mangaInfo: {
        primaryTitle: title,
        secondaryTitles: altTitles,
        thumbnailUrl: image,
        author: field("author").join(", ") || undefined,
        artist: field("artist").join(", ") || undefined,
        synopsis,
        rating: isNaN(ratingValue) ? 0 : ratingValue / 5,
        contentRating: this.contentRating,
        contentType: /\b(novel|text)\b/.test(typeText) ? "novel" : "comic",
        status: this.parseStatus(status),
        tagGroups,
        shareUrl: url,
      },
    };
  }

  // ----------------------------------------------------------------
  // Chapters
  // ----------------------------------------------------------------

  override async getChapters(sourceManga: SourceManga): Promise<Chapter[]> {
    const mangaId = await this.resolveMangaId(sourceManga.mangaId);
    let url: string | undefined = this.buildMangaUrl(mangaId);
    const chapters: Chapter[] = [];
    const seen = new Set<string>();
    const visited = new Set<string>();

    // The series page lists 80 chapters at a time; follow "Next page".
    for (let i = 0; url && i < MadaraDexExtension.MAX_CHAPTER_PAGES; i++) {
      visited.add(url);
      const $ = await this.fetchCheerio({ url, method: "GET" });

      $("ul.mdxr-chapter-rows li.wp-manga-chapter, li.wp-manga-chapter").each((_, element) => {
        const row = $(element);
        const link = row.find("a[href]").first();
        const href = link.attr("href") || "";
        const chapterId = href ? this.parseChapterId(href, mangaId) : "";
        if (!chapterId || seen.has(chapterId)) return;
        seen.add(chapterId);

        const nameEl = row.find(".mdxr-chapter-name").first();
        const title =
          nameEl.attr("data-original-chapter-name")?.trim() ||
          nameEl.text().trim() ||
          link.text().trim();

        let chapNum = parseFloat(nameEl.attr("data-chapter-number") ?? "");
        if (isNaN(chapNum)) {
          const m = title.match(/(?:chapter|episode|ch)[.\s-]*(\d+(?:\.\d+)?)/i);
          chapNum = m ? parseFloat(m[1]) : 0;
        }

        const releaseSeconds = parseInt(nameEl.attr("data-chapter-release") ?? "", 10);
        const publishDate = !isNaN(releaseSeconds)
          ? new Date(releaseSeconds * 1000)
          : this.parseDate(
              row.find("time").first().attr("datetime") ?? row.find("time").text().trim(),
            );

        chapters.push({
          chapterId,
          sourceManga,
          title,
          volume: 0,
          chapNum,
          publishDate,
          langCode: this.langCode,
        });
      });

      const next = $("nav.mdxr-chapter-toolbar a[rel=next]").attr("href");
      const nextUrl = next ? this.absoluteUrl(next.replace(/#.*$/, "")) : undefined;
      url = nextUrl && !visited.has(nextUrl) ? nextUrl : undefined;
    }

    return chapters;
  }

  // ----------------------------------------------------------------
  // Chapter pages
  // ----------------------------------------------------------------

  /**
   * cdn.madaradex.org only serves chapter images once the site has granted
   * access to that chapter. The site's own reader first asks for the grant
   * without a CAPTCHA (`mdx_image_auth_refresh` with the chapter's claim), and
   * the server only demands a Cloudflare Turnstile check when it does not
   * already trust the session. Do the same:
   *   1. If the first page is refused, request the grant with an empty
   *      Turnstile token, exactly as the site's script does first.
   *   2. If the server still wants verification, throw a CloudflareError for
   *      the chapter page. Paperback then offers its web view, the reader
   *      passes the check on the real site, and cloudflareBypassCompleted
   *      stores the cookies it sets.
   * The extension never solves the Turnstile check itself.
   */
  override async getChapterDetails(chapter: Chapter): Promise<ChapterDetails> {
    const details = await super.getChapterDetails(chapter);
    const first = "pages" in details ? details.pages[0] : undefined;
    if (!first || !/^https?:\/\/cdn\.madaradex\.org\//i.test(first)) return details;
    if (await this.imageAllowed(first)) return details;

    const chapterUrl = await this.chapterPageUrl(chapter);
    if ((await this.requestImageGrant(chapterUrl)) && (await this.imageAllowed(first))) {
      return details;
    }
    throw new CloudflareError({
      url: chapterUrl,
      method: "GET",
      headers: { "user-agent": await Application.getDefaultUserAgent() },
    });
  }

  private async imageAllowed(url: string): Promise<boolean> {
    const [response] = await Application.scheduleRequest({ url, method: "GET" });
    return response.status !== 401 && response.status !== 403;
  }

  /** Ask for this chapter's image grant without a Turnstile token. */
  private async requestImageGrant(chapterUrl: string): Promise<boolean> {
    try {
      const $ = await this.fetchCheerio({ url: chapterUrl, method: "GET" });
      const claim = $("img[data-mdx-chapter-claim]").first().attr("data-mdx-chapter-claim");
      if (!claim) return false;
      const body = [
        ["action", "mdx_image_auth_refresh"],
        ["chapter_claim", claim],
        ["chapter_challenge", ""],
        ["cf-turnstile-response", ""],
        ["manual_verification", "0"],
      ]
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join("&");
      const [response, data] = await Application.scheduleRequest({
        url: `${this.baseUrl}/wp-admin/admin-ajax.php`,
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body,
      });
      if (response.status >= 400) return false;
      const result = JSON.parse(Application.arrayBufferToUTF8String(data)) as {
        success?: boolean;
      };
      return result.success === true;
    } catch {
      return false;
    }
  }

  private async chapterPageUrl(chapter: Chapter): Promise<string> {
    const id = this.safeDecode(chapter.chapterId);
    if (id.startsWith("/")) return `${this.baseUrl}${id.replace(/\/+$/, "")}/`;
    const mangaUrl = this.buildMangaUrl(await this.resolveMangaId(chapter.sourceManga.mangaId));
    return `${mangaUrl.replace(/\/+$/, "")}/${id}/`;
  }
}

export const MadaraDex = new MadaraDexExtension();
