import { AdvancedSearchForm, InputRow, Section, SelectRow, } from "@paperback/types";
// Madara `status[]` query options (label -> value)
export const STATUS_OPTIONS = [
    { id: "on-going", title: "Ongoing" },
    { id: "end", title: "Completed" },
    { id: "canceled", title: "Canceled" },
    { id: "on-hold", title: "On Hold" },
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
    author;
    artist;
    release;
    status;
    orderBy;
    adult;
    genreCondition;
    constructor(initialMeta) {
        super();
        this.author = initialMeta?.author ?? "";
        this.artist = initialMeta?.artist ?? "";
        this.release = initialMeta?.release ?? "";
        this.status = initialMeta?.status ?? [];
        this.orderBy = initialMeta?.orderBy ?? [];
        this.adult = initialMeta?.adult ?? [];
        this.genreCondition = initialMeta?.genreCondition ?? [];
    }
    async updateAuthor(value) {
        this.author = value;
        this.reloadForm();
    }
    async updateArtist(value) {
        this.artist = value;
        this.reloadForm();
    }
    async updateRelease(value) {
        this.release = value;
        this.reloadForm();
    }
    async updateStatus(value) {
        this.status = value;
        this.reloadForm();
    }
    async updateOrderBy(value) {
        this.orderBy = value;
        this.reloadForm();
    }
    async updateAdult(value) {
        this.adult = value;
        this.reloadForm();
    }
    async updateGenreCondition(value) {
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
            },
        };
    }
    getSections() {
        return [
            Section("text_filters", [
                InputRow("author", {
                    title: "Author",
                    value: this.author,
                    onValueChange: Application.Selector(this, "updateAuthor"),
                }),
                InputRow("artist", {
                    title: "Artist",
                    value: this.artist,
                    onValueChange: Application.Selector(this, "updateArtist"),
                }),
                InputRow("release", {
                    title: "Year of release",
                    value: this.release,
                    onValueChange: Application.Selector(this, "updateRelease"),
                }),
            ]),
            Section("select_filters", [
                SelectRow("status", {
                    title: "Status",
                    value: this.status,
                    options: STATUS_OPTIONS,
                    minItemCount: 0,
                    maxItemCount: STATUS_OPTIONS.length,
                    onValueChange: Application.Selector(this, "updateStatus"),
                }),
                SelectRow("order_by", {
                    title: "Order by",
                    value: this.orderBy,
                    options: ORDER_BY_OPTIONS,
                    minItemCount: 0,
                    maxItemCount: 1,
                    onValueChange: Application.Selector(this, "updateOrderBy"),
                }),
                SelectRow("adult", {
                    title: "Adult content",
                    value: this.adult,
                    options: ADULT_OPTIONS,
                    minItemCount: 0,
                    maxItemCount: 1,
                    onValueChange: Application.Selector(this, "updateAdult"),
                }),
                SelectRow("genre_condition", {
                    title: "Genre condition",
                    value: this.genreCondition,
                    options: GENRE_CONDITION_OPTIONS,
                    minItemCount: 0,
                    maxItemCount: 1,
                    onValueChange: Application.Selector(this, "updateGenreCondition"),
                }),
            ]),
        ];
    }
}
