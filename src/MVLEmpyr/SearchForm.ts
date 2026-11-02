import {
  AdvancedSearchForm,
  InputRow,
  Section,
  SelectRow,
  TriStateSelectRow,
  type JSONObject,
  type Tag,
} from "@paperback/types";

export type GenreState = Record<string, "included" | "excluded">;

export interface MVLEmpyrSearchMetadata extends JSONObject {
  status?: string;
  genreMatch?: string;
  genres?: GenreState;
  author?: string;
}

const STATUS_OPTIONS: Tag[] = [
  { id: "ongoing", title: "Ongoing" },
  { id: "completed", title: "Completed" },
  { id: "hiatus", title: "Hiatus" },
];

const MATCH_OPTIONS: Tag[] = [
  { id: "and", title: "All selected genres (AND)" },
  { id: "or", title: "Any selected genre (OR)" },
];

export class MVLEmpyrSearchForm extends AdvancedSearchForm {
  private status: string[];
  private genreMatch: string[];
  private genres: GenreState;
  private author: string;

  constructor(
    private readonly genreOptions: Tag[],
    initial?: MVLEmpyrSearchMetadata,
  ) {
    super();
    this.status = initial?.status ? [initial.status] : [];
    this.genreMatch = [initial?.genreMatch ?? "and"];
    this.genres = { ...initial?.genres };
    this.author = initial?.author ?? "";
  }

  override getSections() {
    return [
      Section("filters", [
        InputRow("author", {
          title: "Author",
          value: this.author,
          onValueChange: Application.Selector(this as MVLEmpyrSearchForm, "onAuthorChange"),
        }),
        SelectRow("status", {
          title: "Status",
          subtitle: this.status.length ? undefined : "Any",
          layout: "list",
          value: this.status,
          items: STATUS_OPTIONS,
          minItemCount: 0,
          maxItemCount: 1,
          onValueChange: Application.Selector(this as MVLEmpyrSearchForm, "onStatusChange"),
        }),
        SelectRow("genre_match", {
          title: "Genre Match",
          layout: "list",
          value: this.genreMatch,
          items: MATCH_OPTIONS,
          minItemCount: 1,
          maxItemCount: 1,
          onValueChange: Application.Selector(this as MVLEmpyrSearchForm, "onMatchChange"),
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
          onValueChange: Application.Selector(this as MVLEmpyrSearchForm, "onGenresChange"),
        }),
      ]),
    ];
  }

  async onAuthorChange(value: string): Promise<void> {
    this.author = value;
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

  override getSearchQueryMetadata(): { searchMeta: MVLEmpyrSearchMetadata } {
    const meta: MVLEmpyrSearchMetadata = {};
    if (this.status[0]) meta.status = this.status[0];
    if (this.genreMatch[0] === "or") meta.genreMatch = "or";
    if (Object.keys(this.genres).length) meta.genres = this.genres;
    if (this.author.trim()) meta.author = this.author.trim();
    return { searchMeta: meta };
  }
}
