/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Copyright © 2026 Inkdex */
import { AdvancedSearchForm, Section, SelectRow, } from "@paperback/types";
// Mirrors the site's category directory: each option is its own page, so picking one clears the
// others, as the site does.
export class NovelCoolAdvancedSearchForm extends AdvancedSearchForm {
    options;
    filter;
    constructor(searchQuery, options) {
        super();
        this.options = options;
        const metadata = searchQuery.metadata ?? {};
        const key = ["genre", "status", "year", "letter"].find((name) => metadata[name]?.[0]);
        const id = key ? metadata[key]?.[0] : undefined;
        this.filter = key && id ? { key, id } : undefined;
    }
    row(key, title, items, handler) {
        return SelectRow(key, {
            title,
            layout: "flow",
            value: this.filter?.key === key ? [this.filter.id] : [],
            items,
            minItemCount: 0,
            maxItemCount: 1,
            onValueChange: Application.Selector(this, handler),
        });
    }
    getSections() {
        return [
            Section({
                id: "browse",
                footer: "The site lists one of these at a time, and not alongside a typed title, which searches on its own.",
            }, [
                this.row("genre", "Genre", this.options.genres, "handleGenreChange"),
                this.row("status", "Status", this.options.statuses, "handleStatusChange"),
                this.row("year", "Year", this.options.years, "handleYearChange"),
                this.row("letter", "Alphabetic", this.options.letters, "handleLetterChange"),
            ]),
        ];
    }
    select(key, value) {
        this.filter = value[0] ? { key, id: value[0] } : undefined;
        this.reloadForm();
    }
    async handleGenreChange(value) {
        this.select("genre", value);
    }
    async handleStatusChange(value) {
        this.select("status", value);
    }
    async handleYearChange(value) {
        this.select("year", value);
    }
    async handleLetterChange(value) {
        this.select("letter", value);
    }
    getSearchQueryMetadata() {
        return this.filter ? { [this.filter.key]: [this.filter.id] } : {};
    }
}
