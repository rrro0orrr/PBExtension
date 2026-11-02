import {
  AdvancedSearchForm,
  Section,
  SelectRow,
  TriStateSelectRow,
  type JSONObject,
  type Tag,
} from "@paperback/types";

export type GenreState = Record<string, "included" | "excluded">;

export interface NovelArchiveSearchMetadata extends JSONObject {
  status?: string;
  genreMatch?: string;
  genres?: GenreState;
}

const STATUS_OPTIONS: Tag[] = [
  { id: "ongoing", title: "Ongoing" },
  { id: "completed", title: "Completed" },
  { id: "hiatus", title: "Hiatus" },
];

const MATCH_OPTIONS: Tag[] = [
  { id: "all", title: "All selected genres (AND)" },
  { id: "any", title: "Any selected genre (OR)" },
];

export class NovelArchiveSearchForm extends AdvancedSearchForm {
  private status: string[];
  private genreMatch: string[];
  private genres: GenreState;

  constructor(
    private readonly genreOptions: Tag[],
    initial?: NovelArchiveSearchMetadata,
  ) {
    super();
    this.status = initial?.status ? [initial.status] : [];
    this.genreMatch = [initial?.genreMatch ?? "all"];
    this.genres = { ...initial?.genres };
  }

  override getSections() {
    return [
      Section("filters", [
        SelectRow("status", {
          title: "Status",
          subtitle: this.status.length ? undefined : "Any",
          layout: "list",
          value: this.status,
          items: STATUS_OPTIONS,
          minItemCount: 0,
          maxItemCount: 1,
          onValueChange: Application.Selector(this as NovelArchiveSearchForm, "onStatusChange"),
        }),
        SelectRow("genre_match", {
          title: "Genre Match",
          layout: "list",
          value: this.genreMatch,
          items: MATCH_OPTIONS,
          minItemCount: 1,
          maxItemCount: 1,
          onValueChange: Application.Selector(this as NovelArchiveSearchForm, "onMatchChange"),
        }),
      ]),
      Section({ id: "genres", footer: "Tap once to include a genre, twice to exclude it." }, [
        TriStateSelectRow("genres", {
          title: "Genres",
          layout: "flow",
          value: this.genres,
          items: this.genreOptions,
          allowExclusion: true,
          allowEmptySelection: true,
          onValueChange: Application.Selector(this as NovelArchiveSearchForm, "onGenresChange"),
        }),
      ]),
    ];
  }

  async onStatusChange(value: string[]): Promise<void> {
    this.status = value;
    this.reloadForm();
  }

  async onMatchChange(value: string[]): Promise<void> {
    this.genreMatch = value;
    this.reloadForm();
  }

  async onGenresChange(value: GenreState): Promise<void> {
    this.genres = value;
    this.reloadForm();
  }

  override getSearchQueryMetadata(): { searchMeta: NovelArchiveSearchMetadata } {
    const meta: NovelArchiveSearchMetadata = {};
    if (this.status[0]) meta.status = this.status[0];
    if (this.genreMatch[0] === "any") meta.genreMatch = "any";
    if (Object.keys(this.genres).length) meta.genres = this.genres;
    return { searchMeta: meta };
  }
}
