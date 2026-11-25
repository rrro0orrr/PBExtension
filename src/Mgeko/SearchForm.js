import { AdvancedSearchForm, InputRow, Section, SelectRow, TriStateSelectRow, } from "@paperback/types";
const STATUS_OPTIONS = [
    { id: "ongoing", title: "Ongoing" },
    { id: "completed", title: "Completed" },
    { id: "hiatus", title: "Hiatus" },
];
const TYPE_OPTIONS = [
    { id: "manga", title: "Manga" },
    { id: "manhwa", title: "Manhwa" },
    { id: "manhua", title: "Manhua" },
    { id: "webtoon", title: "Webtoon" },
];
export class MgekoSearchForm extends AdvancedSearchForm {
    genreOptions;
    status;
    type;
    genres;
    minChapters;
    constructor(genreOptions, initial) {
        super();
        this.genreOptions = genreOptions;
        this.status = initial?.status ? [initial.status] : [];
        this.type = initial?.type ? [initial.type] : [];
        this.genres = { ...initial?.genres };
        this.minChapters = initial?.minChapters ?? "";
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
                SelectRow("type", {
                    title: "Type",
                    subtitle: this.type.length ? undefined : "Any",
                    layout: "list",
                    value: this.type,
                    items: TYPE_OPTIONS,
                    minItemCount: 0,
                    maxItemCount: 1,
                    onValueChange: Application.Selector(this, "onTypeChange"),
                }),
                InputRow("min_chapters", {
                    title: "Minimum chapters",
                    value: this.minChapters,
                    onValueChange: Application.Selector(this, "onMinChaptersChange"),
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
    async onTypeChange(value) {
        this.type = value;
        this.reloadForm();
    }
    async onMinChaptersChange(value) {
        this.minChapters = value.replace(/\D/g, "");
    }
    async onGenresChange(value) {
        this.genres = value;
        this.reloadForm();
    }
    getSearchQueryMetadata() {
        const meta = {};
        if (this.status[0])
            meta.status = this.status[0];
        if (this.type[0])
            meta.type = this.type[0];
        if (Object.keys(this.genres).length)
            meta.genres = this.genres;
        if (this.minChapters)
            meta.minChapters = this.minChapters;
        return { searchMeta: meta };
    }
}
