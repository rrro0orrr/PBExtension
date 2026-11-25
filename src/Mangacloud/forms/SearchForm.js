import { AdvancedSearchForm, NavigationRow, Section, SelectRow } from "@paperback/types";
import { Formats, Genres, Statuses, Themes, Types } from "../model";
import { TagFilterForm } from "./TagFilterForm";
export class MangacloudSearchForm extends AdvancedSearchForm {
    type;
    status;
    genreForm;
    themeForm;
    formatForm;
    constructor(initialMeta) {
        super();
        this.type = initialMeta?.type ? [initialMeta.type] : [];
        this.status = initialMeta?.status ? [initialMeta.status] : [];
        this.genreForm = new TagFilterForm(Genres.map((g) => ({ id: g.id, name: g.name })), "genres", {
            included: initialMeta?.genreIncluded ?? [],
            excluded: initialMeta?.genreExcluded ?? [],
        });
        this.themeForm = new TagFilterForm(Themes.map((t) => ({ id: t.id, name: t.name })), "themes", {
            included: initialMeta?.themeIncluded ?? [],
            excluded: initialMeta?.themeExcluded ?? [],
        });
        this.formatForm = new TagFilterForm(Formats.map((f) => ({ id: f.id, name: f.name })), "formats", {
            included: initialMeta?.formatIncluded ?? [],
            excluded: initialMeta?.formatExcluded ?? [],
        });
    }
    async updateType(value) {
        this.type = value;
        this.reloadForm();
    }
    async updateStatus(value) {
        this.status = value;
        this.reloadForm();
    }
    getSearchQueryMetadata() {
        const genres = this.genreForm.getState();
        const themes = this.themeForm.getState();
        const formats = this.formatForm.getState();
        return {
            searchMeta: {
                type: this.type[0] ?? "",
                status: this.status[0] ?? "",
                genreIncluded: genres.included,
                genreExcluded: genres.excluded,
                themeIncluded: themes.included,
                themeExcluded: themes.excluded,
                formatIncluded: formats.included,
                formatExcluded: formats.excluded,
            },
        };
    }
    getSubtitle(state) {
        const total = state.included.length + state.excluded.length;
        return total > 0 ? `${total} selected` : "";
    }
    getSections() {
        return [
            Section("general", [
                SelectRow("type", {
                    title: "Type",
                    value: this.type,
                    options: Types.map((t) => ({ id: t.id, title: t.name })),
                    minItemCount: 0,
                    maxItemCount: 1,
                    onValueChange: Application.Selector(this, "updateType"),
                }),
                SelectRow("status", {
                    title: "Status",
                    value: this.status,
                    options: Statuses.map((s) => ({ id: s.id, title: s.name })),
                    minItemCount: 0,
                    maxItemCount: 1,
                    onValueChange: Application.Selector(this, "updateStatus"),
                }),
            ]),
            Section("genres_section", [
                NavigationRow("genres_nav", {
                    title: "Genres",
                    subtitle: this.getSubtitle(this.genreForm.getState()),
                    form: this.genreForm,
                }),
            ]),
            Section("themes_section", [
                NavigationRow("themes_nav", {
                    title: "Themes",
                    subtitle: this.getSubtitle(this.themeForm.getState()),
                    form: this.themeForm,
                }),
            ]),
            Section("formats_section", [
                NavigationRow("formats_nav", {
                    title: "Formats",
                    subtitle: this.getSubtitle(this.formatForm.getState()),
                    form: this.formatForm,
                }),
            ]),
        ];
    }
}
