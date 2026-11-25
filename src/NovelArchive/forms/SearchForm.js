import { AdvancedSearchForm, Section, SelectRow, TriStateSelectRow, } from "@paperback/types";
const STATUS_OPTIONS = [
    { id: "ongoing", title: "Ongoing" },
    { id: "completed", title: "Completed" },
    { id: "hiatus", title: "Hiatus" },
];
const MATCH_OPTIONS = [
    { id: "all", title: "All selected genres (AND)" },
    { id: "any", title: "Any selected genre (OR)" },
];
export class NovelArchiveSearchForm extends AdvancedSearchForm {
    genreOptions;
    status;
    genreMatch;
    genres;
    constructor(genreOptions, initial) {
        super();
        this.genreOptions = genreOptions;
        this.status = initial?.status ? [initial.status] : [];
        this.genreMatch = [initial?.genreMatch ?? "all"];
        this.genres = { ...initial?.genres };
    }
    getSections() {
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
                    onValueChange: Application.Selector(this, "onStatusChange"),
                }),
                SelectRow("genre_match", {
                    title: "Genre Match",
                    layout: "list",
                    value: this.genreMatch,
                    items: MATCH_OPTIONS,
                    minItemCount: 1,
                    maxItemCount: 1,
                    onValueChange: Application.Selector(this, "onMatchChange"),
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
                    onValueChange: Application.Selector(this, "onGenresChange"),
                }),
            ]),
        ];
    }
    async onStatusChange(value) {
        this.status = value;
        this.reloadForm();
    }
    async onMatchChange(value) {
        this.genreMatch = value;
        this.reloadForm();
    }
    async onGenresChange(value) {
        this.genres = value;
        this.reloadForm();
    }
    getSearchQueryMetadata() {
        const meta = {};
        if (this.status[0])
            meta.status = this.status[0];
        if (this.genreMatch[0] === "any")
            meta.genreMatch = "any";
        if (Object.keys(this.genres).length)
            meta.genres = this.genres;
        return { searchMeta: meta };
    }
}
