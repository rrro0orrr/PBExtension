import {
  AdvancedSearchForm,
  InputRow,
  Section,
  SelectRow,
  type JSONObject,
  type Tag,
} from "@paperback/types";

export interface MadaraSearchMeta extends JSONObject {
  author: string;
  artist: string;
  release: string;
  status: string[];
  orderBy: string[];
  adult: string[];
  genreCondition: string[];
  /** Genre slugs sent as `genre[]`; only for sources that supply a genre list. */
  genres?: string[];
}

// Madara `status[]` query options (label -> value)
export const STATUS_OPTIONS = [
  { id: "on-going", title: "Ongoing" },
  { id: "end", title: "Completed" },
  { id: "canceled", title: "Canceled" },
  { id: "on-hold", title: "On Hold" },
  { id: "upcoming", title: "Upcoming" },
];

// Madara `m_orderby` query options
export const ORDER_BY_OPTIONS = [
  { id: "", title: "Relevance" },
  { id: "latest", title: "Latest" },
  { id: "alphabet", title: "A-Z" },
  { id: "rating", title: "Rating" },
  { id: "trending", title: "Trending" },
  { id: "views", title: "Most Views" },
  { id: "new-manga", title: "New" },
];

// Madara `adult` query options
export const ADULT_OPTIONS = [
  { id: "", title: "All" },
  { id: "0", title: "None" },
  { id: "1", title: "Only" },
];

// Madara `op` (genre condition) query options
export const GENRE_CONDITION_OPTIONS = [
  { id: "", title: "OR" },
  { id: "1", title: "AND" },
];

export class MadaraSearchForm extends AdvancedSearchForm {
  private author: string;
  private artist: string;
  private release: string;
  private status: string[];
  private orderBy: string[];
  private adult: string[];
  private genreCondition: string[];
  private genres: string[];

  /**
   * @param genreOptions the site's `genre[]` choices. Sources that pass none
   *   get no genre picker (and no genre AND/OR row, which would do nothing).
   */
  constructor(
    initialMeta?: MadaraSearchMeta,
    private readonly genreOptions: Tag[] = [],
  ) {
    super();
    this.author = initialMeta?.author ?? "";
    this.artist = initialMeta?.artist ?? "";
    this.release = initialMeta?.release ?? "";
    this.status = initialMeta?.status ?? [];
    this.orderBy = initialMeta?.orderBy ?? [];
    this.adult = initialMeta?.adult ?? [];
    this.genreCondition = initialMeta?.genreCondition ?? [];
    const known = new Set(genreOptions.map((g) => g.id));
    this.genres = (initialMeta?.genres ?? []).filter((g) => known.has(g));
  }

  async updateGenres(value: string[]): Promise<void> {
    this.genres = value;
    this.reloadForm();
  }

  async updateAuthor(value: string): Promise<void> {
    this.author = value;
    this.reloadForm();
  }

  async updateArtist(value: string): Promise<void> {
    this.artist = value;
    this.reloadForm();
  }

  async updateRelease(value: string): Promise<void> {
    this.release = value;
    this.reloadForm();
  }

  async updateStatus(value: string[]): Promise<void> {
    this.status = value;
    this.reloadForm();
  }

  async updateOrderBy(value: string[]): Promise<void> {
    this.orderBy = value;
    this.reloadForm();
  }

  async updateAdult(value: string[]): Promise<void> {
    this.adult = value;
    this.reloadForm();
  }

  async updateGenreCondition(value: string[]): Promise<void> {
    this.genreCondition = value;
    this.reloadForm();
  }

  getSearchQueryMetadata() {
    return {
      searchMeta: {
        author: this.author,
        artist: this.artist,
        release: this.release,
        status: this.status,
        orderBy: this.orderBy,
        adult: this.adult,
        genreCondition: this.genreCondition,
        ...(this.genres.length ? { genres: this.genres } : {}),
      } satisfies MadaraSearchMeta,
    };
  }

  override getSections() {
    return [
      Section("text_filters", [
        InputRow("author", {
          title: "Author",
          value: this.author,
          onValueChange: Application.Selector<MadaraSearchForm, (value: string) => Promise<void>>(
            this,
            "updateAuthor",
          ),
        }),
        InputRow("artist", {
          title: "Artist",
          value: this.artist,
          onValueChange: Application.Selector<MadaraSearchForm, (value: string) => Promise<void>>(
            this,
            "updateArtist",
          ),
        }),
        InputRow("release", {
          title: "Year of release",
          value: this.release,
          onValueChange: Application.Selector<MadaraSearchForm, (value: string) => Promise<void>>(
            this,
            "updateRelease",
          ),
        }),
      ]),
      Section("select_filters", [
        SelectRow("status", {
          title: "Status",
          value: this.status,
          options: STATUS_OPTIONS,
          minItemCount: 0,
          maxItemCount: STATUS_OPTIONS.length,
          onValueChange: Application.Selector<MadaraSearchForm, (value: string[]) => Promise<void>>(
            this,
            "updateStatus",
          ),
        }),
        SelectRow("order_by", {
          title: "Order by",
          value: this.orderBy,
          options: ORDER_BY_OPTIONS,
          minItemCount: 0,
          maxItemCount: 1,
          onValueChange: Application.Selector<MadaraSearchForm, (value: string[]) => Promise<void>>(
            this,
            "updateOrderBy",
          ),
        }),
        SelectRow("adult", {
          title: "Adult content",
          value: this.adult,
          options: ADULT_OPTIONS,
          minItemCount: 0,
          maxItemCount: 1,
          onValueChange: Application.Selector<MadaraSearchForm, (value: string[]) => Promise<void>>(
            this,
            "updateAdult",
          ),
        }),
        SelectRow("genre_condition", {
          title: "Genre condition",
          isHidden: this.genreOptions.length === 0,
          value: this.genreCondition,
          options: GENRE_CONDITION_OPTIONS,
          minItemCount: 0,
          maxItemCount: 1,
          onValueChange: Application.Selector<MadaraSearchForm, (value: string[]) => Promise<void>>(
            this,
            "updateGenreCondition",
          ),
        }),
      ]),
      ...(this.genreOptions.length
        ? [
            Section({ id: "genres", footer: "Genre condition picks any vs. all selected." }, [
              SelectRow("genres", {
                title: "Genres",
                subtitle: this.genres.length ? `${this.genres.length} selected` : "Any",
                layout: "flow",
                value: this.genres,
                items: this.genreOptions,
                minItemCount: 0,
                maxItemCount: this.genreOptions.length,
                onValueChange: Application.Selector<
                  MadaraSearchForm,
                  (value: string[]) => Promise<void>
                >(this, "updateGenres"),
              }),
            ]),
          ]
        : []),
    ];
  }
}
