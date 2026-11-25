import { AdvancedSearchForm, Section, TriStateSelectRow } from "@paperback/types";
import { GENRES } from "../model";
export class ScribbleHubSearchForm extends AdvancedSearchForm {
    genres;
    constructor(initialMeta) {
        super();
        this.genres = initialMeta?.genres ?? {};
    }
    async updateGenres(value) {
        this.genres = value;
        this.reloadForm();
    }
    getSearchQueryMetadata() {
        return {
            searchMeta: {
                genres: this.genres,
            },
        };
    }
    getSections() {
        return [
            Section("filters", [
                TriStateSelectRow("genres", {
                    title: "Genre",
                    layout: "flow",
                    value: this.genres,
                    items: GENRES.filter((g) => g.id !== "0").map((g) => ({ id: g.id, title: g.label })),
                    allowExclusion: true,
                    allowEmptySelection: true,
                    onValueChange: Application.Selector(this, "updateGenres"),
                }),
            ]),
        ];
    }
}
